---
name: "4. Artwork Failure"
about: "Report an issue where posters or blurred backdrop artwork fail to load or display error fallbacks unexpectedly."
title: "[Artwork Failure]: "
labels: ["bug", "artwork"]
---

> [!WARNING]
> **PRIVACY WARNING**:
> Never include IP addresses, API keys, access tokens, passwords, cookies, private file paths, usernames, or sensitive media titles.
> Use the **"Copy diagnostic report"** button on the Playback Monitor page for safe, redacted diagnostic output.

### Environment Details
- **Plugin Version**: 0.2.3.1
- **Jellyfin Server Version**:
- **Server Operating System**:
- **Installation Method**:
- **Browser / Client**:

### Exact Steps to Reproduce
1. Start playing an item that has poster and backdrop artwork in Jellyfin library.
2. Open Playback Monitor in Jellyfin Web.
3. Observe poster display and diagnostics Artwork Status counter.

### Expected Result
Poster image and subtle blurred backdrop should load smoothly; Artwork Status should increment "Loaded".

### Actual Result
Poster fails to load, shows fallback placeholder, or diagnostics Artwork Status shows errors.

### Redacted Diagnostic Report
```json
<!-- Paste the output from the "Copy diagnostic report" button here -->
```

### Media Type & Library Information (Sanitized)
- Media Type: (e.g., Movie, TV Episode, Music)
- Image Format: (e.g., JPEG, PNG, WebP)
*(Do not include media titles or file paths!)*

### Screenshots
If applicable, attach a screenshot of the card showing the artwork placeholder.

### Privacy Confirmation
- [ ] I confirm that I have reviewed this report and removed all sensitive data, IP addresses, tokens, passwords, cookies, file paths, private usernames, and media titles.
