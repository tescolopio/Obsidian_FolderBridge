// Type-only import: nothing from `webdav` may be evaluated when the plugin
// loads.  Its Node build eagerly requires `util`, `node:http`, `node:https`,
// `node:zlib`, … (via path-posix and node-fetch), which do not exist on
// Obsidian Mobile and would make the whole plugin fail to load.  The library
// is loaded lazily through the optional-module shim instead, exactly like
// chokidar, @aws-sdk/client-s3 and ssh2-sftp-client.
import type { WebDAVClient, FileStat } from 'webdav';
import { normalizePath } from 'obsidian';
import { MountPoint } from './types';
import { saveWebDAVPassword, loadWebDAVPassword, clearWebDAVPassword } from './CredentialStore';
import { logger } from './logger';
import { loadOptionalNodeModule } from './runtimeNode';

type WebDAVModule = Pick<typeof import('webdav'), 'createClient'>;

/** Load the `webdav` library on first use; null where it cannot run (mobile). */
function loadWebDAV(): WebDAVModule | null {
    const webdav = loadOptionalNodeModule<WebDAVModule>('webdav');
    return typeof webdav?.createClient === 'function' ? webdav : null;
}

/** fromMount() runs on every health check; warn about a missing client once. */
let warnedUnavailable = false;

/** True when WebDAV mounts can work in this environment. */
export function isWebDAVAvailable(): boolean {
    return loadWebDAV() !== null;
}

/**
 * WebDAVAdapter wraps the `webdav` npm client and exposes the same
 * surface area that VirtualAdapter uses for local fs operations, so
 * VirtualAdapter can delegate to it transparently for WebDAV mounts.
 *
 * Credentials: the URL, username, and any path prefix come from the
 * MountPoint fields. Passwords are intentionally NOT stored in data.json
 * (which syncs); they are kept in `sessionStorage` keyed by mount id and
 * must be re-entered after Obsidian restarts.
 *
 * Convention:
 *   mount.realPath   = server-relative base path, e.g. "/Documents/Work"
 *   mount.webdavUrl  = server root URL, e.g. "https://mycloud.com/dav"
 * Together they form the full resource base: "https://mycloud.com/dav/Documents/Work/..."
 */
export class WebDAVAdapter {
    private client: WebDAVClient;
    private baseUrl: string;

    constructor(webdavUrl: string, username?: string, password?: string) {
        const webdav = loadWebDAV();
        if (!webdav) throw new Error('webdav is unavailable in this environment');
        const { createClient } = webdav;
        this.baseUrl = webdavUrl.replace(/\/$/, '');
        if (username && password) {
            this.client = createClient(this.baseUrl, { username, password });
        } else if (username) {
            this.client = createClient(this.baseUrl, { username, password: '' });
        } else {
            this.client = createClient(this.baseUrl);
        }
    }

    // ------------------------------------------------------------------
    // Password-in-sessionStorage helpers
    // ------------------------------------------------------------------

    static savePassword(mountId: string, password: string): void {
        saveWebDAVPassword(mountId, password);
    }

    static loadPassword(mountId: string): string | null {
        return loadWebDAVPassword(mountId);
    }

    static clearPassword(mountId: string): void {
        clearWebDAVPassword(mountId);
    }

    /** Build a WebDAVAdapter from a MountPoint, using the sessionStorage password. */
    static fromMount(mount: MountPoint): WebDAVAdapter | null {
        if (!mount.webdavUrl) return null;
        // No WebDAV client here (Obsidian Mobile): behave like a mount whose
        // adapter could not be created instead of throwing during plugin load.
        if (!isWebDAVAvailable()) {
            if (!warnedUnavailable) {
                warnedUnavailable = true;
                logger.warn('[FolderBridge] WebDAV is unavailable in this environment; WebDAV mounts are skipped.');
            }
            return null;
        }
        const password = mount.id ? WebDAVAdapter.loadPassword(mount.id) : null;
        return new WebDAVAdapter(mount.webdavUrl, mount.webdavUsername, password ?? undefined);
    }

    // ------------------------------------------------------------------
    // Path helpers
    // ------------------------------------------------------------------

    /**
     * Convert a server-relative path (e.g. "/Documents/Work/note.md") into
     * the form expected by the webdav client (path relative to client root).
     * The client root is the webdavUrl — server paths starting with "/" are
     * already relative to the server root, so we just return them as-is after
     * joining with the mount's realPath base when needed.
     */
    private toServerPath(serverRelativePath: string): string {
        // Normalize slashes
        return serverRelativePath.replace(/\\/g, '/');
    }

    // ------------------------------------------------------------------
    // exists
    // ------------------------------------------------------------------

    async exists(serverPath: string): Promise<boolean> {
        try {
            return await this.client.exists(this.toServerPath(serverPath));
        } catch {
            return false;
        }
    }

    // ------------------------------------------------------------------
    // stat
    // ------------------------------------------------------------------

    async stat(serverPath: string): Promise<{ type: 'file' | 'folder'; ctime: number; mtime: number; size: number } | null> {
        try {
            const info = await this.client.stat(this.toServerPath(serverPath));
            const stat = 'data' in info ? info.data : info;
            return {
                type: stat.type === 'directory' ? 'folder' : 'file',
                ctime: stat.lastmod ? new Date(stat.lastmod).getTime() : 0,
                mtime: stat.lastmod ? new Date(stat.lastmod).getTime() : 0,
                size: stat.size ?? 0,
            };
        } catch {
            return null;
        }
    }

    // ------------------------------------------------------------------
    // list
    // ------------------------------------------------------------------

    async list(serverPath: string, virtualParentPath: string, _mount: MountPoint): Promise<{ files: string[]; folders: string[] }> {
        const files: string[] = [];
        const folders: string[] = [];
        try {
            const contents: FileStat[] = await this.client.getDirectoryContents(this.toServerPath(serverPath));
            for (const item of contents) {
                // Extract filename without requiring the `path` Node module so
                // this works on Obsidian Mobile (WebDAV paths always use '/').
                const name = item.filename.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? '';
                const virtualChild = virtualParentPath
                    ? normalizePath(virtualParentPath + '/' + name)
                    : name;
                if (item.type === 'directory') {
                    folders.push(virtualChild);
                } else {
                    files.push(virtualChild);
                }
            }
        } catch (e) {
            logger.error(`[Folder Bridge] WebDAV list failed for "${serverPath}":`, e);
        }
        return { files, folders };
    }

    // ------------------------------------------------------------------
    // read
    // ------------------------------------------------------------------

    async readText(serverPath: string): Promise<string> {
        const result = await this.client.getFileContents(this.toServerPath(serverPath), { format: 'text' });
        return result as string;
    }

    async readBinary(serverPath: string): Promise<ArrayBuffer> {
        const result = await this.client.getFileContents(this.toServerPath(serverPath), { format: 'binary' });
        const buf = result as Buffer;
        return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    }

    // ------------------------------------------------------------------
    // write
    // ------------------------------------------------------------------

    async writeText(serverPath: string, data: string): Promise<void> {
        await this.client.putFileContents(this.toServerPath(serverPath), data, { overwrite: true });
    }

    async writeBinary(serverPath: string, data: ArrayBuffer): Promise<void> {
        await this.client.putFileContents(this.toServerPath(serverPath), Buffer.from(data), { overwrite: true });
    }

    async append(serverPath: string, data: string): Promise<void> {
        let existing = '';
        try {
            existing = await this.readText(serverPath);
        } catch { /* file may not exist yet */ }
        await this.writeText(serverPath, existing + data);
    }

    // ------------------------------------------------------------------
    // mkdir
    // ------------------------------------------------------------------

    async mkdir(serverPath: string): Promise<void> {
        // Create directory and all missing ancestors
        const parts = serverPath.replace(/\\/g, '/').split('/').filter(Boolean);
        let cumulative = '';
        for (const part of parts) {
            cumulative += '/' + part;
            try {
                const exists = await this.client.exists(cumulative);
                if (!exists) {
                    await this.client.createDirectory(cumulative);
                }
            } catch { /* ignore if already exists */ }
        }
    }

    // ------------------------------------------------------------------
    // remove
    // ------------------------------------------------------------------

    async remove(serverPath: string): Promise<void> {
        await this.client.deleteFile(this.toServerPath(serverPath));
    }

    // ------------------------------------------------------------------
    // rename / copy
    // ------------------------------------------------------------------

    async rename(srcServerPath: string, dstServerPath: string): Promise<void> {
        await this.client.moveFile(
            this.toServerPath(srcServerPath),
            this.toServerPath(dstServerPath)
        );
    }

    async copy(srcServerPath: string, dstServerPath: string): Promise<void> {
        await this.client.copyFile(
            this.toServerPath(srcServerPath),
            this.toServerPath(dstServerPath)
        );
    }
}
