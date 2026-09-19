<img src="banner.png" alt="PlayInfo, real-time Jellyfin playback telemetry" width="500">

*(formerly "Playback Info Card")*

[![Latest Release](https://img.shields.io/github/v/release/Ubaidofficial/Playback-info-card?label=release)](https://github.com/Ubaidofficial/Playback-info-card/releases/latest)
[![Build](https://github.com/Ubaidofficial/Playback-info-card/actions/workflows/build.yml/badge.svg)](https://github.com/Ubaidofficial/Playback-info-card/actions/workflows/build.yml)
[![License: GPL v3](https://img.shields.io/badge/license-GPLv3-blue.svg)](LICENSE)

![PlayInfo Now Playing grid showing active sessions with live transcode telemetry](screenshots/dashboard-desktop.png)

A Now Playing monitor for Jellyfin. It shows a live grid of active streams, play state, resolution, HDR, codecs, and hardware transcode engine, all read straight from what Jellyfin reports. Optional Discord and Telegram notifications for playback events. No analytics, no external calls, no telemetry.

## Installation

**Catalog (recommended)**
1. Dashboard → Plugins → Repositories → Add Repository
2. Repository URL: `https://raw.githubusercontent.com/Ubaidofficial/Playback-info-card/main/manifest.json`
3. Dashboard → Plugins → Catalog → install **PlayInfo**
4. Restart Jellyfin

**Manual**
1. Download the zip from the [latest release](https://github.com/Ubaidofficial/Playback-info-card/releases/latest)
2. Extract into `plugins/PlaybackCard/`
3. Restart Jellyfin

**From source**
```bash
git clone https://github.com/Ubaidofficial/Playback-info-card.git
cd Playback-info-card
dotnet build -c Release
```
Copy `bin/Release/net8.0/Jellyfin.Plugin.PlaybackCard.dll` and `plugin.json` into `plugins/PlaybackCard/`, then restart Jellyfin. The GUID and assembly name stay the same every release, so this replaces an existing install instead of duplicating it.

Docker, reverse proxies, and rollback steps are in [docs/ADVANCED.md](docs/ADVANCED.md).

## Where to find it

- **Dashboard → Now Playing**: replaces the stock Devices widget automatically
- **Dashboard → Server → PlayInfo**: the same session grid as its own page. Admins see every session, everyone else sees only their own

## Features

- Compact, Extended, and Show Details view modes
- A summary strip with a real Direct vs. Transcode split, plus a live bandwidth gauge (total outbound bitrate, split by Local Network vs. Remote when that's enabled, with an optional upload capacity percentage)
- Full telemetry in Compact mode too: resolution, HDR, codecs, bit depth, channels, subtitles, framerate, bitrate
- A completion ring on the poster, with elapsed watch time next to the ETA
- Transcode diagnostics (hardware engine, container, reason) straight from the server, shown as a highlighted callout
- Show Details grouped into Playback, Video, Audio, Stream, and Subtitles sections, each card expands on its own
- ETA, Atmos/DTS:X detection, audio language, and subtitle delivery method. Language codes on subtitles and audio expand to their full name on hover
- A warning on streams paused for a while, and a badge when one account has more than one stream running at once
- Around 35 brand accurate client and OS logos, all bundled locally, no CDN
- Tautulli style cards, with full height poster art, a blurred backdrop, and a status ring colored by playback method
- Admin controls to message or stop a session right from the card, using Jellyfin's own Session API (stopping always asks you to confirm first)
- A "Copy Report" button on each session's Info panel that builds a sanitized technical summary (no username, device, or IP) you can paste into a forum post or GitHub issue
- A Recent Sessions shelf, a short in-memory history of what finished playing. Cleared on restart, no database involved

![PlayInfo Extended mode with the full technical stream breakdown](screenshots/dashboard-extended.png)

## Notifications (Discord & Telegram)

Configure this from the PlayInfo page under Playback Notifications (admins only). Toggles and Save apply immediately.

- Usernames and device names are off by default
- Discord mentions are disabled
- Telegram output is HTML escaped
- Poster art gets attached to the notification itself, uploaded with the message rather than linked back to your server. It's on by default, but you can turn it off

Bot and webhook setup steps are in [docs/ADVANCED.md](docs/ADVANCED.md).

## Privacy & security

- Runs only against your own server
- The diagnostics panel redacts anything sensitive before you're able to copy it
- Discord and Telegram secrets are encrypted at rest
- Every push and release build runs through [CodeQL](https://github.com/Ubaidofficial/Playback-info-card/security/code-scanning) and a ClamAV scan. See the [build workflow](.github/workflows/build.yml) for the details
- Every release ships `SHA256SUMS.txt` and `MD5SUMS.txt` so you can verify the download yourself

The full policy, and how to report a vulnerability, is in [SECURITY.md](SECURITY.md).

## Known limitations

- Native apps show up in the session grid, but they don't render this plugin's own UI. It only works in the web dashboard
- Device names are whatever the client reports

## How this is built

One person project. I use Claude Code for a chunk of the implementation, but I write the requirements, review the changes, and test against a real Jellyfin server before anything ships.

## License

[GNU General Public License v3.0](LICENSE)
