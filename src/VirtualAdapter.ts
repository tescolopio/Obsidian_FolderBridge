import { normalizePath, Notice, DataAdapter, DataWriteOptions } from 'obsidian';
import { PathMapper } from './PathMapper';
import { SecurityManager } from './SecurityManager';
import { MountPoint } from './types';
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
	private onMountRootDelete: (mount: MountPoint) => Promise<'unmount' | 'delete' | 'cancel'>;
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

	constructor(
		original: unknown,
		pathMapper: PathMapper,
		security: SecurityManager,
		dryRun = false,
		maxDataUriBytes = 10 * 1024 * 1024,
		onMountRootDelete: (mount: MountPoint) => Promise<'unmount' | 'delete' | 'cancel'>,
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
				return await fs.promises.readFile(realPath, 'utf8');
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

	// ------------------------------------------------------------------
	// write / writeBinary / append / process
	// ------------------------------------------------------------------

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
				await fs.promises.mkdir(path.dirname(realPath), { recursive: true });
				await fs.promises.writeFile(realPath, data, 'utf8');
				void this.onModify?.(normalizedPath).catch(() => { });
				return;
			} catch (e) {
				const errorMsg = `Folder Bridge: ${translateFsError(e as NodeJS.ErrnoException, 'write')}`;
				logger.error(`[FolderBridge] write failed for "${realPath}":`, e, errorMsg);
				throw new Error(errorMsg);
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
				await fs.promises.mkdir(path.dirname(realPath), { recursive: true });
				await fs.promises.writeFile(realPath, Buffer.from(data));
				void this.onModify?.(normalizedPath).catch(() => { });
			} catch (e) {
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
				void this.onModify?.(normalizedPath).catch(() => { });
			} catch (e) {
				throw new Error(`Folder Bridge: ${translateFsError(e as NodeJS.ErrnoException, 'append')}`);
			}
		}
		return this.orig().append(normalizedPath, data, options as DataWriteOptions | undefined);
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
			await this.write(normalizedPath, updated, options);
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

	private async handleRootMountDeletion(rootMount: MountPoint): Promise<boolean> {
		const action = await this.onMountRootDelete(rootMount);
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

	async trashSystem(normalizedPath: string): Promise<boolean> {
		const rootMount = this.pathMapper.getMountByVirtualPath(normalizedPath);
		if (rootMount) {
			const handled = await this.handleRootMountDeletion(rootMount);
			if (handled) return true;
		}

		const mount = this.pathMapper.getMountForPath(normalizedPath);
		if (mount) {
			if (mount.readOnly) { this.warnReadOnly(mount); return true; }
			if (this.isPathIgnored(normalizedPath, mount)) throw new Error(`Folder Bridge: Cannot trash ignored path "${normalizedPath}"`);
			const realPath = this.toReal(normalizedPath, mount);
			const webdavTS = this.getWebDAV(mount);
			if (webdavTS) {
				if (this.dryRun) { logger.debug(`[FolderBridge DryRun] trashSystem (webdav) → ${this.toServerPath(normalizedPath, mount)}`); return true; }
				await webdavTS.remove(this.toServerPath(normalizedPath, mount));
				await this.notifyDelete(normalizedPath);
				return true;
			}
			const s3TS = this.getS3(mount);
			if (s3TS) {
				if (this.dryRun) { logger.debug(`[FolderBridge DryRun] trashSystem (s3) → ${this.toServerPath(normalizedPath, mount)}`); return true; }
				await s3TS.remove(this.toServerPath(normalizedPath, mount));
				await this.notifyDelete(normalizedPath);
				return true;
			}
			const sftpTS = this.getSFTP(mount);
			if (sftpTS) {
				if (this.dryRun) { logger.debug(`[FolderBridge DryRun] trashSystem (sftp) → ${this.toServerPath(normalizedPath, mount)}`); return true; }
				await sftpTS.remove(this.toServerPath(normalizedPath, mount));
				await this.notifyDelete(normalizedPath);
				return true;
			}
			this.assertAllowed(realPath);
			if (this.dryRun) { logger.debug(`[FolderBridge DryRun] trashSystem → ${realPath}`); return true; }
			try {
				const electron = loadOptionalNodeModule<{ shell?: { trashItem(p: string): Promise<string> } }>('electron');
				const shell = electron?.shell;
				await shell?.trashItem(realPath);
				await this.notifyDelete(normalizedPath);
				return true;
			} catch {
				// Fallback: permanent delete
				await fs.promises.rm(realPath, { recursive: true, force: true });
				await this.notifyDelete(normalizedPath);
				return true;
			}
		}
		return this.orig().trashSystem(normalizedPath);
	}

	async trashLocal(normalizedPath: string, system?: boolean): Promise<void> {
		const rootMount = this.pathMapper.getMountByVirtualPath(normalizedPath);
		if (rootMount) {
			const handled = await this.handleRootMountDeletion(rootMount);
			if (handled) return;
		}

		const mount = this.pathMapper.getMountForPath(normalizedPath);
		if (mount) {
			if (mount.readOnly) { this.warnReadOnly(mount); return; }
			if (this.isPathIgnored(normalizedPath, mount)) throw new Error(`Folder Bridge: Cannot trash ignored path "${normalizedPath}"`);
			const realPath = this.toReal(normalizedPath, mount);
			const webdavTL = this.getWebDAV(mount);
			if (webdavTL) {
				if (this.dryRun) { logger.debug(`[FolderBridge DryRun] trashLocal (webdav) → ${this.toServerPath(normalizedPath, mount)}`); return; }
				await webdavTL.remove(this.toServerPath(normalizedPath, mount));
				await this.notifyDelete(normalizedPath);
				return;
			}
			const s3TL = this.getS3(mount);
			if (s3TL) {
				if (this.dryRun) { logger.debug(`[FolderBridge DryRun] trashLocal (s3) → ${this.toServerPath(normalizedPath, mount)}`); return; }
				await s3TL.remove(this.toServerPath(normalizedPath, mount));
				await this.notifyDelete(normalizedPath);
				return;
			}
			const sftpTL = this.getSFTP(mount);
			if (sftpTL) {
				if (this.dryRun) { logger.debug(`[FolderBridge DryRun] trashLocal (sftp) → ${this.toServerPath(normalizedPath, mount)}`); return; }
				await sftpTL.remove(this.toServerPath(normalizedPath, mount));
				await this.notifyDelete(normalizedPath);
				return;
			}
			this.assertAllowed(realPath);
			if (this.dryRun) { logger.debug(`[FolderBridge DryRun] trashLocal → ${realPath}`); return; }
			await fs.promises.rm(realPath, { recursive: true, force: true });
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
