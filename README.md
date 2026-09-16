# Playback Info Card for Jellyfin

**Stable Version: v0.2.3.1**

Real-time, cinema-grade visual stream telemetry and playback monitoring for Jellyfin Media Server.

---

## What Changed in v0.2.3.1

Version `0.2.3.1` is a complete architectural overhaul focused on server safety, client stability, and administrator privacy.

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
3. Navigate to **Catalog**, find **Playback Info Card**, and select version **0.2.3.1**.
4. Click **Install** and restart Jellyfin server.

### Method 2: Manual Installation (ZIP / Binary)
1. Download `jellyfin-plugin-playbackcard.zip` from [v0.2.3.1 GitHub Releases](https://github.com/Ubaidofficial/Playback-info-card/releases/tag/v0.2.3.1).
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

## Known Limitations

* **Client and Device Metadata**: Device names, client app titles, and operating system labels depend entirely on the strings reported by the client during session registration. Unidentified clients report as "Generic / Unknown Client".
* **Transcode Telemetry Availability**: Transcode reasons and hardware acceleration engine indicators are populated by the server only when video transcoding is active. In direct stream or direct play modes, transcode telemetry fields are omitted.
* **Polling Lifecycle**: Polling frequency is 3 seconds while the monitor page is actively viewed. Switching away or leaving the page stops polling after the current cycle.
* **Native Apps**: Native TV and mobile apps report session telemetry to Jellyfin, but the monitor UI itself can only be viewed in web browsers.

---

## License

This project is licensed under the [MIT License](LICENSE).
