# Native Test Results

Results sheet for the native checks in the
[release validation checklist](RELEASE_VALIDATION.md). That checklist defines the
reproduction steps and required results; this file records what was actually run.
Every row starts as **Not run**. Automated tests and Ubuntu CI do not count as
native evidence.

Rules for filling it in:

- One row per run. If a check is repeated on another OS or build, copy the row
  rather than overwriting the earlier result.
- Use a disposable vault and copies of source files. Back up settings first.
- Install `main.js`, `manifest.json` and `styles.css` from the same release.
- Result is one of **Pass**, **Fail**, **Blocked** (could not set up) or **Not run**.
  A pass covers only the build and environment named in that row.
- Redact usernames, hostnames, server URLs and credentials from paths and console
  output before pasting them anywhere public.

## Environment Record

Fill in once per test machine or device and refer to it by its label.

| Field | Value |
| --- | --- |
| Label (for example `win11-a`) | |
| OS and version | |
| CPU architecture | |
| Obsidian app version | |
| Obsidian installer version | |
| Folder Bridge build (release tag or commit) | |
| Other plugins enabled | |
| Tester and date | |

## Results

| # | Check | Issue | Env label | Result | Evidence (screenshot, console stack, notes) |
| --- | --- | --- | --- | --- | --- |
| 1 | macOS ARM64 install and enable | #28 | | Not run | |
| 2 | macOS file open, with and without trailing separator | #29 | | Not run | |
| 3 | macOS watcher starts without fsevents errors | #39 | | Not run | |
| 4 | Windows WSL mount via `\\wsl$\` and `\\wsl.localhost\`, then restart | #33 | | Not run | |
| 5 | Hidden dot-folder and dot-file, plus exclusion | #26 | | Not run | |
| 6 | Auto-label checkbox persists after reopen and restart | #35 | | Not run | |
| 7 | Virtual path input visible and editable, narrow and desktop widths | #41 | | Not run | |
| 8 | Footnotes render and refresh in a mounted note | #34 | | Not run | |
| 9 | Android: enable packaged build, open a WebDAV or S3 note, restart | #18 | | Not run | |
| 10 | Explorer: context-menu mount, tooltips, expansion, unload | #39 | | Not run | |
| 11 | External edit then in-app save preserves external changes (body, headings, frontmatter, Outline) | #47 | | Not run | |
| 12 | Suppressed mount after restart: children appear, later external edits stay muted, other plugins behave | #16 | | Not run | |

Notes on specific rows:

- **Row 11** is the one that can lose data. Use only a copy of a note, and repeat it
  on the oldest Obsidian version you can run as well as the current one.
- **Row 12** needs a build that includes the #16 fix; it does not apply to 2.15.4.
  Also test with an attachment-management plugin enabled (see #14), because the
  initial index of a suppressed mount does emit one burst of vault `create`
  events. Only later external changes are muted.
- **Rows 2 and 7** already have reporter passes on the 2.15.3-rc.2 build, listed
  in the checklist. Those do not fill these rows for 2.15.4.

## Collecting A Console Stack

Open the developer console (`Ctrl+Shift+I`, or `Cmd+Option+I` on macOS), reload
Obsidian, reproduce the problem, and copy the first red error with its stack.
On Android, use remote debugging from a desktop browser or describe the visible
error text and the Obsidian and WebView versions.
