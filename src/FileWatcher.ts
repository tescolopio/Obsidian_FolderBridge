// Type-only import — no runtime require, so chokidar's Node.js dependencies are
// never evaluated at bundle-load time on Obsidian Mobile.
import type * as Chokidar from 'chokidar';
import { App, normalizePath, Platform } from 'obsidian';
import { MountPoint } from './types';
import { PathMapper } from './PathMapper';
import { logger } from './logger';
import { isVisibleFileInMount, MARKDOWN_EXTENSIONS } from './mountFileFilter';
import { loadOptionalNodeModule } from './runtimeNode';

const pathMod: typeof import('path') = loadOptionalNodeModule<typeof import('path')>('path') ?? null as never;

/** Private vault onChange interface used for external-change notifications. */
type VaultInternal = {
    onChange(event: string, path: string, prev: null, stat: { type: string; ctime: number; mtime: number; size: number } | null): Promise<void>;
};

export class FileWatcher {
    private app: App;
    private pathMapper: PathMapper;
    private isIgnored: (name: string, mount: MountPoint, mountRelativePath?: string) => boolean;
    private watchers: Map<string, Chokidar.FSWatcher> = new Map();
    private watcherBackendWarningShown = false;

    /**
     * Chokidar loader — resolved lazily so Node.js fs/events are never loaded on
     * Obsidian Mobile.  Can be overridden in tests to inject a mock.
     */
    static _loadChokidar: () => typeof Chokidar = () => {
        const chokidar = loadOptionalNodeModule<typeof Chokidar>('chokidar');
        if (!chokidar) throw new Error('chokidar is unavailable in this environment');
        return chokidar;
    };

    /**
     * Per-path debounce timers for 'file-changed' events.  Keyed by real path
     * so that back-to-back writes from external tools (e.g. PlantUML, Pandoc)
     * are coalesced into a single vault notification.
     */
    private debounceTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
    private static readonly DEFAULT_DEBOUNCE_MS = 300;

    /**
     * Runtime event-suppression state.  NOT persisted — resets on plugin reload.
     *
     * When a mount id is present in `suppressedMounts`, or when `_suppressAll`
     * is true, `dispatchEvent` silently drops all vault notifications for that
     * mount.  This lets external scripts (Templater, JS Engine, QuickAdd) mute
     * Obsidian plugin reactions during bulk-sync windows:
     *
     *   const fb = app.plugins.getPlugin('folderbridge');
     *   fb.setWatcherSuppressed(null, true);   // mute all mounts
     *   // … run sync …
     *   fb.setWatcherSuppressed(null, false);  // restore
     */
    private suppressedMounts: Set<string> = new Set();
    private _suppressAll = false;

    constructor(app: App, pathMapper: PathMapper, isIgnored: (name: string, mount: MountPoint, mountRelativePath?: string) => boolean) {
        this.app = app;
        this.pathMapper = pathMapper;
        this.isIgnored = isIgnored;
    }

    private warnWatcherUnavailable(mount: MountPoint, error: unknown): void {
        logger.warn(`[FolderBridge] File watcher unavailable for mount ${mount.virtualPath}:`, error);
        if (this.watcherBackendWarningShown) return;
        this.watcherBackendWarningShown = true;
    }

    // ── Suppression API ────────────────────────────────────────────────────

    /**
     * Enable or disable vault-event dispatching for one mount or all mounts.
     *
     * @param mountId  The mount's `id`, or `null` to affect every mount.
     * @param suppress `true` to mute events, `false` to restore them.
     */
    setSuppressed(mountId: string | null, suppress: boolean): void {
        if (mountId === null) {
            this._suppressAll = suppress;
        } else if (suppress) {
            this.suppressedMounts.add(mountId);
        } else {
            this.suppressedMounts.delete(mountId);
        }
    }

    /** Returns true when *all* mounts are being suppressed via the global flag. */
    isSuppressedAll(): boolean {
        return this._suppressAll;
    }

    /** Returns true when vault events are suppressed for the given mount. */
    isSuppressed(mountId: string): boolean {
        return this._suppressAll || this.suppressedMounts.has(mountId);
    }

    /**
     * Start watching a mount point for changes.
     */
    startWatching(mount: MountPoint): void {
        // Chokidar requires Node.js fs/events APIs that are unavailable in Obsidian's
        // Capacitor WebView on Android / iOS.  Skip file watching on mobile entirely;
        // the vault is refreshed manually or via WebDAV polling.
        if (Platform.isMobile) {
            logger.debug(`[FolderBridge] Skipping file watcher on mobile for: ${mount.virtualPath}`);
            return;
        }

        // Cloud mounts (WebDAV, S3, SFTP) are accessed over the network — there
        // is no local filesystem path to watch for native change events.
        if (mount.mountType === 'webdav' || mount.mountType === 's3' || mount.mountType === 'sftp') {
            logger.debug(`[FolderBridge] Skipping file watcher for ${mount.mountType ?? 'remote'} mount: ${mount.virtualPath}`);
            return;
        }

        if (this.watchers.has(mount.id)) {
            this.stopWatching(mount);
        }

        const realPath = this.pathMapper.getEffectiveRealPath(mount);

        // Load Node.js modules lazily — these are only available on desktop.
        // Uses FileWatcher._loadChokidar so tests can supply a mock by reassigning it.
        const path = pathMod;
        if (!path) {
            this.warnWatcherUnavailable(mount, new Error('path module is unavailable in this environment'));
            return;
        }

        let chokidar: typeof Chokidar;
        try {
            chokidar = FileWatcher._loadChokidar();
        } catch (error) {
            this.warnWatcherUnavailable(mount, error);
            return;
        }

        // [FEATURE_20260222] Initialize chokidar watcher for the mount's real path
        const watcher = chokidar.watch(realPath, {
            ignored: (testPath: string, stats?: import('fs').Stats) => {
                // Ignore hidden files/folders and node_modules
                const name = path.basename(testPath);
                if (name.startsWith('.') || name === 'node_modules') return true;

                // Compute mount-relative real path for path-style ignore patterns
                const normalizedTest = testPath.replace(/\\/g, '/');
                const normalizedMountReal = realPath.replace(/\\/g, '/').replace(/\/$/, '');
                const mountRelativePath: string | undefined = normalizedTest.startsWith(normalizedMountReal + '/')
                    ? normalizedTest.slice(normalizedMountReal.length + 1)
                    : undefined;

                // Apply user-defined ignore rules
                if (this.isIgnored(name, mount, mountRelativePath)) return true;

                return false;
            },
            // SECURITY: Do not follow symlinks. If a symlink inside the mount points
            // outside the mount's real path, PathMapper.toVirtualPath() returns the
            // mount root (not undefined) for out-of-bounds paths, which would cause
            // vault.onChange to signal Obsidian to remove the entire mount from its
            // view. Disabling symlink-following prevents chokidar from ever emitting
            // events for paths outside the mount boundary.
            followSymlinks: false,
            ignoreInitial: true, // Don't trigger 'add' events for existing files on startup
            persistent: true,
            // Per-mount polling override (useful for network drives / NAS that don't
            // support native inotify / kqueue / ReadDirectoryChangesW events)
            usePolling: mount.watcherUsePolling ?? false,
            interval: mount.watcherPollingIntervalMs ?? 2000,
            awaitWriteFinish: {
                stabilityThreshold: 500,
                pollInterval: 100
            }
        });

        watcher
            .on('add', (filePath) => this.handleEvent('file-created', filePath, mount))
            .on('change', (filePath) => this.handleEvent('file-changed', filePath, mount))
            .on('unlink', (filePath) => this.handleEvent('file-removed', filePath, mount))
            .on('addDir', (dirPath) => this.handleEvent('folder-created', dirPath, mount))
            .on('unlinkDir', (dirPath) => this.handleEvent('folder-removed', dirPath, mount))
            .on('error', (error) => logger.warn(`[FolderBridge] Watcher error for mount ${mount.virtualPath}:`, error));

        this.watchers.set(mount.id, watcher);
        logger.debug(`[FolderBridge] Started watching: ${realPath}`);
    }

    /**
     * Stop watching a mount point.
     */
    stopWatching(mount: MountPoint): void {
        const watcher = this.watchers.get(mount.id);
        if (watcher) {
            void watcher.close();
            this.watchers.delete(mount.id);
            logger.debug(`[FolderBridge] Stopped watching: ${this.pathMapper.getEffectiveRealPath(mount)}`);
        }
    }

    /**
     * Stop all active watchers.
     */
    stopAll(): void {
        // Cancel pending debounce timers before closing so they don't fire
        // after the plugin is unloaded.
        for (const timer of this.debounceTimers.values()) clearTimeout(timer);
        this.debounceTimers.clear();
        for (const watcher of this.watchers.values()) {
            void watcher.close();
        }
        this.watchers.clear();
    }

    /**
     * Synchronous per-event entry point called by chokidar listeners.
     *
     * 'file-changed' events are debounced per real path (DEBOUNCE_MS) to
     * coalesce back-to-back writes from external tools like PlantUML, Pandoc,
     * or save-on-every-keystroke editors.  All other event types execute
     * immediately since they represent unambiguous structural changes.
     */
    private handleEvent(eventType: string, realPath: string, mount: MountPoint): void {
        if (eventType !== 'file-changed') {
            void this.dispatchEvent(eventType, realPath, mount);
            return;
        }
        // Cancel any pending notification for this exact path and schedule a
        // fresh one — timer resets on every write, firing only after the last.
        const debounceMs = mount.watcherDebounceMs ?? FileWatcher.DEFAULT_DEBOUNCE_MS;
        const existing = this.debounceTimers.get(realPath);
        if (existing !== undefined) clearTimeout(existing);
        const timer = setTimeout(() => {
            this.debounceTimers.delete(realPath);
            void this.dispatchEvent(eventType, realPath, mount);
        }, debounceMs);
        this.debounceTimers.set(realPath, timer);
    }

    /**
     * Perform the actual vault.onChange notification for a chokidar event.
     */
    private async dispatchEvent(eventType: string, realPath: string, mount: MountPoint): Promise<void> {
        // ── Runtime suppression gate ──────────────────────────────────────────
        // Checked before any path mapping so suppression has zero overhead.
        // Also honours the persistent per-mount `watcherSuppressAllEvents` flag.
        if (this.isSuppressed(mount.id) || mount.watcherSuppressAllEvents) {
            logger.debug(`[FolderBridge] watcher events suppressed for mount "${mount.virtualPath}" — dropped ${eventType} for ${realPath}`);
            return;
        }

        const vault = this.app.vault as typeof this.app.vault & VaultInternal;
        if (typeof vault.onChange !== 'function') return;

        const path = pathMod;
        const virtualPath = this.pathMapper.toVirtualPath(realPath, mount);
        const normalizedPath = normalizePath(virtualPath);

        if ((eventType === 'file-created' || eventType === 'file-changed' || eventType === 'file-removed') && !isVisibleFileInMount(normalizedPath, mount)) {
            logger.debug(`[FolderBridge] visibleFileFilter suppressed ${eventType} for ${normalizedPath}`);
            return;
        }

        // Bug fix: when watcherCreateFilter === 'markdown-only', suppress vault
        // file-created events for binary files (images, PDFs, videos, etc.).
        // This prevents third-party attachment-rename plugins from treating
        // externally created files in the mount as new "active-note attachments"
        // and silently renaming them to match the currently open note.
        if (eventType === 'file-created' && mount.watcherCreateFilter === 'markdown-only') {
            const ext = path.extname(normalizedPath).toLowerCase();
            if (!MARKDOWN_EXTENSIONS.has(ext)) {
                logger.debug(`[FolderBridge] watcherCreateFilter=markdown-only: suppressed file-created for ${normalizedPath}`);
                return;
            }
        }

        try {
            const existsInVault = !!this.app.vault.getAbstractFileByPath(normalizedPath);

            if (eventType === 'file-created' || eventType === 'folder-created') {
                if (existsInVault) return; // Already known to Obsidian
            } else if (eventType === 'file-removed' || eventType === 'folder-removed' || eventType === 'file-changed') {
                if (!existsInVault) return; // Not known to Obsidian, nothing to remove/modify
            }

            if (eventType === 'file-created' || eventType === 'file-changed') {
                // Obsidian expects a stat object for created/modified files
                const stat = await this.app.vault.adapter.stat(normalizedPath);
                if (stat) {
                    await vault.onChange(eventType, normalizedPath, null, stat);
                }
            } else {
                // Removed events don't need a stat object
                await vault.onChange(eventType, normalizedPath, null, null);
            }

            // 'raw' triggers Obsidian's cache refresh (MetadataCache re-read)
            if (eventType === 'file-changed') {
                await vault.onChange('raw', normalizedPath, null, null);
            }
        } catch (e) {
            logger.debug(`[FolderBridge] Failed to handle watcher event ${eventType} for ${normalizedPath}:`, e);
        }
    }
}
