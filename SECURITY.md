# Security & Privacy Policy

## What the plugin actually does

* **No external calls from the UI**: The dashboard page itself makes no third-party network requests and includes no analytics, tracking beacons, or error-reporting SDKs. It only talks to your own Jellyfin server.
* **Dashboard injection is in-memory only, no disk writes**: To put the Now Playing widget onto the stock Dashboard, an `IStartupFilter`-registered ASP.NET Core middleware (`PlaybackCardDashboardMiddleware`) rewrites the server's own `index.html` response in memory, appending a `<script>`/`<link>` tag for the plugin's own JS/CSS before `</body>`. It only touches successful, `text/html` responses, never writes anything to disk, and falls back to serving the original unmodified response if the rewrite itself fails. This is a deliberate architectural choice (Jellyfin's plugin API alone has no way to add a widget to the existing Dashboard page), not an oversight — if you'd rather avoid any response rewriting, use the dedicated **Playback Monitor** sidebar page instead of the auto-injected Dashboard widget.
* **No network classification or IP harvesting**: The monitor does not log, parse, or classify client IP addresses, `RemoteEndPoint`, or LAN/WAN/cellular/Wi-Fi states.
* **Redacted diagnostics copy**: Before the "copy diagnostic report" button puts anything on your clipboard, it scans the payload for sensitive-looking fields (passwords, tokens, cookies, usernames, media titles, IP patterns) and blocks the copy if it finds one.
* **Escaped output**: Every session-derived string rendered into the page (usernames, client/device names, titles, transcode reasons) goes through HTML-entity escaping before it touches the DOM.
* **Isolated render failures**: A malformed or unexpected session doesn't crash the whole grid — each card renders inside its own error boundary.

Notification secrets (Discord webhook URLs, Telegram bot tokens) are kept out of Jellyfin's regular plugin config file and stored separately, encrypted at rest with AES-256-GCM, in a file only the server process can read (owner-only permissions on Linux/macOS; a restricted ACL via `icacls` on Windows). The encryption key lives in a sibling file next to it — DPAPI-protected on Windows, permission-restricted on Linux/macOS — so the real trust boundary is filesystem access to your Jellyfin server, same as for any other plugin's config. They're masked in the admin UI and never sent back to the browser in the clear. If the key file can't be read or written (e.g. a read-only filesystem), the store falls back to a random, process-lifetime-only key rather than ever deriving one from something guessable — secrets just won't survive a restart until the underlying issue is fixed, and you'll see a warning in the server log when that happens.

## Reporting a Vulnerability

If you discover a potential security vulnerability in this project:

1. Please **do not** open a public GitHub issue.
2. Submit your report through GitHub's [Private Vulnerability Reporting](https://github.com/Ubaidofficial/Playback-info-card/security/advisories/new).
3. We will review and acknowledge within 48 hours and coordinate a patched release promptly.
