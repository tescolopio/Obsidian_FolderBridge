import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App, FuzzySuggestModal, Notice, PluginManifest, Setting, TFile, TFolder } from 'obsidian';
import FolderBridgePlugin from '../main';
import { PathMapper } from '../src/PathMapper';
import { SecurityManager } from '../src/SecurityManager';
import { FileWatcher } from '../src/FileWatcher';
import { VirtualAdapter } from '../src/VirtualAdapter';
import { WebDAVAdapter } from '../src/WebDAVAdapter';
import { S3Adapter } from '../src/S3Adapter';
import { SFTPAdapter } from '../src/SFTPAdapter';
import { DEFAULT_SETTINGS, MountPoint } from '../src/types';
import { serializeTocConfig } from '../src/TocConfig';
import { checkPathAccessible } from '../src/OSHelpers';
import { browseFolderOnDisk } from '../src/ui/MountManagerModal';
import { replayMountContentsToVault } from '../src/mountScan';
import { promises as fs } from 'fs';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

vi.mock('../main', () => import('../main' + '.ts'));

vi.mock('obsidian', async importOriginal => {
    const original = await importOriginal<typeof import('obsidian')>();
    const mocked = {
        ...original,
        Notice: class extends original.Notice {
            setMessage = vi.fn();
        },
        FuzzySuggestModal: class extends original.FuzzySuggestModal<MountPoint> {
            setPlaceholder() { return this; }
            open() { }
            getItems() { return []; }
            getItemText() { return ''; }
            onChooseItem() { }
        },
        Setting: class {
            name = '';
            desc = '';
            settingEl: HTMLElement;
            constructor(container: HTMLElement) { this.settingEl = container.createDiv(); }
            setName(value: string) { this.name = value; return this; }
            setDesc(value: string) { this.desc = value; return this; }
            setHeading() { return this; }
            addToggle() { return this; }
            addButton() { return this; }
            addExtraButton() { return this; }
            addText() { return this; }
            addDropdown() { return this; }
        },
    };
    return {
        ...mocked,
        Notice: Object.assign(vi.fn(mocked.Notice), { prototype: mocked.Notice.prototype }),
        Setting: Object.assign(vi.fn(mocked.Setting), { prototype: mocked.Setting.prototype }),
    };
});

vi.mock('../src/ui/MountManagerModal', async importOriginal => ({
    ...await importOriginal<typeof import('../src/ui/MountManagerModal')>(),
    browseFolderOnDisk: vi.fn().mockResolvedValue(null),
    getMountStatus: vi.fn().mockResolvedValue({ reachable: true, readOnly: false }),
}));

vi.mock('../src/mountScan', async importOriginal => {
    const original = await importOriginal<typeof import('../src/mountScan')>();
    return { ...original, replayMountContentsToVault: vi.fn(original.replayMountContentsToVault) };
});

vi.mock('../src/OSHelpers', async importOriginal => ({
    ...await importOriginal<typeof import('../src/OSHelpers')>(),
    checkPathAccessible: vi.fn(),
}));

const mount = (id: string, realPath = '/primary'): MountPoint => ({
    id, virtualPath: id, realPath, enabled: true, readOnly: false, deviceId: 'desktop',
});

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(done => { resolve = done; });
    return { promise, resolve };
}

function makeVirtualAdapter(plugin: FolderBridgePlugin, app: App) {
    const adapter = new VirtualAdapter(
        app.vault.adapter, plugin.pathMapper, plugin.security, false, undefined,
        async () => 'cancel', async () => { }, () => false,
    );
    plugin.virtualAdapter = adapter;
    return adapter;
}

function remoteBackend(filename: string) {
    return {
        list: vi.fn().mockResolvedValue({ files: [`docs/${filename}`], folders: [] }),
        stat: vi.fn().mockResolvedValue({ type: 'file', size: 1, ctime: 0, mtime: 0 }),
        disconnect: vi.fn().mockResolvedValue(undefined),
    };
}

async function makePlugin(mounts: MountPoint[] = [], source = '', fallback = '') {
    const files = new Map<string, TFile | TFolder>();
    const events: string[] = [];
    const app = {
        vault: {
            configDir: '.obsidian',
            getAbstractFileByPath: (path: string) => files.get(path),
            onChange: vi.fn((event: string, path: string) => {
                events.push(`${event}:${path}`);
                if (event.endsWith('-removed')) files.delete(path);
                if (event.endsWith('-created')) {
                    const file = event === 'folder-created' ? new TFolder() : new TFile();
                    file.path = path;
                    files.set(path, file);
                }
                return Promise.resolve();
            }),
            adapter: {
                list: vi.fn().mockResolvedValue({ files: [], folders: [] }),
                stat: vi.fn().mockResolvedValue({ type: 'file', size: 1, ctime: 0, mtime: 0 }),
            },
        },
        workspace: { getLeavesOfType: () => [] },
    } as unknown as App;
    const plugin = new FolderBridgePlugin(app, { name: 'Folder Bridge' } as PluginManifest);
    const saveData = vi.fn().mockResolvedValue(undefined);
    Object.assign(plugin, {
        loadData: vi.fn().mockResolvedValue({
            ...DEFAULT_SETTINGS, deviceId: 'desktop', mountPoints: mounts,
            allowlist: [], tocSources: [], managedTocSource: source, managedTocSourceFallback: fallback
        }),
        saveData,
    });
    plugin.pathMapper = new PathMapper();
    plugin.security = new SecurityManager([]);
    vi.spyOn(plugin.security, 'validateMount').mockReturnValue(null);
    vi.spyOn(plugin.security, 'getPathWarnings').mockReturnValue([]);
    await plugin.loadSettings();
    return { plugin, app, files, events, saveData };
}

class SettingsElement {
    children: SettingsElement[] = [];
    text = '';
    value = '';
    tag = '';
    onclick?: () => void;
    dataset = {};
    classList = { add: vi.fn() };
    createEl(tag: string, options: { text?: string } = {}) {
        const element = new SettingsElement();
        element.tag = tag;
        element.text = options.text ?? '';
        this.children.push(element);
        return element;
    }
    createDiv() { return this.createEl('div'); }
    createSpan(options: { text?: string } = {}) { return this.createEl('span', options); }
    empty() { this.children = []; }
    addClass() { }
    appendText() { }
    setAttribute() { }
    addEventListener() { }
    descendants(): SettingsElement[] { return this.children.flatMap(child => [child, ...child.descendants()]); }
}

async function loadCommands(plugin: FolderBridgePlugin, app: App) {
    const commands = new Map<string, () => void>();
    let layoutReady!: () => void;
    let tab!: { display(): void; containerEl: HTMLElement; renderMountRow(container: HTMLElement, mount: MountPoint): void };
    const internals = plugin as unknown as {
        installVirtualAdapter(): void;
        setupExplorerHighlighting(): void;
        startHealthChecks(): void;
    };
    vi.spyOn(plugin, 'loadSettings').mockResolvedValue(undefined);
    vi.spyOn(plugin.fileServer, 'start').mockResolvedValue(false);
    vi.spyOn(internals, 'installVirtualAdapter').mockImplementation(() => { });
    vi.spyOn(internals, 'setupExplorerHighlighting').mockImplementation(() => { });
    vi.spyOn(internals, 'startHealthChecks').mockImplementation(() => { });
    plugin.settings.showStatusBar = false;
    plugin.settings.hasSeenOnboarding = true;
    Object.assign(plugin, {
        addRibbonIcon: () => ({ addClass: vi.fn() }),
        addSettingTab: (value: typeof tab) => { tab = value; },
        addCommand: (command: { id: string; callback: () => void }) => commands.set(command.id, command.callback),
        registerEvent: vi.fn(),
    });
    Object.assign(app.workspace, {
        on: vi.fn(),
        onLayoutReady: (callback: () => void) => { layoutReady = callback; },
    });
    await plugin.onload();
    return { commands, layoutReady, tab };
}

describe('main fallback regressions', () => {
    beforeEach(() => {
        vi.mocked(Notice).mockClear();
        vi.mocked(Setting).mockClear();
        vi.mocked(checkPathAccessible).mockClear();
        vi.mocked(checkPathAccessible).mockImplementation(path => Promise.resolve({ accessible: path !== '/missing', readOnly: false }));
        vi.spyOn(fs, 'readFile').mockResolvedValue(serializeTocConfig([]));
        vi.spyOn(fs, 'writeFile').mockResolvedValue(undefined);
        vi.spyOn(fs, 'mkdir').mockResolvedValue(undefined);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it.each(['watcher', 'adapter'] as const)('%s modifications invalidate cached content through the recorded vault handler', async source => {
        const existing = mount('docs');
        const { plugin, app, files } = await makePlugin([existing]);
        const oldStat = { type: 'file' as const, size: 1, ctime: 1, mtime: 1 };
        const newStat = { type: 'file' as const, size: 20, ctime: 1, mtime: 2 };
        const file = Object.assign(new TFile(), { path: 'docs/note.md', stat: oldStat, cache: vi.fn() });
        files.set(file.path, file);
        const trigger = vi.fn();
        const recordedHandler = runInNewContext(
            `(${readFileSync(new URL('../docs/vault-onchange.txt', import.meta.url), 'utf8')})`,
            { fM: TFile, mM: TFolder },
        ) as (this: unknown, event: string, path: string, oldPath: string | null, stat: unknown) => void;
        const vaultState = { fileMap: { [file.path]: file }, trigger, configDir: '.obsidian', getConfigFile: () => '' };
        const onChange = vi.fn((event: string, path: string, oldPath: string | null, stat: unknown) => {
            recordedHandler.call(vaultState, event, path, oldPath, stat);
            return Promise.resolve();
        });
        Object.assign(app.vault, { onChange });

        if (source === 'adapter') {
            const installer = plugin as unknown as { installVirtualAdapter(): void };
            installer.installVirtualAdapter();
            vi.spyOn(app.vault.adapter, 'stat').mockResolvedValue(newStat);
            const adapter = plugin.virtualAdapter as unknown as { onModify(path: string): Promise<void> };
            await adapter.onModify(file.path);
        } else {
            vi.mocked(app.vault.adapter.stat).mockResolvedValue(newStat);
            const watcher = new FileWatcher(app, plugin.pathMapper, () => false);
            const dispatch = watcher as unknown as {
                dispatchEvent(event: string, realPath: string, mount: MountPoint, isCurrent: () => boolean): Promise<void>;
            };
            await dispatch.dispatchEvent('file-changed', '/primary/note.md', existing, () => true);
        }

        expect(file.stat).toBe(newStat);
        expect(file.cache).toHaveBeenCalledExactlyOnceWith(null);
        expect(trigger.mock.calls).toEqual([['modify', file], ['raw', file.path]]);
        expect(onChange.mock.calls.map(call => call[0])).toEqual(['modified', 'raw']);
    });

    it.each(['persisted-suppression', 'runtime-suppression', 'null-stat', 'failed-stat', 'unmounted', 'missing-handler'] as const)(
        'keeps adapter modification notifications best-effort for %s', async scenario => {
            const existing = { ...mount('docs'), watcherSuppressAllEvents: scenario === 'persisted-suppression' };
            const { plugin, app } = await makePlugin([existing]);
            const onChange = (app.vault as unknown as { onChange: ReturnType<typeof vi.fn> }).onChange;
            const installer = plugin as unknown as { installVirtualAdapter(): void };
            installer.installVirtualAdapter();
            plugin.fileWatcher = new FileWatcher(app, plugin.pathMapper, () => false);
            if (scenario === 'runtime-suppression') plugin.fileWatcher.setSuppressed(existing.id, true);
            if (scenario === 'missing-handler') Object.assign(app.vault, { onChange: undefined });
            const stat = vi.spyOn(app.vault.adapter, 'stat').mockResolvedValue(null);
            if (scenario === 'failed-stat') stat.mockRejectedValue(new Error('metadata unavailable'));
            const adapter = plugin.virtualAdapter as unknown as { onModify(path: string): Promise<void> };

            await expect(adapter.onModify(scenario === 'unmounted' ? 'outside/note.md' : 'docs/note.md')).resolves.toBeUndefined();

            expect(onChange).not.toHaveBeenCalled();
            expect(stat).toHaveBeenCalledTimes(scenario === 'null-stat' || scenario === 'failed-stat' ? 1 : 0);
        },
    );

    it.each([false, true])('applies saved suppression changes immediately and retains them on reload (initial: %s)', async initial => {
        const existing = { ...mount('docs'), watcherSuppressAllEvents: initial };
        const { plugin, saveData } = await makePlugin([existing]);
        const watcher = { stopWatching: vi.fn(), startWatching: vi.fn() };
        plugin.fileWatcher = watcher as unknown as FileWatcher;
        const reinject = vi.spyOn(plugin, 'notifyVaultMountAdded');

        await plugin.updateMount(existing.id, { ...existing, watcherSuppressAllEvents: !initial });

        expect(watcher.stopWatching).toHaveBeenCalledExactlyOnceWith(existing);
        expect(watcher.startWatching).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
            id: existing.id, watcherSuppressAllEvents: !initial,
        }));
        expect(plugin.pathMapper.getMountByVirtualPath('docs')?.watcherSuppressAllEvents).toBe(!initial);
        expect(reinject).not.toHaveBeenCalled();
        const saved = saveData.mock.calls.at(-1)![0] as { mountPoints: MountPoint[] };
        const reloaded = await makePlugin(saved.mountPoints);
        expect(reloaded.plugin.pathMapper.getMountByVirtualPath('docs')?.watcherSuppressAllEvents).toBe(!initial);
    });

    it('suggests an unused child and refuses to shadow existing vault folders', async () => {
        const { plugin, files } = await makePlugin();
        const explorer = plugin as unknown as {
            getAvailableExplorerMountPath(parent: string): string;
            addExplorerMount(value: Omit<MountPoint, 'id'>): Promise<void>;
        };
        files.set('Projects', new TFolder());
        files.set('Projects/External', new TFolder());
        expect(explorer.getAvailableExplorerMountPath('Projects')).toBe('Projects/External 2');
        const add = vi.spyOn(plugin, 'addMount').mockResolvedValue(undefined);
        await expect(explorer.addExplorerMount({ ...mount('docs'), virtualPath: 'Projects' })).rejects.toThrow('already exists');
        expect(add).not.toHaveBeenCalled();
        await explorer.addExplorerMount({ ...mount('docs'), virtualPath: 'Projects/External 2' });
        expect(add).toHaveBeenCalledOnce();
    });

    it('reattaches observation when a layout replaces the explorer container', async () => {
        const { plugin, app } = await makePlugin();
        const container = () => ({ querySelectorAll: () => [] }) as unknown as HTMLElement;
        let current = container();
        let layoutChanged!: () => void;
        const observers: Array<{ observe: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }> = [];
        const explorer = plugin as unknown as {
            setupExplorerHighlighting(): void;
            registerExplorerTooltipAugmentation(): void;
            registerExplorerExpansionTracking(): void;
            setupNativeTooltipObserver(): void;
            highlightMountedInExplorer(): void;
        };
        for (const method of ['registerExplorerTooltipAugmentation', 'registerExplorerExpansionTracking', 'setupNativeTooltipObserver', 'highlightMountedInExplorer'] as const) {
            vi.spyOn(explorer, method).mockImplementation(() => { });
        }
        Object.assign(app.workspace, {
            getLeavesOfType: () => [{ view: { containerEl: current } }],
            on: (_event: string, callback: () => void) => { layoutChanged = callback; },
        });
        Object.assign(plugin, { registerEvent: vi.fn() });
        vi.stubGlobal('document', { contains: () => true });
        vi.stubGlobal('MutationObserver', class {
            observe = vi.fn();
            disconnect = vi.fn();
            constructor() { observers.push(this); }
        });
        try {
            explorer.setupExplorerHighlighting();
            expect(observers[0].observe).toHaveBeenCalledWith(current, { childList: true, subtree: true });
            current = container();
            layoutChanged();
            expect(observers[0].disconnect).toHaveBeenCalledOnce();
            expect(observers[1].observe).toHaveBeenCalledWith(current, { childList: true, subtree: true });
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it('handles expansion persistence failures and keeps dirty state until retry succeeds', async () => {
        const { plugin } = await makePlugin();
        const explorer = plugin as unknown as {
            explorerExpansionDirty: boolean;
            flushExplorerExpansionState(): Promise<void>;
        };
        explorer.explorerExpansionDirty = true;
        const save = vi.spyOn(plugin, 'saveSettings').mockRejectedValueOnce(new Error('disk unavailable')).mockResolvedValue(undefined);
        await expect(explorer.flushExplorerExpansionState()).resolves.toBeUndefined();
        expect(explorer.explorerExpansionDirty).toBe(true);
        await explorer.flushExplorerExpansionState();
        expect(explorer.explorerExpansionDirty).toBe(false);
        expect(save).toHaveBeenCalledTimes(2);
    });

    it.each([
        { deviceOverrides: { desktop: '/override' } },
        { fallbackRealPath: '/fallback' },
    ])('tracks expansion for a foreign mount enabled by %j', async configuration => {
        const existing = { ...mount('docs'), deviceId: 'other', ...configuration };
        const { plugin } = await makePlugin([existing]);
        const explorer = plugin as unknown as { isFolderBridgeExplorerPath(path: string): boolean };
        expect(explorer.isFolderBridgeExplorerPath('docs/nested')).toBe(true);
        expect(explorer.isFolderBridgeExplorerPath('docs-sibling')).toBe(false);
        plugin.settings.mountPoints[0].enabled = false;
        expect(explorer.isFolderBridgeExplorerPath('docs')).toBe(false);
    });

    it('uses the effective source and preserves native attributes when clearing metadata', async () => {
        const existing = mount('docs');
        const { plugin } = await makePlugin([existing]);
        plugin.pathMapper.setResolvedPath(existing.id, '/fallback');
        const explorer = plugin as unknown as {
            setExplorerMountMetadata(el: HTMLElement, value: MountPoint, label: string): void;
            clearExplorerMountMetadata(el: HTMLElement): void;
        };
        const element = { dataset: {}, removeAttribute: vi.fn(), querySelectorAll: vi.fn() } as unknown as HTMLElement;
        explorer.setExplorerMountMetadata(element, existing, 'Local folder');
        expect(element.dataset.folderbridgeMountTooltip).toContain('Path: /fallback');
        explorer.clearExplorerMountMetadata(element);
        expect(element.dataset.folderbridgeMountTooltip).toBeUndefined();
        expect(element.removeAttribute).not.toHaveBeenCalled();
        expect(element.querySelectorAll).not.toHaveBeenCalled();
    });

    it('ignores queued tooltip updates after the hovered mount loses ownership', async () => {
        const { plugin } = await makePlugin();
        const explorer = plugin as unknown as {
            activeExplorerMountTooltipText: string | null;
            activeExplorerMountTooltipEl: HTMLElement | null;
            appendMountInfoToNativeTooltip(text: string): void;
        };
        const query = vi.fn().mockReturnValue([]);
        vi.stubGlobal('document', { querySelectorAll: query });
        try {
            explorer.activeExplorerMountTooltipText = null;
            explorer.appendMountInfoToNativeTooltip('old mount');
            explorer.activeExplorerMountTooltipText = 'old mount';
            explorer.activeExplorerMountTooltipEl = { isConnected: true, matches: () => false } as unknown as HTMLElement;
            explorer.appendMountInfoToNativeTooltip('old mount');
            expect(query).not.toHaveBeenCalled();
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it('cancels queued explorer work on unload and does not schedule more work', async () => {
        const { plugin } = await makePlugin();
        vi.useFakeTimers();
        vi.stubGlobal('document', { querySelectorAll: () => [] });
        const explorer = plugin as unknown as {
            scheduleExplorerWork(callback: () => void, delay: number): void;
            scheduleExplorerExpansionStateCapture(element: HTMLElement): void;
            captureExplorerExpansionState(element: HTMLElement): void;
        };
        Object.assign(plugin, { fileServer: { stop: vi.fn() } });
        const callback = vi.fn();
        const capture = vi.spyOn(explorer, 'captureExplorerExpansionState');
        try {
            explorer.scheduleExplorerWork(callback, 10);
            explorer.scheduleExplorerExpansionStateCapture({} as HTMLElement);
            plugin.onunload();
            explorer.scheduleExplorerWork(callback, 10);
            vi.runAllTimers();
            expect(callback).not.toHaveBeenCalled();
            expect(capture).not.toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
            vi.unstubAllGlobals();
        }
    });

    it('loads the selected fallback before adding so destination mounts survive', async () => {
        vi.mocked(fs.readFile).mockImplementation(source => Promise.resolve(serializeTocConfig([
            mount(source === '/old.json' ? 'old' : 'destination'),
        ])));
        const { plugin } = await makePlugin([], '/missing', '/old.json');
        plugin.settings.managedTocSourceFallback = '/destination.json';
        await plugin.resolveAndCacheManagedTocSource();
        await plugin.addMount(mount('added'));
        const [destination, text] = vi.mocked(fs.writeFile).mock.calls.at(-1)!;
        expect(destination).toBe('/destination.json');
        expect(JSON.parse(String(text)).mounts.map((entry: MountPoint) => entry.virtualPath)).toEqual(['destination', 'added']);
    });

    it('disables both TOC sources and stays disabled after loading saved settings', async () => {
        vi.mocked(fs.readFile).mockResolvedValue(serializeTocConfig([mount('existing')]));
        const { plugin, saveData } = await makePlugin([], '/missing', '/fallback.json');
        await plugin.unbindManagedTocSource();
        const saved = saveData.mock.calls.at(-1)![0];
        expect(saved.managedTocSourceFallback).toBe('');
        Object.assign(plugin, { loadData: vi.fn().mockResolvedValue(saved) });
        await plugin.loadSettings();
        expect(plugin.resolvedManagedTocSource).toBe('');
        expect(plugin.settings.mountPoints.map(entry => entry.id)).toEqual(['existing']);
    });

    it('clears a cached root even when there is no fallback to probe', async () => {
        const existing = mount('docs');
        const { plugin } = await makePlugin([existing]);
        plugin.pathMapper.setResolvedPath(existing.id, '/obsolete');
        await plugin.notifyVaultMountAdded(existing);
        expect(plugin.pathMapper.getEffectiveRealPath(existing)).toBe('/primary');
    });

    it('retains the active fallback route while the same mount refresh is probing', async () => {
        const existing = { ...mount('docs', '/missing'), fallbackRealPath: '/active-root' };
        const { plugin, app } = await makePlugin([existing]);
        const adapter = makeVirtualAdapter(plugin, app);
        await plugin.notifyVaultMountAdded(existing);
        const probe = deferred<{ accessible: boolean; readOnly: boolean }>();
        vi.mocked(checkPathAccessible).mockImplementation(path => path === '/missing'
            ? probe.promise : Promise.resolve({ accessible: true, readOnly: false }));
        const refresh = plugin.notifyVaultMountAdded(existing);
        try {
            await adapter.write('docs/note.md', 'saved during refresh');
            expect(fs.writeFile).toHaveBeenCalledWith('/active-root/note.md', 'saved during refresh', 'utf8');
            expect(plugin.pathMapper.getEffectiveRealPath(existing)).toBe('/active-root');
        } finally {
            probe.resolve({ accessible: false, readOnly: false });
            await refresh;
        }
        expect(plugin.pathMapper.getEffectiveRealPath(existing)).toBe('/active-root');
    });

    it.each([true, false])('commits fallback availability %s only after its probe finishes', async accessible => {
        const existing = { ...mount('docs', '/missing'), fallbackRealPath: '/active-root' };
        const { plugin, app } = await makePlugin([existing]);
        const adapter = makeVirtualAdapter(plugin, app);
        await plugin.notifyVaultMountAdded(existing);
        const probe = deferred<{ accessible: boolean; readOnly: boolean }>();
        vi.mocked(checkPathAccessible).mockClear();
        vi.mocked(checkPathAccessible).mockImplementation(path => path === '/active-root'
            ? probe.promise : Promise.resolve({ accessible: false, readOnly: false }));
        const refresh = plugin.notifyVaultMountAdded(existing);
        try {
            await vi.waitFor(() => expect(checkPathAccessible).toHaveBeenCalledWith('/active-root'));
            await adapter.write('docs/note.md', 'saved during fallback probe');
            expect(fs.writeFile).toHaveBeenCalledWith('/active-root/note.md', 'saved during fallback probe', 'utf8');
        } finally {
            probe.resolve({ accessible, readOnly: false });
            await refresh;
        }
        expect(plugin.pathMapper.getEffectiveRealPath(existing)).toBe(accessible ? '/active-root' : '/missing');
    });

    it('does not let an older refresh replace a newer primary-path decision', async () => {
        const existing = { ...mount('docs', '/primary'), fallbackRealPath: '/active-root' };
        const { plugin } = await makePlugin([existing]);
        plugin.pathMapper.setResolvedPath(existing.id, '/active-root');
        const probe = deferred<{ accessible: boolean; readOnly: boolean }>();
        vi.mocked(checkPathAccessible).mockResolvedValueOnce({ accessible: false, readOnly: false });
        vi.mocked(checkPathAccessible).mockImplementationOnce(() => probe.promise);
        const older = plugin.notifyVaultMountAdded(existing);
        await vi.waitFor(() => expect(checkPathAccessible).toHaveBeenCalledWith('/active-root'));
        await plugin.notifyVaultMountAdded(existing);
        expect(plugin.pathMapper.getEffectiveRealPath(existing)).toBe('/primary');
        probe.resolve({ accessible: true, readOnly: false });
        await older;
        expect(plugin.pathMapper.getEffectiveRealPath(existing)).toBe('/primary');
    });

    it.each(['webdav', 's3', 'sftp'] as const)('rebuilds the %s adapter before scanning an updated mount', async mountType => {
        const existing = { ...mount('docs', '/old-root'), mountType };
        const { plugin, app, files } = await makePlugin([existing]);
        const adapter = makeVirtualAdapter(plugin, app);
        const oldBackend = remoteBackend('old.md');
        const newBackend = remoteBackend('new.md');
        adapter.setWebDAVAdapter(existing.id, oldBackend as unknown as WebDAVAdapter);
        adapter.setS3Adapter(existing.id, oldBackend as unknown as S3Adapter);
        adapter.setSFTPAdapter(existing.id, oldBackend as unknown as SFTPAdapter);
        vi.spyOn(WebDAVAdapter, 'fromMount').mockReturnValue(newBackend as unknown as WebDAVAdapter);
        vi.spyOn(S3Adapter, 'fromMount').mockReturnValue(newBackend as unknown as S3Adapter);
        vi.spyOn(SFTPAdapter, 'fromMount').mockReturnValue(newBackend as unknown as SFTPAdapter);
        app.vault.adapter.list = adapter.list.bind(adapter);
        app.vault.adapter.stat = adapter.stat.bind(adapter);

        await plugin.updateMount(existing.id, { ...existing, realPath: '/new-root' });

        expect(files.has('docs/new.md')).toBe(true);
        expect(files.has('docs/old.md')).toBe(false);
        expect(oldBackend.list).not.toHaveBeenCalled();
        expect(newBackend.list).toHaveBeenCalledWith('/new-root', 'docs', expect.objectContaining({ realPath: '/new-root' }));
    });

    it.each(['webdav', 's3', 'sftp'] as const)('registers the %s adapter before scanning an added mount', async mountType => {
        const { plugin, app, files } = await makePlugin();
        const adapter = makeVirtualAdapter(plugin, app);
        const backend = remoteBackend('new.md');
        vi.spyOn(WebDAVAdapter, 'fromMount').mockReturnValue(backend as unknown as WebDAVAdapter);
        vi.spyOn(S3Adapter, 'fromMount').mockReturnValue(backend as unknown as S3Adapter);
        vi.spyOn(SFTPAdapter, 'fromMount').mockReturnValue(backend as unknown as SFTPAdapter);
        app.vault.adapter.list = adapter.list.bind(adapter);
        app.vault.adapter.stat = adapter.stat.bind(adapter);

        await plugin.addMount({ ...mount('docs', '/new-root'), mountType });

        await vi.waitFor(() => expect(files.has('docs/new.md')).toBe(true));
        expect(backend.list).toHaveBeenCalledWith('/new-root', 'docs', expect.objectContaining({ mountType }));
    });

    it('supersedes a pending fallback read when binding a managed TOC source', async () => {
        const { plugin } = await makePlugin([], '/missing', '/old.json');
        const slowRead = deferred<string>();
        vi.mocked(fs.readFile).mockImplementation(source => source === '/slow.json'
            ? slowRead.promise : Promise.resolve(serializeTocConfig([mount('newest')])));
        plugin.settings.managedTocSourceFallback = '/slow.json';
        const switching = plugin.resolveAndCacheManagedTocSource();
        await vi.waitFor(() => expect(fs.readFile).toHaveBeenCalledWith('/slow.json', 'utf8'));
        expect(await plugin.bindManagedTocSource('/new.json')).toBe(true);
        await plugin.addMount(mount('added-before-old-read-finishes'));
        expect(vi.mocked(fs.writeFile).mock.calls.at(-1)![0]).toBe('/new.json');
        slowRead.resolve(serializeTocConfig([mount('obsolete')]));
        await switching;
        expect(plugin.resolvedManagedTocSource).toBe('/new.json');
        expect(plugin.settings.mountPoints.map(entry => entry.id)).toEqual(['newest']);
        await plugin.addMount(mount('added'));
        expect(vi.mocked(fs.writeFile).mock.calls.at(-1)![0]).toBe('/new.json');
    });

    it('waits for the bound TOC to finish loading before Add writes', async () => {
        const { plugin } = await makePlugin([], '/old.json');
        const reading = deferred<string>();
        vi.mocked(fs.readFile).mockReturnValue(reading.promise);
        const binding = plugin.bindManagedTocSource('/new.json');
        await vi.waitFor(() => expect(fs.readFile).toHaveBeenCalledWith('/new.json', 'utf8'));
        const adding = plugin.addMount(mount('added'));
        await new Promise(resolve => setTimeout(resolve, 10));
        expect(fs.writeFile).toHaveBeenCalledTimes(1);
        reading.resolve(serializeTocConfig([mount('destination')]));
        await Promise.all([binding, adding]);
        const [destination, text] = vi.mocked(fs.writeFile).mock.calls.at(-1)!;
        expect(destination).toBe('/new.json');
        expect(JSON.parse(String(text)).mounts.map((entry: MountPoint) => entry.virtualPath)).toEqual(['destination', 'added']);
    });

    it.each([true, false])('does not restore a disabled TOC after a pending bind write succeeds=%s', async succeeds => {
        const { plugin } = await makePlugin([], '/old.json');
        const writing = deferred<void>();
        vi.mocked(fs.writeFile).mockImplementationOnce(async () => {
            await writing.promise;
            if (!succeeds) throw new Error('write failed');
        });
        const binding = plugin.bindManagedTocSource('/new.json');
        await vi.waitFor(() => expect(fs.writeFile).toHaveBeenCalled());
        await plugin.unbindManagedTocSource();
        writing.resolve();
        expect(await binding).toBe(false);
        expect(plugin.settings.managedTocSource).toBe('');
        expect(plugin.resolvedManagedTocSource).toBe('');
        expect(plugin.settings.mountPoints).toEqual([]);
    });

    it('does not publish a slower TOC read over a newer source selection', async () => {
        const { plugin } = await makePlugin([], '/missing', '/old.json');
        const slowRead = deferred<string>();
        vi.mocked(fs.readFile).mockImplementation(source => source === '/slow.json'
            ? slowRead.promise : Promise.resolve(serializeTocConfig([mount('newest')])));
        plugin.settings.managedTocSourceFallback = '/slow.json';
        const older = plugin.resolveAndCacheManagedTocSource();
        await vi.waitFor(() => expect(fs.readFile).toHaveBeenCalledWith('/slow.json', 'utf8'));
        plugin.settings.managedTocSourceFallback = '/newest.json';
        await plugin.resolveAndCacheManagedTocSource();
        slowRead.resolve(serializeTocConfig([mount('obsolete')]));
        await older;
        expect(plugin.resolvedManagedTocSource).toBe('/newest.json');
        expect(plugin.settings.mountPoints.map(entry => entry.id)).toEqual(['newest']);
    });

    it('waits for destination loading when Add races a fallback change', async () => {
        const { plugin } = await makePlugin([], '/missing', '/old.json');
        const slowRead = deferred<string>();
        vi.mocked(fs.readFile).mockReturnValue(slowRead.promise);
        plugin.settings.managedTocSourceFallback = '/destination.json';
        const switching = plugin.resolveAndCacheManagedTocSource();
        const adding = plugin.addMount(mount('added'));
        await vi.waitFor(() => expect(fs.readFile).toHaveBeenCalledWith('/destination.json', 'utf8'));
        expect(fs.writeFile).not.toHaveBeenCalled();
        slowRead.resolve(serializeTocConfig([mount('destination')]));
        await Promise.all([switching, adding]);
        const [destination, text] = vi.mocked(fs.writeFile).mock.calls.at(-1)!;
        expect(destination).toBe('/destination.json');
        expect(JSON.parse(String(text)).mounts.map((entry: MountPoint) => entry.virtualPath)).toEqual(['destination', 'added']);
    });

    it('does not re-enable a TOC source when its pending read finishes after Disable', async () => {
        const { plugin } = await makePlugin([], '/missing', '/old.json');
        const slowRead = deferred<string>();
        vi.mocked(fs.readFile).mockReturnValue(slowRead.promise);
        plugin.settings.managedTocSourceFallback = '/slow.json';
        const switching = plugin.resolveAndCacheManagedTocSource();
        await vi.waitFor(() => expect(fs.readFile).toHaveBeenCalledWith('/slow.json', 'utf8'));
        await plugin.unbindManagedTocSource();
        slowRead.resolve(serializeTocConfig([mount('obsolete')]));
        await switching;
        expect(plugin.resolvedManagedTocSource).toBe('');
        expect(plugin.settings.mountPoints).toEqual([]);
    });

    it('does not inject or watch a removed mount when its pending root probe finishes', async () => {
        const existing = { ...mount('docs', '/missing'), fallbackRealPath: '/old-root' };
        const { plugin, events } = await makePlugin([existing]);
        const startWatching = vi.fn();
        plugin.fileWatcher = { stopWatching: vi.fn(), startWatching } as unknown as FileWatcher;
        const probe = deferred<{ accessible: boolean; readOnly: boolean }>();
        vi.mocked(checkPathAccessible).mockImplementation(path => path === '/missing' ? probe.promise : Promise.resolve({ accessible: true, readOnly: false }));
        const injection = plugin.notifyVaultMountAdded(existing);
        await plugin.notifyVaultMountRemoved(existing);
        probe.resolve({ accessible: false, readOnly: false });
        await injection;
        expect(startWatching).not.toHaveBeenCalled();
        expect(events).toEqual([]);
        expect(plugin.pathMapper.getEffectiveRealPath(existing)).toBe('/missing');
    });

    it('drops scan results that finish after mount removal', async () => {
        const existing = mount('docs');
        const { plugin, app, events } = await makePlugin([existing]);
        const startWatching = vi.fn();
        plugin.fileWatcher = { stopWatching: vi.fn(), startWatching } as unknown as FileWatcher;
        const listing = deferred<{ files: string[]; folders: string[] }>();
        vi.mocked(app.vault.adapter.list).mockReturnValue(listing.promise);
        const injection = plugin.notifyVaultMountAdded(existing);
        await vi.waitFor(() => expect(app.vault.adapter.list).toHaveBeenCalled());
        await plugin.notifyVaultMountRemoved(existing);
        events.length = 0;
        listing.resolve({ files: ['docs/obsolete.md'], folders: [] });
        await injection;
        expect(startWatching).not.toHaveBeenCalled();
        expect(events).toEqual([]);
    });

    it('removes old children and waits for the new root before starting watchers', async () => {
        const existing = { ...mount('docs'), fallbackRealPath: '/old-root' };
        const { plugin, app, files, events } = await makePlugin([existing]);
        plugin.pathMapper.setResolvedPath(existing.id, '/old-root');
        const folder = new TFolder();
        folder.path = 'docs';
        const child = new TFile();
        child.path = 'docs/old.md';
        folder.children = [child];
        files.set(folder.path, folder);
        files.set(child.path, child);
        const starts: string[] = [];
        plugin.fileWatcher = {
            stopWatching: vi.fn(),
            startWatching: (active: MountPoint) => { starts.push(plugin.pathMapper.getEffectiveRealPath(active)); },
        } as unknown as FileWatcher;
        const probe = deferred<{ accessible: boolean; readOnly: boolean }>();
        vi.mocked(checkPathAccessible).mockImplementation(path => path === '/missing' ? probe.promise : Promise.resolve({ accessible: true, readOnly: false }));
        const update = plugin.updateMount(existing.id, { ...existing, realPath: '/missing', fallbackRealPath: '/new-root' });
        await vi.waitFor(() => expect(checkPathAccessible).toHaveBeenCalledWith('/missing'));
        expect(plugin.pathMapper.getEffectiveRealPath(plugin.settings.mountPoints[0])).toBe('/missing');
        expect(starts).toEqual([]);
        expect(events).toEqual(['file-removed:docs/old.md', 'folder-removed:docs']);
        probe.resolve({ accessible: false, readOnly: false });
        await update;
        expect(starts).toEqual(['/new-root']);
        expect(files.has(child.path)).toBe(false);
        expect(app.vault.adapter.list).toHaveBeenCalledWith('docs');
    });

    it.each<MountPoint['deviceOverrides']>([{ desktop: '/new-root' }, {}, undefined])('removes old children when the active device override changes to %j', async deviceOverrides => {
        const existing = { ...mount('docs'), deviceOverrides: { desktop: '/old-root' } };
        const { plugin, files, events } = await makePlugin([existing]);
        const folder = new TFolder();
        folder.path = 'docs';
        const child = new TFile();
        child.path = 'docs/old.md';
        folder.children = [child];
        files.set(folder.path, folder);
        files.set(child.path, child);
        const starts: string[] = [];
        plugin.fileWatcher = {
            stopWatching: vi.fn(), startWatching: (active: MountPoint) => {
                starts.push(plugin.pathMapper.getEffectiveRealPath(active));
            }
        } as unknown as FileWatcher;
        await plugin.updateMount(existing.id, { ...existing, deviceOverrides });
        expect(events.slice(0, 2)).toEqual(['file-removed:docs/old.md', 'folder-removed:docs']);
        expect(starts).toEqual([deviceOverrides?.desktop ?? '/primary']);
    });

    it('resolves managed-TOC edits before starting their watcher exactly once', async () => {
        let document = serializeTocConfig([mount('docs')]);
        vi.mocked(fs.readFile).mockImplementation(() => Promise.resolve(document));
        vi.mocked(fs.writeFile).mockImplementation((_path, content) => {
            document = String(content);
            return Promise.resolve();
        });
        const { plugin } = await makePlugin([], '/managed.json');
        const starts: string[] = [];
        plugin.fileWatcher = {
            stopWatching: vi.fn(), startWatching: (active: MountPoint) => {
                starts.push(plugin.pathMapper.getEffectiveRealPath(active));
            }
        } as unknown as FileWatcher;
        await plugin.updateMount('docs', { ...mount('docs', '/missing'), fallbackRealPath: '/new-root' });
        expect(starts).toEqual(['/new-root']);
    });

    it('includes foreign fallback and override mounts in refresh and all three pickers', async () => {
        const mounts = [
            { ...mount('fallback'), deviceId: 'other', fallbackRealPath: '/fallback' },
            { ...mount('override'), deviceId: 'other', deviceOverrides: { desktop: '/override' } },
            { ...mount('inactive'), deviceId: 'other' },
        ];
        const { plugin, app } = await makePlugin(mounts);
        const { commands } = await loadCommands(plugin, app);
        const replay = vi.spyOn(plugin, 'notifyVaultMountAdded').mockResolvedValue(undefined);
        commands.get('refresh-mounts')!();
        await vi.waitFor(() => expect(replay).toHaveBeenCalledTimes(2));
        expect(replay.mock.calls.map(([entry]) => entry.id)).toEqual(['fallback', 'override']);
        const selections: string[][] = [];
        vi.spyOn(FuzzySuggestModal.prototype, 'open').mockImplementation(function (this: FuzzySuggestModal<MountPoint>) {
            selections.push(this.getItems().map(entry => entry.id));
        });
        for (const command of ['toggle-mount', 'toggle-readonly-mount', 'toggle-watcher-suppression-mount']) {
            commands.get(command)!();
        }
        expect(selections).toEqual(Array.from({ length: 3 }, () => ['fallback', 'override']));
    });

    it.each([false, true])('only warns about actually inactive foreign mounts (allow foreign: %s)', async allowForeign => {
        const { plugin, app } = await makePlugin([{ ...mount('foreign'), deviceId: 'other' }]);
        plugin.settings.allowForeignMounts = allowForeign;
        const { layoutReady } = await loadCommands(plugin, app);
        vi.spyOn(plugin, 'notifyVaultMountAdded').mockResolvedValue(undefined);
        layoutReady();
        await vi.waitFor(() => expect((plugin as unknown as { startHealthChecks: ReturnType<typeof vi.fn> }).startHealthChecks).toHaveBeenCalled());
        const warnings = vi.mocked(Notice).mock.calls.filter(([message]) => String(message).includes('inactive here'));
        expect(warnings).toHaveLength(allowForeign ? 0 : 1);
    });

    it.each([false, true])('throttles live scan counts and preserves final counts only while current (cancelled: %s)', async cancelled => {
        const existing = mount('docs');
        const { plugin } = await makePlugin([existing]);
        const started = deferred<void>();
        const released = deferred<void>();
        const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
        let progress!: (result: { fileCount: number; folderCount: number }) => void;
        let hugeMount!: () => void;
        vi.mocked(replayMountContentsToVault).mockImplementationOnce(async (_mount, deps) => {
            progress = deps.onProgress!;
            hugeMount = deps.onHugeMount!;
            started.resolve();
            await released.promise;
            return { fileCount: 7, folderCount: 4, scanLimitHit: false, isHuge: true };
        });
        const injection = plugin.notifyVaultMountAdded(existing);
        await started.promise;
        const notice = vi.mocked(Notice).mock.results.at(-1)!.value as Notice & { setMessage: ReturnType<typeof vi.fn> };
        const hiding = vi.spyOn(notice, 'hide');
        progress({ fileCount: 3, folderCount: 1 });
        expect(notice.setMessage).toHaveBeenLastCalledWith('Folder Bridge: Scanning "docs"... 1 folders, 3 files');
        clock.mockReturnValue(99);
        for (let item = 0; item < 1000; item++) progress({ fileCount: 4, folderCount: 2 });
        expect(notice.setMessage).toHaveBeenCalledOnce();
        clock.mockReturnValue(100);
        progress({ fileCount: 4, folderCount: 2 });
        expect(notice.setMessage).toHaveBeenCalledTimes(2);
        expect(notice.setMessage).toHaveBeenLastCalledWith('Folder Bridge: Scanning "docs"... 2 folders, 4 files');
        hugeMount();
        expect(notice.setMessage).toHaveBeenCalledTimes(3);
        expect(notice.setMessage).toHaveBeenLastCalledWith('Folder Bridge: "docs" is very large. This may take a moment...');
        if (cancelled) await plugin.notifyVaultMountRemoved(existing);
        notice.setMessage.mockClear();
        clock.mockReturnValue(200);
        progress({ fileCount: 5, folderCount: 2 });
        expect(notice.setMessage).toHaveBeenCalledTimes(cancelled ? 0 : 1);
        clock.mockReturnValue(201);
        progress({ fileCount: 6, folderCount: 3 });
        expect(notice.setMessage).toHaveBeenCalledTimes(cancelled ? 0 : 1);
        hugeMount();
        expect(notice.setMessage).toHaveBeenCalledTimes(cancelled ? 0 : 2);
        released.resolve();
        await injection;
        expect(hiding).toHaveBeenCalledOnce();
        const completions = vi.mocked(Notice).mock.calls.filter(([message]) => String(message).startsWith('Folder Bridge: Mounted '));
        expect(completions).toHaveLength(cancelled ? 0 : 1);
        if (!cancelled) expect(completions[0][0]).toBe('Folder Bridge: Mounted 4 folders and 7 files in "docs".');
    });

    it('hides the scan notice if replay rejects', async () => {
        const { plugin } = await makePlugin([mount('docs')]);
        const hiding = vi.spyOn(Notice.prototype, 'hide');
        vi.mocked(replayMountContentsToVault).mockRejectedValueOnce(new Error('scan failed'));
        await expect(plugin.notifyVaultMountAdded(mount('docs'))).rejects.toThrow('scan failed');
        expect(hiding).toHaveBeenCalledOnce();
    });

    it('removes siblings in parallel but waits for children before removing their parents', async () => {
        const existing = mount('docs');
        const { plugin, app, files, events } = await makePlugin([existing]);
        const first = Object.assign(new TFile(), { path: 'docs/sub/deep/first.md' });
        const second = Object.assign(new TFile(), { path: 'docs/sub/deep/second.md' });
        const deep = Object.assign(new TFolder(), { path: 'docs/sub/deep', children: [first, second] });
        const sub = Object.assign(new TFolder(), { path: 'docs/sub', children: [deep] });
        const root = Object.assign(new TFolder(), { path: 'docs', children: [sub] });
        for (const entry of [first, second, deep, sub, root]) files.set(entry.path, entry);
        const released = deferred<void>();
        const onChange = (app.vault as unknown as { onChange: ReturnType<typeof vi.fn<(event: string, path: string) => Promise<void>>> }).onChange;
        const original = onChange.getMockImplementation()!;
        onChange.mockImplementation(async (event: string, path: string) => {
            if (path === first.path) await released.promise;
            await original(event, path);
        });
        const hiding = vi.spyOn(Notice.prototype, 'hide');

        const removal = plugin.notifyVaultMountRemoved(existing);
        await vi.waitFor(() => expect(events).toEqual(['file-removed:docs/sub/deep/second.md']));
        expect(onChange).toHaveBeenCalledTimes(2);
        released.resolve();
        await removal;

        expect(events.slice(2)).toEqual(['folder-removed:docs/sub/deep', 'folder-removed:docs/sub', 'folder-removed:docs']);
        expect(app.vault.adapter.list).not.toHaveBeenCalled();
        expect(hiding).toHaveBeenCalledOnce();
        expect(vi.mocked(Notice).mock.calls.some(([message]) => String(message).includes('Unmounted "docs"'))).toBe(true);
    });

    it('drains failed removal batches and hides progress without removing ancestors', async () => {
        const existing = mount('docs');
        const { plugin, app, files, events } = await makePlugin([existing]);
        const first = Object.assign(new TFile(), { path: 'docs/first.md' });
        const second = Object.assign(new TFile(), { path: 'docs/second.md' });
        files.set('docs', Object.assign(new TFolder(), { path: 'docs', children: [first, second] }));
        files.set(first.path, first);
        files.set(second.path, second);
        const released = deferred<void>();
        const onChange = (app.vault as unknown as { onChange: ReturnType<typeof vi.fn> }).onChange;
        onChange.mockImplementation(async (_event: string, path: string) => {
            if (path === first.path) throw new Error('removal failed');
            await released.promise;
        });
        const hiding = vi.spyOn(Notice.prototype, 'hide');
        const removal = plugin.notifyVaultMountRemoved(existing);
        const rejected = expect(removal).rejects.toThrow('removal failed');
        await Promise.resolve();
        expect(hiding).not.toHaveBeenCalled();
        released.resolve();
        await rejected;
        expect(hiding).toHaveBeenCalledOnce();
        expect(onChange).toHaveBeenCalledTimes(2);
        expect(events).toEqual([]);
    });

    it('cancels remaining removals when a newer injection takes ownership', async () => {
        const existing = mount('docs');
        const { plugin, app, files, events } = await makePlugin([existing]);
        const child = Object.assign(new TFile(), { path: 'docs/old.md' });
        files.set('docs', Object.assign(new TFolder(), { path: 'docs', children: [child] }));
        files.set(child.path, child);
        const released = deferred<void>();
        const onChange = (app.vault as unknown as { onChange: ReturnType<typeof vi.fn<(event: string, path: string) => Promise<void>>> }).onChange;
        const original = onChange.getMockImplementation()!;
        onChange.mockImplementation(async (event: string, path: string) => {
            if (event === 'file-removed') await released.promise;
            await original(event, path);
        });
        const removal = plugin.notifyVaultMountRemoved(existing);
        await plugin.notifyVaultMountAdded(existing);
        released.resolve();
        await removal;
        expect(files.has('docs')).toBe(true);
        expect(events).not.toContain('folder-removed:docs');
        expect(vi.mocked(Notice).mock.calls.some(([message]) => String(message).includes('Unmounted'))).toBe(false);
    });

    it.each(['fallback', 'override'] as const)('labels the effective %s path accurately', async source => {
        const existing = {
            ...mount('docs', '/missing'), fallbackRealPath: '/fallback',
            deviceOverrides: source === 'override' ? { desktop: '/override' } : undefined
        };
        const { plugin, app } = await makePlugin([existing]);
        const { tab } = await loadCommands(plugin, app);
        if (source === 'fallback') plugin.pathMapper.setResolvedPath(existing.id, '/fallback');
        tab.renderMountRow(new SettingsElement() as unknown as HTMLElement, existing);
        const setting = vi.mocked(Setting).mock.results.at(-1)!.value as { desc: string };
        expect(setting.desc).toContain(source === 'override' ? 'Path override for this device: /override' : 'Using fallback path: /fallback');
    });

    it('browses, saves, displays and clears a fallback TOC with a Windows primary filename', async () => {
        const { plugin, app } = await makePlugin([], 'C:\\Vault\\custom.json');
        const { tab } = await loadCommands(plugin, app);
        const container = new SettingsElement();
        tab.containerEl = container as unknown as HTMLElement;
        tab.display();
        const browse = container.descendants().find(element => element.text === 'Browse...')!;
        const row = container.descendants().find(element => element.children.includes(browse))!;
        const input = row.children.find(element => element.tag === 'input')!;
        vi.mocked(browseFolderOnDisk).mockResolvedValueOnce('/linux');
        browse.onclick!();
        await vi.waitFor(() => expect(input.value).toBe('/linux/custom.json'));
        vi.mocked(checkPathAccessible).mockImplementation(candidate => Promise.resolve({ accessible: candidate === '/linux/custom.json', readOnly: false }));
        row.children.find(element => element.text === 'Set fallback')!.onclick!();
        await vi.waitFor(() => expect(container.descendants().some(element => element.text === 'Using fallback TOC file on this device: /linux/custom.json')).toBe(true));
        expect(plugin.settings.managedTocSourceFallback).toBe('/linux/custom.json');
        expect(plugin.resolvedManagedTocSource).toBe('/linux/custom.json');
        const newRow = container.descendants().find(element => element.children.some(child => child.text === 'Set fallback'))!;
        newRow.children.find(element => element.tag === 'input')!.value = '';
        newRow.children.find(element => element.text === 'Set fallback')!.onclick!();
        await vi.waitFor(() => expect(plugin.resolvedManagedTocSource).toBe('C:\\Vault\\custom.json'));
        expect(plugin.settings.managedTocSourceFallback).toBe('');
    });

    it('replays files when the device-path control changes a foreign mount', async () => {
        const existing = { ...mount('docs'), deviceId: 'other', deviceOverrides: { desktop: '/old-root' } };
        const { plugin, app, files, events, saveData } = await makePlugin([existing]);
        const child = Object.assign(new TFile(), { path: 'docs/old.md' });
        files.set('docs', Object.assign(new TFolder(), { path: 'docs', children: [child] }));
        files.set(child.path, child);
        vi.mocked(app.vault.adapter.list).mockResolvedValue({ files: ['docs/new.md'], folders: [] });
        const startWatching = vi.fn();
        plugin.fileWatcher = { stopWatching: vi.fn(), startWatching } as unknown as FileWatcher;

        await plugin.setDeviceOverride('docs', '/new-root');

        expect(events.slice(0, 2)).toEqual(['file-removed:docs/old.md', 'folder-removed:docs']);
        expect(files.has('docs/old.md')).toBe(false);
        expect(files.has('docs/new.md')).toBe(true);
        expect(plugin.pathMapper.getEffectiveRealPath(plugin.settings.mountPoints[0])).toBe('/new-root');
        expect(plugin.settings.allowlist).toContain('/new-root');
        expect(startWatching).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ deviceOverrides: { desktop: '/new-root' } }));
        expect(saveData).toHaveBeenCalled();
    });

    it('does not replay disabled mounts or grant rejected device paths', async () => {
        const existing = { ...mount('docs'), enabled: false };
        const { plugin } = await makePlugin([existing]);
        const replay = vi.spyOn(plugin, 'notifyVaultMountAdded');
        await plugin.setDeviceOverride(existing.id, '/valid');
        expect(replay).not.toHaveBeenCalled();
        vi.mocked(plugin.security.validateMount).mockReturnValue('Invalid mount');
        await plugin.setDeviceOverride(existing.id, '/rejected');
        expect(plugin.settings.allowlist).not.toContain('/rejected');
        expect(plugin.settings.mountPoints[0].deviceOverrides?.desktop).toBe('/valid');
    });

    it('orders overlapping edits to the same mount while a root probe is pending', async () => {
        const existing = mount('docs');
        const { plugin } = await makePlugin([existing]);
        const probe = deferred<{ accessible: boolean; readOnly: boolean }>();
        vi.mocked(checkPathAccessible).mockImplementation(path => path === '/slow-primary' ? probe.promise : Promise.resolve({ accessible: true, readOnly: false }));
        const first = plugin.updateMount('docs', { ...existing, realPath: '/slow-primary', fallbackRealPath: '/first-root' });
        await vi.waitFor(() => expect(checkPathAccessible).toHaveBeenCalledWith('/slow-primary'));
        const second = plugin.updateMount('docs', { ...existing, realPath: '/latest-root' });
        await new Promise(resolve => setTimeout(resolve, 10));
        expect(plugin.settings.mountPoints[0].realPath).toBe('/slow-primary');
        probe.resolve({ accessible: false, readOnly: false });
        await Promise.all([first, second]);
        expect(plugin.pathMapper.getEffectiveRealPath(plugin.settings.mountPoints[0])).toBe('/latest-root');
    });
});

describe('unsafe device overrides', () => {
    const persistedOverrides = (plugin: FolderBridgePlugin) =>
        (plugin as unknown as { persistedMountPoints: MountPoint[] }).persistedMountPoints[0].deviceOverrides;

    it('does not resolve or allowlist a protected override for this device', async () => {
        const { plugin } = await makePlugin([{ ...mount('docs', '/primary'), deviceOverrides: { desktop: '/etc' } }]);
        const mapped = plugin.pathMapper.getMountByVirtualPath('docs')!;

        expect(plugin.pathMapper.getEffectiveRealPath(mapped)).toBe('/primary');
        expect(plugin.pathMapper.toRealPath('docs/note.md', mapped)).not.toContain('etc');
        expect(plugin.settings.allowlist).not.toContain('/etc');
        expect(plugin.settings.allowlist).toContain('/primary');
    });

    it('keeps the stored override so nothing is destroyed on disk', async () => {
        const { plugin } = await makePlugin([{ ...mount('docs', '/primary'), deviceOverrides: { desktop: '/etc' } }]);
        expect(persistedOverrides(plugin)).toEqual({ desktop: '/etc' });
    });

    it('still honors a safe override for this device', async () => {
        const { plugin } = await makePlugin([{ ...mount('docs', '/primary'), deviceOverrides: { desktop: '/override' } }]);
        const mapped = plugin.pathMapper.getMountByVirtualPath('docs')!;

        expect(plugin.pathMapper.getEffectiveRealPath(mapped)).toBe('/override');
        expect(plugin.settings.allowlist).toContain('/override');
    });

    it('only checks this device: another device\'s entry does not affect it', async () => {
        const { plugin } = await makePlugin([{
            ...mount('docs', '/primary'), deviceOverrides: { laptop: '/etc', desktop: '/override' },
        }]);
        const mapped = plugin.pathMapper.getMountByVirtualPath('docs')!;

        expect(plugin.pathMapper.getEffectiveRealPath(mapped)).toBe('/override');
    });
});
