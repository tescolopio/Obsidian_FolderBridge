import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { App } from 'obsidian';
import * as obsidian from 'obsidian';
import { FileWatcher } from '../src/FileWatcher';
import { PathMapper } from '../src/PathMapper';
import { logger } from '../src/logger';
import type { MountPoint } from '../src/types';

// ── Chokidar mock ─────────────────────────────────────────────────────────────
// We patch FileWatcher._loadChokidar (a static property) so tests never call
// the real require('chokidar') and don't need vi.mock().
const on = vi.fn();
const close = vi.fn();
const mockWatcherInstance = { on, close } as unknown as import('chokidar').FSWatcher;
on.mockReturnValue(mockWatcherInstance); // make .on() chainable
const mockChokidarWatch = vi.fn(() => mockWatcherInstance);
const mockWatcherOn = on;
const mockWatcherClose = close;
const mockLoadChokidar = () => ({ watch: mockChokidarWatch } as unknown as typeof import('chokidar'));

// Install the mock before any describe blocks run
FileWatcher._loadChokidar = mockLoadChokidar;

// ── Helpers ───────────────────────────────────────────────────────────────────

function mkMount(id: string, virtualPath: string, realPath: string): MountPoint {
    return { id, virtualPath, realPath, enabled: true, readOnly: false };
}

function makeApp() {
    const mockOnChange = vi.fn().mockResolvedValue(undefined);
    const mockGetAbstractFileByPath = vi.fn(() => null as unknown);
    const mockStat = vi.fn().mockResolvedValue({ size: 100, ctime: 0, mtime: Date.now() });
    const app = {
        vault: {
            onChange: mockOnChange,
            getAbstractFileByPath: mockGetAbstractFileByPath,
            adapter: { stat: mockStat },
        },
    } as unknown as App;
    return { app, mockOnChange, mockGetAbstractFileByPath, mockStat };
}

function makeMapper(mount: MountPoint): PathMapper {
    const mapper = new PathMapper();
    mapper.update([mount], 'test-device');
    return mapper;
}

type WatcherCallback = (...args: unknown[]) => void | Promise<void>;
type IgnoredCallback = (path: string) => boolean;
type WatchOptions = { ignored?: IgnoredCallback };

/** Return the callback registered on the mock watcher for a given chokidar event. */
function getCallback(eventName: string): WatcherCallback {
    const call = mockWatcherOn.mock.calls.find(c => c[0] === eventName);
    if (!call) throw new Error(`No chokidar handler for '${eventName}'`);
    return call[1] as WatcherCallback;
}

function getPathCallback(eventName: string): (path: string) => void | Promise<void> {
    return (path: string) => getCallback(eventName)(path);
}

function getWatchOptions(): WatchOptions {
    const firstCall = mockChokidarWatch.mock.calls[0] as unknown[] | undefined;
    if (!firstCall || firstCall.length < 2) throw new Error('Expected chokidar.watch to be called');

    const options = firstCall[1];
    if (!options || typeof options !== 'object') throw new Error('Expected chokidar.watch options object');

    return options as WatchOptions;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('FileWatcher', () => {
    const mount = mkMount('m1', 'mounts/docs', 'C:/Users/test/Documents');

    beforeEach(() => {
        FileWatcher._loadChokidar = mockLoadChokidar;
        mockChokidarWatch.mockClear();
        mockWatcherOn.mockClear();
        mockWatcherClose.mockClear();
        mockWatcherOn.mockReturnValue(mockWatcherInstance); // re-establish chaining
    });

    describe('suppression transitions', () => {
        it.each(['mount', 'global'])('drops changes received during %s suppression even when resumed before debounce expires', async scope => {
            vi.useFakeTimers();
            const { app, mockOnChange, mockGetAbstractFileByPath } = makeApp();
            mockGetAbstractFileByPath.mockReturnValue({});
            const watcher = new FileWatcher(app, makeMapper(mount), () => false);
            try {
                watcher.startWatching(mount);
                const target = scope === 'global' ? null : mount.id;
                watcher.setSuppressed(target, true);
                await getCallback('change')(`${mount.realPath}/note.md`);
                watcher.setSuppressed(target, false);
                await vi.runAllTimersAsync();
                expect(mockOnChange).not.toHaveBeenCalled();

                await getCallback('change')(`${mount.realPath}/note.md`);
                await vi.runAllTimersAsync();
                expect(mockOnChange.mock.calls.map(call => call[0])).toEqual(['modified', 'raw']);
            } finally {
                watcher.stopAll();
                vi.useRealTimers();
            }
        });

        it.each([
            ['mount', false], ['mount', true], ['global', false], ['global', true],
        ] as const)('drops a pending stat during %s suppression even if resumed: %s', async (scope, resume) => {
            const { app, mockOnChange, mockStat } = makeApp();
            let finishStat!: (value: { size: number; ctime: number; mtime: number }) => void;
            mockStat.mockImplementation(() => new Promise(resolve => { finishStat = resolve; }));
            const watcher = new FileWatcher(app, makeMapper(mount), () => false);
            try {
                watcher.startWatching(mount);
                await getCallback('add')(`${mount.realPath}/note.md`);
                const target = scope === 'global' ? null : mount.id;
                watcher.setSuppressed(target, true);
                if (resume) watcher.setSuppressed(target, false);
                finishStat({ size: 1, ctime: 0, mtime: 0 });
                await Promise.resolve();
                expect(mockOnChange).not.toHaveBeenCalled();
            } finally {
                watcher.stopAll();
            }
        });

        it.each(['mount', 'global'])('cancels already queued changes when %s suppression starts', async scope => {
            vi.useFakeTimers();
            const { app, mockOnChange, mockGetAbstractFileByPath } = makeApp();
            mockGetAbstractFileByPath.mockReturnValue({});
            const watcher = new FileWatcher(app, makeMapper(mount), () => false);
            try {
                watcher.startWatching(mount);
                await getCallback('change')(`${mount.realPath}/note.md`);
                expect(vi.getTimerCount()).toBe(1);
                const target = scope === 'global' ? null : mount.id;
                watcher.setSuppressed(target, true);
                watcher.setSuppressed(target, false);
                expect(vi.getTimerCount()).toBe(0);
                await vi.runAllTimersAsync();
                expect(mockOnChange).not.toHaveBeenCalled();
            } finally {
                watcher.stopAll();
                vi.useRealTimers();
            }
        });

        it('does not deliver raw refresh after suppression starts during a change notification', async () => {
            vi.useFakeTimers();
            const { app, mockOnChange, mockGetAbstractFileByPath } = makeApp();
            mockGetAbstractFileByPath.mockReturnValue({});
            const watcher = new FileWatcher(app, makeMapper(mount), () => false);
            mockOnChange.mockImplementation(async () => {
                watcher.setSuppressed(mount.id, true);
                watcher.setSuppressed(mount.id, false);
            });
            try {
                watcher.startWatching(mount);
                await getCallback('change')(`${mount.realPath}/note.md`);
                await vi.runAllTimersAsync();
                expect(mockOnChange.mock.calls.map(call => call[0])).toEqual(['modified']);
            } finally {
                watcher.stopAll();
                vi.useRealTimers();
            }
        });

        it('keeps other mounts active and preserves per-mount suppression when global suppression ends', async () => {
            const other = mkMount('m2', 'other', '/other');
            const mapper = makeMapper(mount);
            mapper.update([mount, other], 'test-device');
            const { app, mockOnChange } = makeApp();
            const watcher = new FileWatcher(app, mapper, () => false);
            try {
                watcher.startWatching(mount);
                const firstAdd = getCallback('add');
                mockWatcherOn.mockClear();
                watcher.startWatching(other);
                const otherAdd = getCallback('add');
                watcher.setSuppressed(mount.id, true);
                watcher.setSuppressed(null, true);
                watcher.setSuppressed(null, false);
                await firstAdd(`${mount.realPath}/hidden.md`);
                await otherAdd('/other/visible.md');
                expect(mockOnChange).toHaveBeenCalledExactlyOnceWith('file-created', 'other/visible.md', null, expect.any(Object));
            } finally {
                watcher.stopAll();
            }
        });
    });

    // ── startWatching ──────────────────────────────────────────────────────────

    describe('startWatching', () => {
        it('calls chokidar.watch with the mount real path and required options', () => {
            const { app } = makeApp();
            const fw = new FileWatcher(app, makeMapper(mount), () => false);

            fw.startWatching(mount);

            expect(mockChokidarWatch).toHaveBeenCalledWith(
                'C:/Users/test/Documents',
                expect.objectContaining({
                    followSymlinks: false,
                    ignoreInitial: true,
                    persistent: true,
                })
            );
        });

        it('registers add, change, unlink, addDir, unlinkDir and error handlers', () => {
            const { app } = makeApp();
            const fw = new FileWatcher(app, makeMapper(mount), () => false);

            fw.startWatching(mount);

            const events = mockWatcherOn.mock.calls.map(c => c[0]);
            expect(events).toContain('add');
            expect(events).toContain('change');
            expect(events).toContain('unlink');
            expect(events).toContain('addDir');
            expect(events).toContain('unlinkDir');
            expect(events).toContain('error');
        });

        it('stops the existing watcher before starting a new one for the same mount', () => {
            const { app } = makeApp();
            const fw = new FileWatcher(app, makeMapper(mount), () => false);

            fw.startWatching(mount);
            fw.startWatching(mount); // second call should close the first

            expect(mockWatcherClose).toHaveBeenCalledTimes(1);
            expect(mockChokidarWatch).toHaveBeenCalledTimes(2);
        });

        it('logs without a user-facing notice when chokidar cannot be loaded', () => {
            const failure = new Error('chokidar is unavailable in this environment');
            const notice = vi.spyOn(obsidian, 'Notice');
            const warning = vi.spyOn(logger, 'warn').mockImplementation(() => { });
            FileWatcher._loadChokidar = () => {
                throw failure;
            };

            const { app } = makeApp();
            const fw = new FileWatcher(app, makeMapper(mount), () => false);

            try {
                expect(() => fw.startWatching(mount)).not.toThrow();
                expect(() => fw.startWatching(mount)).not.toThrow();
                expect(mockChokidarWatch).not.toHaveBeenCalled();
                expect(notice).not.toHaveBeenCalled();
                expect(warning).toHaveBeenCalledTimes(2);
                expect(warning).toHaveBeenCalledWith(
                    `[FolderBridge] File watcher unavailable for mount ${mount.virtualPath}:`, failure,
                );
            } finally {
                notice.mockRestore();
                warning.mockRestore();
            }
        });
    });

    // ── stopWatching ───────────────────────────────────────────────────────────

    describe('stopWatching', () => {
        it('ignores old-root events after the active mapper entry changes', async () => {
            const { app, mockOnChange, mockGetAbstractFileByPath } = makeApp();
            mockGetAbstractFileByPath.mockReturnValue({});
            const mapper = makeMapper(mount);
            const watcher = new FileWatcher(app, mapper, () => false);
            watcher.startWatching(mount);
            mapper.update([{ ...mount, realPath: '/new-root' }], 'test-device');
            await getCallback('unlinkDir')(mount.realPath);
            expect(mockOnChange).not.toHaveBeenCalled();
            watcher.stopAll();
        });

        it('ignores callbacks from a stopped watcher after a root replacement', async () => {
            const { app, mockOnChange, mockGetAbstractFileByPath } = makeApp();
            mockGetAbstractFileByPath.mockReturnValue({});
            const mapper = makeMapper(mount);
            const watcher = new FileWatcher(app, mapper, () => false);
            watcher.startWatching(mount);
            const staleUnlink = getCallback('unlink');
            const updated = { ...mount, realPath: '/new-root' };
            watcher.stopWatching(mount);
            mapper.update([updated], 'test-device');
            watcher.startWatching(updated);

            await staleUnlink(`${mount.realPath}/old.md`);
            expect(mockOnChange).not.toHaveBeenCalled();
            watcher.stopAll();
        });

        it('cancels pending debounced events for the stopped mount', async () => {
            vi.useFakeTimers();
            try {
                const { app, mockOnChange, mockGetAbstractFileByPath } = makeApp();
                mockGetAbstractFileByPath.mockReturnValue({});
                const watcher = new FileWatcher(app, makeMapper(mount), () => false);
                watcher.startWatching(mount);
                await getCallback('change')(`${mount.realPath}/old.md`);
                watcher.stopWatching(mount);
                expect(vi.getTimerCount()).toBe(0);
                await vi.runAllTimersAsync();
                expect(mockOnChange).not.toHaveBeenCalled();
            } finally {
                vi.useRealTimers();
            }
        });

        it('drops a pending stat result after the watcher is stopped', async () => {
            const { app, mockOnChange, mockStat } = makeApp();
            let finishStat!: (value: { size: number; ctime: number; mtime: number }) => void;
            mockStat.mockImplementation(() => new Promise(resolve => { finishStat = resolve; }));
            const watcher = new FileWatcher(app, makeMapper(mount), () => false);
            watcher.startWatching(mount);
            await getCallback('add')(`${mount.realPath}/old.md`);
            watcher.stopWatching(mount);
            finishStat({ size: 1, ctime: 0, mtime: 0 });
            await Promise.resolve();
            expect(mockOnChange).not.toHaveBeenCalled();
        });

        it('does not translate out-of-root events into mount-root removals', async () => {
            const { app, mockOnChange, mockGetAbstractFileByPath } = makeApp();
            mockGetAbstractFileByPath.mockReturnValue({});
            const watcher = new FileWatcher(app, makeMapper(mount), () => false);
            watcher.startWatching(mount);
            await getCallback('unlinkDir')(`${mount.realPath}-other`);
            expect(mockOnChange).not.toHaveBeenCalled();
            watcher.stopAll();
        });

        it('closes the watcher for the given mount', () => {
            const { app } = makeApp();
            const fw = new FileWatcher(app, makeMapper(mount), () => false);
            fw.startWatching(mount);

            fw.stopWatching(mount);

            expect(mockWatcherClose).toHaveBeenCalledTimes(1);
        });

        it('is a no-op if the mount is not being watched', () => {
            const { app } = makeApp();
            const fw = new FileWatcher(app, makeMapper(mount), () => false);

            fw.stopWatching(mount);

            expect(mockWatcherClose).not.toHaveBeenCalled();
        });
    });

    // ── stopAll ────────────────────────────────────────────────────────────────

    describe('stopAll', () => {
        it('closes all active watchers', () => {
            const mount2 = mkMount('m2', 'mounts/photos', 'C:/Users/test/Photos');
            const { app } = makeApp();
            const mapper = new PathMapper();
            mapper.update([mount, mount2], 'test-device');
            const fw = new FileWatcher(app, mapper, () => false);

            fw.startWatching(mount);
            fw.startWatching(mount2);
            mockWatcherClose.mockClear();

            fw.stopAll();

            expect(mockWatcherClose).toHaveBeenCalledTimes(2);
        });
    });

    // ── ignored callback ───────────────────────────────────────────────────────

    describe('ignored callback', () => {
        function getIgnored(isIgnored: (name: string, mount: MountPoint, relativePath?: string) => boolean = () => false): (p: string) => boolean {
            const { app } = makeApp();
            const fw = new FileWatcher(app, makeMapper(mount), isIgnored);
            fw.startWatching(mount);
            const options = getWatchOptions();
            if (!options.ignored) throw new Error('Expected ignored callback to be registered');
            return options.ignored;
        }

        it('honors configured hidden-file exclusions', () => {
            const ignored = getIgnored(name => name === '.git' || name === '.DS_Store');
            expect(ignored('C:/Users/test/Documents/.git')).toBe(true);
            expect(ignored('C:/Users/test/Documents/.DS_Store')).toBe(true);
        });

        it('honors a configured node_modules exclusion', () => {
            const ignored = getIgnored(name => name === 'node_modules');
            expect(ignored('C:/Users/test/Documents/node_modules')).toBe(true);
        });

        it('allows dot-prefixed paths when not excluded', () => {
            const ignored = getIgnored();
            expect(ignored('C:/Users/test/Documents/.env')).toBe(false);
            expect(ignored('C:/Users/test/Documents/.obsidian_link')).toBe(false);
        });

        it('watches a dot-prefixed mount root and forwards relative ignore paths', () => {
            const hiddenMount = mkMount('hidden', 'docs', '/tmp/.notes');
            const { app } = makeApp();
            const isIgnored = vi.fn((_name: string, _mount: MountPoint, relativePath?: string) => relativePath === 'assets/vendor');
            const watcher = new FileWatcher(app, makeMapper(hiddenMount), isIgnored);
            watcher.startWatching(hiddenMount);
            const ignored = getWatchOptions().ignored!;

            expect(ignored('/tmp/.notes')).toBe(false);
            expect(ignored('/tmp/.notes/assets/vendor')).toBe(true);
            expect(isIgnored).toHaveBeenCalledWith('vendor', hiddenMount, 'assets/vendor');
            expect(ignored('/tmp/.notes/docs/vendor')).toBe(false);
        });

        it('does not ignore regular files', () => {
            const ignored = getIgnored();
            expect(ignored('C:/Users/test/Documents/readme.md')).toBe(false);
            expect(ignored('C:/Users/test/Documents/images/photo.jpg')).toBe(false);
        });

        it('applies user-defined ignore rules via isIgnored callback', () => {
            const { app } = makeApp();
            const isIgnored = vi.fn((name: string) => name === 'secret.md');
            const fw = new FileWatcher(app, makeMapper(mount), isIgnored);
            fw.startWatching(mount);

            const chokidarOptions = getWatchOptions();
            if (!chokidarOptions.ignored) throw new Error('Expected ignored callback to be registered');
            const ignored = chokidarOptions.ignored;

            expect(ignored('C:/Users/test/Documents/secret.md')).toBe(true);
            expect(ignored('C:/Users/test/Documents/notes.md')).toBe(false);
        });
    });

    // ── handleEvent (via chokidar callbacks) ──────────────────────────────────

    describe('handleEvent via chokidar callbacks', () => {
        it('file-created: calls vault.onChange with stat when file is new', async () => {
            const { app, mockOnChange, mockGetAbstractFileByPath } = makeApp();
            mockGetAbstractFileByPath.mockReturnValue(null);
            const fw = new FileWatcher(app, makeMapper(mount), () => false);
            fw.startWatching(mount);

            await getCallback('add')('C:/Users/test/Documents/note.md');

            expect(mockOnChange).toHaveBeenCalledWith('file-created', 'mounts/docs/note.md', null, expect.any(Object));
        });

        it('file-created: skips when file already exists in vault', async () => {
            const { app, mockOnChange, mockGetAbstractFileByPath } = makeApp();
            mockGetAbstractFileByPath.mockReturnValue({ path: 'mounts/docs/note.md' });
            const fw = new FileWatcher(app, makeMapper(mount), () => false);
            fw.startWatching(mount);

            await getCallback('add')('C:/Users/test/Documents/note.md');

            expect(mockOnChange).not.toHaveBeenCalled();
        });

        it('file-changed: calls vault.onChange with stat then raw', async () => {
            vi.useFakeTimers();
            const { app, mockOnChange, mockGetAbstractFileByPath } = makeApp();
            mockGetAbstractFileByPath.mockReturnValue({ path: 'mounts/docs/note.md' });
            const fw = new FileWatcher(app, makeMapper(mount), () => false);
            fw.startWatching(mount);

            // handleEvent is synchronous — must advance timers to trigger dispatchEvent
            getPathCallback('change')('C:/Users/test/Documents/note.md');
            await vi.runAllTimersAsync();

            expect(mockOnChange).toHaveBeenCalledWith('modified', 'mounts/docs/note.md', null, expect.any(Object));
            expect(mockOnChange).toHaveBeenCalledWith('raw', 'mounts/docs/note.md', null, null);
            vi.useRealTimers();
        });

        it('file-changed: skips when file is not in vault', async () => {
            vi.useFakeTimers();
            const { app, mockOnChange, mockGetAbstractFileByPath } = makeApp();
            mockGetAbstractFileByPath.mockReturnValue(null);
            const fw = new FileWatcher(app, makeMapper(mount), () => false);
            fw.startWatching(mount);

            getPathCallback('change')('C:/Users/test/Documents/note.md');
            await vi.runAllTimersAsync();

            expect(mockOnChange).not.toHaveBeenCalled();
            vi.useRealTimers();
        });

        it('file-changed: debounces rapid writes — only notifies vault once', async () => {
            vi.useFakeTimers();
            const { app, mockOnChange, mockGetAbstractFileByPath } = makeApp();
            mockGetAbstractFileByPath.mockReturnValue({ path: 'mounts/docs/note.md' });
            const fw = new FileWatcher(app, makeMapper(mount), () => false);
            fw.startWatching(mount);

            const changeCb = getPathCallback('change');
            changeCb('C:/Users/test/Documents/note.md');
            changeCb('C:/Users/test/Documents/note.md');
            changeCb('C:/Users/test/Documents/note.md');
            await vi.runAllTimersAsync();

            // Three rapid writes → one modified + one raw
            expect(mockOnChange).toHaveBeenCalledTimes(2);
            expect(mockOnChange).toHaveBeenCalledWith('modified', 'mounts/docs/note.md', null, expect.any(Object));
            vi.useRealTimers();
        });

        it('file-changed: resets timer on each write (trailing-edge debounce)', async () => {
            vi.useFakeTimers();
            const { app, mockOnChange, mockGetAbstractFileByPath } = makeApp();
            mockGetAbstractFileByPath.mockReturnValue({ path: 'mounts/docs/note.md' });
            const fw = new FileWatcher(app, makeMapper(mount), () => false);
            fw.startWatching(mount);

            const changeCb = getPathCallback('change');
            changeCb('C:/Users/test/Documents/note.md');
            await vi.advanceTimersByTimeAsync(100); // before DEBOUNCE_MS
            expect(mockOnChange).not.toHaveBeenCalled();

            changeCb('C:/Users/test/Documents/note.md'); // resets the 300ms timer
            await vi.advanceTimersByTimeAsync(299);
            expect(mockOnChange).not.toHaveBeenCalled(); // still inside new window

            await vi.runAllTimersAsync(); // now past DEBOUNCE_MS
            expect(mockOnChange).toHaveBeenCalledWith('modified', 'mounts/docs/note.md', null, expect.any(Object));
            vi.useRealTimers();
        });

        it('file-changed: separate paths debounce independently', async () => {
            vi.useFakeTimers();
            const { app, mockOnChange, mockGetAbstractFileByPath } = makeApp();
            mockGetAbstractFileByPath.mockReturnValue({ path: 'mounts/docs/a.md' });
            const fw = new FileWatcher(app, makeMapper(mount), () => false);
            fw.startWatching(mount);

            const changeCb = getPathCallback('change');
            changeCb('C:/Users/test/Documents/a.md');
            changeCb('C:/Users/test/Documents/b.md');
            await vi.runAllTimersAsync();

            // Two different paths → two independent debounce timers → 4 onChange calls
            expect(mockOnChange).toHaveBeenCalledTimes(4); // (modified + raw) × 2
            vi.useRealTimers();
        });

        it('file-removed: calls vault.onChange without stat', async () => {
            const { app, mockOnChange, mockGetAbstractFileByPath } = makeApp();
            mockGetAbstractFileByPath.mockReturnValue({ path: 'mounts/docs/note.md' });
            const fw = new FileWatcher(app, makeMapper(mount), () => false);
            fw.startWatching(mount);

            await getCallback('unlink')('C:/Users/test/Documents/note.md');

            expect(mockOnChange).toHaveBeenCalledWith('file-removed', 'mounts/docs/note.md', null, null);
        });

        it('file-removed: skips when file is not in vault', async () => {
            const { app, mockOnChange, mockGetAbstractFileByPath } = makeApp();
            mockGetAbstractFileByPath.mockReturnValue(null);
            const fw = new FileWatcher(app, makeMapper(mount), () => false);
            fw.startWatching(mount);

            await getCallback('unlink')('C:/Users/test/Documents/note.md');

            expect(mockOnChange).not.toHaveBeenCalled();
        });

        it('folder-created: calls vault.onChange without stat', async () => {
            const { app, mockOnChange, mockGetAbstractFileByPath } = makeApp();
            mockGetAbstractFileByPath.mockReturnValue(null);
            const fw = new FileWatcher(app, makeMapper(mount), () => false);
            fw.startWatching(mount);

            await getCallback('addDir')('C:/Users/test/Documents/subfolder');

            expect(mockOnChange).toHaveBeenCalledWith('folder-created', 'mounts/docs/subfolder', null, null);
        });

        it('folder-removed: calls vault.onChange without stat', async () => {
            const { app, mockOnChange, mockGetAbstractFileByPath } = makeApp();
            mockGetAbstractFileByPath.mockReturnValue({ path: 'mounts/docs/subfolder' });
            const fw = new FileWatcher(app, makeMapper(mount), () => false);
            fw.startWatching(mount);

            await getCallback('unlinkDir')('C:/Users/test/Documents/subfolder');

            expect(mockOnChange).toHaveBeenCalledWith('folder-removed', 'mounts/docs/subfolder', null, null);
        });

        it('file-created: skips vault.onChange when stat() returns null', async () => {
            const { app, mockOnChange, mockGetAbstractFileByPath, mockStat } = makeApp();
            mockGetAbstractFileByPath.mockReturnValue(null);
            mockStat.mockResolvedValue(null);
            const fw = new FileWatcher(app, makeMapper(mount), () => false);
            fw.startWatching(mount);

            await getCallback('add')('C:/Users/test/Documents/note.md');

            expect(mockOnChange).not.toHaveBeenCalled();
        });

        it('file-created: suppresses files hidden by visibleFileFilter', async () => {
            const { app, mockOnChange, mockGetAbstractFileByPath } = makeApp();
            mockGetAbstractFileByPath.mockReturnValue(null);
            const filteredMount = mkMount('m2', 'mounts/docs', 'C:/Users/test/Documents');
            filteredMount.visibleFileFilter = 'markdown-only';
            const fw = new FileWatcher(app, makeMapper(filteredMount), () => false);
            fw.startWatching(filteredMount);

            await getCallback('add')('C:/Users/test/Documents/manual.pdf');

            expect(mockOnChange).not.toHaveBeenCalled();
        });

        it('does not throw when vault.onChange is not a function', async () => {
            const app = {
                vault: {
                    onChange: null,
                    getAbstractFileByPath: vi.fn(() => null),
                    adapter: { stat: vi.fn().mockResolvedValue({ size: 0, ctime: 0, mtime: 0 }) },
                },
            } as unknown as App;
            const fw = new FileWatcher(app, makeMapper(mount), () => false);
            fw.startWatching(mount);

            // handleEvent is synchronous (void); dispatchEvent runs async internally.
            // Verify no synchronous exception is thrown when vault.onChange is null.
            expect(() => getCallback('add')('C:/Users/test/Documents/note.md')).not.toThrow();
        });
    });
});
