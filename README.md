# Playback Info Card for Jellyfin (`Jellyfin.Plugin.PlaybackCard`)

[![Jellyfin](https://img.shields.io/badge/Jellyfin-10.9%2B%20%7C%20v12%2B-blue.svg)](https://jellyfin.org)
[![.NET](https://img.shields.io/badge/.NET-8.0-purple.svg)](https://dotnet.microsoft.com/)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

A native visual monitoring plugin for **Jellyfin Media Server (v12+ / 10.9+)** that injects a real-time, **Tautulli-inspired** visual monitoring grid directly at the top of the native Jellyfin Admin Dashboard (`/dashboard.html`).

Operating strictly in-memory and transiently, it writes zero data to disk or databases and relies entirely on Jellyfin's native `ApiClient.getSessions()` polling engine.

---

## Features

- **Tautulli-Inspired Telemetry Card Matrix**:
  - **Product / Player**: Client app (`session.Client`) and device name (`session.DeviceName`) with client-specific SVG platform icons (Android, Safari/Apple, FireTV/Roku, Web).
  - **Quality & Bandwidth**: Real-time bitrate formatted in `Mbps` or `kbps` with LAN/WAN lock indicators.
  - **Color-Coded Stream Method**:
    - <span style="color:#2ecc71;font-weight:bold;">Direct Play</span> (Green `#2ecc71`)
    - <span style="color:#3498db;font-weight:bold;">Direct Stream</span> (Blue `#3498db`)
    - <span style="color:#e74c3c;font-weight:bold;">Transcode</span> (Amber/Red `#e74c3c`, with throttle status)
  - **Transcode Reason Badges**: Parses and cleanly formats reason flags (e.g., `Container Not Supported`, `Video Bitrate Limit Exceeded`, `Audio Codec Not Supported`).
  - **Container & Stream Conversion**: Explicit transformation path (e.g. `Converting (MKV → MP4)`).
  - **Audio & Video Streams**: Real-time breakdown of source and target codecs, resolutions, channels, and languages (e.g. `Transcode (ENG - AAC 5.1 → AAC Stereo)`).
  - **Floating ETA & Progress**: Tabular timestamp (`M:SS / H:MM:SS`) and dynamically calculated expected completion time (`ETA: HH:MM`).
- **Liquid Glass Aesthetic**:
  - Semi-translucent dark panes with `backdrop-filter: blur(16px) saturate(180%)`.
  - Subtle borders (`rgba(255, 255, 255, 0.08)`) and ambient glow shadows.
  - Seam progress bar running across the card with neon cyan accent (`#00a4dc`).
- **Activity Summary Banner**:
  - Live pulse indicator showing total active streams, breakdown of direct plays/streams vs transcodes, and aggregate bandwidth.
- **Defensive Engineering & Zero Memory Leaks**:
  - Hooks directly into Jellyfin Web's Single Page Application (SPA) view lifecycle (`viewshow`, `viewhide`, `viewdestroy`).
  - Safe 3-second polling interval that automatically clears when leaving the dashboard.
  - State hashing prevents unnecessary DOM repaints and preserves the administrator's scroll position.

---

## Project Structure

```
├── JellyfinPlaybackCard.csproj   # .NET 8 SDK project file with embedded web resources
├── Plugin.cs                     # Plugin entry point implementing IHasWebPages
├── PluginConfiguration.cs        # Parameter configuration inheriting BasePluginConfiguration
├── plugin.json                   # Jellyfin catalog manifest
├── Web/
│   └── playbackcard.js           # Client-side telemetry engine, styles, & DOM renderer
├── LICENSE                       # MIT License
└── README.md                     # Documentation & setup guide
```

---

## Building and Installation

### Prerequisites
- [.NET 8.0 SDK](https://dotnet.microsoft.com/download/dotnet/8.0)
- Jellyfin Media Server 10.9+ or v12+

### Build from Source
```bash
# Clone the repository
git clone https://github.com/Ubaidofficial/jellyfin-plugin-playbackcard.git
cd jellyfin-plugin-playbackcard

# Compile in Release configuration
dotnet build -c Release
```

### Manual Installation
1. Locate your Jellyfin server's `plugins` directory (e.g., `/var/lib/jellyfin/plugins` on Linux, or `%ProgramData%\Jellyfin\Server\plugins` on Windows).
2. Create a folder named `PlaybackCard`:
   ```bash
   mkdir -p /var/lib/jellyfin/plugins/PlaybackCard
   ```
3. Copy the compiled DLL into the directory:
   ```bash
   cp bin/Release/net8.0/Jellyfin.Plugin.PlaybackCard.dll /var/lib/jellyfin/plugins/PlaybackCard/
   ```
4. Restart your Jellyfin server.
5. Log into the Jellyfin Web UI with an administrator account and navigate to **Dashboard** (`/dashboard.html`). The live monitoring grid will appear at the very top of your dashboard.

---

## Compatibility Note (Jellyfin vs. Emby vs. Plex)

- **Jellyfin**: Fully supported natively via this plugin assembly (`IHasWebPages`).
- **Emby**: While Emby shares historical roots with Jellyfin, Emby uses a proprietary, closed-source SDK and separate plugin signing requirements. The vanilla JavaScript engine (`Web/playbackcard.js`) can be adapted as a userscript or custom web include.
- **Plex**: Plex Web is a closed React application that does not support C# server plugins or native dashboard script injection. To monitor Plex streams, users typically use [Tautulli](https://tautulli.com) directly.

---

## License

This project is licensed under the [MIT License](LICENSE).
