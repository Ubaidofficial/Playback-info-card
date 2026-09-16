---
name: "5. Mobile or Responsive Layout Issue"
about: "Report a layout distortion, badge overflow, or viewport problem on mobile or narrow screens."
title: "[Layout Issue]: "
labels: ["bug", "responsive", "ui"]
---

> [!WARNING]
> **PRIVACY WARNING**:
> Never include IP addresses, API keys, access tokens, passwords, cookies, private file paths, usernames, or sensitive media titles.
> Use the **"Copy diagnostic report"** button on the Playback Monitor page for safe, redacted diagnostic output.

### Environment Details
- **Plugin Version**: 0.2.3.1
- **Jellyfin Server Version**:
- **Device Model**: (e.g., iPhone 15, Pixel 8, iPad Air, Android Tablet)
- **Viewport Width / Screen Resolution**: (e.g., 390px, 412px, 768px)
- **Browser / Client**: (e.g., Mobile Safari, Chrome Mobile, Firefox Mobile)

### Density Mode
- [ ] Compact Mode (Default)
- [ ] Extended Mode

### Exact Steps to Reproduce
1. Open Jellyfin Web on a mobile device or narrow browser window.
2. Navigate to Playback Monitor.
3. Observe session cards and header controls.

### Expected Result
Session cards should adapt gracefully to single column, badges should wrap cleanly without overflowing or causing horizontal scrolling.

### Actual Result
Describe the layout problem (e.g., badges overlapping, text cut off, horizontal scrollbar appearing, button misalignment).

### Redacted Diagnostic Report
```json
<!-- Paste the output from the "Copy diagnostic report" button here -->
```

### Screenshots
Attach a screenshot or screen recording illustrating the responsive layout defect.

### Privacy Confirmation
- [ ] I confirm that I have reviewed this report and removed all sensitive data, IP addresses, tokens, passwords, cookies, file paths, private usernames, and media titles.
