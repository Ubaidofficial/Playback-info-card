---
name: "3. Sessions or Polling Failure"
about: "Report an issue where active playback sessions fail to appear, polling stalls, or Sessions API returns errors."
title: "[Polling Failure]: "
labels: ["bug", "polling"]
---

> [!WARNING]
> **PRIVACY WARNING**:
> Never include IP addresses, API keys, access tokens, passwords, cookies, private file paths, usernames, or sensitive media titles.
> Use the **"Copy diagnostic report"** button on the Playback Monitor page for safe, redacted diagnostic output.

### Environment Details
- **Plugin Version**:
- **Jellyfin Server Version**:
- **Server Operating System**:
- **Installation Method**:
- **Browser / Client**:

### Exact Steps to Reproduce
1. Start playing media on a Jellyfin client.
2. Open Playback Monitor in Jellyfin Web.
3. Observe session status message and diagnostics card.

### Expected Result
Active playback sessions should be polled every 3 seconds and displayed in real-time.

### Actual Result
Describe the failure (e.g., "Sessions unavailable", "Polling stalled", status message shows error, or sessions don't refresh).

### Redacted Diagnostic Report
```json
<!-- Paste the output from the "Copy diagnostic report" button here -->
```

### Screenshots
If applicable, attach screenshots showing the monitor state and diagnostics grid.

### Privacy Confirmation
- [ ] I confirm that I have reviewed this report and removed all sensitive data, IP addresses, tokens, passwords, cookies, file paths, private usernames, and media titles.
