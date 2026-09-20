# Folder Bridge Development Log

## Cross-Device Local Paths

Historical work dated 2026-04-07, introduced in `a4d1f85` and carried by
`update-obsidian-folder-bridge` at `7c5d5e6`. This record was qualified during
2.15.3 integration to describe the current behavior without claiming native
platform verification.

### Motivation

Plugin configuration may be synchronized between devices, while absolute local
paths differ between Windows, Linux, and macOS. A shared mount needs an explicit
way to select a locally accessible source without rewriting its primary path.

### Behavior

- Local mounts support `fallbackRealPath` alongside their primary `realPath`.
- A device override takes precedence. Without an override, resolution checks the
  primary path and may select an accessible fallback directory. The resolved
  choice is runtime state, not a replacement for the persisted primary path.
- This is local path selection during resolution, not continuous failover or a
  fallback mechanism for WebDAV, S3, or SFTP.
- Managed TOC storage similarly supports `managedTocSourceFallback`, with
  browse/save controls and an indication when the fallback is active.
- Mount editing and TOC serialization retain fallback configuration. Security
  checks and the effective-path allowlist still apply.
- Eligible foreign-device mounts appear in refresh and picker flows. Assigning
  a device override replays the indexed tree using the selected source.

### Integration Safeguards

The stable integration keeps newer asynchronous resolution generations,
reinjection cancellation, cache handling, source ownership, and protected-path
checks instead of restoring the older implementation verbatim. Labels distinguish
fallback selection from device overrides, and inactive foreign mounts are reported.

The intended use is one accessible local source per device. Native Windows/WSL,
macOS, Linux host behavior, and minimum-host compatibility are not established by
this historical note. See [RELEASE_VALIDATION.md](RELEASE_VALIDATION.md) for
outstanding platform checks.
