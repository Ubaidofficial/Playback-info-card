<p align="center">
  <img src="screenshots/ui-preview.png" alt="Playback Info Card — Studio Preview" width="900" />
</p>

<h1 align="center">Playback Info Card for Jellyfin</h1>

<p align="center">
  <code>Jellyfin.Plugin.PlaybackCard</code>
</p>

<p align="center">
  <a href="https://jellyfin.org"><img src="https://img.shields.io/badge/Jellyfin-10.9%2B%20%7C%20v12%2B-blue.svg" alt="Jellyfin" /></a>
  <a href="https://dotnet.microsoft.com/"><img src="https://img.shields.io/badge/.NET-8.0-purple.svg" alt=".NET" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-green.svg" alt="License: MIT" /></a>
  <img src="https://img.shields.io/badge/Release-v0.2.0-blue.svg" alt="Release: v0.2.0" />
</p>

<p align="center">
  A native, real-time playback monitoring plugin for <strong>Jellyfin Media Server</strong> that brings <strong>Tautulli-grade session telemetry</strong> and <strong>Moonfin Liquid Glass</strong> aesthetics directly into the Admin Dashboard &mdash; zero external services, zero disk writes, zero dependencies.
</p>

---

## Highlights

- **Tautulli-Grade Specification Matrix**: Clean, dense two-column telemetry table with explicit rows for Player, Product, Quality, Stream, Container, Video, Audio, Subtitle, Location, Bandwidth, and File path.
- **25 Official Vector Brand Badges**: Offline, multi-color vector SVGs for all major clients (Apple Safari, Chrome, Firefox, Edge, Brave, Streamyfin, Finamp, Findroid, Feishin, Android, Apple TV, Chromecast, Nvidia Shield, PlayStation, Xbox, Roku, Fire TV, LG webOS, Samsung Tizen, Kodi, Infuse, Swiftfin, Jellyfin Web).
- **Multi-Stream Smart Sorting**: Instant sorting of concurrent playback sessions by Bandwidth (highest bitrate first), Transcodes First, Progress / ETA, or User Name.
- **Interactive Bandwidth Sparkline & Scrubber**: Rolling bandwidth trendline with interactive hairline cursor scrubber and frosted telemetry tooltip detailing LAN vs WAN breakdown and peak throughput.
- **Configurable Polling Engine**: 1-click cycle between 1s (Real-time), 3s (Balanced), 5s (Eco), and 10s (Low-power) with instant live timer restart and persistent storage.
- **Frosted Glass Time HUD Capsule**: Floating backdrop-blurred widget with real-time ETA or elapsed/total duration toggle and live 1-second ticker.
- **Liquid Glass & Moonfin Aesthetics**: Obsidian glass foundation with specular light sweeps, GlinUI elevation depth, and subtle chromatic rims.
- **Admin Remote Control**: Remote Play/Pause, Mute, direct client messaging, and one-click stream termination.
- **100% Native & Self-Contained**: Injected seamlessly into Jellyfin Web's SPA lifecycle. Zero external API calls, zero database writes, and zero performance overhead.

---

## Screenshots

### Studio UI Preview & Telemetry Matrix
> Multi-stream dashboard view featuring 4K HDR Direct Play (Apple TV 4K), Hardware Transcode (Chrome), and Hi-Res Lossless Audio (Finamp) with the live bandwidth visualizer and sparkline.

<p align="center">
  <img src="screenshots/ui-preview.png" alt="Studio UI Preview" width="900" />
</p>

### Session Card Detail
> Close-up of active playback card showing video/audio specs, hardware acceleration, and quick actions.

<p align="center">
  <img src="screenshots/card-detail.jpg" alt="Session Card Detail" width="750" />
</p>

### Mobile Responsive View
> Adaptive layout optimized for phone screens and tablets with touch-friendly controls.

<p align="center">
  <img src="screenshots/mobile-view.jpg" alt="Mobile View" width="380" />
</p>

---

## Features

### Tautulli-Grade Telemetry Matrix
- **Structured Spec Table**:
  - `PRODUCT`: Client application and version
  - `PLAYER`: Clean device model (e.g. `Apple TV 4K`, `MacBook Pro`, `Pixel 9 Pro`)
  - `QUALITY`: Resolution & dynamic range (e.g. `1080p SDR`, `4K HDR10`, `Dolby Vision BT.2020`)
  - `STREAM`: Stream method badge (`DIRECT PLAY`, `DIRECT STREAM`, or `TRANSCODE`) with transcode reason tooltip
  - `CONTAINER`: Media container path (e.g. `MKV ➔ MP4` or `Direct Play MKV`)
  - `VIDEO`: Video codec, bitrate, frame rate, and bit-depth
  - `AUDIO`: Audio codec, channel configuration (`5.1`, `7.1`, `Stereo`), bitrate, and sample rate
  - `SUBTITLE`: Language, subtitle format (`SRT`, `PGS`, `ASS`), and burn-in diagnostic status
  - `LOCATION`: Network origin with connection badge (`LAN`, `WAN`, `CELLULAR`) and client IP
  - `BANDWIDTH`: Real-time session bandwidth utilization
  - `FILE`: Click-to-copy source media path with file size and instant "Copied!" feedback
- **Hardware Acceleration Telemetry**: Automatic detection of NVENC, QuickSync (QSV), VAAPI, VideoToolbox (Apple Silicon), AMF (AMD), or CPU Software transcoding.
- **Transcode Performance Metrics**: Real-time transcode FPS counter and playback speed multiplier (e.g. `2.5x`) with stutter alerts if speed falls below `1.0x`.

### 25 Official Client Brand Badges
- 100% inline, high-fidelity vector SVGs rendered directly inside the card header:
  - **Browsers**: Apple Safari, Google Chrome, Mozilla Firefox, Microsoft Edge, Brave, Opera GX, Vivaldi
  - **Jellyfin Community Clients**: Streamyfin, Finamp, Findroid, Feishin, Swiftfin, Jellyfin Web
  - **Ecosystem & OS**: Apple TV, Apple iOS/macOS, Google Android, Nvidia Shield TV, Google Chromecast, Amazon Fire TV, Roku
  - **Home Theater & Consoles**: Kodi, Infuse, Sony PlayStation, Microsoft Xbox, LG webOS, Samsung Tizen
- Completely offline: no third-party CDNs, no tracking pixels, zero latency.

### Live Activity Banner, Sparkline & Smart Sorting
- **Stream Activity Header**: Live stream count with pulsing emerald indicator for active playback or amber for paused sessions.
- **Segmented Bandwidth Counter**: Total bandwidth consumption broken down into LAN and WAN upload rates.
- **Rolling Bandwidth Sparkline with Interactive Scrubber**: Smooth SVG micro-trendline displaying bandwidth velocity; hover over any point to reveal an interactive cursor hairline and frosted tooltip with LAN/WAN stats and peak throughput.
- **Multi-Stream Smart Sorting**: 1-click sort toggle in the activity toolbar that smoothly orders cards by:
  - `Default`: Server session order
  - `Bandwidth`: Highest bitrate stream first
  - `Transcodes`: Transcoding streams prioritized at the top
  - `Progress`: Longest duration / highest percentage watched
  - `User A-Z`: Alphabetical by user account name
- **Configurable Polling Engine**: 1-click pill (`⏱ 3s`) that toggles between `1s` (Real-time), `3s` (Balanced), `5s` (Eco), and `10s` (Low-power); restarts the polling loop dynamically without reloading the page.
- **Connected / Idle Devices Drawer**: Collapsible panel listing connected inactive clients with last-seen timestamps.
- **Privacy Mode (`[O] Privacy`)**: One-click toggle that masks user account names and IP addresses for stream-safe screenshots and screen shares.
- **Instant Stream Filters**: Filter sessions on the fly by `All`, `Transcode`, `WAN`, or `Paused`.

### Frosted Glass Time HUD Capsule
- Floating glass capsule with `backdrop-filter: blur(14px)` and specular border bevel.
- **Dynamic Time Mode**: Displays expected completion time (`ETA 10:45 PM`) or paused duration (`Paused 04:12`).
- **Interactive Toggle**: Click to instantly toggle between ETA and `Elapsed / Total` (`18:41 / 20:30 (91%)`).
- **Live 1-Second Ticker**: Smoothly advances progress bar and time counters between server polling cycles.
- **Dual-Layer Progress Bar**: Visualizes current playback position alongside the transcode buffer fill.

### Remote Session Controls
- **Play / Pause**: Remotely pause or resume client playback.
- **Mute / Unmute**: Remotely toggle audio on the client device.
- **Direct Client Messaging**: Send an instant pop-up notification directly to the user's screen.
- **Kill Stream**: Immediately terminate an unwanted session with confirmation.

### Liquid Glass & Moonfin Design System
- **Obsidian Dark Foundation**: Deep glass base (`#090a10`) with heavy backdrop blur and saturation boost.
- **Moonfin Specular Sweeps**: Dynamic subtle highlight reflections across card surfaces.
- **GlinUI Elevation**: Consistent 5-level visual hierarchy separating cards, badges, buttons, and drawers.
- **Zero AI Bloat**: Pure typography, official branding, and clean geometry &mdash; no cartoon emojis.

### Engineering & Performance
- **Zero Memory Leaks**: Full integration with Jellyfin Web's Single Page Application lifecycle (`viewshow`, `viewhide`, `viewdestroy`).
- **State Hashing**: Prevents redundant DOM re-renders to maintain 60 FPS smooth scrolling.
- **Zero Server Overhead**: 100% in-memory client telemetry querying standard `ApiClient.getSessions()`. Zero disk I/O, zero database locks.
- **Standalone Compatibility**: Graceful fallback guards ensuring 0 console errors when run standalone or as an installed plugin.

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

1. Download `Playback-info-card.zip` from the [Latest Release](https://github.com/Ubaidofficial/Playback-info-card/releases/latest)
2. Locate your Jellyfin plugins directory:
   - **Linux**: `/var/lib/jellyfin/plugins`
   - **Windows**: `%ProgramData%\Jellyfin\Server\plugins`
   - **macOS**: `~/.local/share/jellyfin/plugins`
   - **Docker**: `/config/plugins` (mapped volume)
3. Create a folder and extract:
   ```bash
   mkdir -p /var/lib/jellyfin/plugins/PlaybackCard
   unzip Playback-info-card.zip -d /var/lib/jellyfin/plugins/PlaybackCard
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
    playbackcard.js              Client-side engine: CSS, DOM renderer, API poller
  screenshots/                   README preview images
  LICENSE                        MIT License
```

---

## Compatibility

| Platform    | Status             | Notes                                                                                                   |
|-------------|--------------------|---------------------------------------------------------------------------------------------------------|
| **Jellyfin** | Fully Supported   | Native plugin via `IHasWebPages`. Tested on 10.9+ and v12.                                              |
| **Emby**     | Adaptable         | Emby shares historical roots but uses a proprietary SDK. The vanilla JS engine can be adapted as a userscript. |
| **Plex**     | Not Supported     | Plex Web is a closed React app. Use [Tautulli](https://tautulli.com) for Plex stream monitoring.        |

---

## How It Works

The plugin registers itself as an `IHasWebPages` provider, injecting `playbackcard.js` into the Jellyfin Web admin dashboard. The script:

1. **Detects** the dashboard page via URL matching (`/dashboard.html` or SPA routes)
2. **Injects** a CSS stylesheet with all Liquid Glass design tokens
3. **Polls** `ApiClient.getSessions()` every 3 seconds (or user-configured interval)
4. **Renders** session cards with full telemetry into a container above `.dashboardForm`
5. **Manages** its own lifecycle via `viewshow`/`viewhide`/`viewdestroy` events to prevent memory leaks

All data is transient. The plugin writes **zero data** to disk or databases.

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
