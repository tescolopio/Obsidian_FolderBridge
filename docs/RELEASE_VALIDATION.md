# Compatibility Release Validation

This checklist tracks compatibility and explorer integration following 2.15.2.
The compatibility batch shipped as opt-in prerelease 2.15.3-rc.1 through PRs
#42 and #43. The remaining integration adds PR #39 and records the ancestry of
the older PRs whose changes were already included in #42.

On 2026-09-19 the maintainer approved 2.15.3-rc.2 to distribute all merged
changes for testing. It includes the subsequent explorer integration from #44.
The older 2.15.3-rc.1 download does not include that explorer integration.

## Stable Publication Decision

On 2026-09-20 the maintainer explicitly selected stable 2.15.3 publication,
overriding the earlier requirement to wait for native results for this release.
The release consolidates all audited branch work, including the omitted older
behaviors described below. This authorization does not turn pending native
checks into passes. The release notes prominently disclose the broad changes,
backup recommendation, and outstanding native compatibility checks.

The maintainer subsequently requested another stable release on 2026-09-20,
after CI hardening was merged in PR #52. Maintenance release 2.15.4 retains the
same runtime and dependencies as 2.15.3 and carries the same pending-native-test
caveat. This release request does not establish native results or waive the gate
for future runtime changes.

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

Post-rc.2 main also includes PR #47's mounted-file event translation. Regression
tests exercise both the watcher and installed adapter callback against the
checked-in `docs/vault-onchange.txt` handler, checking stat updates, content-cache
invalidation, and public `modify`/`raw` events. That private-handler snapshot has
no recorded host-version provenance; it is not a substitute for native testing.
The historical rc.2 assets do not contain this fix; stable 2.15.3 includes it.
Record the exact revision and assets when running the external-edit check below.

The stable candidate passes all 400 tests across 13 files plus lint, UI text,
typechecking, and the production build. Full and production-only npm audits
report zero known vulnerabilities at preparation time; this is a point-in-time
dependency result, not a guarantee of security.

## Branch And Local Artifact Audit

The audit started from main `b5a8508467da018079f0c4ad844496ef46b099c8`.
The remaining branch tips were reviewed before recording their histories:

| Branch tip | Treatment |
| --- | --- |
| `update-obsidian-folder-bridge` / `7c5d5e6` (includes `pr-23` / `e16880f` and `pr-24` / `a4d1f85`) | Restore missing cross-device refresh/picker eligibility, override reinjection, inactive-mount notices, managed TOC fallback controls/status, labels, progress, bounded parallel removal, and log-only watcher failure reporting. Include a qualified historical devlog. Preserve newer security and lifecycle guards. |
| `maint/fallback-real-path-reviewed` / `915084f` | Reconcile inherited omissions with the restored behavior; keep main's stronger fallback resolution and reinjection safeguards. |
| `fix/watcher-suppression-transitions` / `fbe0563` | Already represented by squash merge #46. |
| `fix/dependency-security` / `430ebf3` | Already represented by squash merge #48. |
| `perf/startup-metadata-batching` / `fa07c99` | Already represented by squash merge #49. |
| `release/2.15.3-rc.2` / `c8b90e3` | Already represented by squash merge #45; stable metadata supersedes prerelease metadata. |

After porting the omitted behavior, history-only merges retain these tips without
reapplying obsolete implementations. Other audited local and remote branch tips
were already ancestors of main. The release PR must use a merge commit, not a
squash merge, to preserve this ancestry.

Local-only files were reviewed individually. Include the sanitized read-only
Obsidian reviewer profile. Keep main's current release checklist and mobile-safe
mount label implementation; the extra build test is already identical to main.
Exclude generated JavaScript, nested checkout artifacts, and raw runtime-validation
logs containing machine-specific paths/metadata. The reusable evaluation plan
duplicates repository validation commands and is not needed in the release.
Original dirty worktrees and their uncommitted files remain untouched.

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
| Explorer / #39 | Add a mount using a native folder's context menu; hover mounted and ordinary rows; collapse and reopen folders; close/reopen the explorer and disable the plugin. | Mount uses a new child destination without shadowing native files; details show the active source; unrelated tooltips are unchanged; expansion persists; decorations and callbacks stop on unload. |
| macOS watcher / #39 | Enable a local mount and create/edit a disposable source file externally. | Watcher starts without native fsevents binding errors and updates the mounted tree. |
| External modifications / #47 (post-rc.2 main) | Open a copied mounted note in Obsidian; change its body, headings, and frontmatter using an external editor. Check the note, Outline, and metadata-dependent views without reopening, then edit and save in Obsidian. Repeat an in-app frontmatter write with native watcher delivery unavailable. | External changes refresh without toggling the plugin; Outline and metadata update; subsequent saves preserve the external edits. The adapter callback updates metadata even without native watcher delivery. Record results on current and oldest supported hosts; do not use valuable source files. |

Unit tests also cover mounted binary append and rejection for unsupported remote
mounts. Verify binary integrity against disposable files when testing a plugin
workflow that uses `appendBinary`.

## PR And Distribution Gates

- PRs #27, #28, #30, #31, and #40 were audited against main at 46a53d2. All
  behavioral changes are represented by #42 and follow-up regression fixes.
  Their ancestry is integrated without reapplying the older implementations or
  #40's obsolete version metadata. Remove retains its guarded destructive API;
  Reconnect remains neutral.
- PR #39's explorer metadata, context action, expansion persistence, and fsevents
  workaround are integrated with additional destination and lifecycle guards.
  Automated tests cover native-path rejection, effective-source metadata,
  device overrides, stale tooltips, unload, observer replacement, and save errors.
- Reconcile branches only after preserving and reviewing the existing uncommitted
  work. Do not sweep unrelated files into a release commit.
- Normally record native results before a version bump or release. The explicit
  publication decisions above cover 2.15.3 and its CI-only 2.15.4 follow-up; continue collecting native
  results. After publishing, confirm the downloadable assets match the tested build.
- The community website has a FolderBridge entry, now claimed by the maintainer.
  The directory reports no matching release despite the exact prerelease tag and
  assets existing on GitHub. Prerelease filtering versus stale directory data is
  not established. Use the authenticated branch preview and release recheck;
  do not claim directory approval or in-app availability from the listing alone.
- Legacy submission #10426 had a passing entry-validation run, not verified full
  approval. Current review concerns include suppressed unsafe-return lint errors,
  donation-link placement, and minimum-host/mobile declarations. Track these
  separately from the functional integration and native test results.

## Deferred Work

These are not fully resolved by this release: #16 suppression semantics, #20
large-mount startup (metadata batching is included, native timing and persistent
caching are not), #21 external-rename backlink updates, #32 cross-mount moves,
#36 native/mobile SMB, and #15 sparse NAS workflows. Each needs its own scoped
behavior and validation plan; do not close them as part of this release.
