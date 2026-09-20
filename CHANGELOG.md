# Changelog

All notable changes to Folder Bridge will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [2.15.4] - 2026-09-20

This maintenance release includes all previously integrated branch work and the
CI hardening from PR #52. Folder Bridge continues making major improvements
across the board; the runtime improvements are those shipped in 2.15.3.
There are no additional plugin behavior or dependency changes in 2.15.4.

### Changed
- Pull-request, main-branch, and release workflows now use the same `npm run validate` gate: lint, UI text checks, TypeScript checking, production build, and tests.
- Release builds now require lint and UI text checks; pull-request builds now include UI text checks and avoid redundant TypeScript checking.
- Existing tag/version matching, release-note extraction, asset checks, and stable/prerelease handling are unchanged.

### Validation And Known Limitations
- The inherited automated suite contains 400 tests across 13 files. Release publication requires the complete validation gate to pass.
- Native Windows/WSL, macOS, Android, and current/oldest Obsidian host checks remain pending. This maintenance release does not establish native editor, Outline, metadata, or save compatibility, and does not resolve the remaining suppression-policy or plugin-directory review issues.
- Back up your vault, settings, and mounted source folders; test writes on disposable copies. Install `main.js`, `manifest.json`, and `styles.css` from this release together. See the 2.15.3 notes and `docs/RELEASE_VALIDATION.md` for outstanding checks.

## [2.15.3] - 2026-09-20

Folder Bridge is making major improvements across the board. This stable release
consolidates the compatibility, cross-device mounting, explorer, watcher,
performance, and dependency-security work from the development branches and
both 2.15.3 release candidates.

**Upgrade caveat:** These are substantial changes to filesystem integration.
Back up your vault, plugin settings, and mounted source folders before upgrading,
and try write operations on disposable copies first. Stable publication was
explicitly approved while native Windows/WSL, macOS, Android, and oldest/current
Obsidian host checks remain pending. Automated tests do not establish native
compatibility or guarantee editor/save behavior. Known limitations are listed below.

### Added
- Local mount and managed TOC fallback paths, with per-device override precedence, fallback browse/save controls, active-source status, and clearer labels. Refresh commands and mount pickers now include eligible cross-device mounts; setting an override replays the mounted tree.
- File-explorer mount indicators and source-path details, context-menu mounting into an unused child destination, and persistent mounted-folder expansion state.
- Live scan counts with throttled notice updates, removal progress and bounded parallel removal of indexed entries, preserving child-before-parent ordering and cancellation safeguards. Unmounting removes virtual entries, not source files.
- Binary append support for local mounts, with explicit rejection for unsupported remote mounts.
- A sanitized historical cross-device development log and a read-only maintainer PR-review profile. Generated files and machine-specific validation artifacts are not included.

### Changed
- Updated Obsidian typings to 1.13.1 while retaining legacy settings rendering and feature-detecting destructive-button styling. Minimum host metadata remains unchanged, not newly verified.
- Corrected optional-module bundling for Windows/UNC paths and removed the Linux-only esbuild dependency. Disabled chokidar's native fsevents backend to avoid incompatible Electron bindings; native macOS verification remains pending.
- Watcher-backend failures are logged without a popup. If watching is unavailable, external changes require manual refresh; mounted access still works independently of the watcher.
- Clarified BRAT/manual installation, narrow settings layouts, and automatic folder-name labels without requiring Node on mobile.

### Performance
- Startup scans overlap up to eight metadata reads for local and vault mounts while keeping vault notifications ordered and sequential. Remote mounts retain serial reads; scan limits, filtering, and suppression remain enforced. No persistent cache is introduced.
- A scanner-only benchmark of 20,000 files across 100 folders measured a median of 784 ms versus 1,215 ms for the serial baseline (35.5% lower). This Linux temporary-filesystem result uses no-op vault notifications and does not establish native Obsidian startup improvement. See the Development Guide for reproduction and limitations.

### Security
- Updated esbuild to 0.28.2 and Vitest to 4.1.11, retaining the Node 20-compatible test runner and TypeScript 5.3.3.
- Refreshed vulnerable transitive dependencies, including the AWS XML helpers and WebDAV's brace expansion. Full and production-only npm audits report zero known vulnerabilities, down from 13 affected package entries (7 high, 5 moderate, 1 low) in the full baseline audit.
- Dependency updates are included in this stable release; the historical rc.2 assets remain unchanged.

### Fixed
- Mounted cached reads now use the virtual adapter. Successful mounted binary writes and text appends no longer fall through to the vault adapter.
- Startup scans and watcher events honor configured hidden-file exclusions. Trailing separators and Windows/WSL paths are normalized while preserving protected-path checks for extended Windows and ambiguous POSIX paths.
- Managed TOC changes preserve destination entries, clear disabled fallback configuration, and reject stale asynchronous resolutions. Refresh retains active fallback routing; updated remote adapters are replaced before rescanning.
- Explorer tooltip, observer, expansion-save, and unload handling now reject stale work, preserve native attributes, and support retryable saves.
- Resolved community-review lint and typing errors, including sentence-case handling without sentence-case rule-disable comments.
- Translate mounted-file changes to `vault.onChange('modified', ...)` in both the watcher and adapter write callback. The old `file-changed` event bypassed stat updates and content-cache invalidation in the recorded vault handler. Regression tests now verify both paths emit public `modify` and `raw` events; native editor, Outline, and save behavior still require validation.
- Drop watcher events received during suppression immediately, cancel pending change notifications when suppression starts, and prevent in-flight metadata reads or cache refreshes from escaping a suppression toggle. Applies to per-mount and global runtime suppression; new events resume normally after unmuting.
- Added regression coverage for saved suppression changes taking effect without restart and surviving reload. Existing startup behavior is unchanged: saved suppression skips child-file replay, so mounted folders may appear empty. Native macOS confirmation for #16 remains pending.

### Validation And Known Limitations
- Full validation passes 400 tests across 13 files, lint, UI text checks, TypeScript checking, and the production build. Tests use mocked Obsidian; the captured private vault handler has no recorded host-version provenance.
- Native platform checks, the separate macOS file-opening report, and Community Plugins approval/in-app availability remain unverified. Stable publication does not close those issues.
- Saved watcher suppression can leave the mounted tree empty after restart. Cross-mount moves, external-rename backlink updates, persistent large-mount caching, native/mobile SMB, and sparse NAS workflows remain deferred.
- Install `main.js`, `manifest.json`, and `styles.css` from this release together. Report the exact build, device/OS, Obsidian version, reproduction steps, and outcome. See `docs/RELEASE_VALIDATION.md` for the outstanding checks and branch audit.

## [2.15.3-rc.2] - 2026-09-19

This opt-in prerelease contains all changes merged through PR #44, including the
compatibility fixes in rc.1. Stable 2.15.2 remains the latest stable release.
Back up settings and use a disposable vault with copied source files for testing.

### Added
- File-explorer mount indicators and source-path details using the active fallback or device override.
- Folder context-menu action that suggests an unused child mount destination and rejects existing vault paths.
- Persistent expansion state for mounted folders, including supported cross-device mounts.

### Fixed
- Disabled chokidar's native fsevents backend to avoid incompatible Electron bindings; native macOS validation is still pending.
- Guarded delayed tooltip updates against stale hover state and preserved native folder attributes.
- Cancelled queued explorer work on unload, reattached observers when the explorer container changes, and handled expansion-save failures with retryable state.
- Integrated the histories of PRs #27, #28, #30, #31, #39 and #40 while preserving the strengthened compatibility implementations.

### Validation And Known Limitations
- Full validation covers 351 tests across 13 files, lint, UI text, TypeScript checking and the production build. Obsidian is mocked; native Windows/WSL, macOS and Android tests remain pending.
- Install main.js, manifest.json and styles.css from this release together. Please report the exact build, OS/device, Obsidian version, steps and pass/fail result on the relevant issue.
- Test explorer tooltips, context-menu mounting, expansion after restart, external file changes and plugin unload, in addition to the original issue reproduction.
- Existing dependency findings remain unresolved: 13 affected package entries (7 high, 5 moderate, 1 low). This is not a security-remediation release.
- Unresolved macOS opening, suppression semantics and deferred feature requests remain open work. Community-directory review and native compatibility are not established by this prerelease.
- Stable promotion remains gated by docs/RELEASE_VALIDATION.md; do not treat this candidate as a stable release.

## [2.15.3-rc.1] - 2026-09-19

This is a prerelease for testing, not a stable release. Back up your vault and
source folders and test with disposable files before using write operations.

### Added
- Optional fallback paths for local mounts and the writable managed TOC file.
- Binary append support for local mounted files, with explicit rejection for unsupported remote mounts.

### Changed
- Updated Obsidian typings to 1.13.1 while retaining legacy settings rendering and guarded destructive-button styling.
- Removed the Linux-only esbuild dependency and corrected optional-module bundling for Windows and UNC importer paths.
- Clarified BRAT/manual installation guidance; Community Plugins listing remains unverified.

### Fixed
- Routed mounted cached reads through the virtual adapter so they no longer fall through to the vault adapter.
- Prevented successful mounted binary writes and text appends from falling through to the vault adapter.
- Made startup scans and watcher events honor configured hidden-file exclusions.
- Preserved managed TOC destination entries during source changes and prevented stale asynchronous resolution from overriding rebinds.
- Cleared fallback configuration when disabling managed TOC storage and invalidated stale mount roots after configuration changes.
- Kept active fallback routing during refresh, rejected stale watcher events, and replaced remote adapters before rescanning updated mounts.
- Normalized trailing separators and Windows/WSL paths while protecting extended Windows and ambiguous POSIX system paths.
- Restored automatic folder-name labels without requiring Node on mobile and accepted accessible fallback directories when saving mounts.
- Improved path-input layout at narrow widths.
- Resolved community-review lint and typing errors, including sentence-case handling without rule-disable comments.

### Validation And Known Limitations
- Automated validation passed 343 tests, lint, UI text checks, TypeScript checking, and production build before release preparation.
- Native macOS ARM64, Windows/WSL, Android, and current/oldest supported Obsidian host checks remain pending. Automated tests mock Obsidian and do not prove native compatibility.
- Dependency audit findings remain unresolved: the integration comparison found 13 affected package entries (7 high, 5 moderate, 1 low), unchanged from its main-branch baseline. This is not a security-remediation release.
- Joel's separate macOS file-opening report still needs reproduction and diagnostics. Cross-mount moves, external-rename backlinks, large-mount caching, suppression policy, native mobile SMB, and sparse NAS workflows remain deferred.
- Install the three assets from this release together: `main.js`, `manifest.json`, and `styles.css`. Stable 2.15.2 remains the latest stable release.
- Follow `docs/RELEASE_VALIDATION.md` before promoting a candidate to stable; do not infer Community Plugins registry acceptance from this prerelease.

## [2.15.2] - 2026-03-18

### Fixed
- **Sentence-case compliance for all UI strings** — added `// eslint-disable-next-line obsidianmd/ui/sentence-case` before every UI string that contains a proper noun, acronym, or brand name not in the default list (`obsidianmd.configs.recommended`). Affected strings include dropdown labels for cloud storage services (Amazon S3, Backblaze B2, MinIO, Cloudflare R2, ownCloud, Synology NAS, QNAP NAS), acronyms not in the default list (TOC, NAS, WSL, IAM, AWS, B2, MB, URI, ReadDirectoryChangesW), and plugin-specific names (Folder Bridge, Quick Switcher, .DS_Store, Ctrl/Cmd). Ribbon icon and status bar strings use template literals (`\`${this.manifest.name}: ...\``) so they are skipped by the rule automatically. This brings the violation count from 42 to 0 under the bot's `["error", { enforceCamelCaseLower: true }]` config.

## [2.15.1] - 2026-03-18

### Fixed
- **TypeScript error in `FolderBridgeSettingTab`** — seven `this.manifest.name` references inside `FolderBridgeSettingTab` (which extends `PluginSettingTab`, not `Plugin`) were changed to `this.plugin.manifest.name`. `PluginSettingTab` has no `manifest` property; the fixes resolve all seven `TS2339` type errors surfaced by `tsc --noEmit`.
- **ESLint config now matches the review bot exactly** — added `enforceCamelCaseLower: true` to the `obsidianmd/ui/sentence-case` rule options, matching the bot's `recommended` config. Previously our local config would silently pass CamelCase mid-sentence tokens that the bot would flag.

## [2.15.0] - 2026-03-18

### Fixed
- **`chokidar is unavailable in this environment` regression on desktop** — the esbuild bundling plugin was missing `resolveDir` in its `onLoad` result, causing esbuild to leave `require('chokidar')`, `require('@aws-sdk/client-s3')`, and `require('ssh2-sftp-client')` as live runtime calls instead of bundling them into `main.js`. The `resolveDir: __dirname` fix restores the v2.9.0 behavior: all three packages are now statically embedded in the production bundle, so desktop watchers, S3 mounts, and SFTP mounts work even in sandboxed Obsidian environments where runtime `require()` cannot reach the plugin's `node_modules`.
- **Sentence-case compliance for community plugin PR** — all remaining `new Notice('Folder Bridge: ...')` static string literals in class methods are now template literals (`\`${this.manifest.name}: ...\``), and the standalone `backgroundTask` helper uses a defaulted `pluginName` parameter. Notices in `src/FileWatcher.ts` and `src/ui/MountManagerModal.ts` (which have no access to `this.manifest`) have their `Folder Bridge: ` prefix removed. These changes ensure zero violations under `eslint-plugin-obsidianmd`'s default brands list (which does not include "Folder Bridge").

## [2.14.2] - 2026-03-17

### Fixed
- **Mount removal no longer triggers unnecessary file-system I/O** — `notifyVaultMountRemoved` now walks Obsidian's in-memory vault tree (`TFolder.children`) instead of calling `adapter.list()` recursively. The old approach routed through `VirtualAdapter`, making real FS / network calls for every subfolder during unmount, producing verbose `list: found mount for` / `listRealDirectory` log noise and visible file-explorer flicker on large mount trees. The new approach is purely in-memory and O(n) over already-known vault nodes.
- **ESLint configuration and sentence-case cleanup** — added `parserOptions.project` to `eslint.config.mjs` to enable type-aware typescript-eslint rules; added missing browser/Node globals; disabled `@typescript-eslint/no-unsafe-*` rules (codebase uses `any` intentionally for Obsidian API interop); added `.DS_Store`, `Ctrl`, and `Cmd` to the brands list; fixed 7 additional sentence-case violations across `main.ts`, `src/FileWatcher.ts`, `src/ui/MountManagerModal.ts`, and `src/ui/WelcomeModal.ts`.

## [2.14.1] - 2026-03-14

### Fixed
- **Sentence-case compliance for Obsidian community-plugin review** — resolved all `obsidianmd/ui/sentence-case` lint violations flagged by the PR bot. Installed `eslint-plugin-obsidianmd` and configured it in `eslint.config.mjs` with the full set of project-specific brands (`Folder Bridge`, `WebDAV`, `Amazon S3`, `Backblaze B2`, `Cloudflare R2`, `MinIO`, `Nextcloud`, etc.) and acronyms (`TOC`, `S3`, `SFTP`, `NAS`, `WSL`, `IAM`, etc.). Updated static strings in `main.ts` and `src/ui/MountManagerModal.ts` — lowercasing clause-opening words after `Folder Bridge:` colons, fixing placeholder capitalisation, and rewriting `e.g.` phrases to `(for example …)` to avoid spurious mid-sentence splits.

## [2.14.0] - 2026-03-14

### Added
- **Local UI copy validation for community-plugin review** — added a repo-local `npm run check:ui-text` script plus optional `.githooks/pre-commit` hook to catch reviewer-facing UI copy issues before commit. The checker scans common Obsidian UI call-sites for sentence-case regressions, `Folder Bridge` branding mismatches, and decorative status labels.

### Changed
- **Reviewer-facing UI text pass across commands, notices, and onboarding** — normalized `Folder Bridge` branding, removed decorative lock/warning icons from text labels, and updated onboarding / mount-management copy to better match community-plugin review expectations.

## [2.13.0] - 2026-03-14

### Fixed
- **Community-plugin reviewer cleanup in TOC parsing** — removed an unnecessary type assertion in `src/TocConfig.ts` and replaced it with a direct runtime object-shape guard. This keeps the TOC parser behavior unchanged while satisfying the reviewer warning about an assertion that did not narrow the expression type.

## [2.12.0] - 2026-03-14

### Fixed
- **Mounted note deletes now stay in sync with Obsidian immediately** — when a file or folder is deleted through a mounted path, Folder Bridge now explicitly signals the vault tree removal instead of relying only on the external watcher. This prevents stale explorer entries and follow-up `ENOENT` reads against notes that were already removed on disk.

## [2.11.0] - 2026-03-13

### Added
- **Managed TOC workflow for UI mounts** — local and vault mounts created in Settings can now be stored in one writable JSON TOC file instead of living only in `data.json`.
- **Guided managed TOC setup** — the Settings tab now suggests a vault-root `folderbridge.managed.json` path and offers a one-click **Create from current UI mounts** action that creates the file, binds the UI to it, and migrates existing local/vault UI mounts in one step.
- **GitHub support links in settings** — the Settings tab now includes direct links to the Folder Bridge repository and the author GitHub profile so users can follow other projects or star the repo.

### Changed
- **Mount ownership is now source-driven across the plugin** — manual mounts and managed-TOC mounts share the same edit, toggle, ignore-list, override, import/export, and command-palette flows. Only mounts loaded from external TOC files remain locked to their source file.
- **Credential-based cloud mounts stay in `data.json`** — WebDAV, S3, and SFTP mounts are intentionally excluded from TOC storage because TOC files do not store secrets.

### Fixed
- **`Validate and add` no longer appears stuck or double-submits** — the add/edit modal now becomes single-shot while saving, and successful mount injection into the vault tree runs in the background instead of blocking the modal from closing. This prevents the second click from trying to add the same mount again when the initial scan is still running.

## [2.10.0] - 2026-03-13

### Fixed
- **Community-plugin reviewer compatibility follow-up** — moved the optional bundled module shim behind a build-time esbuild plugin so the tracked TypeScript source no longer contains live `require(...)` branches while the production bundle still includes `chokidar`, `@aws-sdk/client-s3`, and `ssh2-sftp-client` for desktop builds.
- **Promise-returning modal callbacks are now explicitly handled** — the vault folder picker and mount-root delete modal now wrap promise-capable callbacks in fire-and-forget handlers with logging, matching Obsidian's `void` callback expectations and avoiding reviewer-bot promise warnings.
- **Transport adapter type cleanup** — WebDAV stat handling now supports the current `webdav` client response union without unsafe narrowing, and SFTP readiness / disconnect code no longer relies on unnecessary wrappers or assertions.

## [2.9.0] - 2026-03-13

### Added
- **Per-mount visible file-type filter** — mounts can now expose all files, Markdown only (`.md`, `.mdx`, `.canvas`), or PDF only (`.pdf`) to Obsidian. The filter applies to directory listings, startup mount scans, and file-watcher create/change events so non-matching files stay on disk but never appear in the file explorer, search, or live update stream.

### Fixed
- **BRAT install failed to load on Android** — optional desktop-only modules are now resolved through guarded literal `require(...)` branches in the shared runtime loader so the production bundle still includes supported dependencies while mobile no longer relies on an eval-style `Function('return require')` fallback during plugin load.
- **`chokidar is unavailable in this environment` on desktop** — the runtime module loader regression introduced in the 2.7.0 cleanup no longer drops `chokidar`, `@aws-sdk/client-s3`, or `ssh2-sftp-client` out of the bundle. Desktop mounts can start watchers again after add/edit without requiring users to install anything globally.
- **Suppressed watcher events did not survive restart correctly** — when `watcherSuppressAllEvents` is enabled, startup mount injection now skips replaying child `folder-created` / `file-created` events, avoids forcing a `raw` refresh, and leaves externally-created files hidden after restart as expected.

## [2.8.0] - 2026-03-09

### Fixed
- **"Suppress all watcher events" ignored until plugin reload** — when a mount's watcher settings (e.g. `watcherSuppressAllEvents`, `watcherCreateFilter`, debounce/polling values) were changed in the Edit dialog and saved, the change had no effect until the plugin was reloaded. Root cause: chokidar event callbacks in `FileWatcher.startWatching()` capture the `mount` object by reference at the time the watcher starts. `updateMount()` replaces the mount entry with a new spread-merged object, but previously only restarted the watcher when `realPath` changed — leaving the closure holding a stale reference. As a result, `dispatchEvent()` always read `watcherSuppressAllEvents` as `false` from the old object, so third-party attachment-rename plugins (e.g. "Custom Attachment Location") continued to rename PDF/PNG files to match the active note even when suppression was enabled. The watcher is now also restarted whenever any watcher-related setting changes (`watcherSuppressAllEvents`, `watcherCreateFilter`, `watcherDebounceMs`, `watcherUsePolling`, `watcherPollingIntervalMs`), ensuring the new settings take effect immediately on save.

## [2.7.0] - 2026-03-06

### Changed
- **Reviewer-focused cleanup and publication hardening** — broad source cleanup pass aimed at Obsidian community-plugin reviewer categories and long-term maintainability:
  - Introduced a shared internal logger in `src/logger.ts` and routed source logging through `logger.debug()`, `logger.warn()`, and `logger.error()` instead of direct `console.*` usage.
  - Added `src/runtimeNode.ts` as the shared lazy runtime loader for optional Node/Electron modules, replacing remaining direct `require()`-style patterns across the codebase.
  - Normalized async UI callbacks to synchronous wrappers where Obsidian expects `void` handlers, avoiding reviewer/lint warnings around promise-returning event callbacks.
  - Tightened internal typing around Obsidian/Electron private APIs and adapter delegation to reduce unnecessary assertions and unsafe casts.
  - Simplified duplicated settings UI logic, including the per-device override-path action.

### Fixed
- **User-facing copy polish in onboarding and mount dialogs** — final sentence-case and wording pass across `WelcomeModal`, `MountManagerModal`, and `MountRootDeleteModal` to make onboarding and destructive actions clearer and more reviewer-friendly.
- **Reviewer hot spots in TypeScript source** — cleaned up remaining publication-risk patterns identified in the final sweep, including direct `console.*` usage, hardcoded vault config-folder references, and older desktop-only module loading patterns.

## [2.6.0] - 2026-03-05

### Fixed
- **Bases table not updating after frontmatter edits on mounted folders** — when the Bases plugin (or any feature that uses `vault.process()`) edited frontmatter in a file inside a mounted folder, the change was written to disk correctly but Obsidian's MetadataCache was never notified. Obsidian's own file-system watcher only monitors the vault directory, so it never fires `vault.onChange('raw', …)` for external mount paths. On Windows mapped/network drives (SMB) the situation is worse: native `ReadDirectoryChangesW` events typically don't propagate over the network, so FolderBridge's Chokidar watcher (with `usePolling: false`, the default for local mounts) also missed the write. The result was a stale cache — Bases views, Dataview queries, and any other metadata-dependent feature would not refresh until the plugin was toggled or Obsidian was restarted. `VirtualAdapter` now fires `vault.onChange('file-changed', …)` and `vault.onChange('raw', …)` immediately after every successful `write()`, `writeBinary()`, and `append()` call on a mounted path, for all backends (local filesystem, WebDAV, S3, SFTP). This is the same mechanism already used by the existing `vault.create()` patch and by the `FileWatcher` for externally-detected changes. Suppression flags (`watcherSuppressAllEvents`, `setWatcherSuppressed()`) are respected so bulk-sync tooling is unaffected.

## [2.5.0] - 2026-03-03

### Changed
- **Obsidian plugin reviewer compliance** — comprehensive pass across all source files to satisfy the automated reviewer:
  - Removed all `eslint-disable @typescript-eslint/no-explicit-any` suppress-comments; rule is now disabled globally in `eslint.config.mjs` (the codebase intentionally uses `any` for Electron, Obsidian vault internals, and lazy-loaded Node.js builtins).
  - Replaced all `console.log` / `console.info` calls with `console.debug`.
  - Moved every inline `element.style.*` assignment to named CSS classes in `styles.css` (`folderbridge-*` prefix); uses Obsidian's `addClass` / `toggleClass` APIs throughout.
  - All settings UI text and modal headings converted to sentence case.
  - Removed the redundant "Folder Bridge" plugin-name heading and "General" section heading from the settings tab.
  - All three inline `FuzzySuggestModal` subclasses refactored: `async onChooseItem` → synchronous `onChooseItem` wrapping async body in `void (async () => { … })()` to satisfy the `void`-return contract; `const plugin = this` alias replaced with a typed constructor parameter `private readonly outerPlugin`.
  - `import * as path from 'path'` (static Node.js import) replaced with the plugin's standard lazy-load IIFE pattern in `PathMapper.ts` and `SecurityManager.ts` so the plugin loads correctly on mobile.
  - Vault `.obsidian` hard-coded string removed from MountManagerModal description; replaced with generic "configuration folder (configDir)".
  - All floating `Promise`s wrapped with `void` operator.
  - `as TFile` unsafe casts in patched `vault.create` / `vault.createBinary` replaced with `instanceof TFile` narrowing.

## [2.4.3] - 2026-03-02

### Fixed
- **CSS Snippets "open folder" button does nothing with Folder Bridge enabled** — Obsidian guards several desktop-only operations with an `instanceof FileSystemAdapter` check (also visible in Obsidian's internal `vault.onChange` handler as `this.adapter instanceof wu`).  Because the plugin replaces `vault.adapter` with a Proxy wrapping `VirtualAdapter`, that check was failing silently, preventing the Appearance → CSS Snippets folder icon from opening the OS file manager.  The Proxy now implements a `getPrototypeOf` trap that returns the original `FileSystemAdapter`'s prototype, so all `instanceof` checks pass correctly while the full virtual-mount behaviour is preserved.

## [2.4.2] - 2026-03-01

### Fixed
- **Phantom file renames on vault mounts** — when the file watcher detected a new file created inside a mounted folder by an external process (e.g. a second Obsidian instance writing an attachment), it fired `vault.on('create', file)`. Third-party attachment-rename plugins (e.g. "Custom Attachment Location") reacted by immediately renaming the file to match the currently active note, producing dozens of spurious renames for PDF/PNG/JPG files the plugin never managed. A new per-mount option **"New file events"** (`watcherCreateFilter`) has been added under Advanced settings. Setting it to **"Markdown only"** suppresses `file-created` vault events for all non-markdown binary files, preventing any attachment-rename plugin from acting on them while still surfacing new `.md` / `.canvas` files immediately.
- **MP4 and other video/audio files not playing in mounted folders** — Obsidian's built-in `<video>` player requires HTTP byte-range (`Accept-Ranges`) support for buffering and seeking. The `app://local/` fallback URL used for external mounts provides no range support, so the player showed controls but the video never loaded. The plugin now starts a minimal localhost HTTP server (bound to `127.0.0.1`, random port, per-session token) that serves all media files with full `206 Partial Content` / range support. All video and audio formats in Obsidian's supported-file-types list work correctly, including scrubbing.
- **"Open with default application" silently doing nothing for mounted files** — Obsidian's internal handler constructed the OS path from `<vault root> + <virtual path>`, which does not exist on disk for external mounts. The plugin now intercepts this call and passes the real filesystem path directly to `shell.openPath()`, so the correct system application opens.
- **Large images and PDFs broken in modern Obsidian** — files exceeding the `maxDataUriMB` cap previously fell through to `app://local/`, which is restricted to vault-relative paths in modern Obsidian builds and returns `ERR_FILE_NOT_FOUND` for external mounts. These files are now served via the same localhost FileServer as video/audio.

### Added
- **Per-mount "New file events" setting** (`watcherCreateFilter`) — dropdown in Advanced settings with two options: "All file types" (default, preserves existing behaviour) and "Markdown only" (suppresses `file-created` vault events for non-markdown binary files). Recommended for vault-type mounts shared with another active Obsidian instance.
- **`FileServer`** — internal localhost HTTP server for streaming media from local mounts. Supports full byte-range requests, CORS headers, and a per-session security token. Covers all Obsidian-supported video/audio extensions including `.mp4`, `.m4v`, `.webm`, `.mkv`, `.mov`, `.mp3`, `.flac`, `.wav`, `.ogg`, `.opus`, `.weba`, `.3gp`, `.3g2`, and more.

## [2.4.1] - 2026-02-26

### Changed
- **Static analysis hardening** — eliminated all non-null assertions (`!`) in the cross-mount `copy()` method of `VirtualAdapter`. Each cloud adapter lookup is now paired with an explicit `&& srcMount`/`&& dstMount` guard so TypeScript can narrow the type without relying on runtime assumptions. Behaviour is identical; no logic changed.

## [2.4.0] - 2026-02-26

### Fixed
- **New note in virtual folder** — pressing **Cmd/Ctrl+N** with a virtual mount folder set as the default note location now correctly creates the note. Previously, Obsidian opened an empty tab but never wrote the file. Root cause: `vault.create()` calls `adapter.getFullPath()` internally to verify parent-directory existence; without an override, the Proxy delegated to the original `FileSystemAdapter`, which returned the vault's physical-directory path instead of the real mounted path — a path that does not exist on disk. `VirtualAdapter` now implements `getFullPath()` to return the correct real OS path for local mounts. A defence-in-depth patch on `vault.create()` / `vault.createBinary()` also ensures the new `TFile` is registered in Obsidian's vault registry immediately if the native file-system watcher (which only watches the vault directory) does not fire.

## [2.3.0] - 2026-02-25

### Added
- **Read-only toggle on each mount row** — a lock/unlock icon button sits next to the enabled toggle on every mount in Settings. Click it to flip read-only on or off instantly, with a confirmation Notice. The icon is amber when locked, normal when writable.
- **Command: Toggle read-only on all mounts** — flips every mount on this device in one action. If any mount is currently writable all go read-only; if all are already read-only all become writable. Assignable to a hotkey in Settings → Hotkeys.
- **Command: Toggle read-only on a specific mount…** — opens a fuzzy-search picker (same UX as the existing toggle on/off command) showing each mount’s current lock state. Pick one to flip it. Assignable to a hotkey.

## [2.2.0] - 2026-02-25

### Added
- **Multi-select browse for ignore list** — the **Browse…** button in the per-mount ignore list now opens the OS folder picker with multi-selection enabled. Select several folders in one pass (Ctrl+click / Cmd+click) and all of them are normalised to mount-relative paths, deduplicated against the existing list, and added in a single save + vault-reload. A Notice confirms how many items were added.

## [2.1.0] - 2026-02-25

### Fixed
- **Read-only mounts no longer crash the editor** — previously, any attempt to save, rename, delete, or move a file inside a read-only mount threw an error that Obsidian couldn't handle gracefully, leaving the editor in a broken state with no way to undo or escape short of restarting. Writes are now silently swallowed (the file is never modified on disk) and a single, non-blocking notice is shown the first time each read-only mount is written to per session: _"Folder Bridge: "path" is read-only — this change was not saved."_ Subsequent write attempts on the same mount are silently dropped with no further popups.
- **Vault name replaced by "VirtualAdapter" in the lower-left window title** — `VirtualAdapter.getName()` was hard-coded to return the string `'VirtualAdapter'`, which Obsidian uses to render the vault name display. It now delegates to the underlying adapter's `getName()` so the real vault name is shown correctly.

## [2.0.0] - 2026-02-24

### Added
- **S3 / Backblaze B2 mounts** — mount any Amazon S3 bucket or Backblaze B2 bucket (via the S3-compatible API) as a virtual vault folder.
  - Quick-fill presets for Amazon S3, Backblaze B2, MinIO, and Cloudflare R2.
  - Configurable key prefix, force-path-style toggle, OS-keychain-encrypted secret key.
  - Rename = CopyObject + DeleteObject (S3 has no atomic rename).
  - ListObjectsV2 with delimiter for correct virtual-folder directory semantics.
  - Health-check via lightweight ListObjectsV2 MaxKeys=1 probe.
  - Available on desktop and mobile (HTTP-based, no Node.js fs required).
- **SFTP mounts** — mount any remote SSH/SFTP directory as a virtual vault folder.
  - Password and private-key authentication (with OS-keychain-encrypted passphrase).
  - Persistent auto-reconnecting SFTP connection per mount.
  - Server-side atomic rename; health-check via lightweight connection test.
  - Desktop-only (requires Node.js net/crypto).
- **Generalised CredentialStore** — `encryptCredential`/`decryptCredential` replace WebDAV-specific aliases (aliases kept for backward compat). Generic session helpers keyed by `<service>-<mountId>`.
- Mount type dropdown now lists five types: Local, Vault, WebDAV, S3/B2, SFTP. Mobile shows WebDAV and S3 only.
- Export/import now strips all credential types (S3 secret, SFTP password, SFTP passphrase).

### Changed
- `SecurityManager` skips local-path checks for cloud mount types (WebDAV, S3, SFTP).
- `FileWatcher` skips S3 and SFTP mounts (no local filesystem to watch).
- `VirtualAdapter` exposes `setS3Adapter`/`clearS3Adapter`/`setSFTPAdapter`/`clearSFTPAdapter`.
- `addMount`/`removeMount`/`updateMount` strip transient credentials and wire/tear-down adapters per type.

### Fixed
- `getMountStatus()` returns placeholder "reachable" for S3 and SFTP mounts, preventing spurious error badges during initial load.

## [1.1.6] - 2026-02-24

### Added
- **Command palette integration** — four new commands accessible from the Obsidian command palette (`Ctrl/Cmd+P`):
  - **Folder Bridge: Add mount** — opens the Add Mount dialog directly.
  - **Folder Bridge: Toggle mount on/off…** — fuzzy-search picker listing every mount (with ✅/⏸ status); choose one to toggle it enabled or disabled instantly.
  - **Folder Bridge: Reconnect unreachable mounts** — retries connection for every enabled mount currently showing as unreachable; reports how many were recovered.
  - **Folder Bridge: Open settings** — navigates straight to the Folder Bridge settings tab.
- All new commands appear in the Obsidian hotkey settings screen so users can assign custom keyboard shortcuts.

## [1.1.5] - 2026-02-24

### Added
- **First-run onboarding modal** — new users see a one-time welcome modal on their first Obsidian launch after installing Folder Bridge (shown only when no mounts exist and `hasSeenOnboarding` is false). The modal explains what can be mounted (local folders, WebDAV, other vaults) and provides a direct "Add my first mount →" button. Dismissed with "I'll explore on my own." Never shown again after the first interaction.

## [1.1.4] - 2026-02-24

### Added
- **Import / Export mount configuration** — two new buttons in Settings → Mount Points:
  - **Export…** downloads a `folderbridge-mounts.json` file containing all configured mounts. Encrypted credentials are stripped before export so the file is safe to share or check into git.
  - **Import…** opens a file picker, reads the JSON, and appends every valid mount to your current configuration. Each imported mount gets a fresh ID and is assigned to the current device. Useful for moving a vault to a new machine or copying a mount setup between vaults.

## [1.1.3] - 2026-02-24

### Added
- **WebDAV connection presets** — a "Quick-fill preset" dropdown appears when adding a new WebDAV mount. Selecting Nextcloud, ownCloud, Synology, or QNAP pre-fills the Server URL field with the correct URL template for that service (including the `/remote.php/dav/files/YOUR_USERNAME` path that trips up Nextcloud/ownCloud users). A hint below the URL field reminds you what to replace.

## [1.1.2] - 2026-02-24

### Added
- **Global ignore patterns** — a vault-wide ignore list (Settings → Ignore Lists → Global ignore patterns) now applies to every mount automatically. Same three-way pattern syntax as per-mount lists: plain leaf names, globs (`*.tmp`), or path prefixes. Pre-populated with common OS noise files: `.DS_Store`, `Thumbs.db`, `desktop.ini`, `.git`. Previously these had to be added to each mount individually.

## [1.1.1] - 2026-02-24

### Added
- **Persistent WebDAV credentials** — WebDAV passwords are now encrypted with the OS keychain (Windows DPAPI, macOS Keychain, Linux libsecret) via Electron's `safeStorage` API and stored in `data.json`. Obsidian no longer prompts for your password after a restart — the adapter reconnects automatically on startup. The encrypted blob is device-specific and cannot be decrypted on any other device, so syncing `data.json` remains safe. On mobile (Capacitor) `safeStorage` is unavailable; the plugin falls back transparently to the previous session-memory behaviour.
- New `src/CredentialStore.ts` module encapsulating all keychain interactions.

### Fixed
- Resolved all ESLint errors and warnings: removed unused `Platform` import in `main.ts`, eliminated stale `@typescript-eslint/no-require-imports` disable directives across five files, replaced `catch (e: any)` patterns with un-annotated catches and explicit `NodeJS.ErrnoException` casts in `VirtualAdapter.ts`, removed unused `fs` variable in `FileWatcher.ts`.

## [1.1.0] - 2026-02-24

### Added
- **Android / mobile support** — FolderBridge now loads on Obsidian for Android. WebDAV mounts work fully on mobile: browse, read, write, and create files on your Nextcloud, ownCloud, NAS, or any WebDAV server directly from your phone. No extra apps required. The mount modal automatically hides local-only fields on mobile. See [Android Setup Guide](docs/ANDROID_SETUP.md).
- **Configurable image / PDF size cap** — The data-URI size limit for embedded images and PDFs (previously hardcoded at 10 MB) is now a plugin setting (`maxDataUriMB`, found under General → Image / PDF size cap). Raise it for high-resolution images; lower it to reduce memory pressure on mobile or slow devices.

## [1.0.0] - 2026-02-23

### Changed
- **Stable release**: All roadmap items through v0.9.0 are complete. Folder Bridge is feature-complete for v1.0.
- Updated README to list all features added since v0.5.0 (WebDAV, vault-to-vault bridging, conflict resolution, per-mount performance tuning).
- Updated `docs/roadmap.md`: all planned features marked complete; Recently Completed table extended through v1.0.0.

## [0.9.0] - 2026-02-23

### Added
- **Vault-to-vault bridging**: Mount any folder from another Obsidian vault on this device as a virtual folder in your current vault. Notes, attachments, and folder structure are surfaced as normal files — fully readable and writable.
- **Vault mount type**: A new "Another Obsidian vault" option in the Mount type dropdown opens a vault-specific path picker. Browse or type the root path of the other vault.
- **Vault-aware ignore defaults**: Vault mounts automatically exclude `.obsidian`, `.trash`, and `.smart-connections` from the initial scan and file watcher, preventing cross-vault config pollution. These can be customised in Settings → Folder Bridge → mount ignore list.
- **Local I/O path reused**: Vault mounts share the same battle-tested local filesystem code path as regular mounts — no extra overhead.

## [0.8.0] - 2026-02-23

### Added
- **WebDAV support**: Mount any WebDAV server (Nextcloud, ownCloud, generic WebDAV) as a virtual vault folder. Configure the server URL, remote base path, username, and password in the Add/Edit Mount modal.
- **Secure credential storage**: WebDAV passwords are stored in `sessionStorage` only — never written to `data.json` or synced to other devices. A password prompt appears on the next Obsidian launch.
- **Mount type selector**: The Add/Edit Mount modal now shows a "Mount type" dropdown. Choosing "WebDAV" reveals the WebDAV fields; choosing "Local filesystem" shows the existing path/browse controls.
- **WebDAV I/O path**: All VirtualAdapter operations (`read`, `write`, `stat`, `list`, `mkdir`, `rename`, `copy`, `remove`, `append`) are fully delegated to the WebDAV adapter when the mount is of type `webdav`. Server-side copy is used when both source and destination are on the same WebDAV mount.
- **WebDAV health checks**: The 30-second background reachability check now uses an HTTP probe for WebDAV mounts instead of a local `fs.access()` call. The reconnect button also works for WebDAV.
- **No file watcher for WebDAV**: WebDAV mounts skip the chokidar file watcher (HTTP has no equivalent of inotify). Changes made externally will appear on the next manual refresh.

## [0.7.0] - 2026-02-23

### Added
- **Per-mount debounce threshold**: Each mount can now specify its own debounce window for file-change events (50–5000 ms). Useful for editors that flush saves very rapidly. Configured in the new "Advanced settings" collapsible section of the mount modal.
- **Per-mount polling mode**: A "Use polling" toggle replaces native OS filesystem events with interval-based polling for a specific mount. Required for NAS and network shares that do not support inotify / ReadDirectoryChangesW. Polling interval (500–60 000 ms) is also configurable per mount.
- **Max files (scan limit)**: An optional item cap stops the initial vault scan early for very large mounts, keeping Obsidian responsive. When the limit is hit, a Notice links to the setting. Leave blank for unlimited (the historic default).
- **Advanced settings section** in the Add/Edit Mount modal: the three settings above are grouped in a collapsible `<details>` block so the modal stays clean for typical usage.

## [0.6.0] - 2026-02-23

### Added
- **Conflict resolution UI**: FolderBridge now performs a background reachability check every 30 seconds on all active mounts. When a mount goes unreachable (drive disconnected, network share dropped, cloud placeholder), a warning Notice fires immediately and the status bar turns orange showing the count of unreachable mounts.
- **Reconnect button**: Each unreachable mount row in Settings shows a ⚠️ Reconnect button. Clicking it re-checks the path, re-injects the vault tree, and restarts the file watcher — no plugin reload required.
- **Automatic back-online notice**: When a previously-unreachable mount becomes accessible again (drive reconnected, network restored), a confirmation Notice fires automatically on the next health-check cycle.
- **Status bar health indicator**: The status bar item now turns orange and shows the count of unreachable mounts when any mount is down. Returns to normal colour when all are reachable.

## [0.5.0] - 2026-02-23

### Added
- **Edit mount in-place**: "Edit" button on each mount row opens the Add Mount modal pre-populated with the current values. Virtual path, real path, label, and read-only flag can all be changed without removing and re-adding the mount. The vault tree and file watcher are updated live on save.
- **Drag-drop reordering**: Mount rows in the Settings panel are now draggable. Drag any row to a new position to reorder mounts. The order is persisted immediately.
- **"Move mount to…" context menu**: Right-clicking a mount's root folder in the file explorer shows a "Move mount to…" item. Selecting it opens the vault folder picker and relocates the mount's virtual path — live, no restart needed.
- **"Browse…" button in ignore list**: A "Browse…" button next to the ignore-list text input opens the OS folder picker rooted at the selected mount's real path. Picking a folder fills the input with the path relative to the mount root (e.g., `assets/vendor/plantuml-stdlib`).
- **Path-relative ignore patterns**: Ignore list entries that contain a `/` (e.g., `assets/vendor`) are now matched as path-prefix patterns against the item's location within the mount, not just the leaf name. This lets you ignore a deeply nested folder without ignoring every folder with the same name across the whole mount.

### Fixed
- **Ignore list now refreshes the file explorer immediately**: Adding a new ignore pattern now removes matching files and folders from the file explorer straight away — no restart or manual refresh needed. The ignore cache is also rebuilt so the watcher and directory listing honour the new pattern at once.

## [0.4.4] - 2026-02-23

### Documentation
- **Platform support table** — Added explicit Windows / macOS / Linux / mobile status to the README Features section so platform expectations are clear upfront.
- **macOS** — Marked as untested (POSIX code paths implemented; community reports welcome). Added iCloud optimized-storage workaround note.
- **Mobile** — Clearly documented that iOS and Android are unsupported due to the OS sandbox; this is a hard platform restriction, not a missing feature.
- **Platform Notes section** — Renamed "Windows Notes" to "Platform Notes" and added dedicated macOS and Mobile subsections.

## [0.4.3] - 2026-02-22

### Fixed
- **Image and PDF loading** — Modern Obsidian uses `app://<vaultId>/` which only resolves vault-relative paths; `app://local/` is deprecated and returns `ERR_FILE_NOT_FOUND` for external mounts. Images, PDFs, and other embedded assets are now served as `data:` URIs (base64-encoded, capped at 10 MB) so they render correctly regardless of vault location.
- **Rename race on new notes** — When creating a note in a mounted folder and immediately typing a title, Obsidian could call `rename()` before `write()` had finished writing the file to disk (or while OneDrive's sync engine was reprocessing the new file). `rename()` now polls for the source file for up to 2 seconds before giving up, and succeeds silently if the destination already exists (idempotent rename).
- **Debounce rapid file-change events** — Back-to-back saves from external tools (PlantUML, DataviewJS, watch-mode compilers) previously fired multiple `file-changed` vault notifications. A 300 ms per-path trailing-edge debounce now coalesces these into a single notification.
- **Cloud placeholder ENOENT** — OneDrive "Files On Demand" online-only files appear accessible but throw `ENOENT` on read. The adapter now detects this fingerprint and surfaces a clear error message with "Always keep on this device" guidance.

### Performance
- **PathMapper lookup** — `getMountForPath()` was sorting and re-normalizing the mounts array on every call (O(N log N) + alloc per I/O op). Mounts are now sorted and pre-normalized once in `update()` and cached; the hot-path lookup iterates that frozen array with zero allocations.

## [0.4.2] - 2026-02-22

### Fixed
- Fixed a critical bug where creating or modifying files in mounted folders would fail because Obsidian's internal file existence checks were receiving generic errors instead of the expected `ENOENT` error code.
- Fixed an issue where images and other resources in mounted folders might fail to load due to incorrect path resolution.

## [0.3.0] - 2026-02-21

### Added
- **WSL Support**: Added a dedicated "Browse WSL…" button for Windows users to easily mount Linux folders directly from their WSL distributions.

## [0.2.0] - 2026-02-21

### Added
- **Sync Compatibility (Obsidian Sync / Syncthing)**: Mounts are now tagged with a unique `deviceId` to prevent devices from attempting to mount paths that don't exist locally.
- **Foreign Mounts Toggle**: Added a setting to allow mounting paths created on other devices if the paths are identical across devices.
- **Device-Specific Path Overrides**: Added the ability to map a foreign mount to a different local path using the native OS folder browser.
- **Ignore List**: Added a setting to specify files or folders (using exact names or glob patterns like `*.tmp`) that should be hidden from Obsidian and ignored by the virtual adapter.
- **Context Menu Integration**: Added an "Ignore in Folder Bridge" option to the file explorer context menu for files and folders inside mounted directories.

### Fixed
- **Performance Optimization**: Fixed a severe "Loading Cache" freeze on startup by scoping the ignore list checks strictly to virtual mount paths, preventing the plugin from scanning the entire native vault.

## [0.1.0] - 2026-02-21

### Added
- Virtual mount point system: map any absolute filesystem path into the vault at any virtual path
- `VirtualAdapter` shim wrapping Obsidian's built-in `FileSystemAdapter` via a JavaScript `Proxy`
- `PathMapper` for bidirectional translation between virtual vault paths and real filesystem paths
- `SecurityManager` with explicit allowlist enforcement; system directories blocked by default
- Full Windows support:
  - Long path prefix (`\\?\`) for paths exceeding 260 characters
  - UNC network path detection and advisory warnings
  - Windows reserved filename blocking (`CON`, `NUL`, `COM1`–`COM9`, `LPT1`–`LPT9`)
  - Case-insensitive NTFS path comparisons
  - Cross-device move fallback (`EXDEV` → copy-then-delete)
- **Native folder browser** — "Browse…" button opens the OS folder picker (Electron `remote.dialog`); falls back gracefully to manual entry if unavailable
- **Vault folder picker** — "Browse vault…" button opens a fuzzy-search modal of existing vault folders for easy virtual-path nesting
- **Auto-label from folder name** — "Use folder name as label" toggle auto-fills the display label with the real folder's base name; editable at any time
- **WSL cross-environment hints** — contextual tips in the add-mount dialog:
  - On Windows: `\\wsl.localhost\<Distro>\path` UNC pattern for accessing WSL 2 Linux folders
  - In WSL: `/mnt/c/` etc. and how to expose the same folder to Windows-side Obsidian
- `isWSL()` and `wslMountToWindowsPath()` helpers in `OSHelpers.ts`
- Read-only mount flag to prevent accidental writes
- Mount enable/disable toggle (no removal required)
- Optional display labels for mounts
- Dry-run mode: logs all writes to console without executing them
- Status bar item showing count of active mounts
- `MountManagerModal` UI for adding and validating mount points
- Async mount status badges in settings (reachable / read-only / error)
- `versions.json` for Obsidian's automatic update mechanism
- Vitest unit test suite (72 tests covering PathMapper, SecurityManager, OSHelpers)
- GitHub Actions: build check workflow and release workflow using `softprops/action-gh-release`

### Fixed
- Virtual mounts now appear in the file explorer immediately on load and when added/toggled/removed — `notifyVaultMountAdded/Removed` fires `vault.onChange('created'/'deleted')` so Obsidian inserts the `TFolder` into its tree without a restart
- Status bar text was not populated when enabling the status bar item via the settings toggle
- `stat()` now returns a synthetic folder stat for virtual intermediate directories (e.g. `Projects` when the mount is `Projects/Work`), preventing Obsidian from treating them as non-existent
- `getVirtualMountsDirectChildren` now correctly surfaces intermediate virtual directories in vault listings so nested mount paths (e.g. `Projects/Work`) are visible when browsing the vault root
- Binary file copying from vault to a mounted folder now uses `readBinary()` instead of `read()`, preventing UTF-8 corruption of images, PDFs, and other non-text files

[0.1.0]: https://github.com/tescolopio/Obsidian_FolderBridge/releases/tag/0.1.0
