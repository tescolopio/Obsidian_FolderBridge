# Android / Mobile Setup Guide

Use FolderBridge on your Android phone to access files stored on your **Nextcloud, NAS, WebDAV server, or S3-compatible bucket** — no computer required, no cable, no sync client.

---

## The pitch

If you run Nextcloud at home, have a NAS, or keep work files on a server, FolderBridge on mobile gives you full read/write access to those files inside Obsidian — from anywhere with internet (or WiFi).

```
Your Android phone
  → FolderBridge (HTTP/WebDAV)
    → Nextcloud / NAS / home server
      → Your project files, documents, reference library
```

No extra apps. No setup on the phone beyond installing FolderBridge. Just enter your WebDAV URL and credentials.

---

## Step 1 — Get your WebDAV URL

### Nextcloud (most common)
Your WebDAV endpoint is:
```
https://your-nextcloud.example.com/remote.php/dav/files/YOUR_USERNAME/
```
Replace the domain and username. Find it in Nextcloud → Files → ⚙️ → **WebDAV** (bottom of the sidebar).

### ownCloud
```
https://your-owncloud.example.com/remote.php/dav/files/YOUR_USERNAME/
```

### Synology NAS
Enable WebDAV in **Control Panel → File Services → WebDAV** then use:
```
https://your-nas-ip:5006/
```

### QNAP NAS
Enable in **App Center → WebDAV Server**, then:
```
https://your-nas-ip:8081/
```

### Any other WebDAV server
Use the URL your server admin provides. It must start with `http://` or `https://`.

---

## Step 2 — Install FolderBridge

Folder Bridge is not currently listed in Obsidian's Community Plugins directory.

1. Install and enable **Obsidian42 - BRAT** from **Settings → Community Plugins → Browse**.
2. Run **BRAT: Add a beta plugin for testing** from the command palette.
3. Enter `https://github.com/tescolopio/Obsidian_FolderBridge` and tap **Add Plugin**.
4. Enable Folder Bridge in **Settings → Community Plugins**.

BRAT installs a published GitHub release, not unreleased fixes on a development branch. Android loading failures are still being investigated in [issue #18](https://github.com/tescolopio/Obsidian_FolderBridge/issues/18). If enabling fails, include the installed plugin version and, when possible, the WebView console error in that issue.

---

## Step 3 — Add a mount

1. Open Obsidian → **Settings → FolderBridge**
2. Tap **Add Mount**
3. Fill in the fields:

| Field | Value |
|-------|-------|
| **Mount type** | WebDAV or S3/Backblaze B2 *(the UI shows only mobile-compatible types)* |
| **WebDAV URL** | Your server URL from Step 1 |
| **Username** | Your server username |
| **Password** | Your server password |
| **Virtual path** | Name for the folder in your vault, e.g. `Work Files` or `Nextcloud` |

4. Tap **Save**

The folder appears in Obsidian's file explorer. Browse, open, edit, and create files — all changes write back to your server in real time.

---

## Step 4 — Verify

- File explorer shows your virtual folder
- Navigate into it — your server files are listed
- Open a note — edits save back to the server
- Create a new file — it appears on the server immediately

---

## Troubleshooting

### Mount shows "Offline"
- Check that your server is reachable (open the URL in a browser on the phone)
- Confirm the URL ends with `/` — many WebDAV servers require a trailing slash
- If using `https://`, make sure the certificate is valid (self-signed certs will be rejected)
- Try `http://` if your server does not have TLS configured

### Authentication errors
- Double-check username and password
- Nextcloud users: if you use two-factor authentication, generate an **App Password** in Nextcloud Settings → Security → Devices & sessions

### Files appear but images don't load
- Images in mounted folders are served as data: URIs — this works for files under the configured size cap (default 10 MB, adjustable in FolderBridge Settings → General → Image / PDF size cap)
- Very large images won't embed — open them directly instead

### Slow performance on mobile
- WebDAV over a slow mobile data connection will be slower than local files — this is expected
- For large folders, consider mounting only a specific subdirectory rather than the server root

---

## Don't have a WebDAV server? (Power-user option)

If you want to access files that are **only on your Android device** (e.g. Downloads, DCIM), you can run a WebDAV server *on the phone itself* using a free app:

1. Install [CX File Explorer](https://play.google.com/store/apps/details?id=com.cxinventor.file.explorer) from the Play Store
2. Open CX File Explorer → tap **Network** → **Remote Access** → **Start**
3. In FolderBridge, use `http://localhost:8888/` as the WebDAV URL (adjust port as shown in the app)

Note: You need to keep the server app running in the background — Android may kill it to save battery. Enable "Run in background" in the app's settings and exclude it from battery optimisation.

This works, but it is the harder path. If you just want to access files on your Nextcloud or NAS, you do not need any of this.
