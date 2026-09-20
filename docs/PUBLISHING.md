# Publishing & Release Checklist

This document covers GitHub release preparation and the separate Obsidian Community Plugin directory review. Passing repository checks does not establish directory approval or native compatibility.

## Current Published Release

[2.15.4](https://github.com/tescolopio/Obsidian_FolderBridge/releases/tag/2.15.4)
was published on 2026-09-20 from `29b43c806f2cf3892abea64abd26c8592fdb7b25`.
It is the latest stable release, not a prerelease. It adds CI validation changes;
runtime behavior and dependencies are unchanged from 2.15.3. The release contains
`main.js`, `manifest.json`, and `styles.css`; install all three together.
See [release validation](RELEASE_VALIDATION.md) for evidence and remaining checks.

---

## 1. Pre-Release Code Checks (Bot Scan)

Use these as local preflight checks, then inspect the current directory scan.
The older `obsidianmd/obsidian-releases` PR is historical submission evidence,
not the current entry-management workflow or proof of approval.

### Automated file checks

| Check | Requirement | How we satisfy it |
|-------|-------------|-------------------|
| `manifest.json` present in repo root | Required | ✅ Always committed |
| `manifest.json` `version` matches release tag | Exact match, no `v` prefix | ✅ e.g. tag `2.8.0`, manifest `"version": "2.8.0"` |
| `manifest.json` required fields | `id`, `name`, `version`, `minAppVersion`, `description`, `author` | ✅ All present |
| `versions.json` includes new version | Maps every released version to its `minAppVersion` | ✅ Updated each release |
| `main.js` uploaded to GitHub release | Required | ✅ Attached by release script |
| `manifest.json` uploaded to GitHub release | Required | ✅ Attached by release script |
| `styles.css` uploaded to GitHub release | Required if the file exists | ✅ Attached |

### Code patterns the bot / reviewer checks for

| Pattern | Verdict | Status |
|---------|---------|--------|
| `console.log` / `console.info` | ❌ Banned — use `console.debug` | ✅ Routed through `src/logger.ts` |
| `innerHTML` without sanitization | ❌ Banned — XSS risk | ✅ Not used; DOM built via `createEl` / Obsidian APIs |
| `eval()` | ❌ Banned | ✅ Not used |
| `fetch()` for network requests | ❌ Use `requestUrl` instead | ✅ WebDAV/S3/SFTP use their own authenticated clients; no bare `fetch` |
| Hard-coded `.obsidian` path | ❌ Banned | ✅ Uses `app.vault.configDir` |
| Inline `element.style.*` assignments | ❌ Use CSS classes | ✅ All styles in `styles.css` with `folderbridge-*` prefix |
| Unsafe `as TFile` / `as TFolder` casts | ⚠️ Reviewer flag | ✅ Uses `instanceof` narrowing |
| `require()` at module scope | ⚠️ Breaks mobile | ✅ Uses `loadOptionalNodeModule()` lazy loader |
| Floating `Promise`s | ⚠️ Reviewer flag | ✅ Wrapped with `void` operator |
| `async` event handlers returning `Promise` where `void` expected | ⚠️ Reviewer flag | ✅ Wrapped with synchronous `void (async () => { … })()` |

Run the same gate used by pull-request, main-branch, and release CI:

```sh
npm ci
npm run validate    # Lint, UI text, TypeScript check, production bundle, tests
```

The pattern table is a preflight aid, not a fresh reviewer certification.
Record any directory scan findings separately from the local lint result.

---

## 2. Version Bump Steps

### Prerelease Candidates

Use an explicit prerelease version such as `2.15.3-rc.1` consistently in
`package.json`, `package-lock.json`, `manifest.json`, `versions.json`, and the
changelog. The tag must match exactly, without a `v` prefix. Review and validate
the preparation commit before pushing its tag. The release workflow marks tags
containing `-` as prereleases and does not mark them as latest.

Prereleases are for opt-in testing with disposable vaults and backed-up sources.
Complete the native gates in `docs/RELEASE_VALIDATION.md` before stable release.
For 2.15.3 and the CI-only 2.15.4 follow-up, the maintainer approved publication
with those native checks pending; the decisions and required caveats are recorded
in that checklist. This does not waive native gates for future runtime changes.
For stable promotion, prepare the stable version metadata and a matching new
tag; do not merely remove the prerelease flag from a candidate tag.

Every release follows this sequence. **Do not skip steps.**

### 2a. Write the CHANGELOG entry

Edit `CHANGELOG.md` and add a new section under `## [Unreleased]`:

```markdown
## [X.Y.Z] - YYYY-MM-DD

### Added
- ...

### Changed
- ...

### Fixed
- ...

### Removed
- ...
```

Each bullet must be specific enough for a user to understand what changed and why. Mention the root cause for bug fixes.

### 2b. Run the version bump

Prepare metadata in a clean release checkout, preserving unrelated work. Use an
explicit version with `--no-git-tag-version` so metadata can be reviewed and
validated before a release tag is created. The `version` lifecycle hook updates
`manifest.json` and `versions.json`; review its staged changes as well.

```sh
# Replace X.Y.Z with the approved stable or prerelease version.
npm version X.Y.Z --no-git-tag-version
npm run validate
git diff
git diff --cached
```

Confirm `package.json`, `package-lock.json`, `manifest.json`, `versions.json`, and
the changelog agree. Commit only the reviewed release files and merge the release
PR after its checks pass. Tag the validated merged revision, not an older local
branch or a dirty development checkout.

Tags must match the version exactly, **without a `v` prefix**. The workflow uses
the pattern `[0-9]*.[0-9]*.[0-9]*`. Do not replace an existing published tag.

### 2c. Publish the Approved Tag

```sh
git tag X.Y.Z <validated-merged-commit>
git push origin X.Y.Z
```

The `release.yml` GitHub Actions workflow triggers automatically on the `X.Y.Z` tag. It will:
1. Install with `npm ci`, then run `npm run validate` (lint, UI text, typecheck, production build, tests)
2. Validate tag matches `manifest.json` version  
3. Extract release notes from `CHANGELOG.md`
4. Create the GitHub release and attach `main.js`, `manifest.json`, `styles.css`

> **You do not need to create the GitHub release manually.** The workflow handles it.

> **Critical:** The release tag must match `manifest.json` `"version"` exactly. The bot rejects mismatches.

---

## 3. Obsidian Community Plugin Guidelines Summary

Use the current [developer policies](https://docs.obsidian.md/community-directory/developer-policies)
and [plugin submission requirements](https://docs.obsidian.md/community-directory/submission-requirements-for-plugins)
alongside these local reminders. The directory review is separate from GitHub release CI.

### Required files

- `README.md` — describes the plugin's purpose and usage
- `LICENSE` — open-source license (FolderBridge uses MIT)
- `manifest.json` — valid with all required fields
- `versions.json` — version-to-minAppVersion map
- `main.js` — production bundle (in GitHub release assets, not committed to repo)

### README must include

- What the plugin does (opening paragraph)
- List of features
- Installation instructions
- Usage instructions with steps
- Any required configuration
- Platform limitations (we document macOS/Windows/Linux/Android in a table)
- Disclosure of any network access (WebDAV, S3, SFTP are all disclosed)

### Security & privacy requirements

- Do not request unnecessary permissions
- Disclose all network access in README (✅ done — WebDAV, S3, SFTP, localhost FileServer)
- Do not log or transmit user data
- Credentials must be stored securely (✅ OS keychain via DPAPI/Keychain/libsecret)
- Do not access files outside the vault or user-approved paths (✅ security allowlist)

### UI / UX requirements

- Use sentence case for UI labels (✅ enforced since v2.5.0)
- Prefix all CSS classes with the plugin ID (`folderbridge-*`) (✅ done)
- No modal or notice spam — one notice per action, non-blocking where possible (✅ done)
- Settings must be self-explanatory or have description text (✅ every setting has `.setDesc()`)

---

## 4. Submitting to the Community Plugin Directory

Folder Bridge already has a web listing. Do not create a duplicate submission
because the historical PR is inaccessible. Follow the current
[entry-management guide](https://docs.obsidian.md/community-directory/manage-entry):

1. Sign in with the maintainer's Obsidian account and open Folder Bridge under **Your entries**.
2. Select **Check for new releases** to refresh the published 2.15.4 release.
3. Use **Review branch** with the exact release tag or commit for a preview scan.
4. Address errors, then use **Request review** and record its result.
5. Verify actual in-app search and installation before closing #25 or #38.

The official registry contained no `folderbridge` entry when checked on
2026-09-20. A web listing, successful build, or uploaded GitHub assets alone do
not prove in-app availability. BRAT/manual installation remains the documented route.

---

## 5. Quick Checklist (copy before each release)

```
[ ] manifest.json version updated
[ ] package.json version updated
[ ] package-lock.json version updated
[ ] versions.json entry added
[ ] CHANGELOG.md entry written with root-cause detail for fixes
[ ] npm ci and npm run validate pass on the candidate checkout
[ ] Native results recorded, or explicit release-specific exception and caveats documented
[ ] Release preparation reviewed and merged; merged revision validated
[ ] Tag validated merged commit as X.Y.Z and push that tag (no "v" prefix)
[ ] GitHub release created with main.js, manifest.json, styles.css attached
[ ] Downloaded assets match the tested build and release manifest version
[ ] Stable marked Latest; prerelease marked prerelease and not Latest
[ ] Published notes match CHANGELOG and retain known limitations
[ ] Directory release/review status checked separately; no assumed approval
```
