---
name: "7. Playback Notification Delivery Issue"
about: "Report issues with Discord webhook or Telegram bot playback notifications (delivery failure, formatting, rate limits, or queue stalling)."
title: "[Notification Issue]: "
labels: ["bug", "notifications"]
---

> [!WARNING]
> **CRITICAL PRIVACY WARNING**:
> **NEVER paste Discord webhook URLs, Telegram bot tokens, chat IDs, account passwords, authorization headers, IP addresses, remote endpoints, or local server file paths into this issue.**
> All secrets are sensitive credentials. If you accidentally leak a token or webhook URL, revoke it immediately via Telegram @BotFather or Discord Channel Integrations Settings.
> Use the **"Copy diagnostic report"** button on the Playback Monitor page for safe, redacted diagnostic output.

### Environment Details
- **Plugin Version**:
- **Jellyfin Server Version**:
- **Server Operating System**: (e.g. Ubuntu 24.04, Debian 12, TrueNAS, Windows Server)
- **Installation Method**: (e.g. Method 1 Plugin Repository Manifest, Manual ZIP extraction)
- **Deployment Type**: (e.g. Native bare-metal, Docker, Reverse Proxy / Cloudflare)

### Destination
- [ ] Discord Webhook
- [ ] Telegram Bot

### Failure Category / Symptoms
- [ ] Notification not dispatched on Start
- [ ] Notification not dispatched on Stop / Completion
- [ ] Notification not dispatched on Pause / Resume
- [ ] Progress notifications failing or dropping
- [ ] Test notification fails
- [ ] Rate limited (HTTP 429)
- [ ] Authentication / Secret rejection (HTTP 401 / 403 / 404)
- [ ] Server timeout (HTTP 5xx / 504)
- [ ] Formatting or HTML tag corruption

### Delivery Health Telemetry (from Monitor Page)
- **Discord Status**: (e.g. Configured, Disabled, Error)
- **Telegram Status**: (e.g. Configured, Disabled, Error)
- **Last Failure Category**: (e.g. OK, RateLimited, ServerError, InvalidConfiguration)
- **Dropped Progress Count**:
- **Deduplicated Events Count**:
- **Retry Count**:

### Exact Steps to Reproduce
1. Configure notification destination in Playback Monitor settings.
2. Trigger playback event on client.
3. Observe delivery failure or check Delivery Health Telemetry.

### Expected Result
Describe what notification should have been delivered.

### Actual Result
Describe what occurred instead (e.g. delivery timed out, error badge appeared, test button reported HTTP 403).

### Redacted Diagnostic Report
```json
<!-- Paste the output from the "Copy diagnostic report" button on the Playback Monitor page here -->
```

### Privacy Confirmation
- [ ] I confirm that I have reviewed this report and removed all sensitive data, Discord webhook tokens, Telegram bot tokens, chat IDs, IP addresses, tokens, passwords, cookies, file paths, private usernames, and media titles.
