# Security & Privacy Policy

## Core Implementation Guarantees (v0.2.3.1)

* **100% Air-Gapped & Zero External Telemetry**: The plugin executes entirely locally within the browser. It initiates no third-party network requests, contains zero analytics, tracking beacons, or Sentry error reporters, and loads no remote fonts, scripts, or stylesheets.
* **No Host or Pipeline Modification**: Version `0.2.3.1` completely removes ASP.NET Core middleware, response-stream HTML injection, startup filters (`IStartupFilter`), and disk writes. The plugin is registered strictly through Jellyfin's standard `IHasWebPages` interface.
* **No Network Classification or IP Harvesting**: The monitor does not log, parse, or classify client IP addresses, `RemoteEndPoint`, or LAN/WAN/Cellular/Wi-Fi states.
* **Strict Privacy Redaction Checks**: The diagnostic report tool scans all output against sensitive parameter patterns (passwords, tokens, cookies, usernames, media titles, IP patterns) and blocks clipboard export if any sensitive metadata is detected.
* **XSS Defense & Output Sanitization**: All session strings (usernames, client names, devices, titles, transcode reasons) are escaped with strict HTML entity encoding prior to DOM insertion.
* **Defensive Error Boundaries**: Individual session render failures are caught in isolated error boundaries to prevent crashing the view or leaking unhandled exceptions.

## Reporting a Vulnerability

If you discover a potential security vulnerability in this project:

1. Please **do not** open a public GitHub issue.
2. Submit your report through GitHub's [Private Vulnerability Reporting](https://github.com/Ubaidofficial/Playback-info-card/security/advisories/new).
3. We will review and acknowledge within 48 hours and coordinate a patched release promptly.
