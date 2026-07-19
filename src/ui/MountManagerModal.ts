import { App, ButtonComponent, Modal, Notice, Platform, Setting, SuggestModal, TFolder, TextComponent, normalizePath } from 'obsidian';
import { MountPoint, MountStatus, MountType } from '../types';
import { SecurityManager } from '../SecurityManager';
import { checkPathAccessible, isDirectory, getPlatform, isWSL } from '../OSHelpers';
import { logger } from '../logger';
import { getRuntimeRequire, loadOptionalNodeModule } from '../runtimeNode';
import { SubmitStateController } from './SubmitStateController';

// Lazy-loaded — unavailable on Obsidian Mobile (Capacitor).
const path: typeof import('path') = loadOptionalNodeModule<typeof import('path')>('path') ?? null as never;

/** Minimal interface for Electron's dialog module. */
interface ElectronDialog {
	showOpenDialog(options: ElectronOpenDialogOptions): Promise<{ canceled: boolean; filePaths: string[] }>;
}

/** Options for Electron's dialog.showOpenDialog. */
interface ElectronOpenDialogOptions {
	properties: string[];
	title?: string;
	defaultPath?: string;
}

// ---------------------------------------------------------------------------
// Electron folder-picker helper
// ---------------------------------------------------------------------------

/**
 * Open the native OS folder-picker dialog via Electron's remote API.
 * Returns the selected absolute path, or null if the user cancelled or the
 * Electron remote API is unavailable in the current host environment.
 */
export async function browseFolderOnDisk(title = 'Select folder', defaultPath?: string): Promise<string | null> {
	try {
		const runtimeRequire = getRuntimeRequire();
		// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
		const electron = runtimeRequire?.('electron');
		const remote = (electron as Record<string, unknown>)?.remote as Record<string, unknown> | undefined;
		// Electron ≥ 14 ships remote via @electron/remote; Obsidian re-exports
		// it on the electron object so both old and new versions work here.
		const dialog: ElectronDialog | undefined = remote?.dialog as ElectronDialog | undefined ?? (electron as Record<string, unknown>)?.dialog as ElectronDialog | undefined;
		if (!dialog?.showOpenDialog) {
			new Notice('Native folder browser is unavailable. Please type the path manually.');
			return null;
		}
		const options: ElectronOpenDialogOptions = {
			properties: ['openDirectory'],
			title,
		};
		if (defaultPath) {
			options.defaultPath = defaultPath;
		}
		const result = await dialog.showOpenDialog(options);
		if (result.canceled || !result.filePaths?.length) return null;
		return result.filePaths[0];
	} catch (err) {
		logger.error('Folder Bridge: Electron dialog error', err);
		new Notice('Native folder browser is unavailable. Please type the path manually.');
		return null;
	}
}

/**
 * Open the native OS folder-picker dialog with multi-selection enabled.
 * Returns the array of selected absolute paths, or null if the user cancelled
 * or the Electron remote API is unavailable.
 */
export async function browseMultipleFoldersOnDisk(title = 'Select folders', defaultPath?: string): Promise<string[] | null> {
	try {
		const runtimeRequire = getRuntimeRequire();
		// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
		const electron = runtimeRequire?.('electron');
		const remote = (electron as Record<string, unknown>)?.remote as Record<string, unknown> | undefined;
		const dialog: ElectronDialog | undefined = remote?.dialog as ElectronDialog | undefined ?? (electron as Record<string, unknown>)?.dialog as ElectronDialog | undefined;
		if (!dialog?.showOpenDialog) {
			new Notice('Native folder browser is unavailable. Please type the path manually.');
			return null;
		}
		const options: ElectronOpenDialogOptions = {
			properties: ['openDirectory', 'multiSelections'],
			title,
		};
		if (defaultPath) {
			options.defaultPath = defaultPath;
		}
		const result = await dialog.showOpenDialog(options);
		if (result.canceled || !result.filePaths?.length) return null;
		return result.filePaths;
	} catch (err) {
		logger.error('Folder Bridge: Electron dialog error', err);
		new Notice('Native folder browser is unavailable. Please type the path manually.');
		return null;
	}
}

// ---------------------------------------------------------------------------
// Vault folder picker modal
// ---------------------------------------------------------------------------

/**
 * A fuzzy-search modal that lists all TFolder nodes currently loaded in the
 * vault.  Used so the user can browse the vault hierarchy when choosing a
 * virtual parent path, rather than having to type it from memory.
 */
export class VaultFolderPickerModal extends SuggestModal<string> {
	private onChoose: (folderPath: string) => void | Promise<void>;
	private folders: string[];

	constructor(app: App, onChoose: (folderPath: string) => void | Promise<void>) {
		super(app);
		this.onChoose = onChoose;
		this.setPlaceholder('Type to search vault folders… (leave blank for vault root)');
		// Build the folder list once so getSuggestions only filters, never enumerates
		this.folders = app.vault.getAllLoadedFiles()
			.filter((f): f is TFolder => f instanceof TFolder && f.path.length > 0)
			.map(f => f.path);
	}

	getSuggestions(query: string): string[] {
		const q = query.toLowerCase();
		const results: string[] = [];

		// Always offer the root as first option
		if (!q || '(vault root)'.includes(q)) {
			results.push('(vault root)');
		}

		for (const p of this.folders) {
			if (!q || p.toLowerCase().includes(q)) {
				results.push(p);
			}
		}
		return results;
	}

	renderSuggestion(item: string, el: HTMLElement): void {
		const container = el.createEl('div', { cls: 'vault-folder-suggestion' });

		if (item === '(vault root)') {
			container.addClass('vault-folder-suggestion-root');
			container.createSpan({ text: item, cls: 'vault-folder-suggestion-label' });
		} else {
			container.createSpan({ text: item, cls: 'vault-folder-suggestion-label' });
		}
	}

	onChooseSuggestion(item: string): void {
		void Promise.resolve(this.onChoose(item === '(vault root)' ? '' : item)).catch(error => {
			logger.error('Folder Bridge: Vault folder picker callback failed', error);
		});
	}
}

// ---------------------------------------------------------------------------
// Callback type
// ---------------------------------------------------------------------------

/** Callback invoked by the modal when the user successfully validates a mount. */
export type OnMountSave = (mount: Omit<MountPoint, 'id'>, editId?: string) => Promise<void>;
type MountManagerInitialValues = Partial<Pick<MountPoint, 'mountType' | 'virtualPath' | 'realPath' | 'label' | 'readOnly'>>;

// ---------------------------------------------------------------------------
// MountManagerModal
// ---------------------------------------------------------------------------

/**
 * MountManagerModal lets the user configure a new mount point:
 *
 *  1. Real path  – absolute OS path, with a native "Browse…" folder picker
 *  2. Virtual path – vault-relative path, with a "Browse vault…" picker that
 *     shows existing vault folders for easy nesting
 *  3. Use folder name as label – auto-fills the label from the real path's
 *     base name whenever the real path changes (can still be overridden)
 *  4. Label – optional display name shown in settings instead of the path
 *  5. Read-only – block all writes through this mount
 */
export class MountManagerModal extends Modal {
	private pluginName: string;
	private onSave: OnMountSave;
	private security: SecurityManager;
	private editMount: MountPoint | undefined;

	// ── Form state ──────────────────────────────────────────────────────────
	private mountType: MountType = 'local';
	private virtualPath = '';
	private realPath = '';
	private readOnly = false;
	private label = '';
	private useFolderNameAsLabel = false;
	// WebDAV fields (password never persisted to data.json)
	private webdavUrl = '';
	private webdavUsername = '';
	private webdavPassword = '';
	// S3 / Backblaze B2 fields
	private s3Bucket = '';
	private s3Region = '';
	private s3Endpoint = '';
	private s3AccessKeyId = '';
	private s3SecretKey = '';
	private s3ForcePathStyle = false;
	private s3Prefix = '/';
	// SFTP fields
	private sftpHost = '';
	private sftpPort = 22;
	private sftpUsername = '';
	private sftpPassword = '';
	private sftpPrivateKeyPath = '';
	private sftpPassphrase = '';
	// Advanced (per-mount watcher + performance)
	private watcherDebounceMs: number | undefined = undefined;
	private watcherUsePolling = false;
	private watcherPollingIntervalMs: number | undefined = undefined;
	private visibleFileFilter: 'all' | 'markdown-only' | 'pdf-only' = 'all';
	private watcherCreateFilter: 'all' | 'markdown-only' = 'all';
	private watcherSuppressAllEvents = false;
	private maxFiles: number | undefined = undefined;

	// ── Component references for programmatic updates ────────────────────────
	private virtualPathText: TextComponent | null = null;
	private realPathText: TextComponent | null = null;
	private labelText: TextComponent | null = null;
	private saveButton: ButtonComponent | null = null;
	private cancelButton: ButtonComponent | null = null;
	private readonly submitState: SubmitStateController;

	constructor(
		app: App,
		pluginName: string,
		security: SecurityManager,
		onSave: OnMountSave,
		editMount?: MountPoint,
		initialValues?: MountManagerInitialValues,
	) {
		super(app);
		this.pluginName = pluginName;
		this.security = security;
		this.onSave = onSave;
		this.editMount = editMount;
		this.submitState = new SubmitStateController(
			editMount ? 'Save changes' : 'Validate and add',
			editMount ? 'Saving...' : 'Adding...',
		);
		// Pre-populate state from existing mount
		if (editMount) {
			this.mountType = editMount.mountType ?? 'local';
			this.virtualPath = editMount.virtualPath;
			this.realPath = editMount.realPath;
			this.readOnly = editMount.readOnly;
			this.label = editMount.label ?? '';
			// WebDAV
			this.webdavUrl = editMount.webdavUrl ?? '';
			this.webdavUsername = editMount.webdavUsername ?? '';
			// Password is never stored — leave blank; user re-enters to change
			// S3
			this.s3Bucket = editMount.s3Bucket ?? '';
			this.s3Region = editMount.s3Region ?? '';
			this.s3Endpoint = editMount.s3Endpoint ?? '';
			this.s3AccessKeyId = editMount.s3AccessKeyId ?? '';
			this.s3ForcePathStyle = editMount.s3ForcePathStyle ?? false;
			this.s3Prefix = editMount.realPath || '/';
			// SFTP
			this.sftpHost = editMount.sftpHost ?? '';
			this.sftpPort = editMount.sftpPort ?? 22;
			this.sftpUsername = editMount.sftpUsername ?? '';
			this.sftpPrivateKeyPath = editMount.sftpPrivateKeyPath ?? '';
			// Passwords/passphrases never stored — leave blank
			// Advanced watcher
			this.watcherDebounceMs = editMount.watcherDebounceMs;
			this.watcherUsePolling = editMount.watcherUsePolling ?? false;
			this.watcherPollingIntervalMs = editMount.watcherPollingIntervalMs;
			this.visibleFileFilter = editMount.visibleFileFilter ?? 'all';
			this.watcherCreateFilter = editMount.watcherCreateFilter ?? 'all';
			this.watcherSuppressAllEvents = editMount.watcherSuppressAllEvents ?? false;
			this.maxFiles = editMount.maxFiles;
		} else if (initialValues) {
			this.mountType = initialValues.mountType ?? this.mountType;
			this.virtualPath = initialValues.virtualPath ?? this.virtualPath;
			this.realPath = initialValues.realPath ?? this.realPath;
			this.readOnly = initialValues.readOnly ?? this.readOnly;
			this.label = initialValues.label ?? this.label;
		}
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		const ownCloud = 'ownCloud';
		const backblazeB2 = 'Backblaze B2';
		const minio = 'MinIO';
		const cloudflareR2 = 'Cloudflare R2';
		const synologyLabel = 'Synology NAS (DSM WebDAV)';
		const qnapLabel = 'QNAP NAS';
		const webdav = 'WebDAV';
		const obsidianDesktop = 'Obsidian Desktop';
		const wslLabel = 'WSL';
		const iam = 'IAM';
		const aws = 'AWS';
		const b2 = 'B2';
		const nas = 'NAS';
		contentEl.createEl('h2', { text: this.editMount ? 'Edit mount point' : 'Add mount point' });

		const isMobile = Platform.isMobile;
		const platform = getPlatform();
		const wsl = isWSL();

		// On mobile, only WebDAV mounts are supported (no local fs access).
		if (isMobile && this.mountType !== 'webdav') {
			this.mountType = 'webdav';
		}

		// ── Mount type selector ─────────────────────────────────────────────
		const localSection = contentEl.createDiv();
		const vaultSection = contentEl.createDiv();
		const webdavSection = contentEl.createDiv();
		const s3Section = contentEl.createDiv();
		const sftpSection = contentEl.createDiv();

		const toggleSections = (type: MountType) => {
			this.mountType = type;
			localSection.toggleClass('folderbridge-hidden', type !== 'local');
			vaultSection.toggleClass('folderbridge-hidden', type !== 'vault');
			webdavSection.toggleClass('folderbridge-hidden', type !== 'webdav');
			s3Section.toggleClass('folderbridge-hidden', type !== 's3');
			sftpSection.toggleClass('folderbridge-hidden', type !== 'sftp');
		};

		if (isMobile) {
			// On mobile, only WebDAV and S3 mounts are supported
			contentEl.createEl('p', {
				text: `On mobile, only ${webdav} and S3 mounts are supported. Local filesystem, vault, and SFTP mounts require ${obsidianDesktop}.`,
				cls: 'setting-item-description',
			});
			contentEl.createEl('p', {
				text: 'To access local files on this device, install a WebDAV server app (e.g. CX File Explorer) and connect to http://localhost:PORT/',
				cls: 'setting-item-description',
			});
			new Setting(contentEl)
				.setName('Mount type')
				.addDropdown(drop => drop
					.addOption('webdav', `${webdav} (Nextcloud, ${ownCloud}, generic)`)
					.addOption('s3', `Amazon S3 / ${backblazeB2}`)
					.setValue(this.mountType === 's3' ? 's3' : 'webdav')
					.onChange(val => toggleSections(val as MountType)));
			toggleSections(this.mountType === 's3' ? 's3' : 'webdav');
		} else {
			new Setting(contentEl)
				.setName('Mount type')
				.setDesc('Choose the storage backend for this mount point')
				.addDropdown(drop => drop
					.addOption('local', 'Local filesystem')
					.addOption('vault', 'Another Obsidian vault')
					.addOption('webdav', `${webdav} (Nextcloud, generic)`)
					.addOption('s3', `Amazon S3 / ${backblazeB2}`)
					.addOption('sftp', 'SFTP (SSH file transfer)')
					.setValue(this.mountType)
					.onChange(val => toggleSections(val as MountType)));
			toggleSections(this.mountType);
		} // end else (desktop only)

		// ── Vault section (shown when type === 'vault') ────────────────────
		vaultSection.createEl('p', {
			text: 'Bridge to another Obsidian vault on this device. The vault\'s configuration folder (configDir) and .trash are automatically excluded. ' +
				'Notes and attachments from the other vault appear as regular files in your current vault.',
			cls: 'setting-item-description',
		});
		vaultSection.addClass('folderbridge-vault-section');

		let vaultPathText: TextComponent | null = null;
		new Setting(vaultSection)
			.setName('Other vault root folder')
			.setDesc('Absolute path to the root of the other Obsidian vault')
			.addText(text => {
				vaultPathText = text;
				text.inputEl.addClass('folderbridge-input-flex');
				text.setPlaceholder(platform === 'windows' ? 'C:\\Users\\YourName\\MyOtherVault' : '/home/yourname/MyOtherVault')
					.setValue(this.mountType === 'vault' ? this.realPath : '')
					.onChange(val => {
						this.realPath = val.trim();
						this.syncAutoLabel();
					});
			})
			.addButton(btn => {
				btn.setButtonText('Browse…')
					.setTooltip('Open the system folder picker')
					.onClick(() => {
						void (async () => {
							const selected = await browseFolderOnDisk('Select other vault root');
							if (selected) {
								this.realPath = selected;
								vaultPathText?.setValue(selected);
								this.syncAutoLabel();
							}
						})();
					});
			});

		// ── WebDAV fields (shown when type === 'webdav') ───────────────────

		/* Quick-fill presets — selecting one pre-populates Server URL so users
		 * don't have to remember the /remote.php/dav/files/USERNAME/ pattern. */
		const WEBDAV_PRESETS: Record<string, { urlTemplate: string; note: string }> = {
			nextcloud: { urlTemplate: 'https://cloud.example.com/remote.php/dav/files/YOUR_USERNAME', note: 'Replace cloud.example.com and YOUR_USERNAME with your values.' },
			owncloud: { urlTemplate: 'https://cloud.example.com/remote.php/dav/files/YOUR_USERNAME', note: 'Replace cloud.example.com and YOUR_USERNAME with your values.' },
			synology: { urlTemplate: 'https://nas.example.com/webdav', note: 'Enable WebDAV in Synology Control Panel → File Services → WebDAV.' },
			qnap: { urlTemplate: 'https://nas.example.com:8080/webdav', note: 'Enable WebDAV in QNAP Control Panel → Web Server → WebDAV Server.' },
		};

		let presetNoteEl: HTMLParagraphElement | null = null;
		let webdavUrlText: import('obsidian').TextComponent | null = null;

		if (!this.editMount) {
			new Setting(webdavSection)
				.setName('Quick-fill preset')
				.setDesc('Optionally choose your service to pre-fill the server URL field below.')
				.addDropdown(drop => {
					drop.addOption('', '— select a preset —');
					drop.addOption('nextcloud', 'Nextcloud');
					drop.addOption('owncloud', `${ownCloud}`);
					drop.addOption('synology', `${synologyLabel}`);
					drop.addOption('qnap', `${qnapLabel}`);
					drop.setValue('');
					drop.onChange(val => {
						const preset = WEBDAV_PRESETS[val];
						if (!preset) return;
						if (webdavUrlText) {
							webdavUrlText.setValue(preset.urlTemplate);
							this.webdavUrl = preset.urlTemplate;
						}
						if (!presetNoteEl) {
							presetNoteEl = webdavSection.createEl('p', { cls: 'folderbridge-preset-note' });
						}
						presetNoteEl.setText('💡 ' + preset.note);
					});
				});
		}

		new Setting(webdavSection)
			.setName(`${webdav} server URL`)
			.setDesc('Full URL to the WebDAV endpoint, e.g. https://cloud.example.com/remote.php/dav/files/username')
			.addText(text => {
				webdavUrlText = text;
				text.inputEl.addClass('folderbridge-input-flex');
				text.setPlaceholder('https://cloud.example.com/remote.php/dav/files/username')
					.setValue(this.webdavUrl)
					.onChange(val => { this.webdavUrl = val.trim(); });
			});

		new Setting(webdavSection)
			.setName('Remote base path')
			.setDesc('Path on the WebDAV server to use as the mount root, e.g. / or /Documents. Use / for the server root.')
			.addText(text => {
				text.inputEl.addClass('folderbridge-input-flex');
				text.setPlaceholder('/')
					.setValue(this.mountType === 'webdav' ? (this.realPath || '/') : '/')
					.onChange(val => { this.realPath = val.trim() || '/'; });
			});

		new Setting(webdavSection)
			.setName('Username')
			.addText(text => {
				text.inputEl.addClass('folderbridge-input-flex');
				text.setPlaceholder('Your-username')
					.setValue(this.webdavUsername)
					.onChange(val => { this.webdavUsername = val.trim(); });
			});

		new Setting(webdavSection)
			.setName('Password')
			.setDesc(this.editMount?.mountType === 'webdav'
				? (this.editMount.encryptedWebdavPassword
					? 'Saved securely on this device. Leave blank to keep, or enter a new value to replace.'
					: 'Leave blank to keep the existing password. Enter a new value to replace it.')
				: 'Encrypted and saved on this device — survives Obsidian restarts.')
			.addText(text => {
				text.inputEl.type = 'password';
				text.inputEl.addClass('folderbridge-input-flex');
				const hasStored = !!(this.editMount?.encryptedWebdavPassword);
				text.setPlaceholder(hasStored ? '(saved — leave blank to keep)' : this.editMount?.mountType === 'webdav' ? '(unchanged)' : 'password')
					.setValue('')
					.onChange(val => { this.webdavPassword = val; });
			});

		// ── S3 / Backblaze B2 section ──────────────────────────────────────
		s3Section.createEl('p', {
			text: 'Mount an Amazon S3 bucket or a Backblaze B2 bucket via the S3-compatible API. ' +
				'Files appear as regular notes in your vault. Note: S3 has no native folder rename — ' +
				'renames are implemented as copy + delete, which may be slow for large directories.',
			cls: 'setting-item-description',
		});

		const S3_PRESETS: Record<string, { region: string; endpoint: string; forcePathStyle: boolean; note: string }> = {
			aws: { region: 'us-east-1', endpoint: '', forcePathStyle: false, note: 'Use an IAM user with S3 read/write permissions. Access key ID + secret access key.' },
			b2: { region: 'us-west-004', endpoint: 'https://s3.us-west-004.backblazeb2.com', forcePathStyle: true, note: 'Use a Backblaze Application Key with read/write access to your bucket. Set endpoint to your bucket region.' },
			minio: { region: 'us-east-1', endpoint: 'http://localhost:9000', forcePathStyle: true, note: 'Self-hosted MinIO. Path-style is required. Set endpoint to your MinIO URL.' },
			cloudflare: { region: 'auto', endpoint: 'https://<ACCOUNT_ID>.r2.cloudflarestorage.com', forcePathStyle: false, note: 'Cloudflare R2. Replace <ACCOUNT_ID> with your Cloudflare account ID.' },
		};

		let s3PresetNoteEl: HTMLParagraphElement | null = null;
		let s3RegionText: import('obsidian').TextComponent | null = null;
		let s3EndpointText: import('obsidian').TextComponent | null = null;
		let s3PathStyleToggle: import('obsidian').ToggleComponent | null = null;

		if (!this.editMount) {
			new Setting(s3Section)
				.setName('Quick-fill preset')
				.setDesc('Choose your S3-compatible service to pre-fill fields below.')
				.addDropdown(drop => {
					drop.addOption('', '— select a preset —');
					drop.addOption('aws', 'Amazon S3');
					drop.addOption('b2', `${backblazeB2}`);
					drop.addOption('minio', `${minio} (self-hosted)`);
					drop.addOption('cloudflare', `${cloudflareR2}`);
					drop.setValue('');
					drop.onChange(val => {
						const preset = S3_PRESETS[val];
						if (!preset) return;
						this.s3Region = preset.region;
						this.s3Endpoint = preset.endpoint;
						this.s3ForcePathStyle = preset.forcePathStyle;
						s3RegionText?.setValue(preset.region);
						s3EndpointText?.setValue(preset.endpoint);
						s3PathStyleToggle?.setValue(preset.forcePathStyle);
						if (!s3PresetNoteEl) {
							s3PresetNoteEl = s3Section.createEl('p', { cls: 'folderbridge-preset-note' });
						}
						s3PresetNoteEl.setText(preset.note);
					});
				});
		}

		new Setting(s3Section)
			.setName('Bucket name')
			.setDesc(`The S3 bucket or ${b2} bucket name (case-sensitive)`)
			.addText(text => {
				text.inputEl.addClass('folderbridge-input-flex');
				text.setPlaceholder('My-Obsidian-bucket')
					.setValue(this.s3Bucket)
					.onChange(val => { this.s3Bucket = val.trim(); });
			});

		new Setting(s3Section)
			.setName('Region')
			.setDesc(`${aws} region (for example us-east-1) or ${b2} region string (for example us-west-004)`)
			.addText(text => {
				s3RegionText = text;
				text.inputEl.addClass('folderbridge-input-flex');
				text.setPlaceholder('Us-east-1')
					.setValue(this.s3Region)
					.onChange(val => { this.s3Region = val.trim(); });
			});

		new Setting(s3Section)
			.setName('Custom endpoint URL (optional)')
			.setDesc('Leave empty for AWS S3. For Backblaze B2 set to your region endpoint, e.g. https://s3.us-west-004.backblazeb2.com')
			.addText(text => {
				s3EndpointText = text;
				text.inputEl.addClass('folderbridge-input-flex');
				text.setPlaceholder('https://s3.us-west-004.backblazeb2.com  (leave blank for AWS)')
					.setValue(this.s3Endpoint)
					.onChange(val => { this.s3Endpoint = val.trim(); });
			});

		new Setting(s3Section)
			.setName('Key prefix / path')
			.setDesc('Optional folder prefix inside the bucket to use as the mount root, e.g. / for bucket root or /notes/ for a sub-folder.')
			.addText(text => {
				text.inputEl.addClass('folderbridge-input-flex');
				text.setPlaceholder('/')
					.setValue(this.s3Prefix)
					.onChange(val => { this.s3Prefix = val.trim() || '/'; });
			});

		new Setting(s3Section)
			.setName('Access key ID')
			.setDesc(`${iam} access key ID (${aws}) or application key ID (${backblazeB2})`)
			.addText(text => {
				text.inputEl.addClass('folderbridge-input-flex');
				text.setPlaceholder('AKIAIOSFODNN7EXAMPLE')
					.setValue(this.s3AccessKeyId)
					.onChange(val => { this.s3AccessKeyId = val.trim(); });
			});

		new Setting(s3Section)
			.setName('Secret access key')
			.setDesc(this.editMount?.mountType === 's3'
				? (this.editMount.encryptedS3SecretKey
					? 'Saved securely on this device. Leave blank to keep, or enter a new value to replace.'
					: 'Leave blank to keep the existing key. Enter a new value to replace it.')
				: 'Encrypted and saved on this device — survives Obsidian restarts.')
			.addText(text => {
				text.inputEl.type = 'password';
				text.inputEl.addClass('folderbridge-input-flex');
				const hasStored = !!(this.editMount?.encryptedS3SecretKey);
				text.setPlaceholder(hasStored ? '(saved — leave blank to keep)' : 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY')
					.setValue('')
					.onChange(val => { this.s3SecretKey = val; });
			});

		new Setting(s3Section)
			.setName('Force path-style addressing')
			.setDesc(`Required for ${backblazeB2}, ${minio}, and most self-hosted S3 servers. Leave off for Amazon S3 and ${cloudflareR2}.`)
			.addToggle(toggle => {
				s3PathStyleToggle = toggle;
				toggle.setValue(this.s3ForcePathStyle)
					.onChange(val => { this.s3ForcePathStyle = val; });
			});

		// ── SFTP section ────────────────────────────────────────────────
		sftpSection.createEl('p', {
			text: 'Mount a remote directory over SSH/SFTP. Requires a network connection. ' +
				'The remote server must have an SFTP subsystem enabled (standard on OpenSSH). ' +
				'SFTP mounts are desktop-only.',
			cls: 'setting-item-description',
		});

		new Setting(sftpSection)
			.setName('Host')
			.setDesc('Hostname or IP address of the SFTP server')
			.addText(text => {
				text.inputEl.addClass('folderbridge-input-flex');
				text.setPlaceholder('Files.example.com')
					.setValue(this.sftpHost)
					.onChange(val => { this.sftpHost = val.trim(); });
			});

		new Setting(sftpSection)
			.setName('Port')
			.setDesc('SSH port (default 22)')
			.addText(text => {
				text.inputEl.type = 'number';
				text.inputEl.addClass('folderbridge-input-narrow');
				text.setPlaceholder('22')
					.setValue(String(this.sftpPort))
					.onChange(val => {
						const n = parseInt(val, 10);
						this.sftpPort = isNaN(n) || n <= 0 ? 22 : n;
					});
			});

		new Setting(sftpSection)
			.setName('Username')
			.addText(text => {
				text.inputEl.addClass('folderbridge-input-flex');
				text.setPlaceholder('Alice')
					.setValue(this.sftpUsername)
					.onChange(val => { this.sftpUsername = val.trim(); });
			});

		new Setting(sftpSection)
			.setName('Remote base path')
			.setDesc('Absolute path on the remote server to use as the mount root, e.g. /home/alice/notes')
			.addText(text => {
				text.inputEl.addClass('folderbridge-input-flex');
				text.setPlaceholder('/home/alice/notes')
					.setValue(this.mountType === 'sftp' ? (this.realPath || '/home') : '/home')
					.onChange(val => { this.realPath = val.trim() || '/'; });
			});

		new Setting(sftpSection)
			.setName('Password')
			.setDesc(this.editMount?.mountType === 'sftp'
				? (this.editMount.encryptedSftpPassword
					? 'Saved securely on this device. Leave blank to keep, or enter a new value to replace.'
					: 'Leave blank to keep the existing password.')
				: 'Used for password authentication. Leave blank if using a private key below.')
			.addText(text => {
				text.inputEl.type = 'password';
				text.inputEl.addClass('folderbridge-input-flex');
				const hasStored = !!(this.editMount?.encryptedSftpPassword);
				text.setPlaceholder(hasStored ? '(saved — leave blank to keep)' : 'password (or leave blank for key auth)')
					.setValue('')
					.onChange(val => { this.sftpPassword = val; });
			});

		new Setting(sftpSection)
			.setName('Private key file path (optional)')
			.setDesc('Absolute path to your SSH private key file on this device, e.g. /home/alice/.ssh/id_ed25519. Leave blank for password auth.')
			.addText(text => {
				text.inputEl.addClass('folderbridge-input-flex');
				text.setPlaceholder('/home/yourname/.ssh/id_ed25519')
					.setValue(this.sftpPrivateKeyPath)
					.onChange(val => { this.sftpPrivateKeyPath = val.trim(); });
			});

		new Setting(sftpSection)
			.setName('Private key passphrase (optional)')
			.setDesc(this.editMount?.mountType === 'sftp'
				? (this.editMount.encryptedSftpPassphrase
					? 'Saved securely on this device. Leave blank to keep.'
					: 'Leave blank to keep the existing passphrase.')
				: 'Only needed if your private key is passphrase-protected.')
			.addText(text => {
				text.inputEl.type = 'password';
				text.inputEl.addClass('folderbridge-input-flex');
				const hasStored = !!(this.editMount?.encryptedSftpPassphrase);
				text.setPlaceholder(hasStored ? '(saved — leave blank to keep)' : 'passphrase (if key is encrypted)')
					.setValue('')
					.onChange(val => { this.sftpPassphrase = val; });
			});

		// Apply initial visibility
		toggleSections(this.mountType);

		// Choose a platform-appropriate placeholder for the real path
		let realPlaceholder: string;
		if (platform === 'windows') {
			realPlaceholder = 'C:\\Users\\YourName\\Documents\\Work';
		} else if (wsl) {
			realPlaceholder = '/home/yourname/docs   or   /mnt/c/Users/YourName/docs';
		} else {
			realPlaceholder = '/home/yourname/Documents/Work';
		}

		// ── Real path ──────────────────────────────────────────────────────
		const realPathSetting = new Setting(localSection)
			.setName('Real path (on disk)')
			.setDesc('Absolute path to the external folder you want to mount')
			.addText(text => {
				this.realPathText = text;
				text.inputEl.addClass('folderbridge-input-flex');
				text.setPlaceholder(realPlaceholder)
					.setValue(this.realPath)
					.onChange(val => {
						this.realPath = val.trim();
						this.syncAutoLabel();
					});
			})
			.addButton(btn => {
				btn.setButtonText('Browse…')
					.setTooltip('Open the system folder picker')
					.onClick(() => {
						void (async () => {
							const selected = await browseFolderOnDisk('Select external folder');
							if (selected) {
								this.realPath = selected;
								this.realPathText?.setValue(selected);
								this.syncAutoLabel();
							}
						})();
					});
				btn.buttonEl.setAttribute('aria-label', 'Browse for folder on disk');
			});

		if (platform === 'windows') {
			realPathSetting.addButton(btn => {
				btn.setButtonText(`Browse ${wslLabel}…`)
					.setTooltip(`Open the system folder picker directly to your ${wslLabel} Linux distributions`)
					.onClick(() => {
						void (async () => {
							const selected = await browseFolderOnDisk('Select WSL folder', '\\\\wsl.localhost');
							if (selected) {
								this.realPath = selected;
								this.realPathText?.setValue(selected);
								this.syncAutoLabel();
							}
						})();
					});
				btn.buttonEl.setAttribute('aria-label', `Browse for ${wslLabel} folder`);
			});
		}

		// WSL context hints
		if (platform === 'windows') {
			localSection.createEl('p', {
				text: 'WSL tip: To mount a Linux (WSL 2) folder in Windows Obsidian, use ' +
					'\\\\wsl.localhost\\<Distro>\\path (Windows 11 / Win 10 21H1+) ' +
					'or \\\\wsl$\\<Distro>\\path (older Windows 10). ' +
					'You can type either path in the browse dialog address bar.',
				cls: 'setting-item-description',
			});
		} else if (wsl) {
			localSection.createEl('p', {
				text: 'WSL tip: Windows drives are accessible at /mnt/c/, /mnt/d/, etc. ' +
					'To let Windows-side Obsidian see this folder, use ' +
					'\\\\wsl.localhost\\<Distro>\\path (Windows 11 / Win 10 21H1+) ' +
					'or \\\\wsl$\\<Distro>\\path (older Windows 10).',
				cls: 'setting-item-description',
			});
		}

		// ── Virtual path ───────────────────────────────────────────────────
		new Setting(contentEl)
			.setName('Virtual path (in vault)')
			.setDesc(
				'Where this folder will appear inside your vault, e.g. "Projects/Work". ' +
				'Use "Browse vault…" to pick an existing vault folder as the parent, ' +
				'then refine the leaf name. Leave empty to use the real folder\'s name at the vault root.'
			)
			.addText(text => {
				this.virtualPathText = text;
				text.inputEl.addClass('folderbridge-input-flex');
				text.setPlaceholder('Projects/work')
					.setValue(this.virtualPath)
					.onChange(val => { this.virtualPath = val.trim(); });
			})
			.addButton(btn => {
				btn.setButtonText('Browse vault…')
					.setTooltip('Pick an existing vault folder as the parent directory')
					.onClick(() => {
						new VaultFolderPickerModal(this.app, (chosen) => {
							// `chosen` is '' for vault root, or an existing folder path.
							// Preserve any leaf name the user already typed; if empty,
							// default to the real folder's base name.
							const trimmedVirtualPath = this.virtualPath.trim();
							const existingLeaf = trimmedVirtualPath
								? path.posix.basename(trimmedVirtualPath)
								: '';
							const leaf = existingLeaf || (this.realPath ? path.basename(this.realPath) : '');
							const combined = chosen
								? normalizePath(`${chosen}/${leaf}`)
								: leaf;
							this.virtualPath = combined;
							this.virtualPathText?.setValue(combined);
						}).open();
					});
				btn.buttonEl.setAttribute('aria-label', 'Browse vault folders');
			});

		// ── Use folder name as label ───────────────────────────────────────
		new Setting(contentEl)
			.setName('Use folder name as label')
			.setDesc(
				'Automatically fill the label below with the real folder\'s name. ' +
				'The label is what appears in the settings panel instead of the full path.'
			)
			.addToggle(toggle => toggle
				.setValue(false)
				.onChange(val => {
					this.useFolderNameAsLabel = val;
					// Only auto-fill when enabling the toggle and the label is currently empty
					if (val) {
						const currentLabel =
							(this.labelText?.getValue?.() ?? this.label ?? '').trim();
						if (!currentLabel) {
							this.syncAutoLabel();
						}
					}
				}));

		// ── Label ──────────────────────────────────────────────────────────
		new Setting(contentEl)
			.setName('Label (optional)')
			.setDesc('Display name shown in the settings panel instead of the virtual path')
			.addText(text => {
				this.labelText = text;
				text.setPlaceholder('My work documents')
					.setValue(this.label)
					.onChange(val => { this.label = val.trim(); });
			});

		// ── Read-only ──────────────────────────────────────────────────────
		new Setting(contentEl)
			.setName('Read-only')
			.setDesc(`When enabled, ${this.pluginName} will refuse any write operations to this mount`)
			.addToggle(toggle => toggle
				.setValue(this.readOnly)
				.onChange(val => { this.readOnly = val; }));
		// ── Advanced (collapsible) ─────────────────────────────────────────────
		const details = contentEl.createEl('details', { cls: 'folderbridge-advanced' });
		// File-watcher settings are desktop-only; hide the entire Advanced section on mobile.
		if (isMobile) details.addClass('folderbridge-hidden');
		details.createEl('summary', { text: 'Advanced settings' });

		const advancedContainer = details.createDiv();

		new Setting(advancedContainer)
			.setName('Debounce threshold (ms)')
			.setDesc('How long to wait after the last change event before notifying Obsidian. Increase for editors that save very frequently. (default: 300)')
			.addText(text => {
				text.inputEl.type = 'number';
				text.inputEl.min = '50';
				text.inputEl.max = '5000';
				text.inputEl.addClass('folderbridge-input-narrow');
				text.setPlaceholder('300')
					.setValue(this.watcherDebounceMs != null ? String(this.watcherDebounceMs) : '')
					.onChange(val => {
						const n = parseInt(val, 10);
						this.watcherDebounceMs = isNaN(n) || n <= 0 ? undefined : Math.min(5000, Math.max(50, n));
					});
			});

		let pollingIntervalSetting: Setting | null = null;

		const showHidePollingInterval = (show: boolean) => {
			if (pollingIntervalSetting) {
				pollingIntervalSetting.settingEl.classList.toggle('folderbridge-hidden', !show);
			}
		};

		new Setting(advancedContainer)
			.setName('Use polling')
			.setDesc(`Poll for changes instead of native OS events. Required for ${nas} drives and network shares where native filesystem events are unreliable.`)
			.addToggle(toggle => toggle
				.setValue(this.watcherUsePolling)
				.onChange(val => {
					this.watcherUsePolling = val;
					showHidePollingInterval(val);
				}));

		pollingIntervalSetting = new Setting(advancedContainer)
			.setName('Polling interval (ms)')
			.setDesc('How often to poll the filesystem for changes. Only effective when "use polling" is on. (default: 2000)')
			.addText(text => {
				text.inputEl.type = 'number';
				text.inputEl.min = '500';
				text.inputEl.max = '60000';
				text.inputEl.addClass('folderbridge-input-narrow');
				text.setPlaceholder('2000')
					.setValue(this.watcherPollingIntervalMs != null ? String(this.watcherPollingIntervalMs) : '')
					.onChange(val => {
						const n = parseInt(val, 10);
						this.watcherPollingIntervalMs = isNaN(n) || n <= 0 ? undefined : Math.min(60000, Math.max(500, n));
					});
			});
		showHidePollingInterval(this.watcherUsePolling);

		new Setting(advancedContainer)
			.setName('Visible file types')
			.setDesc(
				'Limit which files in this mount are exposed to Obsidian. ' +
				'Folders remain browsable, but only matching files appear in the file explorer, search, and startup scan.'
			)
			.addDropdown(drop => drop
				.addOption('all', 'All file types (default)')
				.addOption('markdown-only', 'Markdown only (.md, .mdx, .canvas)')
				.addOption('pdf-only', 'PDF only')
				.setValue(this.visibleFileFilter)
				.onChange((val) => { this.visibleFileFilter = val as 'all' | 'markdown-only' | 'pdf-only'; }));

		new Setting(advancedContainer)
			.setName('New file events')
			.setDesc(
				'Controls which new files the watcher announces to Obsidian. ' +
				'"Markdown only" prevents automatic-attachment-rename plugins from ' +
				'renaming images or PDFs that were created by another app inside this ' +
				'mount. New non-markdown files will still appear after a manual refresh.'
			)
			.addDropdown(drop => drop
				.addOption('all', 'All file types (default)')
				.addOption('markdown-only', 'Markdown only (prevents auto-rename)')
				.setValue(this.watcherCreateFilter)
				.onChange((val) => { this.watcherCreateFilter = val as 'all' | 'markdown-only'; }));

		new Setting(advancedContainer)
			.setName('Suppress all watcher events')
			.setDesc(
				'When on, the file watcher monitors this folder but never forwards any ' +
				'events to Obsidian. Useful when the folder is managed by an external ' +
				'sync tool (rclone, Syncthing, Obsidian Sync on another vault, …) and you ' +
				'do not want attachment-rename or note-refactor plugins to react to ' +
				'incoming files. Files you create inside Obsidian (e.g. paste image from ' +
				'clipboard) are unaffected — Obsidian fires its own internal event for those. ' +
				'You can also toggle this at runtime via the command palette or from a script: ' +
				'app.plugins.getPlugin(\'folderbridge\').setWatcherSuppressed(null, true).'
			)
			.addToggle(toggle => toggle
				.setValue(this.watcherSuppressAllEvents)
				.onChange(val => { this.watcherSuppressAllEvents = val; }));

		new Setting(advancedContainer)
			.setName('Max files (scan limit)')
			.setDesc('Stop the initial vault scan after this many items. Leave blank for unlimited. Use this to keep Obsidian responsive with very large mounts.')
			.addText(text => {
				text.inputEl.type = 'number';
				text.inputEl.min = '0';
				text.inputEl.addClass('folderbridge-input-medium');
				text.setPlaceholder('Unlimited')
					.setValue(this.maxFiles != null ? String(this.maxFiles) : '')
					.onChange(val => {
						const n = parseInt(val, 10);
						this.maxFiles = isNaN(n) || n <= 0 ? undefined : n;
					});
			});
		// ── Action buttons ─────────────────────────────────────────────────
		new Setting(contentEl)
			.addButton(btn => {
				this.saveButton = btn;
				return btn
					.setButtonText(this.submitState.currentLabel())
					.setCta()
					.onClick(() => {
						void this.handleSave().catch(err => {
							this.submitState.finish();
							this.syncSubmitButtons();
							logger.error('Folder Bridge: Failed to save mount', err);
							new Notice(`${this.pluginName}: failed to save mount. Check the developer console for details.`);
						});
					});
			})
			.addButton(btn => {
				this.cancelButton = btn;
				return btn
					.setButtonText('Cancel')
					.onClick(() => this.close());
			});
	}

	// ------------------------------------------------------------------
	// Helpers
	// ------------------------------------------------------------------

	/**
	 * If "use folder name as label" is active, overwrite the label field
	 * with the basename of the current real path.
	 */
	private syncAutoLabel(): void {
		if (!this.useFolderNameAsLabel) return;
		const name = this.realPath ? path.basename(this.realPath) : '';
		this.label = name;
		this.labelText?.setValue(name);
	}

	private syncSubmitButtons(): void {
		const isBusy = this.submitState.isBusy();
		this.saveButton?.setDisabled(isBusy);
		this.cancelButton?.setDisabled(isBusy);
		this.saveButton?.setButtonText(this.submitState.currentLabel());
	}

	// ------------------------------------------------------------------
	// Save / validation
	// ------------------------------------------------------------------

	private async handleSave(): Promise<void> {
		if (!this.submitState.tryBegin()) return;
		this.syncSubmitButtons();

		const isWebDAV = this.mountType === 'webdav';
		const isS3 = this.mountType === 's3';
		const isSFTP = this.mountType === 'sftp';

		// ── S3-specific validation ──────────────────────────────────────────
		if (isS3) {
			if (!this.s3Bucket) {
				this.submitState.finish();
				this.syncSubmitButtons();
				new Notice(`${this.pluginName}: S3 bucket name is required.`);
				return;
			}
			if (!this.s3Region) {
				this.submitState.finish();
				this.syncSubmitButtons();
				new Notice(`${this.pluginName}: S3 region is required.`);
				return;
			}
			if (!this.s3AccessKeyId) {
				this.submitState.finish();
				this.syncSubmitButtons();
				new Notice(`${this.pluginName}: S3 access key ID is required.`);
				return;
			}
			const hasStoredSecret = !!(this.editMount?.encryptedS3SecretKey);
			if (!this.editMount && !this.s3SecretKey && !hasStoredSecret) {
				this.submitState.finish();
				this.syncSubmitButtons();
				new Notice(`${this.pluginName}: S3 secret access key is required.`);
				return;
			}
			if (!this.virtualPath.trim()) {
				this.submitState.finish();
				this.syncSubmitButtons();
				new Notice(`${this.pluginName}: Virtual path is required.`);
				return;
			}

			const normalizedVirtual = normalizePath(this.virtualPath.trim());
			const prefix = this.s3Prefix || '/';

			await this.onSave(
				{
					virtualPath: normalizedVirtual,
					realPath: prefix,
					enabled: this.editMount ? this.editMount.enabled : true,
					readOnly: this.readOnly,
					label: this.label || undefined,
					mountType: 's3',
					s3Bucket: this.s3Bucket,
					s3Region: this.s3Region,
					s3Endpoint: this.s3Endpoint || undefined,
					s3AccessKeyId: this.s3AccessKeyId,
					s3ForcePathStyle: this.s3ForcePathStyle || undefined,
					s3SecretKey: this.s3SecretKey || undefined,
					visibleFileFilter: this.visibleFileFilter !== 'all' ? this.visibleFileFilter : undefined,
					maxFiles: this.maxFiles,
				},
				this.editMount?.id,
			);
			this.close();
			return;
		}

		// ── SFTP-specific validation ────────────────────────────────────────
		if (isSFTP) {
			if (!this.sftpHost) {
				this.submitState.finish();
				this.syncSubmitButtons();
				new Notice(`${this.pluginName}: SFTP host is required.`);
				return;
			}
			if (!this.sftpUsername) {
				this.submitState.finish();
				this.syncSubmitButtons();
				new Notice(`${this.pluginName}: SFTP username is required.`);
				return;
			}
			const hasStoredPassword = !!(this.editMount?.encryptedSftpPassword);
			const hasKeyPath = !!this.sftpPrivateKeyPath;
			if (!this.editMount && !this.sftpPassword && !hasStoredPassword && !hasKeyPath) {
				this.submitState.finish();
				this.syncSubmitButtons();
				new Notice(`${this.pluginName}: SFTP password or private key path is required.`);
				return;
			}
			if (!this.virtualPath.trim()) {
				this.submitState.finish();
				this.syncSubmitButtons();
				new Notice(`${this.pluginName}: Virtual path is required.`);
				return;
			}

			const normalizedVirtual = normalizePath(this.virtualPath.trim());
			const remotePath = this.realPath || '/';

			await this.onSave(
				{
					virtualPath: normalizedVirtual,
					realPath: remotePath,
					enabled: this.editMount ? this.editMount.enabled : true,
					readOnly: this.readOnly,
					label: this.label || undefined,
					mountType: 'sftp',
					sftpHost: this.sftpHost,
					sftpPort: this.sftpPort !== 22 ? this.sftpPort : undefined,
					sftpUsername: this.sftpUsername,
					sftpPassword: this.sftpPassword || undefined,
					sftpPrivateKeyPath: this.sftpPrivateKeyPath || undefined,
					sftpPassphrase: this.sftpPassphrase || undefined,
					visibleFileFilter: this.visibleFileFilter !== 'all' ? this.visibleFileFilter : undefined,
					maxFiles: this.maxFiles,
				},
				this.editMount?.id,
			);
			this.close();
			return;
		}

		// ── WebDAV-specific validation ─────────────────────────────────────
		if (isWebDAV) {
			if (!this.webdavUrl) {
				this.submitState.finish();
				this.syncSubmitButtons();
				new Notice(`${this.pluginName}: WebDAV server URL is required.`);
				return;
			}
			try { new URL(this.webdavUrl); } catch {
				this.submitState.finish();
				this.syncSubmitButtons();
				new Notice(`${this.pluginName}: WebDAV URL is not valid. Include the scheme, e.g. https://…`);
				return;
			}
			if (!this.webdavUsername) {
				this.submitState.finish();
				this.syncSubmitButtons();
				new Notice(`${this.pluginName}: WebDAV username is required.`);
				return;
			}
			// Require a password on add unless an encrypted one is already stored
			// (e.g. user opens settings on the same device that originally saved it)
			const hasStoredPassword = !!(this.editMount?.encryptedWebdavPassword);
			if (!this.editMount && !this.webdavPassword && !hasStoredPassword) {
				this.submitState.finish();
				this.syncSubmitButtons();
				new Notice(`${this.pluginName}: WebDAV password is required.`);
				return;
			}
			if (!this.virtualPath.trim()) {
				this.submitState.finish();
				this.syncSubmitButtons();
				new Notice(`${this.pluginName}: Virtual path is required.`);
				return;
			}

			const normalizedVirtual = normalizePath(this.virtualPath.trim());
			const remotePath = this.realPath || '/';

			await this.onSave(
				{
					virtualPath: normalizedVirtual,
					realPath: remotePath,
					enabled: this.editMount ? this.editMount.enabled : true,
					readOnly: this.readOnly,
					label: this.label || undefined,
					mountType: 'webdav',
					webdavUrl: this.webdavUrl,
					webdavUsername: this.webdavUsername,
					// Pass password transiently so plugin can store it under the real mount id
					webdavPassword: this.webdavPassword || undefined,
					visibleFileFilter: this.visibleFileFilter !== 'all' ? this.visibleFileFilter : undefined,
					watcherDebounceMs: undefined,
					watcherUsePolling: undefined,
					watcherPollingIntervalMs: undefined,
					maxFiles: this.maxFiles,
				},
				this.editMount?.id,
			);
			this.close();
			return;
		}

		// ── Local filesystem validation ────────────────────────────────────
		// Fall back to the real folder's base name when no virtual path was typed
		const virtualPathToUse = this.virtualPath.trim()
			|| (this.realPath ? path.basename(this.realPath) : '');

		if (!virtualPathToUse) {
			this.submitState.finish();
			this.syncSubmitButtons();
			new Notice(`${this.pluginName}: Virtual path is required.`);
			return;
		}
		if (!this.realPath) {
			this.submitState.finish();
			this.syncSubmitButtons();
			new Notice(`${this.pluginName}: Real path is required.`);
			return;
		}
		if (!path.isAbsolute(this.realPath)) {
			this.submitState.finish();
			this.syncSubmitButtons();
			new Notice(`${this.pluginName}: Real path must be an absolute filesystem path.`);
			return;
		}

		const normalizedVirtual = normalizePath(virtualPathToUse);

		// Validate via SecurityManager (dangerous paths, duplicate mounts, etc.)
		const validationError = this.security.validateMount(
			{
				virtualPath: normalizedVirtual,
				realPath: this.realPath,
				enabled: true,
				readOnly: this.readOnly,
				label: this.label || undefined,
			},
			[], // Full existing-mount check is done again by the plugin's addMount() / updateMount()
		);
		if (validationError) {
			this.submitState.finish();
			this.syncSubmitButtons();
			new Notice(`Folder Bridge: ${validationError}`);
			return;
		}

		// Only re-check accessibility when the real path has changed (or this is a new mount)
		const realPathChanged = !this.editMount || this.editMount.realPath !== this.realPath;
		if (realPathChanged) {
			const dirExists = await isDirectory(this.realPath);
			if (!dirExists) {
				this.submitState.finish();
				this.syncSubmitButtons();
				new Notice(`Folder Bridge: "${this.realPath}" is not an accessible directory.`);
				return;
			}

			const { accessible, error } = await checkPathAccessible(this.realPath);
			if (!accessible) {
				this.submitState.finish();
				this.syncSubmitButtons();
				new Notice(`Folder Bridge: Cannot access "${this.realPath}": ${error}`);
				return;
			}
		}

		// Non-blocking advisory warnings (e.g. UNC / network paths)
		const warnings = this.security.getPathWarnings(this.realPath);
		for (const w of warnings) {
			new Notice(`Folder Bridge warning: ${w}`, 10_000);
		}

		await this.onSave(
			{
				virtualPath: normalizedVirtual,
				realPath: this.realPath,
				enabled: this.editMount ? this.editMount.enabled : true,
				readOnly: this.readOnly,
				label: this.label || undefined,
				mountType: this.mountType === 'local' ? undefined : this.mountType,
				watcherDebounceMs: this.watcherDebounceMs,
				watcherUsePolling: this.watcherUsePolling || undefined,
				watcherPollingIntervalMs: this.watcherUsePolling ? this.watcherPollingIntervalMs : undefined,
				visibleFileFilter: this.visibleFileFilter !== 'all' ? this.visibleFileFilter : undefined,
				watcherCreateFilter: this.watcherCreateFilter !== 'all' ? this.watcherCreateFilter : undefined,
				watcherSuppressAllEvents: this.watcherSuppressAllEvents || undefined,
				maxFiles: this.maxFiles,
			},
			this.editMount?.id,
		);

		this.close();
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

// ---------------------------------------------------------------------------
// Status helpers used in the settings tab
// ---------------------------------------------------------------------------

/**
 * Query the live reachability and permission status of a mount point.
 * Called when the settings tab renders the mount list.
 */
export async function getMountStatus(mount: MountPoint): Promise<MountStatus> {
	// Remote mounts (WebDAV, S3, SFTP) have no local filesystem path to check.
	// Their reachability is probed by the plugin's health-check loop separately.
	// Return a placeholder "reachable" status so the settings panel stays clean.
	if (mount.mountType === 'webdav' || mount.mountType === 's3' || mount.mountType === 'sftp') {
		return {
			mount,
			reachable: true,
			readOnly: mount.readOnly,
			error: undefined,
		};
	}
	const { accessible, readOnly, error } = await checkPathAccessible(mount.realPath);
	return {
		mount,
		reachable: accessible,
		readOnly: mount.readOnly || readOnly,
		error,
	};
}
