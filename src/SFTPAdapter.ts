import { normalizePath } from 'obsidian';
import { MountPoint } from './types';
import { loadSessionCredential, decryptCredential } from './CredentialStore';
import { logger } from './logger';
import { loadOptionalNodeModule } from './runtimeNode';

/**
 * SFTPAdapter wraps the `ssh2-sftp-client` library to provide the same
 * surface area that VirtualAdapter uses for local/WebDAV/S3 operations,
 * enabling transparent delegation for SFTP mounts.
 *
 * Key design decisions:
 *  - Maintains a persistent, lazily-initialised SFTP connection per adapter.
 *  - Auto-reconnects when the connection has been dropped (server timeout,
 *    network interruption, etc.).
 *  - `mount.realPath` is the remote base directory, e.g. "/home/user/notes".
 *    All paths are resolved relative to that base.
 *  - `copy()` is implemented as read-then-write (SFTP has no server-side copy
 *    primitive for arbitrary paths).
 *
 * Authentication supports two modes, checked in order:
 *  1. Private key file  — path in `mount.sftpPrivateKeyPath`; passphrase
 *     resolved from the transient field, sessionStorage, or the stored
 *     encrypted blob.
 *  2. Password          — resolved from the transient field, sessionStorage,
 *     or the stored encrypted blob.
 *
 * SFTP requires Node.js and is therefore desktop-only.  VirtualAdapter skips
 * SFTP operations on mobile the same way it skips local-fs operations.
 */

// ---------------------------------------------------------------------------
// Lazy loader — prevents pulling in Node.js net/crypto at bundle load time
// ---------------------------------------------------------------------------

/** Minimal interface for the ssh2-sftp-client instance we use. */
interface SFTPClientInstance {
    connect(options: SFTPConnectOptions): Promise<void>;
    list(path: string): Promise<Array<{ type: string; name: string; modifyTime: number; size: number }>>;
    stat(path: string): Promise<{ isDirectory: boolean; modifyTime: number; size: number; mode?: number; atime?: number; mtime?: number }>;
    get(path: string): Promise<Buffer>;
    put(input: string | Buffer, path: string): Promise<void>;
    append(input: string | Buffer, path: string): Promise<void>;
    mkdir(path: string, recursive?: boolean): Promise<void>;
    rmdir(path: string, recursive?: boolean): Promise<void>;
    delete(path: string): Promise<void>;
    rename(src: string, dst: string): Promise<void>;
    exists(path: string): Promise<false | string>;
    end(): Promise<void>;
    sftp?: unknown;
}

/** Options accepted by SFTPClientInstance.connect(). */
interface SFTPConnectOptions {
    host: string;
    port: number;
    username: string;
    password?: string;
    privateKey?: Buffer;
    passphrase?: string;
}

function loadSFTPClient(): new () => SFTPClientInstance {
    const sftpClient = loadOptionalNodeModule<new () => SFTPClientInstance>('ssh2-sftp-client');
    if (!sftpClient) throw new Error('ssh2-sftp-client is unavailable in this environment');
    return sftpClient;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SFTPStatResult {
    type: 'file' | 'folder';
    ctime: number;
    mtime: number;
    size: number;
}

// ---------------------------------------------------------------------------
// SFTPAdapter
// ---------------------------------------------------------------------------

export class SFTPAdapter {
    private host: string;
    private port: number;
    private username: string;
    private password?: string;
    private privateKeyPath?: string;
    private passphrase?: string;

    // The sftp client instance; recreated on connect
    private sftp: SFTPClientInstance | null = null;
    /** In-flight connect promise — all concurrent callers await the same one. */
    private connectingPromise: Promise<void> | null = null;

    constructor(
        host: string,
        port: number,
        username: string,
        options: {
            password?: string;
            privateKeyPath?: string;
            passphrase?: string;
        }
    ) {
        this.host = host;
        this.port = port;
        this.username = username;
        this.password = options.password;
        this.privateKeyPath = options.privateKeyPath;
        this.passphrase = options.passphrase;
    }

    // ------------------------------------------------------------------
    // Factory
    // ------------------------------------------------------------------

    /**
     * Build an SFTPAdapter from a MountPoint, resolving credentials from
     * transient fields, sessionStorage, or encrypted blobs (in that order).
     * Returns null if required fields are missing.
     */
    static fromMount(mount: MountPoint): SFTPAdapter | null {
        if (!mount.sftpHost || !mount.sftpUsername) return null;

        const password =
            mount.sftpPassword ??
            (mount.id ? loadSessionCredential('sftp-pw', mount.id) : null) ??
            (mount.encryptedSftpPassword ? decryptCredential(mount.encryptedSftpPassword) : null) ??
            undefined;

        const passphrase =
            mount.sftpPassphrase ??
            (mount.id ? loadSessionCredential('sftp-pp', mount.id) : null) ??
            (mount.encryptedSftpPassphrase ? decryptCredential(mount.encryptedSftpPassphrase) : null) ??
            undefined;

        return new SFTPAdapter(
            mount.sftpHost,
            mount.sftpPort ?? 22,
            mount.sftpUsername,
            {
                password,
                privateKeyPath: mount.sftpPrivateKeyPath ?? undefined,
                passphrase,
            }
        );
    }

    // ------------------------------------------------------------------
    // Connection lifecycle
    // ------------------------------------------------------------------

    private async connect(): Promise<void> {
        if (this.sftp && this.isSFTPReady()) return;
        if (this.connectingPromise) {
            // Another caller is already connecting — await the same Promise so
            // we don't race: when it resolves this.sftp will be set.
            return this.connectingPromise;
        }
        this.connectingPromise = this._doConnect().finally(() => {
            this.connectingPromise = null;
        });
        return this.connectingPromise;
    }

    private async _doConnect(): Promise<void> {
        const SFTPClient = loadSFTPClient();
        const client = new SFTPClient();

        const connectOptions: SFTPConnectOptions = {
            host: this.host,
            port: this.port,
            username: this.username,
        };

        if (this.privateKeyPath) {
            const fs = loadOptionalNodeModule<typeof import('fs')>('fs');
            if (!fs) throw new Error('fs is unavailable in this environment');
            connectOptions.privateKey = fs.readFileSync(this.privateKeyPath);
            if (this.passphrase) connectOptions.passphrase = this.passphrase;
        } else if (this.password) {
            connectOptions.password = this.password;
        }

        await client.connect(connectOptions);
        this.sftp = client;
    }

    private isSFTPReady(): boolean {
        return this.sftp?.sftp != null || typeof this.sftp?.list === 'function';
    }

    /** Close the SFTP connection. Called on unmount. */
    async disconnect(): Promise<void> {
        if (this.sftp) {
            try {
                await this.sftp.end();
            } catch { /* ignore */ }
            this.sftp = null;
        }
    }

    /** Test connectivity. Returns null on success, error message on failure. */
    async testConnection(): Promise<string | null> {
        try {
            await this.connect();
            return null;
        } catch (e) {
            return e instanceof Error ? e.message : String(e);
        }
    }

    // ------------------------------------------------------------------
    // Path helpers
    // ------------------------------------------------------------------

    /**
     * Resolve a server-relative path (handed off by PathMapper) to a full
     * remote absolute path by prepending nothing — PathMapper already emits
     * the full remote path because mount.realPath is the base dir and
     * toRealPath concatenates normally.
     *
     * On SFTP mounts, mount.realPath is stored as an absolute remote path
     * (e.g. "/home/alice/notes").  PathMapper will produce paths like
     * "/home/alice/notes/subdir/file.md".  We use them directly.
     */
    private toRemotePath(serverRelativePath: string): string {
        return serverRelativePath.replace(/\\/g, '/');
    }

    // ------------------------------------------------------------------
    // exists
    // ------------------------------------------------------------------

    async exists(serverPath: string): Promise<boolean> {
        await this.connect();
        try {
            const stat = await this.sftp!.stat(this.toRemotePath(serverPath));
            return !!stat;
        } catch {
            return false;
        }
    }

    // ------------------------------------------------------------------
    // stat
    // ------------------------------------------------------------------

    async stat(serverPath: string): Promise<SFTPStatResult | null> {
        await this.connect();
        try {
            const info = await this.sftp!.stat(this.toRemotePath(serverPath));
            return {
                type: info.mode !== undefined
                    ? (info.mode & 0o040000 ? 'folder' : 'file')
                    : (info.isDirectory ? 'folder' : 'file'),
                ctime: info.atime ? info.atime * 1000 : 0,
                mtime: info.mtime ? info.mtime * 1000 : 0,
                size: info.size ?? 0,
            };
        } catch {
            return null;
        }
    }

    // ------------------------------------------------------------------
    // list
    // ------------------------------------------------------------------

    async list(
        serverPath: string,
        virtualParentPath: string,
        _mount: MountPoint
    ): Promise<{ files: string[]; folders: string[] }> {
        const files: string[] = [];
        const folders: string[] = [];
        await this.connect();
        try {
            const entries = await this.sftp!.list(this.toRemotePath(serverPath));
            for (const entry of entries) {
                const name: string = entry.name;
                if (name === '.' || name === '..') continue;
                const virtualChild = virtualParentPath
                    ? normalizePath(virtualParentPath + '/' + name)
                    : name;
                // ssh2-sftp-client exposes entry.type: 'd' for directory, '-' for file
                if (entry.type === 'd') {
                    folders.push(virtualChild);
                } else {
                    files.push(virtualChild);
                }
            }
        } catch (e) {
            logger.error(`[Folder Bridge] SFTP list failed for "${serverPath}":`, e);
        }
        return { files, folders };
    }

    // ------------------------------------------------------------------
    // read
    // ------------------------------------------------------------------

    async readText(serverPath: string): Promise<string> {
        await this.connect();
        const buf: Buffer = await this.sftp!.get(this.toRemotePath(serverPath));
        return buf.toString('utf-8');
    }

    async readBinary(serverPath: string): Promise<ArrayBuffer> {
        await this.connect();
        const buf: Buffer = await this.sftp!.get(this.toRemotePath(serverPath));
        return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    }

    // ------------------------------------------------------------------
    // write
    // ------------------------------------------------------------------

    async writeText(serverPath: string, data: string): Promise<void> {
        await this.connect();
        await this.sftp!.put(Buffer.from(data, 'utf-8'), this.toRemotePath(serverPath));
    }

    async writeBinary(serverPath: string, data: ArrayBuffer): Promise<void> {
        await this.connect();
        await this.sftp!.put(Buffer.from(data), this.toRemotePath(serverPath));
    }

    async append(serverPath: string, data: string): Promise<void> {
        // Probe existence with the client's own exists(), which rejects on
        // connection errors (unlike this.exists(), which maps them to false).
        // A failed read must abort: otherwise the write below would replace
        // the whole file with just the appended fragment.
        await this.connect();
        const present = await this.sftp!.exists(this.toRemotePath(serverPath));
        const existing = present ? await this.readText(serverPath) : '';
        await this.writeText(serverPath, existing + data);
    }

    // ------------------------------------------------------------------
    // mkdir
    // ------------------------------------------------------------------

    async mkdir(serverPath: string): Promise<void> {
        await this.connect();
        await this.sftp!.mkdir(this.toRemotePath(serverPath), true); // recursive
    }

    // ------------------------------------------------------------------
    // remove
    // ------------------------------------------------------------------

    async remove(serverPath: string): Promise<void> {
        await this.connect();
        const remotePath = this.toRemotePath(serverPath);
        // Try file delete first; fall back to rmdir for directories
        try {
            await this.sftp!.delete(remotePath);
        } catch {
            await this.sftp!.rmdir(remotePath, true); // recursive
        }
    }

    // ------------------------------------------------------------------
    // rename / copy
    // ------------------------------------------------------------------

    async rename(srcServerPath: string, dstServerPath: string): Promise<void> {
        await this.connect();
        await this.sftp!.rename(
            this.toRemotePath(srcServerPath),
            this.toRemotePath(dstServerPath)
        );
    }

    /**
     * SFTP has no server-side copy primitive; implement as read + write.
     * Only used for files (not recursive directory copy).
     */
    async copy(srcServerPath: string, dstServerPath: string): Promise<void> {
        const data = await this.readBinary(srcServerPath);
        await this.writeBinary(dstServerPath, data);
    }
}
