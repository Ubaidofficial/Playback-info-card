# Security Policy & Trust Model

The **Playback Info Card** team is committed to the highest standards of security, privacy, and transparency for homelab and media server administrators. We recognize that self-hosters place immense trust in the software they install on their servers.

---

## 🤖 AI-Assisted Development Disclosure

This project was developed with the assistance of modern AI engineering tools to accelerate UI CSS styling, embedded SVG vector assets, and telemetry parsing logic.

### How We Ensure Code Safety & Integrity
We treat all generated code with zero-trust skepticism:
1. **Human Architectural Review**: Every single line of C# and JavaScript is reviewed, tested, and defensively hardened by human developers.
2. **Minimal & Inspectable Footprint**: The entire plugin contains only two lightweight source files:
   - `Plugin.cs` (~70 lines of standard C# implementing Jellyfin's `IHasWebPages` to serve embedded assets).
   - `Web/playbackcard.js` (Vanilla JavaScript with **zero npm dependencies**, zero external script tags, and zero obfuscation).
   - Anyone can read the entire codebase in under 5 minutes.
3. **Automated QA Verification**: The codebase is covered by an automated test suite verifying DOM generation, sanitization, and state logic.

---

## 🛡️ Core Security Guarantees

### 1. 100% Air-Gapped & Zero Telemetry
- **No External Network Calls**: The plugin contains zero `fetch()`, `XMLHttpRequest`, `<script src="...">`, or WebSocket connections to third-party servers.
- **No Analytics / No Tracking**: There are no telemetry pings, phone-home beacons, or usage statistics collected.
- **Local API Only**: Telemetry queries are routed exclusively to the local Jellyfin server via its authenticated `ApiClient`.

### 2. Zero Host Disk & Database Footprint
- The plugin does not perform arbitrary disk reads or writes.
- It does not alter Jellyfin database schemas or run server shell commands.
- All telemetry is transient and stored strictly in browser memory while the admin dashboard is actively viewed.

### 3. Strict Input Sanitization & XSS Defense
- All session data (usernames, media titles, client names, file paths) is escaped with strict HTML entity encoding (`escapeHtml`) before insertion into the DOM.
- Inline CSS values (such as custom accent colors and art URLs) are sanitized and validated against strict allowlists to prevent CSS breakout or injection.
- Endpoint parameters are URL-encoded (`encodeURIComponent`) to prevent path manipulation.

### 4. Continuous Automated Security & Antivirus Scanning
- **ClamAV Antivirus Scanning**: Every build artifact (`.dll` and `.zip`) is automatically scanned for viruses, trojans, and malware in our GitHub Actions pipeline prior to release.
- **GitHub CodeQL Analysis**: Every commit and pull request undergoes automated static application security testing (SAST) for OWASP Top 10 and CWE vulnerabilities across C# and JavaScript.
- **Cryptographic Hashes**: Every GitHub release includes published `SHA256SUMS.txt` and `MD5SUMS.txt` files so server admins can verify file integrity.

---

## 🔍 How to Verify Artifacts Yourself

You do not need to take our word for it:

1. **Verify Checksums**:
   ```bash
   sha256sum -c SHA256SUMS.txt
   ```
2. **Scan with VirusTotal**:
   You can upload `jellyfin-plugin-playbackcard.zip` directly to [VirusTotal](https://www.virustotal.com/) to scan across 70+ antivirus engines.
3. **Inspect the DLL**:
   Because .NET assemblies can be decompiled, you can inspect `Jellyfin.Plugin.PlaybackCard.dll` using open-source tools like [ILSpy](https://github.com/icsharpcode/ILSpy) or [dnSpy](https://github.com/dnSpy/dnSpy) to verify that it only contains embedded web resources.

---

## 🚨 Reporting a Vulnerability

If you discover a security vulnerability in this project:

1. **Do not** report security issues in public GitHub issues or forums.
2. Please use GitHub's **[Private Vulnerability Reporting](https://github.com/Ubaidofficial/Playback-info-card/security/advisories/new)** feature.
3. We will acknowledge receipt within 24 hours, provide an assessment, and publish a patched release promptly.
