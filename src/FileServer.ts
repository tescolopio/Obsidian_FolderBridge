import { loadOptionalNodeModule } from './runtimeNode';
import { logger } from './logger';

/**
 * FileServer — minimal localhost HTTP server for streaming files from local mounts.
 *
 * Why this exists
 * ───────────────
 * Modern Obsidian uses `app://<vaultId>/` to serve embedded assets.  That
 * protocol is restricted to files inside the vault root, so external mounts
 * get ERR_FILE_NOT_FOUND.  Serving small assets (images, PDFs ≤ maxDataUriMB)
 * as `data:` URIs works around this, but video and audio files are typically
 * tens to hundreds of MB — far too large for a data URI.
 *
 * `app://local/` is the Electron "any local file" fallback, but its protocol
 * handler does NOT implement byte-range requests (`Accept-Ranges: bytes`).
 * HTML5 `<video>` and `<audio>` elements require range support for seeking
 * and progressive playback; without it the player renders controls but the
 * media never loads.
 *
 * This server listens on a random port on 127.0.0.1 and serves files with
 * full range-request support.  A per-session random token in the URL prevents
 * other browser tabs / processes from making arbitrary file requests.
 *
 * Security
 * ────────
 * • Binds only to 127.0.0.1 — never reachable from the network.
 * • Every request must carry the correct session token (query param `t`).
 * • The requested file path must be under one of the registered allowed
 *   mount roots (set by callers via `addAllowedPath` / `removeAllowedPath`).
 *   Requests for paths outside these roots receive 403.
 *
 * Lifecycle
 * ─────────
 * Call `start()` once during plugin load, `stop()` during plugin unload.
 * The server is lazily activated — if no video/audio is ever opened it
 * consumes almost no resources (one TCP socket on localhost).
 */

// Lazy-loaded Node.js builtins — safe on Obsidian Mobile (Capacitor).
const httpMod: typeof import('http') | null = loadOptionalNodeModule<typeof import('http')>('http');
const fsMod: typeof import('fs') | null = loadOptionalNodeModule<typeof import('fs')>('fs');
const pathMod: typeof import('path') | null = loadOptionalNodeModule<typeof import('path')>('path');

// Import the single-source-of-truth MIME tables from OSHelpers so this file
// never maintains its own independent copy.
import { ALL_MEDIA_MIME } from './OSHelpers';

// Re-export STREAMING_MIME so consumers (VirtualAdapter, main.ts) can import
// it from this file without needing to know it lives in OSHelpers.
export { STREAMING_MIME } from './OSHelpers';

export class FileServer {
    private server: import('http').Server | null = null;
    private port = 0;
    /** Real mount roots that this server is allowed to read from. */
    private allowedRoots: Set<string> = new Set();
    /** Cryptographic session token — regenerated each time start() is called. */
    private token = '';

    // ------------------------------------------------------------------
    // Lifecycle
    // ------------------------------------------------------------------

    /**
     * Start the server on a random available port.
     * Safe to call more than once; subsequent calls are no-ops.
     * Returns false on mobile (Node.js http unavailable).
     */
    async start(): Promise<boolean> {
        if (this.server) return true;
        if (!httpMod) return false;          // mobile — skip silently

        this.token = this.generateToken();

        return new Promise<boolean>((resolve, reject) => {
            const srv = httpMod.createServer((req, res) => {
                this.handleRequest(req, res);
            });

            srv.on('error', (err) => {
                logger.error('[FolderBridge] FileServer failed to start:', err);
                reject(err);
            });

            // Port 0 → OS assigns a free port
            srv.listen(0, '127.0.0.1', () => {
                const addr = srv.address() as { port: number } | null;
                if (!addr) { srv.close(); reject(new Error('FileServer: address() returned null')); return; }
                this.port = addr.port;
                this.server = srv;
                logger.debug(`[FolderBridge] FileServer listening on 127.0.0.1:${this.port}`);
                resolve(true);
            });
        });
    }

    /** Shut down the server (called on plugin unload). */
    stop(): void {
        if (!this.server) return;
        this.server.close();
        this.server = null;
        this.port = 0;
        this.token = '';
        logger.debug('[FolderBridge] FileServer stopped');
    }

    /** True after a successful start(). */
    get isRunning(): boolean { return this.server !== null && this.port > 0; }

    // ------------------------------------------------------------------
    // Allow-list management
    // ------------------------------------------------------------------

    /** Permit the server to serve files under `realPath` (a mount root). */
    addAllowedPath(realPath: string): void {
        this.allowedRoots.add(this.normalize(realPath));
    }

    /** Revoke serving rights for a mount root (called on unmount). */
    removeAllowedPath(realPath: string): void {
        this.allowedRoots.delete(this.normalize(realPath));
    }

    // ------------------------------------------------------------------
    // URL generation
    // ------------------------------------------------------------------

    /**
     * Return a localhost URL that the Obsidian renderer (Electron) can use
     * to stream the file at `realPath`.
     *
     * Only call this when `isRunning` is true.
     */
    getFileUrl(realPath: string): string {
        // Normalise separators so the URL is platform-independent
        const forward = pathMod
            ? realPath.split(pathMod.sep).join('/')
            : realPath.replace(/\\/g, '/');
        return `http://127.0.0.1:${this.port}/file?t=${encodeURIComponent(this.token)}&p=${encodeURIComponent(forward)}`;
    }

    // ------------------------------------------------------------------
    // Request handler
    // ------------------------------------------------------------------

    private handleRequest(req: import('http').IncomingMessage, res: import('http').ServerResponse): void {
        try {
            const urlObj = new URL(req.url ?? '', 'http://localhost');
            const token = urlObj.searchParams.get('t');
            const rawPath = urlObj.searchParams.get('p');

            // Validate token
            if (!token || token !== this.token) {
                res.writeHead(403, { 'Content-Type': 'text/plain' });
                res.end('Forbidden');
                return;
            }

            if (!rawPath) {
                res.writeHead(400, { 'Content-Type': 'text/plain' });
                res.end('Bad Request');
                return;
            }

            // Normalise path (handle both forward- and back-slash on Windows)
            const filePath = decodeURIComponent(rawPath).replace(/\\/g, '/');

            // Security: verify path is under an allowed mount root
            if (!this.isPathAllowed(filePath)) {
                res.writeHead(403, { 'Content-Type': 'text/plain' });
                res.end('Forbidden');
                return;
            }

            if (!fsMod || !pathMod) {
                res.writeHead(500);
                res.end('fs unavailable');
                return;
            }

            // Stat the file
            let stat: import('fs').Stats;
            try {
                // On Windows, readFileSync(encodedForwardSlashPath) works but
                // fsMod.statSync needs the OS-native path separator.
                const nativePath = filePath.split('/').join(pathMod.sep);
                stat = fsMod.statSync(nativePath);
            } catch {
                res.writeHead(404, { 'Content-Type': 'text/plain' });
                res.end('Not Found');
                return;
            }

            if (stat.isDirectory()) {
                res.writeHead(403, { 'Content-Type': 'text/plain' });
                res.end('Forbidden');
                return;
            }

            const ext = pathMod.extname(filePath).toLowerCase();
            // Use ALL_MEDIA_MIME (streaming + embeddable) so the server can also
            // serve images/PDFs that were too large for the data: URI cap.
            const mime = ALL_MEDIA_MIME[ext] ?? 'application/octet-stream';
            const fileSize = stat.size;
            const nativePath = filePath.split('/').join(pathMod.sep);

            // Add CORS headers so Obsidian's renderer (different "origin") can load the resource
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Accept-Ranges', 'bytes');

            const rangeHeader = req.headers['range'];

            if (rangeHeader) {
                // Parse "bytes=start-end" (RFC 7233)
                const m = /bytes=(\d*)-(\d*)/.exec(rangeHeader);
                if (!m) {
                    res.writeHead(416, { 'Content-Range': `bytes */${fileSize}` });
                    res.end();
                    return;
                }

                const start = m[1] !== '' ? parseInt(m[1], 10) : fileSize - (m[2] !== '' ? parseInt(m[2], 10) : 0);
                const end = m[2] !== '' ? parseInt(m[2], 10) : fileSize - 1;

                if (isNaN(start) || isNaN(end) || start > end || end >= fileSize || start < 0) {
                    res.writeHead(416, { 'Content-Range': `bytes */${fileSize}` });
                    res.end();
                    return;
                }

                const chunkSize = end - start + 1;
                res.writeHead(206, {
                    'Content-Range': `bytes ${start}-${end}/${fileSize}`,
                    'Content-Length': chunkSize,
                    'Content-Type': mime,
                });
                fsMod.createReadStream(nativePath, { start, end }).pipe(res);
            } else {
                res.writeHead(200, {
                    'Content-Length': fileSize,
                    'Content-Type': mime,
                });
                fsMod.createReadStream(nativePath).pipe(res);
            }
        } catch (err) {
            logger.error('[FolderBridge] FileServer request error:', err);
            if (!res.headersSent) {
                res.writeHead(500);
                res.end('Internal Server Error');
            }
        }
    }

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------

    private normalize(p: string): string {
        return p.replace(/\\/g, '/').replace(/\/$/, '');
    }

    private isPathAllowed(forwardSlashPath: string): boolean {
        // Reject any `..` segment outright.  The prefix comparison below is
        // purely lexical, so "<root>/../../etc/passwd" would otherwise pass
        // and be resolved by fs to a file outside the mount.
        if (forwardSlashPath.split('/').includes('..')) return false;
        for (const root of this.allowedRoots) {
            if (forwardSlashPath.startsWith(root + '/') || forwardSlashPath === root) {
                return true;
            }
        }
        return false;
    }

    private generateToken(): string {
        const array = new Uint8Array(24);
        crypto.getRandomValues(array);
        return Array.from(array).map(b => b.toString(16).padStart(2, '0')).join('');
    }
}
