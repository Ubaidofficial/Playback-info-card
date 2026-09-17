# Playback Info Card for Jellyfin

**Stable Version: v0.2.3.3**

Real-time stream telemetry and playback monitoring for Jellyfin Media Server.

---

## What Changed in v0.2.3.3

Version `0.2.3.3` provides a critical reliability patch for native Discord and Telegram notifications:

* **Dual Route Aliasing**: Resolved HTTP 404 route mismatch on notification and self-session endpoints by supporting both `PlaybackCard/Notifications` and `PlaybackInfoCard/Notifications` (and `/Self`) routes.
* **Non-Destructive Partial Configuration Updates**: Saving Telegram or Discord configuration independently now safely preserves master notification state and other destination settings without clobbering existing configuration.
* **Flexible Telegram Token Parsing**: Gracefully accepts Bot API tokens with or without the optional leading `bot` prefix (`bot123...` and `123...`).
* **Descriptive Diagnostic Results**: Outbound test dispatches now return actionable, privacy-redacted error descriptions and status codes directly in the web UI.
* **UI State Synchronization**: Diagnostics panel and notification switches now stay synchronized in real time.

* **Plugin-Owned Web Page**: The monitor is now served via Jellyfin's official `IHasWebPages` interface as a dedicated internal admin page (`Dashboard -> Server -> Playback Monitor`).
* **Zero Host Injection**: Completely eliminated ASP.NET Core middleware, response-stream HTML rewriting, startup pipeline filters (`IStartupFilter`), and disk file manipulation.
* **No Network or Location Classification**: Removed all IP address parsing, WAN/LAN/Cellular heuristics, and geolocation inference.
* **No Remote-Control Actions**: Removed all stream termination, pause, or remote control hooks. The monitor is strictly a read-only telemetry dashboard.
* **No Custom Server APIs**: Queries Jellyfin's standard, authenticated `/Sessions` API client directly in browser memory.
* **Built-In Local Diagnostics**: Added a small, administrator-visible diagnostics panel with an automated privacy-redacting **"Copy diagnostic report"** tool.
* **User-Initiated Issue Reporting**: Added pre-formatted GitHub issue templates with privacy guidelines and confirmation checkboxes.

---

## Where to Find the Monitor

In earlier releases (`0.2.3.0` and prior), the plugin injected cards directly into the default Jellyfin Dashboard "Devices" section.

In `0.2.3.1`, the monitor has moved to a dedicated, plugin-owned page:

1. Log into **Jellyfin Web** as an **Administrator**.
2. Open the **Dashboard** (Settings &rarr; Dashboard).
3. In the left navigation sidebar under the **Server** section, click **Playback Monitor**.

Direct URL route: `/web/#/configurationpage?name=playbackcard`

---

## Features & UI Overview

* **Compact & Extended Modes**: Toggle between a clean, badge-capped compact grid and an expanded telemetry breakdown.
* **Stream Telemetry**:
  - Playback status: Playing &bull; Paused &bull; Direct Play &bull; Direct Stream &bull; Remux &bull; Transcode
  - Resolution: 4K &bull; 1440p &bull; 1080p &bull; 720p &bull; SD
  - Dynamic Range: HDR &bull; HDR10+ &bull; Dolby Vision &bull; SDR
  - Video Codecs: HEVC &bull; AV1 &bull; VP9 &bull; H.264 &bull; MPEG2
  - Bit Depth: 10-bit &bull; 8-bit
  - Audio: Atmos &bull; 7.1 &bull; 5.1 &bull; Stereo &bull; Audio Codecs (TrueHD, E-AC3, AC3, DTS, FLAC, AAC)
  - Active Subtitles &amp; Closed Captions: Language and subtitle stream type
  - Framerate (FPS) &amp; Stream Bitrate
* **Transcoding Engine Details**: In extended mode, view active hardware acceleration engine (`QSV`, `NVENC`, `VAAPI`, `AMF`, `VideoToolbox`, or `Software CPU`), container conversion, and transcode reasons reported by the server.
* **Artwork & Visuals**: Poster artwork and subtle blurred backdrop with automatic error fallback.
* **Platform Icons**: Self-contained inline SVGs for Android, Apple, Windows, Linux, Roku, LG webOS, Samsung Tizen, Chrome/Web, and Fire TV.

---

## Privacy & Diagnostics Policy

### 100% Offline & Air-Gapped
* **Zero External Calls**: The monitor executes entirely within browser memory and queries only the local Jellyfin server via authenticated `ApiClient.getSessions()`.
* **Zero Telemetry**: No tracking, no Google Analytics, no Sentry, no remote beacons, and no automated uploads.

### Safe Diagnostics & Redacted Reports
The diagnostics card at the bottom of the monitor displays:
* Plugin version (`0.2.3.1`)
* Jellyfin server and web client versions (if available)
* Current monitor route
* Sessions API health category (`OK`, `Waiting for sessions`, `Sessions unavailable`)
* Polling status (`active`, `stopped`, `stalled` when interval exceeds threshold)
* Artwork loaded, fallback, and error counts
* Malformed session and client render error counts

### Redacted Copy Tool
Clicking **Copy diagnostic report** produces a clean JSON structure:
```json
{
  "pluginVersion": "0.2.3.1",
  "jellyfinVersion": "10.9.11",
  "webVersion": "Available",
  "route": "/playbackcard",
  "pageLoaded": true,
  "sessionsApi": "ok",
  "lastSuccessfulPoll": "3s ago",
  "pollingState": "active",
  "artwork": "loaded",
  "ignoredSessionCount": 0,
  "renderErrors": 0
}
```
Before copying, an automated redaction check scans for sensitive keywords (`RemoteEndPoint`, `ipAddress`, `token`, `password`, `cookie`, `media title`, `username`, IP regex). If any sensitive pattern is detected, the copy action is immediately blocked with a warning.

---

## Installation

### Method 1: Jellyfin Plugin Repository (Catalog Delivery)
> [!NOTE]
> Method 1 delivery requires the plugin repository URL to be configured in your Jellyfin server. Until catalog updates are released to production, install via Method 2 (Manual ZIP).

1. In Jellyfin Web, navigate to **Dashboard** &rarr; **Plugins** &rarr; **Repositories**.
2. Add the custom repository:
   - **Repository Name**: `Playback Info Card`
   - **Repository URL**: `https://raw.githubusercontent.com/Ubaidofficial/Playback-info-card/main/manifest.json`
3. Navigate to **Catalog**, find **Playback Info Card**, and select version **0.2.3.3**.
4. Click **Install** and restart Jellyfin server.

### Method 2: Manual Installation (ZIP / Binary)
1. Download `jellyfin-plugin-playbackcard.zip` from [v0.2.3.3 GitHub Releases](https://github.com/Ubaidofficial/Playback-info-card/releases/tag/v0.2.3.3).
2. Locate your Jellyfin `plugins` directory:
   - **Linux (systemd)**: `/var/lib/jellyfin/plugins/PlaybackCard/`
   - **Docker**: `<path-to-config>/plugins/PlaybackCard/`
   - **Windows**: `%ProgramData%\Jellyfin\Server\plugins\PlaybackCard\` or `<install-dir>\plugins\PlaybackCard\`
   - **macOS**: `~/.local/share/jellyfin/plugins/PlaybackCard/`
3. Extract `Jellyfin.Plugin.PlaybackCard.dll` and `plugin.json` into the `PlaybackCard` subdirectory.
4. Restart Jellyfin Media Server.

---

## Deployment Notes by Platform

### Linux (Debian / Ubuntu / Arch / Fedora)
* Ensure file permissions for the extracted files match the `jellyfin` service account:
  ```bash
  sudo chown -R jellyfin:jellyfin /var/lib/jellyfin/plugins/PlaybackCard
  sudo chmod 644 /var/lib/jellyfin/plugins/PlaybackCard/*
  sudo systemctl restart jellyfin
  ```

### Docker
* Mount the plugins directory from the host into the container:
  ```yaml
  volumes:
    - /path/to/jellyfin/config:/config
    - /path/to/jellyfin/plugins:/plugins
  ```
* Place the plugin files in `<host-plugins-dir>/PlaybackCard/` and restart the container:
  ```bash
  docker restart jellyfin
  ```

### Windows
* Ensure the service account has read permissions to `%ProgramData%\Jellyfin\Server\plugins\PlaybackCard`.
* Restart the Jellyfin Server service using the Windows Services app or Jellyfin tray tool.

### Reverse Proxy and Custom Base Paths
* **Base Path Support**: The monitor page resolves URLs using Jellyfin's runtime `ApiClient.getUrl()`, which respects custom base paths (such as `/jellyfin` or `/media`).
* **Sub-path / Nginx / Caddy / Traefik / Cloudflare**:
  - No special proxy header rewrites are required.
  - Standard WebSocket and HTTP proxy pass directives for Jellyfin are sufficient.
  - Do not cache dynamic responses for `/Sessions` or `/web/configurationpage`.

---

## Client Compatibility

* **Jellyfin Web (Desktop & Mobile)**: Fully supported modern browser interface.
* **Native Client Apps (Android TV, Apple TV, Roku, iOS, Infuse, Moonfin, Jellyfin Enhanced)**: Native client playback sessions are reported by the server and will appear in the Web Playback Monitor. However, native client apps do not render internal Web plugin pages.

---

## Migration from v0.2.3.0

1. **Uninstall Legacy Injection**: If you previously installed `0.2.3.0`, replace the plugin DLL and `plugin.json` in your server's `plugins/PlaybackCard/` directory with `0.2.3.1`.
2. **Remove Host Modifications**: If you previously inserted `<script>` tags into `index.html` or used custom CSS tweaks for earlier versions, remove them. Version `0.2.3.1` requires zero host file modifications.
3. **Restart Jellyfin**: Restart the server to initialize the updated assembly.
4. **Access the New Location**: Open Jellyfin Web &rarr; Dashboard &rarr; Server &rarr; **Playback Monitor**.

---

## Rollback Instructions

If you need to revert to `0.2.3.0` for any reason:

1. Stop Jellyfin Server:
   ```bash
   sudo systemctl stop jellyfin
   ```
2. Download the preserved `0.2.3.0` release package:
   ```bash
   curl -L -O https://github.com/Ubaidofficial/Playback-info-card/releases/download/v0.2.3/jellyfin-plugin-playbackcard.zip
   ```
3. Extract into your plugins directory:
   ```bash
   unzip -o jellyfin-plugin-playbackcard.zip -d /var/lib/jellyfin/plugins/PlaybackCard/
   ```
4. Restart Jellyfin Server:
   ```bash
   sudo systemctl start jellyfin
   ```
The previous `0.2.3.0` release artifact and repository manifest entry remain preserved for immediate rollback.

---

## ABI & Version Compatibility

* **Compiled Server SDK**: Jellyfin 10.9.11 (`Jellyfin.Controller` and `Jellyfin.Model`).
* **Target Runtime**: `.NET 8.0` (`net8.0`).
* **Target ABI**: Declared as `10.9.0.0` in `plugin.json`.
* **Version Scope**: Compatibility is designed for Jellyfin 10.9.x releases. Compatibility is treated as unverified until validated on your specific server environment and deployment type. We do not claim universal support across every Jellyfin version.

---

## Client Compatibility & Telemetry Limitations

* **Dashboard Web Interface**: The Playback Monitor UI runs exclusively within the Jellyfin Web administrator interface (`Dashboard -> Server -> Playback Monitor`).
* **Native Apps (Moonfin, Android TV, Apple TV, Roku, iOS, Infuse, Jellyfin Enhanced)**:
  - Native apps provide playback session data and telemetry to the server API; they **do not** render this dashboard page.
  - Do not assume universal client support: device names, client application titles, and operating system labels depend strictly on what each individual client reports upon session registration.
  - Omitted fields: If a client does not report audio/video bitrates, framerates, or profile data, the monitor omits these tags rather than inventing placeholders.
* **Network & Connection Type**: The monitor never attempts to distinguish Wi-Fi, Ethernet, or Cellular connections. Jellyfin cannot reliably distinguish these network modes, and network classification heuristics are strictly forbidden for privacy.

---

## Known Unverified Scenarios

* **Live Server Environments**: Manual verification matrix across all physical native clients (Moonfin, Android TV, Jellyfin Enhanced) and live Windows host deployments remains to be verified by administrators on their respective servers.
* **Method 1 Catalog**: The repository catalog (`manifest.json`) on `main` provides version `0.2.3.1` with verified MD5 checksums, while retaining `0.2.3.0` for safe rollback.

---

## Playback Notifications (Native Discord & Telegram)

Playback Info Card provides high-performance, server-side native playback notifications for **Discord** and **Telegram**. Dispatches occur directly inside the Jellyfin server background pipeline, operating completely independently of client browsers or external plugins.

### Privacy by Omission & Threat Model

* **IP-Safe by Omission**: The notification pipeline never queries, collects, or transmits client IP addresses, server internal IPs, remote endpoints, private LAN/WAN classifications, local filesystem paths, or authentication tokens.
* **Explicit Disclosures**: Username and client/device disclosures are **disabled by default**. Administrators must explicitly check the respective disclosure checkboxes in the UI to include user account names or device models in external messages.
* **Server-Local Plaintext Storage Disclosure**: In accordance with Jellyfin plugin architecture, plugin settings and configured secrets (Discord webhook URLs, Telegram bot tokens) are stored in server-local XML configuration files on disk in plaintext. Secrets are never encrypted on disk. Ensure file-system access to your Jellyfin server is strictly restricted to authorized administrators.
* **Write-Only Secrets & Masking in API**: The plugin's administration REST API masks all tokens and secrets in responses (e.g. `••••••••`). Raw secret values are never reflected back over the network to the browser.
* **Mention Storm Suppression**: Outbound Discord payloads strictly enforce `"allowed_mentions": { "parse": [] }` and sanitize `@everyone`, `@here`, and role mention strings from media titles to prevent ping storms.
* **HTML Tag Integrity**: Outbound Telegram messages strictly escape HTML special characters (`&`, `<`, `>`, `"`) and cap messages at 4,096 characters to prevent HTML tag corruption.

---

### Configuration Guide

#### 1. Native Configuration via Playback Monitor Page
Administrators can configure notifications directly on the **Playback Monitor** page (`/playbackcard`):
1. Navigate to **Dashboard** &rarr; **Playback Monitor** (or `/playbackcard`).
2. Scroll to the **Playback Notifications** section (visible only to server administrators).
3. Toggle the **Master Switch** to enable the notification engine.
4. Configure your desired destination (Discord and/or Telegram).
5. Select your desired event subscriptions (Playback Start, Stop, Media Completion, Pause/Resume, and Periodic Progress).
6. Click **Test Discord** or **Test Telegram** to send a synthetic test dispatch and verify delivery health.

---

#### 2. Telegram Bot Setup
1. Open Telegram and start a chat with [@BotFather](https://t.me/botfather).
2. Send `/newbot` and follow the prompts to create your bot and obtain your HTTP API bot token (formatted as `123456789:ABCdefGhIjKlMnOpQrStUvWxYz`).
3. Create a Telegram channel or group for alerts, add your bot as an administrator, and send a test message.
4. Obtain the target Chat ID using `@userinfobot`, `@get_id_bot`, or by querying `https://api.telegram.org/bot<TOKEN>/getUpdates`.
5. In Playback Info Card settings, enter the Bot Token and Chat ID, toggle **Enable Telegram Delivery**, and click **Save Telegram**.

---

#### 3. Discord Webhook Setup
1. In Discord, open your server's **Server Settings** &rarr; **Integrations** &rarr; **Webhooks**.
2. Click **New Webhook**, assign a name (e.g., `Jellyfin Playback`), and select the alert channel.
3. Click **Copy Webhook URL** (must start with `https://discord.com/api/webhooks/` or `https://discordapp.com/api/webhooks/`).
4. In Playback Info Card settings, paste the Webhook URL into **Webhook URL**, toggle **Enable Discord Delivery**, and click **Save Discord**.

---

### Delivery Engine & Resilience

* **Independent Bounded Queues**: Discord and Telegram queues are fully isolated with an in-memory capacity of 100 items each.
* **Priority Delivery**: Playback Start, Stop, and Media Completion events are prioritized over progress updates. A dedicated reservation of 20 slots ensures critical notifications are never blocked by high volumes of progress updates.
* **Progress Coalescing**: Consecutive periodic progress updates for the same playback session replace older pending progress in the queue, preventing delivery backlog.
* **Rate Limiting & Backoff**: Handles HTTP 429 rate limits by parsing Discord `Retry-After` headers and Telegram `parameters.retry_after`. Transient network errors (5xx, timeouts) automatically retry up to 3 times with exponential backoff and jitter. Permanent client errors (400, 401, 403, 404) fail immediately without retry.
* **Shutdown Drain Budget**: On Jellyfin server shutdown, background queues execute a graceful drain with a 3-second maximum budget to flush pending events without delaying server termination.

---

### Optional Upstream Webhook Plugin Integration (Alternative Option A)

If you prefer using the generic upstream [Jellyfin Webhook Plugin](https://github.com/jellyfin/jellyfin-plugin-webhook) instead of the native engine:

> [!CAUTION]
> **DO NOT USE THE OFFICIAL UPSTREAM SAMPLE TELEGRAM TEMPLATE AS-IS.**
> The sample `PlaybackStart.handlebars` template in the official webhook repository includes `{{RemoteEndPoint}}`, which broadcasts internal server IP addresses, client IP addresses, and private network topologies into chat rooms.
> Always use IP-safe templates that strictly omit all IP and network fields.

#### IP-Safe Upstream Telegram Template:
```json
{
  "chat_id": "YOUR_CHAT_ID",
  "text": "🎬 <b>Playback Started</b>\n\n<b>Title:</b> {{#if_equals ItemType 'Episode'}}<b>{{SeriesName}}</b> — S{{SeasonNumber00}}E{{EpisodeNumber00}} {{Name}}{{else}}<b>{{Name}}</b> ({{Year}}){{/if_equals}}\n<b>User:</b> {{NotificationUsername}}\n<b>Client:</b> {{ClientName}} ({{DeviceName}})\n<b>Play Method:</b> {{PlayMethod}}\n<b>Video:</b> {{Video_0_Codec}} {{Video_0_Width}}x{{Video_0_Height}}\n<b>Audio:</b> {{Audio_0_Codec}} ({{Audio_0_Channels}}ch)",
  "parse_mode": "HTML",
  "protect_content": true,
  "disable_web_page_preview": true
}
```

#### IP-Safe Upstream Discord Embed Template:
```json
{
  "content": "",
  "allowed_mentions": { "parse": [] },
  "embeds": [
    {
      "title": "🎬 Playback Started",
      "description": "{{#if_equals ItemType 'Episode'}}**{{SeriesName}}**\nS{{SeasonNumber00}}E{{EpisodeNumber00}} — {{Name}}{{else}}**{{Name}}** ({{Year}}){{/if_equals}}",
      "color": 421980,
      "fields": [
        { "name": "User", "value": "{{NotificationUsername}}", "inline": true },
        { "name": "Client", "value": "{{ClientName}} ({{DeviceName}})", "inline": true },
        { "name": "Stream", "value": "{{PlayMethod}}", "inline": true },
        { "name": "Video", "value": "{{Video_0_Codec}} {{Video_0_Width}}x{{Video_0_Height}}", "inline": true },
        { "name": "Audio", "value": "{{Audio_0_Codec}} {{Audio_0_Channels}}ch", "inline": true }
      ],
      "footer": { "text": "Playback Info Card • Privacy Safe" },
      "timestamp": "{{UtcTimestamp}}"
    }
  ]
}
```

---

## Known Limitations

* **Client and Device Metadata**: Device names, client app titles, and operating system labels depend entirely on the strings reported by the client during session registration. Unidentified clients report as "Generic / Unknown Client".
* **Transcode Telemetry Availability**: Transcode reasons and hardware acceleration engine indicators are populated by the server only when video transcoding is active. In direct stream or direct play modes, transcode telemetry fields are omitted.
* **Polling Lifecycle**: Polling frequency is 3 seconds while the monitor page is actively viewed. Switching away or leaving the page stops polling after the current cycle.
* **Native Apps**: Native TV and mobile apps report session telemetry to Jellyfin, but the monitor UI itself can only be viewed in web browsers.

---

## License

This project is licensed under the [MIT License](LICENSE).
