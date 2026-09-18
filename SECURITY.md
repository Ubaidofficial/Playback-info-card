# Security & Privacy Policy

## What the plugin actually does

- **No external calls from the UI.** The dashboard page talks only to your own Jellyfin server — no analytics, tracking, or error-reporting SDKs.
- **Dashboard widget is an in-memory response rewrite, no disk writes.** Jellyfin's plugin API has no way to add a widget to the stock Dashboard, so `PlaybackCardDashboardMiddleware` inserts a `<script>`/`<link>` tag into the server's own `index.html` response before `</body>`. Only successful `text/html` responses are touched, nothing is written to disk, and a failed rewrite falls back to the original response. Prefer no rewriting at all? Use the dedicated PlayInfo sidebar page instead.
- **No IP or network logging.** Client IP addresses, `RemoteEndPoint`, and LAN/WAN/Wi-Fi/cellular state are never read, logged, or classified.
- **Diagnostics copy is scanned before it hits your clipboard.** The "copy diagnostic report" button checks the payload for passwords, tokens, cookies, usernames, media titles, and IP patterns, and blocks the copy if it finds one.
- **All rendered text is HTML-escaped** — usernames, client/device names, titles, transcode reasons.
- **One bad session can't crash the grid.** Each card renders inside its own error boundary.
- **Admin session controls (Stop / Send Message)** are visible only to server admins and call Jellyfin's own native Session API — the same endpoints Jellyfin Web's remote control uses. Jellyfin core enforces the actual permission check; hiding the buttons client-side is a convenience layer on top of that, not the real boundary.

Discord webhook URLs and Telegram bot tokens are stored separately from Jellyfin's regular plugin config, encrypted at rest with AES-256-GCM, in a file only the server process can read (owner-only permissions on Linux/macOS, a restricted ACL on Windows). The encryption key lives in a sibling file — DPAPI-protected on Windows, permission-restricted on Linux/macOS. The real trust boundary is filesystem access to your Jellyfin server, same as for any other plugin's config. Secrets are masked in the admin UI and never sent back to the browser in the clear. If the key file can't be read or written, the store falls back to a random key that only lasts the process lifetime — secrets won't survive a restart until the underlying issue is fixed, and you'll see a warning in the server log.

## Reporting a Vulnerability

If you discover a potential security vulnerability in this project:

1. Please **do not** open a public GitHub issue.
2. Submit your report through GitHub's [Private Vulnerability Reporting](https://github.com/Ubaidofficial/Playback-info-card/security/advisories/new).
3. I'll acknowledge within 48 hours and work on a patched release from there.
