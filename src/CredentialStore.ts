import { getRuntimeRequire } from './runtimeNode';

/**
 * CredentialStore — persist secrets using Electron's safeStorage API.
 *
 * safeStorage uses the OS keychain as the encryption key:
 *   - Windows : DPAPI (user-account bound)
 *   - macOS   : Keychain
 *   - Linux   : libsecret / kwallet
 *
 * Encrypted blobs are device-specific: even if data.json syncs to another
 * device, the value cannot be decrypted there — the OS key differs.
 *
 * Stored format:  "enc:<base64-of-encrypted-buffer>"
 *
 * Mobile fallback: safeStorage is absent on Obsidian Mobile (Capacitor).
 * encryptCredential() returns null; callers should fall back to sessionStorage.
 *
 * Usage (generic):
 *   const blob = encryptCredential(plaintext);        // store in data.json field
 *   const plain = decryptCredential(blob);             // read back at mount time
 *
 * Session helpers (keyed by "<service>-<mountId>"):
 *   saveSessionCredential('webdav', id, password);
 *   loadSessionCredential('webdav', id);
 *   clearSessionCredential('webdav', id);
 */

const PREFIX = 'enc:';
const SESSION_NS = 'folderbridge';

// ---------------------------------------------------------------------------
// Electron safeStorage accessor
// ---------------------------------------------------------------------------

type SafeStorage = {
    isEncryptionAvailable(): boolean;
    encryptString(plainText: string): Buffer;
    decryptString(encrypted: Buffer): string;
};

type ElectronWithSafeStorage = {
    remote?: { safeStorage?: SafeStorage };
    safeStorage?: SafeStorage;
};

function getSafeStorage(): SafeStorage | null {
    try {
        const runtimeRequire = getRuntimeRequire();
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        const electron = runtimeRequire?.('electron') as ElectronWithSafeStorage | undefined;
        // safeStorage lives in the main process; Obsidian re-exports it via remote.
        const ss: SafeStorage | undefined = electron?.remote?.safeStorage ?? electron?.safeStorage;
        return ss ?? null;
    } catch {
        return null;
    }
}

// ---------------------------------------------------------------------------
// Public API — OS keychain
// ---------------------------------------------------------------------------

/**
 * Returns true when OS-level encryption is available on this device.
 * Always false on Obsidian Mobile.
 */
export function isEncryptionAvailable(): boolean {
    try {
        return getSafeStorage()?.isEncryptionAvailable() ?? false;
    } catch {
        return false;
    }
}

/**
 * Encrypt a plaintext credential using the OS keychain.
 *
 * Returns `"enc:<base64>"` on success, or `null` if safeStorage is
 * unavailable (mobile, or OS keychain locked).  The caller should fall
 * back to sessionStorage when null is returned.
 */
export function encryptCredential(plaintext: string): string | null {
    try {
        const ss = getSafeStorage();
        if (!ss?.isEncryptionAvailable()) return null;
        const buf: Buffer = ss.encryptString(plaintext);
        return PREFIX + buf.toString('base64');
    } catch {
        return null;
    }
}

/**
 * Decrypt a value previously produced by encryptCredential().
 *
 * Returns the plaintext credential, or `null` if:
 *   - The value was not produced on this device (wrong OS key)
 *   - safeStorage is unavailable
 *   - The value is malformed / corrupted
 */
export function decryptCredential(encrypted: string): string | null {
    if (!encrypted?.startsWith(PREFIX)) return null;
    try {
        const ss = getSafeStorage();
        if (!ss?.isEncryptionAvailable()) return null;
        const buf = Buffer.from(encrypted.slice(PREFIX.length), 'base64');
        return ss.decryptString(buf);
    } catch {
        return null;
    }
}

// ---------------------------------------------------------------------------
// Backward-compatible aliases (used by existing WebDAV credential calls)
// ---------------------------------------------------------------------------

/** @deprecated Use encryptCredential() instead. */
export const encryptPassword = encryptCredential;
/** @deprecated Use decryptCredential() instead. */
export const decryptPassword = decryptCredential;

// ---------------------------------------------------------------------------
// Public API — sessionStorage (transient, cleared on browser/Obsidian restart)
// ---------------------------------------------------------------------------

/**
 * Persist a credential in sessionStorage under a namespaced key.
 *
 * @param service  Short service name, e.g. 'webdav', 's3', 'sftp'
 * @param mountId  The mount's unique id
 * @param value    The credential to store (e.g. password, secret key)
 */
export function saveSessionCredential(service: string, mountId: string, value: string): void {
    try {
        sessionStorage.setItem(`${SESSION_NS}-${service}-${mountId}`, value);
    } catch { /* sessionStorage unavailable */ }
}

/**
 * Load a credential from sessionStorage. Returns null if not found.
 */
export function loadSessionCredential(service: string, mountId: string): string | null {
    try {
        return sessionStorage.getItem(`${SESSION_NS}-${service}-${mountId}`);
    } catch {
        return null;
    }
}

/**
 * Remove a credential from sessionStorage.
 */
export function clearSessionCredential(service: string, mountId: string): void {
    try {
        sessionStorage.removeItem(`${SESSION_NS}-${service}-${mountId}`);
    } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Convenience wrappers — WebDAV (backward compat with WebDAVAdapter callers)
// ---------------------------------------------------------------------------

/** Save a WebDAV password to sessionStorage. */
export function saveWebDAVPassword(mountId: string, password: string): void {
    saveSessionCredential('webdav', mountId, password);
}

/** Load a WebDAV password from sessionStorage. */
export function loadWebDAVPassword(mountId: string): string | null {
    return loadSessionCredential('webdav', mountId);
}

/** Remove a WebDAV password from sessionStorage. */
export function clearWebDAVPassword(mountId: string): void {
    clearSessionCredential('webdav', mountId);
}
