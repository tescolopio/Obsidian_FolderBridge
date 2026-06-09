# FolderBridge Dev Log

## Cross-Platform Vault Support (fallbackRealPath)

**Date:** 2026-04-07
**Branch:** main
**Files changed:** `main.ts`, `src/types.ts`, `src/PathMapper.ts`, `src/SecurityManager.ts`, `src/TocConfig.ts`, `src/ui/MountManagerModal.ts`

### Problem

FolderBridge stores mount paths in `data.json`, which syncs across devices via Obsidian Sync or git. When a vault is created on Windows (e.g. `D:\Pauls Obsidian\Projects`), those paths are meaningless on Linux or macOS where the same folder may live at `/home/user/Obsidian/Projects`. The existing `allowForeignMounts` toggle was too blunt — it controlled visibility but gave no way to remap paths per platform.

### Solution

Added a `fallbackRealPath` field to `MountPoint`. When the primary `realPath` is inaccessible at plugin load, the plugin automatically tries `fallbackRealPath`. If accessible, it stores the resolved path in memory (never written to `data.json`) and uses it transparently for all I/O. This allows Windows users to set their Windows path as `realPath` and their Linux/macOS path as `fallbackRealPath` — the same `data.json` then works on both platforms with no manual intervention after the initial setup.

The same fallback mechanism was also added to the managed TOC file path (`managedTocSourceFallback`), since users who configure mounts via a TOC JSON file face the identical problem.

### Changes

#### `src/types.ts`
- Added `fallbackRealPath?: string` to `MountPoint` (with JSDoc)
- Added `fallbackRealPath?: string` to `TocFileMount`
- Added `managedTocSourceFallback?: string` to `FolderBridgeSettings`

#### `src/PathMapper.ts`
- Added `resolvedRealPaths: Map<string, string>` — runtime cache of resolved fallback paths (not persisted)
- Added `setResolvedPath()` / `clearResolvedPath()` methods
- Updated `getEffectiveRealPath()` priority: deviceOverride → resolvedFallback → primary path
- `update()` cleans stale entries from the cache when mounts change

#### `src/SecurityManager.ts`
- `validateMount()`: replaced `path.isAbsolute(mount.realPath)` with cross-platform check using `path.posix.isAbsolute || path.win32.isAbsolute`. Previously, saving a mount with a Windows primary path (`D:\...`) on Linux would always fail with "Real path must be an absolute filesystem path" even when editing an existing, unchanged path.

#### `src/TocConfig.ts`
- `serializeMountToTocEntry()`: includes `fallbackRealPath` in the serialized TOC entry
- `parseTocConfig()`: reads and validates `fallbackRealPath` from TOC JSON

#### `src/ui/MountManagerModal.ts`
- Added "Fallback real path" Setting in the local-mount section with text input and Browse button
- Pre-populates from `editMount.fallbackRealPath` when editing an existing mount
- Passes `fallbackRealPath` to `onSave()` callback
- Modal-level absoluteness check also updated to use cross-platform `path.posix.isAbsolute || path.win32.isAbsolute` and only runs when the real path has actually changed (not when only the fallback changed)

#### `main.ts`
- Added `resolveMountPath()` — checks primary path accessibility, falls back to `fallbackRealPath` if needed, stores result via `pathMapper.setResolvedPath()`
- Added `resolveAndCacheManagedTocSource()` — same fallback logic for the managed TOC file path
- Added `managedTocSourceFallback` Browse + save UI in the settings tab
- `addMount()` / `updateMount()`: manages `fallbackRealPath` in the security allowlist
- `isMountEnabledOnThisDevice()`: now also returns `true` when `fallbackRealPath` is set, so cross-platform mounts activate on foreign devices without requiring `allowForeignMounts`
- `syncEffectiveMountState()`: includes `fallbackRealPath` in the allowlist sync

### How to use

1. Open Settings → FolderBridge → edit a mount
2. In the "Real path" field, keep your Windows path (e.g. `D:\Pauls Obsidian\Projects`)
3. In the new "Fallback real path" field, enter your Linux/macOS path (e.g. `/home/user/Obsidian/Projects`)
4. Save — the plugin will use whichever path is accessible on each device

For the managed TOC file, set the fallback path in Settings → FolderBridge → "Managed TOC source" section.

### Platform coverage

This fix benefits all three platforms:
- **Windows → Linux**: primary Windows path skipped, fallback Linux POSIX path used
- **Windows → macOS**: primary Windows path skipped, fallback macOS POSIX path used
- **Linux/macOS → Windows**: primary POSIX path skipped, fallback Windows path used
