import { Platform } from 'obsidian';
import { OSPlatform } from './types';
import { loadOptionalNodeModule } from './runtimeNode';

// Lazy-loaded Node.js builtins — safe on Obsidian Mobile (Capacitor) where
// Node APIs are unavailable.  On mobile these will be null; all functions
// guarded behind platform checks or try-catch will gracefully return early.
const fs: typeof import('fs') = loadOptionalNodeModule<typeof import('fs')>('fs') ?? null as never;
const path: typeof import('path') = loadOptionalNodeModule<typeof import('path')>('path') ?? null as never;

// ---------------------------------------------------------------------------
// Platform detection
// ---------------------------------------------------------------------------

export function getPlatform(): OSPlatform {
	// On Obsidian Mobile (Capacitor / Android / iOS), the Node.js `process`
	// global is not available.  Fall back to the Obsidian Platform API instead.
	if (Platform.isMobile) return 'unknown';
	const platform = (typeof process !== 'undefined') ? process.platform : undefined;
	switch (platform) {
		case 'win32': return 'windows';
		case 'linux': return 'linux';
		case 'darwin': return 'mac';
		default: return 'unknown';
	}
}

// ---------------------------------------------------------------------------
// Accessibility checks
// ---------------------------------------------------------------------------

export interface PathAccessResult {
	accessible: boolean;
	readOnly: boolean;
	error?: string;
}

/**
 * Check whether a real filesystem path is accessible, and if so whether it
 * is writable.  Safe to call on non-existent paths (returns accessible:false).
 */
export async function checkPathAccessible(realPath: string): Promise<PathAccessResult> {
	try {
		await fs.promises.access(realPath, fs.constants.F_OK);
	} catch (e) {
		return { accessible: false, readOnly: false, error: (e as Error).message };
	}

	let readOnly = false;
	try {
		await fs.promises.access(realPath, fs.constants.W_OK);
	} catch {
		readOnly = true;
	}

	return { accessible: true, readOnly };
}

/** Returns true when realPath exists and is a directory (resolving symlinks). */
export async function isDirectory(realPath: string): Promise<boolean> {
	try {
		return (await fs.promises.stat(realPath)).isDirectory();
	} catch {
		return false;
	}
}

/** Returns true when realPath is a symbolic link (does NOT follow it). */
export async function isSymlink(realPath: string): Promise<boolean> {
	try {
		return (await fs.promises.lstat(realPath)).isSymbolicLink();
	} catch {
		return false;
	}
}

/**
 * Returns true when a real path appears to exist on disk (F_OK passes) but
 * threw ENOENT when opened for reading — the fingerprint of an OneDrive /
 * SharePoint "Files On Demand" online-only placeholder on Windows.
 *
 * Intentionally async so it never blocks the event loop.
 */
export async function isCloudPlaceholder(realPath: string): Promise<boolean> {
	try {
		await fs.promises.access(realPath, fs.constants.F_OK);
		return true; // path exists on disk but readFile threw ENOENT → placeholder
	} catch {
		return false; // genuinely missing
	}
}

// ---------------------------------------------------------------------------
// Windows-specific helpers
// ---------------------------------------------------------------------------

/**
 * On Windows, detect whether a directory entry is a junction or symlink by
 * checking the lstat result.  Both are reported as symbolic links by Node.js
 * on Windows with a non-zero nlink count for junctions.
 *
 * Always returns false on non-Windows platforms.
 */
export async function isWindowsJunctionOrSymlink(realPath: string): Promise<boolean> {
	if (getPlatform() !== 'windows') return false;
	try {
		return (await fs.promises.lstat(realPath)).isSymbolicLink();
	} catch {
		return false;
	}
}

// ---------------------------------------------------------------------------
// Cross-device detection
// ---------------------------------------------------------------------------

/**
 * Returns true when pathA and pathB reside on different filesystem devices.
 * This is used to warn the user before attempting a cross-device move, which
 * requires a copy-then-delete rather than a simple rename.
 */
export async function areDifferentDevices(pathA: string, pathB: string): Promise<boolean> {
	try {
		const [statA, statB] = await Promise.all([
			fs.promises.stat(pathA).catch(() => null),
			fs.promises.stat(pathB).catch(() => null),
		]);
		if (!statA || !statB) return false;
		return (statA as import('fs').Stats & { dev: number }).dev !== (statB as import('fs').Stats & { dev: number }).dev;
	} catch {
		return false;
	}
}

// ---------------------------------------------------------------------------
// Path utilities
// ---------------------------------------------------------------------------

/** Normalize a real OS path (handles mixed separators on Windows). */
export function normalizeRealPath(realPath: string): string {
	// path.normalize on Windows converts forward slashes to backslashes.
	// We want to preserve the original separator style if possible, or at least
	// be consistent for our tests.
	const normalized = path.normalize(realPath);
	if (path.sep === '\\' && realPath.includes('/')) {
		// If we are mocking the platform to linux in tests but running on Windows,
		// path.normalize will still use backslashes. We need to fix that.
		return normalized.replace(/\\/g, '/');
	}
	return normalized;
}

/**
 * Return a resource URL that Obsidian/Electron can use to display a file
 * from an arbitrary real path (e.g. for images embedded from mounted folders).
 *
 * The "app://local/" protocol is served by the Electron main process and
 * bypasses the vault root restriction.
 */
export function realPathToResourceUrl(realPath: string): string {
	// On mobile, path module is unavailable; return a no-op URL.
	if (!path) return realPath;
	// app://local/ is the Electron protocol handler that serves ANY local file
	// path, regardless of whether it is inside the vault.  Do NOT use
	// window.app.appId here — that vault-hash host only resolves paths that are
	// children of the vault root, causing ERR_FILE_NOT_FOUND for external mounts.

	// Electron expects forward slashes even on Windows
	const forward = realPath.split(path.sep).join('/');

	// For Windows paths like D:\path, ensure a leading slash → /D:/path
	const withSlash = forward.startsWith('/') ? forward : '/' + forward;

	// Percent-encode each path segment but leave the Windows drive letter colon
	// (e.g. "C:") unencoded so Electron's handler can parse it correctly.
	const encodedPath = withSlash.split('/').map(segment => {
		if (segment.match(/^[a-zA-Z]:$/)) return segment;
		return encodeURIComponent(segment);
	}).join('/');

	const finalPath = encodedPath.startsWith('/') ? encodedPath : '/' + encodedPath;

	return `app://local${finalPath}`;
}

// ---------------------------------------------------------------------------
// Media MIME tables  (single source of truth — imported by FileServer too)
// ---------------------------------------------------------------------------

/**
 * MIME types for formats that MUST be streamed via the localhost FileServer
 * (HTML5 <video>/<audio> require byte-range / Accept-Ranges support).
 *
 * Covers every format listed in Obsidian's official supported-file-types doc
 * plus common extras.  Keeping this exported so FileServer.ts can import it
 * and avoid a second, independently-maintained copy.
 */
export const STREAMING_MIME: Record<string, string> = {
	// ── Video ──────────────────────────────────────────────────────────────
	'.mp4': 'video/mp4',
	'.m4v': 'video/mp4',
	'.webm': 'video/webm',
	'.ogv': 'video/ogg',
	'.mov': 'video/quicktime',
	'.avi': 'video/x-msvideo',
	'.mkv': 'video/x-matroska',
	'.wmv': 'video/x-ms-wmv',
	'.flv': 'video/x-flv',
	// ── Audio ──────────────────────────────────────────────────────────────
	'.mp3': 'audio/mpeg',
	'.m4a': 'audio/mp4',
	'.wav': 'audio/wav',
	'.ogg': 'audio/ogg',
	'.oga': 'audio/ogg',
	'.flac': 'audio/flac',
	'.aac': 'audio/aac',
	'.opus': 'audio/ogg; codecs=opus',
	'.weba': 'audio/webm',           // WebM audio (Obsidian-supported)
	'.3gp': 'audio/3gpp',           // 3GPP audio/video (Obsidian-supported)
	'.3g2': 'audio/3gpp2',          // 3GPP2 audio/video
};

/**
 * Derived set of extensions that must not be served as data: URIs and must
 * instead go through the range-capable FileServer.
 */
export const STREAMING_EXTENSIONS: ReadonlySet<string> = new Set(Object.keys(STREAMING_MIME));

/**
 * MIME types for embeddable formats (images, PDF) that are small enough to
 * serve as data: URIs and displayed directly by Obsidian's renderer / PDF.js.
 *
 * Exported so FileServer can re-use the same map when it needs to serve a
 * large image or PDF that exceeded the data-URI byte cap.
 */
export const EMBEDDABLE_MIME: Record<string, string> = {
	// ── Images ─────────────────────────────────────────────────────────────
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.gif': 'image/gif',
	'.webp': 'image/webp',
	'.svg': 'image/svg+xml',
	'.bmp': 'image/bmp',
	'.ico': 'image/x-icon',
	'.avif': 'image/avif',
	'.tiff': 'image/tiff',
	'.tif': 'image/tiff',
	// ── Document ───────────────────────────────────────────────────────────
	'.pdf': 'application/pdf',
};

/**
 * Union of STREAMING_MIME and EMBEDDABLE_MIME — every extension the plugin
 * should resolve to a working URL rather than falling through to app://local/.
 */
export const ALL_MEDIA_MIME: Record<string, string> = {
	...STREAMING_MIME,
	...EMBEDDABLE_MIME,
};

// Internal alias kept for tryReadAsDataUri (must not be exported to avoid
// callers accidentally using it instead of ALL_MEDIA_MIME).
const DATA_URI_MIME = EMBEDDABLE_MIME;

/** Default maximum file size that we will read synchronously to produce a data: URI. */
const MAX_SYNC_DATA_URI_BYTES = 10 * 1024 * 1024; // 10 MB

/**
 * Synchronously read a file and return it as a `data:` URI string.
 *
 * Returns `null` when:
 *   - The file extension is not in the allow-list above
 *   - The file is larger than MAX_SYNC_DATA_URI_BYTES
 *   - Any fs error occurs (file missing, permission denied, cloud placeholder, …)
 *
 * This is used by the vault.getResourcePath patch so that images and PDFs
 * in mounted (external) folders can be served in Obsidian's renderer.
 *
 * Background: Modern Obsidian uses `app://<vaultId>/` instead of the
 * previously documented `app://local/` protocol.  The vault-id scheme is
 * restricted to files inside the vault root, so arbitrary external paths
 * resolve to ERR_FILE_NOT_FOUND.  A data: URI is the only reliable,
 * CSP-compliant way to embed external binary assets in the renderer.
 */
export function tryReadAsDataUri(realPath: string, maxBytes = MAX_SYNC_DATA_URI_BYTES): string | null {
	// Node.js APIs unavailable on mobile — all local file reads return null.
	if (!fs || !path) return null;
	const ext = path.extname(realPath).toLowerCase();
	// Video/audio files must stream via FileServer — never serve them as data URIs.
	if (STREAMING_EXTENSIONS.has(ext)) return null;
	const mime = DATA_URI_MIME[ext]; // DATA_URI_MIME === EMBEDDABLE_MIME
	if (!mime) return null;
	try {
		const stat = fs.statSync(realPath);
		if (stat.size > maxBytes) return null;
		const data = fs.readFileSync(realPath);
		return `data:${mime};base64,${data.toString('base64')}`;
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// Windows path utilities
// ---------------------------------------------------------------------------

/**
 * Normalize a path for equality comparison.  On Windows (case-insensitive
 * NTFS) this lowercases the result so that 'C:\Docs' and 'c:\docs' are
 * treated as the same path.  On POSIX systems the case is preserved.
 */
export function normalizeForComparison(p: string): string {
	let n = path.normalize(p);
	// path.normalize preserves trailing separators.  Strip them so that
	// prefix comparisons in SecurityManager.isAllowed() don't produce a
	// double-separator (e.g. "C:\path\" + "\" → "C:\path\\") that never
	// matches child paths.  Preserve the separator for filesystem roots
	// like "C:\" or "/" where it is semantically significant.
	const root = path.parse(n).root;
	if (n !== root && (n.endsWith('/') || n.endsWith('\\'))) {
		n = n.slice(0, -1);
	}
	if (getPlatform() !== 'windows' && path.sep === '\\') {
		n = n.replace(/\\/g, '/');
	}
	return getPlatform() === 'windows' ? n.toLowerCase() : n;
}

/**
 * Returns true for UNC network paths (e.g. `\\server\share`).
 * These start with two backslashes and indicate a network location.
 */
export function isUNCPath(p: string): boolean {
	return p.startsWith('\\\\');
}

/**
 * On Windows, paths longer than 260 characters (MAX_PATH) silently fail
 * unless the path is prefixed with `\\?\` (or `\\?\UNC\` for UNC paths).
 * This helper applies the prefix when needed.  It is a no-op on other
 * platforms, or when the path is already prefixed or short enough.
 */
export function ensureLongPathPrefix(p: string): string {
	if (getPlatform() !== 'windows') return p;
	if (p.startsWith('\\\\?\\')) return p;  // already prefixed
	if (p.length < 260) return p;            // short enough; no prefix needed
	if (isUNCPath(p)) {
		// \\server\share\... → \\?\UNC\server\share\...
		return '\\\\?\\UNC\\' + p.slice(2);
	}
	// C:\... → \\?\C:\...
	return '\\\\?\\' + p;
}

/**
 * Returns true when `name` is a Windows reserved device filename.
 * These names (CON, NUL, COM1-9, LPT1-9, etc.) cannot be used as file or
 * directory names on Windows, even with an extension (e.g. `CON.txt`).
 *
 * Always returns false on non-Windows platforms.
 */
export function isReservedWindowsFilename(name: string): boolean {
	if (getPlatform() !== 'windows') return false;
	const stem = name.split('.')[0];
	return /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(stem);
}

// ---------------------------------------------------------------------------
// WSL (Windows Subsystem for Linux) helpers
// ---------------------------------------------------------------------------

/**
 * Returns true when the current process is running inside WSL (Windows
 * Subsystem for Linux).
 *
 * Detection strategy (in order):
 *  1. `WSL_DISTRO_NAME` env var — set by WSL 2 for the active distro name
 *  2. `WSLENV` env var — set by both WSL 1 and WSL 2 for shared env vars
 *  3. `/proc/version` fallback — reads the kernel version string and checks
 *     for "microsoft" or "wsl" (covers edge cases where env vars are absent)
 *
 * Always returns false on non-Linux platforms.
 */
export function isWSL(): boolean {
	if (getPlatform() !== 'linux') return false;
	const env = (typeof process !== 'undefined' && process.env) ? process.env : {};
	if (env.WSL_DISTRO_NAME || env.WSLENV) return true;
	try {
		const version = fs.readFileSync('/proc/version', 'utf8');
		return /microsoft|wsl/i.test(version);
	} catch {
		return false;
	}
}

/**
 * Convert a WSL drive-mount path like /mnt/c/Users/foo to the equivalent
 * Windows path C:\Users\foo.
 *
 * Only single-letter drive mounts under /mnt are supported (e.g., /mnt/c,
 * /mnt/D).  Paths with multi-letter mount names such as /mnt/cc/path do
 * not match this pattern and will cause the function to return null.
 *
 * Exported for use by future UI features (e.g. auto-converting a WSL path
 * to its Windows-side UNC form when the user is setting up a cross-OS mount).
 */
export function wslMountToWindowsPath(wslPath: string): string | null {
	// Regex intentionally restricts to a single drive letter under /mnt
	// (i.e. /mnt/<drive-letter>[/...]); multi-letter mounts are treated as invalid.
	const match = wslPath.match(/^\/mnt\/([a-zA-Z])(\/.*)?$/);
	if (!match) return null;
	const drive = match[1].toUpperCase();
	const rest = (match[2] ?? '').replace(/\//g, '\\');
	return `${drive}:${rest || '\\'}`;
}

// ---------------------------------------------------------------------------

/**
 * Translate a Node.js filesystem error code into a user-friendly message
 * with platform-appropriate guidance where relevant.
 */
export function translateFsError(err: NodeJS.ErrnoException, op: string): string {
	const p = err.path ? `"${err.path}"` : 'path';
	switch (err.code) {
		case 'EACCES':
			return `Access denied to ${p}. Check folder permissions.`;
		case 'EPERM':
			return getPlatform() === 'windows'
				? `Operation not permitted on ${p}. On Windows, creating symbolic links ` +
				`requires Developer Mode (Settings → System → For Developers) or administrator rights.`
				: `Operation not permitted on ${p}. Check file permissions or ownership.`;
		case 'ENAMETOOLONG':
			return getPlatform() === 'windows'
				? `Path exceeds the Windows 260-character limit. Enable Long Paths in ` +
				`Windows Settings → System → For Developers → Long Paths, or use a shorter path.`
				: `Path name is too long for the filesystem.`;
		case 'EBUSY':
			return `${p} is locked by another process. Close any programs using it and try again.`;
		case 'ENOENT':
			return `${p} was not found. It may have been moved or deleted.`;
		case 'ENOSPC':
			return `Not enough disk space to complete the operation.`;
		case 'EXDEV':
			return `Cross-device move is not supported at the OS level (handled internally by FolderBridge).`;
		default:
			return `${op}: ${err.message}`;
	}
}
