# Next Release Outline

Status: stabilization outline, started 2026-10-02. Opt-in 2.15.5-rc.2 was
published on October 3 through #73. The maintainer then approved the review
follow-up #74 and separate opt-in 2.15.5-rc.3 preparation and publication after
CI passes. Stable promotion is not approved.

## Goal And Release Sequence

Make source-file safety and backend correctness the next substantial release
theme. Do not add new transports or cross-mount transfer features while the
existing write, delete and native-host gates remain incomplete.

1. Finish and review the stabilization branch.
2. Run the combined automated gate and disclose the remaining blockers below.
3. Prepare opt-in 2.15.5-rc.3 with matching bundle, manifest and styles after CI
   passes. Outstanding native, dependency and policy gates remain mandatory for
   stable promotion; their disclosure is not evidence that they are resolved.
4. Collect native results on disposable sources and address failures.
5. Choose the stable version and publish only after a separate approval.

The approved candidate continues the 2.15.5 prerelease sequence; the next
substantial stable release's version is undecided. In particular, "major release"
does not yet authorize a SemVer 3.0 bump. Review the deliberate remote-trash
behavior change when deciding versioning and upgrade communication.

## Integrated On This Branch

Release branch: `release/2.15.5-rc.3`, based on validated main at `152c490`
(merged #74). The original `stabilization/next-release-safety` work at `f3a2cbf`
shipped through #73; the two review follow-ups at `ed5bfac` shipped through #74.
The original #59/#69/#70 PRs were integrated without merging their individual PRs.

| Item | Source | Included behavior |
| --- | --- | --- |
| Existing compatibility fixes | Published 2.15.5-rc.1 | Android lazy WebDAV loading and one-time suppressed-mount indexing. Native confirmation is still pending. |
| File-server traversal | Already merged #55 | Reject traversal segments in requests. Not in the published rc.1 assets. |
| Remote append safety | Already merged #56 | Fail rather than overwrite after a non-missing-file read error. |
| Device-override validation | Already merged #58, integrated #70 | Refuse unsafe local active-device overrides in effective routing; preserve remote server-relative overrides and raw stored maps during UI edits. Watcher restarts and reinjection use safe runtime mounts. |
| Protected-path expansion | Integrated #69 | Additional macOS/system/credential-folder restrictions during mount validation. |
| Recoverable local trash | Integrated #59, strengthened here | Atomically reserved recovery folder per deletion, cross-volume copy before source removal, explicit failures, system-trash fallback and source-bound short-lived root confirmation. |
| Remote trash guard | Maintainer-approved change in this session | WebDAV/S3/SFTP trash requests throw without deleting; explicit permanent-delete operations are unchanged. |
| Accurate deletion UX | This branch | Root confirmation distinguishes recoverable trash from permanent deletion. Existing saved root-deletion choices retain their identifiers and follow the requested deletion mode. |
| Safe local validation | This branch | Windows-portable lint/UI paths and optional redirected bundle output. Installed `main.js` is not replaced by the validation run. |
| Post-#73 review fixes | Merged #74 | Ordinary edits/moves preserve raw overrides; replacement is explicit. Remote root-trash dialogs offer only cancel/unmount, not a deletion choice that could save a future permanent-delete preference. |

## Upgrade And Recovery Notes

- Stable remains 2.15.4; opt-in 2.15.5-rc.3 adds the #73 review fixes on top of
  rc.2's append, traversal, override and trash work.
- Existing root-deletion preferences are preserved. Review that setting and
  restore confirmation if a failed rc.2 remote-trash attempt saved an unintended
  deletion preference. Upgrade does not silently reset legitimate saved choices.
- Back up the vault, plugin settings and mounted sources before any candidate
  test. Use copied source data, never valuable files for failure injection.
- Local and vault-mounted trash entries are now located at
  `<current-vault>/.trash/folderbridge-<unique>/<original-name>`. The original
  filename and nested contents are preserved. Restore by copying the item back
  to the original external source location.
- A failed cross-volume copy leaves the source untouched and may retain a
  partial recovery copy. A failed source removal retains the completed recovery
  copy and reports failure rather than removing the item from Obsidian's tree.
  Errors include the recovery destination. Cross-volume copy-then-remove is not
  atomic with concurrent external writers; pause them during deletion tests.
- Remote trash is deliberately unavailable until a recoverable workflow exists.
  There is no implicit permanent-delete fallback. Users who truly want permanent
  removal must select an explicitly permanent-delete operation.
- Saved unsafe local device overrides are retained for review but ignored for this
  device's effective routing, with a warning and notice. Its normal path is used
  instead; other devices' entries are not discarded. Cloud mounts' server-relative
  overrides are not subject to local protected-path checks. Enabled and ignore-list
  edits merge into the raw mount by ID, preserving the stored override map in
  both data.json and managed TOC files; explicit override edits use `updateMount`.
- Newly protected paths can be refused when adding, editing or importing a mount.
  This is not a complete filesystem sandbox: existing primary/fallback paths,
  symlink containment, whole-home/whole-drive mounts and unguarded metadata/path
  methods still need a separately scoped policy review. Do not describe #69/#70
  as closing every path-access concern in #63.

## Remaining Engineering Gates

| Priority | Work | Required outcome before claiming it is fixed |
| --- | --- | --- |
| Highest | SFTP host-key trust, #60 / #63 | Review persistence and reconnect paths, initial trust UX, changed-key refusal, host/port edits and deliberate reset. Run against a disposable SSH server. Current branch still lacks this PR. |
| High | S3 prefix correction, #57 / #62 | Validate every caller's server-path contract, then test root/non-root prefixes on a live compatible bucket. Document that old doubled-prefix objects remain in the bucket and must be migrated explicitly; no automatic move or delete. |
| High | S3 CopySource encoding, #68 | Integrate with #57, test spaces, punctuation and Unicode in rename/copy against a live bucket. |
| High | Runtime dependency advisory | Current production audit reports 2 high affected-package entries, `braces` and `chokidar`, from the same braces advisory chain. Resolve or document a reviewed mitigation; do not use `npm audit fix --force` blindly. Watcher dependency upgrades require API, glob and Electron compatibility review. |
| Medium | Development dependency advisory | Full audit also reports 3 moderate affected-package entries via `moment`, `obsidian` and `eslint-plugin-obsidianmd`. Evaluate patched dependencies or exposure; do not downgrade host typings merely to satisfy the suggested audit fix. |
| Medium | Security policy, #71 | Finish policy/contact review and integrate documentation. |
| Medium | Path-access policy | Define the remaining guard/containment behavior before broader changes; #69/#70 do not establish a complete allowlist boundary. |

These are release gates or explicit exclusions, not evidence that the draft PRs
are approved. Keep #61, #62 and #63 open while their remaining work and native
validation are incomplete. The approved rc.2 distributes the current safety
subset with these exclusions and risks disclosed; it is not a stable release or
an assertion that this entire queue is complete.

### #69 Feedback And Whole-Drive Policy

The exact `/private` parent is rejected during local mount validation, including
normalized parent paths, fallback paths and device overrides. Ordinary safe
subfolders such as `/private/tmp/notes` remain mountable. This closes the reported
macOS parent gap for validated mount paths, not every stored/manual allowlist.

On October 3 the maintainer chose to retain whole-drive mounts rather than reject
every Windows drive-letter root. The non-C drive-root review comment remains
unresolved: accepting `D:\` can still expose `D:\Windows` and `D:\Program Files`
through descendant-access paths. Direct validation of those system folders does
not close that ancestor gap. Do not describe any-drive protection as complete.

Before resolving that comment, define a descendant-access policy covering local
reads/writes, listings/metadata, resource/full paths, streaming, watchers and
saved/manual allowlists, while retaining legitimate external-drive content.
Keep implementation of that broader policy separate from the exact-parent fix.

## Automated Evidence

Validation was run on Windows with the production bundle redirected outside the
active vault. Obsidian and remote behavior are mocked unless stated otherwise.

- Lint passes with one pre-existing sentence-case warning.
- UI text checks, TypeScript checking and production bundling pass.
- Rc.3 follow-up: 557 passed, 4 failed, 561 total on Windows. #74 PR and
  merged-main Ubuntu/Node 20 CI pass all 561 tests across 17 files. The 15 new
  regressions cover sanitized mount moves, raw settings/TOC preservation,
  explicit override replacement/clearing and remote root-trash choices; 33
  focused feedback/compatibility tests pass.
- Final rc.2 full run on October 3: 542 passed, 4 failed, 546 total across 17 test files.
  Focused changed-behavior runs: 238 passed across the trash, protected-path
  and deletion-dialog files, plus 12 device-override tests passed.
- All 202 SecurityManager tests pass, including 6 normalized-parent cases added
  after #69 feedback. The final full run includes that follow-up.
- Changed-behavior checks pass: local/vault trash, collisions, cross-volume
  success/partial-copy/source-removal failures, missing/failed system trash,
  remote refusal and permanent deletion, read-only/dry-run/filter/allowlist
  protections, root confirmation expiration/path changes, deletion-mode copy,
  protected-path validation and active-device override routing. The #70 feedback
  regressions cover remote overrides, raw-state UI persistence and safe watcher
  reinjection/restart, including a raw mount passed to the injection boundary.
- Full Windows tests have four failures in `tests/mainFallback.test.ts`:
  three POSIX-path write expectations and the Linux fallback-TOC browse
  expectation. All four also reproduce on an unchanged archive of main
  (`61aeffd`). They are not waived: fix test portability in a separate scoped
  change or establish the candidate's clean supported-platform validation.
- No native Obsidian, Android, live S3/WebDAV/SFTP or physical cross-volume test
  was performed. Cross-volume automated tests inject `EXDEV`; they are not
  physical filesystem evidence.

Run the full gate after every additional integration. Exact results and remaining
failures must accompany the candidate, not a blanket "all tests pass" statement.

## Native And Publication Gates

Use [release validation](RELEASE_VALIDATION.md) and record runs in
[native test results](NATIVE_TEST_RESULTS.md).

1. Restore local files and folders after both trash modes, on same and different
   volumes. Check duplicate names, errors, root confirmation and unmount-only.
2. Verify Obsidian's actual `trashSystem() === false` fallback. A rejected
   remote-trash request must leave both remote data and the vault tree unchanged.
3. Check external-edit/in-app-save preservation, Outline and frontmatter on
   current and oldest supported Obsidian hosts.
4. Check Android enablement, desktop WebDAV regression and suppressed restart
   with an attachment-management plugin; obtain #18/#16 reporter results.
5. Check Windows/WSL, macOS and the outstanding footnote/label/hidden-file flows.
6. Verify settings/TOC reload preserves stored overrides and never routes an
   unsafe active override.
7. Finish authenticated community-directory review for #25/#38 and verify
   in-app discovery/install. GitHub release availability is not directory
   approval; if still blocked, state BRAT/manual installation limits explicitly.
8. Review matching version/tag metadata, release notes and all three packaged
   assets for the approved rc.3 publication. Stable publication still requires
   a separate approval after the outstanding gates are completed.

## Deferred From This Release

- SMB transport (#36), sparse per-note NAS resolution (#15), automatic external
  rename/backlink updates (#21), and cross-mount moves (#32).
- Persistent startup caching; first obtain real cold/warm measurements for #20.
- Remote download-to-trash recovery, beyond the fail-closed guard.
- S3 recursive folder removal remains a known limitation; this work does not
  claim that every existing remote permanent-delete operation is complete.
- Speculative cleanup from #72. Production use contradicts the unused-ID and
  device-override claims; WSL indicators already exist. Seek a reproduction for
  the proposed health-check race before scheduling it.

## Next Working Session

After the approved opt-in rc.3, resolve SFTP trust and S3 correctness with their
migration/UX decisions and combined tests. Address the dependency, Windows and
native validation gates before stable promotion. No stable publication is
recommended from the current branch state.
