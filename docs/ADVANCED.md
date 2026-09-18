# Advanced setup, deployment, and troubleshooting

Details that most installs don't need day to day. See the [README](../README.md) for the basics.

## Deployment notes by platform

**Linux (systemd)**
```bash
sudo chown -R jellyfin:jellyfin /var/lib/jellyfin/plugins/PlaybackCard
sudo chmod 644 /var/lib/jellyfin/plugins/PlaybackCard/*
sudo systemctl restart jellyfin
```

**Docker**
Mount your plugins directory into the container as usual, place the extracted files in `<host-plugins-dir>/PlaybackCard/`, and `docker restart jellyfin`.

**Windows**
Make sure the Jellyfin service account can read `%ProgramData%\Jellyfin\Server\plugins\PlaybackCard`, then restart the Jellyfin Server service.

**Reverse proxies / custom base paths**
The page resolves URLs through Jellyfin's own `ApiClient.getUrl()`, so it works behind a sub-path (`/jellyfin`, `/media`, etc.) with no special rewrite rules. Standard Jellyfin proxy config (WebSocket + HTTP passthrough) is enough — just don't cache `/Sessions` or `/web/configurationpage` responses.

## Rollback

Every release ever published stays on [GitHub Releases](https://github.com/Ubaidofficial/Playback-info-card/releases) — the catalog (`manifest.json`) only surfaces the 5 most recent for the in-app updater, nothing is ever deleted.

```bash
sudo systemctl stop jellyfin
curl -L -O https://github.com/Ubaidofficial/Playback-info-card/releases/download/vX.Y.Z.W/jellyfin-plugin-playbackcard.zip
unzip -o jellyfin-plugin-playbackcard.zip -d /var/lib/jellyfin/plugins/PlaybackCard/
sudo systemctl start jellyfin
```

## Duplicate/stale plugin version folders

Jellyfin's plugin loader is supposed to keep only the newest installed version of a plugin on disk, but this hasn't always happened reliably in practice (see [jellyfin/jellyfin#12959](https://github.com/jellyfin/jellyfin/issues/12959)) — an update can leave an old `PlayInfo_x.y.z.w` folder sitting next to the new one in your `plugins` directory, and Jellyfin can end up loading the older one. When that happens, fixes from newer releases silently don't apply — nothing crashes or errors, features just quietly stop working as if the update never happened.

This plugin checks for that condition itself:
- At every startup it looks for older sibling `PlayInfo_*` folders next to the build that's actually running and logs a warning if it finds any.
- If any are found, the plugin's own dashboard (System Diagnostics section) shows a banner naming them, with a **Remove** button per folder.

Removal is always an explicit, one-click, admin-confirmed action — never automatic — and it refuses to run unless it can positively confirm the target folder belongs to this plugin and is strictly older than the version currently running. If you ever see this banner, it's worth deleting the older folder and restarting to confirm the "Loaded assembly" line in your server log now points at the version you expect.

## Compatibility

- Built against Jellyfin 10.9.11 (`Jellyfin.Controller` / `Jellyfin.Model`), targeting `.NET 8.0`, ABI `10.9.0.0`.
- Aimed at the 10.9.x server line. It isn't tested against every Jellyfin version or deployment type, so treat anything outside that as unverified until you've checked it on your own server.
- Native apps (Android TV, Apple TV, Roku, iOS, Infuse, Moonfin, Jellyfin Enhanced, etc.) report their sessions to the server and appear in the grid, but none of them render this plugin's own web page — that only runs in Jellyfin Web.
- The monitor never tries to guess Wi-Fi/Ethernet/cellular — Jellyfin doesn't reliably expose that, and network fingerprinting isn't something this plugin does.

## Notification delivery details

- Discord and Telegram each get their own in-memory queue (capacity 100), with 20 slots reserved so start/stop/completion events can't be starved by a burst of progress updates.
- Repeated progress updates for the same session replace the previous pending one in the queue rather than piling up.
- HTTP 429s are honored via Discord's `Retry-After` / Telegram's `retry_after`. Transient errors (5xx, timeouts) retry up to 3 times with backoff and jitter; permanent client errors (400/401/403/404) fail immediately.
- On server shutdown, queues get a 3-second drain budget to flush what they can without delaying shutdown.

## Telegram bot setup

1. Message [@BotFather](https://t.me/botfather) on Telegram, send `/newbot`, and follow the prompts to get a bot token (`123456789:ABCdefGhIjKlMnOpQrStUvWxYz`).
2. Create a channel or group for alerts and add the bot as an admin.
3. Get the chat ID via `@userinfobot`, `@get_id_bot`, or `https://api.telegram.org/bot<TOKEN>/getUpdates`.
4. Paste the token and chat ID into the plugin's notification settings, enable Telegram delivery, and save.

## Discord webhook setup

1. Server Settings → Integrations → Webhooks → New Webhook, pick a channel.
2. Copy the webhook URL (`https://discord.com/api/webhooks/...`).
3. Paste it into the plugin's notification settings, enable Discord delivery, and save.

## Using the upstream Jellyfin Webhook plugin instead

If you'd rather use the generic [jellyfin-plugin-webhook](https://github.com/jellyfin/jellyfin-plugin-webhook) than this plugin's built-in sender, one thing to watch for:

> [!CAUTION]
> The official sample `PlaybackStart.handlebars` template includes `{{RemoteEndPoint}}`, which puts internal/client IP addresses straight into your chat. Use IP-safe templates like the ones below instead.

**Telegram**
```json
{
  "chat_id": "YOUR_CHAT_ID",
  "text": "🎬 <b>Playback Started</b>\n\n<b>Title:</b> {{#if_equals ItemType 'Episode'}}<b>{{SeriesName}}</b> — S{{SeasonNumber00}}E{{EpisodeNumber00}} {{Name}}{{else}}<b>{{Name}}</b> ({{Year}}){{/if_equals}}\n<b>User:</b> {{NotificationUsername}}\n<b>Client:</b> {{ClientName}} ({{DeviceName}})\n<b>Play Method:</b> {{PlayMethod}}\n<b>Video:</b> {{Video_0_Codec}} {{Video_0_Width}}x{{Video_0_Height}}\n<b>Audio:</b> {{Audio_0_Codec}} ({{Audio_0_Channels}}ch)",
  "parse_mode": "HTML",
  "protect_content": true,
  "disable_web_page_preview": true
}
```

**Discord**
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
      "footer": { "text": "PlayInfo • Privacy Safe" },
      "timestamp": "{{UtcTimestamp}}"
    }
  ]
}
```
