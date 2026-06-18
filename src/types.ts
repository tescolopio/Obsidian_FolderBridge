/**
 * A single virtual mount point: maps a vault-relative virtual path
 * to an absolute real filesystem path.
 */
export type MountType = 'local' | 'webdav' | 'vault' | 's3' | 'sftp';
export type MountVisibleFileFilter = 'all' | 'markdown-only' | 'pdf-only';

export interface MountPoint {
	id: string;            // Unique identifier (generated at creation)
	virtualPath: string;   // Normalized vault path, e.g. "Projects/Work"
	realPath: string;      // Absolute OS path (local/vault) OR server-relative path (webdav/sftp) OR S3 prefix (s3)
	/**
	 * Alternative path tried automatically when realPath is not accessible.
	 * Useful for cross-platform vaults: set the Windows path as realPath and the
	 * Linux/macOS path here (or vice-versa).  The fallback is tried once at mount
	 * activation; if accessible it is used transparently for all I/O.
	 * A configured fallback also enables the mount on foreign devices without
	 * requiring allowForeignMounts.
	 */
	fallbackRealPath?: string;
	enabled: boolean;      // Whether the mount is currently active
	readOnly: boolean;     // Block all write operations through this mount
	label?: string;        // Optional human-readable display name
	deviceId?: string;     // The device ID that created this mount (for sync compatibility)
	deviceOverrides?: Record<string, string>; // Map of deviceId -> realPath override
	ignoreList?: string[]; // List of file/folder names to ignore for this specific mount
	/** Limits which file types are exposed to Obsidian for this mount. */
	visibleFileFilter?: MountVisibleFileFilter;
	// Per-mount watcher settings (all optional; fall back to built-in defaults)
	watcherDebounceMs?: number;       // Debounce threshold for change events (default 300 ms)
	watcherUsePolling?: boolean;      // Use polling instead of native fs events (for NAS/network drives)
	watcherPollingIntervalMs?: number; // Polling interval in ms (default 2000; only used when usePolling)
	/**
	 * Controls which file types emit a `file-created` vault event when the
	 * file watcher detects a new file in this mount.
	 *
	 * - `'all'`            (default) — all new files are announced to Obsidian.
	 * - `'markdown-only'` — only `.md` / `.canvas` files trigger a vault
	 *   `file-created` event; new images, PDFs, videos, etc. will appear
	 *   after the next manual refresh but will NOT immediately fire
	 *   `vault.on('create', …)`.  Use this on vault mounts to prevent
	 *   third-party attachment-rename plugins from renaming binary files
	 *   they didn't originally manage.
	 */
	watcherCreateFilter?: 'all' | 'markdown-only';
	/**
	 * When `true`, the file watcher for this mount will NEVER dispatch any
	 * vault events (`file-created`, `file-changed`, `file-removed`, …).
	 *
	 * The watcher still runs and monitors the folder — it just silently drops
	 * all events instead of forwarding them to Obsidian.  This prevents
	 * third-party plugins (attachment-rename, note-refactor, etc.) from
	 * reacting to files that arrive via an external sync system.
	 *
	 * Files written by the user inside Obsidian (e.g. paste image from
	 * clipboard) are unaffected: those go through VirtualAdapter and Obsidian
	 * fires its own internal vault events directly — the watcher is bypassed.
	 *
	 * You can also toggle suppression at runtime without touching this setting:
	 *   const fb = app.plugins.getPlugin('folderbridge');
	 *   fb.setWatcherSuppressed('mountId', true);   // mute one mount
	 *   fb.setWatcherSuppressed(null, true);         // mute all mounts
	 *   fb.setWatcherSuppressed(null, false);        // restore all
	 */
	watcherSuppressAllEvents?: boolean;
	maxFiles?: number;                // Cap initial scan at this many files (0 = unlimited)
	// Mount type (defaults to 'local' when absent)
	mountType?: MountType;
	// WebDAV-specific (only set when mountType === 'webdav')
	webdavUrl?: string;               // WebDAV server root URL, e.g. "https://mycloud.com/dav"
	webdavUsername?: string;          // Basic-auth username
	/**
	 * Encrypted password blob produced by encryptCredential().
	 * Stored in data.json but device-specific: the OS keychain is the encryption
	 * key, so the value is useless on any other device even if data.json syncs.
	 * Format: "enc:<base64-of-safeStorage-encrypted-buffer>"
	 */
	encryptedWebdavPassword?: string;
	/** TRANSIENT — never written to data.json.  Carries the password from the
	 *  modal → addMount() / updateMount() so it can be saved to sessionStorage
	 *  under the real (server-assigned) mount id. */
	webdavPassword?: string;

	// S3 / Backblaze B2-specific (only set when mountType === 's3')
	/** S3 bucket name */
	s3Bucket?: string;
	/** AWS region, e.g. "us-east-1". Required for AWS; for B2 use the bucket's region string. */
	s3Region?: string;
	/** Custom S3 endpoint URL. Leave empty for AWS; set to B2 S3-compat endpoint for Backblaze. */
	s3Endpoint?: string;
	/** S3 access key ID (IAM key or B2 application key ID). */
	s3AccessKeyId?: string;
	/** Encrypted S3 secret access key (produced by encryptCredential). */
	encryptedS3SecretKey?: string;
	/** TRANSIENT — carries the raw secret key from the modal to addMount(). Never persisted. */
	s3SecretKey?: string;
	/** Force path-style addressing (required for Backblaze B2 and many self-hosted S3 servers). */
	s3ForcePathStyle?: boolean;

	// SFTP-specific (only set when mountType === 'sftp')
	/** SFTP server hostname or IP address */
	sftpHost?: string;
	/** SFTP port (default 22) */
	sftpPort?: number;
	/** SFTP username */
	sftpUsername?: string;
	/** Encrypted SFTP password (produced by encryptCredential). */
	encryptedSftpPassword?: string;
	/** TRANSIENT — carries the raw password from the modal to addMount(). Never persisted. */
	sftpPassword?: string;
	/** Path to a local private key file for key-based authentication (desktop only). */
	sftpPrivateKeyPath?: string;
	/** Encrypted passphrase for the private key (produced by encryptCredential). */
	encryptedSftpPassphrase?: string;
	/** TRANSIENT — carries the raw passphrase from the modal. Never persisted. */
	sftpPassphrase?: string;
	/** Runtime-only source path when this mount is generated from a TOC config file. */
	tocSourcePath?: string;
}

export interface FolderBridgeSettings {
	mountPoints: MountPoint[];
	allowlist: string[];    // Approved real paths (must match before any I/O)
	managedTocSource: string; // Optional writable TOC file for UI-managed local/vault mounts
	/**
	 * Alternative TOC file path tried when managedTocSource is not accessible.
	 * Useful for cross-platform vaults: set the Windows path as managedTocSource
	 * and the Linux/macOS path here (or vice-versa).
	 */
	managedTocSourceFallback?: string;
	tocSources: string[];   // Absolute paths to JSON config files that define additional mounts
	dryRun: boolean;        // Log writes without executing them
	showStatusBar: boolean;
	mountRootDeletionBehavior: 'ask' | 'unmount' | 'delete';
	deviceId: string;       // Unique ID for this specific device
	allowForeignMounts: boolean; // Allow mounting paths created on other devices
	/** Maximum size (in MB) of files that will be served as data: URIs (images, PDFs). */
	maxDataUriMB: number;
	/**
	 * Patterns applied to EVERY mount, exactly like per-mount ignoreList entries.
	 * Useful for OS noise files: .DS_Store, Thumbs.db, desktop.ini, etc.
	 */
	globalIgnorePatterns: string[];
	/** Set to true after the first-run welcome modal has been shown. */
	hasSeenOnboarding: boolean;
}

export const DEFAULT_SETTINGS: FolderBridgeSettings = {
	mountPoints: [],
	allowlist: [],
	managedTocSource: '',
	managedTocSourceFallback: undefined,
	tocSources: [],
	dryRun: false,
	showStatusBar: true,
	mountRootDeletionBehavior: 'ask',
	deviceId: '',
	allowForeignMounts: false,
	maxDataUriMB: 10,
	globalIgnorePatterns: ['.DS_Store', 'Thumbs.db', 'desktop.ini', '.git'],
	hasSeenOnboarding: false,
};

export interface MountStatus {
	mount: MountPoint;
	reachable: boolean;
	readOnly: boolean;     // true if OS-level or mount-level read-only
	error?: string;
}

export interface TocFileMount {
	id?: string;
	deviceId?: string;
	virtualPath: string;
	realPath: string;
	fallbackRealPath?: string;
	label?: string;
	enabled?: boolean;
	readOnly?: boolean;
	mountType?: 'local' | 'vault';
	ignore?: string[];
	ignoreList?: string[];
	visibleFileFilter?: MountVisibleFileFilter;
	watcherDebounceMs?: number;
	watcherUsePolling?: boolean;
	watcherPollingIntervalMs?: number;
	watcherCreateFilter?: 'all' | 'markdown-only';
	watcherSuppressAllEvents?: boolean;
	maxFiles?: number;
	deviceOverrides?: Record<string, string>;
}

export interface TocFileConfig {
	version?: number | string;
	mounts?: TocFileMount[];
}

export type OSPlatform = 'windows' | 'linux' | 'mac' | 'unknown';
