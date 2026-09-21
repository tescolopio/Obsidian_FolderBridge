# Security Policy

## Supported versions

Security fixes go into the latest stable release and, when one exists, the newest
prerelease. Older releases are not patched; please update first and check whether the
problem still occurs.

## Reporting a vulnerability

Please **do not open a public issue** for a security problem. Report it privately with
GitHub's private vulnerability reporting:

1. Open the [Security tab](https://github.com/tescolopio/Obsidian_FolderBridge/security)
   of this repository.
2. Choose **Report a vulnerability**, or go straight to
   [the report form](https://github.com/tescolopio/Obsidian_FolderBridge/security/advisories/new).

Only the maintainers can see the report until it is resolved.

### What helps

- The Folder Bridge version and where you installed it from (release, BRAT, or source).
- Your operating system and Obsidian version.
- Exact steps to reproduce, and what you expected to happen instead.
- The impact you believe it has, for example reading files outside a mount or exposing a
  credential.
- Whether the problem needs a specific mount type (local, vault, WebDAV, S3 or SFTP).

Please do not include real passwords, access keys or private notes. A disposable vault and
sample files are enough.

## What we consider in scope

Folder Bridge maps folders outside your vault into it, so reports about these areas are
especially useful:

- Reading or writing outside a configured mount or the allowlist, including path traversal
  and symbolic links.
- Mounts that should be refused as protected system paths.
- Handling of credentials for WebDAV, S3 and SFTP mounts, including the stored form and
  exports.
- The local file server used for media, and how servers' identities are verified.
- Data loss caused by a bug in a write, append, rename or delete path.

## After you report

We will confirm receipt, investigate, and tell you what we decide. Fixes are released as a
new version and described in the [changelog](CHANGELOG.md). If you would like credit, say
how you want to be named.
