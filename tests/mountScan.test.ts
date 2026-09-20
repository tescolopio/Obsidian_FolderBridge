import { describe, expect, it, vi } from 'vitest';
import type { MountPoint } from '../src/types';
import { replayMountContentsToVault } from '../src/mountScan';

function mkMount(overrides: Partial<MountPoint> = {}): MountPoint {
    return {
        id: 'm1',
        virtualPath: 'mounts/docs',
        realPath: '/tmp/docs',
        enabled: true,
        readOnly: false,
        ...overrides,
    };
}

describe('replayMountContentsToVault', () => {
    it.each([undefined, 'local', 'vault'] as const)('bounds %s metadata reads while replaying files in listing order', async mountType => {
        vi.useFakeTimers();
        try {
            const files = Array.from({ length: 24 }, (_, index) => `mounts/docs/${index}.md`);
            let activeReads = 0;
            let peakReads = 0;
            let activeNotifications = 0;
            let peakNotifications = 0;
            const completedReads: string[] = [];
            const deps = {
                list: vi.fn(async () => ({ folders: [], files })),
                stat: vi.fn(async (file: string) => {
                    activeReads++;
                    peakReads = Math.max(peakReads, activeReads);
                    await new Promise(resolve => setTimeout(resolve, 10 - files.indexOf(file) % 8));
                    activeReads--;
                    completedReads.push(file);
                    return { type: 'file' as const, ctime: 0, mtime: 0, size: 1 };
                }),
                hasAbstractFile: vi.fn(() => false),
                isIgnored: vi.fn(() => false),
                onFolderCreated: vi.fn(async () => { }),
                onFileCreated: vi.fn(async (_path: string) => {
                    activeNotifications++;
                    peakNotifications = Math.max(peakNotifications, activeNotifications);
                    await Promise.resolve();
                    activeNotifications--;
                }),
                yieldToEventLoop: vi.fn(async () => { }),
            };
            const started = Date.now();
            const replay = replayMountContentsToVault(mkMount({ mountType }), deps);
            await vi.runAllTimersAsync();

            expect((await replay).fileCount).toBe(24);
            expect(completedReads.slice(0, 8)).toEqual(files.slice(0, 8).reverse());
            expect(deps.onFileCreated.mock.calls.map(call => call[0])).toEqual(files);
            expect(Date.now() - started).toBe(30);
            expect(peakReads).toBe(8);
            expect(peakNotifications).toBe(1);
        } finally {
            vi.useRealTimers();
        }
    });

    it('skips child replay entirely when watcher suppression is enabled', async () => {
        const mount = mkMount({ watcherSuppressAllEvents: true });
        const deps = {
            list: vi.fn(),
            stat: vi.fn(),
            hasAbstractFile: vi.fn(() => false),
            isIgnored: vi.fn(() => false),
            onFolderCreated: vi.fn(async () => { }),
            onFileCreated: vi.fn(async () => { }),
        };

        const result = await replayMountContentsToVault(mount, deps);

        expect(result).toEqual({ fileCount: 0, folderCount: 0, scanLimitHit: false, isHuge: false });
        expect(deps.list).not.toHaveBeenCalled();
        expect(deps.onFolderCreated).not.toHaveBeenCalled();
        expect(deps.onFileCreated).not.toHaveBeenCalled();
    });

    it.each([1, 5, 9])('does not read metadata beyond a scan limit of %i', async maxFiles => {
        const files = Array.from({ length: 20 }, (_, index) => `mounts/docs/sub/${index}.md`);
        const deps = {
            list: vi.fn(async (folder: string) => folder === 'mounts/docs'
                ? { folders: ['mounts/docs/sub'], files: [] }
                : { folders: [], files }),
            stat: vi.fn(async () => ({ type: 'file' as const, ctime: 0, mtime: 0, size: 1 })),
            hasAbstractFile: vi.fn(() => false),
            isIgnored: vi.fn(() => false),
            onFolderCreated: vi.fn(async () => { }),
            onFileCreated: vi.fn(async () => { }),
            yieldToEventLoop: vi.fn(async () => { }),
        };

        const result = await replayMountContentsToVault(mkMount({ maxFiles }), deps);

        expect(result).toMatchObject({ folderCount: 1, fileCount: maxFiles - 1, scanLimitHit: true });
        expect(deps.stat).toHaveBeenCalledTimes(maxFiles - 1);
        expect(deps.onFileCreated).toHaveBeenCalledTimes(maxFiles - 1);
    });

    it('filters ignored, invisible and existing files before reading metadata', async () => {
        const files = ['existing.md', 'ignored.md', 'image.png', 'new.md'].map(name => `mounts/docs/${name}`);
        const deps = {
            list: vi.fn(async () => ({ folders: [], files })),
            stat: vi.fn(async () => null),
            hasAbstractFile: vi.fn((file: string) => file === files[0]),
            isIgnored: vi.fn((name: string) => name === 'ignored.md'),
            onFolderCreated: vi.fn(async () => { }),
            onFileCreated: vi.fn(async () => { }),
            yieldToEventLoop: vi.fn(async () => { }),
        };

        const result = await replayMountContentsToVault(mkMount({ visibleFileFilter: 'markdown-only' }), deps);

        expect(result.fileCount).toBe(1);
        expect(deps.stat).toHaveBeenCalledExactlyOnceWith(files[3]);
        expect(deps.onFileCreated).toHaveBeenCalledWith(files[3], null);
    });

    it('does not duplicate a file added while a metadata batch is pending', async () => {
        const files = ['first.md', 'second.md', 'third.md'].map(name => `mounts/docs/${name}`);
        const existing = new Set<string>();
        const deps = {
            list: vi.fn(async () => ({ folders: [], files })),
            stat: vi.fn(async (file: string) => {
                existing.add(files[0]);
                return { type: 'file' as const, ctime: 0, mtime: 0, size: file.length };
            }),
            hasAbstractFile: vi.fn((file: string) => existing.has(file)),
            isIgnored: vi.fn(() => false),
            onFolderCreated: vi.fn(async () => { }),
            onFileCreated: vi.fn(async (file: string) => { existing.add(file); }),
            yieldToEventLoop: vi.fn(async () => { }),
        };

        const result = await replayMountContentsToVault(mkMount({ maxFiles: 2 }), deps);

        expect(result.fileCount).toBe(2);
        expect(deps.onFileCreated.mock.calls.map(call => call[0])).toEqual(files.slice(1));
        expect(deps.stat).toHaveBeenCalledTimes(3);
    });

    it('settles failed batches and preserves folder-level error handling', async () => {
        const files = Array.from({ length: 16 }, (_, index) => `mounts/docs/${index}.md`);
        const failure = new Error('metadata unavailable');
        let completed = 0;
        const deps = {
            list: vi.fn(async () => ({ folders: [], files })),
            stat: vi.fn(async (file: string) => {
                await Promise.resolve();
                completed++;
                if (file === files[1] || file === files[7]) throw failure;
                return null;
            }),
            hasAbstractFile: vi.fn(() => false),
            isIgnored: vi.fn(() => false),
            onFolderCreated: vi.fn(async () => { }),
            onFileCreated: vi.fn(async () => { }),
            onError: vi.fn(),
            yieldToEventLoop: vi.fn(async () => { }),
        };

        const result = await replayMountContentsToVault(mkMount(), deps);

        expect(completed).toBe(8);
        expect(result.fileCount).toBe(1);
        expect(deps.onFileCreated).toHaveBeenCalledExactlyOnceWith(files[0], null);
        expect(deps.onError).toHaveBeenCalledExactlyOnceWith('mounts/docs', failure);
    });

    it.each(['webdav', 's3', 'sftp'] as const)('keeps %s metadata reads serial', async mountType => {
        const files = ['mounts/docs/first.md', 'mounts/docs/second.md'];
        const events: string[] = [];
        await replayMountContentsToVault(mkMount({ mountType }), {
            list: async () => ({ folders: [], files }),
            stat: async file => { events.push(`stat:${file}`); return null; },
            hasAbstractFile: () => false,
            isIgnored: () => false,
            onFolderCreated: async () => { },
            onFileCreated: async file => { events.push(`created:${file}`); },
            yieldToEventLoop: async () => { },
        });

        expect(events).toEqual(files.flatMap(file => [`stat:${file}`, `created:${file}`]));
    });

    it('replays child folders and files when suppression is disabled', async () => {
        const mount = mkMount();
        const deps = {
            list: vi.fn(async (folderPath: string) => {
                if (folderPath === 'mounts/docs') {
                    return {
                        folders: ['mounts/docs/subfolder'],
                        files: ['mounts/docs/note.md'],
                    };
                }
                return { folders: [], files: ['mounts/docs/subfolder/child.md'] };
            }),
            stat: vi.fn(async () => ({ type: 'file' as const, ctime: 0, mtime: 0, size: 1 })),
            hasAbstractFile: vi.fn(() => false),
            isIgnored: vi.fn(() => false),
            onFolderCreated: vi.fn(async () => { }),
            onFileCreated: vi.fn(async () => { }),
            yieldToEventLoop: vi.fn(async () => { }),
        };

        const result = await replayMountContentsToVault(mount, deps);

        expect(result.fileCount).toBe(2);
        expect(result.folderCount).toBe(1);
        expect(result.scanLimitHit).toBe(false);
        expect(deps.onFolderCreated).toHaveBeenCalledWith('mounts/docs/subfolder');
        expect(deps.onFileCreated).toHaveBeenCalledWith('mounts/docs/note.md', expect.any(Object));
        expect(deps.onFileCreated).toHaveBeenCalledWith('mounts/docs/subfolder/child.md', expect.any(Object));
    });

    it('uses configured exclusions for dot-prefixed folders and files', async () => {
        const mount = mkMount();
        const deps = {
            list: vi.fn(async (folderPath: string) => folderPath === mount.virtualPath
                ? { folders: ['mounts/docs/.notes', 'mounts/docs/.git'], files: ['mounts/docs/.note.md', 'mounts/docs/.DS_Store'] }
                : { folders: [], files: ['mounts/docs/.notes/child.md'] }),
            stat: vi.fn(async () => ({ type: 'file' as const, ctime: 0, mtime: 0, size: 1 })),
            hasAbstractFile: vi.fn(() => false),
            isIgnored: vi.fn((name: string) => name === '.git' || name === '.DS_Store'),
            onFolderCreated: vi.fn(async () => { }),
            onFileCreated: vi.fn(async () => { }),
            yieldToEventLoop: vi.fn(async () => { }),
        };

        const result = await replayMountContentsToVault(mount, deps);

        expect(result.folderCount).toBe(1);
        expect(result.fileCount).toBe(2);
        expect(deps.list).not.toHaveBeenCalledWith('mounts/docs/.git');
        expect(deps.onFileCreated).toHaveBeenCalledWith('mounts/docs/.note.md', expect.any(Object));
        expect(deps.onFileCreated).toHaveBeenCalledWith('mounts/docs/.notes/child.md', expect.any(Object));
    });

    it('skips files hidden by the mount visible-file filter', async () => {
        const mount = mkMount({ visibleFileFilter: 'markdown-only' });
        const deps = {
            list: vi.fn(async () => ({
                folders: [],
                files: ['mounts/docs/note.md', 'mounts/docs/attachment.pdf'],
            })),
            stat: vi.fn(async () => ({ type: 'file' as const, ctime: 0, mtime: 0, size: 1 })),
            hasAbstractFile: vi.fn(() => false),
            isIgnored: vi.fn(() => false),
            onFolderCreated: vi.fn(async () => { }),
            onFileCreated: vi.fn(async () => { }),
            yieldToEventLoop: vi.fn(async () => { }),
        };

        const result = await replayMountContentsToVault(mount, deps);

        expect(result.fileCount).toBe(1);
        expect(deps.onFileCreated).toHaveBeenCalledTimes(1);
        expect(deps.onFileCreated).toHaveBeenCalledWith('mounts/docs/note.md', expect.any(Object));
    });
});
