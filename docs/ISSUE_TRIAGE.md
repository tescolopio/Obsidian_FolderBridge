# Release And Issue Review

Snapshot: 2026-09-20. Repository: [tescolopio/Obsidian_FolderBridge](https://github.com/tescolopio/Obsidian_FolderBridge).
Latest stable: [2.15.4](https://github.com/tescolopio/Obsidian_FolderBridge/releases/tag/2.15.4).
This is a review queue, not a record of actions taken. No comments, labels,
assignments, or issue states were changed during this pass.

## Overall Assessment

The project is in a stabilization phase after substantial integration work.
2.15.3 brought the runtime fixes and dependency updates; 2.15.4 changes CI only.
The current release and main builds passed the unified validation gate, with
400 automated tests across 13 files. The release-preparation audit recorded zero
known npm vulnerabilities; that is historical, point-in-time evidence, not a new
audit or an assurance of ongoing security. No open PRs were found in this pass.

The largest remaining risks are native Obsidian compatibility, source-file safety
when editing across applications, and installation/distribution clarity. Private
vault APIs and mocked tests make the native external-edit/Outline/frontmatter/save
check particularly important. Two rc.2 reporter passes are useful, but neither
certifies the full stable 2.15.4 build or all platforms. The declared minimum host
version is still 0.15.0 and has not been newly verified.

Recommendation: finish native validation and directory review before expanding
the transport or file-moving feature set. Keep sparse NAS, SMB, and cross-mount
transfers distinct from bug fixes. Avoid advertising complete mobile or native
compatibility until it has evidence.

## Queue Summary

Reviewed all 13 open issues and all eight closed issues, including their comment
histories. Open-issue comments were also checked through the paginated REST API
for edits after the maintainer's last response. Maintainer responses are identified
by repository owner `tescolopio`; PR conversations are not counted as issues.

- No open issue lacks a maintainer response.
- Two recent confirmations need acknowledgment: open #41 and closed #29.
- Five native-test requests have no subsequent reporter reply: open #18, #33,
  #34, #35 and closed #26. Requests were sent September 19; no immediate repeated
  reminder is warranted, but the obsolete release instructions should be corrected.
- Six open issues need product/engineering decisions: #15, #16, #20, #21, #32, #36.
- Two open issues concern directory distribution: #25 and #38.
- Closed #12 and #19 end with older thank-you/confirmation messages. These are
  optional courtesy acknowledgments, not unresolved support questions.

The test-waiting queue overlaps the stale-release-message queue below; counts are
not all additive. Open issue categories total 13 (1 + 4 + 6 + 2).

## First: Acknowledge Results

| Priority | Thread and evidence | Current state | Suggested action |
| --- | --- | --- | --- |
| 1 | [#41: path input](https://github.com/tescolopio/Obsidian_FolderBridge/issues/41#issuecomment-5746493168), seasonsteven, September 20 00:43 UTC | Open. Reporter says **pass** on rc.2, Windows 11 Home, Obsidian 1.13.7. No later maintainer reply. | Thank the reporter. Recommend closing the original layout report as reporter-confirmed, while keeping stable/current/oldest-host checks in the release checklist. Do not call this a 2.15.4 test. |
| 2 | [#29: macOS file opening](https://github.com/tescolopio/Obsidian_FolderBridge/issues/29#issuecomment-5747702235), JoelAnderson-UU, September 20 04:48 UTC | Already closed. Reporter says rc.2 passes on macOS 27 Golden Gate, Obsidian 1.14.2, installer 1.13.7. No later maintainer reply. | Acknowledge the macOS confirmation and keep the issue closed. Record versions as supplied. Ask about original-storage coverage only if needed; architecture and separate per-path results were not given. |

### Suggested Reply For #41

> Thanks for confirming the path-input fix on 2.15.3-rc.2 with Windows 11 Home and Obsidian 1.13.7. I've recorded that result. The fix is included in the current stable 2.15.4 release. This confirms the original layout report in your environment; broader stable and older-host checks remain separate. Please report a regression with its exact version if it returns.

Decision for maintainer: close #41 after acknowledging. No closure performed here.

### Suggested Reply For #29

> Thanks, Joel. I've recorded your successful macOS test on 2.15.3-rc.2 with Obsidian 1.14.2 (installer 1.13.7). The relevant fixes are included in stable 2.15.4. Keeping this report closed; the remaining stable-release platform checks are tracked separately. Thanks for following up with the versions.

## Waiting For Testing

All five threads below already have a specific test request. Correct the requested
build to stable 2.15.4, preserve the original comment's historical context, and give
reporters time to respond. Silence is not evidence that a bug is fixed.

| Issue | Latest request | What is needed | Closure guidance |
| --- | --- | --- | --- |
| [#18: Android loading](https://github.com/tescolopio/Obsidian_FolderBridge/issues/18) | [September 19](https://github.com/tescolopio/Obsidian_FolderBridge/issues/18#issuecomment-5743730366) | Enable packaged 2.15.4, open a supported WebDAV/S3 note, restart, and report Android/Obsidian/WebView versions and any redacted load error. | Keep open; bundling and mobile-safe helpers are not proof of Android enablement. |
| [#33: Windows WSL paths](https://github.com/tescolopio/Obsidian_FolderBridge/issues/33) | [September 19](https://github.com/tescolopio/Obsidian_FolderBridge/issues/33#issuecomment-5743731368) | Test both WSL UNC hostnames, note opening, and restart with normal permissions. | Keep open pending native confirmation; normalization fixes have shipped. |
| [#34: footnotes](https://github.com/tescolopio/Obsidian_FolderBridge/issues/34) | [September 19](https://github.com/tescolopio/Obsidian_FolderBridge/issues/34#issuecomment-5743731814) | Compare mounted/native copies through edit/read/reopen/restart. Obtain a minimal anonymized note and citation-plugin versions if it fails. | Keep open; cached-read repair does not prove the entire citation workflow is fixed. |
| [#35: auto-label checkbox](https://github.com/tescolopio/Obsidian_FolderBridge/issues/35) | [September 19](https://github.com/tescolopio/Obsidian_FolderBridge/issues/35#issuecomment-5743732211) | Save/reopen automatic and custom labels, then restart on the reported host. | Keep open; #41's path-input pass does not cover this checkbox. |
| [#26: hidden-folder refresh](https://github.com/tescolopio/Obsidian_FolderBridge/issues/26) | [September 19](https://github.com/tescolopio/Obsidian_FolderBridge/issues/26#issuecomment-5743730701) | Allowed dot-files/folders update; excluded entries remain hidden after create/edit/refresh/restart. | Already closed. Track missing evidence without reopening solely for silence or claiming reporter confirmation. |

### Stable-Release Correction Draft

Use as a short follow-up to the relevant existing request, with its issue-specific
steps retained. Review before posting; do not send a repeated generic reminder.

> Release update: 2.15.4 is now the latest stable release. The earlier rc.2 request and statement that stable publication was on hold are historical. Please use all three assets from 2.15.4 together for any new test and report the exact plugin, OS/device, and Obsidian versions. Stable publication was approved with native checks incomplete; it is not a claim that this issue is resolved. Back up your configuration and use disposable source copies for write tests.

The outdated native-test wording appears in #18, #26, #29, #33, #34, #35, and #41.
For #29 and #41, combine the correction with the acknowledgment instead of sending
another demand to repeat an already supplied result.

## Engineering And Product Work

| Priority | Issue | Current release status | Next decision or action |
| --- | --- | --- | --- |
| High | [#16: suppression](https://github.com/tescolopio/Obsidian_FolderBridge/issues/16) | Runtime toggle/delivery-race fixes shipped in 2.15.3 and remain in 2.15.4. In 2.15.4, saved suppression still skips initial child replay and can leave the tree empty. A fix on main after 2.15.4 (unreleased) indexes existing files once and keeps later external events muted. | Keep open until a release includes the fix and the suppressed-restart check in the [results sheet](NATIVE_TEST_RESULTS.md) passes, including with an attachment plugin. Related closed [#14](https://github.com/tescolopio/Obsidian_FolderBridge/issues/14) concerns attachment-plugin rename notifications; no new unanswered reply there. |
| Medium | [#20: large-mount startup](https://github.com/tescolopio/Obsidian_FolderBridge/issues/20) | Bounded local metadata batching shipped. Persistent scan caching did not. The earlier comment predates this improvement. | Tell the reporter what actually shipped and request cold/warm measurements on their 19,751-file mount. Do not promise the contributor's cache design or claim the scanner benchmark measures native startup. |
| Medium | [#21: external-rename links](https://github.com/tescolopio/Obsidian_FolderBridge/issues/21) | No reliable external rename correlation/backlink-update workflow. | Scope ambiguity handling and Obsidian link updates separately; modified-event repair is not rename support. |
| Medium | [#32: cross-mount moves](https://github.com/tescolopio/Obsidian_FolderBridge/issues/32) | Safe transfer between vault/mount/backend boundaries is not implemented. | Design copy, verify, then delete with conflict/cancellation/failure handling before offering drag-and-drop moves. Source-data integrity makes this higher risk than cosmetic work. |
| Backlog | [#15: sparse NAS workflow](https://github.com/tescolopio/Obsidian_FolderBridge/issues/15) | Directory mounts remain the unit of access; no arbitrary per-note/on-demand NAS resolution. | Decide whether this fits the product. Narrow subfolder mounts do not satisfy the reporter's roughly 500-project workflow. |
| Backlog | [#36: SMB client](https://github.com/tescolopio/Obsidian_FolderBridge/issues/36) | OS-mounted desktop shares are usable as local sources; no native/mobile SMB transport. | Keep the OS-mount workaround distinct from new SMB support. Defer transport expansion until current native paths are validated. |

### Suggested Release Status Updates

For #16:

> Stable 2.15.4 includes the runtime suppression fixes shipped in 2.15.3: queued events are canceled on suppression and in-flight work cannot escape a toggle. The separate empty-tree behavior after restart is unchanged in 2.15.4 because saved suppression skips initial child replay. A fix is merged to main and will ship in the next release: a suppressed mount indexes its existing files once at load and keeps later external changes muted. That one-time index can still produce a burst of create events for other plugins. Keeping this open until a release includes it and it is tested.

For #20:

> Stable 2.15.4 includes bounded local/vault metadata batching from 2.15.3. It does not add a persistent scan cache, and remote scans remain serial. A scanner-only 20,000-file benchmark improved from about 1,215 ms to 784 ms; it used no-op vault notifications and is not an Obsidian startup measurement. Could you report cold/warm startup timings for your large mount on 2.15.4, along with storage type, OS, Obsidian version, and scan settings? Keeping this open pending results.

## Directory Distribution

[#25](https://github.com/tescolopio/Obsidian_FolderBridge/issues/25) and
[#38](https://github.com/tescolopio/Obsidian_FolderBridge/issues/38) are the same
user-facing distribution problem. Both have maintainer responses and neither has
a newer unanswered question. Their release references are stale.

On September 20 the official `obsidianmd/obsidian-releases` registry contained no
entry with id `folderbridge`. The public website listing alone is not proof of
in-app search/install. Current authenticated dashboard/review results were not
available in this audit, so the reason for non-availability is not established.

Maintainer action: open the existing entry under **Your entries**, use **Check for
new releases** for 2.15.4, run **Review branch** against the release revision, then
**Request review**. Record the actual errors before assuming old review concerns
still apply. Verify installation in Obsidian before closing either issue. See the
[publishing guide](PUBLISHING.md) and
[official management instructions](https://docs.obsidian.md/community-directory/manage-entry).

Suggested reply after reviewing, without claiming dashboard actions occurred:

> 2.15.4 is now the latest stable GitHub release, available through BRAT/manual installation. The official registry still lacks a Folder Bridge entry in our September 20 check; the public listing is not evidence of in-app availability. Directory release discovery/review and actual in-app installation still need confirmation. Keeping this issue open and tracking the same distribution problem in the related report.

## Other Closed Reports

| Issue | Evidence/status | Action |
| --- | --- | --- |
| [#12](https://github.com/tescolopio/Obsidian_FolderBridge/issues/12#issuecomment-3977149708) | February 28 reporter confirms note creation works and thanks the maintainer. | Optional courtesy acknowledgment only. No new question. |
| [#19](https://github.com/tescolopio/Obsidian_FolderBridge/issues/19#issuecomment-4055120115) | March 13 reporter confirms file-type filtering works and thanks the maintainer. | Optional courtesy acknowledgment only. No new question. |
| [#17](https://github.com/tescolopio/Obsidian_FolderBridge/issues/17) | Reporter confirmed a historical upgrade fixed loading; maintainer subsequently replied and closed. | No outstanding response identified. |
| [#13](https://github.com/tescolopio/Obsidian_FolderBridge/issues/13) | Maintainer posted the video-playback fix; no later reporter rebuttal. | No outstanding response identified; silence is not new validation. |
| [#37](https://github.com/tescolopio/Obsidian_FolderBridge/issues/37) | Closed build/type issue has a September 19 maintainer release follow-up. | No outstanding response. Its rc.1 note is historical; fixes are included in stable. |
| [#14](https://github.com/tescolopio/Obsidian_FolderBridge/issues/14) | Post-closure notification complaint was answered September 19 and linked to #16. | Keep its interaction in the suppression test scope; no fresh reply owed. |

## Recommended Order

1. Acknowledge #41 and #29; decide on #41 closure.
2. Correct stale candidate/hold wording and communicate the partial fixes in #16/#20.
3. Complete authenticated directory review for #25/#38.
4. Run the native 2.15.4 external-edit/save check, then Android, WSL, footnote, label,
   hidden-file, and oldest-host checks in [release validation](RELEASE_VALIDATION.md),
   recording each run in the [native test results sheet](NATIVE_TEST_RESULTS.md).
5. Resolve #16's visibility policy and measure #20 on the real workload before
   committing to broader features.

## Follow-Up Actions (2026-09-20)

After the review above, the maintainer approved and posted the drafted comments
for #41, #29, #18, #26, #33, #34, #35, #20, #25 and #38, each tagged with the
`folderbridge-issue-audit-2026-09-20-stable` marker. No issue was closed or
relabeled; #41 was deliberately left open. The #16 comment was held: a fix that
indexes a suppressed mount's existing files on startup has since been merged to
main but is not released, so #16 should be updated with a link to that change and
the next release rather than the 2.15.4 draft above. The authenticated
directory steps for #25/#38 and all native runs remain pending; record native
results in the [results sheet](NATIVE_TEST_RESULTS.md).

## Scope Of The Original Audit

This audit made documentation changes only. It did not rerun runtime tests,
perform a new dependency audit, execute native Obsidian checks, publish a release,
or change GitHub conversations. Release CI evidence is linked in the validation
checklist; documentation metadata, local links, and issue coverage are checked locally.
