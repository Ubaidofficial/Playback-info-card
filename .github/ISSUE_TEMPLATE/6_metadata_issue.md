---
name: "6. Incorrect or Missing Playback Metadata"
about: "Report incorrect, missing, or mislabeled stream badges, audio channels, transcode reasons, or subtitles."
title: "[Metadata Issue]: "
labels: ["bug", "metadata"]
---

> [!WARNING]
> **PRIVACY WARNING**:
> Never include IP addresses, API keys, access tokens, passwords, cookies, private file paths, usernames, or sensitive media titles.
> Use the **"Copy diagnostic report"** button on the Playback Monitor page for safe, redacted diagnostic output.

### Environment Details
- **Plugin Version**: 0.2.3.1
- **Jellyfin Server Version**:
- **Server Operating System**:
- **Installation Method**: (e.g., Method 1 Plugin Repository Manifest, Manual ZIP extraction)
- **Browser / Client**: (e.g., Jellyfin Web / Chrome, Jellyfin Android TV 0.16.11, Moonfin, Infuse 7.7)

### Playback Type
- [ ] Direct Play
- [ ] Direct Stream
- [ ] Remux
- [ ] Transcode

### Stream Characteristics (Sanitized)
- **Container**: (e.g., MKV, MP4, WebM)
- **Video Codec**: (e.g., HEVC / H.265, H.264, AV1, VP9)
- **Dynamic Range**: (e.g., SDR, HDR10, HDR10+, Dolby Vision)
- **Audio Channels / Codec**: (e.g., 7.1 TrueHD, 5.1 EAC3, Stereo AAC)
- **Active Subtitle**: (e.g., English SRT, French ASS, Closed Captions)

### Exact Steps to Reproduce
1. Start playback on the client app.
2. Open Jellyfin Web as administrator and navigate to Playback Monitor.
3. Observe the reported metadata badges on the session card.

### Expected Result
What badges, codecs, or details should be shown?

### Actual Result
What does the monitor card show instead? (e.g., shows Stereo instead of 5.1, transcode reason missing, subtitle badge absent)

### Redacted Diagnostic Report
```json
<!-- Paste the output from the "Copy diagnostic report" button here -->
```

### Privacy Confirmation
- [ ] I confirm that I have reviewed this report and removed all sensitive data, IP addresses, tokens, passwords, cookies, file paths, private usernames, and media titles.
