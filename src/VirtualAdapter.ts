import { normalizePath, Notice, DataAdapter, DataWriteOptions } from 'obsidian';
import { PathMapper } from './PathMapper';
import { SecurityManager } from './SecurityManager';
import { ConflictMode, MountPoint } from './types';
import { RecentTexts, isMergeableText, mergeText } from './textMerge';
import { WebDAVAdapter } from './WebDAVAdapter';
import { S3Adapter } from './S3Adapter';
import { SFTPAdapter } from './SFTPAdapter';
import { FileServer, STREAMING_MIME } from './FileServer';
import { logger } from './logger';
import { isVisibleFileInMount } from './mountFileFilter';
import { loadOptionalNodeModule } from './runtimeNode';
import {
	realPathToResourceUrl,
	tryReadAsDataUri,
	ensureLongPathPrefix,
	isReservedWindowsFilename,
	translateFsError,
	isCloudPlaceholder,
	EMBEDDABLE_MIME,
} from './OSHelpers';

// Lazy-loaded Node.js builtins — wrapped in try/catch so the bundle loads on
// Obsidian Mobile (Capacitor) where Node APIs are unavailable.  On mobile these
// will be null; local-mount operations gracefully fail while WebDAV mounts work.
const fs: typeof import('fs') = loadOptionalNodeModule<typeof import('fs')>('fs') ?? null as never;
const path: typeof import('path') = loadOptionalNodeModule<typeof import('path')>('path') ?? null as never;

/** Folder inside the vault's .trash where someone else's version is kept when a save would replace it. */
export const CONFLICT_COPIES_FOLDER = 'folderbridge-conflicts';

/** Local date and time for file names, e.g. "2026-05-04 13.07.09" (no characters Windows forbids). */
function fileStamp(date = new Date()): string {
	const p = (n: number) => String(n).padStart(2, '0');
	return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}.${p(date.getMinutes())}.${p(date.getSeconds())}`;
}

/** Decode UTF-8 text the way fs.readFile(…, 'utf8') does, or null when it isn't valid UTF-8. */
function decodeUtf8(buf: Uint8Array): string | null {
	try {
		return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buf);
	} catch {
		return null;
	}
}

/**
 * VirtualAdapter is a shim that wraps Obsidian's built-in FileSystemAdapter.
 *
 * For every vault I/O method it checks whether the requested path falls inside
 * a user-configured mount point.  If so, it routes the call through Node.js
 * `fs` APIs operating on the real external path.  Otherwise it delegates to
 * the original adapter unchanged.
 *
 * The class intentionally avoids `implements DataAdapter` so that we are not
 * required to satisfy every internal/undocumented method on the interface; we
 * forward unknowns to `original` via the Proxy installed in main.ts.
 */
export class VirtualAdapter {
	private original: unknown;
	private pathMapper: PathMapper;
	private security: SecurityManager;
	private dryRun: boolean;
	private onMountRootDelete: (mount: MountPoint, trash?: boolean) => Promise<'unmount' | 'delete' | 'cancel'>;
	private onMountRootMove: (mount: MountPoint, newVirtualPath: string) => Promise<void>;
	private isIgnored: (name: string, mount: MountPoint, mountRelativePath?: string) => boolean;
	/** WebDAV client instances keyed by mount.id, managed by the plugin. */
	private webdavAdapters: Map<string, WebDAVAdapter> = new Map();
	/** S3 / Backblaze B2 client instances keyed by mount.id. */
	private s3Adapters: Map<string, S3Adapter> = new Map();
	/** SFTP client instances keyed by mount.id. */
	private sftpAdapters: Map<string, SFTPAdapter> = new Map();
	/** Max bytes for data: URI generation; configurable via plugin settings. */
	private maxDataUriBytes: number;
	/** Mount IDs that have already shown a read-only notice this session (one-time per mount). */
	private readOnlyNoticedMounts: Set<string> = new Set();
	/** Optional localhost HTTP server for streaming video/audio from local mounts. */
	private fileServer: FileServer | null = null;
	/**
	 * Called after every successful write/append on a mounted path so that
	 * Obsidian's MetadataCache is immediately notified.  Without this callback,
	 * Obsidian's own file-system watcher (which only watches the vault directory)
	 * never fires `vault.onChange('raw', …)` for paths on external mounts, leaving
	 * MetadataCache stale — which means features like Bases that subscribe to
	 * metadata-changed events won't update their views after a frontmatter edit.
	 * Particularly important for Windows mapped / network drives where native
	 * ReadDirectoryChangesW notifications don't propagate over SMB, so Chokidar
	 * (with usePolling:false) also misses the write.
	 */
	private onModify?: (normalizedPath: string) => Promise<void>;
	/**
	 * Called after a mounted file or folder is successfully deleted so Obsidian
	 * can immediately remove it from the in-memory vault tree even when the
	 * external watcher backend is unavailable or suppressed.
	 */
	private onDelete?: (normalizedPath: string) => Promise<void>;
	/**
	 * The modification time Obsidian has for a vault path, or undefined when
	 * Obsidian doesn't know the file (set by the plugin from the vault index).
	 * A write to a path Obsidian doesn't know is a create, and a create must
	 * never replace a file that already exists on the drive.
	 */
	getKnownMtime?: (normalizedPath: string) => number | undefined;
	/**
	 * What to do when a file on a local mount changed on the drive since
	 * Obsidian last saw it and Obsidian saves over it (set by the plugin from
	 * the settings, default 'merge'). Only used when getKnownMtime is set;
	 * without it the adapter overwrites, as before.
	 */
	getConflictMode?: () => ConflictMode;
	/**
	 * Called after a save that merged in someone else's changes. Obsidian
	 * ignores change events while it is saving, so the plugin tells the open
	 * editor to reload the merged text once the save has finished.
	 */
	onMergedSave?: (normalizedPath: string) => void;
	/** True when a path is open in an editor: its merge base is then never evicted from memory. */
	isOpenInEditor?: (normalizedPath: string) => boolean;
	/** The last text read or written per path on local mounts: the base of a three-way merge. */
	private recentTexts = new RecentTexts(p => this.isOpenInEditor?.(p) ?? false);
	/**
	 * Per path, the modification time and size of the file right after this
	 * adapter last wrote it. Obsidian learns the new time only a moment later
	 * (onModify runs in the background, and not at all when events are
	 * suppressed), so a second quick save must not mistake our own previous
	 * save for someone else's change.
	 */
	private ownWrites = new Map<string, { mtime: number; size: number }>();
	/** Paths being saved by process(): it has just read the file, so there is nothing to protect. */
	private processing = new Set<string>();

	constructor(
		original: unknown,
		pathMapper: PathMapper,
		security: SecurityManager,
		dryRun = false,
		maxDataUriBytes = 10 * 1024 * 1024,
		onMountRootDelete: (mount: MountPoint, trash?: boolean) => Promise<'unmount' | 'delete' | 'cancel'>,
		onMountRootMove: (mount: MountPoint, newVirtualPath: string) => Promise<void>,
		isIgnored: (name: string, mount: MountPoint, mountRelativePath?: string) => boolean,
		onModify?: (normalizedPath: string) => Promise<void>,
		onDelete?: (normalizedPath: string) => Promise<void>
	) {
		this.original = original;
		this.pathMapper = pathMapper;
		this.security = security;
		this.dryRun = dryRun;
		this.maxDataUriBytes = maxDataUriBytes;
		this.onMountRootDelete = onMountRootDelete;
		this.onMountRootMove = onMountRootMove;
		this.isIgnored = isIgnored;
		this.onModify = onModify;
		this.onDelete = onDelete;
	}

	private async notifyDelete(normalizedPath: string): Promise<void> {
		try {
			await this.onDelete?.(normalizedPath);
		} catch {
			// Best-effort only: the delete already succeeded on the backend.
		}
	}

	/** Register the FileServer instance so getResourcePath can use it for video/audio. */
	setFileServer(server: FileServer): void {
		this.fileServer = server;
	}

	/** Register (or replace) the WebDAV client for a mount. */
	setWebDAVAdapter(mountId: string, adapter: WebDAVAdapter): void {
		this.webdavAdapters.set(mountId, adapter);
	}

	/** Remove the WebDAV client for a mount (called on unmount). */
	clearWebDAVAdapter(mountId: string): void {
		this.webdavAdapters.delete(mountId);
	}

	/** Register (or replace) the S3 client for a mount. */
	setS3Adapter(mountId: string, adapter: S3Adapter): void {
		this.s3Adapters.set(mountId, adapter);
	}

	/** Remove the S3 client for a mount (called on unmount). */
	clearS3Adapter(mountId: string): void {
		this.s3Adapters.delete(mountId);
	}

	/** Register (or replace) the SFTP client for a mount. */
	setSFTPAdapter(mountId: string, adapter: SFTPAdapter): void {
		this.sftpAdapters.set(mountId, adapter);
	}

	/** Remove and disconnect the SFTP client for a mount (called on unmount). */
	clearSFTPAdapter(mountId: string): void {
		const adapter = this.sftpAdapters.get(mountId);
		if (adapter) {
			void adapter.disconnect().catch(error => {
				logger.error(`[FolderBridge] Failed to disconnect SFTP adapter for mount ${mountId}:`, error);
			});
			this.sftpAdapters.delete(mountId);
		}
	}

	/** Update dry-run mode without reloading the plugin. */
	setDryRun(val: boolean): void { this.dryRun = val; }

	/** Update the data: URI size cap without reloading the plugin. */
	setMaxDataUri(bytes: number): void { this.maxDataUriBytes = bytes; }

	/**
	 * Clear the one-shot read-only notice record for a mount.
	 * Call this whenever the mount's readOnly flag is changed so the Notice
	 * fires again if needed after the next toggle.
	 */
	clearReadOnlyNotice(mountId: string): void {
		this.readOnlyNoticedMounts.delete(mountId);
	}

	/**
	 * Silently swallow a write blocked by readOnly and show a one-time notice.
	 * Called instead of throwing, so Obsidian never sees a save error and the
	 * editor stays in a usable state.
	 */
	private warnReadOnly(mount: MountPoint): void {
		if (!this.readOnlyNoticedMounts.has(mount.id)) {
			this.readOnlyNoticedMounts.add(mount.id);
			new Notice(
				`Folder Bridge: "${mount.virtualPath}" is read-only — this change was not saved.`,
				6000
			);
		}
	}

	// ------------------------------------------------------------------
	// Delegation helper
	// ------------------------------------------------------------------

	private orig(): DataAdapter { return this.original as DataAdapter; }

	// ------------------------------------------------------------------
	// Path helpers
	// ------------------------------------------------------------------

	/**
	 * Translate a virtual vault path to a real filesystem path, applying the
	 * Windows long-path prefix (`\\?\`) when the path exceeds 255 characters.
	 */
	private toReal(normalizedPath: string, mount: MountPoint): string {
		return ensureLongPathPrefix(this.pathMapper.toRealPath(normalizedPath, mount));
	}

	/**
	 * Translate a virtual vault path to a server-relative WebDAV path.
	 * Unlike toReal(), this never applies the Windows long-path prefix and
	 * always uses forward slashes, as required by WebDAV URLs.
	 */
	private toServerPath(normalizedPath: string, mount: MountPoint): string {
		return this.pathMapper.toRealPath(normalizedPath, mount).replace(/\\/g, '/');
	}

	/**
	 * Return the WebDAVAdapter for a mount if it is a WebDAV mount, or null.
	 */
	private getWebDAV(mount: MountPoint): WebDAVAdapter | null {
		if (mount.mountType !== 'webdav') return null;
		return this.webdavAdapters.get(mount.id) ?? null;
	}

	/**
	 * Return the S3Adapter for a mount if it is an S3 mount, or null.
	 */
	private getS3(mount: MountPoint): S3Adapter | null {
		if (mount.mountType !== 's3') return null;
		return this.s3Adapters.get(mount.id) ?? null;
	}

	/**
	 * Return the SFTPAdapter for a mount if it is an SFTP mount, or null.
	 */
	private getSFTP(mount: MountPoint): SFTPAdapter | null {
		if (mount.mountType !== 'sftp') return null;
		return this.sftpAdapters.get(mount.id) ?? null;
	}

	// ------------------------------------------------------------------
	// Security helpers
	// ------------------------------------------------------------------

	private assertAllowed(realPath: string, skipAllowlist = false): void {
		if (skipAllowlist) return;
		if (!this.security.isAllowed(realPath)) {
			throw new Error(
				`Folder Bridge: "${realPath}" is not on the allowlist. ` +
				`Add the mount in plugin settings to permit access.`
			);
		}
	}

	/** True for mount types whose paths are not local filesystem paths (no allowlist check). */
	private static isCloudMount(mount: MountPoint): boolean {
		return mount.mountType === 's3' || mount.mountType === 'sftp' || mount.mountType === 'webdav';
	}

	/**
	 * On Windows, certain device names (CON, NUL, COM1-9, LPT1-9, etc.) are
	 * reserved by the OS and cannot be used as file or folder names.  Attempting
	 * to create them produces a cryptic OS error; this guard surfaces a clear
	 * message instead.
	 */
	private assertNotReserved(realPath: string): void {
		const base = path.basename(realPath);
		if (isReservedWindowsFilename(base)) {
			throw new Error(
				`Folder Bridge: "${base}" is a reserved device name on Windows and ` +
				`cannot be used as a file or folder name (e.g. CON, NUL, COM1-9, LPT1-9).`
			);
		}
	}

	private isPathIgnored(normalizedPath: string, mount: MountPoint): boolean {
		// Compute the path relative to the mount's virtual root for path-style patterns
		const mountVirtual = normalizePath(mount.virtualPath);
		const mountRelativePath: string | undefined = normalizedPath.startsWith(mountVirtual + '/')
			? normalizedPath.slice(mountVirtual.length + 1)
			: (normalizedPath === mountVirtual ? '' : undefined);

		const parts = normalizedPath.split('/');
		for (const part of parts) {
			if (part && this.isIgnored(part, mount, mountRelativePath)) return true;
		}
		return false;
	}

	private isVisibleMountFile(normalizedPath: string, mount: MountPoint): boolean {
		return isVisibleFileInMount(normalizedPath, mount);
	}

	private assertVisibleMountFile(normalizedPath: string, mount: MountPoint): void {
		if (!this.isVisibleMountFile(normalizedPath, mount)) {
			throw new Error(`Folder Bridge: Path "${normalizedPath}" is hidden by this mount's visible file filter.`);
		}
	}

	// ------------------------------------------------------------------
	// getName
	// ------------------------------------------------------------------

	getName(): string { return this.orig().getName?.() ?? 'Vault'; }

	// ------------------------------------------------------------------
	// getFullPath
	// ------------------------------------------------------------------

	/**
	 * Returns the absolute OS path for a vault-relative path.
	 *
	 * Obsidian's `vault.create()` / `vault.createBinary()` call
	 * `adapter.getFullPath()` internally to resolve parent-directory checks and
	 * post-write verification against the local filesystem.  Without this
	 * override the Proxy would delegate to the original FileSystemAdapter, which
	 * returns `{vaultDir}/{virtualPath}` — a path that does not exist on disk for
	 * virtual mount files (whose real location is the mounted source directory).
	 * The resulting existence check fails silently, so vault.create() returns
	 * null and Obsidian opens an empty tab with no note.
	 *
	 * For local mounts we return the real mounted OS path.
	 * For cloud mounts (WebDAV / S3 / SFTP) there is no local path; we
	 * delegate to the original adapter so callers get the vault-relative path
	 * they already had (cloud files are not accessed via the local filesystem).
	 */
	getFullPath(normalizedPath: string): string {
		const mount = this.pathMapper.getMountForPath(normalizedPath);
		if (mount && !VirtualAdapter.isCloudMount(mount)) {
			return this.pathMapper.toRealPath(normalizedPath, mount);
		}
		return (this.orig() as DataAdapter & { getFullPath?(path: string): string }).getFullPath?.(normalizedPath) ?? normalizedPath;
	}

	// ------------------------------------------------------------------
	// exists
	// ------------------------------------------------------------------

	async exists(normalizedPath: string, sensitive?: boolean): Promise<boolean> {
		const mount = this.pathMapper.getMountForPath(normalizedPath);
		if (mount) {
			return (await this.stat(normalizedPath)) !== null;
		}

		// A path may not physically exist in the vault yet but still needs to
		// "exist" if it is a virtual parent directory of a mount.
		if (this.pathMapper.hasMountsUnder(normalizedPath)) {
			const real = await this.orig().exists(normalizedPath, sensitive);
			if (real) return true;
			return this.pathMapper.getVirtualMountsDirectChildren(normalizedPath).length > 0;
		}

		return this.orig().exists(normalizedPath, sensitive);
	}

	// ------------------------------------------------------------------
	// stat
	// ------------------------------------------------------------------

	async stat(normalizedPath: string): Promise<{ type: 'file' | 'folder'; ctime: number; mtime: number; size: number } | null> {
		const mount = this.pathMapper.getMountForPath(normalizedPath);
		if (mount) {
			if (this.isPathIgnored(normalizedPath, mount)) return null;
			const webdav = this.getWebDAV(mount);
			if (webdav) {
				const stat = await webdav.stat(this.toServerPath(normalizedPath, mount));
				if (stat?.type === 'file' && !this.isVisibleMountFile(normalizedPath, mount)) return null;
				return stat;
			}
			const s3 = this.getS3(mount);
			if (s3) {
				const stat = await s3.stat(this.toServerPath(normalizedPath, mount));
				if (stat?.type === 'file' && !this.isVisibleMountFile(normalizedPath, mount)) return null;
				return stat;
			}
			const sftp = this.getSFTP(mount);
			if (sftp) {
				const stat = await sftp.stat(this.toServerPath(normalizedPath, mount));
				if (stat?.type === 'file' && !this.isVisibleMountFile(normalizedPath, mount)) return null;
				return stat;
			}
			const realPath = this.toReal(normalizedPath, mount);
			try {
				const s = await fs.promises.stat(realPath);
				if (s.isFile() && !this.isVisibleMountFile(normalizedPath, mount)) return null;
				return {
					type: s.isDirectory() ? 'folder' : 'file',
					ctime: s.ctimeMs,
					mtime: s.mtimeMs,
					size: s.size,
				};
			} catch (e) {
				// Obsidian expects null for missing files, not an error
				if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
					logger.debug(`[FolderBridge] stat failed for "${realPath}":`, e);
				}
				return null;
			}
		}

		// Virtual intermediate directory: a path that doesn't exist on disk but
		// is a parent of a mount (e.g. "Projects" when the mount is "Projects/Work").
		// Obsidian calls stat() on paths it knows exist (from exists()), so we must
		// return a synthetic folder stat rather than null.
		if (this.pathMapper.hasMountsUnder(normalizedPath)) {
			const real = await this.orig().stat(normalizedPath);
			if (real) return real;
			return { type: 'folder', ctime: 0, mtime: Date.now(), size: 0 };
		}

		return this.orig().stat(normalizedPath);
	}

	// ------------------------------------------------------------------
	// list
	// ------------------------------------------------------------------

	async list(normalizedPath: string): Promise<{ files: string[]; folders: string[] }> {
		const mount = this.pathMapper.getMountForPath(normalizedPath);
		if (mount) {
			logger.debug(`[FolderBridge] list: found mount for "${normalizedPath}"`);
			if (this.isPathIgnored(normalizedPath, mount)) {
				logger.debug(`[FolderBridge] list: path is ignored, returning empty`);
				return { files: [], folders: [] };
			}
			const webdav = this.getWebDAV(mount);
			if (webdav) {
				const sp = this.toServerPath(normalizedPath, mount);
				const result = await webdav.list(sp, normalizedPath, mount);
				return {
					folders: result.folders,
					files: result.files.filter(file => this.isVisibleMountFile(file, mount)),
				};
			}
			const s3 = this.getS3(mount);
			if (s3) {
				const sp = this.toServerPath(normalizedPath, mount);
				const result = await s3.list(sp, normalizedPath, mount);
				return {
					folders: result.folders,
					files: result.files.filter(file => this.isVisibleMountFile(file, mount)),
				};
			}
			const sftp = this.getSFTP(mount);
			if (sftp) {
				const sp = this.toServerPath(normalizedPath, mount);
				const result = await sftp.list(sp, normalizedPath, mount);
				return {
					folders: result.folders,
					files: result.files.filter(file => this.isVisibleMountFile(file, mount)),
				};
			}
			const realPath = this.toReal(normalizedPath, mount);
			logger.debug(`[FolderBridge] list: resolved to real path "${realPath}"`);
			try {
				return await this.listRealDirectory(realPath, normalizedPath, mount);
			} catch (e) {
				logger.error(`[FolderBridge] list failed for mount "${mount.virtualPath}":`, e);
				// Return empty instead of throwing to avoid breaking the UI
				return { files: [], folders: [] };
			}
		}

		// Merge real vault listing with injected virtual mount folders
		let result: { files: string[]; folders: string[] };
		try {
			result = await this.orig().list(normalizedPath);
		} catch {
			// Path may only exist as a virtual parent of a mount
			result = { files: [], folders: [] };
		}

		const virtualChildren = this.pathMapper.getVirtualMountsDirectChildren(normalizedPath);
		for (const child of virtualChildren) {
			if (!result.folders.includes(child)) {
				result.folders.push(child);
			}
		}

		return result;
	}

	private async listRealDirectory(
		realDirPath: string,
		virtualParentPath: string,
		mount: MountPoint,
	): Promise<{ files: string[]; folders: string[] }> {
		const files: string[] = [];
		const folders: string[] = [];
		const MAX_ENTRIES = 10000; // Safety limit to prevent UI freeze on huge directories

		// Pre-compute the mount-relative parent path for path-style ignore patterns
		const mountVirtual = normalizePath(mount.virtualPath);
		const mountRelativeParent: string | undefined = virtualParentPath.startsWith(mountVirtual + '/')
			? virtualParentPath.slice(mountVirtual.length + 1)
			: (virtualParentPath === mountVirtual ? '' : undefined);

		let entries: import('fs').Dirent[];
		try {
			entries = await fs.promises.readdir(realDirPath, { withFileTypes: true });
		} catch (e) {
			const msg = translateFsError(e as NodeJS.ErrnoException, 'list');
			logger.error(`[FolderBridge] Failed to list directory "${realDirPath}":`, msg);
			throw new Error(`Folder Bridge: Cannot list "${realDirPath}": ${msg}`);
		}

		logger.debug(`[FolderBridge] listRealDirectory: found ${entries.length} entries in "${realDirPath}"`);

		// Warn if directory is extremely large
		if (entries.length > MAX_ENTRIES) {
			logger.warn(`[FolderBridge] WARNING: Directory "${realDirPath}" contains ${entries.length} items. Plate Folder Bridge limits display to ${MAX_ENTRIES} items for performance.`);
		}

		for (let i = 0; i < entries.length && i < MAX_ENTRIES; i++) {
			const entry = entries[i];
			// Build the mount-relative path for this entry so path-style patterns work
			const entryMountRelativePath: string | undefined =
				mountRelativeParent !== undefined
					? (mountRelativeParent ? `${mountRelativeParent}/${entry.name}` : entry.name)
					: undefined;
			if (this.isIgnored(entry.name, mount, entryMountRelativePath)) continue;

			const virtualChild = virtualParentPath
				? normalizePath(virtualParentPath + '/' + entry.name)
				: entry.name;

			if (entry.isDirectory()) {
				folders.push(virtualChild);
			} else if (entry.isFile()) {
				if (this.isVisibleMountFile(virtualChild, mount)) files.push(virtualChild);
			} else if (entry.isSymbolicLink()) {
				// For very large directories, skip symlink resolution to avoid delay
				if (entries.length > 1000) {
					logger.debug(`[FolderBridge] Skipping symlink resolution in large directory (${entries.length} items)`);
					// Assume it's a file (safer default)
					if (this.isVisibleMountFile(virtualChild, mount)) files.push(virtualChild);
				} else {
					// Resolve symlinks to determine actual type
					try {
						const s = await fs.promises.stat(path.join(realDirPath, entry.name));
						if (s.isDirectory()) {
							folders.push(virtualChild);
						} else {
							if (this.isVisibleMountFile(virtualChild, mount)) files.push(virtualChild);
						}
					} catch {
						// Broken symlink or permission error – skip silently
					}
				}
			}
		}

		logger.debug(`[FolderBridge] listRealDirectory: returning ${folders.length} folders and ${files.length} files`);
		return { files, folders };
	}

	// ------------------------------------------------------------------
	// read / readBinary
	// ------------------------------------------------------------------

	async read(normalizedPath: string): Promise<string> {
		const mount = this.pathMapper.getMountForPath(normalizedPath);
		if (mount) {
			if (this.isPathIgnored(normalizedPath, mount)) throw new Error(`Folder Bridge: Cannot read ignored path "${normalizedPath}"`);
			this.assertVisibleMountFile(normalizedPath, mount);
			const webdav = this.getWebDAV(mount);
			if (webdav) return await webdav.readText(this.toServerPath(normalizedPath, mount));
			const s3 = this.getS3(mount);
			if (s3) return await s3.readText(this.toServerPath(normalizedPath, mount));
			const sftp = this.getSFTP(mount);
			if (sftp) return await sftp.readText(this.toServerPath(normalizedPath, mount));
			const realPath = this.toReal(normalizedPath, mount);
			this.assertAllowed(realPath);
			try {
				const key = normalizePath(normalizedPath);
				if (!this.getKnownMtime || !isMergeableText(key)) return await fs.promises.readFile(realPath, 'utf8');
				return await this.readAndRemember(key, realPath);
			} catch (e) {
				logger.error(`[FolderBridge] read failed for "${realPath}":`, e);
				if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
					// Check whether the file is an online-only cloud placeholder
					// (e.g. OneDrive Files On Demand) before surfacing a raw ENOENT.
					if (await isCloudPlaceholder(realPath)) {
						throw new Error(
							`Folder Bridge: "${path.basename(realPath)}" is a cloud-only placeholder ` +
							`(OneDrive / SharePoint Files On Demand) and cannot be read while offline. ` +
							`Right-click the file and choose "Always keep on this device" to make it available locally.`
						);
					}
					// Genuinely missing — preserve ENOENT so Obsidian handles it normally
					const err = new Error(`ENOENT: no such file or directory, open '${realPath}'`);
					(err as NodeJS.ErrnoException).code = 'ENOENT';
					throw err;
				}
				throw new Error(`Folder Bridge: ${translateFsError(e as NodeJS.ErrnoException, 'read')}`);
			}
		}
		return this.orig().read(normalizedPath);
	}

	async cachedRead(normalizedPath: string): Promise<string> {
		const mount = this.pathMapper.getMountForPath(normalizedPath);
		if (mount) {
			return this.read(normalizedPath);
		}
		const original = this.orig() as DataAdapter & { cachedRead?: (path: string) => Promise<string> };
		if (typeof original.cachedRead === 'function') {
			return original.cachedRead(normalizedPath);
		}
		return this.orig().read(normalizedPath);
	}

	async readBinary(normalizedPath: string): Promise<ArrayBuffer> {
		const mount = this.pathMapper.getMountForPath(normalizedPath);
		if (mount) {
			if (this.isPathIgnored(normalizedPath, mount)) throw new Error(`Folder Bridge: Cannot read ignored path "${normalizedPath}"`);
			this.assertVisibleMountFile(normalizedPath, mount);
			const webdav = this.getWebDAV(mount);
			if (webdav) return await webdav.readBinary(this.toServerPath(normalizedPath, mount));
			const s3 = this.getS3(mount);
			if (s3) return await s3.readBinary(this.toServerPath(normalizedPath, mount));
			const sftp = this.getSFTP(mount);
			if (sftp) return await sftp.readBinary(this.toServerPath(normalizedPath, mount));
			const realPath = this.toReal(normalizedPath, mount);
			this.assertAllowed(realPath);
			try {
				const buf = await fs.promises.readFile(realPath);
				// Return a proper ArrayBuffer (buf.buffer may be a shared Buffer pool slice)
				return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
			} catch (e) {
				if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
					if (await isCloudPlaceholder(realPath)) {
						throw new Error(
							`Folder Bridge: "${path.basename(realPath)}" is a cloud-only placeholder ` +
							`(OneDrive / SharePoint Files On Demand) and cannot be read while offline. ` +
							`Right-click the file and choose "Always keep on this device" to make it available locally.`
						);
					}
					const err = new Error(`ENOENT: no such file or directory, open '${realPath}'`);
					(err as NodeJS.ErrnoException).code = 'ENOENT';
					throw err;
				}
				throw new Error(`Folder Bridge: ${translateFsError(e as NodeJS.ErrnoException, 'readBinary')}`);
			}
		}
		return this.orig().readBinary(normalizedPath);
	}

	/**
	 * Read a text file on a local mount and remember the text as the base for
	 * a later merge, tagged with the modification time of the exact version
	 * read (the time is taken before and after the read on the open file; if
	 * the file changed in between, nothing is remembered).
	 */
	private async readAndRemember(key: string, realPath: string): Promise<string> {
		const handle = await fs.promises.open(realPath, 'r');
		try {
			const before = await handle.stat();
			const text = await handle.readFile('utf8');
			const after = await handle.stat();
			if (before.mtimeMs === after.mtimeMs && before.size === after.size) this.recentTexts.set(key, text, Math.round(after.mtimeMs));
			else this.recentTexts.delete(key);
			return text;
		} finally {
			await handle.close().catch(() => { });
		}
	}

	// ------------------------------------------------------------------
	// Changed on the drive since Obsidian last saw it (local mounts)
	// ------------------------------------------------------------------

	/**
	 * Before a save over a file Obsidian knows: has someone else changed it on
	 * the drive since Obsidian last saw it (a colleague's save that the
	 * watcher hasn't reported yet, or a share that never reports changes)?
	 * Depending on the conflict setting:
	 * - overwrite: save anyway (last save wins).
	 * - copy: keep their version as a copy in the vault's .trash folder, then
	 *   save. If the copy can't be made, the save is refused.
	 * - merge (text files only): combine both sets of changes against the
	 *   last text Obsidian read or wrote. When that isn't possible (no base,
	 *   both changed the same lines, not UTF-8, binary file), as copy.
	 * `mine` is the text being saved, or null for a binary write. Returns the
	 * text to write instead (a merge) or null to write the original data, and
	 * a message to show once the save succeeded.
	 */
	private async resolveChangedOnDisk(key: string, realPath: string, mine: string | null): Promise<{ merged: string | null; notice: string | null }> {
		const unchanged = { merged: null, notice: null };
		if (this.processing.has(key)) return unchanged;
		const mode = this.getConflictMode?.() ?? 'overwrite';
		if (mode === 'overwrite') return unchanged;
		const known = this.getKnownMtime?.(key);
		if (known === undefined) return unchanged; // no vault lookup, or a new file
		let disk: import('fs').Stats;
		try {
			disk = await fs.promises.stat(realPath);
		} catch {
			return unchanged; // missing or unreadable: the write itself reports real problems
		}
		if (!disk.isFile()) return unchanged;
		const diskMtime = Math.round(disk.mtimeMs);
		if (diskMtime === Math.round(known)) return unchanged;
		const own = this.ownWrites.get(key);
		if (own && own.mtime === diskMtime && own.size === disk.size) return unchanged; // our own previous save

		const name = path.basename(realPath);
		let mergeFailed = false;
		if (mine !== null) {
			const onDisk = await fs.promises.readFile(realPath).catch(() => null);
			const theirs = onDisk ? decodeUtf8(onDisk) : null;
			const recent = this.recentTexts.get(key);
			// The base must be the version Obsidian edited, not a later read of theirs.
			const base = recent && (recent.mtime === Math.round(known) || recent.mtime === own?.mtime) ? recent.text : undefined;
			if (theirs !== null) {
				if (theirs === mine || theirs === base) return unchanged; // same text, only the time changed
				if (mode === 'merge' && base !== undefined && isMergeableText(key)) {
					const result = mergeText(base, mine, theirs);
					if (result.clean && result.merged === mine) return unchanged; // they made the same changes
					if (result.clean) {
						return {
							merged: result.merged,
							notice: `Folder Bridge: "${name}" was changed on the drive while you edited it. Both sets of changes were merged.`,
						};
					}
				}
			}
			mergeFailed = mode === 'merge' && isMergeableText(key);
		}
		const copyName = await this.keepTheirVersion(realPath);
		const why = mergeFailed ? ' and the changes could not be merged automatically' : '';
		return {
			merged: null,
			notice: `Folder Bridge: "${name}" was changed on the drive by someone else after Obsidian loaded it${why}. ` +
				`Their version was kept as "${copyName}" in the vault's .trash/${CONFLICT_COPIES_FOLDER} folder, then yours was saved.`,
		};
	}

	/**
	 * Copy the file on the drive (someone else's version) into
	 * <vault>/.trash/folderbridge-conflicts before a save replaces it.
	 * Returns the copy's name. Throws (and so refuses the save) when no copy
	 * could be made: their version must not be lost.
	 */
	private async keepTheirVersion(realPath: string): Promise<string> {
		const name = path.basename(realPath);
		const refuse = (reason: string) => new Error(
			`Folder Bridge: "${name}" was changed on the drive by someone else after Obsidian loaded it, and their version ` +
			`could not be kept as a copy (${reason}). Your changes were not saved, so their version is untouched. ` +
			`Copy your text somewhere safe, then reopen the note.`
		);
		const basePath = (this.orig() as DataAdapter & { getBasePath?(): string }).getBasePath?.();
		if (!basePath) throw refuse('the vault folder could not be found');
		const dir = path.join(basePath, '.trash', CONFLICT_COPIES_FOLDER);
		const ext = path.extname(name);
		const stem = path.basename(name, ext);
		const when = fileStamp();
		try {
			await fs.promises.mkdir(dir, { recursive: true });
			for (let n = 1; ; n++) {
				const copyName = `${stem} (changed by someone else ${when}${n > 1 ? ` ${n}` : ''})${ext}`;
				try {
					await fs.promises.copyFile(realPath, path.join(dir, copyName), fs.constants.COPYFILE_EXCL);
					return copyName;
				} catch (e) {
					if ((e as NodeJS.ErrnoException).code !== 'EEXIST' || n >= 50) throw e;
				}
			}
		} catch (e) {
			logger.error(`[FolderBridge] could not keep a copy of "${realPath}" before saving:`, e);
			throw refuse(translateFsError(e as NodeJS.ErrnoException, 'copy').replace(/\.$/, ''));
		}
	}

	/** After a successful local write: remember what we wrote (see ownWrites, recentTexts). */
	private async rememberOwnWrite(key: string, realPath: string, text: string | null): Promise<void> {
		if (!this.getKnownMtime) return;
		try {
			const s = await fs.promises.stat(realPath);
			const mtime = Math.round(s.mtimeMs);
			this.ownWrites.set(key, { mtime, size: s.size });
			if (text !== null && isMergeableText(key)) this.recentTexts.set(key, text, mtime);
			else this.recentTexts.delete(key);
		} catch {
			this.ownWrites.delete(key);
			this.recentTexts.delete(key);
		}
	}

	// ------------------------------------------------------------------
	// write / writeBinary / append / process
	// ------------------------------------------------------------------

	/**
	 * Write a file on a local mount. A file Obsidian doesn't know yet is
	 * created with the "wx" flag, so vault.create() can never replace a file
	 * someone else put on the drive (a colleague's note with the same name, or
	 * one the watcher hasn't reported yet). That case throws an EEXIST error.
	 */
	private async writeLocalFile(normalizedPath: string, realPath: string, content: string | Buffer, op: string): Promise<void> {
		const isCreate = this.getKnownMtime !== undefined && this.getKnownMtime(normalizePath(normalizedPath)) === undefined;
		await fs.promises.mkdir(path.dirname(realPath), { recursive: true });
		try {
			const encoding = typeof content === 'string' ? 'utf8' : undefined;
			if (isCreate) await fs.promises.writeFile(realPath, content, { flag: 'wx', encoding });
			else if (encoding) await fs.promises.writeFile(realPath, content, encoding);
			else await fs.promises.writeFile(realPath, content);
		} catch (e) {
			if (isCreate && (e as NodeJS.ErrnoException).code === 'EEXIST') {
				const err = new Error(
					`Folder Bridge: "${path.basename(realPath)}" already exists on the drive, so it was not replaced. ` +
					`It may have just been created by someone else; it will appear in the vault shortly. Choose another name.`
				) as NodeJS.ErrnoException;
				err.code = 'EEXIST';
				throw err;
			}
			throw new Error(`Folder Bridge: ${translateFsError(e as NodeJS.ErrnoException, op)}`);
		}
	}

	async write(normalizedPath: string, data: string, options?: unknown): Promise<void> {
		const mount = this.pathMapper.getMountForPath(normalizedPath);
		if (mount) {
			if (mount.readOnly) { this.warnReadOnly(mount); return; }
			if (this.isPathIgnored(normalizedPath, mount)) throw new Error(`Folder Bridge: Cannot write to ignored path "${normalizedPath}"`);
			this.assertVisibleMountFile(normalizedPath, mount);
			const webdav = this.getWebDAV(mount);
			if (webdav) {
				if (this.dryRun) { logger.debug(`[Folder Bridge DryRun] webdav write → ${this.toServerPath(normalizedPath, mount)}`); return; }
				await webdav.writeText(this.toServerPath(normalizedPath, mount), data);
				void this.onModify?.(normalizedPath).catch(() => { });
				return;
			}
			const s3 = this.getS3(mount);
			if (s3) {
				if (this.dryRun) { logger.debug(`[Folder Bridge DryRun] s3 write → ${this.toServerPath(normalizedPath, mount)}`); return; }
				await s3.writeText(this.toServerPath(normalizedPath, mount), data);
				void this.onModify?.(normalizedPath).catch(() => { });
				return;
			}
			const sftp = this.getSFTP(mount);
			if (sftp) {
				if (this.dryRun) { logger.debug(`[Folder Bridge DryRun] sftp write → ${this.toServerPath(normalizedPath, mount)}`); return; }
				await sftp.writeText(this.toServerPath(normalizedPath, mount), data);
				void this.onModify?.(normalizedPath).catch(() => { });
				return;
			}
			const realPath = this.toReal(normalizedPath, mount);

			this.assertAllowed(realPath);
			this.assertNotReserved(realPath);
			if (this.dryRun) { logger.debug(`[FolderBridge DryRun] write → ${realPath}`); return; }
			try {
				const key = normalizePath(normalizedPath);
				const { merged, notice } = await this.resolveChangedOnDisk(key, realPath, data);
				const text = merged ?? data;
				await this.writeLocalFile(normalizedPath, realPath, text, 'write');
				await this.rememberOwnWrite(key, realPath, text);
				void this.onModify?.(normalizedPath).catch(() => { });
				if (notice) new Notice(notice, merged !== null ? 8000 : 15000);
				if (merged !== null) this.onMergedSave?.(normalizedPath);
				return;
			} catch (e) {
				logger.error(`[FolderBridge] write failed for "${realPath}":`, e);
				if ((e as Error).message?.startsWith('Folder Bridge:')) throw e;
				throw new Error(`Folder Bridge: ${translateFsError(e as NodeJS.ErrnoException, 'write')}`);
			}
		}
		return this.orig().write(normalizedPath, data, options as DataWriteOptions | undefined);
	}

	async writeBinary(normalizedPath: string, data: ArrayBuffer, options?: unknown): Promise<void> {
		const mount = this.pathMapper.getMountForPath(normalizedPath);
		if (mount) {
			if (mount.readOnly) { this.warnReadOnly(mount); return; }
			if (this.isPathIgnored(normalizedPath, mount)) throw new Error(`Folder Bridge: Cannot write to ignored path "${normalizedPath}"`);
			this.assertVisibleMountFile(normalizedPath, mount);
			const webdav = this.getWebDAV(mount);
			if (webdav) {
				if (this.dryRun) { logger.debug(`[Folder Bridge DryRun] webdav writeBinary → ${this.toServerPath(normalizedPath, mount)}`); return; }
				await webdav.writeBinary(this.toServerPath(normalizedPath, mount), data);
				void this.onModify?.(normalizedPath).catch(() => { });
				return;
			}
			const s3 = this.getS3(mount);
			if (s3) {
				if (this.dryRun) { logger.debug(`[Folder Bridge DryRun] s3 writeBinary → ${this.toServerPath(normalizedPath, mount)}`); return; }
				await s3.writeBinary(this.toServerPath(normalizedPath, mount), data);
				void this.onModify?.(normalizedPath).catch(() => { });
				return;
			}
			const sftp = this.getSFTP(mount);
			if (sftp) {
				if (this.dryRun) { logger.debug(`[Folder Bridge DryRun] sftp writeBinary → ${this.toServerPath(normalizedPath, mount)}`); return; }
				await sftp.writeBinary(this.toServerPath(normalizedPath, mount), data);
				void this.onModify?.(normalizedPath).catch(() => { });
				return;
			}
			const realPath = this.toReal(normalizedPath, mount);
			this.assertAllowed(realPath);
			this.assertNotReserved(realPath);
			if (this.dryRun) { logger.debug(`[FolderBridge DryRun] writeBinary → ${realPath}`); return; }
			try {
				const key = normalizePath(normalizedPath);
				// Binary: keep a copy of their version or overwrite, never merge.
				const { notice } = await this.resolveChangedOnDisk(key, realPath, null);
				await this.writeLocalFile(normalizedPath, realPath, Buffer.from(data), 'writeBinary');
				await this.rememberOwnWrite(key, realPath, null);
				void this.onModify?.(normalizedPath).catch(() => { });
				if (notice) new Notice(notice, 15000);
				return;
			} catch (e) {
				if ((e as Error).message?.startsWith('Folder Bridge:')) throw e;
				throw new Error(`Folder Bridge: ${translateFsError(e as NodeJS.ErrnoException, 'writeBinary')}`);
			}
		}
		return this.orig().writeBinary(normalizedPath, data, options as DataWriteOptions | undefined);
	}

	async append(normalizedPath: string, data: string, options?: unknown): Promise<void> {
		const mount = this.pathMapper.getMountForPath(normalizedPath);
		if (mount) {
			if (mount.readOnly) { this.warnReadOnly(mount); return; }
			if (this.isPathIgnored(normalizedPath, mount)) throw new Error(`Folder Bridge: Cannot append to ignored path "${normalizedPath}"`);
			this.assertVisibleMountFile(normalizedPath, mount);
			const webdav = this.getWebDAV(mount);
			if (webdav) {
				if (this.dryRun) { logger.debug(`[Folder Bridge DryRun] webdav append → ${this.toServerPath(normalizedPath, mount)}`); return; }
				await webdav.append(this.toServerPath(normalizedPath, mount), data);
				void this.onModify?.(normalizedPath).catch(() => { });
				return;
			}
			const s3 = this.getS3(mount);
			if (s3) {
				if (this.dryRun) { logger.debug(`[Folder Bridge DryRun] s3 append → ${this.toServerPath(normalizedPath, mount)}`); return; }
				await s3.append(this.toServerPath(normalizedPath, mount), data);
				void this.onModify?.(normalizedPath).catch(() => { });
				return;
			}
			const sftp = this.getSFTP(mount);
			if (sftp) {
				if (this.dryRun) { logger.debug(`[Folder Bridge DryRun] sftp append → ${this.toServerPath(normalizedPath, mount)}`); return; }
				await sftp.append(this.toServerPath(normalizedPath, mount), data);
				void this.onModify?.(normalizedPath).catch(() => { });
				return;
			}
			const realPath = this.toReal(normalizedPath, mount);
			this.assertAllowed(realPath);
			if (this.dryRun) { logger.debug(`[FolderBridge DryRun] append → ${realPath}`); return; }
			try {
				await fs.promises.appendFile(realPath, data, 'utf8');
				await this.rememberOwnWrite(normalizePath(normalizedPath), realPath, null);
				void this.onModify?.(normalizedPath).catch(() => { });
				return;
			} catch (e) {
				throw new Error(`Folder Bridge: ${translateFsError(e as NodeJS.ErrnoException, 'append')}`);
			}
		}
		return this.orig().append(normalizedPath, data, options as DataWriteOptions | undefined);
	}

	async appendBinary(normalizedPath: string, data: ArrayBuffer, options?: DataWriteOptions): Promise<void> {
		const mount = this.pathMapper.getMountForPath(normalizedPath);
		if (!mount) return this.orig().appendBinary(normalizedPath, data, options);
		if (mount.readOnly) { this.warnReadOnly(mount); return; }
		if (this.isPathIgnored(normalizedPath, mount)) throw new Error(`Folder Bridge: Cannot append to ignored path "${normalizedPath}"`);
		this.assertVisibleMountFile(normalizedPath, mount);
		if (mount.mountType === 'webdav' || mount.mountType === 's3' || mount.mountType === 'sftp') {
			throw new Error(`Folder Bridge: Binary append is not supported for ${mount.mountType} mounts.`);
		}
		const realPath = this.toReal(normalizedPath, mount);
		this.assertAllowed(realPath);
		this.assertNotReserved(realPath);
		if (this.dryRun) { logger.debug(`[FolderBridge DryRun] appendBinary: ${realPath}`); return; }
		try {
			await fs.promises.appendFile(realPath, Buffer.from(data));
			await this.rememberOwnWrite(normalizePath(normalizedPath), realPath, null);
			void this.onModify?.(normalizedPath).catch(() => { });
		} catch (error) {
			throw new Error(`Folder Bridge: ${translateFsError(error as NodeJS.ErrnoException, 'appendBinary')}`);
		}
	}

	async process(
		normalizedPath: string,
		fn: (data: string) => string,
		options?: unknown,
	): Promise<string> {
		const mount = this.pathMapper.getMountForPath(normalizedPath);
		if (mount) {
			if (this.isPathIgnored(normalizedPath, mount)) throw new Error(`Folder Bridge: Cannot process ignored path "${normalizedPath}"`);
			this.assertVisibleMountFile(normalizedPath, mount);
			const content = await this.read(normalizedPath);
			const updated = fn(content);
			// The text was derived from what is on the drive right now: saving it
			// can't lose anyone's change, so skip the changed-on-disk check.
			const key = normalizePath(normalizedPath);
			this.processing.add(key);
			try {
				await this.write(normalizedPath, updated, options);
			} finally {
				this.processing.delete(key);
			}
			return updated;
		}
		return this.orig().process(normalizedPath, fn, options as DataWriteOptions | undefined);
	}

	// ------------------------------------------------------------------
	// getResourcePath
	// ------------------------------------------------------------------

	getResourcePath(normalizedPath: string): string {
		const mount = this.pathMapper.getMountForPath(normalizedPath);
		if (mount) {
			// NOTE: Vault.getResourcePath(TFile) is patched separately in main.ts because
			// Obsidian's renderer calls the vault-level method directly, not this adapter method.
			// Modern Obsidian (app://<vaultId>/) only serves vault-relative paths, so
			// external mounts must be served as data: URIs instead.
			// The size cap is configurable via plugin settings (maxDataUriMB).
			const realPath = this.pathMapper.toRealPath(normalizedPath, mount);
			return this.resolveResourceUrl(realPath);
		}
		return this.orig().getResourcePath(normalizedPath);
	}

	/**
	 * Select the best URL strategy for a real file path:
	 *
	 *   1. Streaming types (video / audio, any size)
	 *        → localhost FileServer  (only option with range-request support)
	 *        → app://local/ if FileServer is not running (mobile / startup race)
	 *
	 *   2. Embeddable types (images, PDF)
	 *      a. File ≤ maxDataUriMB → data: URI  (fast, no extra latency, always works)
	 *      b. File > maxDataUriMB → FileServer  (avoids broken app://local/ in modern Obsidian)
	 *      c. FileServer also not running → app://local/  (last-resort legacy fallback)
	 *
	 *   3. Unknown / non-media extension → app://local/
	 */
	resolveResourceUrl(realPath: string): string {
		if (!path) return realPathToResourceUrl(realPath); // mobile — no ext parsing

		const ext = path.extname(realPath).toLowerCase();

		// ── 1. Streaming types (video / audio) ──────────────────────────────────
		if (ext in STREAMING_MIME) {
			if (this.fileServer?.isRunning) return this.fileServer.getFileUrl(realPath);
			// FileServer not yet started (or mobile): fall back to app://local/
			// Note: seeking/scrubbing won't work without range support but at least
			// short clips may play through.
			return realPathToResourceUrl(realPath);
		}

		// ── 2. Embeddable types (images, PDF) ──────────────────────────────
		if (ext in EMBEDDABLE_MIME) {
			// Try data: URI first — cheapest path for reasonably sized files.
			const dataUri = tryReadAsDataUri(realPath, this.maxDataUriBytes);
			if (dataUri) return dataUri;
			// File exceeded the data-URI cap.  Route through FileServer so the
			// image/PDF loads properly instead of getting ERR_FILE_NOT_FOUND.
			if (this.fileServer?.isRunning) return this.fileServer.getFileUrl(realPath);
			// Last resort: app://local/ (may fail in modern Obsidian builds).
			return realPathToResourceUrl(realPath);
		}

		// ── 3. Non-media / unknown extension ────────────────────────────────
		return realPathToResourceUrl(realPath);
	}

	// ------------------------------------------------------------------
	// mkdir
	// ------------------------------------------------------------------

	async mkdir(normalizedPath: string): Promise<void> {
		const mount = this.pathMapper.getMountForPath(normalizedPath);
		if (mount) {
			if (mount.readOnly) { this.warnReadOnly(mount); return; }
			if (this.isPathIgnored(normalizedPath, mount)) throw new Error(`Folder Bridge: Cannot create ignored path "${normalizedPath}"`);

			const realPath = this.toReal(normalizedPath, mount);

			const webdav = this.getWebDAV(mount);
			if (webdav) {
				if (this.dryRun) { logger.debug(`[FolderBridge DryRun] mkdir (webdav) → ${this.toServerPath(normalizedPath, mount)}`); return; }
				await webdav.mkdir(this.toServerPath(normalizedPath, mount));
				return;
			}
			const s3mkdir = this.getS3(mount);
			if (s3mkdir) {
				if (this.dryRun) { logger.debug(`[FolderBridge DryRun] mkdir (s3) → ${this.toServerPath(normalizedPath, mount)}`); return; }
				await s3mkdir.mkdir(this.toServerPath(normalizedPath, mount));
				return;
			}
			const sftpMkdir = this.getSFTP(mount);
			if (sftpMkdir) {
				if (this.dryRun) { logger.debug(`[FolderBridge DryRun] mkdir (sftp) → ${this.toServerPath(normalizedPath, mount)}`); return; }
				await sftpMkdir.mkdir(this.toServerPath(normalizedPath, mount));
				return;
			}

			this.assertAllowed(realPath);
			this.assertNotReserved(realPath);

			if (this.dryRun) {
				logger.debug(`[FolderBridge DryRun] mkdir → ${realPath}`);
				return;
			}

			try {
				await fs.promises.mkdir(realPath, { recursive: true });
			} catch (e) {
				const errorMsg = `Folder Bridge: ${translateFsError(e as NodeJS.ErrnoException, 'mkdir')}`;
				logger.error(`[FolderBridge] mkdir failed for "${realPath}":`, e, errorMsg);
				throw new Error(errorMsg);
			}
			return;
		}

		return this.orig().mkdir(normalizedPath);
	}

	// ------------------------------------------------------------------
	// trash / remove
	// ------------------------------------------------------------------

	/**
	 * Mount roots whose real deletion the user already confirmed in
	 * trashSystem().  When the system trash then fails and Obsidian falls
	 * back to trashLocal(), the confirmation is consumed instead of asking
	 * the same question a second time.  Entries expire quickly so a stale
	 * confirmation can never silently authorise a later, unrelated delete.
	 */
	private confirmedRootDeletions: Map<string, number> = new Map();
	private static readonly ROOT_DELETION_CONFIRM_TTL_MS = 5000;

	private rootDeletionConfirmationKey(mount: MountPoint): string {
		return JSON.stringify([mount.id, this.pathMapper.getEffectiveRealPath(mount)]);
	}

	private consumeRootDeletionConfirmation(mount: MountPoint): boolean {
		const key = this.rootDeletionConfirmationKey(mount);
		const confirmedAt = this.confirmedRootDeletions.get(key);
		this.confirmedRootDeletions.delete(key);
		return confirmedAt !== undefined &&
			Date.now() - confirmedAt <= VirtualAdapter.ROOT_DELETION_CONFIRM_TTL_MS;
	}

	private async handleRootMountDeletion(rootMount: MountPoint, trash = false): Promise<boolean> {
		const action = await this.onMountRootDelete(rootMount, trash);
		if (action === 'cancel') {
			throw new Error(`Folder Bridge: Deletion cancelled.`);
		}
		if (action === 'unmount') {
			// The callback handles the unmounting. We just return true to stop the real deletion.
			return true;
		}
		// action === 'delete'
		return false; // Proceed with real deletion
	}

	private assertRecoverableTrash(mount: MountPoint): void {
		if (mount.mountType === 'webdav' || mount.mountType === 's3' || mount.mountType === 'sftp') {
			throw new Error(`Folder Bridge: Recoverable trash is unavailable for ${mount.mountType} mounts. The item was not deleted. Use an explicit permanent-delete action only if you intend to delete it permanently.`);
		}
	}

	async trashSystem(normalizedPath: string): Promise<boolean> {
		const rootMount = this.pathMapper.getMountByVirtualPath(normalizedPath);
		if (rootMount) {
			this.confirmedRootDeletions.delete(this.rootDeletionConfirmationKey(rootMount));
			const handled = await this.handleRootMountDeletion(rootMount, true);
			if (handled) return true;
		}

		const mount = this.pathMapper.getMountForPath(normalizedPath);
		if (mount) {
			if (mount.readOnly) { this.warnReadOnly(mount); return true; }
			if (this.isPathIgnored(normalizedPath, mount)) throw new Error(`Folder Bridge: Cannot trash ignored path "${normalizedPath}"`);
			this.assertRecoverableTrash(mount);
			const realPath = this.toReal(normalizedPath, mount);
			this.assertAllowed(realPath);
			if (this.dryRun) { logger.debug(`[FolderBridge DryRun] trashSystem → ${realPath}`); return true; }
			// Never fall back to a permanent delete here.  Per the DataAdapter
			// contract, returning false tells Obsidian the system trash is
			// unavailable (network volume, no trash support, no Electron shell)
			// and it then calls trashLocal(), which keeps the data recoverable.
			const electron = loadOptionalNodeModule<{ shell?: { trashItem(p: string): Promise<void> } }>('electron');
			const shell = electron?.shell;
			if (!shell?.trashItem) {
				logger.warn('[FolderBridge] System trash is unavailable; use the vault trash fallback.');
				if (rootMount) this.confirmedRootDeletions.set(this.rootDeletionConfirmationKey(rootMount), Date.now());
				return false;
			}
			try {
				await shell.trashItem(realPath);
			} catch (e) {
				logger.warn(`[FolderBridge] System trash unavailable for "${realPath}"; falling back to the vault .trash folder.`, e);
				if (rootMount) this.confirmedRootDeletions.set(this.rootDeletionConfirmationKey(rootMount), Date.now());
				return false;
			}
			await this.notifyDelete(normalizedPath);
			return true;
		}
		return this.orig().trashSystem(normalizedPath);
	}

	private async moveToVaultTrash(realPath: string): Promise<void> {
		const basePath = (this.orig() as DataAdapter & { getBasePath?(): string }).getBasePath?.();
		if (!basePath) {
			throw new Error('Folder Bridge: cannot locate the vault .trash folder, so the item was not deleted.');
		}
		const basename = path.basename(realPath);
		if (!basename) {
			throw new Error('Folder Bridge: A filesystem root cannot be moved to the vault trash.');
		}
		const trashDir = path.join(basePath, '.trash');
		await fs.promises.mkdir(trashDir, { recursive: true });
		const [source, trash] = await Promise.all([
			fs.promises.realpath(realPath),
			fs.promises.realpath(trashDir),
		]);
		const relativeTrash = path.relative(source, trash);
		if (!relativeTrash || (!path.isAbsolute(relativeTrash) && relativeTrash !== '..' && !relativeTrash.startsWith(`..${path.sep}`))) {
			throw new Error('Folder Bridge: The vault trash is inside the item being deleted. The item was not deleted.');
		}

		// Reserve a private directory atomically; concurrent deletions never share a destination.
		const recoveryDir = await fs.promises.mkdtemp(path.join(trashDir, 'folderbridge-'));
		const destination = path.join(recoveryDir, basename);
		try {
			try {
				await fs.promises.rename(realPath, destination);
			} catch (e) {
				const err = e as NodeJS.ErrnoException;
				if (err.code !== 'EXDEV') throw e;
				await fs.promises.cp(realPath, destination, {
					recursive: true, errorOnExist: true, force: false,
					mode: fs.constants.COPYFILE_EXCL, preserveTimestamps: true, verbatimSymlinks: true,
				});
				await fs.promises.rm(realPath, { recursive: true });
			}
		} catch (e) {
			const err = e as NodeJS.ErrnoException;
			logger.error(`[FolderBridge] Trash failed; recovery data, if created, is at "${destination}".`, e);
			throw new Error(`Folder Bridge: ${translateFsError(err, 'trash')} Recovery data, if created, is at "${destination}".`);
		}
	}

	async trashLocal(normalizedPath: string, system?: boolean): Promise<void> {
		const rootMount = this.pathMapper.getMountByVirtualPath(normalizedPath);
		if (rootMount && !this.consumeRootDeletionConfirmation(rootMount)) {
			const handled = await this.handleRootMountDeletion(rootMount, true);
			if (handled) return;
		}

		const mount = this.pathMapper.getMountForPath(normalizedPath);
		if (mount) {
			if (mount.readOnly) { this.warnReadOnly(mount); return; }
			if (this.isPathIgnored(normalizedPath, mount)) throw new Error(`Folder Bridge: Cannot trash ignored path "${normalizedPath}"`);
			this.assertRecoverableTrash(mount);
			const realPath = this.toReal(normalizedPath, mount);
			this.assertAllowed(realPath);
			if (this.dryRun) { logger.debug(`[FolderBridge DryRun] trashLocal → ${realPath}`); return; }
			await this.moveToVaultTrash(realPath);
			await this.notifyDelete(normalizedPath);
			return;
		}
		return (this.orig().trashLocal as (path: string, system?: boolean) => Promise<void>)(normalizedPath, system);
	}

	async rmdir(normalizedPath: string, recursive: boolean): Promise<void> {
		const rootMount = this.pathMapper.getMountByVirtualPath(normalizedPath);
		if (rootMount) {
			const handled = await this.handleRootMountDeletion(rootMount);
			if (handled) return;
		}

		const mount = this.pathMapper.getMountForPath(normalizedPath);
		if (mount) {
			if (mount.readOnly) { this.warnReadOnly(mount); return; }
			if (this.isPathIgnored(normalizedPath, mount)) throw new Error(`Folder Bridge: Cannot remove ignored path "${normalizedPath}"`);
			const realPath = this.toReal(normalizedPath, mount);
			const webdavRD = this.getWebDAV(mount);
			if (webdavRD) {
				if (this.dryRun) { logger.debug(`[FolderBridge DryRun] rmdir (webdav) → ${this.toServerPath(normalizedPath, mount)}`); return; }
				await webdavRD.remove(this.toServerPath(normalizedPath, mount));
				await this.notifyDelete(normalizedPath);
				return;
			}
			const s3RD = this.getS3(mount);
			if (s3RD) {
				if (this.dryRun) { logger.debug(`[FolderBridge DryRun] rmdir (s3) → ${this.toServerPath(normalizedPath, mount)}`); return; }
				await s3RD.removePrefix(this.toServerPath(normalizedPath, mount));
				await this.notifyDelete(normalizedPath);
				return;
			}
			const sftpRD = this.getSFTP(mount);
			if (sftpRD) {
				if (this.dryRun) { logger.debug(`[FolderBridge DryRun] rmdir (sftp) → ${this.toServerPath(normalizedPath, mount)}`); return; }
				await sftpRD.remove(this.toServerPath(normalizedPath, mount));
				await this.notifyDelete(normalizedPath);
				return;
			}
			this.assertAllowed(realPath);
			if (this.dryRun) { logger.debug(`[FolderBridge DryRun] rmdir → ${realPath}`); return; }
			await fs.promises.rm(realPath, { recursive: true, force: true });
			await this.notifyDelete(normalizedPath);
			return;
		}
		if (typeof this.orig().rmdir === 'function') {
			return this.orig().rmdir(normalizedPath, recursive);
		}
	}

	async remove(normalizedPath: string): Promise<void> {
		const rootMount = this.pathMapper.getMountByVirtualPath(normalizedPath);
		if (rootMount) {
			const handled = await this.handleRootMountDeletion(rootMount);
			if (handled) return;
		}

		const mount = this.pathMapper.getMountForPath(normalizedPath);
		if (mount) {
			if (mount.readOnly) { this.warnReadOnly(mount); return; }
			if (this.isPathIgnored(normalizedPath, mount)) throw new Error(`Folder Bridge: Cannot remove ignored path "${normalizedPath}"`);
			const realPath = this.toReal(normalizedPath, mount);
			const webdavRM = this.getWebDAV(mount);
			if (webdavRM) {
				if (this.dryRun) { logger.debug(`[FolderBridge DryRun] remove (webdav) → ${this.toServerPath(normalizedPath, mount)}`); return; }
				await webdavRM.remove(this.toServerPath(normalizedPath, mount));
				await this.notifyDelete(normalizedPath);
				return;
			}
			const s3RM = this.getS3(mount);
			if (s3RM) {
				if (this.dryRun) { logger.debug(`[FolderBridge DryRun] remove (s3) → ${this.toServerPath(normalizedPath, mount)}`); return; }
				await s3RM.remove(this.toServerPath(normalizedPath, mount));
				await this.notifyDelete(normalizedPath);
				return;
			}
			const sftpRM = this.getSFTP(mount);
			if (sftpRM) {
				if (this.dryRun) { logger.debug(`[FolderBridge DryRun] remove (sftp) → ${this.toServerPath(normalizedPath, mount)}`); return; }
				await sftpRM.remove(this.toServerPath(normalizedPath, mount));
				await this.notifyDelete(normalizedPath);
				return;
			}
			this.assertAllowed(realPath);
			if (this.dryRun) { logger.debug(`[FolderBridge DryRun] remove → ${realPath}`); return; }
			await fs.promises.rm(realPath, { recursive: true, force: true });
			await this.notifyDelete(normalizedPath);
			return;
		}
		if (typeof this.orig().remove === 'function') {
			return this.orig().remove(normalizedPath);
		}
	}

	// ------------------------------------------------------------------
	// rename / copy
	// ------------------------------------------------------------------

	async rename(normalizedPath: string, newNormalizedPath: string): Promise<void> {
		const rootMount = this.pathMapper.getMountByVirtualPath(normalizedPath);
		if (rootMount) {
			// The user dragged or moved the mount root folder in the file explorer.
			// Delegate to the plugin's updateMount() via the onMountRootMove callback
			// so the virtual path is updated live without touching the real disk folder.
			await this.onMountRootMove(rootMount, newNormalizedPath);
			return;
		}

		const srcMount = this.pathMapper.getMountForPath(normalizedPath);
		const dstMount = this.pathMapper.getMountForPath(newNormalizedPath);

		if (!srcMount && !dstMount) {
			return this.orig().rename(normalizedPath, newNormalizedPath);
		}

		if (srcMount && dstMount && srcMount.id === dstMount.id) {
			// Rename within the same mount
			if (srcMount.readOnly) { this.warnReadOnly(srcMount); return; }
			if (this.isPathIgnored(normalizedPath, srcMount) || this.isPathIgnored(newNormalizedPath, dstMount)) {
				throw new Error(`Folder Bridge: Cannot rename ignored paths`);
			}
			const srcReal = this.toReal(normalizedPath, srcMount);
			const dstReal = this.toReal(newNormalizedPath, dstMount);
			const webdavRN = this.getWebDAV(srcMount);
			if (webdavRN) {
				if (this.dryRun) { logger.debug(`[FolderBridge DryRun] rename (webdav) ${this.toServerPath(normalizedPath, srcMount)} → ${this.toServerPath(newNormalizedPath, dstMount)}`); return; }
				await webdavRN.rename(this.toServerPath(normalizedPath, srcMount), this.toServerPath(newNormalizedPath, dstMount));
				return;
			}
			const s3RN = this.getS3(srcMount);
			if (s3RN) {
				if (this.dryRun) { logger.debug(`[FolderBridge DryRun] rename (s3) ${this.toServerPath(normalizedPath, srcMount)} → ${this.toServerPath(newNormalizedPath, dstMount)}`); return; }
				await s3RN.rename(this.toServerPath(normalizedPath, srcMount), this.toServerPath(newNormalizedPath, dstMount));
				return;
			}
			const sftpRN = this.getSFTP(srcMount);
			if (sftpRN) {
				if (this.dryRun) { logger.debug(`[FolderBridge DryRun] rename (sftp) ${this.toServerPath(normalizedPath, srcMount)} → ${this.toServerPath(newNormalizedPath, dstMount)}`); return; }
				await sftpRN.rename(this.toServerPath(normalizedPath, srcMount), this.toServerPath(newNormalizedPath, dstMount));
				return;
			}
			this.assertAllowed(srcReal);
			this.assertAllowed(dstReal);
			this.assertNotReserved(dstReal);
			if (this.dryRun) { logger.debug(`[FolderBridge DryRun] rename ${srcReal} → ${dstReal}`); return; }
			await fs.promises.mkdir(path.dirname(dstReal), { recursive: true });

			// Wait for srcReal to materialise before attempting the rename.
			// Obsidian's vault.create() may register a TFile in its in-memory
			// index and focus the inline-title editor *before* adapter.write()
			// has finished writing the file to disk.  If the user immediately
			// types a title and blurs, adapter.rename() is called while the
			// source path hasn't been written yet.  OneDrive cloud-sync operations
			// can also cause a transient ENOENT on a freshly-written file.
			const MAX_WAIT_MS = 2000;
			const POLL_MS = 100;
			let waited = 0;
			let srcExists = false;
			while (waited <= MAX_WAIT_MS) {
				try {
					await fs.promises.access(srcReal, fs.constants.F_OK);
					srcExists = true;
					break;
				} catch {
					if (waited >= MAX_WAIT_MS) break;
					await new Promise<void>(resolve => setTimeout(resolve, POLL_MS));
					waited += POLL_MS;
				}
			}

			if (!srcExists) {
				// Check for an idempotent rename: an external tool or a parallel
				// vault.create() path may have already moved the file.
				try {
					await fs.promises.access(dstReal, fs.constants.F_OK);
					return; // destination already exists – rename is effectively done
				} catch { /* neither end exists; fall through to throw */ }
				throw new Error(
					`Folder Bridge: Cannot rename "${path.basename(srcReal)}" – the source file was not found after ` +
					`waiting ${MAX_WAIT_MS}ms. ` +
					`If this file is in OneDrive "Files On Demand", right-click it in Windows Explorer and ` +
					`choose "Always keep on this device", then try again.`,
				);
			}

			try {
				await fs.promises.rename(srcReal, dstReal);
			} catch (e) {
				const err = e as NodeJS.ErrnoException;
				if (err.code === 'EXDEV') {
					// Cross-device move (e.g. different drive letters on Windows):
					// fall back to copy-then-delete so the operation succeeds transparently.
					// Use fs.promises.cp so that both files and directories are handled.
					await fs.promises.cp(srcReal, dstReal, { recursive: true });
					await fs.promises.rm(srcReal, { recursive: true });
					return;
				}
				throw new Error(`Folder Bridge: ${translateFsError(err, 'rename')}`);
			}
			return;
		}

		// Cross-mount or cross-adapter rename is not atomic – surface a clear error
		throw new Error(
			`Folder Bridge: Cannot move "${normalizedPath}" to "${newNormalizedPath}" across mount boundaries. ` +
			`Please copy the file manually instead.`
		);
	}

	async copy(normalizedPath: string, newNormalizedPath: string): Promise<void> {
		const srcMount = this.pathMapper.getMountForPath(normalizedPath);
		const dstMount = this.pathMapper.getMountForPath(newNormalizedPath);

		if (!srcMount && !dstMount) {
			return this.orig().copy(normalizedPath, newNormalizedPath);
		}

		if (dstMount?.readOnly) { this.warnReadOnly(dstMount); return; }

		if ((srcMount && this.isPathIgnored(normalizedPath, srcMount)) || (dstMount && this.isPathIgnored(newNormalizedPath, dstMount))) {
			throw new Error(`Folder Bridge: Cannot copy ignored paths`);
		}

		if (this.dryRun) {
			const srcDesc = srcMount ? this.pathMapper.toRealPath(normalizedPath, srcMount) : normalizedPath;
			const dstDesc = dstMount ? this.pathMapper.toRealPath(newNormalizedPath, dstMount) : newNormalizedPath;
			logger.debug(`[FolderBridge DryRun] copy ${srcDesc} → ${dstDesc}`);
			return;
		}

		try {
			const srcWebDAV = srcMount ? this.getWebDAV(srcMount) : null;
			const dstWebDAV = dstMount ? this.getWebDAV(dstMount) : null;
			const srcS3 = srcMount ? this.getS3(srcMount) : null;
			const dstS3 = dstMount ? this.getS3(dstMount) : null;
			const srcSFTP = srcMount ? this.getSFTP(srcMount) : null;
			const dstSFTP = dstMount ? this.getSFTP(dstMount) : null;

			// Server-side copy when both ends are on the same WebDAV mount
			// (srcWebDAV truthy implies srcMount non-null; dstWebDAV implies dstMount non-null)
			if (srcWebDAV && dstWebDAV && srcMount && dstMount && srcMount.id === dstMount.id) {
				await srcWebDAV.copy(this.toServerPath(normalizedPath, srcMount), this.toServerPath(newNormalizedPath, dstMount));
				return;
			}

			// Server-side copy for S3 same-bucket same-mount
			if (srcS3 && dstS3 && srcMount && dstMount && srcMount.id === dstMount.id) {
				await srcS3.copy(this.toServerPath(normalizedPath, srcMount), this.toServerPath(newNormalizedPath, dstMount));
				return;
			}

			// SFTP server-side rename (which is atomic); for copy we read+write
			// (SFTP has no native copy command)

			// Read from source
			let content: Buffer;
			if (srcWebDAV && srcMount) {
				content = Buffer.from(await srcWebDAV.readBinary(this.toServerPath(normalizedPath, srcMount)));
			} else if (srcS3 && srcMount) {
				content = Buffer.from(await srcS3.readBinary(this.toServerPath(normalizedPath, srcMount)));
			} else if (srcSFTP && srcMount) {
				content = Buffer.from(await srcSFTP.readBinary(this.toServerPath(normalizedPath, srcMount)));
			} else if (srcMount) {
				content = await fs.promises.readFile(this.toReal(normalizedPath, srcMount));
			} else {
				content = Buffer.from(await this.orig().readBinary(normalizedPath));
			}

			const contentAB = content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength);

			// Write to destination
			if (dstWebDAV && dstMount) {
				await dstWebDAV.writeBinary(this.toServerPath(newNormalizedPath, dstMount), contentAB);
			} else if (dstS3 && dstMount) {
				await dstS3.writeBinary(this.toServerPath(newNormalizedPath, dstMount), contentAB);
			} else if (dstSFTP && dstMount) {
				await dstSFTP.writeBinary(this.toServerPath(newNormalizedPath, dstMount), contentAB);
			} else if (dstMount) {
				const dstReal = this.toReal(newNormalizedPath, dstMount);
				this.assertAllowed(dstReal);
				this.assertNotReserved(dstReal);
				await fs.promises.mkdir(path.dirname(dstReal), { recursive: true });
				await fs.promises.writeFile(dstReal, content);
			} else {
				await this.orig().writeBinary(newNormalizedPath, contentAB);
			}
		} catch (e) {
			// Re-throw FolderBridge errors unchanged; translate raw fs errors
			const err = e as Error;
			if (err.message.startsWith('Folder Bridge:')) throw err;
			throw new Error(`Folder Bridge: ${translateFsError(e as NodeJS.ErrnoException, 'copy')}`);
		}
	}
}
