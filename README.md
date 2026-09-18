<img src="banner.png" alt="PlayInfo - real-time Jellyfin playback telemetry" width="500">

*(formerly "Playback Info Card")*

![PlayInfo Now Playing grid showing active sessions with live transcode telemetry](screenshots/dashboard-desktop.png)

A Now Playing monitor for Jellyfin: a live grid of active streams — play state, resolution, HDR, codecs, hardware transcode engine — read straight from what Jellyfin reports, never guessed. Optional native Discord/Telegram notifications for playback events. No analytics, no external calls, no telemetry.

Last tagged release: **v0.2.7.1** — [changelog](https://github.com/Ubaidofficial/Playback-info-card/releases).

## Where to find it

**Dashboard → Now Playing** replaces the stock Devices widget automatically, with Connected Devices restyled to match. **Dashboard → Server → PlayInfo** is the same session grid as a dedicated view — admins see every session, everyone else sees only their own, decided by role, one sidebar entry for both.

## Features

- Compact/extended/show-details modes, summary strip with a real Direct vs. Transcode split.
- Full telemetry: resolution, HDR, codecs, bit depth, channels, subtitles, framerate, bitrate — visible in Compact mode too, not locked behind Extended.
- A completion ring on the poster and real elapsed watch time next to ETA, so progress reads at a glance.
- Transcode diagnostics (hardware engine, container, reason) sourced only from what the server actually reports — never fabricated — shown as a highlighted callout instead of buried in a field list.
- Show Details groups everything into Playback/Video/Audio/Stream/Subtitles sections, and each card's panel expands and collapses independently of the others.
- ETA, Atmos/DTS:X detection, audio language, subtitle delivery method.
- ~35 brand-accurate inline client/OS logos (browsers, native apps, TVs, consoles — no CDN).
- **Tautulli-style card**: poster art bleeds flush to the card's edge and spans its full height, with a vivid blurred backdrop and a colored status ring (green/blue/purple/red) matching the session's real playback method — a grid of sessions reads at a glance.
- **Admin session controls**: send an on-screen message or stop a session's playback directly from the card, via Jellyfin's own Session API. Admin-only, and Stop always confirms first.

![PlayInfo Extended mode with the full technical stream breakdown](screenshots/dashboard-extended.png)

## Installation

**Catalog (recommended):** Dashboard → Plugins → Repositories → add `https://raw.githubusercontent.com/Ubaidofficial/Playback-info-card/main/manifest.json` → Catalog → install **PlayInfo** → restart Jellyfin.

**Manual:** download the zip from the [latest release](https://github.com/Ubaidofficial/Playback-info-card/releases/latest), extract into `plugins/PlaybackCard/`, restart.

Platform paths, Docker/reverse-proxy notes, and rollback steps: [docs/ADVANCED.md](docs/ADVANCED.md).

### Building from Source

To build and install directly from source instead of the catalog or a release zip:

```bash
git clone https://github.com/Ubaidofficial/Playback-info-card.git
cd Playback-info-card
dotnet build -c Release
```

The Web assets (`Web/dashboard.js`, `Web/dashboard.css`, `Web/playbackcard.html`) are compiled directly into the DLL as embedded resources — nothing else to copy. Take `bin/Release/net8.0/Jellyfin.Plugin.PlaybackCard.dll` and this repo's `plugin.json`, drop them into your `plugins/PlaybackCard/` directory as in Manual install above, and restart Jellyfin. The plugin GUID and assembly name never change between releases, so this safely replaces an existing install rather than creating a duplicate.

## Notifications (Discord & Telegram)

Configure from the PlayInfo page (**Playback Notifications**, admins only) — no external plugin needed. Flipping a switch or hitting Save applies it immediately; Test stays disabled until there's actually something to test against. Usernames/device names are off by default; Discord mentions are disabled; Telegram output is HTML-escaped. Bot/webhook setup steps: [docs/ADVANCED.md](docs/ADVANCED.md).

## Privacy & security

Runs only against your own server. The diagnostics panel redacts anything sensitive before you can copy it, and Discord/Telegram secrets are encrypted at rest. Full policy and how to report a vulnerability: [SECURITY.md](SECURITY.md).

Every push and every release build runs through [CodeQL](https://github.com/Ubaidofficial/Playback-info-card/security/code-scanning) (static security analysis, C# and JS) and a ClamAV antivirus scan before the zip is published — both are part of the public [build workflow](.github/workflows/build.yml), not something run privately and taken on faith. Each release also ships a `SHA256SUMS.txt`/`MD5SUMS.txt` alongside the zip so you can verify the download yourself; `manifest.json`'s checksums are cross-checked against these before being published.

## Known limitations

Native apps report sessions into the grid but don't render this plugin's own UI (web-dashboard only). Device names are whatever the client self-reports.

## How this is built

One-person side project. I use Claude Code for a meaningful share of the implementation and review, but every change is my own requirement, gets read by me, and is tested against a real Jellyfin server before it ships — nothing goes out on AI output alone. If you're wondering whether that means this plugin could do something sketchy to your server: no differently than any other open-source plugin — the source is all here to read, the [build is public](.github/workflows/build.yml), and the security scanning described above runs on every release, not just the ones I remember to check by hand.

## License

[GNU General Public License v3.0](LICENSE) — same as [Tautulli](https://github.com/Tautulli/Tautulli), this project's inspiration.
