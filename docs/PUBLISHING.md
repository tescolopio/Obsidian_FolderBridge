# Publishing & Release Checklist

This document defines every step required to release a new version of FolderBridge and pass all automated and manual checks for the Obsidian Community Plugin directory.

---

## 1. Pre-Release Code Checks (Bot Scan)

The Obsidian community-plugin bot validates these automatically when a PR is opened against [`obsidianmd/obsidian-releases`](https://github.com/obsidianmd/obsidian-releases).

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

Run to verify locally:

```sh
npm run lint        # ESLint (catches most of the above)
npm run build       # TypeScript type check + esbuild production bundle
npm test            # Vitest unit tests
```

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

Stage the changelog, then run `npm version`. The `version` lifecycle hook updates `manifest.json` and `versions.json` automatically. `.npmrc` is configured with `tag-version-prefix=` so the git tag is created **without a `v` prefix** — this is required for the GitHub Actions release workflow to fire.

```sh
# Stage your changelog entry first
git add CHANGELOG.md

# For a patch release (bug fixes only):
npm version patch

# For a minor release (new features, backwards-compatible):
npm version minor

# For a major release (breaking changes):
npm version major
```

`npm version` will:
1. Bump `package.json`, `manifest.json`, `versions.json`
2. Commit all staged files with message `Release X.Y.Z`
3. Create git tag `X.Y.Z` (**no `v` prefix** — critical for the release workflow)

> ⚠️ **Never** run `npm version --no-git-tag-version` and manually `git tag vX.Y.Z`. The `v` prefix breaks the `release.yml` trigger pattern `[0-9]*.[0-9]*.[0-9]*`, so the GitHub release with assets will never be created.

### 2c. Push the commit and tag

```sh
git push && git push origin X.Y.Z
```

The `release.yml` GitHub Actions workflow triggers automatically on the `X.Y.Z` tag. It will:
1. Install deps, run tests, build `main.js`
2. Validate tag matches `manifest.json` version  
3. Extract release notes from `CHANGELOG.md`
4. Create the GitHub release and attach `main.js`, `manifest.json`, `styles.css`

> **You do not need to create the GitHub release manually.** The workflow handles it.

> **Critical:** The release tag must match `manifest.json` `"version"` exactly. The bot rejects mismatches.

---

## 3. Obsidian Community Plugin Guidelines Summary

These are the reviewer criteria drawn from the [official plugin guidelines](https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines). All must be satisfied before submitting to `obsidianmd/obsidian-releases`.

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

This only needs to be done once (initial submission). Subsequent releases only require new GitHub release tags.

1. Fork [`obsidianmd/obsidian-releases`](https://github.com/obsidianmd/obsidian-releases)
2. Add an entry to `community-plugins.json`:

```json
{
  "id": "folderbridge",
  "name": "Folder Bridge",
  "author": "Timmothy Escolopio",
  "description": "Adds external folders to your vault as seamless, native-feeling directories. Supports local filesystem, WebDAV, S3/Backblaze B2, and SFTP mounts.",
  "repo": "tescolopio/Obsidian_FolderBridge",
  "branch": "main"
}
```

3. Open a PR — the bot will auto-validate and comment results
4. Ensure the latest GitHub release tag matches `manifest.json` `"version"` exactly
5. Address any bot or reviewer comments

---

## 5. Quick Checklist (copy before each release)

```
[ ] manifest.json version updated
[ ] package.json version updated
[ ] versions.json entry added
[ ] CHANGELOG.md entry written with root-cause detail for fixes
[ ] npm run lint — no errors
[ ] npm run build — succeeds, main.js generated
[ ] npm test — all tests pass
[ ] Commit: "chore: release vX.Y.Z"
[ ] Tag: git tag X.Y.Z && git push origin X.Y.Z  (no "v" prefix)
[ ] GitHub release created with main.js, manifest.json, styles.css attached
[ ] Release set as "Latest"
[ ] Release notes written (copy from CHANGELOG)
```
