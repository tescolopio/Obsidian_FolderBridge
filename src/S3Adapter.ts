import { normalizePath } from 'obsidian';
import { MountPoint } from './types';
import { loadSessionCredential } from './CredentialStore';
import { logger } from './logger';
import { loadOptionalNodeModule } from './runtimeNode';

/**
 * S3Adapter wraps the AWS SDK v3 S3 client and exposes the same surface area
 * that VirtualAdapter uses for local/WebDAV operations, allowing transparent
 * delegation for S3 and Backblaze B2 mounts.
 *
 * Key design decisions:
 *  - S3 is a flat key-value store; "folders" are simulated via key prefixes
 *    ending in "/" (common prefix convention).
 *  - `mount.realPath` is used as the key prefix (e.g. "/" or "/notes/").
 *    Combined with `mount.s3Bucket` and `mount.s3Endpoint`, it defines the
 *    full addressable namespace.
 *  - Rename = CopyObject + DeleteObject (S3 has no atomic rename).
 *  - mkdir creates a zero-byte placeholder object with a trailing "/" key.
 *  - The AWS SDK is lazy-loaded so that this file can be bundled without
 *    pulling in heavy AWS internals at module evaluation time.
 *
 * Backblaze B2 compatibility:
 *  - Set `mount.s3Endpoint` to the B2 S3-compatible endpoint, e.g.
 *    "https://s3.us-west-004.backblazeb2.com"
 *  - Set `mount.s3ForcePathStyle = true` (required for B2).
 *  - Use Application Key ID / Application Key as access key ID / secret.
 */

// ---------------------------------------------------------------------------
// Lazy AWS SDK loader — isolates heavy imports from mobile / initial load
// ---------------------------------------------------------------------------

/** Minimal interface for the lazy-loaded @aws-sdk/client-s3 module. */
interface S3AwsModule {
    S3Client: new (cfg: S3Config) => S3ClientInstance;
    PutObjectCommand: new (input: object) => object;
    GetObjectCommand: new (input: object) => object;
    HeadObjectCommand: new (input: object) => object;
    DeleteObjectCommand: new (input: object) => object;
    DeleteObjectsCommand: new (input: object) => object;
    CopyObjectCommand: new (input: object) => object;
    ListObjectsV2Command: new (input: object) => object;
}

/** Minimal S3 client configuration. */
interface S3Config {
    region: string;
    credentials: { accessKeyId: string; secretAccessKey: string };
    endpoint?: string;
    forcePathStyle?: boolean;
}

/** Minimal interface for the initialized S3Client instance. */
interface S3ClientInstance {
    send(command: object): Promise<S3SendResult>;
    destroy?(): void;
}

/** Body stream returned by GetObjectCommand; extends AsyncIterable for for-await enumeration. */
interface S3ResponseBody extends AsyncIterable<Buffer | Uint8Array> {
    transformToByteArray?(): Promise<Uint8Array>;
    transformToString?(encoding: string): Promise<string>;
}

/** Union of all S3 response shapes returned by send() in this adapter. */
interface S3SendResult {
    Contents?: Array<{ Key?: string }>;
    CommonPrefixes?: Array<{ Prefix?: string }>;
    IsTruncated?: boolean;
    NextContinuationToken?: string;
    KeyCount?: number;
    LastModified?: Date;
    ContentLength?: number;
    Body?: S3ResponseBody;
}

function loadAWS(): S3AwsModule {
    const awsModule = loadOptionalNodeModule<S3AwsModule>('@aws-sdk/client-s3');
    if (!awsModule) throw new Error('@aws-sdk/client-s3 is unavailable in this environment');
    return awsModule;
}

// ---------------------------------------------------------------------------
// Stat-result type (matches VirtualAdapter / WebDAVAdapter surface)
// ---------------------------------------------------------------------------

export interface S3StatResult {
    type: 'file' | 'folder';
    ctime: number;
    mtime: number;
    size: number;
}

// ---------------------------------------------------------------------------
// S3Adapter
// ---------------------------------------------------------------------------

export class S3Adapter {
    // The client instance created in the constructor
    private client: S3ClientInstance;
    private bucket: string;
    /** Normalized key prefix for this mount, always ending with "/" (or empty for bucket root). */
    private prefix: string;

    constructor(
        bucket: string,
        region: string,
        accessKeyId: string,
        secretAccessKey: string,
        options?: {
            endpoint?: string;
            forcePathStyle?: boolean;
        }
    ) {
        const aws = loadAWS();
        this.bucket = bucket;
        // Normalize prefix: strip leading slash, ensure trailing slash
        this.prefix = '';

        const cfg: S3Config = {
            region,
            credentials: { accessKeyId, secretAccessKey },
        };
        if (options?.endpoint) cfg.endpoint = options.endpoint;
        if (options?.forcePathStyle) cfg.forcePathStyle = true;

        this.client = new aws.S3Client(cfg);
    }

    // ------------------------------------------------------------------
    // Factory
    // ------------------------------------------------------------------

    /**
     * Build an S3Adapter from a MountPoint, resolving the secret key from
     * either the transient field (newly entered in the modal) or sessionStorage.
     * Returns null if any required fields are missing.
     */
    static fromMount(mount: MountPoint): S3Adapter | null {
        if (!mount.s3Bucket || !mount.s3Region || !mount.s3AccessKeyId) return null;
        const secret =
            mount.s3SecretKey ??
            (mount.id ? loadSessionCredential('s3', mount.id) : null);
        if (!secret) return null;

        const s3 = new S3Adapter(
            mount.s3Bucket,
            mount.s3Region,
            mount.s3AccessKeyId,
            secret,
            {
                endpoint: mount.s3Endpoint ?? undefined,
                forcePathStyle: mount.s3ForcePathStyle ?? false,
            }
        );
        s3.setPrefix(mount.realPath);
        return s3;
    }

    // ------------------------------------------------------------------
    // Key helpers
    // ------------------------------------------------------------------

    /**
     * Translate a server-relative path (the value produced by
     * PathMapper.toRealPath for an S3 mount) into an S3 object key.
     *
     * PathMapper stores `mount.realPath` as the key prefix root (e.g. "/" or
     * "/notes/").  The server-relative path handed to us already has that
     * prefix stripped — it is the path relative to the S3 mount root.
     * We prepend `this.prefix` (mount.realPath normalised) to form the full key.
     */
    private toKey(serverRelativePath: string): string {
        // Normalise to forward slashes; strip leading slash
        const clean = serverRelativePath.replace(/\\/g, '/').replace(/^\//, '');
        return this.prefix ? `${this.prefix}${clean}` : clean;
    }

    /**
     * Convert an S3 object key back to a server-relative path (leading slash).
     */
    private fromKey(key: string): string {
        const stripped = this.prefix ? key.slice(this.prefix.length) : key;
        return stripped.startsWith('/') ? stripped : '/' + stripped;
    }

    /**
     * Set the key prefix from a mount's realPath.  Called by fromMount after
     * construction so the adapter knows its namespace.
     *
     * realPath is stored as "/" or "/notes/" style — normalise to no leading
     * slash, always trailing slash (or empty for bucket root).
     */
    setPrefix(realPath: string): void {
        const clean = realPath.replace(/\\/g, '/').replace(/^\//, '').replace(/\/$/, '');
        this.prefix = clean ? `${clean}/` : '';
    }

    // ------------------------------------------------------------------
    // testConnection
    // ------------------------------------------------------------------

    /** Probe connectivity by listing at most 1 key. Returns null on success, error message on failure. */
    async testConnection(): Promise<string | null> {
        try {
            const aws = loadAWS();
            const cmd = new aws.ListObjectsV2Command({
                Bucket: this.bucket,
                Prefix: this.prefix || undefined,
                MaxKeys: 1,
            });
            await this.client.send(cmd);
            return null;
        } catch (e) {
            return String((e as Error).message ?? e);
        }
    }

    // ------------------------------------------------------------------
    // exists
    // ------------------------------------------------------------------

    async exists(serverPath: string): Promise<boolean> {
        const key = this.toKey(serverPath);
        try {
            const aws = loadAWS();
            // Check exact object first
            const head = new aws.HeadObjectCommand({ Bucket: this.bucket, Key: key });
            await this.client.send(head);
            return true;
        } catch (headErr: unknown) {
            // If head failed, check whether it exists as a "directory" (prefix)
            if (this.isNotFound(headErr)) {
                return await this.existsAsPrefix(key);
            }
            return false;
        }
    }

    private async existsAsPrefix(key: string): Promise<boolean> {
        try {
            const aws = loadAWS();
            const prefix = key.endsWith('/') ? key : `${key}/`;
            const cmd = new aws.ListObjectsV2Command({
                Bucket: this.bucket,
                Prefix: prefix,
                MaxKeys: 1,
            });
            const resp = await this.client.send(cmd);
            return (resp.KeyCount ?? 0) > 0 || (resp.Contents?.length ?? 0) > 0;
        } catch {
            return false;
        }
    }

    // ------------------------------------------------------------------
    // stat
    // ------------------------------------------------------------------

    async stat(serverPath: string): Promise<S3StatResult | null> {
        const key = this.toKey(serverPath);
        try {
            const aws = loadAWS();
            // First try an exact object lookup
            const head = new aws.HeadObjectCommand({ Bucket: this.bucket, Key: key });
            const resp = await this.client.send(head);
            return {
                type: 'file',
                ctime: resp.LastModified ? new Date(resp.LastModified).getTime() : 0,
                mtime: resp.LastModified ? new Date(resp.LastModified).getTime() : 0,
                size: resp.ContentLength ?? 0,
            };
        } catch (headErr: unknown) {
            if (!this.isNotFound(headErr)) return null;
            // Check if it's a virtual directory (has objects under the prefix)
            const isDir = await this.existsAsPrefix(key);
            if (isDir) {
                return { type: 'folder', ctime: 0, mtime: 0, size: 0 };
            }
            return null;
        }
    }

    // ------------------------------------------------------------------
    // list
    // ------------------------------------------------------------------

    /**
     * List the immediate children of a virtual S3 directory.
     *
     * Uses ListObjectsV2 with a delimiter of "/" so that S3 returns
     * common prefixes (sub-folders) and direct object keys (files)
     * separately — matching the semantics of a real directory listing.
     */
    async list(
        serverPath: string,
        virtualParentPath: string,
        _mount: MountPoint
    ): Promise<{ files: string[]; folders: string[] }> {
        const files: string[] = [];
        const folders: string[] = [];

        let prefix = this.toKey(serverPath);
        // Ensure prefix ends with "/" so we don't accidentally match siblings
        if (prefix && !prefix.endsWith('/')) prefix += '/';

        try {
            const aws = loadAWS();
            let continuationToken: string | undefined;

            do {
                const cmd = new aws.ListObjectsV2Command({
                    Bucket: this.bucket,
                    Prefix: prefix || undefined,
                    Delimiter: '/',
                    MaxKeys: 1000,
                    ContinuationToken: continuationToken,
                });
                const resp = await this.client.send(cmd);

                // Files — direct object keys under this prefix
                for (const obj of resp.Contents ?? []) {
                    const key: string = obj.Key ?? '';
                    if (!key || key === prefix) continue; // skip the directory placeholder itself
                    const name = key.slice(prefix.length);
                    if (!name || name.includes('/')) continue; // shouldn't happen with delimiter, but be safe
                    const virtualChild = virtualParentPath
                        ? normalizePath(virtualParentPath + '/' + name)
                        : name;
                    files.push(virtualChild);
                }

                // Folders — common prefixes (virtual sub-directories)
                for (const cp of resp.CommonPrefixes ?? []) {
                    const cpKey: string = cp.Prefix ?? '';
                    if (!cpKey) continue;
                    // Strip trailing slash, then extract name
                    const withoutTrailing = cpKey.replace(/\/$/, '');
                    const name = withoutTrailing.slice(prefix.length);
                    if (!name) continue;
                    const virtualChild = virtualParentPath
                        ? normalizePath(virtualParentPath + '/' + name)
                        : name;
                    folders.push(virtualChild);
                }

                continuationToken = resp.IsTruncated ? resp.NextContinuationToken : undefined;
            } while (continuationToken);
        } catch (e) {
            logger.error(`[Folder Bridge] S3 list failed for "${serverPath}":`, e);
        }

        return { files, folders };
    }

    // ------------------------------------------------------------------
    // read
    // ------------------------------------------------------------------

    async readText(serverPath: string): Promise<string> {
        const body = await this.readBodyStream(serverPath);
        return body;
    }

    async readBinary(serverPath: string): Promise<ArrayBuffer> {
        const aws = loadAWS();
        const key = this.toKey(serverPath);
        const cmd = new aws.GetObjectCommand({ Bucket: this.bucket, Key: key });
        const resp = await this.client.send(cmd);
        return await this.streamToArrayBuffer(resp.Body);
    }

    private async readBodyStream(serverPath: string): Promise<string> {
        const aws = loadAWS();
        const key = this.toKey(serverPath);
        const cmd = new aws.GetObjectCommand({ Bucket: this.bucket, Key: key });
        const resp = await this.client.send(cmd);
        const body = resp.Body;
        if (!body) return '';
        // AWS SDK v3 Body is a Readable stream (Node) or ReadableStream (browser)
        if (typeof body.transformToString === 'function') {
            return await body.transformToString('utf-8');
        }
        // Node.js Readable fallback
        const chunks: Buffer[] = [];
        for await (const chunk of body) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        return Buffer.concat(chunks).toString('utf-8');
    }

    private async streamToArrayBuffer(body: unknown): Promise<ArrayBuffer> {
        const b = body as S3ResponseBody;
        if (typeof b?.transformToByteArray === 'function') {
            const arr = await b.transformToByteArray();
            return arr.buffer as ArrayBuffer;
        }
        const chunks: Buffer[] = [];
        for await (const chunk of b) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        const buf = Buffer.concat(chunks);
        return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    }

    // ------------------------------------------------------------------
    // write
    // ------------------------------------------------------------------

    async writeText(serverPath: string, data: string): Promise<void> {
        const aws = loadAWS();
        const key = this.toKey(serverPath);
        const cmd = new aws.PutObjectCommand({
            Bucket: this.bucket,
            Key: key,
            Body: data,
            ContentType: 'text/plain; charset=utf-8',
        });
        await this.client.send(cmd);
    }

    async writeBinary(serverPath: string, data: ArrayBuffer): Promise<void> {
        const aws = loadAWS();
        const key = this.toKey(serverPath);
        const cmd = new aws.PutObjectCommand({
            Bucket: this.bucket,
            Key: key,
            Body: Buffer.from(data),
        });
        await this.client.send(cmd);
    }

    async append(serverPath: string, data: string): Promise<void> {
        // Only a genuine "not found" may be treated as an empty file.  Any other
        // read failure (timeout, 401/403, 5xx) must abort: otherwise the write
        // below would replace the whole object with just the appended fragment.
        let existing = '';
        try {
            existing = await this.readText(serverPath);
        } catch (err) {
            if (!this.isNotFound(err)) throw err;
        }
        await this.writeText(serverPath, existing + data);
    }

    // ------------------------------------------------------------------
    // mkdir
    // ------------------------------------------------------------------

    /**
     * Create a virtual directory by writing a zero-byte placeholder object
     * with a trailing "/" in the key.  S3 itself does not have real folders;
     * this placeholder makes the prefix visible to listing operations.
     */
    async mkdir(serverPath: string): Promise<void> {
        const aws = loadAWS();
        const key = this.toKey(serverPath);
        const dirKey = key.endsWith('/') ? key : `${key}/`;
        const cmd = new aws.PutObjectCommand({
            Bucket: this.bucket,
            Key: dirKey,
            Body: '',
            ContentType: 'application/x-directory',
        });
        await this.client.send(cmd);
    }

    // ------------------------------------------------------------------
    // remove
    // ------------------------------------------------------------------

    async remove(serverPath: string): Promise<void> {
        const aws = loadAWS();
        const key = this.toKey(serverPath);

        // Try deleting as a file first
        const del = new aws.DeleteObjectCommand({ Bucket: this.bucket, Key: key });
        await this.client.send(del);

        // Also clean up the directory placeholder if it exists
        const dirKey = key.endsWith('/') ? key : `${key}/`;
        if (dirKey !== key) {
            try {
                await this.client.send(new aws.DeleteObjectCommand({ Bucket: this.bucket, Key: dirKey }));
            } catch { /* ignore */ }
        }
    }

    /**
     * Recursively remove all objects under a prefix (for directory deletes).
     */
    async removePrefix(serverPath: string): Promise<void> {
        const aws = loadAWS();
        let prefix = this.toKey(serverPath);
        if (!prefix.endsWith('/')) prefix += '/';

        let continuationToken: string | undefined;
        do {
            const listCmd = new aws.ListObjectsV2Command({
                Bucket: this.bucket,
                Prefix: prefix,
                MaxKeys: 1000,
                ContinuationToken: continuationToken,
            });
            const resp = await this.client.send(listCmd);
            const keys = (resp.Contents ?? []).map((o: { Key?: string }) => o.Key).filter(Boolean) as string[];

            if (keys.length > 0) {
                const delCmd = new aws.DeleteObjectsCommand({
                    Bucket: this.bucket,
                    Delete: { Objects: keys.map((Key: string) => ({ Key })), Quiet: true },
                });
                await this.client.send(delCmd);
            }

            continuationToken = resp.IsTruncated ? resp.NextContinuationToken : undefined;
        } while (continuationToken);
    }

    // ------------------------------------------------------------------
    // rename / copy
    // ------------------------------------------------------------------

    async rename(srcServerPath: string, dstServerPath: string): Promise<void> {
        await this.copy(srcServerPath, dstServerPath);
        await this.remove(srcServerPath);
    }

    async copy(srcServerPath: string, dstServerPath: string): Promise<void> {
        const aws = loadAWS();
        const srcKey = this.toKey(srcServerPath);
        const dstKey = this.toKey(dstServerPath);

        // Check if source is a file or directory
        const srcStat = await this.stat(srcServerPath);
        if (srcStat?.type === 'folder') {
            await this.copyPrefix(srcKey, dstKey);
        } else {
            const cmd = new aws.CopyObjectCommand({
                Bucket: this.bucket,
                CopySource: this.copySource(srcKey),
                Key: dstKey,
            });
            await this.client.send(cmd);
        }
    }

    private async copyPrefix(srcPrefix: string, dstPrefix: string): Promise<void> {
        const aws = loadAWS();
        const normalizedSrc = srcPrefix.endsWith('/') ? srcPrefix : `${srcPrefix}/`;
        const normalizedDst = dstPrefix.endsWith('/') ? dstPrefix : `${dstPrefix}/`;

        let continuationToken: string | undefined;
        do {
            const listCmd = new aws.ListObjectsV2Command({
                Bucket: this.bucket,
                Prefix: normalizedSrc,
                MaxKeys: 1000,
                ContinuationToken: continuationToken,
            });
            const resp = await this.client.send(listCmd);

            for (const obj of resp.Contents ?? []) {
                const srcKey: string = obj.Key ?? '';
                if (!srcKey) continue;
                const dstKey = normalizedDst + srcKey.slice(normalizedSrc.length);
                await this.client.send(new aws.CopyObjectCommand({
                    Bucket: this.bucket,
                    CopySource: this.copySource(srcKey),
                    Key: dstKey,
                }));
            }

            continuationToken = resp.IsTruncated ? resp.NextContinuationToken : undefined;
        } while (continuationToken);
    }

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------

    /**
     * CopyObject's `CopySource` must be URL-encoded (bucket/key, separated by a
     * slash).  Encode each key segment so spaces, `+`, `?`, `#` and non-ASCII
     * characters survive, while keeping the `/` separators literal.
     */
    private copySource(key: string): string {
        return `${this.bucket}/${key.split('/').map(encodeURIComponent).join('/')}`;
    }

    private isNotFound(err: unknown): boolean {
        if (typeof err !== 'object' || err === null) return false;
        const e = err as { $metadata?: { httpStatusCode?: number }; name?: string; Code?: string };
        return (
            e.$metadata?.httpStatusCode === 404 ||
            e.name === 'NoSuchKey' ||
            e.Code === 'NoSuchKey' ||
            e.name === 'NotFound'
        );
    }
}
