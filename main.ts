import { App, DataAdapter, DataWriteOptions, FuzzySuggestModal, Plugin, PluginSettingTab, Setting, Notice, normalizePath, TFolder, TFile } from 'obsidian';
import { FolderBridgeSettings, MountPoint, DEFAULT_SETTINGS } from './src/types';
import { PathMapper } from './src/PathMapper';
import { VirtualAdapter } from './src/VirtualAdapter';
import { SecurityManager } from './src/SecurityManager';
import { MountManagerModal, getMountStatus, browseFolderOnDisk, browseMultipleFoldersOnDisk, VaultFolderPickerModal } from './src/ui/MountManagerModal';
import { MountRootDeleteModal } from './src/ui/MountRootDeleteModal';
import { WelcomeModal } from './src/ui/WelcomeModal';
import { getPlatform, realPathToResourceUrl, tryReadAsDataUri } from './src/OSHelpers';
import { FileServer } from './src/FileServer';
import {
	encryptCredential, decryptCredential,
	saveSessionCredential, clearSessionCredential,
	saveWebDAVPassword, clearWebDAVPassword,
} from './src/CredentialStore';
import { FileWatcher } from './src/FileWatcher';
import { WebDAVAdapter } from './src/WebDAVAdapter';
import { S3Adapter } from './src/S3Adapter';
import { SFTPAdapter } from './src/SFTPAdapter';
import { logger } from './src/logger';
import { loadOptionalNodeModule } from './src/runtimeNode';
import { replayMountContentsToVault } from './src/mountScan';
import { parseTocConfig, serializeTocConfig } from './src/TocConfig';

// Lazy-loaded Node.js builtins — safe on Obsidian Mobile (Capacitor).
const fs: typeof import('fs') = loadOptionalNodeModule<typeof import('fs')>('fs') ?? null as never;
const path: typeof import('path') = loadOptionalNodeModule<typeof import('path')>('path') ?? null as never;

// ---------------------------------------------------------------------------
// Private Obsidian internals accessed via type-safe casts.
// ---------------------------------------------------------------------------

/** Vault properties not in the public API but stable across Obsidian versions. */
type VaultInternal = {
	onChange(event: string, path: string, prev: null, stat: { type: string; ctime: number; mtime: number; size: number } | null): Promise<void>;
	adapter: DataAdapter;
	getResourcePath?(file: TFile): string;
	create?(path: string, data: string, options?: unknown): Promise<TFile | null>;
	createBinary?(path: string, data: ArrayBuffer, options?: unknown): Promise<TFile | null>;
};

/** App properties not in the public API but stable across Obsidian versions. */
type AppInternal = {
	setting?: { open?(): void; openTabById?(id: string): void };
	openWithDefaultApp?(filePath: string): void;
};

type DesktopVaultAdapter = DataAdapter & {
	getBasePath?(): string;
};

/** Minimal interface for the Electron module shell. */
type ElectronShell = { openPath(p: string): Promise<string> };
type ElectronModule = { shell?: ElectronShell; default?: { shell?: ElectronShell } };

const GITHUB_REPO_URL = 'https://github.com/tescolopio/Obsidian_FolderBridge';
const GITHUB_PROFILE_URL = 'https://github.com/tescolopio';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function generateId(): string {
	return Math.random().toString(36).slice(2, 9) + Date.now().toString(36);
}

function openExternalUrl(url: string): void {
	window.open(url, '_blank', 'noopener,noreferrer');
}

function backgroundTask(task: Promise<void>, context: string, pluginName = 'Folder Bridge'): void {
	void task.catch(error => {
		logger.error(`[FolderBridge] ${context}`, error);
		new Notice(`${pluginName}: a background mount refresh failed. Check the developer console for details.`);
	});
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export default class FolderBridgePlugin extends Plugin {
	settings: FolderBridgeSettings;
	pathMapper: PathMapper;
	security: SecurityManager;
	virtualAdapter: VirtualAdapter | null = null;
	fileWatcher: FileWatcher | null = null;
	private persistedMountPoints: MountPoint[] = [];
	private persistedAllowlist: string[] = [];
	private managedTocMountPoints: MountPoint[] = [];
	private externalTocMountPoints: MountPoint[] = [];
	private tocWarnings: string[] = [];
	/** Localhost HTTP server — streams video/audio from local mounts with range-request support. */
	fileServer: FileServer = new FileServer();

	// Preserve original adapter so we can restore it on unload
	private originalAdapter: unknown = null;
	// Preserve original vault.getResourcePath so we can restore it on unload
	private originalVaultGetResourcePath: unknown = null;
	// Preserve original vault.create / vault.createBinary so we can restore on unload
	private originalVaultCreate: unknown = null;
	private originalVaultCreateBinary: unknown = null;
	// Preserve original app.openWithDefaultApp so we can restore it on unload
	private originalOpenWithDefaultApp: unknown = null;
	statusBarItem: HTMLElement | null = null;

	/** Tracks reachability per mount.id; populated by the 30-second health-check loop. */
	mountHealthMap = new Map<string, boolean>();
	private healthCheckInterval: ReturnType<typeof setInterval> | null = null;

	isTocManagedMount(mount: MountPoint): boolean {
		return typeof mount.tocSourcePath === 'string' && mount.tocSourcePath.length > 0;
	}

	isManagedTocMount(mount: MountPoint): boolean {
		return this.isManagedTocSource(mount.tocSourcePath);
	}

	isUserEditableMount(mount: MountPoint): boolean {
		return !this.isTocManagedMount(mount) || this.isManagedTocMount(mount);
	}

	getTocWarnings(): string[] {
		return [...this.tocWarnings];
	}

	private getManagedTocSourcePath(): string | null {
		const sourcePath = this.settings.managedTocSource?.trim();
		return sourcePath ? sourcePath : null;
	}

	private isManagedTocSource(sourcePath?: string): boolean {
		const managedSource = this.getManagedTocSourcePath();
		return !!managedSource && sourcePath === managedSource;
	}

	private canPersistToManagedToc(mountType?: MountPoint['mountType']): boolean {
		if (!this.getManagedTocSourcePath()) return false;
		return mountType === undefined || mountType === 'local' || mountType === 'vault';
	}

	private getSuggestedManagedTocSourcePath(): string | null {
		if (!path) return null;
		const adapter = this.app.vault.adapter as DesktopVaultAdapter;
		const basePath = typeof adapter.getBasePath === 'function' ? adapter.getBasePath() : '';
		return basePath ? path.join(basePath, 'folderbridge.managed.json') : null;
	}

	getSuggestedManagedTocPath(): string | null {
		return this.getSuggestedManagedTocSourcePath();
	}

	private resolveManagedTocSourcePath(inputPath: string): string {
		const trimmedPath = inputPath.trim();
		if (trimmedPath) return trimmedPath;
		return this.getSuggestedManagedTocSourcePath() ?? '';
	}

	private getManagedTocDraftMounts(): MountPoint[] {
		return this.managedTocMountPoints.map(mount => {
			const copy = { ...mount };
			delete copy.tocSourcePath;
			return copy;
		});
	}

	private getManagedTocIndex(id: string): number {
		return this.managedTocMountPoints.findIndex(mount => mount.id === id);
	}

	private async writeManagedTocMounts(mounts: MountPoint[]): Promise<boolean> {
		const sourcePath = this.getManagedTocSourcePath();
		if (!sourcePath) {
			new Notice(`${this.manifest.name}: configure a managed TOC file first.`);
			return false;
		}
		if (!fs?.promises || !path) {
			new Notice(`${this.manifest.name}: writable TOC files are only supported on desktop builds with filesystem access.`);
			return false;
		}
		const unsupportedMount = mounts.find(mount => this.isCloudMount(mount));
		if (unsupportedMount) {
			new Notice(`Folder Bridge: Managed TOC files currently support only local and vault mounts. "${unsupportedMount.label || unsupportedMount.virtualPath}" stays in data.json.`);
			return false;
		}

		await fs.promises.mkdir(path.dirname(sourcePath), { recursive: true });
		await fs.promises.writeFile(sourcePath, serializeTocConfig(mounts), 'utf8');
		return true;
	}

	async bindManagedTocSource(sourcePath: string): Promise<boolean> {
		const trimmedPath = this.resolveManagedTocSourcePath(sourcePath);
		if (!trimmedPath) {
			new Notice(`${this.manifest.name}: managed TOC file path cannot be determined automatically. Enter an absolute path first.`);
			return false;
		}

		const previousSource = this.settings.managedTocSource;
		this.settings.managedTocSource = trimmedPath;
		this.settings.tocSources = this.settings.tocSources.filter(item => item.trim() !== trimmedPath);

		try {
			if (!await this.writeManagedTocMounts(this.getManagedTocDraftMounts())) {
				this.settings.managedTocSource = previousSource;
				return false;
			}
			await this.refreshTocMountSources(true);
			await this.saveSettings();
			return true;
		} catch (error) {
			this.settings.managedTocSource = previousSource;
			const message = error instanceof Error ? error.message : String(error);
			new Notice(`Folder Bridge: Failed to initialize managed TOC file (${message}).`);
			return false;
		}
	}

	async createManagedTocFromCurrentMounts(sourcePath: string): Promise<{ success: boolean; moved: number; skipped: number; targetPath: string | null }> {
		const targetPath = this.resolveManagedTocSourcePath(sourcePath);
		if (!targetPath) {
			new Notice(`${this.manifest.name}: enter a managed TOC file path first.`);
			return { success: false, moved: 0, skipped: 0, targetPath: null };
		}

		const bindSucceeded = await this.bindManagedTocSource(targetPath);
		if (!bindSucceeded) {
			return { success: false, moved: 0, skipped: 0, targetPath: null };
		}

		const migration = await this.migrateLocalManualMountsToManagedToc();
		return {
			success: true,
			moved: migration.moved,
			skipped: migration.skipped,
			targetPath,
		};
	}

	async unbindManagedTocSource(): Promise<boolean> {
		const sourcePath = this.getManagedTocSourcePath();
		if (!sourcePath) return true;

		this.persistedMountPoints.push(...this.getManagedTocDraftMounts());
		this.managedTocMountPoints = [];
		this.settings.managedTocSource = '';
		await this.refreshTocMountSources();
		await this.saveSettings();
		return true;
	}

	async migrateLocalManualMountsToManagedToc(): Promise<{ moved: number; skipped: number }> {
		const sourcePath = this.getManagedTocSourcePath();
		if (!sourcePath) {
			new Notice(`${this.manifest.name}: configure a managed TOC file first.`);
			return { moved: 0, skipped: 0 };
		}

		const movableMounts = this.persistedMountPoints.filter(mount => !this.isCloudMount(mount));
		const skipped = this.persistedMountPoints.length - movableMounts.length;
		if (movableMounts.length === 0) {
			return { moved: 0, skipped };
		}

		const nextManagedMounts = [...this.getManagedTocDraftMounts(), ...movableMounts];
		if (!await this.writeManagedTocMounts(nextManagedMounts)) {
			return { moved: 0, skipped };
		}

		this.persistedMountPoints = this.persistedMountPoints.filter(mount => this.isCloudMount(mount));
		await this.refreshTocMountSources(true);
		await this.saveSettings();
		return { moved: movableMounts.length, skipped };
	}

	async persistEditableMountFromState(mount: MountPoint): Promise<boolean> {
		if (!this.isUserEditableMount(mount)) return false;

		if (this.isManagedTocMount(mount)) {
			const managedIndex = this.getManagedTocIndex(mount.id);
			if (managedIndex === -1) return false;

			const nextManagedMounts = this.getManagedTocDraftMounts();
			const updatedMount = { ...mount };
			delete updatedMount.tocSourcePath;
			nextManagedMounts[managedIndex] = updatedMount;
			if (!await this.writeManagedTocMounts(nextManagedMounts)) return false;
			await this.refreshTocMountSources(true);
			await this.saveSettings();
			return true;
		}

		await this.saveSettings();
		this.syncEffectiveMountState();
		return true;
	}

	addManualAllowlistPath(realPath: string): void {
		if (!this.persistedAllowlist.includes(realPath)) {
			this.persistedAllowlist.push(realPath);
		}
		this.security?.allow(realPath);
	}

	resyncEffectiveMountState(): void {
		this.syncEffectiveMountState();
	}

	private effectiveRealPathForAllowlist(mount: MountPoint): string {
		return mount.deviceOverrides?.[this.settings.deviceId] ?? mount.realPath;
	}

	private isCloudMount(mount: Pick<MountPoint, 'mountType'>): boolean {
		return mount.mountType === 'webdav' || mount.mountType === 's3' || mount.mountType === 'sftp';
	}

	private syncEffectiveMountState(): void {
		const effectiveMounts = [
			...this.persistedMountPoints,
			...this.managedTocMountPoints,
			...this.externalTocMountPoints,
		];
		const effectiveAllowlist = Array.from(new Set([
			...this.persistedAllowlist,
			...effectiveMounts
				.filter(m => !this.isCloudMount(m))
				.map(m => this.effectiveRealPathForAllowlist(m))
				.filter(Boolean),
		]));

		this.settings.mountPoints = effectiveMounts;
		this.settings.allowlist = effectiveAllowlist;
		this.pathMapper?.update(this.settings.mountPoints, this.settings.deviceId);
		this.security?.setAllowlist(effectiveAllowlist);
	}

	async refreshTocMountSources(notifyOnWarnings = false): Promise<void> {
		this.tocWarnings = [];
		const validator = this.security ?? new SecurityManager(this.persistedAllowlist);
		const managedSource = this.getManagedTocSourcePath();
		const externalSources = Array.from(new Set(
			this.settings.tocSources
				.map(source => source.trim())
				.filter(Boolean)
				.filter(source => source !== managedSource)
		));

		if (!managedSource && externalSources.length === 0) {
			this.managedTocMountPoints = [];
			this.externalTocMountPoints = [];
			this.syncEffectiveMountState();
			this.updateIgnoreCache();
			return;
		}

		if (!fs?.promises) {
			this.tocWarnings = ['TOC config files are only supported on desktop builds with filesystem access.'];
			this.managedTocMountPoints = [];
			this.externalTocMountPoints = [];
			this.syncEffectiveMountState();
			this.updateIgnoreCache();
			if (notifyOnWarnings) {
				for (const warning of this.tocWarnings) {
					new Notice(`Folder Bridge: ${warning}`);
				}
			}
			return;
		}

		const managedMounts: MountPoint[] = [];
		const externalMounts: MountPoint[] = [];
		const warnings: string[] = [];

		if (managedSource) {
			try {
				const text = await fs.promises.readFile(managedSource, 'utf8');
				const parsed = parseTocConfig(text, managedSource, this.settings.deviceId);
				warnings.push(...parsed.warnings);

				for (const candidate of parsed.mounts) {
					const error = validator.validateMount(candidate, [...this.persistedMountPoints, ...managedMounts]);
					if (error) {
						warnings.push(`${managedSource}: skipped mount "${candidate.virtualPath}" (${error})`);
						continue;
					}
					managedMounts.push(candidate);
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				warnings.push(`${managedSource}: Failed to load config file (${message}).`);
			}
		}

		for (const sourcePath of externalSources) {
			const trimmedPath = sourcePath.trim();
			if (!trimmedPath) continue;
			try {
				const text = await fs.promises.readFile(trimmedPath, 'utf8');
				const parsed = parseTocConfig(text, trimmedPath, this.settings.deviceId);
				warnings.push(...parsed.warnings);

				for (const candidate of parsed.mounts) {
					const error = validator.validateMount(candidate, [...this.persistedMountPoints, ...managedMounts, ...externalMounts]);
					if (error) {
						warnings.push(`${trimmedPath}: skipped mount "${candidate.virtualPath}" (${error})`);
						continue;
					}
					externalMounts.push(candidate);
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				warnings.push(`${trimmedPath}: Failed to load config file (${message}).`);
			}
		}

		this.managedTocMountPoints = managedMounts;
		this.externalTocMountPoints = externalMounts;
		this.tocWarnings = warnings;
		this.syncEffectiveMountState();
		this.updateIgnoreCache();

		if (notifyOnWarnings) {
			for (const warning of warnings) {
				new Notice(`Folder Bridge: ${warning}`);
			}
		}
	}

	async onload() {
		await this.loadSettings();

		this.pathMapper = new PathMapper();
		this.security = new SecurityManager(this.settings.allowlist);
		this.pathMapper.update(this.settings.mountPoints, this.settings.deviceId);

		// [FEATURE_20260222] Initialize FileWatcher
		this.fileWatcher = new FileWatcher(this.app, this.pathMapper, (name, mount, mountRelativePath) => this.isNameIgnored(name, mount, mountRelativePath));

		// Install the virtual adapter shim
		this.installVirtualAdapter();

		// Start the localhost streaming server for video/audio in local mounts.
		// Runs on a random available port; bound to 127.0.0.1 only.
		void this.fileServer.start().then(started => {
			if (!started) return; // mobile — unavailable
			// Register all currently active local mounts
			for (const m of this.settings.mountPoints) {
				if (m.enabled && m.realPath && !['webdav', 's3', 'sftp'].includes(m.mountType ?? '')) {
					this.fileServer.addAllowedPath(m.realPath);
				}
			}
			this.virtualAdapter?.setFileServer(this.fileServer);
		}).catch(err => {
			logger.warn('[FolderBridge] FileServer failed to start (video streaming unavailable):', err);
		});

		// Ribbon icon opens the add-mount modal
		const ribbonIconEl = this.addRibbonIcon('folder-plus', `${this.manifest.name}: add mount`, () => {
			new MountManagerModal(this.app, this.manifest.name, this.security, (mount) => this.addMount(mount)).open();
		});
		ribbonIconEl.addClass('folderbridge-ribbon-class');

		// Status bar
		if (this.settings.showStatusBar) {
			this.statusBarItem = this.addStatusBarItem();
			this.updateStatusBar();
		}

		// Settings tab
		this.addSettingTab(new FolderBridgeSettingTab(this.app, this));

		// Add a command to manually refresh mounts
		this.addCommand({
			id: 'refresh-mounts',
			name: 'Refresh all mounts',
			callback: () => {
				void (async () => {
					for (const mount of this.settings.mountPoints.filter(m => m.enabled && (m.deviceId === this.settings.deviceId || this.settings.allowForeignMounts))) {
						await this.notifyVaultMountAdded(mount);
					}
					new Notice(`${this.manifest.name}: mounts refreshed`);
				})();
			}
		});

		// Command: open add-mount modal
		this.addCommand({
			id: 'add-mount',
			name: 'Add mount',
			callback: () => {
				new MountManagerModal(this.app, this.manifest.name, this.security, (mount) => this.addMount(mount)).open();
			},
		});

		// Command: open plugin settings tab
		this.addCommand({
			id: 'open-settings',
			name: 'Open settings',
			callback: () => {
				(this.app as App & AppInternal).setting?.open?.();
				(this.app as App & AppInternal).setting?.openTabById?.('folderbridge');
			},
		});

		// Command: toggle a mount (picker modal)
		this.addCommand({
			id: 'toggle-mount',
			name: 'Toggle mount on/off…',
			callback: () => {
				const myMounts = this.settings.mountPoints.filter(
					m => this.isUserEditableMount(m) && (m.deviceId === this.settings.deviceId || this.settings.allowForeignMounts),
				);
				if (myMounts.length === 0) {
					new Notice(`${this.manifest.name}: no mounts configured.`);
					return;
				}
				// Inline FuzzySuggestModal — avoids a separate file for a small feature
				const modal = new (class extends FuzzySuggestModal<MountPoint> {
					constructor(app: App, private readonly outerPlugin: FolderBridgePlugin) { super(app); }
					getItems() { return myMounts; }
					getItemText(m: MountPoint) {
						const status = m.enabled ? '✅' : '⏸';
						return `${status}  ${m.label || m.virtualPath}`;
					}
					onChooseItem(m: MountPoint) {
						void (async () => {
							const enabling = !m.enabled;
							// Must remove BEFORE setting enabled=false so adapter can still resolve paths
							if (!enabling) await this.outerPlugin.notifyVaultMountRemoved(m);
							m.enabled = enabling;
							await this.outerPlugin.persistEditableMountFromState(m);
							this.outerPlugin.pathMapper.update(this.outerPlugin.settings.mountPoints, this.outerPlugin.settings.deviceId);
							this.outerPlugin.updateStatusBar();
							if (enabling) {
								await this.outerPlugin.notifyVaultMountAdded(m);
								new Notice(`Folder Bridge: "${m.label || m.virtualPath}" Enabled.`);
							} else {
								new Notice(`Folder Bridge: "${m.label || m.virtualPath}" Disabled.`);
							}
						})();
					}
				})(this.app, this);
				modal.setPlaceholder('Choose a mount to toggle on / off');
				modal.open();
			},
		});

		// Command: reconnect all unreachable mounts
		this.addCommand({
			id: 'reconnect-mounts',
			name: 'Reconnect unreachable mounts',
			callback: () => {
				void (async () => {
					const unreachable = this.settings.mountPoints.filter(
						m => m.enabled && !this.mountHealthMap.get(m.id),
					);
					if (unreachable.length === 0) {
						new Notice(`${this.manifest.name}: all mounts are reachable.`);
						return;
					}
					let reconnected = 0;
					for (const mount of unreachable) {
						try {
							await this.reconnectMount(mount);
							reconnected++;
						} catch { /* individual failure already noticed inside reconnectMount */ }
					}
					new Notice(`Folder Bridge: Reconnected ${reconnected} / ${unreachable.length} mount(s).`);
				})();
			},
		});

		// Command: toggle read-only on ALL mounts belonging to this device
		this.addCommand({
			id: 'toggle-readonly-all',
			name: 'Toggle read-only on all mounts',
			callback: () => {
				void (async () => {
					const myMounts = this.settings.mountPoints.filter(m => this.isUserEditableMount(m) && m.deviceId === this.settings.deviceId);
					if (myMounts.length === 0) {
						new Notice(`${this.manifest.name}: no mounts configured.`);
						return;
					}
					// If any mount is currently writable, make all read-only; otherwise unlock all.
					const anyWritable = myMounts.some(m => !m.readOnly);
					for (const m of myMounts) {
						await this.setMountReadOnly(m.id, anyWritable, /* skipNotice */ true);
					}
					new Notice(`Folder Bridge: All mounts are now ${anyWritable ? 'read-only' : 'writable'}.`);
				})();
			},
		});

		// Command: toggle read-only on a specific mount (fuzzy picker)
		this.addCommand({
			id: 'toggle-readonly-mount',
			name: 'Toggle read-only on a specific mount…',
			callback: () => {
				const myMounts = this.settings.mountPoints.filter(
					m => this.isUserEditableMount(m) && (m.deviceId === this.settings.deviceId || this.settings.allowForeignMounts),
				);
				if (myMounts.length === 0) {
					new Notice(`${this.manifest.name}: no mounts configured.`);
					return;
				}
				const modal = new (class extends FuzzySuggestModal<MountPoint> {
					constructor(app: App, private readonly outerPlugin: FolderBridgePlugin) { super(app); }
					getItems() { return myMounts; }
					getItemText(m: MountPoint) {
						const state = m.readOnly ? 'Read-only' : 'Writable';
						return `${state}  ${m.label || m.virtualPath}`;
					}
					onChooseItem(m: MountPoint) {
						void this.outerPlugin.setMountReadOnly(m.id, !m.readOnly);
					}
				})(this.app, this);
				modal.setPlaceholder('Choose a mount to toggle read-only.');
				modal.open();
			},
		});

		// Command: toggle global watcher-event suppression (all mounts)
		this.addCommand({
			id: 'toggle-watcher-suppression-all',
			name: 'Toggle watcher event suppression (all mounts)',
			callback: () => {
				const wasSuppressed = this.fileWatcher?.isSuppressedAll() ?? false;
				this.setWatcherSuppressed(null, !wasSuppressed);
				new Notice(
					`Folder Bridge: Watcher events ${!wasSuppressed ? 'suppressed. External-sync changes will not trigger other plugins.' : 'restored. External-sync changes will trigger other plugins again.'}`
				);
			},
		});

		// Command: toggle watcher-event suppression for a specific mount
		this.addCommand({
			id: 'toggle-watcher-suppression-mount',
			name: 'Toggle watcher event suppression for a specific mount…',
			callback: () => {
				const myMounts = this.settings.mountPoints.filter(
					m => m.deviceId === this.settings.deviceId || this.settings.allowForeignMounts,
				);
				if (myMounts.length === 0) {
					new Notice(`${this.manifest.name}: no mounts configured.`);
					return;
				}
				const modal = new (class extends FuzzySuggestModal<MountPoint> {
					constructor(app: App, private readonly outerPlugin: FolderBridgePlugin) { super(app); }
					getItems() { return myMounts; }
					getItemText(m: MountPoint) {
						const suppressed = this.outerPlugin.fileWatcher?.isSuppressed(m.id) ?? false;
						return `${suppressed ? 'Suppressed' : 'Active'}  ${m.label || m.virtualPath}`;
					}
					onChooseItem(m: MountPoint) {
						const suppressed = this.outerPlugin.fileWatcher?.isSuppressed(m.id) ?? false;
						this.outerPlugin.setWatcherSuppressed(m.id, !suppressed);
						new Notice(
							`Folder Bridge: Watcher events for "${m.label || m.virtualPath}" ${!suppressed ? 'suppressed' : 'restored'}.`
						);
					}
				})(this.app, this);
				modal.setPlaceholder('Choose a mount to toggle watcher suppression.');
				modal.open();
			},
		});

		// Add context menu item to ignore files/folders
		this.registerEvent(
			this.app.workspace.on('file-menu', (menu, file) => {
				// Only show if the file is inside a mounted folder
				const mount = this.pathMapper.getMountForPath(file.path);
				if (!mount) return;

				// "Move mount to…" — only on the mount's own root folder
				const isMountRoot = file instanceof TFolder &&
					normalizePath(file.path) === normalizePath(mount.virtualPath) &&
					mount.deviceId === this.settings.deviceId;
				if (isMountRoot) {
					menu.addItem((item) => {
						item
							.setTitle('Move mount to\u2026')
							.setIcon('folder-input')
							.onClick(() => {
								new VaultFolderPickerModal(this.app, async (newParent) => {
									const leaf = normalizePath(mount.virtualPath).split('/').pop() || '';
									const newVirtualPath = newParent
										? normalizePath(`${newParent}/${leaf}`)
										: leaf;
									if (newVirtualPath === normalizePath(mount.virtualPath)) return;
									await this.updateMount(mount.id, { ...mount, virtualPath: newVirtualPath });
								}).open();
							});
					});
				}

				menu.addItem((item) => {
					item
						.setTitle(`Ignore "${file.name}" in Folder Bridge`)
						.setIcon('eye-off')
						.onClick(() => {
							void (async () => {
								if (!this.isNameIgnored(file.name, mount)) {
									if (!mount.ignoreList) mount.ignoreList = [];
									mount.ignoreList.push(file.name);
									await this.saveSettings();
									new Notice(`Folder Bridge: Added "${file.name}" to ignore list for mount "${mount.virtualPath}".`);

									// Remove it from the vault view immediately
									const vault = this.app.vault as typeof this.app.vault & VaultInternal;
									if (typeof vault.onChange === 'function') {
										try {
											if (file instanceof TFolder) {
												await vault.onChange('folder-removed', file.path, null, null);
											} else if (file instanceof TFile) {
												await vault.onChange('file-removed', file.path, null, null);
											}
										} catch (e) {
											logger.debug('Folder Bridge: Failed to remove ignored item from view', e);
										}
									}
								} else {
									new Notice(`Folder Bridge: "${file.name}" is already in the ignore list for this mount.`);
								}
							})();
						});
				});
			})
		);

		// After the workspace finishes loading, inject all enabled mounts into
		// Obsidian's internal vault file tree so they appear in the file explorer
		// without requiring a restart.
		this.app.workspace.onLayoutReady(() => {
			void (async () => {
				// [BUGFIX_20260222] Removed debug log for resource path format

				const activeMounts = this.settings.mountPoints.filter(m => m.enabled && (m.deviceId === this.settings.deviceId || this.settings.allowForeignMounts));

				// Register adapters for all active mounts — each type handled in its own branch.
				for (const mount of activeMounts) {
					if (mount.mountType === 'webdav') {
						// Decrypt the persisted password into sessionStorage so fromMount() can pick it up.
						if (mount.encryptedWebdavPassword) {
							const plain = decryptCredential(mount.encryptedWebdavPassword);
							if (plain) saveWebDAVPassword(mount.id, plain);
						}
						const adapter = WebDAVAdapter.fromMount(mount);
						if (adapter) this.virtualAdapter?.setWebDAVAdapter(mount.id, adapter);
					} else if (mount.mountType === 's3') {
						// Decrypt secret key so S3Adapter.fromMount() can build the client.
						if (mount.encryptedS3SecretKey) {
							const plain = decryptCredential(mount.encryptedS3SecretKey);
							if (plain) saveSessionCredential('s3', mount.id, plain);
						}
						const s3 = S3Adapter.fromMount(mount);
						if (s3) this.virtualAdapter?.setS3Adapter(mount.id, s3);
					} else if (mount.mountType === 'sftp') {
						// Decrypt SFTP credentials into sessionStorage.
						if (mount.encryptedSftpPassword) {
							const plain = decryptCredential(mount.encryptedSftpPassword);
							if (plain) saveSessionCredential('sftp-pw', mount.id, plain);
						}
						if (mount.encryptedSftpPassphrase) {
							const plain = decryptCredential(mount.encryptedSftpPassphrase);
							if (plain) saveSessionCredential('sftp-pp', mount.id, plain);
						}
						const sftpAdapter = SFTPAdapter.fromMount(mount);
						if (sftpAdapter) this.virtualAdapter?.setSFTPAdapter(mount.id, sftpAdapter);
					}
				}

				for (const mount of activeMounts) {
					await this.notifyVaultMountAdded(mount);
				}
				// Start background reachability checks after initial mount injection
				this.startHealthChecks();

				// Show first-run welcome modal for new users
				if (!this.settings.hasSeenOnboarding) {
					this.settings.hasSeenOnboarding = true;
					await this.saveSettings();
					new WelcomeModal(
						this.app,
						() => new MountManagerModal(
							this.app,
							this.manifest.name,
							this.security,
							async (mount) => { await this.addMount(mount); },
						).open(),
						() => { /* dismissed */ },
					).open();
				}
			})();
		});

		logger.debug(`Folder Bridge Loaded (${getPlatform()}, ${this.settings.mountPoints.filter(m => m.enabled && (m.deviceId === this.settings.deviceId || this.settings.allowForeignMounts)).length} active mounts on this device)`);
	}

	onunload() {
		// Stop background health-check loop before watcher so no stale notices fire
		if (this.healthCheckInterval !== null) {
			clearInterval(this.healthCheckInterval);
			this.healthCheckInterval = null;
		}
		// [FEATURE_20260222] Stop all file watchers
		this.fileWatcher?.stopAll();

		// Restore the original adapter so the vault works normally after unload
		if (this.originalAdapter) {
			(this.app.vault as typeof this.app.vault & VaultInternal).adapter = this.originalAdapter as DataAdapter;
			this.originalAdapter = null;
		}

		// Restore the original vault.getResourcePath
		if (this.originalVaultGetResourcePath) {
			(this.app.vault as typeof this.app.vault & VaultInternal).getResourcePath = this.originalVaultGetResourcePath as (file: TFile) => string;
			this.originalVaultGetResourcePath = null;
		}

		// Restore the original vault.create / vault.createBinary
		if (this.originalVaultCreate) {
			(this.app.vault as unknown as { create?: unknown }).create = this.originalVaultCreate;
			this.originalVaultCreate = null;
		}
		if (this.originalVaultCreateBinary) {
			(this.app.vault as unknown as { createBinary?: unknown }).createBinary = this.originalVaultCreateBinary;
			this.originalVaultCreateBinary = null;
		}

		// Restore the original app.openWithDefaultApp
		if (this.originalOpenWithDefaultApp) {
			(this.app as App & AppInternal).openWithDefaultApp = this.originalOpenWithDefaultApp as (filePath: string) => void;
			this.originalOpenWithDefaultApp = null;
		}

		// Stop the localhost streaming server
		this.fileServer.stop();

		logger.debug('Folder Bridge Unloaded');
	}

	// ------------------------------------------------------------------
	// Helpers
	// ------------------------------------------------------------------

	private ignoreCache = new Map<string, { nameStrings: string[], pathStrings: string[], regexes: RegExp[] }>();

	/** Public alias used by the settings UI to refresh after global-pattern changes. */
	updateIgnoreCachePublic() { this.updateIgnoreCache(); }

	private updateIgnoreCache() {
		this.ignoreCache.clear();

		// Pre-parse global patterns once
		const globalList = this.settings.globalIgnorePatterns || [];
		const globalNameStrings: string[] = [];
		const globalPathStrings: string[] = [];
		const globalRegexes: RegExp[] = [];
		for (const pattern of globalList) {
			if (pattern.includes('*')) {
				const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
				globalRegexes.push(new RegExp('^' + escaped.replace(/\*/g, '[^/]*') + '$'));
			} else if (pattern.includes('/')) {
				globalPathStrings.push(normalizePath(pattern));
			} else {
				globalNameStrings.push(pattern);
			}
		}

		for (const mount of this.settings.mountPoints) {
			const nameStrings: string[] = [...globalNameStrings];
			const pathStrings: string[] = [...globalPathStrings];
			const regexes: RegExp[] = [...globalRegexes];
			const list = mount.ignoreList || [];
			for (const pattern of list) {
				if (pattern.includes('*')) {
					// Use [^/]* instead of .* to prevent ReDoS from user-supplied
					// patterns like "a*b*" which would produce catastrophic backtracking
					const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
					const regexStr = '^' + escaped.replace(/\*/g, '[^/]*') + '$';
					regexes.push(new RegExp(regexStr));
				} else if (pattern.includes('/')) {
					pathStrings.push(normalizePath(pattern));
				} else {
					nameStrings.push(pattern);
				}
			}
			this.ignoreCache.set(mount.id, { nameStrings, pathStrings, regexes });
		}
	}

	/**
	 * Returns true when `name` (the leaf filename/dirname) or `mountRelativePath`
	 * (the path relative to the mount root, e.g. "assets/vendor/cache") should
	 * be excluded from the vault view and file watcher.
	 *
	 * Pattern types in ignoreList:
	 *   - No slash, no wildcard  → matched against the leaf name only
	 *     (e.g. ".git", "node_modules")
	 *   - Contains "/"           → matched as a prefix against mountRelativePath
	 *     (e.g. "assets/vendor" ignores that subtree and nothing else named "assets")
	 *   - Contains "*"           → treated as a glob matched against the leaf name
	 *     (e.g. "*.tmp", "~$*")
	 */
	isNameIgnored(name: string, mount: MountPoint, mountRelativePath?: string): boolean {
		const cache = this.ignoreCache.get(mount.id);
		if (!cache) return false;
		// Path-prefix patterns: only applicable when the full relative path is known
		if (mountRelativePath) {
			for (const pathPat of cache.pathStrings) {
				if (mountRelativePath === pathPat || mountRelativePath.startsWith(pathPat + '/')) return true;
			}
		}
		// Name patterns and globs
		if (cache.nameStrings.includes(name)) return true;
		for (const regex of cache.regexes) {
			if (regex.test(name)) return true;
		}
		return false;
	}

	// ------------------------------------------------------------------
	// Adapter installation
	// ------------------------------------------------------------------

	private installVirtualAdapter(): void {
		const vault = this.app.vault as typeof this.app.vault & VaultInternal;
		this.originalAdapter = vault.adapter;

		this.virtualAdapter = new VirtualAdapter(
			this.originalAdapter,
			this.pathMapper,
			this.security,
			this.settings.dryRun,
			(this.settings.maxDataUriMB ?? 10) * 1024 * 1024,
			async (mount: MountPoint) => {
				let action: 'unmount' | 'delete' | 'cancel' = 'cancel';

				if (this.settings.mountRootDeletionBehavior === 'unmount') {
					action = 'unmount';
				} else if (this.settings.mountRootDeletionBehavior === 'delete') {
					action = 'delete';
				} else {
					action = await new Promise<'unmount' | 'delete' | 'cancel'>((resolve) => {
						const modal = new MountRootDeleteModal(this.app, mount.virtualPath, async (result) => {
							if (result === 'unmount-always') {
								this.settings.mountRootDeletionBehavior = 'unmount';
								await this.saveSettings();
								resolve('unmount');
							} else if (result === 'delete-always') {
								this.settings.mountRootDeletionBehavior = 'delete';
								await this.saveSettings();
								resolve('delete');
							} else {
								resolve(result);
							}
						});
						modal.open();
					});
				}

				if (action === 'unmount') {
					const idx = this.persistedMountPoints.findIndex(m => m.id === mount.id);
					if (idx !== -1) {
						this.persistedMountPoints.splice(idx, 1);
						await this.saveSettings();
						this.syncEffectiveMountState();
						this.updateStatusBar();
					}
				}

				return action;
			},
			// onMountRootMove: called when the user drags/moves a mount root in the file explorer
			async (mount: MountPoint, newVirtualPath: string) => {
				await this.updateMount(mount.id, { ...mount, virtualPath: newVirtualPath });
			},
			(name: string, mount: MountPoint, mountRelativePath?: string) => {
				return this.isNameIgnored(name, mount, mountRelativePath);
			},
			// onModify: fired after every successful write/append on a mounted path.
			//
			// Obsidian's own file-system watcher only monitors the vault directory, so
			// it never fires vault.onChange('raw', …) for writes to external mount paths.
			// FolderBridge's Chokidar watcher covers external changes from other apps,
			// but on Windows network/mapped drives (SMB) native ReadDirectoryChangesW
			// events often don't propagate — so Chokidar misses writes that originate
			// inside Obsidian too (e.g. Bases editing frontmatter).  The net effect is
			// that MetadataCache stays stale and features like Bases never update their
			// views after a frontmatter edit until the plugin is toggled or Obsidian is
			// restarted.
			//
			// Firing 'file-changed' + 'raw' here is the same thing FileWatcher does for
			// externally-detected changes, and mirrors the vault.create() patch above.
			// If Chokidar also fires for the same write (on drives that DO support native
			// events) the double notification is harmless — MetadataCache re-reads the
			// file twice and emits 'changed' once.
			async (normalizedPath: string) => {
				const mountForPath = this.pathMapper.getMountForPath(normalizedPath);
				if (!mountForPath) return;
				// Respect per-mount and runtime suppression flags.
				if (this.fileWatcher?.isSuppressed(mountForPath.id) || mountForPath.watcherSuppressAllEvents) return;
				const vault = this.app.vault as typeof this.app.vault & VaultInternal;
				if (typeof vault.onChange !== 'function') return;
				try {
					const stat = await this.app.vault.adapter.stat(normalizedPath);
					if (stat) {
						await vault.onChange('file-changed', normalizedPath, null, stat);
						await vault.onChange('raw', normalizedPath, null, null);
					}
				} catch {
					// Best-effort: stat may fail transiently (e.g. cloud mount); ignore.
				}
			},
			// onDelete: fired after a mounted path is deleted via the adapter.
			//
			// When a delete originates inside Obsidian, the external watcher may not
			// fire at all (watcher backend unavailable, network-drive watcher gaps,
			// or runtime suppression). Explicitly signaling the removal here keeps the
			// vault tree and any open file state in sync with the real filesystem.
			async (normalizedPath: string) => {
				const vault = this.app.vault as typeof this.app.vault & VaultInternal;
				if (typeof vault.onChange !== 'function') return;
				const existing = this.app.vault.getAbstractFileByPath(normalizedPath);
				if (!existing) return;
				await vault.onChange(existing instanceof TFolder ? 'folder-removed' : 'file-removed', normalizedPath, null, null);
			}
		);

		// Wrap with a Proxy so that any undocumented methods on the original
		// adapter (internal Obsidian APIs) still work transparently.
		vault.adapter = new Proxy(this.virtualAdapter, {
			get(target, prop, receiver) {
				// If VirtualAdapter has the property, use it
				if (prop in target) {
					const val = Reflect.get(target, prop, receiver);
					return typeof val === 'function' ? val.bind(target) : val;
				}
				// Otherwise fall through to the original adapter
				const orig = (target as unknown as { orig?(): DataAdapter }).orig?.();
				if (orig && prop in orig) {
					const val = orig[prop as keyof typeof orig];
					return typeof val === 'function' ? val.bind(orig) : val;
				}
				return undefined;
			},
			// Present the original adapter's prototype to satisfy Obsidian's internal
			// `instanceof FileSystemAdapter` guards.  Several desktop-only paths —
			// most visibly the CSS Snippets "open folder" button in Appearance settings
			// — bail out silently when this check fails.  Because our proxy wraps the
			// original FileSystemAdapter and fully delegates all unimplemented methods
			// back to it, reporting its prototype is semantically accurate.
			getPrototypeOf(target) {
				const orig = (target as unknown as { orig?(): DataAdapter }).orig?.();
				return orig ? Object.getPrototypeOf(orig) : Object.getPrototypeOf(target);
			},
		}) as DataAdapter;

		// Obsidian's renderer calls Vault.getResourcePath(TFile) directly — it does NOT
		// go through the adapter. We must also patch the vault-level method so that
		// embedded images in mounted folders resolve to the real disk path.
		this.originalVaultGetResourcePath = vault.getResourcePath?.bind(vault);
		const pathMapper = this.pathMapper;
		vault.getResourcePath = (file: TFile): string => {
			const mount = pathMapper.getMountForPath(file.path);
			if (mount) {
				const realPath = pathMapper.toRealPath(file.path, mount);
				// Modern Obsidian uses app://<vaultId>/ which is restricted to
				// vault-relative paths — external mounts get ERR_FILE_NOT_FOUND.
				// For video/audio: stream via localhost FileServer (supports range requests).
				// For images/PDFs: serve as data: URI (no range needed).
				// For everything else: fall back to app://local/ (legacy).
				return this.virtualAdapter?.resolveResourceUrl(realPath)
					?? tryReadAsDataUri(realPath, (this.settings.maxDataUriMB ?? 10) * 1024 * 1024)
					?? realPathToResourceUrl(realPath);
			}
			// Fallback to original vault method for non-mounted files
			if (typeof this.originalVaultGetResourcePath === 'function') {
				return (this.originalVaultGetResourcePath as (file: TFile) => string)(file);
			}
			return '';
		};

		// Patch app.openWithDefaultApp() to use the real filesystem path for
		// mounted files.  Without this, Obsidian constructs a path relative to
		// the vault root which doesn't exist on disk for external mounts, so the
		// "Open with default application" context-menu action silently does nothing.
		const appInternal = this.app as App & AppInternal;
		this.originalOpenWithDefaultApp = appInternal.openWithDefaultApp?.bind(this.app);
		appInternal.openWithDefaultApp = (filePath: string): void => {
			const nPath = normalizePath(filePath);
			const mount = pathMapper.getMountForPath(nPath);
			if (mount && !['webdav', 's3', 'sftp'].includes(mount.mountType ?? '')) {
				// Local mount: pass the real OS path directly to the shell
				const realPath = pathMapper.toRealPath(nPath, mount);
				try {
					const electron = loadOptionalNodeModule<ElectronModule>('electron');
					const shellApi: ElectronShell | undefined = electron?.shell ?? electron?.default?.shell;
					shellApi?.openPath(realPath).catch((e: unknown) => {
						logger.warn('[Folder Bridge] openWithDefaultApp shell.openPath failed:', e);
					});
				} catch (e) {
					logger.warn('[Folder Bridge] openWithDefaultApp: electron not available', e);
				}
				return;
			}
			// Non-mounted or cloud file: fall through to original
			if (typeof this.originalOpenWithDefaultApp === 'function') {
				(this.originalOpenWithDefaultApp as (f: string) => void)(filePath);
			}
		};

		// Patch vault.create() and vault.createBinary() for virtual mount paths.
		//
		// Obsidian's internal vault.create() calls adapter.getFullPath() to verify
		// that the parent directory exists on the local filesystem before — and after
		// — writing.  For virtual mount files the real data lives in the mounted
		// source directory, not inside the vault's physical folder.  Even with
		// getFullPath() correctly overridden on the adapter, Obsidian may not call
		// vault.onChange('file-created', …) synchronously for virtual paths (it
		// relies on the native filesystem watcher, which only watches the vault dir).
		//
		// This patch ensures that, for any path belonging to a virtual mount:
		// 1. The original vault.create() runs normally (it writes via our adapter).
		// 2. If the TFile is not in the vault's fileMap after that call, we perform
		//    a manual write + immediate vault.onChange('file-created', …) so the TFile
		//    is present and a newly-opened tab immediately shows the new note.
		this.originalVaultCreate = vault.create?.bind(vault);
		this.originalVaultCreateBinary = vault.createBinary?.bind(vault);

		type OrigVaultCreate = (path: string, data: string, options?: unknown) => Promise<TFile | null>;
		type OrigVaultCreateBinary = (path: string, data: ArrayBuffer, options?: unknown) => Promise<TFile | null>;
		type PatchedVault = { create?: OrigVaultCreate; createBinary?: OrigVaultCreateBinary };

		(vault as unknown as PatchedVault).create = async (path: string, data: string, options?: unknown): Promise<TFile | null> => {
			const nPath = normalizePath(path);
			if (!this.pathMapper.getMountForPath(nPath)) {
				return (this.originalVaultCreate as OrigVaultCreate)(path, data, options);
			}

			// Let the original vault.create() run — it calls adapter.write() and may
			// call vault.onChange('file-created', …) depending on the Obsidian version.
			try {
				await (this.originalVaultCreate as OrigVaultCreate)(path, data, options);
			} catch (e) {
				// Original vault.create() might reject due to a failed filesystem check
				// against the vault physical directory (the real file is in the mount).
				// We swallow the error and fall through to manual registration.
				logger.debug('[Folder Bridge] vault.create() rejected for virtual path, using manual registration:', e);
			}

			// If the original call already registered the TFile, return it.
			const existingA = this.app.vault.getAbstractFileByPath(nPath);
			const existing = existingA instanceof TFile ? existingA : null;
			if (existing) return existing;

			// Manual fallback: write the file + register the TFile immediately.
			// This runs when vault.create() failed or when Obsidian relies on the
			// native FS watcher (which never fires for paths outside the vault dir).
			try {
				await vault.adapter.write(nPath, data, options as DataWriteOptions | undefined);
			} catch {
				// File may already have been written by the failed vault.create() above.
			}
			const stat = await vault.adapter.stat(nPath);
			if (stat && typeof vault.onChange === 'function' && !this.app.vault.getAbstractFileByPath(nPath)) {
				await vault.onChange('file-created', nPath, null, stat);
			}
			const created = this.app.vault.getAbstractFileByPath(nPath);
			return created instanceof TFile ? created : null;
		};

		(vault as unknown as PatchedVault).createBinary = async (path: string, data: ArrayBuffer, options?: unknown): Promise<TFile | null> => {
			const nPath = normalizePath(path);
			if (!this.pathMapper.getMountForPath(nPath)) {
				return (this.originalVaultCreateBinary as OrigVaultCreateBinary)(path, data, options);
			}

			try {
				await (this.originalVaultCreateBinary as OrigVaultCreateBinary)(path, data, options);
			} catch (e) {
				logger.debug('[Folder Bridge] vault.createBinary() rejected for virtual path, using manual registration:', e);
			}

			const existingBin = this.app.vault.getAbstractFileByPath(nPath);
			const existing = existingBin instanceof TFile ? existingBin : null;
			if (existing) return existing;

			try {
				await vault.adapter.writeBinary(nPath, data, options as DataWriteOptions | undefined);
			} catch {
				// File may already have been written by the failed vault.createBinary().
			}
			const stat = await vault.adapter.stat(nPath);
			if (stat && typeof vault.onChange === 'function' && !this.app.vault.getAbstractFileByPath(nPath)) {
				await vault.onChange('file-created', nPath, null, stat);
			}
			const createdBin = this.app.vault.getAbstractFileByPath(nPath);
			return createdBin instanceof TFile ? createdBin : null;
		};
	}

	// ------------------------------------------------------------------
	// Mount management
	// ------------------------------------------------------------------

	async addMount(mountData: Omit<MountPoint, 'id'>): Promise<void> {
		const mountType = (mountData as MountPoint).mountType;
		const isCloud = mountType === 'webdav' || mountType === 's3' || mountType === 'sftp';
		const existingMounts = this.settings.mountPoints;

		// Validate against existing mounts; cloud mounts skip local-path validation
		const error = this.security.validateMount(mountData, existingMounts);
		if (error) {
			new Notice(`Folder Bridge: ${error}`);
			return;
		}
		if (!isCloud) {
			// Surface advisory warnings (UNC paths, real-path overlaps) for local mounts
			const warnings = this.security.getPathWarnings(mountData.realPath, existingMounts, mountType);
			for (const w of warnings) {
				new Notice(`Folder Bridge warning: ${w}`, 10_000);
			}
		}

		// Strip ALL transient credential fields before persisting to data.json
		const {
			webdavPassword,
			s3SecretKey,
			sftpPassword,
			sftpPassphrase,
			...mountDataClean
		} = mountData as MountPoint;

		const mount: MountPoint = {
			...mountDataClean,
			id: generateId(),
			deviceId: this.settings.deviceId,
			// Vault mounts get a broader default ignore list
			ignoreList: mountDataClean.mountType === 'vault'
				? ['.git', 'node_modules', this.app.vault.configDir, '.trash', '.smart-connections']
				: ['.git', 'node_modules', this.app.vault.configDir]
		};

		if (this.canPersistToManagedToc(mount.mountType)) {
			if (!await this.writeManagedTocMounts([...this.getManagedTocDraftMounts(), mount])) {
				return;
			}
			await this.refreshTocMountSources(true);
		} else {
			this.persistedMountPoints.push(mount);
		}

		// Register in allowlist (local mounts only — cloud mounts have no local path)
		if (!isCloud && !this.canPersistToManagedToc(mount.mountType) && !this.persistedAllowlist.includes(mount.realPath)) {
			this.persistedAllowlist.push(mount.realPath);
			this.security.allow(mount.realPath);
		}

		// Wire up WebDAV adapter
		if (mount.mountType === 'webdav') {
			if (webdavPassword) {
				saveWebDAVPassword(mount.id, webdavPassword);
				const encrypted = encryptCredential(webdavPassword);
				if (encrypted) {
					mount.encryptedWebdavPassword = encrypted;
					await this.saveSettings();
				}
			}
			const adapter = WebDAVAdapter.fromMount(mount);
			if (adapter) this.virtualAdapter?.setWebDAVAdapter(mount.id, adapter);
		}

		// Wire up S3 adapter
		if (mount.mountType === 's3') {
			if (s3SecretKey) {
				saveSessionCredential('s3', mount.id, s3SecretKey);
				const encrypted = encryptCredential(s3SecretKey);
				if (encrypted) {
					mount.encryptedS3SecretKey = encrypted;
					await this.saveSettings();
				}
			}
			const s3 = S3Adapter.fromMount(mount);
			if (s3) this.virtualAdapter?.setS3Adapter(mount.id, s3);
		}

		// Wire up SFTP adapter
		if (mount.mountType === 'sftp') {
			if (sftpPassword) {
				saveSessionCredential('sftp-pw', mount.id, sftpPassword);
				const encrypted = encryptCredential(sftpPassword);
				if (encrypted) {
					mount.encryptedSftpPassword = encrypted;
					await this.saveSettings();
				}
			}
			if (sftpPassphrase) {
				saveSessionCredential('sftp-pp', mount.id, sftpPassphrase);
				const encrypted = encryptCredential(sftpPassphrase);
				if (encrypted) {
					mount.encryptedSftpPassphrase = encrypted;
					await this.saveSettings();
				}
			}
			const sftpAdapter = SFTPAdapter.fromMount(mount);
			if (sftpAdapter) this.virtualAdapter?.setSFTPAdapter(mount.id, sftpAdapter);
		}

		await this.saveSettings();
		this.syncEffectiveMountState();
		this.updateStatusBar();
		const runtimeMount = this.settings.mountPoints.find(existing => existing.id === mount.id) ?? mount;

		// Register the mount's real path with the streaming server (local mounts only)
		if (!isCloud && runtimeMount.realPath) this.fileServer.addAllowedPath(runtimeMount.realPath);

		backgroundTask(this.notifyVaultMountAdded(runtimeMount), `Failed to inject newly-added mount "${runtimeMount.virtualPath}" into the vault tree.`);

		let mountLabel: string;
		if (runtimeMount.mountType === 'webdav') {
			mountLabel = `"${runtimeMount.webdavUrl}" → "${runtimeMount.virtualPath}"`;
		} else if (runtimeMount.mountType === 's3') {
			mountLabel = `s3://${runtimeMount.s3Bucket}${runtimeMount.realPath} → "${runtimeMount.virtualPath}"`;
		} else if (runtimeMount.mountType === 'sftp') {
			mountLabel = `sftp://${runtimeMount.sftpHost}${runtimeMount.realPath} → "${runtimeMount.virtualPath}"`;
		} else {
			mountLabel = `"${runtimeMount.realPath}" → "${runtimeMount.virtualPath}"`;
		}
		new Notice(`Folder Bridge: Mounted ${mountLabel}`);
	}

	async removeMount(id: string): Promise<void> {
		const idx = this.persistedMountPoints.findIndex(m => m.id === id);
		if (idx === -1) {
			const managedIndex = this.getManagedTocIndex(id);
			if (managedIndex === -1) return;

			const mount = this.managedTocMountPoints[managedIndex];
			await this.notifyVaultMountRemoved(mount);

			const nextManagedMounts = this.getManagedTocDraftMounts().filter(existing => existing.id !== id);
			if (!await this.writeManagedTocMounts(nextManagedMounts)) {
				if (mount.enabled) {
					await this.notifyVaultMountAdded(mount);
				}
				return;
			}

			await this.refreshTocMountSources(true);
			await this.saveSettings();
			this.updateStatusBar();
			new Notice(`Folder Bridge: Removed mount "${mount.virtualPath}".`);
			return;
		}

		const mount = this.persistedMountPoints[idx];

		// [BUGFIX_20260222] Remove from vault tree BEFORE removing from pathMapper so stat() still resolves
		await this.notifyVaultMountRemoved(mount);

		this.persistedMountPoints.splice(idx, 1);

		// Only revoke the allowlist entry if no other active mount shares the real path
		const stillUsed = this.persistedMountPoints.some(m => m.realPath === mount.realPath);
		if (!stillUsed) {
			this.persistedAllowlist = this.persistedAllowlist.filter(p => p !== mount.realPath);
			this.security.revoke(mount.realPath);
			// Revoke streaming-server access for this real path
			if (mount.realPath) this.fileServer.removeAllowedPath(mount.realPath);
		}

		// Tear down adapters and clear stored credentials
		if (mount.mountType === 'webdav') {
			this.virtualAdapter?.clearWebDAVAdapter(mount.id);
			clearWebDAVPassword(mount.id);
			if (mount.encryptedWebdavPassword) {
				delete mount.encryptedWebdavPassword;
				await this.saveSettings();
			}
		} else if (mount.mountType === 's3') {
			this.virtualAdapter?.clearS3Adapter(mount.id);
			clearSessionCredential('s3', mount.id);
			if (mount.encryptedS3SecretKey) {
				delete mount.encryptedS3SecretKey;
				await this.saveSettings();
			}
		} else if (mount.mountType === 'sftp') {
			this.virtualAdapter?.clearSFTPAdapter(mount.id);
			clearSessionCredential('sftp-pw', mount.id);
			clearSessionCredential('sftp-pp', mount.id);
			if (mount.encryptedSftpPassword) {
				delete mount.encryptedSftpPassword;
			}
			if (mount.encryptedSftpPassphrase) {
				delete mount.encryptedSftpPassphrase;
			}
			await this.saveSettings();
		}

		await this.saveSettings();
		this.syncEffectiveMountState();
		this.updateStatusBar();

		new Notice(`Folder Bridge: Removed mount "${mount.virtualPath}".`);
	}

	/**
	 * Update an existing mount in-place.  Handles vault-tree re-injection when
	 * the virtual path or real path changes, and keeps the allowlist in sync.
	 */
	/**
	 * Flip the read-only flag for a single mount, clear its one-shot notice
	 * record, persist settings, and show a confirmation Notice.
	 * @param skipNotice  Pass true when batch-toggling all mounts (caller shows a single summary Notice).
	 */
	async setMountReadOnly(id: string, readOnly: boolean, skipNotice = false): Promise<void> {
		const mount = this.persistedMountPoints.find(m => m.id === id);
		if (mount) {
			mount.readOnly = readOnly;
			this.virtualAdapter?.clearReadOnlyNotice(id);
			await this.saveSettings();
			this.syncEffectiveMountState();
			if (!skipNotice) {
				new Notice(`Folder Bridge: “${mount.label || mount.virtualPath}” is now ${readOnly ? 'read-only' : 'writable'}.`);
			}
			return;
		}

		const managedIndex = this.getManagedTocIndex(id);
		if (managedIndex === -1) return;

		const nextManagedMounts = this.getManagedTocDraftMounts();
		nextManagedMounts[managedIndex] = {
			...nextManagedMounts[managedIndex],
			readOnly,
		};
		if (!await this.writeManagedTocMounts(nextManagedMounts)) return;

		this.virtualAdapter?.clearReadOnlyNotice(id);
		await this.refreshTocMountSources(true);
		await this.saveSettings();
		const updatedMount = this.settings.mountPoints.find(existing => existing.id === id);
		if (!skipNotice && updatedMount) {
			new Notice(`Folder Bridge: “${updatedMount.label || updatedMount.virtualPath}” is now ${readOnly ? 'read-only' : 'writable'}.`);
		}
	}

	async updateMount(id: string, newData: Omit<MountPoint, 'id'>): Promise<void> {
		const idx = this.persistedMountPoints.findIndex(m => m.id === id);
		if (idx === -1) {
			const managedIndex = this.getManagedTocIndex(id);
			if (managedIndex === -1) return;

			const oldMount = this.managedTocMountPoints[managedIndex];
			const otherMounts = this.settings.mountPoints.filter(m => m.id !== id);
			const error = this.security.validateMount(newData, otherMounts);
			if (error) {
				new Notice(`Folder Bridge: ${error}`);
				return;
			}

			const wasEnabled = oldMount.enabled;
			const virtualPathChanged = normalizePath(oldMount.virtualPath) !== normalizePath(newData.virtualPath);
			const realPathChanged = oldMount.realPath !== newData.realPath;
			const visibleFileFilterChanged = oldMount.visibleFileFilter !== newData.visibleFileFilter;

			if (wasEnabled && (virtualPathChanged || realPathChanged || visibleFileFilterChanged)) {
				await this.notifyVaultMountRemoved(oldMount);
			}

			const nextManagedMounts = this.getManagedTocDraftMounts();
			nextManagedMounts[managedIndex] = {
				...nextManagedMounts[managedIndex],
				...newData,
				id,
			};

			if (!await this.writeManagedTocMounts(nextManagedMounts)) {
				if (wasEnabled && (virtualPathChanged || realPathChanged || visibleFileFilterChanged)) {
					await this.notifyVaultMountAdded(oldMount);
				}
				return;
			}

			await this.refreshTocMountSources(true);
			await this.saveSettings();
			this.updateStatusBar();

			const updatedMount = this.settings.mountPoints.find(existing => existing.id === id);
			if (!updatedMount) return;

			if (wasEnabled && (virtualPathChanged || realPathChanged || visibleFileFilterChanged)) {
				await this.notifyVaultMountAdded(updatedMount);
			}

			const watcherSettingsChanged =
				oldMount.visibleFileFilter !== updatedMount.visibleFileFilter ||
				oldMount.watcherSuppressAllEvents !== updatedMount.watcherSuppressAllEvents ||
				oldMount.watcherCreateFilter !== updatedMount.watcherCreateFilter ||
				oldMount.watcherDebounceMs !== updatedMount.watcherDebounceMs ||
				oldMount.watcherUsePolling !== updatedMount.watcherUsePolling ||
				oldMount.watcherPollingIntervalMs !== updatedMount.watcherPollingIntervalMs;
			if ((realPathChanged || watcherSettingsChanged) && wasEnabled) {
				this.fileWatcher?.stopWatching(oldMount);
				this.fileWatcher?.startWatching(updatedMount);
			}

			new Notice(`Folder Bridge: Updated "${updatedMount.virtualPath}".`);
			return;
		}

		const oldMount = this.persistedMountPoints[idx];

		// Validate against all OTHER mounts (exclude the one being edited)
		const otherMounts = this.settings.mountPoints.filter(m => m.id !== id);
		const error = this.security.validateMount(newData, otherMounts);
		if (error) {
			new Notice(`Folder Bridge: ${error}`);
			return;
		}

		const wasEnabled = oldMount.enabled;
		const virtualPathChanged = normalizePath(oldMount.virtualPath) !== normalizePath(newData.virtualPath);
		const realPathChanged = oldMount.realPath !== newData.realPath;
		const visibleFileFilterChanged = oldMount.visibleFileFilter !== newData.visibleFileFilter;

		// Remove from vault tree before mutating PathMapper state
		if (wasEnabled && (virtualPathChanged || realPathChanged || visibleFileFilterChanged)) {
			await this.notifyVaultMountRemoved(oldMount);
		}

		// Keep allowlist in sync when real path changes (local mounts only)
		const newMountType = (newData as MountPoint).mountType;
		const newIsCloud = newMountType === 'webdav' || newMountType === 's3' || newMountType === 'sftp';
		const oldIsCloud = oldMount.mountType === 'webdav' || oldMount.mountType === 's3' || oldMount.mountType === 'sftp';
		if (realPathChanged) {
			if (!oldIsCloud) {
				const stillUsed = otherMounts.some(m => m.realPath === oldMount.realPath);
				if (!stillUsed) {
					this.persistedAllowlist = this.persistedAllowlist.filter(p => p !== oldMount.realPath);
					this.security.revoke(oldMount.realPath);
				}
			}
			if (!newIsCloud && !this.persistedAllowlist.includes(newData.realPath)) {
				this.persistedAllowlist.push(newData.realPath);
				this.security.allow(newData.realPath);
			}
		}

		// Preserve id, deviceId, ignoreList, and deviceOverrides from the original
		this.persistedMountPoints[idx] = {
			...oldMount,
			...newData,
			id,
		};

		await this.saveSettings();
		this.syncEffectiveMountState();
		this.updateStatusBar();

		const updatedMount = this.persistedMountPoints[idx];

		// Re-inject when enabled and something structural changed
		if (wasEnabled && (virtualPathChanged || realPathChanged || visibleFileFilterChanged)) {
			backgroundTask(this.notifyVaultMountAdded(updatedMount), `Failed to refresh edited mount "${updatedMount.virtualPath}" in the vault tree.`);
		}

		// Restart watcher when real path or any watcher-related setting changes.
		// The chokidar callbacks capture `mount` by reference at startWatching() time.
		// If the mount object is replaced (as updateMount() does via spread merge) without
		// restarting the watcher, the closure reads stale values — e.g. watcherSuppressAllEvents
		// set to true in Settings would have no effect until the plugin is reloaded.
		const watcherSettingsChanged =
			oldMount.visibleFileFilter !== updatedMount.visibleFileFilter ||
			oldMount.watcherSuppressAllEvents !== updatedMount.watcherSuppressAllEvents ||
			oldMount.watcherCreateFilter !== updatedMount.watcherCreateFilter ||
			oldMount.watcherDebounceMs !== updatedMount.watcherDebounceMs ||
			oldMount.watcherUsePolling !== updatedMount.watcherUsePolling ||
			oldMount.watcherPollingIntervalMs !== updatedMount.watcherPollingIntervalMs;
		if ((realPathChanged || watcherSettingsChanged) && wasEnabled) {
			this.fileWatcher?.stopWatching(oldMount);
			this.fileWatcher?.startWatching(updatedMount);
		}

		// Recreate adapters when mount type or credentials change
		if (updatedMount.mountType === 'webdav') {
			const { webdavPassword } = newData as MountPoint;
			if (webdavPassword) {
				saveWebDAVPassword(id, webdavPassword);
				const encrypted = encryptCredential(webdavPassword);
				if (encrypted) {
					this.persistedMountPoints[idx].encryptedWebdavPassword = encrypted;
					await this.saveSettings();
				}
			}
			this.virtualAdapter?.clearWebDAVAdapter(id);
			const adapter = WebDAVAdapter.fromMount(updatedMount);
			if (adapter) this.virtualAdapter?.setWebDAVAdapter(id, adapter);
		} else if (oldMount.mountType === 'webdav') {
			this.virtualAdapter?.clearWebDAVAdapter(id);
			clearWebDAVPassword(id);
		}

		if (updatedMount.mountType === 's3') {
			const { s3SecretKey } = newData as MountPoint;
			if (s3SecretKey) {
				saveSessionCredential('s3', id, s3SecretKey);
				const encrypted = encryptCredential(s3SecretKey);
				if (encrypted) {
					this.persistedMountPoints[idx].encryptedS3SecretKey = encrypted;
					await this.saveSettings();
				}
			}
			this.virtualAdapter?.clearS3Adapter(id);
			const s3 = S3Adapter.fromMount(updatedMount);
			if (s3) this.virtualAdapter?.setS3Adapter(id, s3);
		} else if (oldMount.mountType === 's3') {
			this.virtualAdapter?.clearS3Adapter(id);
			clearSessionCredential('s3', id);
		}

		if (updatedMount.mountType === 'sftp') {
			const { sftpPassword, sftpPassphrase } = newData as MountPoint;
			if (sftpPassword) {
				saveSessionCredential('sftp-pw', id, sftpPassword);
				const encrypted = encryptCredential(sftpPassword);
				if (encrypted) {
					this.persistedMountPoints[idx].encryptedSftpPassword = encrypted;
					await this.saveSettings();
				}
			}
			if (sftpPassphrase) {
				saveSessionCredential('sftp-pp', id, sftpPassphrase);
				const encrypted = encryptCredential(sftpPassphrase);
				if (encrypted) {
					this.persistedMountPoints[idx].encryptedSftpPassphrase = encrypted;
					await this.saveSettings();
				}
			}
			this.virtualAdapter?.clearSFTPAdapter(id);
			const sftpAdapter = SFTPAdapter.fromMount(updatedMount);
			if (sftpAdapter) this.virtualAdapter?.setSFTPAdapter(id, sftpAdapter);
		} else if (oldMount.mountType === 'sftp') {
			this.virtualAdapter?.clearSFTPAdapter(id);
			clearSessionCredential('sftp-pw', id);
			clearSessionCredential('sftp-pp', id);
		}

		new Notice(`Folder Bridge: Updated "${updatedMount.virtualPath}".`);
	}

	// ------------------------------------------------------------------
	// Vault file-tree injection
	// ------------------------------------------------------------------

	/**
	 * Notify Obsidian's internal vault index that a new virtual mount folder
	 * exists so it appears in the file explorer without requiring a restart.
	 *
	 * Obsidian's internal `vault.onChange('created', path)` is the same hook
	 * the OS file-watcher uses to signal new paths.  Because our VirtualAdapter
	 * intercepts `adapter.stat()`, Obsidian correctly identifies each segment
	 * as a folder and inserts it into its internal TFolder tree.
	 */
	async notifyVaultMountAdded(mount: MountPoint): Promise<void> {
		const vault = this.app.vault as typeof this.app.vault & VaultInternal;

		if (typeof vault.onChange !== 'function') {
			logger.debug("vault.onChange is not a function!");
			return;
		}

		// Walk every path segment so intermediate virtual folders also appear
		// (e.g. mounting "Projects/Work" also surfaces the "Projects" folder).
		const segments = normalizePath(mount.virtualPath).split('/');
		for (let i = 1; i <= segments.length; i++) {
			const partPath = segments.slice(0, i).join('/');
			// Skip segments Obsidian already knows about
			if (this.app.vault.getAbstractFileByPath(partPath)) continue;
			try {
				await vault.onChange('folder-created', partPath, null, null);
			} catch (e) {
				logger.debug('Folder Bridge: vault.onChange(folder-created) unavailable', e);
			}
		}

		// Recursively notify Obsidian about all files and folders inside the mount
		const suppressionEnabled = !!mount.watcherSuppressAllEvents;

		const notice = new Notice(`Folder Bridge: Scanning and mounting "${mount.virtualPath}"...`, 0);
		const { fileCount, folderCount, scanLimitHit } = await replayMountContentsToVault(mount, {
			list: (folderPath) => this.app.vault.adapter.list(folderPath),
			stat: (filePath) => this.app.vault.adapter.stat(filePath),
			hasAbstractFile: (path) => !!this.app.vault.getAbstractFileByPath(path),
			isIgnored: (name, activeMount, mountRelativePath) => this.isNameIgnored(name, activeMount, mountRelativePath),
			onFolderCreated: (path) => vault.onChange('folder-created', path, null, null),
			onFileCreated: (path, stat) => vault.onChange('file-created', path, null, stat),
			onHugeMount: () => {
				new Notice(`Folder Bridge: "${mount.virtualPath}" is very large. This may take a moment...`);
			},
			onError: (folderPath, error) => {
				logger.debug(`Folder Bridge: Failed to list ${folderPath}`, error);
			},
		});
		notice.hide();
		if (scanLimitHit) {
			const scanLimit = mount.maxFiles ?? 0;
			new Notice(
				`Folder Bridge: Scan limit (${scanLimit.toLocaleString()} items) reached for "${mount.virtualPath}". ` +
				`Increase "Max files" in mount advanced settings to surface more.`,
				10000
			);
		}
		if (suppressionEnabled) {
			new Notice(`Folder Bridge: Mounted "${mount.virtualPath}" with external file events suppressed.`);
		} else {
			new Notice(`Folder Bridge: Mounted ${folderCount} folders and ${fileCount} files in "${mount.virtualPath}".`);
			try {
				await vault.onChange('raw', normalizePath(mount.virtualPath), null, null);
			} catch (e) {
				logger.debug('Folder Bridge: vault.onChange(raw) unavailable', e);
			}
		}

		// Force the file explorer to refresh the folder contents by expanding and collapsing it
		if (!suppressionEnabled) setTimeout(() => {
			const fileExplorerLeaves = this.app.workspace.getLeavesOfType('file-explorer');
			if (fileExplorerLeaves.length === 0) return;

			type FileExplorerView = { fileItems?: Record<string, { setCollapsed?: (collapsed: boolean) => void }> };
			const fileExplorerView = fileExplorerLeaves[0].view as unknown as FileExplorerView;
			const fileItems = fileExplorerView.fileItems;

			const folderPath = normalizePath(mount.virtualPath);
			if (fileItems && fileItems[folderPath]) {
				const folderItem = fileItems[folderPath];
				if (typeof folderItem.setCollapsed === 'function') {
					folderItem.setCollapsed(false);
				}
			}
		}, 100);

		// [FEATURE_20260222] Start watching the mount for external changes
		this.fileWatcher?.startWatching(mount);
	}

	/**
	 * Remove a virtual mount folder from Obsidian's internal vault index
	 * so the file explorer stops showing it immediately after removal.
	 *
	 * [BUGFIX_20260222] This method must be called BEFORE the mount is removed
	 * from the PathMapper, otherwise adapter.list() will fail to resolve the
	 * virtual paths to real paths, and the files will remain orphaned in the UI.
	 */
	async notifyVaultMountRemoved(mount: MountPoint): Promise<void> {
		// [FEATURE_20260222] Stop watching the mount for external changes
		this.fileWatcher?.stopWatching(mount);

		const vault = this.app.vault as typeof this.app.vault & VaultInternal;
		if (typeof vault.onChange !== 'function') return;

		const nPath = normalizePath(mount.virtualPath);
		const mountFolder = this.app.vault.getAbstractFileByPath(nPath);
		if (!mountFolder) return;

		// Recursively remove all files and folders inside the mount using the
		// vault's in-memory tree.  This avoids calling adapter.list() (which
		// routes through VirtualAdapter and makes real FS / network calls) and
		// therefore prevents the "list: found mount for" log spam, eliminates
		// unnecessary I/O, and stops the visible file-explorer flicker caused
		// by the adapter re-enumerating the directory while files are being
		// removed.
		const recursivelyRemoveVault = async (folder: TFolder): Promise<void> => {
			for (const child of [...folder.children]) {
				if (child instanceof TFolder) {
					await recursivelyRemoveVault(child);
					logger.debug(`[FolderBridge] Removing folder from UI: ${child.path}`);
					await vault.onChange('folder-removed', child.path, null, null);
				} else {
					logger.debug(`[FolderBridge] Removing file from UI: ${child.path}`);
					await vault.onChange('file-removed', child.path, null, null);
				}
			}
		};

		if (mountFolder instanceof TFolder) {
			await recursivelyRemoveVault(mountFolder);
		}

		try {
			logger.debug(`[FolderBridge] Removing root mount folder from UI: ${nPath}`);
			await vault.onChange('folder-removed', nPath, null, null);
		} catch (e) {
			logger.debug('Folder Bridge: vault.onChange(folder-removed) unavailable', e);
		}
	}

	// ------------------------------------------------------------------
	// Ignore-list helpers
	// ------------------------------------------------------------------

	/**
	 * Rebuild the ignore cache and immediately remove from Obsidian's vault
	 * index any files/folders under `mount` that are now matched by the
	 * current ignore list.  Call this after adding a new pattern so the file
	 * explorer hides matching items without requiring a restart.
	 */
	async applyIgnoreListToVault(mount: MountPoint): Promise<void> {
		this.updateIgnoreCache();

		const vault = this.app.vault as typeof this.app.vault & VaultInternal;
		if (typeof vault.onChange !== 'function') return;

		const mountPath = normalizePath(mount.virtualPath);
		const mountFolder = this.app.vault.getAbstractFileByPath(mountPath);
		if (!(mountFolder instanceof TFolder)) return;

		const recursivelyRemoveIgnored = async (folder: TFolder): Promise<void> => {
			for (const child of [...folder.children]) {
				const mountRelative = child.path.startsWith(mountPath + '/')
					? child.path.slice(mountPath.length + 1)
					: child.path;
				if (this.isNameIgnored(child.name, mount, mountRelative)) {
					try {
						if (child instanceof TFolder) {
							await vault.onChange('folder-removed', child.path, null, null);
						} else {
							await vault.onChange('file-removed', child.path, null, null);
						}
					} catch (e) {
						logger.debug('Folder Bridge: Failed to remove ignored item from vault view', e);
					}
				} else if (child instanceof TFolder) {
					await recursivelyRemoveIgnored(child);
				}
			}
		};

		await recursivelyRemoveIgnored(mountFolder);
	}

	// ------------------------------------------------------------------
	// Mount health checking
	// ------------------------------------------------------------------

	/**
	 * Start the background 30-second reachability loop.
	 * Runs one immediate check on call, then fires every CHECK_INTERVAL_MS.
	 * When reachability changes, fires a Notice and refreshes the status bar.
	 */
	private startHealthChecks(): void {
		const CHECK_INTERVAL_MS = 30_000;

		const runCheck = async () => {
			// Avoid churning I/O while Obsidian is in the background
			if (typeof document !== 'undefined' && document.hidden) return;

			const activeMounts = this.settings.mountPoints.filter(
				m => m.enabled && (m.deviceId === this.settings.deviceId || this.settings.allowForeignMounts)
			);

			let anyChanged = false;
			for (const mount of activeMounts) {
				let reachable = false;
				try {
					if (mount.mountType === 'webdav') {
						const adapter = WebDAVAdapter.fromMount(mount);
						if (adapter) reachable = await adapter.exists(mount.realPath);
					} else if (mount.mountType === 's3') {
						const s3 = S3Adapter.fromMount(mount);
						if (s3) reachable = (await s3.testConnection()) === null;
					} else if (mount.mountType === 'sftp') {
						const sftpAdapter = SFTPAdapter.fromMount(mount);
						if (sftpAdapter) reachable = (await sftpAdapter.testConnection()) === null;
					} else {
						// Local mounts require Node.js fs — unavailable on mobile
						if (fs && fs.promises) {
							const realPath = this.pathMapper.getEffectiveRealPath(mount);
							await fs.promises.access(realPath, fs.constants.F_OK);
							reachable = true;
						}
					}
				} catch {
					reachable = false;
				}
				const prev = this.mountHealthMap.get(mount.id);
				if (prev !== reachable) {
					this.mountHealthMap.set(mount.id, reachable);
					anyChanged = true;
					if (!reachable && prev === true) {
						new Notice(
							`Folder Bridge: "${mount.label || mount.virtualPath}" is unreachable. ` +
							`Check that the path exists and is accessible on this device.`,
							8000
						);
					} else if (reachable && prev === false) {
						new Notice(
							`Folder Bridge: "${mount.label || mount.virtualPath}" is back online.`,
							4000
						);
					}
				}
			}
			if (anyChanged) this.updateStatusBar();
		};

		void runCheck(); // immediate first pass
		this.healthCheckInterval = setInterval(() => void runCheck(), CHECK_INTERVAL_MS);
	}

	/**
	 * Re-check whether mount's real path is accessible now.
	 * If it is, remove stale vault-tree entries and re-inject the mount.
	 * Called from the settings tab "Reconnect" button.
	 */
	async reconnectMount(mount: MountPoint): Promise<void> {
		let reachable = false;
		try {
			if (mount.mountType === 'webdav') {
				const adapter = WebDAVAdapter.fromMount(mount);
				if (adapter) reachable = await adapter.exists(mount.realPath);
			} else if (mount.mountType === 's3') {
				const s3 = S3Adapter.fromMount(mount);
				if (s3) reachable = (await s3.testConnection()) === null;
			} else if (mount.mountType === 'sftp') {
				const sftpAdapter = SFTPAdapter.fromMount(mount);
				if (sftpAdapter) reachable = (await sftpAdapter.testConnection()) === null;
			} else {
				if (fs && fs.promises) {
					const realPath = this.pathMapper.getEffectiveRealPath(mount);
					await fs.promises.access(realPath, fs.constants.F_OK);
					reachable = true;
				}
			}
		} catch {
			reachable = false;
		}
		this.mountHealthMap.set(mount.id, reachable);

		if (!reachable) {
			new Notice(`Folder Bridge: "${mount.label || mount.virtualPath}" is still unreachable.`, 5000);
			this.updateStatusBar();
			return;
		}

		// Clean up any stale vault-tree remnants before re-injecting
		await this.notifyVaultMountRemoved(mount);
		await this.notifyVaultMountAdded(mount);
		new Notice(`Folder Bridge: "${mount.label || mount.virtualPath}" reconnected successfully.`);
		this.updateStatusBar();
	}

	// ------------------------------------------------------------------
	// Status bar
	// ------------------------------------------------------------------

	/**
	 * Temporarily suppress (or restore) vault-event dispatching for one mount
	 * or for all mounts at once.  Suppression state is runtime-only: it resets
	 * the next time the plugin is reloaded.
	 *
	 * **Why this is useful:** External sync tools (Obsidian Sync, rclone, rsync,
	 * Syncthing…) write files directly to the bridged folder on disk.  Chokidar
	 * detects those writes and FolderBridge forwards them as vault events, which
	 * causes attachment-rename or note-refactor plugins to react as if the files
	 * were freshly created by the user.  By muting events around a sync window
	 * you prevent those spurious reactions while still letting user-initiated
	 * actions (e.g. paste image from clipboard) go through Obsidian's own
	 * internal vault path, which is unaffected by this flag.
	 *
	 * **Usage from external scripts** (Templater, JS Engine, QuickAdd, etc.):
	 * ```js
	 * const fb = app.plugins.getPlugin('folderbridge');
	 * fb.setWatcherSuppressed(null, true);           // mute all mounts
	 * // … wait for sync to finish …
	 * fb.setWatcherSuppressed(null, false);          // restore all mounts
	 *
	 * // Or target a single mount by its id (visible in Folder Bridge settings):
	 * fb.setWatcherSuppressed('abc123def', true);
	 * ```
	 *
	 * @param mountId  The mount's `id` string, or `null` to affect every mount.
	 * @param suppress `true` to mute events, `false` to restore them.
	 */
	setWatcherSuppressed(mountId: string | null, suppress: boolean): void {
		this.fileWatcher?.setSuppressed(mountId, suppress);
		this.updateStatusBar();
	}

	updateStatusBar(): void {
		if (!this.statusBarItem) return;
		const active = this.settings.mountPoints.filter(m => m.enabled).length;
		const unreachableCount = [...this.mountHealthMap.values()].filter(v => v === false).length;
		const allSuppressed = this.fileWatcher?.isSuppressedAll() ?? false;
		if (allSuppressed) {
			this.statusBarItem.setText(`${this.manifest.name}: events paused`);
			this.statusBarItem.classList.remove('folderbridge-status-warning');
			this.statusBarItem.classList.add('folderbridge-status-suppressed');
		} else if (unreachableCount > 0) {
			this.statusBarItem.setText(`Folder Bridge: ${unreachableCount} unreachable`);
			this.statusBarItem.classList.remove('folderbridge-status-suppressed');
			this.statusBarItem.classList.add('folderbridge-status-warning');
		} else {
			this.statusBarItem.setText(`Folder Bridge: ${active} mount${active !== 1 ? 's' : ''}`);
			this.statusBarItem.classList.remove('folderbridge-status-suppressed', 'folderbridge-status-warning');
		}
	}

	// ------------------------------------------------------------------
	// Settings persistence
	// ------------------------------------------------------------------

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
		this.settings.managedTocSource = this.settings.managedTocSource ?? '';
		this.persistedMountPoints = [...this.settings.mountPoints];
		this.persistedAllowlist = [...this.settings.allowlist];

		// Generate a unique device ID if one doesn't exist
		if (!this.settings.deviceId) {
			this.settings.deviceId = generateId();
		}

		// Back-compat: assign ids to mounts created before the id field existed
		for (const m of this.persistedMountPoints) {
			if (!m.id) m.id = generateId();
			// Back-compat: assign deviceId to mounts created before deviceId existed
			if (!m.deviceId) m.deviceId = this.settings.deviceId;
		}

		// Back-compat: migrate global ignoreList to per-mount ignoreList
		const legacySettings = this.settings as FolderBridgeSettings & Record<string, unknown>;
		if (legacySettings['ignoreList'] && Array.isArray(legacySettings['ignoreList'])) {
			const legacyIgnoreList = legacySettings['ignoreList'] as string[];
			for (const m of this.persistedMountPoints) {
				if (!m.ignoreList) {
					m.ignoreList = [...legacyIgnoreList];
				}
			}
			delete legacySettings['ignoreList'];
		}

		this.syncEffectiveMountState();
		await this.refreshTocMountSources();
		await this.saveSettings();
		this.updateIgnoreCache();
	}

	async saveSettings() {
		// Strip transient webdavPassword field before persisting — it must never
		// reach data.json.  We deep-clone only the mount points array to avoid
		// mutating the live in-memory objects.
		const dataToSave = {
			...this.settings,
			allowlist: [...this.persistedAllowlist],
			mountPoints: this.persistedMountPoints.map(m => {
				const rest = { ...m };
				delete rest.webdavPassword;
				delete rest.s3SecretKey;
				delete rest.sftpPassword;
				delete rest.sftpPassphrase;
				delete rest.tocSourcePath;
				return rest;
			}),
		};
		await this.saveData(dataToSave);
		this.updateIgnoreCache();
	}
}

// ---------------------------------------------------------------------------
// Settings tab
// ---------------------------------------------------------------------------

class FolderBridgeSettingTab extends PluginSettingTab {
	plugin: FolderBridgePlugin;
	private selectedIgnoreMountId: string | null = null;
	/** ID of the mount row being dragged (for reorder drag-drop). */
	private dragSrcId: string | null = null;

	constructor(app: App, plugin: FolderBridgePlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		// Render sync part, then trigger async refresh for mount statuses
		this.renderSync();
	}

	private renderSync(): void {
		const { containerEl } = this;
		containerEl.empty();
		const pluginName = this.plugin.manifest.name;
		const toc = 'TOC';
		const syncthing = 'Syncthing';
		const mb = 'MB';
		const dataUri = 'data: URI';
		const dsStore = '.DS_Store';
		const ctrlCmd = 'Ctrl / Cmd';

		// ── Header ──────────────────────────────────────────────────────

		const infoDiv = containerEl.createDiv('folderbridge-info-box');

		infoDiv.createEl('p', {
			text: `Platform: ${getPlatform()} | Device ID: ${this.plugin.settings.deviceId.substring(0, 8)}`,
			cls: 'setting-item-description folderbridge-info-meta',
		});

		const syncWarning = infoDiv.createEl('p', {
			cls: 'setting-item-description folderbridge-sync-warning',
		});
		syncWarning.createEl('strong', { text: 'Sync warning:' });
		syncWarning.appendText(' If you use Obsidian Sync or Syncthing, you ');
		syncWarning.createEl('strong', { text: 'Must' });
		syncWarning.appendText(' add your virtual folder names to your sync ignore list (e.g. ');
		syncWarning.createEl('code', { text: '.stignore' });
		syncWarning.appendText(' or Obsidian Sync Excluded Folders). Otherwise, your sync engine will try to upload the entire contents of your mounted folders!');

		// ── Global options ───────────────────────────────────────────────

		new Setting(containerEl)
			.setName('Dry-run mode')
			.setDesc('Log write operations to the console without executing them. Useful for debugging.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.dryRun)
				.onChange(val => {
					void (async () => {
						this.plugin.settings.dryRun = val;
						await this.plugin.saveSettings();
						this.plugin.virtualAdapter?.setDryRun(val);
					})();
				}));

		new Setting(containerEl)
			.setName('Show status bar item')
			.setDesc('Display the active mount count in Obsidian\'s status bar.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.showStatusBar)
				.onChange(val => {
					void (async () => {
						this.plugin.settings.showStatusBar = val;
						await this.plugin.saveSettings();

						// Dynamically show/hide the status bar item without requiring a reload
						if (val) {
							// Show status bar item if it doesn't exist yet
							if (!this.plugin.statusBarItem) {
								this.plugin.statusBarItem = this.plugin.addStatusBarItem();
								this.plugin.updateStatusBar();
							}
						} else {
							// Hide status bar item if it exists
							if (this.plugin.statusBarItem) {
								this.plugin.statusBarItem.remove();
								this.plugin.statusBarItem = null;
							}
						}
					})();
				}));

		new Setting(containerEl)
			.setName('Mount root deletion behavior')
			.setDesc('What should happen when you delete a mounted folder from the file explorer?')
			.addDropdown(drop => drop
				.addOption('ask', 'Ask me every time')
				.addOption('unmount', 'Unmount only (keep real files)')
				.addOption('delete', 'Delete permanently (destroy real files)')
				.setValue(this.plugin.settings.mountRootDeletionBehavior)
				.onChange((val: 'ask' | 'unmount' | 'delete') => {
					void (async () => {
						this.plugin.settings.mountRootDeletionBehavior = val;
						await this.plugin.saveSettings();
					})();
				})
			);

		new Setting(containerEl)
			.setName('Allow foreign mounts')
			.setDesc(`Allow mounting paths created on other devices. Enable this if you use ${syncthing} to sync the actual mounted folders across devices and the paths are identical.`)
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.allowForeignMounts)
				.onChange(val => {
					void (async () => {
						this.plugin.settings.allowForeignMounts = val;
						await this.plugin.saveSettings();
						this.display(); // Refresh to update toggle states
					})();
				}));

		new Setting(containerEl)
			.setName(`Image / PDF size cap (${mb})`)
			.setDesc(`Maximum file size that will be embedded as a ${dataUri} (used for images and PDFs in external mounts). Files larger than this fall back to a resource URL. Default: 10 ${mb}.`)
			.addText(text => text
				.setPlaceholder('10')
				.setValue(String(this.plugin.settings.maxDataUriMB ?? 10))
				.onChange(val => {
					void (async () => {
						const parsed = parseFloat(val);
						if (!isNaN(parsed) && parsed > 0) {
							this.plugin.settings.maxDataUriMB = parsed;
							await this.plugin.saveSettings();
							this.plugin.virtualAdapter?.setMaxDataUri(parsed * 1024 * 1024);
						}
					})();

					new Setting(containerEl)
							.setName(`Support ${pluginName}`)
						.setDesc('Follow ongoing work, browse other projects, or star the repository on GitHub.')
						.addButton(btn => btn
							.setButtonText('GitHub repo')
								.setTooltip(`Open the ${pluginName} repository`)
							.onClick(() => openExternalUrl(GITHUB_REPO_URL)))
						.addButton(btn => btn
							.setButtonText('More projects')
							.setTooltip('Open the author GitHub profile')
							.onClick(() => openExternalUrl(GITHUB_PROFILE_URL)));
				}));

		// ── Ignore Lists ─────────────────────────────────────────────────
		new Setting(containerEl).setName('Ignore lists').setHeading();

		// ── Global ignore patterns ───────────────────────────────────────
		new Setting(containerEl)
			.setName('Global ignore patterns')
			.setDesc('Patterns applied to every mount. Same syntax as per-mount patterns: plain names match any leaf, globs (*.tmp) match leaf names, paths with / match subtrees. Pre-populated with common OS noise files.')
			.setHeading();

		const globalIgnoreContainer = containerEl.createDiv('folderbridge-global-ignore');

		const renderGlobalIgnoreList = () => {
			globalIgnoreContainer.empty();
			const list = this.plugin.settings.globalIgnorePatterns || [];
			if (list.length === 0) {
				globalIgnoreContainer.createEl('p', {
					text: `No global patterns. Files like ${dsStore} are visible in all mounts.`,
					cls: 'setting-item-description'
				});
			}
			for (const item of list) {
				const itemEl = globalIgnoreContainer.createDiv('folderbridge-ignore-item');
				itemEl.createSpan({ text: item });
				const removeBtn = itemEl.createEl('button', { text: 'Remove' });
				removeBtn.onclick = () => {
					void (async () => {
						this.plugin.settings.globalIgnorePatterns = this.plugin.settings.globalIgnorePatterns.filter(i => i !== item);
						await this.plugin.saveSettings();
						this.plugin.updateIgnoreCachePublic();
						renderGlobalIgnoreList();
					})();
				};
			}
			const addContainer = globalIgnoreContainer.createDiv('folderbridge-ignore-add');
			const inputEl = addContainer.createEl('input', { type: 'text', placeholder: 'e.g. .DS_Store, Thumbs.db, *.tmp, node_modules' });
			const addBtn = addContainer.createEl('button', { text: 'Add' });
			addBtn.onclick = () => {
				void (async () => {
					const val = inputEl.value.trim();
					if (val) {
						if (!this.plugin.settings.globalIgnorePatterns) this.plugin.settings.globalIgnorePatterns = [];
						if (!this.plugin.settings.globalIgnorePatterns.includes(val)) {
							this.plugin.settings.globalIgnorePatterns.push(val);
							await this.plugin.saveSettings();
							this.plugin.updateIgnoreCachePublic();
							inputEl.value = '';
							renderGlobalIgnoreList();
						}
					}
				})();
			};
			inputEl.addEventListener('keypress', e => { if (e.key === 'Enter') addBtn.click(); });
		};
		renderGlobalIgnoreList();

		// ── Per-mount ignore lists ────────────────────────────────────────
		new Setting(containerEl)
			.setName('Per-mount ignore lists')
			.setDesc('Patterns applied to a specific mount only.')
			.setHeading();

		const editableMounts = this.plugin.settings.mountPoints.filter(m => this.plugin.isUserEditableMount(m));

		if (editableMounts.length === 0) {
			containerEl.createEl('p', {
				text: this.plugin.settings.tocSources.length > 0 || this.plugin.settings.managedTocSource.trim()
					? 'Ignore lists are editable for mounts you manage in settings or through the managed TOC file. External TOC mounts define ignore rules in their source file.'
					: 'Add a mount point first to configure its ignore list.',
				cls: 'setting-item-description',
			});
		} else {
			// Ensure a valid selection
			if (!this.selectedIgnoreMountId || !editableMounts.find(m => m.id === this.selectedIgnoreMountId)) {
				this.selectedIgnoreMountId = editableMounts[0].id;
			}

			new Setting(containerEl)
				.setName('Select mount')
				.setDesc('Choose which mount\'s ignore list to edit.')
				.addDropdown(drop => {
					for (const m of editableMounts) {
						drop.addOption(m.id, m.label || m.virtualPath);
					}
					drop.setValue(this.selectedIgnoreMountId!);
					drop.onChange(val => {
						this.selectedIgnoreMountId = val;
						this.display(); // Re-render to show the selected mount's list
					});
				});

			const selectedMount = editableMounts.find(m => m.id === this.selectedIgnoreMountId);
			if (selectedMount) {
				const ignoreListContainer = containerEl.createDiv('folderbridge-ignore-list');

				const renderIgnoreList = () => {
					ignoreListContainer.empty();

					const list = selectedMount.ignoreList || [];
					if (list.length === 0) {
						ignoreListContainer.createEl('p', { text: 'No items ignored for this mount.', cls: 'setting-item-description' });
					}

					for (const item of list) {
						const itemEl = ignoreListContainer.createDiv('folderbridge-ignore-item');
						itemEl.createSpan({ text: item });

						const removeBtn = itemEl.createEl('button', { text: 'Remove' });
						removeBtn.onclick = () => {
							void (async () => {
								selectedMount.ignoreList = selectedMount.ignoreList!.filter(i => i !== item);
								await this.plugin.persistEditableMountFromState(selectedMount);
								renderIgnoreList();
							})();
						};
					}

					const addContainer = ignoreListContainer.createDiv('folderbridge-ignore-add');

					const inputEl = addContainer.createEl('input', { type: 'text', placeholder: 'Name (e.g. .DS_Store) or path (e.g. vendor/cache)' });

					// Browse mount button — opens disk picker rooted at the mount's real path
					// Multi-select: all chosen folders are added to the ignore list immediately.
					const browseBtn = addContainer.createEl('button', { text: 'Browse…' });
					browseBtn.setAttribute('title', `Hold ${ctrlCmd} to select multiple folders`);
					browseBtn.onclick = () => {
						void (async () => {
							const selections = await browseMultipleFoldersOnDisk(
								`Select folder(s) to ignore in "${selectedMount.label || selectedMount.virtualPath}"`,
								selectedMount.realPath,
							);
							if (!selections?.length) return;

							const mountReal = selectedMount.realPath.replace(/\\/g, '/').replace(/\/$/, '');
							if (!selectedMount.ignoreList) selectedMount.ignoreList = [];

							let added = 0;
							for (const selected of selections) {
								const sel = selected.replace(/\\/g, '/').replace(/\/$/, '');
								const relative = sel.startsWith(mountReal + '/')
									? sel.slice(mountReal.length + 1)
									: sel;
								if (!selectedMount.ignoreList.includes(relative)) {
									selectedMount.ignoreList.push(relative);
									added++;
								}
							}

							if (added > 0) {
								await this.plugin.persistEditableMountFromState(selectedMount);
								await this.plugin.applyIgnoreListToVault(selectedMount);
								renderIgnoreList();
								new Notice(`Folder Bridge: Added ${added} item${added === 1 ? '' : 's'} to the ignore list.`);
							}
						})();
					};

					const addBtn = addContainer.createEl('button', { text: 'Add' });
					addBtn.onclick = () => {
						void (async () => {
							const val = inputEl.value.trim();
							if (val) {
								if (!selectedMount.ignoreList) selectedMount.ignoreList = [];
								if (!selectedMount.ignoreList.includes(val)) {
									selectedMount.ignoreList.push(val);
									await this.plugin.persistEditableMountFromState(selectedMount);
									// Rebuild cache and remove newly-ignored items from the file explorer
									await this.plugin.applyIgnoreListToVault(selectedMount);
									inputEl.value = '';
									renderIgnoreList();
								}
							}
						})();
					};

					inputEl.addEventListener('keypress', (e) => {
						if (e.key === 'Enter') {
							addBtn.click();
						}
					});
				};

				renderIgnoreList();
			}
		}

		// ── Managed TOC file ───────────────────────────────────────────────
		new Setting(containerEl)
			.setName(`Managed ${toc} file`)
			.setDesc(`Optional writable JSON file for local and vault mounts created from the ${pluginName} UI. When set, new local and vault mounts are written there instead of data.json.`)
			.setHeading();

		const managedTocContainer = containerEl.createDiv('folderbridge-toc-sources');
		const renderManagedToc = () => {
			managedTocContainer.empty();
			const currentPath = this.plugin.settings.managedTocSource.trim();
			const suggestedPath = this.plugin.getSuggestedManagedTocPath();
			managedTocContainer.createEl('p', {
				text: currentPath
					? `Current managed TOC file: ${currentPath}`
					: 'No managed TOC file configured. UI-created local and vault mounts will stay in data.json until you set one.',
				cls: 'setting-item-description',
			});
			if (!currentPath && suggestedPath) {
				managedTocContainer.createEl('p', {
					text: `Suggested location: ${suggestedPath}`,
					cls: 'setting-item-description',
				});
			}

			const addRow = managedTocContainer.createDiv('folderbridge-ignore-add');
			const inputEl = addRow.createEl('input', {
				type: 'text',
				placeholder: 'Absolute path to a writable TOC JSON file, e.g. /home/me/folderbridge.managed.json',
			});
			inputEl.value = currentPath || suggestedPath || '';

			const saveBtn = addRow.createEl('button', { text: currentPath ? 'Rebind' : 'Set' });
			saveBtn.onclick = () => {
				void (async () => {
					if (await this.plugin.bindManagedTocSource(inputEl.value)) {
						this.display();
					}
				})();
			};

			if (!currentPath) {
				const createBtn = addRow.createEl('button', { text: 'Create from current UI mounts' });
				createBtn.onclick = () => {
					void (async () => {
						const result = await this.plugin.createManagedTocFromCurrentMounts(inputEl.value);
						if (!result.success || !result.targetPath) return;
						if (result.moved > 0 || result.skipped > 0) {
							new Notice(`Folder Bridge: Created ${result.targetPath} and moved ${result.moved} local/vault mount(s) into it.${result.skipped ? ` ${result.skipped} cloud mount(s) stayed in data.json.` : ''}`);
						} else {
							new Notice(`Folder Bridge: Created ${result.targetPath}. New local and vault mounts will be written there.`);
						}
						this.display();
					})();
				};
			}

			if (currentPath) {
				const clearBtn = addRow.createEl('button', { text: 'Disable' });
				clearBtn.onclick = () => {
					void (async () => {
						await this.plugin.unbindManagedTocSource();
						this.display();
					})();
				};

				const migrateBtn = addRow.createEl('button', { text: 'Move local/vault UI mounts here' });
				migrateBtn.onclick = () => {
					void (async () => {
						const result = await this.plugin.migrateLocalManualMountsToManagedToc();
						if (result.moved > 0 || result.skipped > 0) {
							new Notice(`Folder Bridge: Moved ${result.moved} local/vault mount(s) to the managed TOC file.${result.skipped ? ` ${result.skipped} cloud mount(s) stayed in data.json.` : ''}`);
						} else {
							new Notice(`${this.plugin.manifest.name}: no local or vault UI mounts needed migration.`);
						}
						this.display();
					})();
				};
			}
		};
		renderManagedToc();

		// ── External TOC config files ─────────────────────────────────────
		new Setting(containerEl)
			.setName(`External ${toc} config files`)
			.setDesc('Load one or more JSON config files that declare additional mounts and per-mount ignore rules.')
			.setHeading();

		const tocInfo = containerEl.createEl('p', {
			text: `External ${toc} files are desktop-only and remain authoritative. Mounts loaded from these files appear below but must be edited in their source file.`,
			cls: 'setting-item-description',
		});
		tocInfo.addClass('folderbridge-setting-note');

		const tocWarnings = this.plugin.getTocWarnings();
		if (tocWarnings.length > 0) {
			const warningList = containerEl.createEl('ul', { cls: 'setting-item-description' });
			for (const warning of tocWarnings) {
				warningList.createEl('li', { text: warning });
			}
		}

		const tocContainer = containerEl.createDiv('folderbridge-toc-sources');
		const renderTocSources = () => {
			tocContainer.empty();
			if (this.plugin.settings.tocSources.length === 0) {
				tocContainer.createEl('p', {
					text: `No external ${toc} config files configured.`,
					cls: 'setting-item-description',
				});
			}

			for (const source of this.plugin.settings.tocSources) {
				const row = tocContainer.createDiv('folderbridge-ignore-item');
				row.createSpan({ text: source });
				const removeBtn = row.createEl('button', { text: 'Remove' });
				removeBtn.onclick = () => {
					void (async () => {
						this.plugin.settings.tocSources = this.plugin.settings.tocSources.filter(item => item !== source);
						await this.plugin.refreshTocMountSources(true);
						await this.plugin.saveSettings();
						this.display();
					})();
				};
			}

			const addRow = tocContainer.createDiv('folderbridge-ignore-add');
			const inputEl = addRow.createEl('input', {
				type: 'text',
				placeholder: 'Absolute path to a read-only TOC JSON file, e.g. /home/me/folderbridge.mounts.json',
			});
			const addBtn = addRow.createEl('button', { text: 'Add' });
			addBtn.onclick = () => {
				void (async () => {
					const value = inputEl.value.trim();
					if (!value || this.plugin.settings.tocSources.includes(value)) return;
					this.plugin.settings.tocSources.push(value);
					await this.plugin.refreshTocMountSources(true);
					await this.plugin.saveSettings();
					inputEl.value = '';
					this.display();
				})();
			};
			inputEl.addEventListener('keypress', event => {
				if (event.key === 'Enter') addBtn.click();
			});
		};
		renderTocSources();

		// ── Mount points ─────────────────────────────────────────────────
		new Setting(containerEl).setName('Mount points').setHeading();

		new Setting(containerEl)
			.setName('Add a new mount')
			.setDesc('Map an external folder to a virtual path inside your vault.')
			.addButton(btn => btn
				.setButtonText('Add mount point')
				.setCta()
				.onClick(() => {
					new MountManagerModal(
						this.app,
						this.plugin.manifest.name,
						this.plugin.security,
						async (mount) => {
							await this.plugin.addMount(mount);
							this.display();
						},
					).open();
				}))
			.addButton(btn => btn
				.setButtonText('Export…')
				.setTooltip('Export all mounts to a JSON file for backup or transfer')
				.onClick(() => {
					const manualMounts = this.plugin.settings.mountPoints.filter(m => this.plugin.isUserEditableMount(m));
					// Strip secrets before exporting
					const exportData = {
						version: '1',
						exportedAt: new Date().toISOString(),
						mountPoints: manualMounts.map(m => {
							// Strip all stored credentials — device-specific and useless on other machines.
							// JSON.stringify omits undefined values, so these fields are excluded from export.
							return {
								...m,
								encryptedWebdavPassword: undefined,
								webdavPassword: undefined,
								encryptedS3SecretKey: undefined,
								s3SecretKey: undefined,
								encryptedSftpPassword: undefined,
								sftpPassword: undefined,
								encryptedSftpPassphrase: undefined,
								sftpPassphrase: undefined,
							};
						}),
					};
					const blob = new Blob([JSON.stringify(exportData, null, '\t')], { type: 'application/json' });
					const url = URL.createObjectURL(blob);
					const a = document.createElement('a');
					a.href = url;
					a.download = 'folderbridge-mounts.json';
					a.click();
					URL.revokeObjectURL(url);
				}))
			.addButton(btn => btn
				.setButtonText('Import…')
				.setTooltip('Import mounts from a previously exported JSON file')
				.onClick(() => {
					const input = document.createElement('input');
					input.type = 'file';
					input.accept = '.json,application/json';
					input.onchange = () => {
						void (async () => {
							const file = input.files?.[0];
							if (!file) return;
							try {
								const text = await file.text();
								const parsed = JSON.parse(text);
								const mounts: MountPoint[] = Array.isArray(parsed)
									? parsed                        // legacy bare array
									: parsed.mountPoints ?? [];    // { version, mountPoints }
								if (!Array.isArray(mounts) || mounts.length === 0) {
									new Notice(`${this.plugin.manifest.name}: no mount points found in the selected file.`);
									return;
								}

								let added = 0, skipped = 0;
								for (const m of mounts) {
									if (typeof m.virtualPath !== 'string' || typeof m.realPath !== 'string') {
										skipped++; continue;
									}
									// Assign fresh ID and current device unless file already has a matching one
									const fresh: MountPoint = {
										...m,
										id: generateId(),
										deviceId: this.plugin.settings.deviceId,
										// Strip all stored credentials so the imported mount
										// doesn't carry encrypted blobs that can't be decrypted on this device.
										encryptedWebdavPassword: undefined,
										webdavPassword: undefined,
										encryptedS3SecretKey: undefined,
										s3SecretKey: undefined,
										encryptedSftpPassword: undefined,
										sftpPassword: undefined,
										encryptedSftpPassphrase: undefined,
										sftpPassphrase: undefined,
									};
									await this.plugin.addMount(fresh);
									added++;
								}
								new Notice(`Folder Bridge: Imported ${added} mount(s).${skipped ? ` ${skipped} skipped (invalid).` : ''}`);
								this.display();
							} catch {
								new Notice(`${this.plugin.manifest.name}: failed to parse the selected file. Is it a valid Folder Bridge export?`);
							}
						})();
					};
					input.click();
				}));

		// Render each existing mount (status loaded async below)
		if (this.plugin.settings.mountPoints.length === 0) {
			containerEl.createEl('p', {
				text: 'No mounts configured yet. Click "add mount point" to get started.',
				cls: 'setting-item-description',
			});
		}

		// Wrap mount rows in a container so drag-drop only affects this list
		const mountListEl = containerEl.createDiv('folderbridge-mount-list');
		for (const mount of this.plugin.settings.mountPoints) {
			this.renderMountRow(mountListEl, mount);
		}
	}

	/** Render a single mount row synchronously, then patch status asynchronously. */
	private renderMountRow(containerEl: HTMLElement, mount: MountPoint): void {
		const isThisDevice = mount.deviceId === this.plugin.settings.deviceId;
		const canEnable = isThisDevice || this.plugin.settings.allowForeignMounts;
		const isTocManaged = this.plugin.isTocManagedMount(mount);
		const isManagedToc = this.plugin.isManagedTocMount(mount);
		const isUserEditable = this.plugin.isUserEditableMount(mount);
		const displayName = mount.label || mount.virtualPath;

		let desc = `${normalizePath(mount.virtualPath)} → ${mount.realPath}`;
		if (isTocManaged) {
			desc += isManagedToc
				? `\n(Managed TOC file: ${mount.tocSourcePath})`
				: `\n(External config file: ${mount.tocSourcePath})`;
		}
		if (!isThisDevice) {
			desc += ` (Created on device: ${mount.deviceId?.substring(0, 8) || 'unknown'})`;
		}

		const effectivePath = this.plugin.pathMapper.getEffectiveRealPath(mount);
		if (effectivePath !== mount.realPath) {
			desc += `\n(Overridden on this device: ${effectivePath})`;
		}

		const setting = new Setting(containerEl)
			.setName(`${displayName}`)
			.setDesc(desc)
			.addToggle(toggle => {
				toggle
					.setValue(mount.enabled)
					.setTooltip(
						!isUserEditable
							? 'This mount is managed by an external config file. Edit the source file to change its enabled state.'
							: (canEnable ? 'Enable / disable this mount' : 'This mount belongs to another device and cannot be enabled here.')
					)
					.onChange(val => {
						void (async () => {
							if (!isUserEditable) {
								toggle.setValue(mount.enabled);
								new Notice(`${this.plugin.manifest.name}: this mount is managed by an external config file. Edit the source file to change it.`);
								return;
							}
							if (!canEnable) {
								// Revert the toggle visually if they try to enable a foreign mount
								toggle.setValue(false);
								new Notice(`${this.plugin.manifest.name}: cannot enable a mount created on a different device.`);
								return;
							}

							// [BUGFIX_20260222] Fix UI refresh bug when unmounting
							// We must call notifyVaultMountRemoved BEFORE updating pathMapper
							// so that adapter.list() can still resolve the virtual paths to real paths
							// and find the files to remove from Obsidian's internal fileMap.
							if (!val) {
								await this.plugin.notifyVaultMountRemoved(mount);
							}

							mount.enabled = val;
							await this.plugin.persistEditableMountFromState(mount);
							this.plugin.pathMapper.update(this.plugin.settings.mountPoints, this.plugin.settings.deviceId);
							this.plugin.updateStatusBar();

							// Inject into Obsidian's vault tree live
							if (val) {
								await this.plugin.notifyVaultMountAdded(mount);
							}
						})();
					});

				// Disable the toggle entirely if it's not this device and foreign mounts aren't allowed
				if (!canEnable || !isUserEditable) {
					toggle.toggleEl.classList.add('is-disabled', 'folderbridge-toggle-disabled');
				}
			})
			.addExtraButton(btn => {
				// Read-only lock icon — click to toggle; always visible so state is obvious at a glance
				btn
					.setIcon(mount.readOnly ? 'lock' : 'unlock')
					.setTooltip(
						!isUserEditable
							? 'This mount is managed by an external config file. Edit the source file to change its read-only state.'
							: (mount.readOnly ? 'Read-only — click to allow writes' : 'Writable — click to make read-only')
					)
					.onClick(() => {
						void (async () => {
							if (!isUserEditable) {
								new Notice(`${this.plugin.manifest.name}: this mount is managed by an external config file. Edit the source file to change it.`);
								return;
							}
							await this.plugin.setMountReadOnly(mount.id, !mount.readOnly);
							this.display();
						})();
					});
				if (mount.readOnly) {
					btn.extraSettingsEl.classList.add('folderbridge-warning-icon');
				}
			});

		const addOverridePathButton = (): void => {
			setting.addButton(btn => btn
				.setButtonText('Override path')
				.setTooltip('Set a different real path for this device')
				.onClick(() => {
					void (async () => {
						const newPath = await browseFolderOnDisk('Select real folder for this device');
						if (newPath) {
							if (!mount.deviceOverrides) mount.deviceOverrides = {};
							mount.deviceOverrides[this.plugin.settings.deviceId] = newPath;

							// Add to allowlist
							if (!this.plugin.settings.allowlist.includes(newPath)) {
								this.plugin.addManualAllowlistPath(newPath);
							}

							await this.plugin.persistEditableMountFromState(mount);
							this.plugin.resyncEffectiveMountState();
							// Restart the file watcher so it tracks the new real path
							if (mount.enabled) {
								this.plugin.fileWatcher?.stopWatching(mount);
								this.plugin.fileWatcher?.startWatching(mount);
							}
							this.display();
							new Notice(`${this.plugin.manifest.name}: path overridden for this device.`);
						}
					})();
				}));
		};

		if (!isThisDevice && isUserEditable) {
			addOverridePathButton();
		}

		// Edit button — opens the modal pre-populated with this mount's values
		if (isThisDevice && isUserEditable) {
			setting.addButton(btn => btn
				.setButtonText('Edit')
				.setTooltip("Edit this mount's paths, label, or read-only flag")
				.onClick(() => {
					new MountManagerModal(
						this.app,
						this.plugin.manifest.name,
						this.plugin.security,
						async (updatedData, editId) => {
							if (editId) {
								await this.plugin.updateMount(editId, updatedData);
							}
							this.display();
						},
						mount, // pre-populate all fields
					).open();
				}));
		}

		if (isUserEditable) {
			setting.addButton(btn => btn
				.setButtonText('Remove')
				.setWarning()
				.onClick(() => {
					void (async () => {
						await this.plugin.removeMount(mount.id);
						this.display();
					})();
				}));
		}

		// ── Drag-drop reordering ────────────────────────────────────────────
		const el = setting.settingEl;
		const allowReorder = this.plugin.settings.tocSources.length === 0 && !this.plugin.settings.managedTocSource.trim() && !isTocManaged;
		if (allowReorder) {
			el.setAttribute('draggable', 'true');
			el.dataset.mountId = mount.id;
			el.addClass('folderbridge-draggable-row');
		}

		el.addEventListener('dragstart', (e) => {
			if (!allowReorder) return;
			this.dragSrcId = mount.id;
			el.addClass('folderbridge-drag-source');
			e.dataTransfer?.setData('text/plain', mount.id);
		});

		el.addEventListener('dragend', () => {
			if (!allowReorder) return;
			this.dragSrcId = null;
			el.removeClass('folderbridge-drag-source');
			containerEl.querySelectorAll('.folderbridge-drag-over')
				.forEach(n => (n as HTMLElement).removeClass('folderbridge-drag-over'));
		});

		el.addEventListener('dragover', (e) => {
			if (!allowReorder) return;
			if (this.dragSrcId && this.dragSrcId !== mount.id) {
				e.preventDefault();
				containerEl.querySelectorAll('.folderbridge-drag-over')
					.forEach(n => (n as HTMLElement).removeClass('folderbridge-drag-over'));
				el.addClass('folderbridge-drag-over');
			}
		});

		el.addEventListener('dragleave', (e) => {
			if (!allowReorder) return;
			if (!el.contains(e.relatedTarget as Node)) {
				el.removeClass('folderbridge-drag-over');
			}
		});

		el.addEventListener('drop', (e) => {
			if (!allowReorder) return;
			e.preventDefault();
			el.removeClass('folderbridge-drag-over');
			if (!this.dragSrcId || this.dragSrcId === mount.id) return;

			const mounts = this.plugin.settings.mountPoints;
			const srcIdx = mounts.findIndex(m => m.id === this.dragSrcId);
			const dstIdx = mounts.findIndex(m => m.id === mount.id);
			if (srcIdx === -1 || dstIdx === -1) return;

			const [moved] = mounts.splice(srcIdx, 1);
			mounts.splice(dstIdx, 0, moved);

			void this.plugin.saveSettings().then(() => this.display());
		});

		// ── Reconnect button (shown immediately when mount is known unreachable) ────
		if (canEnable && this.plugin.mountHealthMap.get(mount.id) === false) {
			setting.addButton(btn => btn
				.setButtonText('Reconnect')
				.setWarning()
				.onClick(() => {
					void (async () => {
						await this.plugin.reconnectMount(mount);
						this.display();
					})();
				}));
		}

		// ── Async status badge ───────────────────────────────────────────────
		if (canEnable) {
			void getMountStatus(mount).then(status => {
				const isUnreachable = this.plugin.mountHealthMap.get(mount.id) === false;
				const badge = isUnreachable
					? '[unreachable]'
					: status.reachable
						? (status.readOnly ? '[read-only]' : '[writable]')
						: `[error: ${status.error ?? 'unreachable'}]`;
				const prefix = (isUnreachable || !status.reachable) ? '✗' : '✓';
				setting.setName(`${prefix} ${displayName} ${badge}`);
				if (isUnreachable || !status.reachable) {
					setting.settingEl.classList.add('folderbridge-unreachable-row');
				}
			}).catch(() => { /* ignore render errors */ });
		} else {
			setting.setName(`[Other device] ${displayName}`);
			setting.settingEl.classList.add('folderbridge-foreign-mount');
		}
	}
}
