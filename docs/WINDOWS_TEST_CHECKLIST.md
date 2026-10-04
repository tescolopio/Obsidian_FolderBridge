# Windows Cumulative Fix Test Checklist

## Build And Scope

Target: **local 2.15.5-rc.5 candidate**, unpublished. It contains all published
rc.4 fixes, including the earlier compatibility, watcher, override and trash
work, plus the combined S3 prefix and copy-source fixes (#57/#68).
It does not include every open issue or complete security/native hardening.
Published rc.4 and stable 2.15.4 are unchanged.

Record the installed bundle SHA-256 and backup directory from the local
installation report. Version alone is not enough to identify an unpublished
build. After restarting Obsidian, confirm Folder Bridge shows `2.15.5-rc.5`.

## Safety First

- [ ] Back up the vault, plugin settings and mounted sources.
- [ ] Use disposable source folders and notes for every write/delete test.
- [ ] Start with other plugins disabled; repeat compatibility checks with them
  enabled only after the isolated pass. Pause sync and external writers.
- [ ] Pause plugin auto-updaters while testing this unpublished local build.
- [ ] Do not post `data.json`, credentials, tokens or unredacted server logs.
- [ ] Use test-only SFTP credentials and a disposable S3 prefix/bucket.
- [ ] Review existing non-root S3 mounts before opening this build for writes.
  Prefer read-only credentials until exact keys have been checked in the provider.
- [ ] Open the developer console with `Ctrl+Shift+I`; capture the first relevant
  red error and stack if a test fails.

**S3 migration warning:** `/notes` now addresses `notes/a.md`, not
`notes/notes/a.md`. Existing doubled-prefix objects remain where they were.
They may appear under an extra nested folder rather than the former virtual
path. Confirm both locations with the provider's console/CLI. Back up and copy
objects deliberately if migration is needed; do not overwrite corrected keys or
delete the old copies until the new ones are verified. This build does not
automatically migrate anything.

## Environment And Results

Record Windows edition/build, CPU architecture, Obsidian app and installer
versions, candidate version/bundle hash, other plugins and test date.
Each result must be **Pass**, **Fail**, **Blocked**, or **Not run**.
Lack of a server, WSL installation or second drive is **Blocked**, not Pass.
All native checks below start as **Not run**.

Recommended first pass: startup/local editing (1-4), override-preserving move
(15), local trash/restore (17-18), SFTP approval/restart (23-25), S3 exact keys
and copy/rename (29-32), then the final restart (38). Continue through the
remaining checks as the required servers, shares and drives are available.

Use [NATIVE_TEST_RESULTS.md](NATIVE_TEST_RESULTS.md) for shared evidence. Copy
rows for repeat runs rather than overwriting evidence for another build.

## A. Startup And Everyday Local Use

1. [ ] Launch Obsidian, enable Folder Bridge, confirm the candidate version and
   no new startup errors. Check that existing mount settings have been preserved.
2. [ ] Mount a copied local folder using a path with spaces. List/open nested
   notes and an image/PDF. Repeat with a trailing separator. No duplicate mount
   entries or missing children should appear.
3. [ ] Create and edit a copied note, including headings, frontmatter, a footnote
   and an internal link. Outline, preview and metadata should refresh after save.
4. [ ] Edit that note externally while open, then save in Obsidian. Confirm
   external changes are not lost. Repeat with external writers paused and record
   any conflict. This is a data-loss-sensitive check: use copies only.
5. [ ] Mark a mount read-only and attempt a save. Source bytes must not change;
   the UI should report read-only behavior. Restore the setting afterward.
6. [ ] Turn on dry-run mode and try writing a copied note. Source bytes must not
   change. Turn dry-run off before later write tests.
7. [ ] Show a dot-file/dot-folder, then exclude it. Check explorer visibility and
   ignore behavior. Verify the auto-label choice and virtual-path field persist
   after reopening settings and restarting.

## B. Watchers, Windows Paths And Fallbacks

8. [ ] With watcher suppression enabled, restart: existing children must appear.
   Later external edits should remain muted until suppression is disabled.
   One initial indexing burst of create events is expected. Repeat with an
   attachment-management plugin only on copied data.
9. [ ] Without suppression, create/edit/delete a copied external note. Explorer,
   cached reads and metadata should update; a rename must not leave stale entries.
10. [ ] If available, test a UNC/network share and a WSL mount using both
    `\\wsl$\...` and `\\wsl.localhost\...`, then restart. Confirm listing/open/save.
    Use polling when native network notifications are unavailable.
11. [ ] Configure primary and fallback copied folders. Make the primary
    unavailable, refresh/reconnect and verify the fallback is used. Restore the
    primary and verify the route switches correctly without losing saves.
12. [ ] Test managed/external TOC refresh, fallback TOC selection and clearing.
    Existing mount labels, enabled state and explicit device paths must persist.

## C. Device Overrides And Mount Moves

13. [ ] Attempt to add a protected system directory such as `C:\Windows`.
    It should be refused. Do not allowlist it or inspect protected contents.
14. [ ] Using a backed-up test configuration, check a rejected active-device
    override. Expect a warning and safe effective routing, while raw override
    entries remain preserved for review. Do not route into sensitive directories.
15. [ ] Move an ordinary mount via **Move mount to...** and explorer drag.
    Its raw override map must survive settings/restart; sanitized entries must
    not disappear merely because the mount moved.
16. [ ] Repeat the move for a managed-TOC mount. Ordinary enabled/ignore-list
    edits must preserve overrides; an explicit device-path change must replace
    the requested device entry.

Whole-drive descendants, symlink containment and all pre-existing path-policy
gaps are not certified by these checks. Do not test by exposing an entire drive.

## D. Recoverable Trash And Deletion Choices

17. [ ] Choose Obsidian/local trash in Obsidian's deletion settings. Delete a
    copied local file and folder. Recover them from the vault's
    `.trash\folderbridge-<unique>\<original-name>` location by copying back.
    Original names, nested contents and bytes must be intact.
18. [ ] Delete two copied items with the same name from different locations.
    They must have separate recovery entries, not overwrite each other.
19. [ ] If a second volume is available, repeat local trash across volumes.
    Pause external writers. If you can safely induce a copy failure, the source
    must remain intact and an error must identify recovery state. Never alter
    production ACLs or fill a disk to induce failure.
20. [ ] Test Windows system trash on copied data and verify recovery from the
    Recycle Bin. System-trash fallback/failure needs a controllable test setup;
    mark Blocked if unavailable.
21. [ ] At a remote mount root, request trash. Only Cancel/Unmount should be
    offered, not unsupported deletion. Cancel must preserve the saved root
    confirmation preference, including with **Don't ask again** selected.
22. [ ] Remote file/folder trash must refuse deletion explicitly. Verify source
    objects remain. Explicit permanent deletion is a different operation and
    should only be tested on a disposable file, never a production root.

S3 recursive folder deletion is still incomplete; do not treat removal of a
placeholder or a successful file delete as proof that child objects were removed.
Cross-volume copy/remove is not atomic against concurrent external writers.

## E. SFTP Trust And Timeout Recovery

23. [ ] Get the actual host-key fingerprint independently from the administrator.
    Add/connect an unpinned test mount; compare it in the approval dialog.
    Leave the dialog open for **at least 30 seconds**, then approve.
    It must remain open and connect afterward. Server logs, when available,
    should show no password/public-key authentication before approval.
24. [ ] Cancel/close first approval. Background retries must not repeatedly
    prompt. Explicit **Reconnect** should permit a fresh approval.
25. [ ] After approval, list/open/save a copied note; restart Obsidian.
    The unchanged trusted server should not require a new prompt.
26. [ ] On a disposable server only, change the host key and reconnect.
    Refuse connection with expected/received fingerprints; do not silently
    replace the pin or authenticate.
27. [ ] Independently verify the changed key, select **Forget host key on save**,
    save and reconnect. A new approval must be required. Host/port changes also
    require fresh trust. Ordinary label/path edits must preserve saved trust.
28. [ ] Approve a verified key using wrong test credentials. Authentication
    should fail normally without discarding the approved pin. Correct credentials
    should connect without reapproval. Do not repeatedly lock out a real account.

Discovery and authentication retain bounded network timeouts. Human approval is
not part of either handshake. Real loopback tests cover timeout/cancellation
recovery; a native server-stall test is optional and needs a controlled endpoint.

## F. S3 Prefix, Copy And Rename

29. [ ] Seed known objects with the provider's tool, not through the old plugin:
    `check.md` at bucket root, `fb-test/check.md`, and
    `fb-test/sub/nested.md`. Mount `/` and `/fb-test` separately.
    Each must show the expected object and identical contents.
30. [ ] Through the `/fb-test` mount, write a new copied note. Verify the provider
    key is exactly `fb-test/new.md`, never `fb-test/fb-test/new.md`.
    Append and reopen it; verify old and new content are both present.
31. [ ] Create a subfolder/placeholder and binary attachment. List/read them
    and check the provider keys and bytes. Repeat a file write on a bucket-root
    mount to confirm unchanged root behavior.
32. [ ] Copy and rename test files with spaces, `+`, `#`, `%`, and a non-ASCII
    character in their names. Verify destination bytes and literal names with
    the provider tool. A literal `%2F` in a key must not become a slash.
    Windows forbids some local filename characters; seed provider-only `?` or
    `*` keys directly if testing those cases.
33. [ ] Copy a disposable folder containing nested files and a placeholder.
    Destination structure/bytes must match; source objects must remain.
    Pagination is automatically tested; a live >1,000-object check is optional
    and can incur storage/API costs.
34. [ ] If a safe provider policy allows it, deny copy on a disposable source
    and try a file rename. Expect failure and an intact source. Restore only
    the test policy afterward. Partial folder-copy destinations can remain.
35. [ ] Seed a legacy object at `fb-test/fb-test/legacy.md`. Inspect it after
    enabling the corrected mount: the exact provider object must remain.
    No automatic move/delete should occur. Do not confuse changed virtual
    placement with data loss.
36. [ ] If using a cloud device override, write a disposable note and verify
    its exact provider key uses the effective device prefix only once.

Copy/rename is not atomic. Folder rename does not fix recursive source cleanup;
avoid using it as a migration mechanism. Live AWS/B2/MinIO compatibility is
not established by mocked command tests; record the provider and endpoint type.

## G. WebDAV And Final Restart

37. [ ] If available, reconnect a desktop WebDAV test mount, list/open/save and
    append a copied note. Existing bytes must be preserved. An induced non-404
    read failure must not turn append into an overwrite; otherwise mark Blocked.
38. [ ] Restart once more with the completed test configuration. Confirm mount
    paths, labels, override maps, saved SFTP trust and deletion preferences.
    Repeat key everyday checks with your usual plugins enabled on copied data.

## Automated Evidence And Known Limits

The local installation report records actual command results and build hashes.
The final local suite reports **615 passed / four unchanged Windows baseline
failures, 619 total across 20 files**. All 23 added S3 regressions pass.
Obsidian is mocked in most tests; real loopback SSH checks are not native UI
evidence. The four previously reproduced Windows path-separator expectation
failures remain outside this batch, along with one existing lint warning.
Dependency advisories, broader path policy, oldest-host compatibility,
physical cross-volume and live remote-provider checks remain pending.
Android/macOS checks are not covered by a Windows pass.

## Rollback

Close Obsidian before restoring. From the verified backup directory named in the
local installation report, copy back `main.js`, `manifest.json` and `styles.css`
to the plugin directory together. Preserve `data.json` by default. The backup
also includes its pre-install state; restore it only if settings changes must
be undone, because doing so discards settings changes made during testing.
Reopen Obsidian and verify basic access before using valuable sources again.
Do not delete mounted source data as part of rollback.
