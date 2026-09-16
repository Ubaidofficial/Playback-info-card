<p align="center">
  <img src="screenshots/ui-preview.png" alt="Playback Info Card — Studio Preview" width="900" />
</p>

<h1 align="center">Playback Info Card for Jellyfin</h1>

<p align="center">
  <strong>Real-time playback telemetry, hardware transcode diagnostics, and remote session controls &mdash; natively inside your Jellyfin dashboard.</strong>
</p>

<p align="center">
  <code>Jellyfin.Plugin.PlaybackCard</code>
</p>

<p align="center">
  <a href="https://jellyfin.org"><img src="https://img.shields.io/badge/Jellyfin-10.9%2B%20%7C%20v12%2B-blue.svg" alt="Jellyfin" /></a>
  <a href="https://dotnet.microsoft.com/"><img src="https://img.shields.io/badge/.NET-8.0-purple.svg" alt=".NET" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-green.svg" alt="License: MIT" /></a>
  <img src="https://img.shields.io/badge/Release-v0.2.3-00a4dc.svg" alt="Release: v0.2.3" />
  <a href="#-security--privacy-guarantees"><img src="https://img.shields.io/badge/Antivirus-ClamAV%20Clean-brightgreen.svg" alt="Antivirus: ClamAV Clean" /></a>
  <a href="#-security--privacy-guarantees"><img src="https://img.shields.io/badge/Security-CodeQL%20Passed-brightgreen.svg" alt="Security: CodeQL Passed" /></a>
  <a href="#-security--privacy-guarantees"><img src="https://img.shields.io/badge/Telemetry-Zero%20(Air--Gap)-blue.svg" alt="Telemetry: Zero" /></a>
</p>

---

## Overview

Playback Info Card replaces the default Devices list on your Jellyfin Admin Dashboard with an interactive monitoring card. It shows who is watching what, whether media is direct playing or transcoding, which GPU encoder is active, why a transcode was triggered, and how much bandwidth is being consumed in real time.

Everything runs natively in your browser using Jellyfin's built-in session APIs. No separate Docker container, no external database, and zero tracking.

---

## Screenshots

### Main Dashboard
> Live session cards displaying 4K HDR Direct Play, Hardware NVENC Transcode, and Lossless Hi-Res Audio with real-time bandwidth analytics.

<p align="center">
  <img src="screenshots/ui-preview.png" alt="Studio UI Preview" width="900" />
</p>

### Detailed Stream Inspection
> Individual card breakdown showing player client, resolution, video/audio formats, container changes, network origin, and file paths.

<p align="center">
  <img src="screenshots/card-detail.png" alt="Stream Hardware Telemetry Detail" width="750" />
</p>

### Mobile View
> Clean responsive layout with touch-friendly player controls and compact progress stacks for mobile browsers.

<p align="center">
  <img src="screenshots/mobile-view.png" alt="Mobile-Responsive View" width="380" />
</p>

---

## Features

### Real-Time Playback Telemetry
* **Stream Diagnostics**: Identifies Direct Play, Direct Stream, and Transcode states instantly.
* **Hardware Acceleration Badges**: Detects NVIDIA NVENC, Intel QuickSync (QSV), Apple VideoToolbox, AMD AMF, and VAAPI with performance stats (`60 fps · 2.5x speed`).
* **Dedicated Transcode Reason Row**: Displays why Jellyfin is transcoding (`Sub Burn-In`, `Video Codec`, `Audio Codec`, `Bitrate Limit`, `Container Remux`, or `Resolution Limit`).
* **Cinema & Audio Badges**: Automatic detection of 4K UHD, Dolby Vision, HDR10+, HDR10, HLG, SDR Tone Mapping, Dolby Atmos, TrueHD, DTS:X, DTS-HD MA, and Hi-Res FLAC.
* **Source Quality Tags**: Identifies release source (`REMUX`, `BLURAY`, `WEB-DL`, `HDTV`, `DVD`) from media file metadata.

### 1-Click Live FFmpeg Transcode Log Viewer
* **In-Dashboard Terminal**: Click the **FFmpeg Log** button on any transcode session to view live FFmpeg output in an overlay modal.
* **Live Stream Metrics**: Automatically parses current transcode FPS, speed multiplier, bitrate, and buffer size from the log stream.
* **Log Controls**: Syntax highlighting (errors in red, warnings in amber, progress in green), live 3-second auto-refresh, errors-only filter, and a 1-click **Copy Log** button.

### Ghost & Zombie Session Pruner
* **Automatic Detection**: Flags sessions that have been paused with no position change for over 15 minutes or abandoned socket connections consuming server RAM.
* **One-Click Prune**: Click **Prune Ghosts** in the toolbar to terminate idle sessions and reclaim server memory.

### Bandwidth Monitoring & Session Management
* **LAN vs. WAN Breakdown**: Real-time traffic split showing local home network bandwidth versus outbound internet upload.
* **Interactive Sparkline**: Rolling bandwidth trendline with interactive scrub tooltips.
* **Remote Session Controls**: Play/pause, mute/unmute, send on-screen messages to clients, or terminate streams with one click.
* **Admin Privacy Mode**: 1-click toggle (`[O] Privacy`) to mask usernames and IP addresses for screen shares or screenshots.
* **25 Offline Client Badges**: Embedded vector SVG logos for Chrome, Safari, Firefox, Apple TV, Swiftfin, Finamp, Streamyfin, Android TV, and more. 100% offline with zero CDN dependencies.

---

## 🔒 Security & Privacy Guarantees

We believe self-hosters deserve total transparency about the code running on their servers:

* **Zero External Network Requests (100% Air-Gap Safe)**: The plugin makes no external network calls, loads no third-party CDNs, and includes zero tracking or telemetry.
* **In-Memory Only**: Queries the standard internal `ApiClient.getSessions()` endpoint. No host disk writes, no external databases, and no database locks.
* **XSS Sanitization**: All incoming session metadata (usernames, media titles, client devices) is escaped with strict HTML entity encoding.
* **Automated CI Security**: Every release binary is automatically scanned by ClamAV and analyzed by GitHub CodeQL static analysis before publication.
* **Small & Auditable**: The codebase consists of clean C# plugin wrappers ([`Plugin.cs`](Plugin.cs)) and vanilla JavaScript ([`Web/playbackcard.js`](Web/playbackcard.js)) with **zero npm dependencies**.

*Read our complete [Security Policy & Verification Guide](SECURITY.md).*

---

## Installation

### Prerequisites
- [Jellyfin Media Server](https://jellyfin.org/downloads/) **10.9+** or **v12+**
- [.NET 8.0 SDK](https://dotnet.microsoft.com/download/dotnet/8.0) (only for building from source)

---

### Method 1: Plugin Repository (Recommended)

Install directly from the Jellyfin Web UI with automatic updates:

1. Open your Jellyfin Web interface and navigate to **Dashboard** &#10132; **Plugins** &#10132; **Repositories**
2. Click the **+** button to add a new repository
3. Enter the following:
   - **Repository Name**: `Playback Info Card`
   - **Repository URL**:
     ```
     https://raw.githubusercontent.com/Ubaidofficial/Playback-info-card/main/manifest.json
     ```
4. Click **Save**
5. Switch to the **Catalog** tab under Plugins
6. Find **Playback Info Card**, click **Install**, and select the latest version
7. **Restart** your Jellyfin Server

The playback card will automatically appear at the top of your Admin Dashboard whenever streams are active.

---

### Method 2: Manual Installation (Release ZIP)

1. Download `jellyfin-plugin-playbackcard.zip` from the [Latest Release](https://github.com/Ubaidofficial/Playback-info-card/releases/latest)
2. Locate your Jellyfin plugins directory:
   - **Linux**: `/var/lib/jellyfin/plugins`
   - **Windows**: `%ProgramData%\Jellyfin\Server\plugins`
   - **macOS**: `~/.local/share/jellyfin/plugins`
   - **Docker**: `/config/plugins` (mapped volume)
3. Create a folder and extract:
   ```bash
   mkdir -p /var/lib/jellyfin/plugins/PlaybackCard
   unzip jellyfin-plugin-playbackcard.zip -d /var/lib/jellyfin/plugins/PlaybackCard
   ```
4. Verify the folder contains:
   - `Jellyfin.Plugin.PlaybackCard.dll`
   - `plugin.json`
5. **Restart** your Jellyfin server

---

### Method 3: Build from Source

```bash
git clone https://github.com/Ubaidofficial/Playback-info-card.git
cd Playback-info-card
dotnet build -c Release
```

Copy the compiled DLL from `bin/Release/net8.0/Jellyfin.Plugin.PlaybackCard.dll` along with `plugin.json` into your Jellyfin `plugins/PlaybackCard/` directory and restart the server.

---

## Project Structure

```
Playback-info-card/
  JellyfinPlaybackCard.csproj    .NET 8 SDK project with embedded web resources
  Plugin.cs                      Plugin entry point (IHasWebPages)
  PluginConfiguration.cs         Configuration (BasePluginConfiguration)
  manifest.json                  Jellyfin plugin catalog manifest
  plugin.json                    Plugin metadata
  Web/
    playbackcard.js              Client-side engine: DOM renderer, state machine, API poller
    playbackcard.css             Liquid Glass theme stylesheet and responsive layout tokens
  screenshots/                   High-resolution README preview images
  SECURITY.md                    Security policy, AI disclosure, and verification guide
  LICENSE                        MIT License
```

---

## Compatibility

| Platform    | Status             | Notes                                                                                                   |
|-------------|--------------------|---------------------------------------------------------------------------------------------------------|
| **Jellyfin** | Fully Supported   | Native plugin via `IHasWebPages`. Tested on 10.9+ and v12.                                              |
| **Emby**     | Adaptable         | Emby shares historical roots but uses a proprietary SDK. The vanilla JS engine can be adapted as a userscript. |

---

## How It Works

The plugin registers itself as an `IHasWebPages` provider, injecting `playbackcard.js` into the Jellyfin Web admin dashboard. The script:

1. **Detects** the dashboard page via URL matching (`/dashboard.html` or SPA routes)
2. **Injects** a CSS stylesheet with all Liquid Glass design tokens
3. **Polls** `ApiClient.getSessions()` every 3 seconds (or your configured interval)
4. **Renders** session cards with full telemetry into a container above `.dashboardForm`
5. **Manages** its own lifecycle via `viewshow`/`viewhide`/`viewdestroy` events to prevent memory leaks

All telemetry is transient and in-memory. The plugin writes **zero data** to disk or databases.

---

## Contributing

Contributions are welcome. Please open an issue to discuss proposed changes before submitting a pull request.

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/your-feature`)
3. Commit your changes
4. Push and open a Pull Request

---

## License

This project is licensed under the [MIT License](LICENSE).

---

<p align="center">
  Built with &hearts; for the Jellyfin community
</p>
