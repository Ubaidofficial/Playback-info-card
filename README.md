# Playback Info Card for Jellyfin

A Now Playing monitor for Jellyfin. It replaces the stock Devices widget on the admin Dashboard with a live grid of active streams — play state, resolution, HDR, codecs, audio, subtitles, and (when the server is transcoding) the actual hardware engine and reason, taken straight from what Jellyfin reports rather than guessed. There's also an optional native Discord/Telegram notifier for playback events.

Latest release: **v0.2.5.3** — see the [changelog](https://github.com/Ubaidofficial/Playback-info-card/releases) for what changed.

## Where to find it

Two places, one page:

- **Dashboard → the Now Playing grid** replaces the stock Devices widget automatically, no configuration needed.
- **Dashboard → Server → Playback Monitor** is the same page as a dedicated view. Admins see every active session; everyone else sees only their own — the page decides which by role, so there's a single sidebar entry instead of two separate pages for admins and regular users.

## Features

- Compact and extended display modes, with a summary strip showing total streams and a real Direct/Transcode split.
- Full stream telemetry: playback state, resolution, dynamic range (HDR/HDR10+/Dolby Vision), video/audio codecs, bit depth, channel layout, subtitles, framerate, and bitrate.
- Transcode diagnostics that only show what the server actually reports — hardware engine (QSV/NVENC/VAAPI/AMF/VideoToolbox), container conversion, and transcode reason. No fabricated values, and it rejects obviously impossible ones (e.g. a hardware badge on a direct-play stream).
- Estimated time to finish, Atmos/DTS:X detection, audio language, and subtitle delivery method.
- Poster art with a backdrop and hover effects, plus ~25 brand-accurate inline client logos (no CDN, no runtime fetches).
- A single "Info" toggle per card that expands the full field breakdown in place and survives the next poll, instead of closing itself.

## Installation

**Via the plugin catalog (recommended)**
1. Dashboard → Plugins → Repositories → Add repository.
2. Repository URL: `https://raw.githubusercontent.com/Ubaidofficial/Playback-info-card/main/manifest.json`
3. Dashboard → Catalog → find **Playback Info Card** → Install → restart Jellyfin.

**Manually**
Download the zip from the [latest release](https://github.com/Ubaidofficial/Playback-info-card/releases/latest), extract `Jellyfin.Plugin.PlaybackCard.dll` and `plugin.json` into your `plugins/PlaybackCard/` directory, and restart the server.

The catalog only lists the 5 most recent versions; every release ever published stays available on the [Releases page](https://github.com/Ubaidofficial/Playback-info-card/releases). Platform-specific paths, Docker/reverse-proxy notes, and rollback steps are in [docs/ADVANCED.md](docs/ADVANCED.md).

## Playback notifications (Discord & Telegram)

The plugin can post playback start/stop/completion (and optional progress) events directly from the Jellyfin server — no external plugin required.

- Configure it from the Playback Monitor page itself: scroll to **Playback Notifications** (admins only), turn on the master switch, add a Discord webhook and/or Telegram bot token, pick which events to send, and use the built-in test buttons to confirm delivery.
- Usernames and device names are **off by default** — an admin has to explicitly opt in to including them in outgoing messages.
- Discord messages disable `@everyone`/`@here`/role mentions. Telegram messages are HTML-escaped and capped at 4,096 characters.
- Getting a Telegram bot token/chat ID and a Discord webhook URL, plus the full delivery/retry behavior, is covered in [docs/ADVANCED.md](docs/ADVANCED.md).

## Privacy & security

Everything runs against your own Jellyfin server — no analytics, no third-party calls, no telemetry. The diagnostics panel redacts anything sensitive (IPs, tokens, usernames, media titles) before you can copy it. Discord/Telegram secrets are encrypted at rest, separately from the rest of the plugin's config, and masked in the admin UI; see [SECURITY.md](SECURITY.md) for the full policy and how to report a vulnerability.

## Known limitations

- Native apps (Android TV, Apple TV, Roku, etc.) report sessions to the server and show up in the grid, but they don't render this plugin's own UI — it's web-dashboard only.
- Device/client names come from whatever each client self-reports; unrecognized ones show up as a generic label.
- Polling runs every 3 seconds while the page is open and stops when you navigate away.

## How this is built

This is a one-person side project. I use Claude Code for a meaningful share of the implementation, refactoring, and code review — I write the requirements and test every change against a real Jellyfin server before it ships, but you should assume AI tooling touched most commits.

## License

[MIT](LICENSE)
