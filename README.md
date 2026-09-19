# Folder Bridge

Extends Obsidian's single-root vault by letting you mount external folders as seamless, native-feeling directories inside your vault. Files stay in their original locations — no copying, no duplicating, no symlinking required.

---

## Full Feature List (v2.14.0)

Current release highlights:

- **Managed TOC workflow** for UI-created local and vault mounts
- **Mounted delete sync fix** so deleted mounted notes disappear from Obsidian immediately
- **Community-plugin reviewer cleanup** in the TOC parser to remove a non-narrowing type assertion warning without changing runtime behavior
- **Local UI copy validation** with a reviewer-focused text check and pre-commit hook support

### Core

- **Zero duplication** — files are always read and written from their real locations on disk or on the remote backend
- **Multi-root workspaces** — mount as many folders as you want at any virtual path inside one vault
- **Full Obsidian integration** — mounted files participate in the file explorer, Quick Switcher, Search, graph-adjacent indexing workflows, embeds, and normal vault commands
- **Image and PDF rendering** — embedded images and PDFs inside mounted folders render correctly, including files served through data URIs or the local file server when Obsidian's normal vault URL scheme would fail
- **Security allowlist** — only explicitly approved real paths can be accessed; protected system directories are blocked
- **Dry-run mode** — log write operations without executing them when testing a new setup

### Mount Types

- **Local folder mounts** — mount any directory from your local filesystem, external drive, NAS share, UNC path, or WSL-exposed folder
- **WebDAV mounts** — mount folders from Nextcloud, ownCloud, Synology, or any generic WebDAV server; credentials are encrypted per-device on desktop via the OS keychain and fall back to session memory on mobile
- **S3-compatible mounts** — mount Amazon S3, Backblaze B2, MinIO, Cloudflare R2, and other compatible buckets, with provider presets and per-device encrypted secrets on desktop
- **SFTP mounts** — mount remote SSH directories with password or private-key authentication, persistent reconnecting sessions, and desktop-only support
- **Vault-to-vault bridging** — mount content from another Obsidian vault; the other vault's config and conflict-prone folders such as `.obsidian`, `.trash`, and `.smart-connections` are auto-ignored

### Mount Management

- **Edit mounts in place** — change virtual path, real path, label, read-only mode, or watcher settings without deleting and recreating the mount
- **Drag-drop reordering in Settings** — reorder mounts visually and persist the order immediately
- **Drag-drop in the file explorer** — drag a mount root to a new location in the vault tree and update its virtual path live
- **`Move mount to…` context action** — right-click a mount root and choose a new parent from the vault folder picker
- **Read-only mounts** — block writes through a specific mount while keeping the content fully browsable and searchable
- **Fast read-only toggles** — toggle read-only from the Settings row or through assignable commands for one mount or all mounts
- **TOC config files** — load external read-only TOC files, bind the UI to a managed writable TOC file for local and vault mounts, and create that managed file directly from your current UI mounts

### Reliability and Conflict Resolution

- **Background health monitoring** — active mounts are probed every 30 seconds for reachability
- **Status bar indicators** — the status item surfaces mount health, including the unreachable warning state and all-clear state
- **One-click reconnect** — the conflict resolution UI exposes reconnect actions for mounts that have gone offline
- **WebDAV-specific health probing** — WebDAV mounts are checked through the adapter instead of local filesystem assumptions
- **Startup mount replay** — mounted folders are injected into Obsidian's internal vault tree without requiring a restart

### Per-Mount Watcher Tuning

- **Custom debounce** — set a debounce delay per mount to balance responsiveness against churn from rapid-save tools
- **Polling mode** — switch individual mounts to stat polling for network shares or filesystems without reliable native watch events
- **Polling interval** — configure polling cadence independently per mount
- **Max-files cap** — limit startup scan size for very large directory trees
- **Suppress all watcher events** — keep a mount visible while preventing its external file events from triggering Obsidian/plugin reactions
- **New file event filter** — optionally announce only Markdown files on create, reducing interference from attachment-rename plugins
- **Visible file-type filter** — expose all files, Markdown only, or PDF only while keeping the real folder structure intact on disk

### Sync and Multi-Device

- **Device-specific mount paths** — map the same virtual folder to different real paths on different machines
- **Per-device path overrides** — override a synced mount's real path locally without changing another device's configuration
- **Foreign mount control** — choose whether mounts created on another device are available on the current one
- **Sync-friendly settings model** — mount definitions can sync while real secrets stay device-specific and decrypted only on the originating desktop OS keychain

### Ignore System

- **Browse-to-ignore** — pick a subfolder from the OS folder picker and store its mount-relative path automatically
- **Path-relative ignore patterns** — entries containing `/` ignore a specific subtree without affecting similarly named folders elsewhere
- **Name patterns** — plain entries such as `.git` or `node_modules` match any leaf with that name
- **Glob patterns** — wildcard entries such as `*.tmp` and `~$*` match leaf names as globs
- **Context-menu ignore** — right-click any file or folder inside a mount and add it instantly to the ignore list
- **Global ignore rules** — apply a shared ignore baseline across every mount

### Platform and Performance

- **Windows hardened** — long paths, UNC/network paths, OneDrive-style workflows, reserved names, and case-insensitive comparisons are handled explicitly
- **Linux and macOS support** — POSIX paths work natively, and the same core adapter and watcher logic applies across desktop platforms
- **Android support for remote mounts** — WebDAV and S3-compatible mounts work on Android with a mobile-adapted UI
- **Background file watcher** — file changes from mounted folders appear in Obsidian in real time when the backend supports it
- **PathMapper cache optimisation** — active mounts are pre-normalised and sorted once so path resolution stays fast even with many mounts

### Platform Support

Quick compatibility summary. For platform-specific caveats and setup notes, see [Platform Notes](#platform-notes) below.

| Platform | Status | Notes |
|----------|--------|-------|
| Windows | ✅ Tested | Full support — long paths, UNC, NTFS quirks all handled |
| macOS | ⚠️ Untested | POSIX code paths are implemented; not yet officially tested. Community reports welcome. |
| Linux | ✅ Tested | POSIX paths, works including WSL |
| Android | ✅ Stable | WebDAV and S3/B2 mounts work fully. UI auto-adapts to show only mobile-compatible mount types. See [Android Setup Guide](docs/ANDROID_SETUP.md) |
| iOS | ❌ Not supported | Not yet tested on iOS; WebDAV may work in theory |

---

## Installation

Folder Bridge is not currently listed in Obsidian's Community Plugins directory. Use BRAT or manual installation below until the community submission is approved.

### Using BRAT (Beta Reviewers Auto-update Tool)

Install the latest published GitHub release via [BRAT](https://tfthacker.com/BRAT):

1. Install the **Obsidian42 - BRAT** plugin from the Community Plugins directory.
2. Enable BRAT in your settings.
3. Open the command palette and run **BRAT: Add a beta plugin for testing**.
4. Enter the repository URL: `https://github.com/tescolopio/Obsidian_FolderBridge`
5. Click **Add Plugin**. BRAT will automatically download and install the latest release.

### Manual Installation

1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/tescolopio/Obsidian_FolderBridge/releases/latest)
2. Copy them to `<your-vault>/.obsidian/plugins/folderbridge/`
3. Enable the plugin in **Settings → Community Plugins**

### Local Development (git clone)

If you want to run straight from source (no release download needed):

```bash
# 1. Clone into your vault's plugin folder
git clone https://github.com/tescolopio/Obsidian_FolderBridge.git \
  /path/to/your-vault/.obsidian/plugins/folderbridge

cd /path/to/your-vault/.obsidian/plugins/folderbridge

# 2. Install dependencies
npm install

# 3. Build the plugin (produces main.js that Obsidian loads)
npm run build
```

Then in Obsidian: **Settings → Community Plugins → disable Safe Mode → enable Folder Bridge**.

> **Hot-reload during development:** run `npm run dev` instead of `npm run build`.
> Install the [hot-reload plugin](https://github.com/pjeby/hot-reload) in Obsidian and it will
> automatically reload Folder Bridge whenever `main.js` is rebuilt.

---

## Quick Start

1. Click the **folder-plus** ribbon icon (or go to **Settings → Folder Bridge → Add Mount Point**)
2. Select the **Mount Type** (Local folder, WebDAV, S3/Backblaze B2, SFTP, or Another Obsidian vault)
3. Fill in the **Real path** and **Virtual path**, then click **Validate & Add**

The folder appears immediately in Obsidian's file explorer — no restart needed.

For full step-by-step instructions on each mount type and feature, see the [Usage Guide](#usage-guide) below.

For advanced JSON-driven mount definitions, see the [TOC Config Guide](docs/TOC_CONFIG.md).

If you want the Settings UI to write local and vault mounts into a JSON file instead of only `data.json`, use the managed TOC workflow described below.

---

## Mount Ownership and TOC Workflow

Folder Bridge now treats mount storage as a source-of-truth decision rather than just a file format option.

There are three mount ownership modes:

- **Manual / `data.json` mounts** — the default behavior when no managed TOC file is configured.
- **Managed TOC mounts** — local and vault mounts written by the Settings UI into one writable JSON file.
- **External TOC mounts** — additional JSON files that Folder Bridge reads at runtime but does not edit from the UI.

How it works in practice:

- If you do nothing, mounts keep working the old way and stay in `data.json`.
- If you configure a **Managed TOC file**, new local and vault mounts created from Settings are written there instead.
- If you already have a working local/vault setup in Settings, use **Create from current UI mounts** once to create the file and migrate those mounts automatically.
- If you add **External TOC config files**, those mounts appear in Settings but stay read-only because their source file is authoritative.
- WebDAV, S3, and SFTP mounts stay in `data.json` because TOC files do not store credentials.

This affects the whole plugin, not just the TOC screens:

- Editable mounts include manual mounts and managed-TOC mounts.
- Read-only external TOC mounts are locked consistently in row actions, ignore-list editing, toggle flows, and command-palette actions.
- Import/export covers mounts you can still manage from the UI.

Recommended setup:

1. Use **Managed TOC file** if you want one editable JSON source for local and vault mounts.
2. Use **Create from current UI mounts** the first time if your setup already exists in Settings.
3. Use **External TOC config files** for shared, reviewed, or machine-specific read-only mount definitions.
4. Leave credentialed cloud mounts in `data.json`.

For the JSON schema, examples, and troubleshooting details, see the [TOC Config Guide](docs/TOC_CONFIG.md).

---

## Support and Follow

If Folder Bridge is useful in your workflow, you can support the project in lightweight ways:

- Follow other work on [GitHub](https://github.com/tescolopio)
- Browse or star the [Folder Bridge repository](https://github.com/tescolopio/Obsidian_FolderBridge)

The plugin settings also include direct GitHub buttons under **Support Folder Bridge**.

---

## Usage Guide

### Adding a Local Mount

1. Click the **folder-plus** ribbon icon, or go to **Settings → Folder Bridge** and click **Add Mount Point**
2. In the **Mount Type** dropdown, select **Local folder**
3. **Real path** — click **Browse…** to open the OS folder picker, or type the absolute path  
   - Windows: `C:\Users\YourName\Documents\Work`  
   - Linux / macOS: `/home/yourname/Documents/Work`  
   - WSL path from Windows: `\\wsl.localhost\Ubuntu\home\yourname\Work`  
   - UNC network path: `\\server\share\documents`
4. **Virtual path** — where the folder will appear inside your vault, e.g. `Projects/Work`  
   - Click **Browse vault…** to pick an existing vault folder as the parent  
   - Leave empty to mount at vault root using the real folder's name
5. Optionally set a **Label** for the mount (shown in the settings list)
6. Optionally enable **Read-only** to block all writes through this mount
7. Click **Validate & Add**

The folder appears immediately in Obsidian's file explorer. No restart needed.

---

### Adding a WebDAV Mount

Mount a remote Nextcloud, ownCloud, or generic WebDAV server as a vault folder.

1. Click **Add Mount Point** and select **WebDAV server** in the **Mount Type** dropdown
2. **Server URL** — the full URL to your WebDAV server, e.g.:
   - Nextcloud: `https://cloud.example.com/remote.php/dav/files/username`
   - Generic: `https://dav.example.com`
3. **Remote path** — the path on the server to mount, e.g. `/Documents/Notes`
4. **Virtual path** — where it will appear in your vault, e.g. `Remote/Notes`
5. **Username** — your WebDAV username
6. **Password** — your WebDAV password  
   > 🔒 The password is encrypted with your **OS keychain** (Windows DPAPI / macOS Keychain / Linux libsecret) and stored in `data.json`. It persists across Obsidian restarts — no re-entry needed. The encrypted blob is device-specific; other devices cannot decrypt it even if `data.json` syncs. On mobile, passwords fall back to session memory only.
7. Click **Validate & Add**

Folder Bridge will test the connection before saving. If the server is unreachable, you'll see an error with the reason.

---

### Vault-to-Vault Bridging

Browse a folder from a second Obsidian vault inside your current one without duplicating files.

1. Click **Add Mount Point** and select **Another Obsidian vault** in the **Mount Type** dropdown
2. **Real path** — click **Browse…** and navigate to the **root folder** of the other vault (the folder that contains the `.obsidian` directory)
3. Optionally narrow to a **sub-folder** of that vault by specifying a relative path inside it
4. Set a **Virtual path** where it will appear in your current vault, e.g. `Reference`
5. Click **Validate & Add**

Folder Bridge automatically adds `.obsidian`, `.trash`, and `.smart-connections` to the ignore list for vault mounts to prevent the two vaults from interfering with each other.

---

### Editing an Existing Mount

All mount settings can be changed without deleting and re-adding the mount.

1. Open **Settings → Folder Bridge**
2. Click the **Edit** (pencil) button on any mount row
3. Change any field — virtual path, real path, label, read-only flag, or watcher settings
4. Click **Save**

The vault tree, file watcher, and all internal caches update live. No restart needed.

---

### Reordering Mounts

The order of mounts in the list determines the order they are checked during path resolution.

- **Drag** a mount row up or down in **Settings → Folder Bridge** to reorder it
- The new order is saved immediately

---

### Moving a Mount in the File Explorer

You can change a mount's virtual path directly from Obsidian's file explorer without opening Settings.

**Option 1 — Drag and drop:**
1. In the file explorer, click and hold the mounted folder
2. Drag it to a new location in the vault hierarchy
3. The virtual path updates live — nothing on disk is touched

**Option 2 — Context menu:**
1. Right-click the mounted folder root in the file explorer
2. Select **Move mount to…**
3. Choose a new parent folder from the vault picker
4. Click **Move**

---

### Read-Only Mounts

Prevent any write operations through a specific mount (useful for reference folders or shared network drives you don't own).

- Enable the **Read-only** toggle when adding or editing a mount, or click the **lock icon** directly on any mount row in Settings
- The lock icon turns amber when a mount is read-only so you can see its state at a glance without opening the edit modal
- Toggle all mounts at once with the **Folder Bridge: Toggle read-only on all mounts** command (assignable to a hotkey)
- Toggle a single mount by name with the **Folder Bridge: Toggle read-only on a specific mount…** command (assignable to a hotkey)
- Obsidian can still open, search, and read all files in the mount
- Any attempt to create, edit, rename, or delete a file through the mount is silently blocked with a one-time Notice

---

### Ignore List

Hide specific files or folders inside a mount from Obsidian. Useful for large directories (`node_modules`, build outputs) that would slow down indexing.

**Adding entries manually:**
1. Open **Settings → Folder Bridge**, expand the mount, and go to the **Ignore List** section
2. Type a pattern and click **Add**

**Adding entries with the folder picker (Browse…):**
1. Click the **Browse…** button next to the ignore list input
2. The OS folder picker opens inside the mount's real directory
3. Navigate to the subfolder you want to ignore and click **OK**
4. The mount-relative path is filled in automatically — review it and click **Add**

**Adding entries from the file explorer:**
1. Right-click any file or folder inside a mounted directory
2. Select **Ignore in Folder Bridge**
3. The entry is added immediately and the item disappears from the file explorer

**Pattern types:**

| Pattern | Behaviour | Example |
|---------|-----------|---------|
| Plain name | Matches any file or folder with that leaf name anywhere in the mount | `node_modules` |
| Path prefix (contains `/`) | Matches only that exact subtree | `assets/vendor/plantuml-stdlib` |
| Glob (contains `*`) | Matches leaf names against the glob | `*.tmp`, `~$*`, `build*` |

---

### Conflict Resolution & Health Monitoring

Folder Bridge checks every active mount for reachability every **30 seconds** in the background.

**When a mount goes offline** (drive disconnected, network drop, WebDAV server unreachable):
- An **orange indicator** appears in the Obsidian status bar
- Click the indicator to open the **Conflict Resolution panel**
- The panel shows every affected mount with its last-known error
- Click **Reconnect** next to a mount to retry it immediately

**When all mounts are reachable:**
- The status bar indicator turns **green** (if visible) or disappears, depending on your settings

---

### Per-Mount Watcher Tuning

Each mount has independent file-watcher settings. Open **Edit** on any mount to see:

| Setting | Default | Description |
|---------|---------|-------------|
| **Debounce (ms)** | 300 | How long to wait after the last file-change event before notifying Obsidian. Lower = more responsive; higher = less CPU on rapid saves. |
| **Use polling** | Off | Enable stat-based polling instead of native OS watch events. Required for most network drives and some containerised filesystems. |
| **Polling interval (ms)** | 2000 | How frequently to poll when polling mode is on. Has no effect when polling is off. |
| **Visible file types** | All | Limit what Obsidian sees from this mount: all files, Markdown only, or PDF only. |
| **Max files** | 10 000 | Stop scanning a directory tree after this many entries. Protects performance on very large mounts. |

> **Tip:** For a local SSD, leave all defaults. For a Samba/NFS network share, enable **Use polling** and set the interval to 3000–5000 ms to avoid hammering the server.

---

### Device-Specific Paths (Multi-Device Sync)

Each mount is tagged with the `deviceId` of the machine that created it. When your vault syncs to another device, that device's Obsidian will see the mount but won't activate it unless the path also exists there.

**To map a mount to a different path on another device:**

1. On the second device, open **Settings → Folder Bridge**
2. Find the mount (it will show a warning badge if the original path doesn't exist locally)
3. Click **Override Path** and enter the correct local path for this device
4. Click **Save**

The override applies only to this device; the original path is preserved for the device that created it.

**To let all mounts from other devices activate automatically (if paths match):**
- Enable **Allow foreign mounts** in **Settings → Folder Bridge**

---

## Settings Reference

| Setting | Description |
|---------|-------------|
| **Dry-run mode** | Log all write operations to the console without executing them. Safe for testing configuration changes. |
| **Show status bar item** | Display the active mount count (and health indicator) in Obsidian's status bar. |
| **Allow foreign mounts** | Activate mounts created on other devices if the real path exists on this machine. |
| **Mount list** | Enable, disable, edit, or remove individual mounts. Each row shows a live reachability badge and drag handle. |

---

## Platform Notes

### Windows

- **Long paths**: Paths over 260 characters are handled automatically with the `\\?\` prefix. For best results, also enable **Long Path Support** in Windows Settings → System → For Developers.
- **Symlinks**: Creating symlinks on Windows requires either Developer Mode or administrator rights. Folder Bridge itself does not create symlinks, but the underlying filesystem may encounter related permission errors.
- **UNC network paths** (`\\server\share\...`): Supported, but file-change watching may not work on some servers and the path may be unavailable offline.
- **Reserved names**: Files and folders named `CON`, `NUL`, `COM1`–`COM9`, `LPT1`–`LPT9` (Windows reserved device names) are blocked from creation via Folder Bridge to prevent cryptic OS errors.
- **OneDrive Files On Demand**: Online-only placeholder files will show a user-friendly error rather than a raw ENOENT. Right-click the file in Explorer and choose **Always keep on this device** to make it locally accessible.

### macOS

> ⚠️ **macOS has not yet been officially tested.** The POSIX code paths are fully implemented and should work, but there may be edge cases. If you run into issues, please [open an issue](https://github.com/tescolopio/Obsidian_FolderBridge/issues) — macOS bug reports are actively welcomed.

- Standard absolute paths work: `/Users/yourname/Documents/Work`
- **iCloud Drive (optimized storage)**: Files set to "online only" behave like OneDrive placeholders — Folder Bridge will surface a friendly error. Open Finder, right-click the file, and choose **Download Now** to make it available locally.

### Mobile (iOS / Android)

**Android** — WebDAV and S3/B2 mounts are fully supported on Obsidian for Android (v2.0.0+). Connect to Nextcloud, ownCloud, a NAS, any WebDAV server, or an S3-compatible bucket from your phone — no extra apps required. Local and SFTP mounts are not available on Android due to the app sandbox. See the [Android Setup Guide](docs/ANDROID_SETUP.md) for step-by-step instructions.

**iOS** — Not yet tested. WebDAV may work in theory (same code paths as Android) but is not officially supported. Feedback welcome via [GitHub Issues](https://github.com/tescolopio/Obsidian_FolderBridge/issues).

---

## Architecture

Folder Bridge installs a lightweight **virtual filesystem adapter shim** that intercepts every I/O call Obsidian makes to its vault:

```
Obsidian → vault.adapter (Proxy) → VirtualAdapter
                                        ├── path inside a mount? → Node.js fs APIs (real path)
                                        └── path outside mounts? → original FileSystemAdapter
```

A JavaScript `Proxy` forwards all undocumented Obsidian-internal methods transparently to the original adapter, so no Obsidian functionality is broken.

---

## Development Setup

### Prerequisites

- Node.js 20.x (LTS)
- npm

### Installation

```bash
git clone https://github.com/tescolopio/Obsidian_FolderBridge.git
cd Obsidian_FolderBridge
npm install
```

### Linking to your vault

```bash
# Windows (PowerShell, run as administrator or with Developer Mode enabled)
New-Item -ItemType Junction -Path "$env:APPDATA\obsidian\<YourVault>\.obsidian\plugins\folderbridge" -Target (Get-Location)

# Linux / macOS
ln -s "$(pwd)" "/path/to/vault/.obsidian/plugins/folderbridge"
```

### Build scripts

```bash
npm run dev      # Watch mode with hot-reload
npm run build    # Production build (type-checks first)
npm test         # Run unit tests
npm run version  # Bump version in manifest.json and versions.json
```

### Project structure

```
├── main.ts                    # Plugin entry point and settings UI
├── src/
│   ├── types.ts               # Shared TypeScript interfaces
│   ├── PathMapper.ts          # Virtual ↔ real path translation
│   ├── VirtualAdapter.ts      # Virtual filesystem adapter (core)
│   ├── SecurityManager.ts     # Allowlist enforcement and validation
│   ├── OSHelpers.ts           # Platform detection and Windows helpers
│   ├── CredentialStore.ts     # OS-keychain credential encryption (Electron safeStorage)
│   ├── FileWatcher.ts         # chokidar-based background file watcher
│   └── ui/
│       └── MountManagerModal.ts  # Add/edit mount dialog
├── tests/                     # Vitest unit tests
├── manifest.json              # Plugin metadata
├── versions.json              # Version → minAppVersion map
└── esbuild.config.mjs         # Build configuration
```

---

## Contributing

Contributions are welcome! Please open an issue or pull request.

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

---

## License

MIT — see [LICENSE](LICENSE) for details.

## Attribution

This plugin does not use code from other Obsidian plugins. It relies solely on the official Obsidian API and standard Node.js libraries.
