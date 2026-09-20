# Development Guide

This document provides detailed instructions for setting up and developing the FolderBridge plugin for Obsidian.

## Prerequisites

### Required Software

1. **Node.js (LTS)**
   - Version: 20.x or higher
   - Download from: https://nodejs.org/
   - Verify installation: `node --version`

2. **Package Manager**
   - npm (comes with Node.js): `npm --version`
   - OR pnpm (faster alternative): `npm install -g pnpm`

3. **Obsidian**
   - Download from: https://obsidian.md/
   - Desktop app required (plugin is desktop-only)

### Recommended Tools

- **IDE**: Visual Studio Code with TypeScript extensions
- **Git**: For version control
- **Hot Reload Plugin**: Install in Obsidian for automatic plugin reloading

## Initial Setup

### 1. Clone and Install Dependencies

```bash
# Clone the repository
git clone https://github.com/tescolopio/Obsidian_FolderBridge.git
cd Obsidian_FolderBridge

# Install dependencies
npm install
```

### 2. Configure TypeScript

TypeScript is already configured via `tsconfig.json`. The configuration includes:
- Target: ES6
- Module: ESNext
- Strict null checks enabled
- Source maps for debugging

No additional configuration needed.

### 3. Enable Developer Mode in Obsidian

1. Open Obsidian
2. Navigate to: **Settings** → **Community Plugins**
3. Make sure **"Restricted mode"** is turned **off** so community plugins can run
4. Click **"Turn on Developer Mode"** (appears once Restricted mode is off and Community Plugins are enabled)

### 4. Link Plugin to Obsidian Vault

Create a symbolic link from your vault's plugins directory to this project:

**macOS/Linux:**
```bash
ln -s "$(pwd)" "/path/to/your/vault/.obsidian/plugins/obsidian-folderbridge"
```

**Windows (PowerShell as Administrator):**
```powershell
New-Item -ItemType SymbolicLink -Path "C:\path\to\your\vault\.obsidian\plugins\obsidian-folderbridge" -Target "$(Get-Location)"
```

**Alternative (Copy Method):**
If symbolic links don't work on your system, you can manually copy files after each build:
```bash
# After running npm run build
cp main.js manifest.json styles.css "/path/to/your/vault/.obsidian/plugins/obsidian-folderbridge/"
```

## Development Workflow

### Build Commands

#### Development Mode (with watch and hot-reload)
```bash
npm run dev
```
- Watches for file changes
- Automatically rebuilds on save
- Includes source maps for debugging
- Works with Hot Reload plugin for instant updates

#### Production Build
```bash
npm run build
```
- Type-checks TypeScript files
- Creates optimized production build
- No source maps (smaller file size)
- Use for final testing and releases

#### UI copy style check
```bash
npm run check:ui-text
```
- Scans common UI text call-sites such as `setName(...)`, `setDesc(...)`, `setTooltip(...)`, `setButtonText(...)`, `setTitle(...)`, `setText(...)`, and `new Notice(...)`
- Fails on branding and status-label issues such as `Folder bridge:` prefixes, lowercase text after `Folder Bridge:`, and decorative status icons in reviewer-facing UI text

#### Full local validation
```bash
npm run validate
```
- Runs the UI text check, production build, and full test suite in one command

#### Mount scan benchmark

```bash
node scripts/benchmark-mount-scan.mjs a0600814ce4530b2c0eb2f0b4051d38bb8b5daef
```

Compares the scanner at the given Git revision with the working-tree scanner.
The revision defaults to `HEAD`; pass a pre-optimization revision after committing
the optimization. Run after installing dependencies, from a checkout with that
revision available locally.

The script creates 20,000 zero-byte image files across 100 directories under the
OS temporary directory, alternates baseline/current order over five trials each,
and removes its fixture afterward. It checks identical notification order, file
and folder counts, and metadata-read counts, then prints per-trial timings and
medians as JSON. The scanner's normal event-loop yields remain enabled.

On Linux with Node 22.14.0, the serial baseline above measured a 1,215 ms median
versus 784 ms for batches of eight local metadata reads, a 35.5% reduction. Both
performed 20,000 metadata reads; the change overlaps I/O rather than eliminating
it. WebDAV, S3, and SFTP scans remain serial.

This is a scanner microbenchmark, not an Obsidian startup measurement: vault
notifications are no-ops, file contents are not read, and OS caches are not
flushed. It does not model a cold disk, NAS latency, watcher startup, or Obsidian
indexing. Native before/after measurements on representative mounts are still
required; there is no timing threshold in CI.

#### Optional pre-commit hook
```bash
npm run hooks:install
```
- Configures this clone to use the repo's `.githooks/pre-commit` hook
- The hook currently runs `npm run check:ui-text` before each commit
- This is intentionally lightweight so it catches copy regressions without making every commit wait for the full build/test cycle

#### Version Bump
```bash
npm run version
```
- Updates version in `manifest.json` and `versions.json`
- Automatically runs as part of npm version commands

## Releasing a New Version

The release pipeline is fully automated via GitHub Actions (`.github/workflows/release.yml`).
To cut a release:

1. **Update `CHANGELOG.md`** — add a new `## [X.Y.Z] - YYYY-MM-DD` section above the previous release with the changes for this version, and add a link reference at the bottom.

2. **Bump the version** — run the following command (replace `X.Y.Z` with the new version):
   ```bash
   npm version X.Y.Z
   ```
   This will:
   - Update `package.json`, `manifest.json`, and `versions.json` with the new version
   - Create a Git commit (`chore: X.Y.Z`)
   - Create a Git tag `X.Y.Z` (no `v` prefix — configured via `.npmrc`)

3. **Push the commit and tag**:
   ```bash
   git push && git push --tags
   ```

4. **GitHub Actions takes over** — pushing the `X.Y.Z` tag triggers the release workflow, which:
   - Runs tests and the production build
   - Validates the tag matches `manifest.json`
   - Extracts release notes from `CHANGELOG.md`
   - Creates a GitHub Release with `main.js`, `manifest.json`, and `styles.css` as downloadable assets

> **Note:** The tag must not have a `v` prefix (e.g. use `0.2.0`, not `v0.2.0`). The `.npmrc` setting `tag-version-prefix=` ensures `npm version` honors this automatically.

### Hot Reload Setup

1. Install the **Hot Reload** plugin in Obsidian:
   - Open Settings → Community Plugins → Browse
   - Search for "Hot Reload"
   - Install and enable it

2. The `.hotreload` file in the project root enables hot-reload functionality

3. Start development mode:
   ```bash
   npm run dev
   ```

4. Make changes to `main.ts` and save
5. Plugin automatically reloads in Obsidian!

### Manual Reload (without Hot Reload plugin)

1. Open Command Palette in Obsidian (Ctrl/Cmd + P)
2. Run: **"Reload app without saving"**
3. Or use: Ctrl/Cmd + R (on some platforms)

## Project Structure

```
Obsidian_FolderBridge/
├── .editorconfig           # Editor configuration
├── .eslintrc              # ESLint configuration
├── .gitignore             # Git ignore rules
├── .hotreload             # Hot-reload marker
├── .npmrc                 # npm configuration
├── esbuild.config.mjs     # Build configuration
├── .githooks/             # Optional repo-local git hooks
├── main.ts                # Main plugin entry point
├── manifest.json          # Plugin metadata
├── package.json           # Dependencies and scripts
├── README.md              # User documentation
├── scripts/               # Local validation and maintenance scripts
├── DEVELOPMENT.md         # This file
├── styles.css             # Plugin styles
├── tsconfig.json          # TypeScript configuration
├── version-bump.mjs       # Version management script
└── versions.json          # Version compatibility tracking
```

## Code Organization

### Main Plugin File (`main.ts`)

The plugin follows Obsidian's plugin structure:

1. **Plugin Class**: Extends `Plugin` from Obsidian API
   - `onload()`: Initialize plugin, add UI elements, load settings
   - `onunload()`: Cleanup when plugin is disabled
   - `loadSettings()`: Load saved settings from Obsidian
   - `saveSettings()`: Save settings to Obsidian

2. **Settings Interface**: Define data structure for plugin settings
   - Typed with TypeScript interfaces
   - Default values provided

3. **Settings Tab**: Extends `PluginSettingTab`
   - `display()`: Render settings UI
   - Uses Obsidian's `Setting` API for consistent UI

### TypeScript Best Practices

- Use strict type checking (enabled in `tsconfig.json`)
- Define interfaces for all data structures
- Use async/await for asynchronous operations
- Follow Obsidian API patterns and conventions

## Building the Virtual Filesystem Adapter

The current implementation provides a foundation. To implement the virtual filesystem adapter:

### Phase 1: Path Mapping
- Create a `PathMapper` class to track virtual → real path mappings
- Implement path resolution logic
- Handle path normalization and validation

### Phase 2: File Operations
- Intercept Obsidian's file system operations
- Implement adapters for read, write, delete, move operations
- Route operations to real filesystem paths

### Phase 3: Directory Listing
- Override directory listing to show virtual folders
- Merge virtual and real directory contents
- Handle recursive operations

### Phase 4: File Watching
- Monitor real filesystem for changes
- Sync changes to Obsidian's virtual view
- Handle conflicts and race conditions

## Debugging

### Console Logging
```typescript
console.log('FolderBridge:', 'message', data);
```
View logs in:
- Obsidian: Open Developer Console (Ctrl/Cmd + Shift + I)
- Look for messages prefixed with "FolderBridge:"

### TypeScript Errors
```bash
# Check for type errors without building
npx tsc --noEmit
```

### ESLint
```bash
# Check for code style issues
npx eslint main.ts

# Auto-fix issues
npx eslint main.ts --fix
```

## Testing

### Manual Testing Checklist

1. **Plugin Loading**
   - [ ] Plugin appears in Community Plugins list
   - [ ] Plugin can be enabled/disabled
   - [ ] No errors in console on load

2. **UI Elements**
   - [ ] Ribbon icon appears
   - [ ] Status bar shows "FolderBridge: Ready"
   - [ ] Settings tab accessible

3. **Settings**
   - [ ] Settings tab opens without errors
   - [ ] Settings persist after reload

4. **Build Process**
   - [ ] `npm run build` completes without errors
   - [ ] `npm run dev` watches for changes
   - [ ] Hot reload works (if Hot Reload plugin installed)

## Common Issues

### Issue: Module not found errors
**Solution**: Run `npm install` to ensure all dependencies are installed

### Issue: TypeScript errors about Obsidian API
**Solution**: Make sure `obsidian` package is in devDependencies and installed

### Issue: Plugin doesn't appear in Obsidian
**Solution**: 
1. Check that plugin is in the correct directory
2. Verify `manifest.json` exists
3. Restart Obsidian
4. Check Developer Console for errors

### Issue: Hot reload not working
**Solution**:
1. Verify `.hotreload` file exists
2. Install Hot Reload plugin in Obsidian
3. Ensure `npm run dev` is running
4. Check that symbolic link is valid

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test thoroughly
5. Submit a pull request

## Resources

- [Obsidian API Documentation](https://github.com/obsidianmd/obsidian-api)
- [Obsidian Plugin Developer Docs](https://docs.obsidian.md/Plugins/Getting+started/Build+a+plugin)
- [Sample Plugin Template](https://github.com/obsidianmd/obsidian-sample-plugin)
- [Obsidian Plugin Forum](https://forum.obsidian.md/c/plugin-development/)

## License

MIT License - see LICENSE file for details
