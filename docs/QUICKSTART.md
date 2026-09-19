# Quick Start Guide

Get up and running with FolderBridge development in 5 minutes!

## 🚀 Quick Setup

### 1. Install Dependencies (2 minutes)

```bash
npm install
```

### 2. Build the Plugin (30 seconds)

```bash
npm run build
```

This creates:
- `main.js` - The compiled plugin
- Uses TypeScript type checking
- Bundles all dependencies

### 3. Link to Obsidian (1 minute)

**Option A: Symbolic Link (Recommended)**
```bash
# macOS/Linux
ln -s "$(pwd)" "/path/to/your/vault/.obsidian/plugins/obsidian-folderbridge"

# Windows (PowerShell as Admin)
New-Item -ItemType SymbolicLink -Path "C:\path\to\vault\.obsidian\plugins\obsidian-folderbridge" -Target "$(Get-Location)"
```

**Option B: Manual Copy**
```bash
# Copy files to your vault's plugins directory
cp main.js manifest.json styles.css "/path/to/vault/.obsidian/plugins/obsidian-folderbridge/"
```

### 4. Enable in Obsidian (1 minute)

1. Open Obsidian
2. Go to: **Settings → Community Plugins**
3. Turn off "Restricted mode" (if enabled)
4. Reload Obsidian, then find "Folder Bridge" in the installed plugins list (not **Browse**)
5. Click **"Enable"**

### 5. Start Developing! (Optional)

For hot-reload development:

```bash
npm run dev
```

Then install the **Hot Reload** community plugin in Obsidian for automatic updates!

## ✅ Verify Installation

Look for:
- 📁 Folder icon in the left ribbon
- "FolderBridge: Ready" in the status bar
- "FolderBridge" in Settings → Community Plugins

## 🎯 Next Steps

1. **Read the docs**: Check out `DEVELOPMENT.md` for detailed information
2. **Configure settings**: Open Obsidian Settings → FolderBridge
3. **Start coding**: Edit `main.ts` to implement features
4. **Test changes**: Use `npm run build` and reload Obsidian

## 📚 Key Files

- `main.ts` - Main plugin code (edit this!)
- `manifest.json` - Plugin metadata
- `styles.css` - Custom styling
- `package.json` - Dependencies and scripts

## 🔧 Useful Commands

```bash
npm run dev      # Development mode with watch
npm run build    # Production build
npm run version  # Bump version
```

## ❓ Need Help?

- **Build errors?** Make sure Node.js 20+ is installed
- **Plugin not showing?** Check the .obsidian/plugins directory
- **Hot reload not working?** Install Hot Reload plugin in Obsidian
- **More details?** See `DEVELOPMENT.md`

## 🎉 You're Ready!

The development environment is fully configured with:
- ✅ TypeScript with strict type checking
- ✅ esbuild for fast bundling
- ✅ ESLint for code quality
- ✅ Hot-reload support
- ✅ VS Code integration
- ✅ Clean plugin foundation

Happy coding! 🚀
