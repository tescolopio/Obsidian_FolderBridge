# Compatibility Release Validation

This checklist tracks the unreleased compatibility work following 2.15.2. Local
source reconciliation does not merge PRs, publish a release, or close issues.

## Automated Checks

Run `npm run validate` on the candidate checkout. It runs lint, UI text checks,
TypeScript checking, the production bundle build, and unit tests. In the current
WSL development environment, use `conda run -n folderbridge npm run validate`.

The suite covers configured hidden-path filtering, mounted reads and binary
append, trailing separators, both WSL UNC host names, and the build hook's POSIX,
Windows drive, and UNC importer paths. Obsidian is mocked in unit tests; passing
these checks does not establish native host or device compatibility.

Obsidian typings are now 1.13.1. The manifest's minimum host version remains
unchanged. The new destructive-button API is feature-detected; the existing
settings display entry point remains available to older hosts.

## Native Release Gates

Use a disposable vault and temporary source folders. Back up any files before
testing writes. Install the candidate's `main.js`, `manifest.json`, and
`styles.css` together. Record OS, CPU architecture, Obsidian app and installer
versions, candidate revision, and any console stack for each result.

All native checks below remain pending. Existing CI runs on Ubuntu only.

| Area | Reproduction | Required Result |
| --- | --- | --- |
| macOS ARM64 / #28 | Install dependencies from the lockfile on a clean native checkout; build and enable the candidate in Obsidian. | No Linux-only package installation failure; plugin enables and opens a mounted note. |
| macOS file open / #29 | Mount a temporary local folder both with and without a trailing separator; open its Markdown file from the explorer. Separately reproduce Joel's reported storage/path setup once diagnostics arrive. | Both temporary-folder cases open. Do not infer that Joel's distinct failure is fixed without his reproduction or confirmation. |
| Windows WSL / #33 | Mount the same accessible directory through `\\wsl$\...` and `\\wsl.localhost\...`; open a child note and restart Obsidian. | No false protected-path rejection; note remains readable after restart. |
| Hidden paths / #26 | Include a dot-folder and dot-file, configure an exclusion, then create/edit files and refresh/restart. | Allowed hidden entries appear and update; excluded entries stay hidden. |
| Settings / #35, #41 | Reopen an edited mount with auto-label enabled; edit virtual path at narrow and desktop widths. Repeat on current and oldest supported hosts. | Checkbox state persists; input remains visible and editable; no missing API exception. |
| Footnotes / #34 | Open a mounted note with footnotes in reading view; edit, switch views, reopen, and restart. | Footnotes render and cached content refreshes correctly. |
| Android / #18 | Install the packaged candidate on Android and enable it; configure a supported remote mount. Repeat after restarting the app. | No Node/Electron module-load failure; remote note opens; desktop-only local access is not required. |

Unit tests also cover mounted binary append and rejection for unsupported remote
mounts. Verify binary integrity against disposable files when testing a plugin
workflow that uses `appendBinary`.

## PR And Distribution Gates

- PR #40's path, fallback, credential, and settings compatibility changes are
  represented locally. Remove uses a guarded destructive API; Reconnect is not
  styled as destructive. PR #28's portability and typing changes are represented
  locally. Their GitHub merge conflicts are not resolved by this working-tree work.
- The Windows optional-module importer fix associated with #27 is included and
  regression-tested. Review overlapping PRs #27, #30, and #31 against the final
  candidate before merging or closing them.
- Reconcile branches only after preserving and reviewing the existing uncommitted
  work. Do not sweep unrelated files into a release commit.
- Record native results before a version bump or release. After publishing,
  confirm BRAT/manual installation uses the tested assets.
- The last registry check found no `folderbridge` entry in the official Community
  Plugins registry. The legacy submission link was inaccessible, so its status
  is unverified. Locate or establish the current submission and address its
  checks before resolving #25/#38 or advertising directory installation.

## Deferred Work

These are not fixed by the compatibility batch: #16 suppression semantics, #20
large-mount startup, #21 external-rename backlink updates, #32 cross-mount moves,
#36 native/mobile SMB, and #15 sparse NAS workflows. Each needs its own scoped
behavior and validation plan; do not close them as part of this release.
