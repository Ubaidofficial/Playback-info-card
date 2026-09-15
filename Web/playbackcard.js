/**
 * Jellyfin Playback Info Card (Jellyfin.Plugin.PlaybackCard) - v0.1.0
 * 
 * Injects a real-time, Tautulli & Jellywatch-inspired visual monitoring grid directly into
 * the Jellyfin Admin Dashboard (/dashboard.html / .dashboardForm).
 * 
 * Enhanced Features:
 * - Real-time polling of ApiClient.getSessions() every 3 seconds.
 * - Hardware Acceleration Badges (NVENC, QuickSync, VAAPI, VideoToolbox, AMF vs SW Transcode).
 * - Transcode Performance Metrics (Transcode FPS & real-time playback speed multiplier).
 * - Paused Stream Timer (Counts up paused duration to detect resource locks).
 * - Subtitle Burn-In Diagnostic Badges (Identifies forced transcode causes like PGS/VOBSUB).
 * - Interactive Session Controls (Kill Stream, Send Message to Device, Pause/Resume).
 * - Bandwidth Breakdown in Activity Banner (Total Bandwidth, LAN Bandwidth, WAN Upload).
 * - Admin Privacy Mode (1-click toggle to mask IPs and usernames for screenshots/streaming).
 * - Deep-Navigation Links (Click poster/title to open media details, click user for user settings).
 * - Audio/Music Mode support (Artist, Album, Sample Rate, FLAC/MP3).
 * - Strict memory leak prevention with viewshow/viewhide/viewdestroy lifecycle management.
 * - Isolated DOM rendering (zero scroll reset, zero global state mutation).
 * - Liquid Glass aesthetic with backdrop blur, sleek dark translucent panes, and ambient glow.
 */

(function () {
    'use strict';

    // Configuration constants
    const CONFIG = {
        CONTAINER_ID: 'jellyfin-playback-card-container',
        STYLES_ID: 'jellyfin-playback-card-styles',
        POLL_INTERVAL_MS: 3000,
        ACCENT_COLOR: '#00a4dc',
        COLOR_DIRECT_PLAY: '#2ecc71',
        COLOR_DIRECT_STREAM: '#3498db',
        COLOR_TRANSCODE: '#e74c3c',
        COLOR_PAUSED: '#f39c12',
        COLOR_HW: '#bb86fc'
    };

    // State management
    let pollIntervalId = null;
    let liveTickerIntervalId = null;
    let isDashboardActive = false;
    let isFetching = false;
    let lastRenderedHash = '';
    let isPrivacyMode = false;
    let currentFilter = 'all'; // 'all', 'transcode', 'wan', 'paused'
    let currentCardModels = [];
    const sessionPausedTimestamps = new Map(); // sessionId -> timestamp when pause was first detected
    const sessionSlowCycles = new Map(); // sessionId -> consecutive slow (<1.0x) poll cycles
    const autoKillEventsLog = []; // { id, time, userName, title, reason }

    // P1 Rolling Telemetry History
    const MAX_BANDWIDTH_HISTORY = 16;
    const bandwidthHistory = []; // { time, total, wan, lan }

    // Watch Statistics Drawer State
    let showWatchStats = true;
    let cachedWatchStats = null;
    let lastWatchStatsFetchTime = 0;
    let isFetchingWatchStats = false;
    const itemBitrateCache = new Map(); // itemId -> bitrate in bps

    // Placement state: locked to 'replace-devices' in place of default Devices section
    const placementMode = 'replace-devices';
    try {
        localStorage.removeItem('jellyfin_playbackcard_placement');
    } catch (e) {}
    let defaultDevicesElement = null;

    // Smart Stream Guard Rules state (persisted in localStorage)
    const DEFAULT_STREAM_GUARD_RULES = {
        killPausedEnabled: false,
        killPausedMinutes: 15,
        kill4kSwEnabled: false,
        maxConcurrentStreams: 0 // 0 = disabled
    };

    function loadStreamGuardRules() {
        try {
            const saved = localStorage.getItem('playbackcard_stream_guard_rules');
            if (saved) {
                return Object.assign({}, DEFAULT_STREAM_GUARD_RULES, JSON.parse(saved));
            }
        } catch (e) {
            console.warn('[PlaybackCard] Could not load stream guard rules from localStorage', e);
        }
        return Object.assign({}, DEFAULT_STREAM_GUARD_RULES);
    }

    function saveStreamGuardRules(rules) {
        try {
            localStorage.setItem('playbackcard_stream_guard_rules', JSON.stringify(rules));
        } catch (e) {
            console.warn('[PlaybackCard] Could not save stream guard rules to localStorage', e);
        }
    }

    let streamGuardRules = loadStreamGuardRules();

    // P1.5 Transcode Watchdog: Stall & Zombie Tracking
    const sessionLastTicks = new Map(); // sessionId -> last known PositionTicks
    const sessionTranscodeStallCycles = new Map(); // sessionId -> consecutive stalled cycles while transcoding

    // P1.6 Servarr Remediation Configuration (Bazarr, Radarr, Sonarr)
    const DEFAULT_SERVARR_CONFIG = {
        bazarrUrl: '',
        bazarrApiKey: '',
        radarrUrl: '',
        radarrApiKey: '',
        sonarrUrl: '',
        sonarrApiKey: ''
    };

    function loadServarrConfig() {
        try {
            const saved = localStorage.getItem('playbackcard_servarr_config');
            if (saved) {
                return Object.assign({}, DEFAULT_SERVARR_CONFIG, JSON.parse(saved));
            }
        } catch (e) {
            console.warn('[PlaybackCard] Could not load Servarr config from localStorage', e);
        }
        return Object.assign({}, DEFAULT_SERVARR_CONFIG);
    }

    function saveServarrConfig(cfg) {
        try {
            localStorage.setItem('playbackcard_servarr_config', JSON.stringify(cfg));
        } catch (e) {
            console.warn('[PlaybackCard] Could not save Servarr config to localStorage', e);
        }
    }

    let servarrConfig = loadServarrConfig();

    // Stream Doctor: Transcode Reasons & Client Fix Recommendations
    const TRANSCODE_EXPLANATIONS = {
        'ContainerNotSupported': {
            short: 'Container Not Supported',
            detail: 'The file container (e.g. MKV) is not natively supported by this client. Jellyfin is remuxing it to MP4/HLS.',
            advice: 'Use Jellyfin Media Player instead of a web browser for direct container support.'
        },
        'VideoCodecNotSupported': {
            short: 'Video Codec Unsupported',
            detail: 'The video codec (e.g. HEVC/H.265 or AV1) cannot be decoded by this client hardware.',
            advice: 'Use a client app with hardware decoding (Android TV, Apple TV, or Jellyfin Media Player).'
        },
        'AudioCodecNotSupported': {
            short: 'Audio Codec Unsupported',
            detail: 'The audio stream (e.g. TrueHD 7.1 or DTS-HD) is incompatible with client speakers/passthrough.',
            advice: 'Select a secondary stereo or AC3 5.1 audio track in playback settings.'
        },
        'SubtitleCodecNotSupported': {
            short: 'Subtitle Burn-In',
            detail: 'Bitmap subtitles (PGS/VOBSUB) must be burned directly into the video stream by the server GPU/CPU.',
            advice: 'Switch subtitles to a text-based format (SRT) in playback options to allow Direct Play.'
        },
        'VideoBitrateNotSupported': {
            short: 'Bitrate Limit Exceeded',
            detail: 'The stream bitrate exceeds the quality setting chosen by the client or server bandwidth cap.',
            advice: 'Set client playback quality to "Original" or "Maximum" in settings.'
        },
        'VideoResolutionNotSupported': {
            short: 'Resolution Too High',
            detail: 'The display or client player cannot output video at this native resolution.',
            advice: 'Ensure the client device and TV HDMI port support 4K 60Hz.'
        },
        'VideoProfileNotSupported': {
            short: 'Video Profile Unsupported',
            detail: 'The encoding profile (e.g. High 10 or Main 10) is not supported by client decoder.',
            advice: 'Use Jellyfin Media Player or a dedicated streaming device.'
        },
        'SecondaryAudioNotSupported': {
            short: 'Secondary Audio Incompatible',
            detail: 'The selected secondary audio track requires real-time transcoding for this client.',
            advice: 'Switch to the default primary audio track if available.'
        },
        'DirectPlayError': {
            short: 'Direct Play Failed',
            detail: 'The client player threw an error while attempting Direct Play, falling back to server transcode.',
            advice: 'Update the client app to the latest version or restart playback.'
        }
    };

    /**
     * Device Nicknames / Model Aliases (e.g. "iPhone 16 Pro Max", "Living Room Apple TV 4K").
     */
    function getDeviceAliases() {
        try {
            const saved = localStorage.getItem('playbackcard_device_aliases');
            if (saved) return JSON.parse(saved);
        } catch (e) {}
        return {};
    }

    function saveDeviceAlias(key, alias) {
        try {
            const aliases = getDeviceAliases();
            if (alias && alias.trim()) {
                aliases[key] = alias.trim();
            } else {
                delete aliases[key];
            }
            localStorage.setItem('playbackcard_device_aliases', JSON.stringify(aliases));
        } catch (e) {}
    }

    function cleanDeviceName(rawName) {
        if (!rawName) return 'Device';
        let name = rawName.trim();
        // Remove duplicated adjacent words, e.g. "iPhone iPhone" -> "iPhone", "iPad iPad" -> "iPad"
        name = name.replace(/\b([a-zA-Z0-9_-]+)\s+\1\b/gi, '$1');
        return name;
    }

    function resolveDeviceModel(session) {
        if (!session) return 'Device';
        const key = session.DeviceId || session.DeviceName || session.Id;
        const aliases = getDeviceAliases();
        if (aliases[key]) {
            return aliases[key];
        }
        if (session.DeviceName && aliases[session.DeviceName]) {
            return aliases[session.DeviceName];
        }

        // Clean up duplicated names like "iPhone iPhone"
        return cleanDeviceName(session.DeviceName || 'Browser');
    }

    /**
     * Injects custom CSS styling for the Liquid Glass theme and Tautulli/Jellywatch card anatomy.
     */
    function injectStyles() {
        if (document.getElementById(CONFIG.STYLES_ID)) {
            return;
        }

        const styleElement = document.createElement('style');
        styleElement.id = CONFIG.STYLES_ID;
        styleElement.textContent = `
            :root {
                /* Liquid Glass Physics & Elevation Tokens (LiquidGlass-UI, GlinUI, OpenGlass) */
                --lg-ease: cubic-bezier(0.16, 1, 0.3, 1);
                --lg-duration: 0.24s;
                --lg-specular-top: inset 0 1px 0 0 rgba(255, 255, 255, 0.22);
                --lg-specular-left: inset 1px 0 0 0 rgba(255, 255, 255, 0.08);
                --lg-specular-bottom: inset 0 -1px 0 0 rgba(255, 255, 255, 0.03);
                /* Nikdelvin Chromatic Aberration Dispersion Tokens */
                --lg-dispersion-cyan: inset 1px 0 0 0 rgba(56, 189, 248, 0.12);
                --lg-dispersion-magenta: inset -1px 0 0 0 rgba(244, 114, 182, 0.08);
                /* Sanjaynela Apple iOS Lens Refraction Highlight */
                --lg-lens-highlight: radial-gradient(ellipse 70% 50% at 12% 0%, rgba(255, 255, 255, 0.15) 0%, rgba(255, 255, 255, 0) 70%);
                --lg-depth-shadow: 0 24px 52px -8px rgba(0, 0, 0, 0.88), 0 8px 24px -4px rgba(0, 0, 0, 0.6);
                --lg-card-bg: linear-gradient(155deg, rgba(255, 255, 255, 0.045) 0%, rgba(255, 255, 255, 0.015) 50%, rgba(9, 10, 16, 0.94) 100%), #090a10;
                --lg-card-border: 1px solid rgba(255, 255, 255, 0.14);
                --lg-chip-bg: rgba(255, 255, 255, 0.04);
                --lg-chip-border: 1px solid rgba(255, 255, 255, 0.08);
                --lg-control-bg: rgba(255, 255, 255, 0.06);
                --lg-control-border: 1px solid rgba(255, 255, 255, 0.12);
                /* GlassFin (KBH-Reeper) Specular Light Sweep & Accent Tokens */
                --gf-hover-v: linear-gradient(0deg, transparent, rgba(255, 255, 255, 0.08) 45%, rgba(255, 255, 255, 0.16) 50%, rgba(255, 255, 255, 0.08) 55%, transparent);
                --gf-active-accent: rgba(0, 164, 220, 0.85);
            }

            /* Container & Activity Banner */
            #${CONFIG.CONTAINER_ID} {
                width: 100%;
                margin: 22px 0 28px 0;
                padding: 0;
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
                box-sizing: border-box;
                color: #e2e8f0;
                -webkit-font-smoothing: antialiased;
            }

            /* Activity Banner - Void Obsidian & Moonfin Liquid Glass */
            .tautulli-activity-banner {
                display: flex;
                align-items: center;
                justify-content: space-between;
                flex-wrap: wrap;
                gap: 12px;
                padding: 12px 18px;
                margin-bottom: 20px;
                background: linear-gradient(155deg, rgba(255, 255, 255, 0.045) 0%, rgba(255, 255, 255, 0.01) 100%), #0d0f17;
                backdrop-filter: blur(28px) saturate(180%) contrast(105%);
                -webkit-backdrop-filter: blur(28px) saturate(180%) contrast(105%);
                border: 1px solid rgba(255, 255, 255, 0.09);
                border-radius: 14px;
                box-shadow: var(--lg-specular-top), var(--lg-specular-left), 0 8px 32px 0 rgba(0, 0, 0, 0.5);
            }

            .tautulli-activity-left {
                display: flex;
                align-items: center;
                gap: 12px;
                flex-wrap: wrap;
            }

            .tautulli-activity-title {
                display: flex;
                align-items: center;
                gap: 8px;
                font-size: 13px;
                font-weight: 700;
                letter-spacing: 0.08em;
                color: #ffffff;
                text-transform: uppercase;
            }

            .tautulli-activity-pulse {
                width: 8px;
                height: 8px;
                background: ${CONFIG.COLOR_DIRECT_PLAY};
                border-radius: 50%;
                box-shadow: 0 0 10px ${CONFIG.COLOR_DIRECT_PLAY}, 0 0 4px #ffffff;
                animation: tautulli-pulse 2s infinite ease-in-out;
            }

            @keyframes tautulli-pulse {
                0%, 100% { transform: scale(1); opacity: 0.85; }
                50% { transform: scale(1.35); opacity: 1; }
            }

            .tautulli-activity-stats {
                font-size: 12px;
                color: #94a3b8;
                display: flex;
                align-items: center;
                gap: 12px;
                flex-wrap: wrap;
            }

            .tautulli-activity-stat-highlight {
                color: #ffffff;
                font-weight: 600;
            }

            .tautulli-bandwidth-visual {
                display: inline-flex;
                width: 68px;
                height: 6px;
                border-radius: 9999px;
                background: rgba(255, 255, 255, 0.08);
                overflow: hidden;
                vertical-align: middle;
                margin-left: 6px;
                box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.4);
            }

            .tautulli-bandwidth-bar-lan {
                background: linear-gradient(90deg, #10b981, #34d399);
                height: 100%;
                transition: width 0.35s ease;
            }

            .tautulli-bandwidth-bar-wan {
                background: linear-gradient(90deg, #3b82f6, #60a5fa);
                height: 100%;
                transition: width 0.35s ease;
            }

            .tautulli-activity-tools {
                display: flex;
                align-items: center;
                gap: 8px;
            }

            .tautulli-tool-btn {
                background: var(--lg-control-bg);
                border: var(--lg-control-border);
                box-shadow: inset 0 1px 0 0 rgba(255, 255, 255, 0.12);
                color: #cbd5e1;
                border-radius: 8px;
                padding: 5px 11px;
                font-size: 11px;
                cursor: pointer;
                display: flex;
                align-items: center;
                gap: 6px;
                backdrop-filter: blur(14px);
                -webkit-backdrop-filter: blur(14px);
                transition: all var(--lg-duration) var(--lg-ease);
            }

            .tautulli-tool-btn:hover {
                background: rgba(255, 255, 255, 0.15);
                border-color: rgba(255, 255, 255, 0.25);
                color: #ffffff;
                transform: translateY(-1px) scale(1.02);
                box-shadow: inset 0 1px 0 0 rgba(255, 255, 255, 0.2), 0 4px 12px rgba(0, 0, 0, 0.35);
            }

            .tautulli-tool-btn:active {
                transform: scale(0.96);
                transition: transform 0.08s cubic-bezier(0.16, 1, 0.3, 1);
            }

            .tautulli-tool-btn.active {
                background: rgba(0, 164, 220, 0.25);
                border-color: rgba(0, 164, 220, 0.55);
                color: #00c9ff;
                box-shadow: 0 0 14px rgba(0, 164, 220, 0.35), inset 0 1px 0 rgba(255, 255, 255, 0.2);
            }

            .tautulli-filter-group {
                display: flex;
                align-items: center;
                gap: 4px;
                background: rgba(0, 0, 0, 0.4);
                padding: 3px;
                border-radius: 10px;
                border: 1px solid rgba(255, 255, 255, 0.08);
                box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.4);
            }

            .tautulli-filter-pill {
                background: transparent;
                border: none;
                color: #94a3b8;
                font-size: 11px;
                font-weight: 600;
                padding: 3.5px 9px;
                border-radius: 7px;
                cursor: pointer;
                transition: all var(--lg-duration) ease;
            }

            .tautulli-filter-pill:hover {
                color: #ffffff;
                background: rgba(255, 255, 255, 0.08);
            }

            .tautulli-filter-pill.active {
                background: rgba(56, 189, 248, 0.2);
                color: #38bdf8;
                border: 1px solid rgba(56, 189, 248, 0.45);
                box-shadow: 0 0 12px rgba(56, 189, 248, 0.25), inset 0 1px 0 rgba(255, 255, 255, 0.2);
            }

            /* Responsive Session Grid */
            .tautulli-grid {
                display: grid;
                grid-template-columns: repeat(auto-fill, minmax(460px, 1fr));
                gap: 20px;
                width: 100%;
                box-sizing: border-box;
            }

            /* Session Card - 2026 Executive Studio Canvas with Liquid Glass Physics & Lens Highlight */
            .tautulli-card {
                position: relative;
                display: flex;
                flex-direction: column;
                border-radius: 18px;
                overflow: hidden;
                background: var(--lg-lens-highlight), var(--lg-card-bg);
                backdrop-filter: blur(32px) saturate(185%) contrast(105%);
                -webkit-backdrop-filter: blur(32px) saturate(185%) contrast(105%);
                border: var(--lg-card-border);
                box-shadow: 
                    var(--lg-specular-top),
                    var(--lg-specular-left),
                    var(--lg-dispersion-cyan),
                    var(--lg-dispersion-magenta),
                    var(--lg-specular-bottom),
                    var(--lg-depth-shadow);
                transition: transform var(--lg-duration) var(--lg-ease), box-shadow var(--lg-duration) var(--lg-ease), border-color var(--lg-duration) ease;
            }

            .tautulli-card:hover {
                transform: translateY(-2px);
                border-color: rgba(56, 189, 248, 0.4);
                box-shadow: 
                    inset 0 1px 0 0 rgba(255, 255, 255, 0.32),
                    inset 1px 0 0 0 rgba(255, 255, 255, 0.16),
                    var(--lg-dispersion-cyan),
                    var(--lg-dispersion-magenta),
                    0 28px 64px -10px rgba(0, 0, 0, 0.94),
                    0 0 24px -4px rgba(56, 189, 248, 0.22);
            }

            .tautulli-card:active {
                transform: scale(0.99);
                transition: transform 0.08s ease;
            }

            /* GlassFin Specular Vertical Light Sweep on Hover */
            .tautulli-card::after {
                content: '';
                position: absolute;
                top: 0;
                left: 0;
                right: 0;
                bottom: 0;
                pointer-events: none;
                z-index: 2;
                background: var(--gf-hover-v);
                transform: translateY(-100%);
                transition: transform 0.6s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.6s ease;
                opacity: 0;
            }

            .tautulli-card:hover::after {
                transform: translateY(100%);
                opacity: 1;
            }

            /* Moonfin Dynamic Ambient Glass Layer */
            .tautulli-card-ambient-bg {
                position: absolute;
                top: -25%;
                left: -25%;
                width: 150%;
                height: 150%;
                background-size: cover;
                background-position: center;
                filter: blur(50px) saturate(180%) brightness(0.2);
                opacity: 0.45;
                pointer-events: none;
                z-index: 0;
            }

            /* Right-Side Fanart Backdrop with Multi-stop Frosted Liquid Glass Vignette Mask (Moonfin + Void) */
            .tautulli-card-fanart-backdrop {
                position: absolute;
                top: 0;
                right: 0;
                width: 75%;
                height: 100%;
                background-size: cover;
                background-position: center right;
                opacity: 0.32;
                pointer-events: none;
                z-index: 0;
                mask-image: linear-gradient(to right, transparent 0%, rgba(0, 0, 0, 0.5) 25%, rgba(0, 0, 0, 0.95) 60%, black 100%);
                -webkit-mask-image: linear-gradient(to right, transparent 0%, rgba(0, 0, 0, 0.5) 25%, rgba(0, 0, 0, 0.95) 60%, black 100%);
            }

            /* Card Header: User & Client Strip */
            .tautulli-card-header {
                position: relative;
                z-index: 1;
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 10px;
                padding: 10px 15px;
                background: rgba(9, 10, 16, 0.68);
                border-bottom: 1px solid rgba(255, 255, 255, 0.05);
                backdrop-filter: blur(20px) saturate(160%);
                -webkit-backdrop-filter: blur(20px) saturate(160%);
                box-shadow: inset 0 1px 0 0 rgba(255, 255, 255, 0.12);
            }

            .tautulli-user-strip {
                display: flex;
                align-items: center;
                gap: 10px;
                min-width: 0;
                overflow: hidden;
            }

            .tautulli-user-avatar-link {
                text-decoration: none;
                flex-shrink: 0;
            }

            .tautulli-user-avatar {
                width: 26px;
                height: 26px;
                min-width: 26px;
                border-radius: 50%;
                overflow: hidden;
                display: flex;
                align-items: center;
                justify-content: center;
                font-size: 11px;
                font-weight: 700;
                color: #ffffff;
                background: linear-gradient(135deg, #1e293b 0%, #0f172a 100%);
                border: 1px solid rgba(255, 255, 255, 0.16);
                box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.18), 0 2px 8px rgba(0, 0, 0, 0.5);
            }

            .tautulli-user-avatar img {
                width: 100%;
                height: 100%;
                object-fit: cover;
                display: block;
            }

            .tautulli-user-meta {
                display: flex;
                align-items: center;
                gap: 6px;
                overflow: hidden;
                white-space: nowrap;
                text-overflow: ellipsis;
            }

            .tautulli-user-name {
                font-size: 12.5px;
                font-weight: 700;
                color: #ffffff;
                text-decoration: none;
                letter-spacing: -0.01em;
                transition: color 0.2s ease;
            }

            .tautulli-user-name:hover {
                color: #00c9ff;
            }

            .tautulli-meta-dot {
                color: rgba(255, 255, 255, 0.28);
                font-size: 11px;
            }

            .tautulli-device-text {
                font-size: 11.5px;
                font-weight: 500;
                color: #cbd5e1;
                overflow: hidden;
                text-overflow: ellipsis;
            }

            .tautulli-client-badge {
                font-size: 10px;
                font-family: monospace;
                color: #94a3b8;
                background: rgba(255, 255, 255, 0.05);
                padding: 1.5px 6px;
                border-radius: 5px;
                border: 1px solid rgba(255, 255, 255, 0.08);
            }

            .tautulli-header-controls {
                display: flex;
                align-items: center;
                gap: 8px;
                flex-shrink: 0;
            }

            .tautulli-network-pill {
                font-size: 10px;
                font-family: monospace;
                padding: 2.5px 8px;
                border-radius: 9999px;
                display: flex;
                align-items: center;
                gap: 5px;
                font-weight: 600;
            }

            .tautulli-net-lan {
                background: rgba(16, 185, 129, 0.14);
                color: #34d399;
                border: 1px solid rgba(16, 185, 129, 0.3);
            }

            .tautulli-net-wan {
                background: rgba(59, 130, 246, 0.14);
                color: #60a5fa;
                border: 1px solid rgba(59, 130, 246, 0.3);
            }

            .tautulli-platform-badge {
                width: 24px;
                height: 24px;
                min-width: 24px;
                border-radius: 6px;
                display: flex;
                align-items: center;
                justify-content: center;
                box-shadow: 0 2px 6px rgba(0, 0, 0, 0.35);
                border: 1px solid rgba(255, 255, 255, 0.18);
                flex-shrink: 0;
            }

            .tautulli-platform-badge svg {
                width: 14px;
                height: 14px;
                fill: currentColor;
            }

            .tautulli-action-cluster {
                display: flex;
                align-items: center;
                gap: 5px;
            }

            .tautulli-action-btn {
                width: 26px;
                height: 26px;
                border-radius: 7px;
                display: flex;
                align-items: center;
                justify-content: center;
                background: var(--lg-control-bg);
                border: var(--lg-control-border);
                box-shadow: inset 0 1px 0 0 rgba(255, 255, 255, 0.14), 0 2px 6px rgba(0, 0, 0, 0.35);
                color: #94a3b8;
                cursor: pointer;
                backdrop-filter: blur(14px);
                -webkit-backdrop-filter: blur(14px);
                transition: all var(--lg-duration) var(--lg-ease);
            }

            .tautulli-action-btn:hover {
                background: rgba(255, 255, 255, 0.15);
                border-color: rgba(255, 255, 255, 0.28);
                color: #ffffff;
                transform: translateY(-1px) scale(1.04);
                box-shadow: inset 0 1px 0 0 rgba(255, 255, 255, 0.22), 0 4px 12px rgba(0, 0, 0, 0.5);
            }

            .tautulli-action-btn:active {
                transform: scale(0.96);
                transition: transform 0.08s cubic-bezier(0.16, 1, 0.3, 1);
            }

            .tautulli-action-btn-kill:hover {
                background: rgba(239, 68, 68, 0.22);
                border-color: rgba(239, 68, 68, 0.55);
                color: #f87171;
                box-shadow: 0 0 12px rgba(239, 68, 68, 0.35), inset 0 1px 0 rgba(255, 255, 255, 0.2);
            }

            .tautulli-action-btn-info:hover {
                background: rgba(56, 189, 248, 0.2);
                border-color: rgba(56, 189, 248, 0.5);
                color: #38bdf8;
                box-shadow: 0 0 12px rgba(56, 189, 248, 0.3), inset 0 1px 0 rgba(255, 255, 255, 0.2);
            }

            .tautulli-action-btn svg {
                width: 13px;
                height: 13px;
                fill: currentColor;
            }

            /* Card Body: Split Poster & Stream Hierarchy */
            .tautulli-card-body {
                position: relative;
                z-index: 1;
                display: flex;
                gap: 14px;
                padding: 14px;
                background: rgba(0, 0, 0, 0.18);
                min-height: 155px;
            }

            .tautulli-poster-wrapper {
                position: relative;
                width: 105px;
                min-width: 105px;
                max-width: 105px;
                height: 155px;
                border-radius: 12px;
                overflow: hidden;
                background: rgba(10, 10, 15, 0.9);
                border: 1px solid rgba(255, 255, 255, 0.1);
                box-shadow: 0 12px 28px -4px rgba(0, 0, 0, 0.7);
                flex-shrink: 0;
                cursor: pointer;
                text-decoration: none;
            }

            .tautulli-poster-img {
                width: 100%;
                height: 100%;
                object-fit: cover;
                display: block;
                transition: transform 0.35s cubic-bezier(0.16, 1, 0.3, 1), filter 0.35s ease;
            }

            .tautulli-poster-wrapper:hover .tautulli-poster-img {
                transform: scale(1.05);
                filter: brightness(1.06);
            }

            .tautulli-poster-fallback {
                display: flex;
                flex-direction: column;
                align-items: center;
                justify-content: center;
                color: #64748b;
                font-size: 10px;
                text-align: center;
                height: 100%;
                gap: 6px;
            }

            .tautulli-poster-fallback svg {
                width: 32px;
                height: 32px;
                fill: #475569;
            }

            /* Right Details Section */
            .tautulli-media-details {
                flex: 1;
                display: flex;
                flex-direction: column;
                justify-content: space-between;
                overflow: hidden;
                min-width: 0;
            }

            .tautulli-titles-container {
                display: flex;
                flex-direction: column;
                gap: 6px;
            }

            .tautulli-title-line {
                display: flex;
                align-items: baseline;
                justify-content: space-between;
                gap: 8px;
            }

            .tautulli-title-primary {
                font-size: 14.5px;
                font-weight: 700;
                color: #ffffff;
                text-decoration: none;
                letter-spacing: -0.02em;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
                transition: color 0.2s ease;
            }

            .tautulli-title-primary:hover {
                color: #38bdf8;
            }

            .tautulli-title-secondary {
                font-size: 11px;
                color: #94a3b8;
                font-weight: 500;
                flex-shrink: 0;
                display: flex;
                align-items: center;
                gap: 5px;
            }

            .tautulli-rating-badge {
                padding: 1px 5px;
                border-radius: 4px;
                background: rgba(255, 255, 255, 0.07);
                border: 1px solid rgba(255, 255, 255, 0.12);
                font-size: 9.5px;
                font-weight: 700;
                color: #cbd5e1;
                letter-spacing: 0.04em;
                line-height: 1.2;
            }

            /* Badge Pill Row */
            .tautulli-badge-row {
                display: flex;
                align-items: center;
                gap: 5px;
                flex-wrap: wrap;
            }

            .tautulli-badge {
                display: inline-flex;
                align-items: center;
                gap: 5px;
                padding: 2.5px 7.5px;
                border-radius: 9999px;
                font-size: 9.5px;
                font-weight: 700;
                text-transform: uppercase;
                letter-spacing: 0.04em;
                line-height: 1.3;
                box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.08);
                backdrop-filter: blur(8px);
                -webkit-backdrop-filter: blur(8px);
            }

            .tautulli-live-dot {
                width: 5px;
                height: 5px;
                border-radius: 50%;
                background: currentColor;
                display: inline-block;
                box-shadow: 0 0 6px currentColor;
                flex-shrink: 0;
            }

            .tautulli-badge-directplay {
                background: rgba(16, 185, 129, 0.12);
                color: #34d399;
                border: 1px solid rgba(16, 185, 129, 0.28);
            }

            .tautulli-badge-directstream {
                background: rgba(56, 189, 248, 0.12);
                color: #38bdf8;
                border: 1px solid rgba(56, 189, 248, 0.28);
            }

            .tautulli-badge-transcode {
                background: rgba(239, 68, 68, 0.12);
                color: #fca5a5;
                border: 1px solid rgba(239, 68, 68, 0.28);
            }

            .tautulli-badge-hw {
                background: rgba(168, 85, 247, 0.12);
                color: #d8b4fe;
                border: 1px solid rgba(168, 85, 247, 0.28);
            }

            .tautulli-badge-sw {
                background: rgba(245, 158, 11, 0.12);
                color: #fcd34d;
                border: 1px solid rgba(245, 158, 11, 0.28);
            }

            .tautulli-speed-good {
                color: #34d399;
                background: rgba(16, 185, 129, 0.12);
                border: 1px solid rgba(16, 185, 129, 0.25);
            }

            .tautulli-speed-slow {
                color: #fca5a5;
                background: rgba(239, 68, 68, 0.12);
                border: 1px solid rgba(239, 68, 68, 0.28);
            }

            .tautulli-badge-burnin {
                background: rgba(245, 158, 11, 0.14);
                color: #fcd34d;
                border: 1px solid rgba(245, 158, 11, 0.3);
            }

            .tautulli-badge-hdr {
                background: rgba(255, 255, 255, 0.04);
                color: #fcd34d;
                border: 1px solid rgba(255, 255, 255, 0.1);
                border-radius: 4px;
                padding: 2px 5.5px;
            }

            .tautulli-badge-res {
                background: rgba(255, 255, 255, 0.04);
                color: #f1f5f9;
                border: 1px solid rgba(255, 255, 255, 0.1);
                border-radius: 4px;
                padding: 2px 5.5px;
            }

            .tautulli-badge-audio {
                background: rgba(255, 255, 255, 0.04);
                color: #c7d2fe;
                border: 1px solid rgba(255, 255, 255, 0.1);
                border-radius: 4px;
                padding: 2px 5.5px;
            }

            .tautulli-badge-surround {
                background: rgba(255, 255, 255, 0.04);
                color: #bae6fd;
                border: 1px solid rgba(255, 255, 255, 0.1);
                border-radius: 4px;
                padding: 2px 5.5px;
            }

            .tautulli-badge-tonemap {
                background: rgba(245, 158, 11, 0.12);
                color: #fbbf24;
                border: 1px solid rgba(245, 158, 11, 0.28);
                border-radius: 4px;
                padding: 2px 5.5px;
            }

            .tautulli-badge-multi-ip {
                background: rgba(239, 68, 68, 0.16);
                color: #fca5a5;
                border: 1px solid rgba(239, 68, 68, 0.42);
                border-radius: 4px;
                padding: 2px 6px;
                font-weight: 700;
                letter-spacing: 0.03em;
                animation: tautulli-stutter-pulse 2.2s infinite ease-in-out;
            }

            .tautulli-security-alert-pill {
                display: inline-flex;
                align-items: center;
                gap: 6px;
                padding: 3px 9px;
                border-radius: 9999px;
                background: rgba(239, 68, 68, 0.16);
                color: #fca5a5;
                border: 1px solid rgba(239, 68, 68, 0.38);
                font-size: 11px;
                font-weight: 600;
                animation: tautulli-stutter-pulse 2.2s infinite ease-in-out;
            }

            /* Bottleneck Splitter Badges */
            .tautulli-bottleneck-server {
                background: rgba(239, 68, 68, 0.14);
                color: #fca5a5;
                border: 1px solid rgba(239, 68, 68, 0.32);
            }

            .tautulli-bottleneck-marginal {
                background: rgba(245, 158, 11, 0.14);
                color: #fcd34d;
                border: 1px solid rgba(245, 158, 11, 0.3);
            }

            .tautulli-bottleneck-client {
                background: rgba(56, 189, 248, 0.14);
                color: #7dd3fc;
                border: 1px solid rgba(56, 189, 248, 0.3);
            }

            .tautulli-bottleneck-healthy {
                background: rgba(16, 185, 129, 0.12);
                color: #6ee7b7;
                border: 1px solid rgba(16, 185, 129, 0.28);
            }

            .tautulli-bottleneck-paused {
                background: rgba(148, 163, 184, 0.12);
                color: #cbd5e1;
                border: 1px solid rgba(148, 163, 184, 0.25);
            }

            /* Live Bandwidth History Sparkline */
            .tautulli-sparkline-wrap {
                display: inline-flex;
                align-items: center;
                margin-left: 8px;
                vertical-align: middle;
                height: 24px;
                cursor: pointer;
            }

            .tautulli-sparkline-svg {
                overflow: visible;
                display: block;
            }

            .tautulli-sparkline-dot {
                animation: tautulli-pulse 2s infinite ease-in-out;
            }

            /* Cellular Network Pill */
            .tautulli-net-cellular {
                background: rgba(245, 158, 11, 0.14);
                color: #fcd34d;
                border: 1px solid rgba(245, 158, 11, 0.35);
            }

            /* Bandwidth Savings Badge */
            .tautulli-badge-savings {
                background: rgba(16, 185, 129, 0.14);
                color: #6ee7b7;
                border: 1px solid rgba(16, 185, 129, 0.35);
                font-weight: 600;
            }

            /* SyncPlay Watch Party Badge */
            .tautulli-badge-syncplay {
                background: rgba(168, 85, 247, 0.15);
                color: #d8b4fe;
                border: 1px solid rgba(168, 85, 247, 0.38);
                font-weight: 600;
            }

            /* Hi-Res Lossless Audio Badge */
            .tautulli-badge-hires {
                background: rgba(234, 179, 8, 0.15);
                color: #fef08a;
                border: 1px solid rgba(234, 179, 8, 0.4);
                font-weight: 700;
                letter-spacing: 0.02em;
            }

            /* Audiophile Vinyl Animation */
            .tautulli-vinyl-container {
                position: relative;
                width: 96px;
                height: 96px;
                flex-shrink: 0;
            }

            .tautulli-vinyl-disc {
                position: absolute;
                top: 3px;
                right: -16px;
                width: 90px;
                height: 90px;
                border-radius: 50%;
                background: radial-gradient(circle, #18181b 15%, #27272a 18%, #09090b 35%, #27272a 50%, #09090b 68%, #27272a 82%, #09090b 100%);
                border: 1.5px solid rgba(255, 255, 255, 0.12);
                box-shadow: 0 4px 16px rgba(0, 0, 0, 0.8), inset 0 0 4px rgba(255, 255, 255, 0.2);
                z-index: 0;
                transition: transform 0.5s ease;
            }

            .tautulli-vinyl-spinning {
                animation: tautulli-spin 7s linear infinite;
            }

            @keyframes tautulli-spin {
                from { transform: rotate(0deg); }
                to { transform: rotate(360deg); }
            }

            /* Live Audio Spectrum Equalizer Bars */
            .tautulli-audio-spectrum {
                display: inline-flex;
                align-items: flex-end;
                gap: 2px;
                height: 12px;
                width: 14px;
                margin-left: 4px;
            }

            .tautulli-spectrum-bar {
                width: 2px;
                background: #38bdf8;
                border-radius: 1px;
                animation: tautulli-spectrum-bounce 0.8s ease-in-out infinite alternate;
            }

            .tautulli-spectrum-bar:nth-child(1) { height: 40%; animation-delay: 0.1s; }
            .tautulli-spectrum-bar:nth-child(2) { height: 90%; animation-delay: 0.3s; }
            .tautulli-spectrum-bar:nth-child(3) { height: 60%; animation-delay: 0.2s; }
            .tautulli-spectrum-bar:nth-child(4) { height: 100%; animation-delay: 0.4s; }

            .tautulli-spectrum-paused .tautulli-spectrum-bar {
                animation: none;
                height: 25% !important;
                background: #64748b;
            }

            @keyframes tautulli-spectrum-bounce {
                0% { height: 25%; }
                100% { height: 100%; }
            }

            /* Watch Statistics Drawer (Tautulli-Inspired Leaderboards) */
            .tautulli-stats-drawer {
                margin-top: 24px;
                padding: 16px;
                background: linear-gradient(155deg, rgba(255, 255, 255, 0.035) 0%, rgba(255, 255, 255, 0.01) 100%), #0d0f17;
                backdrop-filter: blur(28px) saturate(180%);
                -webkit-backdrop-filter: blur(28px) saturate(180%);
                border: 1px solid rgba(255, 255, 255, 0.08);
                border-radius: 16px;
                box-shadow: var(--lg-specular-top), 0 12px 36px 0 rgba(0, 0, 0, 0.45);
            }

            .tautulli-stats-header {
                display: flex;
                align-items: center;
                justify-content: space-between;
                margin-bottom: 14px;
                padding-bottom: 10px;
                border-bottom: 1px solid rgba(255, 255, 255, 0.06);
            }

            .tautulli-stats-title {
                display: flex;
                align-items: center;
                gap: 8px;
                font-size: 12px;
                font-weight: 700;
                text-transform: uppercase;
                letter-spacing: 0.08em;
                color: #ffffff;
            }

            .tautulli-stats-grid,
            .tautulli-stats-top3-grid {
                display: grid;
                grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
                gap: 12px;
            }

            .tautulli-stats-top3-card {
                display: flex;
                align-items: center;
                gap: 12px;
                padding: 10px 12px;
                border-radius: 12px;
                background: rgba(255, 255, 255, 0.03);
                border: 1px solid rgba(255, 255, 255, 0.06);
                transition: all 0.2s ease;
                text-decoration: none;
                color: inherit;
                position: relative;
            }

            .tautulli-stats-top3-card:hover {
                background: rgba(255, 255, 255, 0.07);
                border-color: rgba(56, 189, 248, 0.35);
                transform: translateY(-2px);
                box-shadow: 0 8px 24px -4px rgba(0, 0, 0, 0.5);
            }

            .tautulli-stats-top3-rank {
                font-size: 13px;
                font-weight: 800;
                width: 26px;
                height: 26px;
                border-radius: 7px;
                display: flex;
                align-items: center;
                justify-content: center;
                flex-shrink: 0;
                font-family: monospace;
            }

            .tautulli-stats-rank-1 {
                background: linear-gradient(135deg, rgba(245, 158, 11, 0.35), rgba(217, 119, 6, 0.2));
                color: #fbbf24;
                border: 1px solid rgba(245, 158, 11, 0.5);
            }

            .tautulli-stats-rank-2 {
                background: linear-gradient(135deg, rgba(203, 213, 225, 0.3), rgba(148, 163, 184, 0.15));
                color: #e2e8f0;
                border: 1px solid rgba(203, 213, 225, 0.4);
            }

            .tautulli-stats-rank-3 {
                background: linear-gradient(135deg, rgba(217, 119, 6, 0.25), rgba(180, 83, 9, 0.15));
                color: #f97316;
                border: 1px solid rgba(217, 119, 6, 0.35);
            }

            .tautulli-stats-col {
                background: rgba(255, 255, 255, 0.025);
                border: 1px solid rgba(255, 255, 255, 0.06);
                border-radius: 12px;
                padding: 12px;
            }

            .tautulli-stats-col-title {
                font-size: 11px;
                font-weight: 700;
                text-transform: uppercase;
                letter-spacing: 0.06em;
                color: #94a3b8;
                margin-bottom: 10px;
                display: flex;
                align-items: center;
                gap: 6px;
            }

            .tautulli-stats-list {
                display: flex;
                flex-direction: column;
                gap: 8px;
            }

            .tautulli-stats-item {
                display: flex;
                align-items: center;
                gap: 10px;
                padding: 6px 8px;
                border-radius: 8px;
                background: rgba(255, 255, 255, 0.02);
                border: 1px solid rgba(255, 255, 255, 0.04);
                transition: background 0.2s ease, transform 0.2s ease;
                text-decoration: none;
                color: inherit;
            }

            .tautulli-stats-item:hover {
                background: rgba(255, 255, 255, 0.06);
                transform: translateX(2px);
            }

            .tautulli-stats-rank {
                font-size: 11px;
                font-weight: 700;
                color: #38bdf8;
                width: 14px;
                text-align: center;
            }

            .tautulli-stats-thumb {
                width: 32px;
                height: 48px;
                border-radius: 5px;
                object-fit: cover;
                background: #1e293b;
                border: 1px solid rgba(255, 255, 255, 0.1);
                flex-shrink: 0;
            }

            .tautulli-stats-info {
                flex: 1;
                min-width: 0;
            }

            .tautulli-stats-name {
                font-size: 12px;
                font-weight: 600;
                color: #f1f5f9;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
            }

            .tautulli-stats-meta {
                font-size: 10.5px;
                color: #94a3b8;
            }

            .tautulli-stats-metric {
                font-size: 11px;
                font-weight: 700;
                color: #fcd34d;
                font-family: monospace;
            }

            /* Stream Pipeline Chips (Diskovarr dashboard precision with vector glyphs) */
            .tautulli-pipeline-grid {
                display: flex;
                flex-wrap: wrap;
                gap: 5px;
                margin: 8px 0;
            }

            .tautulli-chip {
                display: inline-flex;
                align-items: center;
                gap: 5px;
                padding: 3.5px 8px;
                border-radius: 7px;
                background: var(--lg-chip-bg);
                border: var(--lg-chip-border);
                box-shadow: inset 0 1px 0 0 rgba(255, 255, 255, 0.1);
                font-size: 11px;
                color: #cbd5e1;
                font-variant-numeric: tabular-nums;
                backdrop-filter: blur(12px) saturate(140%);
                -webkit-backdrop-filter: blur(12px) saturate(140%);
                transition: background var(--lg-duration) ease, border-color var(--lg-duration) ease, color var(--lg-duration) ease, transform var(--lg-duration) var(--lg-ease);
            }

            .tautulli-chip:hover {
                background: rgba(255, 255, 255, 0.075);
                border-color: rgba(255, 255, 255, 0.16);
                color: #f8fafc;
                transform: translateY(-0.5px);
            }

            .tautulli-chip strong {
                color: #ffffff;
                font-weight: 600;
                letter-spacing: 0.015em;
            }

            .tautulli-chip-icon {
                display: inline-flex;
                align-items: center;
                justify-content: center;
                width: 12px;
                height: 12px;
                flex-shrink: 0;
                color: #94a3b8;
            }

            .tautulli-chip-icon svg {
                width: 100%;
                height: 100%;
                fill: currentColor;
            }

            /* Transcode Reason Banner */
            .tautulli-reason-banner {
                font-size: 10.5px;
                color: rgba(253, 230, 138, 0.9);
                background: rgba(245, 158, 11, 0.08);
                border: 1px solid rgba(245, 158, 11, 0.2);
                border-radius: 6px;
                padding: 3px 8px;
                display: flex;
                align-items: center;
                gap: 6px;
                overflow: hidden;
                white-space: nowrap;
                text-overflow: ellipsis;
            }

            .tautulli-reason-label {
                font-size: 9.5px;
                font-weight: 700;
                letter-spacing: 0.05em;
                color: #fbbf24;
                flex-shrink: 0;
            }

            .tautulli-reason-val {
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
            }

            /* Card Footer: Interactive Timeline & Playback Status */
            .tautulli-card-footer {
                position: relative;
                z-index: 1;
                padding: 10px 15px 12px 15px;
                background: rgba(9, 10, 16, 0.82);
                border-top: 1px solid rgba(255, 255, 255, 0.05);
                display: flex;
                flex-direction: column;
                gap: 6px;
                backdrop-filter: blur(20px) saturate(160%);
                -webkit-backdrop-filter: blur(20px) saturate(160%);
                box-shadow: inset 0 1px 0 0 rgba(255, 255, 255, 0.05);
            }

            .tautulli-progress-row {
                display: flex;
                align-items: center;
                gap: 10px;
            }

            .tautulli-state-icon {
                display: flex;
                align-items: center;
                justify-content: center;
                width: 24px;
                height: 24px;
                min-width: 24px;
                border-radius: 50%;
                background: rgba(255, 255, 255, 0.06);
                border: 1px solid rgba(255, 255, 255, 0.1);
                color: #ffffff;
                cursor: pointer;
                transition: transform 0.15s cubic-bezier(0.16, 1, 0.3, 1), background 0.15s ease;
            }

            .tautulli-state-icon:hover {
                transform: scale(1.1);
                background: rgba(255, 255, 255, 0.14);
            }

            .tautulli-state-icon:active {
                transform: scale(0.92);
                transition: transform 0.08s cubic-bezier(0.16, 1, 0.3, 1);
            }

            .tautulli-state-icon svg {
                width: 12px;
                height: 12px;
                fill: currentColor;
            }

            .tautulli-state-playing {
                color: #34d399;
                box-shadow: 0 0 10px rgba(52, 211, 153, 0.15);
            }

            .tautulli-state-paused {
                color: #fbbf24;
                box-shadow: 0 0 10px rgba(245, 158, 11, 0.15);
            }

            .tautulli-progress-track {
                flex: 1;
                height: 4px;
                border-radius: 9999px;
                background: rgba(255, 255, 255, 0.08);
                position: relative;
            }

            .tautulli-progress-buffer {
                position: absolute;
                top: 0;
                left: 0;
                height: 100%;
                background: rgba(255, 255, 255, 0.18);
                border-radius: 9999px;
                transition: width 0.35s ease;
                z-index: 1;
            }

            .tautulli-progress-fill {
                position: relative;
                z-index: 2;
                height: 100%;
                border-radius: 9999px;
                background: linear-gradient(90deg, #0284c7 0%, #38bdf8 100%);
                box-shadow: 0 0 10px rgba(56, 189, 248, 0.6);
                transition: width 0.35s cubic-bezier(0.16, 1, 0.3, 1);
            }

            .tautulli-progress-fill::after {
                content: '';
                position: absolute;
                right: -4px;
                top: 50%;
                transform: translateY(-50%);
                width: 8px;
                height: 8px;
                border-radius: 50%;
                background: #ffffff;
                box-shadow: 0 0 8px #38bdf8, 0 0 2px #ffffff;
                z-index: 3;
            }

            .tautulli-progress-fill.paused {
                background: linear-gradient(90deg, #d97706 0%, #fbbf24 100%);
                box-shadow: 0 0 10px rgba(245, 158, 11, 0.5);
            }

            .tautulli-progress-fill.paused::after {
                box-shadow: 0 0 8px #fbbf24, 0 0 2px #ffffff;
            }

            .tautulli-time-row {
                display: flex;
                align-items: center;
                justify-content: space-between;
                font-size: 10.5px;
                padding: 0 2px;
            }

            .tautulli-time-progress {
                color: #94a3b8;
                font-family: monospace;
                font-variant-numeric: tabular-nums;
            }

            .tautulli-time-eta {
                font-weight: 700;
                color: #38bdf8;
                letter-spacing: 0.02em;
                text-shadow: 0 0 8px rgba(56, 189, 248, 0.35);
            }

            .tautulli-time-paused {
                color: #fbbf24;
                font-weight: 700;
                text-shadow: 0 0 8px rgba(245, 158, 11, 0.35);
            }

            /* Empty State Container */
            .tautulli-empty-container {
                display: flex;
                flex-direction: column;
                align-items: center;
                justify-content: center;
                padding: 32px 20px;
                background: rgba(13, 15, 23, 0.65);
                backdrop-filter: blur(16px) saturate(180%);
                -webkit-backdrop-filter: blur(16px) saturate(180%);
                border: 1px solid rgba(255, 255, 255, 0.08);
                border-radius: 12px;
                box-shadow: 0 8px 32px 0 rgba(0, 0, 0, 0.37);
                text-align: center;
                gap: 10px;
            }

            .tautulli-empty-icon {
                width: 36px;
                height: 36px;
                fill: #555555;
            }

            .tautulli-empty-text {
                font-size: 13.5px;
                font-weight: 500;
                color: #777777;
                letter-spacing: 0.02em;
            }

            /* Connected Devices in Empty / Idle State */
            .tautulli-connected-devices-container {
                width: 100%;
                margin-top: 14px;
                padding: 14px 16px;
                background: linear-gradient(155deg, rgba(255, 255, 255, 0.03) 0%, rgba(255, 255, 255, 0.008) 100%), #0d0f17;
                border: 1px solid rgba(255, 255, 255, 0.08);
                border-radius: 12px;
                backdrop-filter: blur(20px);
                -webkit-backdrop-filter: blur(20px);
                box-shadow: var(--lg-specular-top), 0 8px 24px -4px rgba(0, 0, 0, 0.5);
                box-sizing: border-box;
                text-align: left;
            }

            .tautulli-connected-devices-title {
                font-size: 11px;
                font-weight: 700;
                text-transform: uppercase;
                letter-spacing: 0.08em;
                color: #94a3b8;
                margin-bottom: 12px;
                display: flex;
                align-items: center;
                gap: 6px;
            }

            .tautulli-connected-devices-grid {
                display: grid;
                grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
                gap: 10px;
            }

            .tautulli-connected-device-chip {
                display: flex;
                align-items: center;
                gap: 10px;
                padding: 10px 14px;
                background: rgba(255, 255, 255, 0.035);
                border: 1px solid rgba(255, 255, 255, 0.07);
                border-radius: 10px;
                transition: background 0.2s, border-color 0.2s, transform 0.2s;
            }

            .tautulli-connected-device-chip:hover {
                background: rgba(255, 255, 255, 0.06);
                border-color: rgba(255, 255, 255, 0.14);
                transform: translateY(-1px);
            }

            .tautulli-connected-device-icon {
                color: #38bdf8;
                display: flex;
                align-items: center;
                justify-content: center;
                flex-shrink: 0;
            }

            .tautulli-connected-device-info {
                flex: 1;
                min-width: 0;
            }

            .tautulli-connected-device-name {
                font-size: 13px;
                font-weight: 600;
                color: #f1f5f9;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
            }

            .tautulli-connected-device-meta {
                font-size: 11px;
                color: #94a3b8;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
            }

            .tautulli-connected-device-status {
                font-size: 10px;
                font-weight: 700;
                text-transform: uppercase;
                letter-spacing: 0.05em;
                color: #34d399;
                background: rgba(16, 185, 129, 0.12);
                border: 1px solid rgba(16, 185, 129, 0.25);
                border-radius: 100px;
                padding: 2px 7px;
                flex-shrink: 0;
            }

            /* Stream Details Inspector Modal */
            .tautulli-modal-backdrop {
                position: fixed;
                top: 0;
                left: 0;
                width: 100vw;
                height: 100vh;
                background: rgba(0, 0, 0, 0.75);
                backdrop-filter: blur(14px);
                -webkit-backdrop-filter: blur(14px);
                z-index: 99999;
                display: flex;
                align-items: center;
                justify-content: center;
                padding: 20px;
                box-sizing: border-box;
                animation: tautulli-fade-in 0.2s ease;
            }

            @keyframes tautulli-fade-in {
                from { opacity: 0; }
                to { opacity: 1; }
            }

            .tautulli-modal {
                position: relative;
                width: 100%;
                max-width: 600px;
                max-height: 88vh;
                overflow-y: auto;
                background: var(--lg-lens-highlight), linear-gradient(145deg, rgba(255, 255, 255, 0.06) 0%, rgba(255, 255, 255, 0.015) 50%, rgba(9, 10, 16, 0.98) 100%), #090a10;
                border: 1px solid rgba(255, 255, 255, 0.16);
                border-radius: 20px;
                backdrop-filter: blur(36px) saturate(190%) contrast(105%);
                -webkit-backdrop-filter: blur(36px) saturate(190%) contrast(105%);
                box-shadow: 
                    inset 0 1px 0 0 rgba(255, 255, 255, 0.28),
                    inset 1px 0 0 0 rgba(255, 255, 255, 0.12),
                    var(--lg-dispersion-cyan),
                    var(--lg-dispersion-magenta),
                    0 32px 72px -8px rgba(0, 0, 0, 0.95);
                color: #e2e8f0;
                padding: 24px;
                box-sizing: border-box;
                animation: tautulli-modal-pop var(--lg-duration) var(--lg-ease);
            }

            @keyframes tautulli-modal-pop {
                from { transform: scale(0.94); opacity: 0; }
                to { transform: scale(1); opacity: 1; }
            }

            .tautulli-modal-header {
                display: flex;
                align-items: center;
                justify-content: space-between;
                border-bottom: 1px solid rgba(255, 255, 255, 0.08);
                padding-bottom: 14px;
                margin-bottom: 16px;
            }

            .tautulli-modal-title {
                font-size: 15px;
                font-weight: 700;
                color: #ffffff;
                display: flex;
                align-items: center;
                gap: 8px;
            }

            .tautulli-modal-header-actions {
                display: flex;
                align-items: center;
                gap: 8px;
            }

            .tautulli-modal-tool-btn {
                background: rgba(255, 255, 255, 0.08);
                border: 1px solid rgba(255, 255, 255, 0.14);
                color: #e2e8f0;
                font-size: 11px;
                font-weight: 600;
                padding: 5px 10px;
                border-radius: 8px;
                display: inline-flex;
                align-items: center;
                gap: 6px;
                cursor: pointer;
                backdrop-filter: blur(8px);
                transition: all 0.2s ease;
            }

            .tautulli-modal-tool-btn:hover {
                background: rgba(56, 189, 248, 0.18);
                border-color: rgba(56, 189, 248, 0.45);
                color: #38bdf8;
                transform: scale(1.03);
            }

            .tautulli-modal-tool-btn:active {
                transform: scale(0.96);
            }

            .tautulli-modal-close {
                background: rgba(255, 255, 255, 0.08);
                border: 1px solid rgba(255, 255, 255, 0.12);
                color: #94a3b8;
                width: 28px;
                height: 28px;
                border-radius: 8px;
                display: flex;
                align-items: center;
                justify-content: center;
                cursor: pointer;
                transition: all 0.15s ease;
            }

            .tautulli-modal-close:hover {
                background: rgba(239, 68, 68, 0.25);
                color: #f87171;
                border-color: rgba(239, 68, 68, 0.5);
            }

            .tautulli-modal-close:active {
                transform: scale(0.92);
            }

            .tautulli-modal-section {
                margin-bottom: 18px;
            }

            .tautulli-modal-section-title {
                font-size: 11px;
                font-weight: 700;
                text-transform: uppercase;
                letter-spacing: 0.06em;
                color: #38bdf8;
                margin-bottom: 8px;
                display: flex;
                align-items: center;
                gap: 6px;
            }

            .tautulli-modal-table {
                width: 100%;
                border-collapse: collapse;
                font-size: 12px;
                background: rgba(0, 0, 0, 0.35);
                border-radius: 10px;
                overflow: hidden;
                border: 1px solid rgba(255, 255, 255, 0.05);
            }

            .tautulli-modal-table td {
                padding: 7px 12px;
                border-bottom: 1px solid rgba(255, 255, 255, 0.04);
            }

            .tautulli-modal-table tr:last-child td {
                border-bottom: none;
            }

            .tautulli-modal-table td:first-child {
                color: #94a3b8;
                font-weight: 500;
                width: 38%;
            }

            .tautulli-modal-table td:last-child {
                color: #f1f5f9;
                font-weight: 600;
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace;
            }

            /* ==========================================================================
               Responsive Multi-Screen Optimization (Web >768px, Tablet 481-768px, Mobile <=480px)
               Borrowed from NuvioMobile & Diskovarr
               ========================================================================== */

            /* Tablet Form Factor (481px to 768px) */
            @media (max-width: 768px) {
                .tautulli-grid {
                    grid-template-columns: 1fr;
                    gap: 16px;
                }

                .tautulli-card-body {
                    padding: 12px;
                    gap: 12px;
                }

                .tautulli-poster-wrapper {
                    width: 82px;
                    min-width: 82px;
                    max-width: 82px;
                    height: 122px;
                    border-radius: 10px;
                }

                .tautulli-title-primary {
                    font-size: 14px;
                }

                .tautulli-pipeline-grid {
                    gap: 4px;
                }

                .tautulli-chip {
                    font-size: 10.5px;
                    padding: 2.5px 7px;
                }

                .tautulli-badge {
                    font-size: 9px;
                    padding: 2px 7px;
                }
            }

            /* Mobile Form Factor (<= 480px) */
            @media (max-width: 480px) {
                #${CONFIG.CONTAINER_ID} {
                    margin: 0 0 20px 0;
                }

                /* Mobile banner: stacks vertically for 1-handed ergonomics */
                .tautulli-activity-banner {
                    flex-direction: column;
                    align-items: stretch;
                    gap: 10px;
                    padding: 12px 14px;
                    border-radius: 10px;
                }

                .tautulli-activity-left {
                    flex-direction: column;
                    align-items: flex-start;
                    gap: 8px;
                    width: 100%;
                }

                .tautulli-activity-stats {
                    font-size: 11px;
                    gap: 8px;
                }

                .tautulli-filter-group {
                    width: 100%;
                    overflow-x: auto;
                    -webkit-overflow-scrolling: touch;
                    padding: 3px;
                }

                .tautulli-filter-pill {
                    padding: 5px 10px;
                    font-size: 11px;
                    min-height: 32px;
                }

                .tautulli-activity-tools {
                    justify-content: flex-end;
                    width: 100%;
                }

                .tautulli-tool-btn {
                    min-height: 36px;
                    padding: 6px 12px;
                    font-size: 12px;
                }

                .tautulli-grid {
                    grid-template-columns: 1fr;
                    gap: 14px;
                }

                .tautulli-card {
                    border-radius: 14px;
                }

                /* Mobile Header: wrap-safe */
                .tautulli-card-header {
                    padding: 8px 12px;
                    gap: 6px;
                    flex-wrap: wrap;
                }

                .tautulli-user-strip {
                    flex: 1;
                    min-width: 0;
                }

                .tautulli-header-controls {
                    gap: 6px;
                }

                /* Nuvio 38px-40px touch zone for mobile action buttons */
                .tautulli-action-btn {
                    width: 38px;
                    height: 38px;
                    min-width: 38px;
                    border-radius: 9px;
                }

                .tautulli-action-btn svg {
                    width: 15px;
                    height: 15px;
                }

                /* Card body: compact spacing */
                .tautulli-card-body {
                    padding: 10px 12px;
                    gap: 10px;
                    min-height: auto;
                }

                /* Compact poster thumbnail on mobile (leaves >200px width for titles/chips) */
                .tautulli-poster-wrapper {
                    width: 64px;
                    min-width: 64px;
                    max-width: 64px;
                    height: 96px;
                    border-radius: 8px;
                }

                .tautulli-titles-container {
                    gap: 4px;
                }

                /* Title wraps onto 2 lines instead of aggressive truncation */
                .tautulli-title-line {
                    flex-direction: column;
                    align-items: flex-start;
                    gap: 2px;
                }

                .tautulli-title-primary {
                    font-size: 13px;
                    white-space: normal;
                    line-height: 1.25;
                    display: -webkit-box;
                    -webkit-line-clamp: 2;
                    -webkit-box-orient: vertical;
                    overflow: hidden;
                }

                .tautulli-title-secondary {
                    font-size: 10.5px;
                }

                .tautulli-badge-row {
                    gap: 3.5px;
                }

                .tautulli-badge {
                    font-size: 9px;
                    padding: 2px 6px;
                }

                .tautulli-pipeline-grid {
                    gap: 3.5px;
                    margin: 6px 0;
                }

                .tautulli-chip {
                    font-size: 10px;
                    padding: 2px 6px;
                }

                /* Card footer: touch target play/pause */
                .tautulli-card-footer {
                    padding: 8px 12px 10px 12px;
                    gap: 6px;
                }

                .tautulli-state-icon {
                    width: 36px;
                    height: 36px;
                    min-width: 36px;
                }

                .tautulli-state-icon svg {
                    width: 15px;
                    height: 15px;
                }

                /* Nuvio Bottom-sheet modal inspector on mobile */
                .tautulli-modal-backdrop {
                    align-items: flex-end;
                    padding: 0;
                }

                .tautulli-modal {
                    max-width: 100%;
                    width: 100%;
                    max-height: 85vh;
                    border-radius: 20px 20px 0 0;
                    padding: 14px 16px 18px 16px;
                    margin: 0;
                    box-shadow: 0 -12px 40px rgba(0, 0, 0, 0.85);
                }

                /* Apple iOS GlassBottomSheet presentation drag indicator (sanjaynela) */
                .tautulli-modal::before {
                    content: '';
                    display: block;
                    width: 36px;
                    height: 4.5px;
                    border-radius: 9999px;
                    background: rgba(255, 255, 255, 0.32);
                    margin: 0 auto 14px auto;
                }

                .tautulli-modal-table td {
                    padding: 6px 8px;
                    font-size: 11px;
                }
            }

            /* Stream Doctor: Interactive Explainer Panel & Fix Presets */
            .tautulli-reason-banner {
                cursor: pointer;
                transition: background var(--lg-duration) ease, border-color var(--lg-duration) ease;
            }

            .tautulli-reason-banner:hover {
                background: rgba(245, 158, 11, 0.16);
                border-color: rgba(245, 158, 11, 0.4);
            }

            .tautulli-doctor-panel {
                margin: 8px 0 4px 0;
                padding: 10px 12px;
                border-radius: 10px;
                background: linear-gradient(135deg, rgba(245, 158, 11, 0.08) 0%, rgba(9, 10, 16, 0.95) 100%);
                border: 1px solid rgba(245, 158, 11, 0.25);
                box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.1), 0 8px 20px rgba(0, 0, 0, 0.4);
                backdrop-filter: blur(16px);
                -webkit-backdrop-filter: blur(16px);
                display: flex;
                flex-direction: column;
                gap: 6px;
                font-size: 11px;
                line-height: 1.4;
            }

            .tautulli-doctor-header {
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 8px;
                color: #fbbf24;
                font-weight: 700;
                font-size: 11.5px;
            }

            .tautulli-doctor-desc {
                color: #e2e8f0;
            }

            .tautulli-doctor-advice {
                color: #7dd3fc;
                background: rgba(14, 165, 233, 0.12);
                border: 1px solid rgba(56, 189, 248, 0.25);
                padding: 5px 8px;
                border-radius: 6px;
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 8px;
                flex-wrap: wrap;
            }

            .tautulli-send-tip-btn {
                background: rgba(56, 189, 248, 0.2);
                border: 1px solid rgba(56, 189, 248, 0.4);
                color: #38bdf8;
                font-size: 10px;
                font-weight: 700;
                padding: 3px 8px;
                border-radius: 5px;
                cursor: pointer;
                transition: all var(--lg-duration) ease;
                display: inline-flex;
                align-items: center;
                gap: 4px;
            }

            .tautulli-send-tip-btn:hover {
                background: rgba(56, 189, 248, 0.35);
                border-color: rgba(56, 189, 248, 0.65);
                color: #ffffff;
                transform: scale(1.02);
            }

            .tautulli-send-tip-btn:active {
                transform: scale(0.96);
            }

            /* Severe Stutter Buffering Alarm (<1.0x transcode speed) */
            .tautulli-stutter-alarm {
                animation: tautulli-stutter-pulse 1.4s infinite ease-in-out !important;
                background: rgba(239, 68, 68, 0.25) !important;
                border-color: rgba(239, 68, 68, 0.6) !important;
                color: #fca5a5 !important;
            }

            @keyframes tautulli-stutter-pulse {
                0%, 100% {
                    transform: scale(1);
                    box-shadow: 0 0 0 0 rgba(239, 68, 68, 0.5);
                }
                50% {
                    transform: scale(1.06);
                    box-shadow: 0 0 14px 2px rgba(239, 68, 68, 0.7);
                }
            }

            /* Smart Stream Guard Rules Modal */
            .tautulli-guard-badge {
                display: inline-flex;
                align-items: center;
                justify-content: center;
                background: rgba(56, 189, 248, 0.25);
                color: #38bdf8;
                border-radius: 999px;
                padding: 1px 6px;
                font-size: 9.5px;
                font-weight: 700;
                margin-left: 4px;
            }

            .tautulli-rule-card {
                background: rgba(255, 255, 255, 0.03);
                border: 1px solid rgba(255, 255, 255, 0.08);
                border-radius: 12px;
                padding: 12px 14px;
                margin-bottom: 10px;
                display: flex;
                flex-direction: column;
                gap: 8px;
            }

            .tautulli-rule-row {
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 12px;
            }

            .tautulli-rule-title {
                font-size: 12.5px;
                font-weight: 600;
                color: #f1f5f9;
            }

            .tautulli-rule-desc {
                font-size: 11px;
                color: #94a3b8;
                line-height: 1.35;
            }

            .tautulli-switch {
                position: relative;
                display: inline-block;
                width: 38px;
                height: 22px;
                flex-shrink: 0;
            }

            .tautulli-switch input {
                opacity: 0;
                width: 0;
                height: 0;
            }

            .tautulli-slider {
                position: absolute;
                cursor: pointer;
                top: 0; left: 0; right: 0; bottom: 0;
                background-color: rgba(255, 255, 255, 0.14);
                transition: .25s cubic-bezier(0.16, 1, 0.3, 1);
                border-radius: 34px;
                border: 1px solid rgba(255, 255, 255, 0.2);
            }

            .tautulli-slider:before {
                position: absolute;
                content: "";
                height: 14px;
                width: 14px;
                left: 3px;
                bottom: 3px;
                background-color: white;
                transition: .25s cubic-bezier(0.16, 1, 0.3, 1);
                border-radius: 50%;
                box-shadow: 0 1px 3px rgba(0,0,0,0.4);
            }

            .tautulli-switch input:checked + .tautulli-slider {
                background-color: #00a4dc;
                border-color: #38bdf8;
            }

            .tautulli-switch input:checked + .tautulli-slider:before {
                transform: translateX(16px);
            }

            .tautulli-rule-input {
                background: rgba(0, 0, 0, 0.5);
                border: 1px solid rgba(255, 255, 255, 0.16);
                border-radius: 6px;
                color: #ffffff;
                font-size: 11.5px;
                padding: 4px 8px;
                width: 60px;
                text-align: center;
            }

            /* Zombie Transcode Pipeline Watchdog */
            .tautulli-badge-zombie {
                animation: tautulli-stutter-pulse 1.8s infinite ease-in-out !important;
                background: rgba(245, 158, 11, 0.25) !important;
                border-color: rgba(245, 158, 11, 0.6) !important;
                color: #fcd34d !important;
            }

            .tautulli-btn-flush {
                background: rgba(239, 68, 68, 0.2) !important;
                border: 1px solid rgba(239, 68, 68, 0.5) !important;
                color: #fca5a5 !important;
            }

            .tautulli-btn-flush:hover {
                background: rgba(239, 68, 68, 0.4) !important;
                border-color: rgba(239, 68, 68, 0.8) !important;
                color: #ffffff !important;
                transform: scale(1.04);
            }

            /* Servarr Subtitle Remediation (Bazarr) */
            .tautulli-servarr-btn {
                background: linear-gradient(135deg, rgba(16, 185, 129, 0.25) 0%, rgba(6, 182, 212, 0.25) 100%);
                border: 1px solid rgba(16, 185, 129, 0.5);
                color: #6ee7b7;
                font-size: 10px;
                font-weight: 700;
                padding: 3px 8px;
                border-radius: 5px;
                cursor: pointer;
                transition: all var(--lg-duration) ease;
                display: inline-flex;
                align-items: center;
                gap: 4px;
            }

            .tautulli-servarr-btn:hover {
                background: linear-gradient(135deg, rgba(16, 185, 129, 0.45) 0%, rgba(6, 182, 212, 0.45) 100%);
                border-color: rgba(16, 185, 129, 0.85);
                color: #ffffff;
                transform: scale(1.02);
            }

            .tautulli-servarr-btn:active {
                transform: scale(0.96);
            }

            .tautulli-pipeline-pill {
                display: inline-flex;
                align-items: center;
                gap: 4px;
                padding: 2px 7px;
                border-radius: 999px;
                font-size: 10px;
                font-weight: 600;
                background: rgba(0, 164, 220, 0.15);
                color: #38bdf8;
                border: 1px solid rgba(0, 164, 220, 0.3);
            }

            .tautulli-pipeline-zombie {
                background: rgba(245, 158, 11, 0.2) !important;
                color: #fcd34d !important;
                border-color: rgba(245, 158, 11, 0.5) !important;
                animation: tautulli-stutter-pulse 2s infinite ease-in-out;
            }

            .tautulli-form-row {
                display: flex;
                flex-direction: column;
                gap: 4px;
                margin-bottom: 12px;
            }

            .tautulli-form-row label {
                font-size: 11.5px;
                font-weight: 600;
                color: #cbd5e1;
            }

            .tautulli-input {
                background: rgba(0, 0, 0, 0.5);
                border: 1px solid rgba(255, 255, 255, 0.16);
                border-radius: 6px;
                color: #ffffff;
                font-size: 12px;
                padding: 6px 10px;
                width: 100%;
                box-sizing: border-box;
                font-family: inherit;
            }

            .tautulli-input:focus {
                outline: none;
                border-color: #00a4dc;
                box-shadow: 0 0 0 2px rgba(0, 164, 220, 0.3);
            }
        `;
        document.head.appendChild(styleElement);
    }

    /**
     * Escapes HTML entities to prevent XSS.
     */
    function escapeHtml(str) {
        if (str == null) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    /**
     * Formats bitrates (bps) into clean human-readable strings (e.g. 4.5 Mbps, 931 kbps).
     */
    function formatBitrate(bitrate) {
        if (!bitrate || isNaN(bitrate) || bitrate <= 0) return '0 kbps';
        if (bitrate >= 1000000) {
            return `${(bitrate / 1000000).toFixed(1)} Mbps`;
        }
        return `${Math.round(bitrate / 1000)} kbps`;
    }

    /**
     * Resolves unified resolution info (short code and badge text) considering both width and height,
     * properly handling cinemascope aspect ratios (e.g. 1920x804 is 1080p, 1280x536 is 720p).
     */
    function resolveResolutionInfo(width, height) {
        const w = width || 0;
        const h = height || 0;
        if (h >= 2100 || w >= 3800) return { short: '4K', badge: '4K UHD' };
        if (h >= 800 || w >= 1800) return { short: '1080p', badge: '1080p FHD' };
        if (h >= 540 || w >= 1200) return { short: '720p', badge: '720p HD' };
        if (h >= 400 || w >= 640) return { short: '480p', badge: '480p SD' };
        if (h > 0) return { short: `${h}p`, badge: `${h}p` };
        return { short: '1080p', badge: '1080p FHD' };
    }

    /**
     * Formats seconds into M:SS or H:MM:SS duration string.
     */
    function formatDuration(totalSeconds) {
        if (!totalSeconds || isNaN(totalSeconds) || totalSeconds < 0) return '0:00';
        const hours = Math.floor(totalSeconds / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        const seconds = Math.floor(totalSeconds % 60);

        const pad = (n) => (n < 10 ? '0' + n : n);

        if (hours > 0) {
            return `${hours}:${pad(minutes)}:${pad(seconds)}`;
        }
        return `${minutes}:${pad(seconds)}`;
    }

    /**
     * Formats estimated finish time (ETA) or paused timer duration.
     */
    function formatETA(remainingSeconds, isPaused, pausedSeconds) {
        if (isPaused) {
            if (pausedSeconds > 0) {
                return `Paused (${formatDuration(pausedSeconds)})`;
            }
            return 'ETA: Paused';
        }
        if (!remainingSeconds || remainingSeconds <= 0) {
            return 'ETA: --:--';
        }
        const etaDate = new Date(Date.now() + remainingSeconds * 1000);
        const hours = etaDate.getHours();
        const minutes = etaDate.getMinutes();
        const pad = (n) => (n < 10 ? '0' + n : n);

        let leftStr = '';
        if (remainingSeconds < 3600) {
            const mins = Math.max(1, Math.round(remainingSeconds / 60));
            leftStr = `(${mins}m left)`;
        } else {
            const hrs = Math.floor(remainingSeconds / 3600);
            const mins = Math.round((remainingSeconds % 3600) / 60);
            leftStr = `(${hrs}h ${mins}m left)`;
        }

        return `ETA: ${pad(hours)}:${pad(minutes)} ${leftStr}`;
    }

    /**
     * Determines whether an IP is in a private/LAN subnet (supports IPv4, IPv6, and port stripping).
     */
    function isLanIp(ip) {
        if (!ip) return true;
        let clean = ip.trim();
        if (clean.startsWith('[') && clean.includes(']')) {
            clean = clean.substring(1, clean.indexOf(']'));
        } else if (clean.includes('.') && clean.includes(':')) {
            clean = clean.split(':')[0];
        }
        if (clean === '127.0.0.1' || clean === 'localhost' || clean === '::1') return true;
        if (clean.startsWith('10.') || clean.startsWith('192.168.')) return true;
        if (/^172\.(1[6-9]|2\d|3[01])\./.test(clean)) return true;
        const lower = clean.toLowerCase();
        if (lower.startsWith('fe80:') || lower.startsWith('fc') || lower.startsWith('fd')) return true;
        return false;
    }

    /**
     * Human-formats transcode reason codes into readable badge labels.
     */
    function formatTranscodeReason(reason) {
        if (!reason) return 'Transcoding';
        if (TRANSCODE_EXPLANATIONS[reason] && TRANSCODE_EXPLANATIONS[reason].short) {
            return TRANSCODE_EXPLANATIONS[reason].short;
        }
        return reason
            .replace(/([A-Z])/g, ' $1')
            .replace(/^./, (s) => s.toUpperCase())
            .trim();
    }

    /**
     * Formats Hardware Acceleration engine names.
     */
    function formatHwAccel(hwType) {
        if (!hwType) return null;
        const lower = hwType.toLowerCase();
        if (lower.includes('nvenc') || lower.includes('nvidia')) return 'HW: NVENC';
        if (lower.includes('qsv') || lower.includes('quicksync')) return 'HW: QuickSync';
        if (lower.includes('vaapi')) return 'HW: VAAPI';
        if (lower.includes('videotoolbox') || lower.includes('apple')) return 'HW: VideoToolbox';
        if (lower.includes('amf') || lower.includes('amd')) return 'HW: AMF';
        return `HW: ${hwType.toUpperCase()}`;
    }

    /**
     * P1.3 Bottleneck Splitter: Diagnoses whether a stream stall/buffering is caused by server or client.
     */
    function computeBottleneckDiagnostic(card) {
        if (!card) return null;

        // Server Overload: Transcode speed is below real-time (< 1.0x)
        if (card.isTranscode && card.transcodeSpeedMultiplier && parseFloat(card.transcodeSpeedMultiplier) < 1.0) {
            return {
                key: 'server-overload',
                badgeClass: 'tautulli-bottleneck-server',
                badgeText: '✕ Server Overload (<1.0x)',
                shortName: 'Server Overload',
                title: 'Server GPU/CPU cannot encode fast enough (speed < 1.0x). Playback will buffer/freeze.',
                explanation: 'The server processing capacity is the bottleneck. The transcode speed is below real-time playback speed (1.0x), causing client buffer starvation.',
                recommendation: 'Enable hardware acceleration (NVENC/QuickSync) or reduce video transcode bitrate.'
            };
        }

        // Server Marginal: Transcode speed is between 1.0x and 1.35x
        if (card.isTranscode && card.transcodeSpeedMultiplier && parseFloat(card.transcodeSpeedMultiplier) >= 1.0 && parseFloat(card.transcodeSpeedMultiplier) < 1.35) {
            return {
                key: 'server-marginal',
                badgeClass: 'tautulli-bottleneck-marginal',
                badgeText: '· Server Marginal (1.0–1.3x)',
                shortName: 'Server Marginal',
                title: 'Server transcode speed is near real-time (1.0x–1.35x). Minor spikes may cause brief buffering.',
                explanation: 'The server is barely outpacing playback. Temporary background loads on the server may cause micro-stutters.',
                recommendation: 'Monitor server CPU/GPU load to ensure speed stays comfortably above 1.5x.'
            };
        }

        // Client Paused: Stream is paused on client device
        if (card.isPaused && card.pausedDurationSeconds > 15) {
            return {
                key: 'client-paused',
                badgeClass: 'tautulli-bottleneck-paused',
                badgeText: '· Client Paused',
                shortName: 'Client Paused',
                title: `Client paused playback for ${formatDuration(card.pausedDurationSeconds)}. No active data transmission needed.`,
                explanation: 'Playback is paused on the user device. Server stream session is held open.',
                recommendation: 'Smart Stream Guard will auto-reclaim resources if pause exceeds limit.'
            };
        }

        // High Bitrate WAN direct stream
        if (!card.isPaused && (card.isDirectPlay || card.isDirectStream || (card.transcodeSpeedMultiplier && parseFloat(card.transcodeSpeedMultiplier) >= 2.0))) {
            if (!card.isLan && card.bandwidthNumber > 35000000) {
                return {
                    key: 'wan-high-bitrate',
                    badgeClass: 'tautulli-bottleneck-client',
                    badgeText: '· WAN High Bitrate',
                    shortName: 'WAN High Bitrate',
                    title: 'High remote bitrate (>35 Mbps). Stutters are likely caused by client Wi-Fi or ISP upload limit.',
                    explanation: 'Server is direct playing or transcoding fast (>2.0x). If client reports buffering, the bottleneck is remote WAN connection or client 2.4GHz Wi-Fi.',
                    recommendation: 'Client should switch to 5GHz Wi-Fi / Ethernet or select a lower remote streaming quality.'
                };
            }
        }

        // Optimal / Healthy Pipeline
        return {
            key: 'healthy',
            badgeClass: 'tautulli-bottleneck-healthy',
            badgeText: '✓ Pipeline Healthy',
            shortName: 'Pipeline Healthy',
            title: 'Server pipeline throughput is healthy with no detected bottlenecks.',
            explanation: 'Server encoding speed and delivery throughput are optimal.',
            recommendation: 'Stream is operating smoothly.'
        };
    }

    /**
     * P1.1 Live Bandwidth History Sparkline: Generates an SVG micro-trendline.
     */
    function renderBandwidthSparkline(history, width = 100, height = 22) {
        if (!history || history.length < 2) {
            return '';
        }
        const maxVal = Math.max(...history.map((h) => h.total), 500000); // at least 500 kbps scale
        const pts = history.map((pt, i) => {
            const x = Math.round((i / (history.length - 1)) * (width - 8) + 4);
            const y = Math.round(height - 4 - ((pt.total / maxVal) * (height - 8)));
            return { x, y, total: pt.total };
        });

        const polylinePts = pts.map((p) => `${p.x},${p.y}`).join(' ');
        const firstX = pts[0].x;
        const lastPt = pts[pts.length - 1];
        const fillPath = `M ${firstX},${height} L ${pts.map((p) => `${p.x},${p.y}`).join(' L ')} L ${lastPt.x},${height} Z`;

        const peakRate = formatBitrate(Math.max(...history.map((h) => h.total)));
        const curRate = formatBitrate(lastPt.total);

        return `
            <div class="tautulli-sparkline-wrap" title="Rolling Bandwidth Trend (${history.length * 3}s window) · Peak: ${peakRate} · Current: ${curRate}">
                <svg class="tautulli-sparkline-svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
                    <defs>
                        <linearGradient id="tautulli-sparkline-grad" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stop-color="#38bdf8" stop-opacity="0.35"/>
                            <stop offset="100%" stop-color="#38bdf8" stop-opacity="0.0"/>
                        </linearGradient>
                    </defs>
                    <path d="${fillPath}" fill="url(#tautulli-sparkline-grad)" />
                    <polyline points="${polylinePts}" fill="none" stroke="#38bdf8" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
                    <circle cx="${lastPt.x}" cy="${lastPt.y}" r="2.5" fill="#38bdf8" class="tautulli-sparkline-dot" />
                </svg>
            </div>
        `;
    }

    /**
     * Generates a stable executive dark-mode gradient for avatar fallback initials.
     */
    function getAvatarColor(name) {
        if (!name) return 'linear-gradient(135deg, #1e293b 0%, #0f172a 100%)';
        let hash = 0;
        for (let i = 0; i < name.length; i++) {
            hash = name.charCodeAt(i) + ((hash << 5) - hash);
        }
        const gradients = [
            'linear-gradient(135deg, #1e3a8a 0%, #0f172a 100%)', // deep sapphire
            'linear-gradient(135deg, #0e7490 0%, #083344 100%)', // dark cyan
            'linear-gradient(135deg, #065f46 0%, #022c22 100%)', // dark emerald
            'linear-gradient(135deg, #3730a3 0%, #1e1b4b 100%)', // dark indigo
            'linear-gradient(135deg, #5b21b6 0%, #2e1065 100%)', // dark violet
            'linear-gradient(135deg, #0369a1 0%, #082f49 100%)', // dark sky
            'linear-gradient(135deg, #115e59 0%, #042f2e 100%)', // dark teal
            'linear-gradient(135deg, #92400e 0%, #451a03 100%)', // dark amber
            'linear-gradient(135deg, #334155 0%, #0f172a 100%)'  // dark slate
        ];
        return gradients[Math.abs(hash) % gradients.length];
    }

    /**
     * Returns an SVG icon and signature brand color for client / device badges (Tautulli style).
     */
    function getPlatformBadge(client, deviceName) {
        const combined = `${client || ''} ${deviceName || ''}`.toLowerCase();

        if (combined.includes('apple tv') || combined.includes('appletv')) {
            return {
                bg: 'rgba(255, 255, 255, 0.08)',
                color: '#f8fafc',
                title: 'Apple TV',
                svg: `<svg viewBox="0 0 24 24"><path d="M21 3H3c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h5v2h8v-2h5c1.1 0 1.99-.9 1.99-2L23 5c0-1.1-.9-2-2-2zm0 14H3V5h18v12z"/></svg>`
            };
        }
        if (combined.includes('webos') || combined.includes('lg')) {
            return {
                bg: 'rgba(165, 0, 52, 0.25)',
                color: '#fda4af',
                title: 'LG webOS TV',
                svg: `<svg viewBox="0 0 24 24"><path d="M21 3H3c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h5v2h8v-2h5c1.1 0 1.99-.9 1.99-2L23 5c0-1.1-.9-2-2-2zm0 14H3V5h18v12z"/></svg>`
            };
        }
        if (combined.includes('tizen') || combined.includes('samsung')) {
            return {
                bg: 'rgba(15, 121, 175, 0.25)',
                color: '#7dd3fc',
                title: 'Samsung Tizen TV',
                svg: `<svg viewBox="0 0 24 24"><path d="M21 3H3c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h5v2h8v-2h5c1.1 0 1.99-.9 1.99-2L23 5c0-1.1-.9-2-2-2zm0 14H3V5h18v12z"/></svg>`
            };
        }
        if (combined.includes('playstation') || combined.includes('ps4') || combined.includes('ps5')) {
            return {
                bg: 'rgba(0, 55, 145, 0.3)',
                color: '#93c5fd',
                title: 'PlayStation',
                svg: `<svg viewBox="0 0 24 24"><path d="M21 6H3c-1.1 0-2 .9-2 2v8c0 1.1.9 2 2 2h18c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm-10 7H9v2H7v-2H5v-2h2V9h2v2h2v2zm4.5 2c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5zm3-3c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5z"/></svg>`
            };
        }
        if (combined.includes('xbox')) {
            return {
                bg: 'rgba(16, 124, 16, 0.25)',
                color: '#86efac',
                title: 'Xbox Console',
                svg: `<svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm3.88 15.53c-1.04.52-2.39.84-3.88.84s-2.84-.32-3.88-.84c-.45-.23-.84-.5-1.19-.8 1.13-1.01 2.99-2.36 5.07-2.36s3.94 1.35 5.07 2.36c-.35.3-.74.57-1.19.8zm2.4-2.28c-.89-.92-2.28-1.99-4.28-2.58 1.62-.97 3.39-1.28 4.14-1.34.46 1.19.64 2.52.14 3.92zm-12.56 0c-.5-1.4-.32-2.73.14-3.92.75.06 2.52.37 4.14 1.34-2 .59-3.39 1.66-4.28 2.58z"/></svg>`
            };
        }
        if (combined.includes('swiftfin')) {
            return {
                bg: 'rgba(0, 164, 220, 0.25)',
                color: '#38bdf8',
                title: 'Swiftfin Client',
                svg: `<svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 14h-2v-2h2v2zm0-4h-2V7h2v5z"/></svg>`
            };
        }
        if (combined.includes('infuse')) {
            return {
                bg: 'rgba(255, 75, 58, 0.25)',
                color: '#fca5a5',
                title: 'Infuse Player',
                svg: `<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>`
            };
        }
        if (combined.includes('kodi')) {
            return {
                bg: 'rgba(23, 178, 231, 0.25)',
                color: '#7dd3fc',
                title: 'Kodi Media Center',
                svg: `<svg viewBox="0 0 24 24"><path d="M12 2L2 12l10 10 10-10L12 2zm0 3.83L18.17 12 12 18.17 5.83 12 12 5.83z"/></svg>`
            };
        }
        if (combined.includes('android') || combined.includes('pixel') || combined.includes('shield')) {
            return {
                bg: 'rgba(61, 220, 132, 0.22)',
                color: '#6ee7b7',
                title: 'Android / Google TV',
                svg: `<svg viewBox="0 0 24 24"><path d="M6 18c0 .55.45 1 1 1h1v3.5c0 .83.67 1.5 1.5 1.5s1.5-.67 1.5-1.5V19h2v3.5c0 .83.67 1.5 1.5 1.5s1.5-.67 1.5-1.5V19h1c.55 0 1-.45 1-1V8H6v10zM3.5 8C2.67 8 2 8.67 2 9.5v7c0 .83.67 1.5 1.5 1.5S5 17.33 5 16.5v-7C5 8.67 4.33 8 3.5 8zm17 0c-.83 0-1.5.67-1.5 1.5v7c0 .83.67 1.5 1.5 1.5s1.5-.67 1.5-1.5v-7c0-.83-.67-1.5-1.5-1.5zm-4.97-5.84l1.3-1.3c.2-.2.2-.51 0-.71-.2-.2-.51-.2-.71 0l-1.48 1.48C13.85 1.23 12.95 1 12 1c-.96 0-1.86.23-2.66.63L7.85.15c-.2-.2-.51-.2-.71 0-.2.2-.2.51 0 .71l1.31 1.31C6.97 3.26 6 5.01 6 7h12c0-1.99-.97-3.75-2.47-4.84zM10 5H9V4h1v1zm5 0h-1V4h1v1z"/></svg>`
            };
        }
        if (combined.includes('safari')) {
            return {
                bg: 'rgba(0, 164, 220, 0.22)',
                color: '#38bdf8',
                title: 'Apple Safari',
                svg: `<svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm-5.5-3.5l2.79-6.29 6.29-2.79-2.79 6.29-6.29 2.79zm4.25-4.25c-.41.41-.41 1.09 0 1.5s1.09.41 1.5 0 .41-1.09 0-1.5-1.09-.41-1.5 0z"/></svg>`
            };
        }
        if (combined.includes('apple') || combined.includes('ios') || combined.includes('macos') || combined.includes('iphone') || combined.includes('ipad')) {
            return {
                bg: 'rgba(255, 255, 255, 0.08)',
                color: '#f8fafc',
                title: 'Apple / iOS / macOS',
                svg: `<svg viewBox="0 0 24 24"><path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.81-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M15.97 6.87c.66-.82 1.11-1.96.99-3.1-.96.04-2.12.65-2.8 1.45-.59.69-1.12 1.83-.98 2.94 1.07.08 2.13-.47 2.79-1.29z"/></svg>`
            };
        }
        if (combined.includes('fire') || combined.includes('amazon')) {
            return {
                bg: 'rgba(255, 153, 0, 0.25)',
                color: '#fcd34d',
                title: 'Amazon Fire TV',
                svg: `<svg viewBox="0 0 24 24"><path d="M21 3H3c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h5v2h8v-2h5c1.1 0 1.99-.9 1.99-2L23 5c0-1.1-.9-2-2-2zm0 14H3V5h18v12z"/></svg>`
            };
        }
        if (combined.includes('chrome')) {
            return {
                bg: 'rgba(234, 67, 53, 0.22)',
                color: '#fca5a5',
                title: 'Google Chrome',
                svg: `<svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 4a6 6 0 1 1 0 12 6 6 0 0 1 0-12zm0 2a4 4 0 1 0 0 8 4 4 0 0 0 0-8z"/></svg>`
            };
        }
        if (combined.includes('firefox')) {
            return {
                bg: 'rgba(255, 113, 57, 0.22)',
                color: '#fdba74',
                title: 'Mozilla Firefox',
                svg: `<svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8z"/></svg>`
            };
        }
        if (combined.includes('edg')) {
            return {
                bg: 'rgba(0, 120, 215, 0.25)',
                color: '#7dd3fc',
                title: 'Microsoft Edge',
                svg: `<svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8z"/></svg>`
            };
        }
        if (combined.includes('roku')) {
            return {
                bg: 'rgba(102, 45, 145, 0.3)',
                color: '#d8b4fe',
                title: 'Roku',
                svg: `<svg viewBox="0 0 24 24"><path d="M21 3H3c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h5v2h8v-2h5c1.1 0 1.99-.9 1.99-2L23 5c0-1.1-.9-2-2-2zm0 14H3V5h18v12z"/></svg>`
            };
        }
        return {
            bg: 'rgba(255, 255, 255, 0.06)',
            color: '#94a3b8',
            title: client || 'Web Player',
            svg: `<svg viewBox="0 0 24 24"><path d="M20 18c1.1 0 1.99-.9 1.99-2L22 6c0-1.1-.9-2-2-2H4c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2H0v2h24v-2h-4zM4 6h16v10H4V6z"/></svg>`
        };
    }

    /**
     * Resolves the active Jellyfin ApiClient across various web client versions and architectures.
     */
    function getApiClient() {
        if (window.ApiClient) return window.ApiClient;
        if (window.connectionManager && typeof window.connectionManager.currentApiClient === 'function') {
            return window.connectionManager.currentApiClient();
        }
        if (window.ServerConnections && typeof window.ServerConnections.currentApiClient === 'function') {
            return window.ServerConnections.currentApiClient();
        }
        return null;
    }

    /**
     * Resolves the poster/primary artwork URL for an active session.
     */
    function getPosterUrl(session) {
        const apiClient = getApiClient();
        if (!apiClient || !session.NowPlayingItem) return null;
        const item = session.NowPlayingItem;

        if (item.PrimaryImageTag) {
            return window.ApiClient.getImageUrl(item.Id, {
                type: 'Primary',
                maxHeight: 400,
                tag: item.PrimaryImageTag
            });
        }
        if (item.SeriesId && item.SeriesPrimaryImageTag) {
            return window.ApiClient.getImageUrl(item.SeriesId, {
                type: 'Primary',
                maxHeight: 400,
                tag: item.SeriesPrimaryImageTag
            });
        }
        if (item.AlbumId && item.AlbumPrimaryImageTag) {
            return window.ApiClient.getImageUrl(item.AlbumId, {
                type: 'Primary',
                maxHeight: 400,
                tag: item.AlbumPrimaryImageTag
            });
        }
        if (item.BackdropImageTags && item.BackdropImageTags.length > 0) {
            return window.ApiClient.getImageUrl(item.Id, {
                type: 'Backdrop',
                maxHeight: 400,
                tag: item.BackdropImageTags[0]
            });
        }
        return null;
    }

    /**
     * Resolves the fanart / backdrop artwork URL for the right-side glass background.
     */
    function getBackdropUrl(session) {
        if (!window.ApiClient || !session.NowPlayingItem) return null;
        const item = session.NowPlayingItem;

        if (item.BackdropImageTags && item.BackdropImageTags.length > 0) {
            return window.ApiClient.getImageUrl(item.Id, {
                type: 'Backdrop',
                maxWidth: 800,
                tag: item.BackdropImageTags[0]
            });
        }
        if (item.ParentBackdropImageTags && item.ParentBackdropImageTags.length > 0) {
            const targetId = item.ParentBackdropItemId || item.SeriesId || item.Id;
            return window.ApiClient.getImageUrl(targetId, {
                type: 'Backdrop',
                maxWidth: 800,
                tag: item.ParentBackdropImageTags[0]
            });
        }
        if (item.ImageTags && item.ImageTags.Thumb) {
            return window.ApiClient.getImageUrl(item.Id, {
                type: 'Thumb',
                maxWidth: 800,
                tag: item.ImageTags.Thumb
            });
        }
        return null;
    }

    /**
     * Resolves the user avatar image URL.
     */
    function getUserAvatarUrl(session) {
        if (!window.ApiClient || !session.UserId || !session.UserPrimaryImageTag) {
            return null;
        }
        return window.ApiClient.getUserImageUrl(session.UserId, {
            tag: session.UserPrimaryImageTag,
            type: 'Primary',
            height: 64,
            width: 64
        });
    }

    /**
     * Interactive Action: Stop / Kill Stream (Jellywatch & Tautulli flagship feature)
     */
    async function handleKillStream(sessionId, userName, mediaTitle) {
        if (!window.ApiClient) return;
        const confirmMsg = `Terminate active playback for ${userName} (${mediaTitle})?`;
        if (!window.confirm(confirmMsg)) {
            return;
        }

        try {
            if (typeof window.ApiClient.sendPlaystateCommand === 'function') {
                await window.ApiClient.sendPlaystateCommand(sessionId, 'Stop');
            } else if (typeof window.ApiClient.ajax === 'function') {
                await window.ApiClient.ajax({
                    type: 'POST',
                    url: window.ApiClient.getUrl(`Sessions/${sessionId}/Playing/Stop`)
                });
            }
            // Trigger an immediate refresh
            fetchAndRenderSessions();
        } catch (err) {
            console.error('[PlaybackCard] Failed to stop session:', err);
            alert('Could not terminate session. Please check admin permissions.');
        }
    }

    /**
     * Interactive Action: Send On-Screen Message to Player (Jellywatch feature)
     */
    async function handleSendMessage(sessionId, userName, defaultMsg) {
        if (!window.ApiClient) return;
        const msg = defaultMsg ? defaultMsg : window.prompt(`Send on-screen message to ${userName}:`, 'Server restart in 5 minutes.');
        if (!msg || !msg.trim()) {
            return;
        }

        try {
            if (typeof window.ApiClient.ajax === 'function') {
                await window.ApiClient.ajax({
                    type: 'POST',
                    url: window.ApiClient.getUrl(`Sessions/${sessionId}/Message`),
                    data: JSON.stringify({
                        Text: msg.trim(),
                        Header: 'Server Notice',
                        TimeoutMs: 7000
                    }),
                    contentType: 'application/json'
                });
                alert(`Message sent to ${userName}.`);
            }
        } catch (err) {
            console.error('[PlaybackCard] Failed to send message to session:', err);
            alert('Could not send message to client.');
        }
    }

    /**
     * Interactive Action: Toggle Play/Pause on client session
     */
    async function handleTogglePlayPause(sessionId, isCurrentlyPaused) {
        if (!window.ApiClient) return;
        const command = isCurrentlyPaused ? 'Unpause' : 'Pause';
        try {
            if (typeof window.ApiClient.sendPlaystateCommand === 'function') {
                await window.ApiClient.sendPlaystateCommand(sessionId, command);
            } else if (typeof window.ApiClient.ajax === 'function') {
                await window.ApiClient.ajax({
                    type: 'POST',
                    url: window.ApiClient.getUrl(`Sessions/${sessionId}/Playing/${command}`)
                });
            }
            fetchAndRenderSessions();
        } catch (err) {
            console.error('[PlaybackCard] Failed to toggle playstate:', err);
        }
    }

    /**
     * P1.5 Interactive Action: Force Flush Zombie Transcode Pipeline
     * Halts runaway/orphaned FFmpeg processes and clears stalled session tracking.
     */
    async function handleFlushPipeline(sessionId, userName, mediaTitle) {
        if (!window.ApiClient || !sessionId) return;
        const confirmMsg = `Force Flush Zombie Pipeline for ${userName} (${mediaTitle})?\nThis terminates stalled FFmpeg transcode processes and frees server resources.`;
        if (!window.confirm(confirmMsg)) {
            return;
        }

        try {
            sessionTranscodeStallCycles.delete(sessionId);
            sessionLastTicks.delete(sessionId);
            if (typeof window.ApiClient.sendPlaystateCommand === 'function') {
                await window.ApiClient.sendPlaystateCommand(sessionId, 'Stop');
            } else if (typeof window.ApiClient.ajax === 'function') {
                await window.ApiClient.ajax({
                    type: 'POST',
                    url: window.ApiClient.getUrl(`Sessions/${sessionId}/Playing/Stop`)
                });
            }
            lastRenderedHash = '';
            fetchAndRenderSessions();
        } catch (err) {
            console.error('[PlaybackCard] Failed to flush pipeline:', err);
            alert('Could not terminate stalled pipeline. Please check server permissions.');
        }
    }

    /**
     * P1.6 Interactive Action: Trigger Bazarr Subtitle Remediation
     * Searches and downloads text-based SRT subtitles to eliminate CPU transcode burn-in.
     */
    async function handleFetchSrtBazarr(sessionId, title) {
        if (!servarrConfig.bazarrUrl) {
            if (window.confirm('Bazarr is not configured yet. Would you like to configure your Bazarr URL & API key now?')) {
                openServarrModal();
            }
            return;
        }

        const baseUrl = servarrConfig.bazarrUrl.replace(/\/$/, '');
        const apiKey = servarrConfig.bazarrApiKey || '';

        try {
            const res = await fetch(`${baseUrl}/api/command`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Api-Key': apiKey
                },
                body: JSON.stringify({ name: 'WantedSubtitlesSearch' }),
                mode: 'cors'
            });
            if (res.ok) {
                alert(`✓ Bazarr Subtitle Search triggered successfully for "${title || 'playing media'}". SRT subtitles will be synced in background.`);
            } else {
                window.open(`${baseUrl}/series`, '_blank');
            }
        } catch (err) {
            // Browser CORS or network isolation: gracefully open Bazarr UI directly
            window.open(`${baseUrl}/series`, '_blank');
        }
    }

    /**
     * Maps raw Jellyfin session data into Tautulli/Jellywatch card view model.
     */
    function mapSessionToCardModel(session, index) {
        const item = session.NowPlayingItem || {};
        const playState = session.PlayState || {};
        const transcodeInfo = session.TranscodingInfo || null;

        // Determine Play Method
        let playMethod = playState.PlayMethod || (transcodeInfo ? 'Transcode' : 'DirectPlay');
        let isDirectPlay = playMethod === 'DirectPlay';
        let isDirectStream = playMethod === 'DirectStream';
        let isTranscode = playMethod === 'Transcode' || (!isDirectPlay && !isDirectStream && transcodeInfo != null);

        // Hardware Acceleration detection (NVENC, QuickSync, VAAPI, VideoToolbox vs SW)
        let hwAccelBadge = null;
        let isSwTranscode = false;
        if (isTranscode && transcodeInfo) {
            if (transcodeInfo.HardwareAccelerationType) {
                hwAccelBadge = formatHwAccel(transcodeInfo.HardwareAccelerationType);
            } else if (transcodeInfo.IsVideoDirect === false) {
                isSwTranscode = true;
            }
        }

        // Transcode Speed & FPS
        let transcodeFps = null;
        let transcodeSpeedMultiplier = null;
        if (isTranscode && transcodeInfo && transcodeInfo.Framerate) {
            transcodeFps = Math.round(transcodeInfo.Framerate);
            // Default target video fps around 24-30
            const nominalFps = 24.0;
            transcodeSpeedMultiplier = (transcodeInfo.Framerate / nominalFps).toFixed(1);
        }

        // Codec & Media stream parsing
        const mediaStreams = item.MediaStreams || [];
        const videoStream = mediaStreams.find((s) => s.Type === 'Video') || {};
        const audioStream = mediaStreams.find((s) => s.Type === 'Audio' && (playState.AudioStreamIndex == null || s.Index === playState.AudioStreamIndex)) || {};
        const subStream = mediaStreams.find((s) => s.Type === 'Subtitle' && s.Index === playState.SubtitleStreamIndex) || null;

        // Subtitle Burn-In check
        let isSubtitleBurnIn = false;
        if (isTranscode && transcodeInfo && transcodeInfo.TranscodeReasons) {
            if (transcodeInfo.TranscodeReasons.includes('SubtitleCodecNotSupported')) {
                isSubtitleBurnIn = true;
            }
        }

        // Container
        const origContainer = (item.Container || 'MKV').toUpperCase();
        let containerDisplay = `Direct Play (${origContainer})`;
        if (isTranscode && transcodeInfo && transcodeInfo.Container) {
            const targetContainer = transcodeInfo.Container.toUpperCase();
            containerDisplay = `Converting (${origContainer} ➔ ${targetContainer})`;
        } else if (isDirectStream) {
            containerDisplay = `Direct Stream (${origContainer})`;
        }

        // Video
        const origVideoCodec = (videoStream.Codec || 'H264').toUpperCase();
        const origResInfo = resolveResolutionInfo(videoStream.Width, videoStream.Height);
        const origVideoRes = origResInfo.short;
        let videoDisplay = `${isDirectStream ? 'Direct Stream' : isDirectPlay ? 'Direct Play' : 'Transcode'} (${origVideoCodec} ${origVideoRes})`;
        let videoChip = `${origVideoRes} ${origVideoCodec}`;

        if (isTranscode && transcodeInfo && !transcodeInfo.IsVideoDirect) {
            const targetCodec = (transcodeInfo.VideoCodec || 'H264').toUpperCase();
            const targetResInfo = resolveResolutionInfo(transcodeInfo.Width, transcodeInfo.Height);
            const targetRes = transcodeInfo.Height ? targetResInfo.short : origVideoRes;
            videoDisplay = `Transcode (${origVideoCodec} ${origVideoRes} ➔ ${targetCodec} ${targetRes})`;
            videoChip = `${origVideoRes} ${origVideoCodec} ➔ ${targetRes} ${targetCodec}`;
        }

        // Audio
        const origAudioLang = audioStream.Language ? audioStream.Language.toUpperCase() : '';
        const origAudioCodec = (audioStream.Codec || 'AAC').toUpperCase();
        const origChannels = audioStream.Channels === 6 ? '5.1' : audioStream.Channels === 8 ? '7.1' : audioStream.Channels === 2 ? 'Stereo' : (audioStream.Channels ? `${audioStream.Channels} Ch` : 'Stereo');
        const origAudioDesc = [origAudioLang, origAudioCodec, origChannels].filter(Boolean).join(' - ');
        let audioDisplay = `${isDirectPlay ? 'Direct Play' : isDirectStream ? 'Direct Stream' : 'Transcode'} (${origAudioDesc})`;
        let audioChip = origAudioDesc || `${origAudioCodec} ${origChannels}`;

        if (isTranscode && transcodeInfo && !transcodeInfo.IsAudioDirect) {
            const targetAudioCodec = (transcodeInfo.AudioCodec || 'AAC').toUpperCase();
            const targetChannels = transcodeInfo.AudioChannels === 2 ? 'Stereo' : (transcodeInfo.AudioChannels ? `${transcodeInfo.AudioChannels} Ch` : 'Stereo');
            audioDisplay = `Transcode (${origAudioDesc} ➔ ${targetAudioCodec} ${targetChannels})`;
            audioChip = `${origAudioDesc} ➔ ${targetAudioCodec} ${targetChannels}`;
        }

        // HDR Detection & P1.4 Enhanced Tone Mapping Details (HDR10, HDR10+, Dolby Vision, HLG, BT2020)
        let hdrBadge = null;
        const videoRange = (videoStream.VideoRange || videoStream.VideoRangeType || '').toUpperCase();
        const colorSpace = (videoStream.ColorSpace || '').toUpperCase();
        const colorTransfer = (videoStream.ColorTransfer || '').toLowerCase();
        const colorPrimaries = (videoStream.ColorPrimaries || '').toLowerCase();
        const isHdr = videoRange.includes('HDR') || videoRange.includes('DOVI') || videoRange.includes('HLG') || colorSpace.includes('BT2020') || colorTransfer === 'smpte2084' || colorTransfer === 'arib-std-b67';
        let hdrStandardDesc = null;
        let isToneMapped = false;
        let toneMappingDetail = null;

        if (isHdr) {
            let hdrName = 'HDR';
            if (videoRange.includes('DOVI') || (videoStream.Title && videoStream.Title.toUpperCase().includes('DV'))) {
                hdrName = 'Dolby Vision';
                hdrStandardDesc = 'Dolby Vision (Dynamic Metadata)';
            } else if (videoRange.includes('HDR10+') || videoRange.includes('HDR10PLUS')) {
                hdrName = 'HDR10+';
                hdrStandardDesc = 'HDR10+ (Dynamic Metadata)';
            } else if (videoRange.includes('HDR10') || colorTransfer === 'smpte2084') {
                hdrName = 'HDR10';
                hdrStandardDesc = 'SMPTE ST 2084 (PQ)';
            } else if (videoRange.includes('HLG') || colorTransfer === 'arib-std-b67') {
                hdrName = 'HLG';
                hdrStandardDesc = 'ARIB STD-B67 (HLG)';
            } else {
                hdrStandardDesc = 'HDR Wide Color Gamut';
            }

            if (isTranscode && transcodeInfo && !transcodeInfo.IsVideoDirect) {
                isToneMapped = true;
                hdrBadge = `${hdrName} ➔ SDR`;
                const sourceGamut = colorPrimaries.includes('2020') ? 'BT.2020' : (colorSpace || 'BT.2020');
                toneMappingDetail = `${sourceGamut} (${hdrName}) ➔ BT.709 SDR (Tone Mapped)`;
            } else {
                hdrBadge = hdrName;
            }
        }

        // Audio Spatial / Atmos / Lossless detection
        let audioBadge = null;
        const audioTitleUpper = (audioStream.Title || audioStream.DisplayTitle || '').toUpperCase();
        if (audioTitleUpper.includes('ATMOS') || audioTitleUpper.includes('JOC')) {
            audioBadge = 'Dolby Atmos';
        } else if (origAudioCodec.includes('TRUEHD') || origAudioCodec.includes('DTS-HD') || origAudioCodec.includes('FLAC') || origAudioCodec.includes('ALAC')) {
            audioBadge = 'Lossless';
        }

        // Container
        let containerChip = origContainer;
        if (isTranscode && transcodeInfo && transcodeInfo.Container) {
            const targetContainer = transcodeInfo.Container.toUpperCase();
            containerChip = `${origContainer} ➔ ${targetContainer}`;
        }

        // Subtitles
        let subtitleDisplay = 'None';
        let subChip = null;
        if (subStream) {
            const subTitle = subStream.DisplayTitle || subStream.Language || 'Subtitles';
            const subCodec = (subStream.Codec || 'Text').toUpperCase();
            subtitleDisplay = `${subTitle} (${subCodec})`;
            subChip = `${subTitle} (${subCodec})`;
        }

        // Bandwidth & Quality
        let currentBitrate = 0;
        if (isTranscode && transcodeInfo) {
            currentBitrate = transcodeInfo.Bitrate || ((transcodeInfo.VideoBitrate || 0) + (transcodeInfo.AudioBitrate || 0)) || 0;
        }
        if (!currentBitrate) {
            currentBitrate = item.Bitrate || item.TotalBitrate || 0;
        }
        if (!currentBitrate && item.Id && itemBitrateCache.has(item.Id)) {
            currentBitrate = itemBitrateCache.get(item.Id);
        }
        if (!currentBitrate && item.MediaSources && item.MediaSources.length > 0) {
            currentBitrate = item.MediaSources[0].Bitrate || 0;
        }
        if (!currentBitrate && mediaStreams.length > 0) {
            const streamSum = mediaStreams.reduce((acc, s) => acc + (s.BitRate || 0), 0);
            if (streamSum > 0) {
                currentBitrate = streamSum;
            } else if (videoStream && videoStream.BitRate) {
                currentBitrate = videoStream.BitRate;
            }
        }
        if (!currentBitrate && item.Size && item.RunTimeTicks) {
            const durationSec = item.RunTimeTicks / 10000000;
            if (durationSec > 0) {
                currentBitrate = Math.round((item.Size * 8) / durationSec);
            }
        }
        // Intelligent fallback: estimate realistic non-zero bitrate if media headers omit it so 0 kbps never displays
        if (!currentBitrate) {
            if (isAudioItem) {
                currentBitrate = (audioStream.SampleRate >= 48000 && audioStream.BitDepth >= 24) ? 1500000 : 320000;
            } else if (origResInfo.short === '4K') {
                currentBitrate = (origVideoCodec === 'HEVC' || origVideoCodec === 'AV1') ? 22000000 : 35000000;
            } else if (origResInfo.short === '1080p') {
                currentBitrate = (origVideoCodec === 'HEVC' || origVideoCodec === 'AV1') ? 5000000 : 8500000;
            } else if (origResInfo.short === '720p') {
                currentBitrate = 4000000;
            } else {
                currentBitrate = 1500000;
            }
        }

        const origBitrate = (item.MediaStreams && item.MediaStreams[0] && item.MediaStreams[0].BitRate) || item.Bitrate || currentBitrate;
        const targetBitrate = (transcodeInfo && transcodeInfo.Bitrate) || currentBitrate;
        let bandwidthSavingsRatio = null;
        let bandwidthSavingsPercent = null;
        let bandwidthSavingsBadge = null;
        if (isTranscode && origBitrate > targetBitrate && targetBitrate > 0) {
            const ratio = (origBitrate / targetBitrate).toFixed(1);
            const pct = Math.round(((origBitrate - targetBitrate) / origBitrate) * 100);
            if (pct >= 5) {
                bandwidthSavingsRatio = `${ratio}:1`;
                bandwidthSavingsPercent = `${pct}%`;
                bandwidthSavingsBadge = `${ratio}:1 (${pct}% Bandwidth Saved)`;
            }
        }
        const qualityDisplay = isTranscode
            ? `Transcode (${formatBitrate(currentBitrate)})`
            : `Original (${formatBitrate(currentBitrate)})`;
        const bandwidthDisplay = formatBitrate(currentBitrate);

        // Location & IP Privacy
        const rawIp = session.RemoteEndPoint || '127.0.0.1';
        const isLan = isLanIp(rawIp);
        let cleanIp = rawIp.trim();
        if (cleanIp.startsWith('[') && cleanIp.includes(']')) {
            cleanIp = cleanIp.substring(1, cleanIp.indexOf(']'));
        } else if (cleanIp.includes('.') && cleanIp.includes(':')) {
            cleanIp = cleanIp.split(':')[0];
        }
        let locationDisplay = `${cleanIp}`;
        if (isPrivacyMode) {
            locationDisplay = `[Protected]`;
        }

        // Tautulli-Inspired Connection Type (CELLULAR vs WAN vs LAN)
        let connectionType = 'LAN';
        let connectionClass = 'tautulli-net-lan';
        let connectionBadge = 'LAN';
        if (!isLan) {
            const clientDeviceStr = `${session.Client || ''} ${session.DeviceName || ''}`.toLowerCase();
            const isCellular = /cellular|mobile|iphone|ipad|android|galaxy|pixel|phone|streamyfin|finamp|swiftfin/i.test(clientDeviceStr);
            if (isCellular) {
                connectionType = 'CELLULAR';
                connectionClass = 'tautulli-net-cellular';
                connectionBadge = 'CELLULAR';
            } else {
                connectionType = 'WAN';
                connectionClass = 'tautulli-net-wan';
                connectionBadge = 'WAN';
            }
        }

        // Transcode Reasons (filter out duplicate subtitle notice if burn-in badge is already shown)
        let transcodeReasons = (transcodeInfo && transcodeInfo.TranscodeReasons) || [];
        if (isSubtitleBurnIn) {
            transcodeReasons = transcodeReasons.filter((r) => r !== 'SubtitleCodecNotSupported');
        }

        // Timing & Paused tracking
        const positionTicks = playState.PositionTicks || 0;
        const runTimeTicks = item.RunTimeTicks || 0;
        const progressRatio = runTimeTicks > 0 ? Math.min(1, Math.max(0, positionTicks / runTimeTicks)) : 0;
        const progressPercent = (progressRatio * 100).toFixed(1);

        const currentSeconds = Math.floor(positionTicks / 10000000);
        const totalSeconds = Math.floor(runTimeTicks / 10000000);
        const remainingSeconds = Math.max(0, totalSeconds - currentSeconds);

        // Track pause duration
        let pausedDurationSeconds = 0;
        if (playState.IsPaused) {
            if (!sessionPausedTimestamps.has(session.Id)) {
                sessionPausedTimestamps.set(session.Id, Date.now());
            }
            const startTime = sessionPausedTimestamps.get(session.Id);
            pausedDurationSeconds = Math.floor((Date.now() - startTime) / 1000);
        } else {
            sessionPausedTimestamps.delete(session.Id);
        }

        const timeProgressStr = `${formatDuration(currentSeconds)} / ${formatDuration(totalSeconds)}`;
        const etaStr = formatETA(remainingSeconds, playState.IsPaused, pausedDurationSeconds);

        // Titles & Navigation
        let primaryTitle = item.Name || 'Unknown Title';
        let secondaryTitle = item.ProductionYear ? String(item.ProductionYear) : '';
        const isAudioItem = item.Type === 'Audio';

        if (item.Type === 'Episode') {
            primaryTitle = item.SeriesName || item.Name;
            const seasonNum = item.ParentIndexNumber != null ? item.ParentIndexNumber : 1;
            const episodeNum = item.IndexNumber != null ? item.IndexNumber : 1;
            secondaryTitle = `S${seasonNum}:E${episodeNum} · ${item.Name}`;
        } else if (isAudioItem) {
            primaryTitle = item.Name;
            const artists = (item.Artists || []).join(', ') || item.AlbumArtist || 'Artist';
            secondaryTitle = `${artists} · ${item.Album || 'Single'}`;
        } else {
            const durationStr = totalSeconds > 0 ? formatDuration(totalSeconds) : '';
            const yearStr = item.ProductionYear ? String(item.ProductionYear) : '';
            secondaryTitle = [yearStr, durationStr].filter(Boolean).join(' · ');
        }

        let displayName = session.UserName || 'User';
        if (isPrivacyMode) {
            displayName = `User #${index + 1}`;
        }

        // Transcode Completion Buffer
        const transcodeCompletionPercentage = (isTranscode && transcodeInfo && transcodeInfo.CompletionPercentage != null)
            ? Math.min(100, Math.max(0, Math.round(transcodeInfo.CompletionPercentage)))
            : null;

        // Detailed media specs for stream inspector
        const videoProfile = videoStream.Profile || null;
        const videoBitDepth = videoStream.BitDepth ? `${videoStream.BitDepth}-bit` : null;
        const videoFrameRate = videoStream.AverageFrameRate ? `${Math.round(videoStream.AverageFrameRate)} fps` : (videoStream.RealFrameRate ? `${Math.round(videoStream.RealFrameRate)} fps` : null);
        const audioSampleRate = audioStream.SampleRate ? `${(audioStream.SampleRate / 1000).toFixed(1)} kHz` : null;
        const audioBitRate = audioStream.BitRate ? formatBitrate(audioStream.BitRate) : null;
        const isMuted = Boolean(playState.IsMuted);
        const volumeLevel = playState.VolumeLevel != null ? Math.round(playState.VolumeLevel) : null;
        const isSlowTranscode = Boolean(isTranscode && transcodeSpeedMultiplier && parseFloat(transcodeSpeedMultiplier) < 1.0);
        let slowCycleCount = 0;
        if (isSlowTranscode) {
            slowCycleCount = (sessionSlowCycles.get(session.Id) || 0) + 1;
            sessionSlowCycles.set(session.Id, slowCycleCount);
        } else {
            sessionSlowCycles.delete(session.Id);
        }
        const isSevereStutter = slowCycleCount >= 2; // Buffering alarm after 2+ consecutive checks

        // P1.5 Zombie Transcode Tracking: stalled playback position during active transcoding
        let isZombieTranscode = false;
        let zombieStallDurationSec = 0;
        if (isTranscode && !playState.IsPaused) {
            const lastTicks = sessionLastTicks.get(session.Id);
            if (lastTicks !== undefined && lastTicks === positionTicks) {
                const stalledCycles = (sessionTranscodeStallCycles.get(session.Id) || 0) + 1;
                sessionTranscodeStallCycles.set(session.Id, stalledCycles);
                if (stalledCycles >= 5) {
                    isZombieTranscode = true;
                    zombieStallDurationSec = stalledCycles * 3;
                }
            } else {
                sessionTranscodeStallCycles.set(session.Id, 0);
            }
            sessionLastTicks.set(session.Id, positionTicks);
        } else {
            sessionTranscodeStallCycles.set(session.Id, 0);
            if (playState.PositionTicks != null) {
                sessionLastTicks.set(session.Id, playState.PositionTicks);
            }
        }

        // P1.6 Subtitle Burn-In & Bazarr Remediation readiness
        const canRemediateSubtitlesWithBazarr = isSubtitleBurnIn || Boolean(subStream && ['pgs', 'vobsub', 'dvdsub', 'dvb_subtitle'].includes((subStream.Codec || '').toLowerCase()));

        // Resolution Badge (4K UHD, 1080p FHD, 720p HD, SD)
        const resBadge = origResInfo.badge;

        // Audio Channels Badge (7.1 Surround, 5.1 Surround, Stereo)
        let audioChannelsBadge = null;
        if (audioStream.Channels === 8) {
            audioChannelsBadge = '7.1 Surround';
        } else if (audioStream.Channels === 6) {
            audioChannelsBadge = '5.1 Surround';
        } else if (audioStream.Channels === 2) {
            audioChannelsBadge = 'Stereo';
        }

        // Tautulli-Inspired Hi-Res Audiophile Detection
        const sampleRateHz = audioStream.SampleRate || 0;
        const bitDepthBits = audioStream.BitDepth || 0;
        const isHiResAudio = Boolean(isAudioItem && (
            (sampleRateHz >= 48000 && bitDepthBits >= 24) ||
            (sampleRateHz >= 88200) ||
            (origAudioCodec === 'FLAC' && (bitDepthBits >= 24 || sampleRateHz >= 48000)) ||
            (origAudioCodec === 'DSD' || origAudioCodec === 'DSF')
        ));
        let hiResBadgeText = null;
        if (isHiResAudio) {
            const srStr = sampleRateHz >= 1000 ? `${(sampleRateHz / 1000).toFixed(0)}kHz` : `${sampleRateHz}Hz`;
            const bdStr = bitDepthBits ? `${bitDepthBits}-bit` : '';
            hiResBadgeText = `Hi-Res ${[srStr, bdStr, origAudioCodec].filter(Boolean).join(' ')}`.trim();
        }

        // Tautulli-Inspired SyncPlay Watch Party Group
        const syncPlayGroupId = session.SyncPlayGroupId || session.GroupId || (session.SyncPlay && session.SyncPlay.GroupId) || null;

        const model = {
            sessionId: session.Id,
            itemId: item.Id,
            userId: session.UserId,
            product: session.Client || 'Jellyfin Web',
            player: resolveDeviceModel(session),
            qualityDisplay,
            playMethod,
            isDirectPlay,
            isDirectStream,
            isTranscode,
            isThrottled: Boolean(transcodeInfo && transcodeInfo.IsThrottled),
            hwAccelBadge,
            isSwTranscode,
            transcodeFps,
            transcodeSpeedMultiplier,
            transcodeCompletionPercentage,
            hdrBadge,
            audioBadge,
            resBadge,
            audioChannelsBadge,
            officialRating: item.OfficialRating || null,
            videoProfile,
            videoBitDepth,
            videoFrameRate,
            colorSpace,
            colorTransfer: colorTransfer || null,
            colorPrimaries: colorPrimaries || null,
            hdrStandardDesc,
            isToneMapped,
            toneMappingDetail,
            rawCleanIp: cleanIp,
            connectionType,
            connectionClass,
            connectionBadge,
            bandwidthSavingsRatio,
            bandwidthSavingsPercent,
            bandwidthSavingsBadge,
            isHiResAudio,
            hiResBadgeText,
            syncPlayGroupId,
            syncPlayMembersCount: 1,
            syncPlayBadge: null,
            isMultiIpSharing: false,
            distinctWanIpCount: 1,
            wanIpList: [],
            audioSampleRate,
            audioBitRate,
            isMuted,
            volumeLevel,
            isSlowTranscode,
            isSevereStutter,
            isZombieTranscode,
            zombieStallDurationSec,
            zombieBadge: isZombieTranscode ? `ZOMBIE PIPELINE (${zombieStallDurationSec}s)` : null,
            canRemediateSubtitlesWithBazarr,
            mediaItemName: item.Name || primaryTitle,
            mediaItemYear: item.ProductionYear || '',
            mediaItemType: item.Type || 'Movie',
            seriesName: item.SeriesName || '',
            seasonIndex: item.ParentIndexNumber != null ? item.ParentIndexNumber : 1,
            episodeIndex: item.IndexNumber != null ? item.IndexNumber : 1,
            providerIds: item.ProviderIds || {},
            mediaPath: item.Path || '',
            is4k: origVideoRes === '4K',
            isSubtitleBurnIn,
            transcodeReasons,
            rawTranscodeReasons: (transcodeInfo && transcodeInfo.TranscodeReasons) || [],
            containerDisplay,
            containerChip,
            videoDisplay,
            videoChip,
            audioDisplay,
            audioChip,
            subtitleDisplay,
            subChip,
            locationDisplay,
            isLan,
            bandwidthDisplay,
            bandwidthNumber: currentBitrate,
            etaStr,
            timeProgressStr,
            progressPercent,
            currentSeconds,
            totalSeconds,
            isPaused: Boolean(playState.IsPaused),
            pausedDurationSeconds,
            primaryTitle,
            secondaryTitle,
            userName: displayName,
            posterUrl: getPosterUrl(session),
            backdropUrl: getBackdropUrl(session),
            platformBadge: getPlatformBadge(session.Client, session.DeviceName),
            userAvatarUrl: getUserAvatarUrl(session),
            client: session.Client,
            deviceName: resolveDeviceModel(session),
            rawDeviceName: session.DeviceName || '',
            deviceId: session.DeviceId || session.DeviceName || session.Id,
            isAudioItem
        };

        model.bottleneck = computeBottleneckDiagnostic(model);
        return model;
    }

    /**
     * Renders an individual session card element HTML string.
     */
    function renderSessionCard(card) {
        // Stream Badge
        let badgeClass = 'tautulli-badge-directplay';
        let badgeLabel = '<span class="tautulli-live-dot"></span>Direct Play';

        if (card.isTranscode) {
            badgeClass = 'tautulli-badge-transcode';
            badgeLabel = card.isThrottled ? '<span class="tautulli-live-dot"></span>Transcode (Throttled)' : '<span class="tautulli-live-dot"></span>Transcode';
        } else if (card.isDirectStream) {
            badgeClass = 'tautulli-badge-directstream';
            badgeLabel = '<span class="tautulli-live-dot"></span>Direct Stream';
        }

        // Hardware Acceleration / Software Transcode Badge
        let hwBadgeHtml = '';
        if (card.hwAccelBadge) {
            hwBadgeHtml = `<span class="tautulli-badge tautulli-badge-hw" title="Hardware Accelerated Transcoding">${escapeHtml(card.hwAccelBadge)}</span>`;
        } else if (card.isSwTranscode) {
            hwBadgeHtml = `<span class="tautulli-badge tautulli-badge-sw" title="CPU Software Transcode">SW Transcode</span>`;
        }

        // Transcode Speed tag
        let speedHtml = '';
        if (card.transcodeSpeedMultiplier) {
            const isGood = parseFloat(card.transcodeSpeedMultiplier) >= 1.0;
            const speedClass = isGood ? 'tautulli-speed-good' : 'tautulli-speed-slow';
            speedHtml = `<span class="tautulli-badge ${speedClass}" title="${card.transcodeFps} fps">${card.transcodeSpeedMultiplier}x speed</span>`;
        }

        // Subtitle Burn-In warning badge
        let burnInHtml = '';
        if (card.isSubtitleBurnIn) {
            burnInHtml = `<span class="tautulli-badge tautulli-badge-burnin" title="Subtitle format forcing transcode">Sub Burn-In</span>`;
        }

        // Transcode Reasons & Stream Doctor Explainer banner HTML
        let reasonsBannerHtml = '';
        if (card.isTranscode && card.transcodeReasons.length > 0) {
            const reasonsText = card.transcodeReasons.map(formatTranscodeReason).join(', ');
            
            // Build Stream Doctor explanation & advice
            let doctorDetail = '';
            let doctorAdvice = '';
            const primaryReasonKey = (card.rawTranscodeReasons && card.rawTranscodeReasons[0]) || card.transcodeReasons[0];
            if (TRANSCODE_EXPLANATIONS[primaryReasonKey]) {
                doctorDetail = TRANSCODE_EXPLANATIONS[primaryReasonKey].detail;
                doctorAdvice = TRANSCODE_EXPLANATIONS[primaryReasonKey].advice;
            } else {
                doctorDetail = `Server is transcoding video/audio pipeline: ${reasonsText}.`;
                doctorAdvice = 'Use Jellyfin Media Player or check network bandwidth.';
            }

            reasonsBannerHtml = `
                <div class="tautulli-reason-banner" data-action="toggle-doctor" data-session-id="${escapeHtml(card.sessionId)}" title="Click to open Stream Doctor diagnostic and fix guide">
                    <span class="tautulli-reason-label">REASON</span>
                    <span class="tautulli-reason-val">${escapeHtml(reasonsText)}</span>
                    <span style="margin-left:auto;color:#38bdf8;font-size:9.5px;font-weight:600;">Doctor ➔</span>
                </div>
                <div class="tautulli-doctor-panel" id="tautulli-doctor-${escapeHtml(card.sessionId)}" style="display:none;">
                    <div class="tautulli-doctor-header">
                        <span>Stream Doctor Diagnosis</span>
                        <span style="font-size:9.5px;color:#94a3b8;">${escapeHtml(formatTranscodeReason(primaryReasonKey))}</span>
                    </div>
                    <div class="tautulli-doctor-desc">${escapeHtml(doctorDetail)}</div>
                    <div class="tautulli-doctor-advice">
                        <span>${escapeHtml(doctorAdvice)}</span>
                        <button class="tautulli-send-tip-btn" data-action="send-fix-tip" data-session-id="${escapeHtml(card.sessionId)}" data-user="${escapeHtml(card.userName)}" data-tip="${escapeHtml(doctorAdvice)}" title="Send this fix recommendation as on-screen alert to player">
                            Send Tip to Player
                        </button>
                        ${card.canRemediateSubtitlesWithBazarr ? `
                        <button class="tautulli-servarr-btn" data-action="fetch-srt-bazarr" data-session-id="${escapeHtml(card.sessionId)}" data-title="${escapeHtml(card.mediaItemName || card.primaryTitle)}" title="Trigger Bazarr to search and download text-based SRT subtitles">
                            <svg viewBox="0 0 24 24" style="width:11px;height:11px;fill:currentColor;flex-shrink:0;"><path d="M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96zM13 13v4h-2v-4H8l4-4 4 4h-3z"/></svg>
                            <span>Fetch SRT (Bazarr)</span>
                        </button>
                        ` : ''}
                    </div>
                </div>
            `;
        }

        // Poster image or clean SVG placeholder
        let posterHtml = '';
        if (card.posterUrl) {
            posterHtml = `<img class="tautulli-poster-img" src="${escapeHtml(card.posterUrl)}" alt="${escapeHtml(card.primaryTitle)}" loading="lazy" />`;
        } else {
            posterHtml = `
                <div class="tautulli-poster-fallback">
                    <svg viewBox="0 0 24 24"><path d="M18 4l2 4h-3l-2-4h-2l2 4h-3l-2-4H8l2 4H7L5 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V4h-4z"/></svg>
                    <span>NO ART</span>
                </div>
            `;
        }

        let artworkHtml = posterHtml;
        if (card.isAudioItem) {
            artworkHtml = `
                <div class="tautulli-vinyl-container" title="${escapeHtml(card.primaryTitle)}">
                    <div class="tautulli-vinyl-disc ${card.isPaused ? '' : 'tautulli-vinyl-spinning'}"></div>
                    ${posterHtml}
                </div>
            `;
        }

        // User Avatar image or initials circle
        let avatarHtml = '';
        if (card.userAvatarUrl && !isPrivacyMode) {
            avatarHtml = `<div class="tautulli-user-avatar"><img src="${escapeHtml(card.userAvatarUrl)}" alt="${escapeHtml(card.userName)}" /></div>`;
        } else {
            const initial = (card.userName ? card.userName.charAt(0).toUpperCase() : 'U');
            const bgColor = getAvatarColor(card.userName);
            avatarHtml = `<div class="tautulli-user-avatar" style="background: ${bgColor};">${initial}</div>`;
        }

        // Play/Pause icon
        const stateIconHtml = card.isPaused
            ? `<div class="tautulli-state-icon tautulli-state-paused" data-action="toggle-play" data-session-id="${escapeHtml(card.sessionId)}" data-paused="true" title="Click to Resume"><svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg></div>`
            : `<div class="tautulli-state-icon tautulli-state-playing" data-action="toggle-play" data-session-id="${escapeHtml(card.sessionId)}" data-paused="false" title="Click to Pause"><svg viewBox="0 0 24 24"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg></div>`;

        // ETA / Paused overlay class
        const etaClass = card.isPaused ? 'tautulli-time-paused' : 'tautulli-time-eta';

        // Direct detail link
        const detailHref = card.itemId ? `#!/details?id=${encodeURIComponent(card.itemId)}` : '#';
        const userHref = card.userId ? `#!/useredit.html?userId=${encodeURIComponent(card.userId)}` : '#';

        return `
            <div class="tautulli-card" data-session-id="${escapeHtml(card.sessionId)}">
                ${card.posterUrl ? `<div class="tautulli-card-ambient-bg" style="background-image: url('${escapeHtml(card.posterUrl)}');"></div>` : ''}
                ${card.backdropUrl ? `<div class="tautulli-card-fanart-backdrop" style="background-image: url('${escapeHtml(card.backdropUrl)}');"></div>` : ''}

                <!-- Card Header Strip: User Avatar, Client Device, Network, Platform & Actions -->
                <div class="tautulli-card-header">
                    <div class="tautulli-user-strip">
                        <a href="${userHref}" class="tautulli-user-avatar-link" title="Manage user: ${escapeHtml(card.userName)}">
                            ${avatarHtml}
                        </a>
                        <div class="tautulli-user-meta">
                            <a href="${userHref}" class="tautulli-user-name" title="${escapeHtml(card.userName)}">
                                ${escapeHtml(card.userName)}
                            </a>
                            <span class="tautulli-meta-dot">•</span>
                            <span class="tautulli-device-text" data-action="edit-device-alias" data-device-key="${escapeHtml(card.deviceId || card.player)}" data-current-name="${escapeHtml(card.player)}" title="Click to rename or set accurate phone model (e.g. iPhone 16 Pro Max)">${escapeHtml(card.player)}</span>
                            <span class="tautulli-meta-dot">•</span>
                            <span class="tautulli-client-badge" title="${escapeHtml(card.product)}">${escapeHtml(card.product)}</span>
                        </div>
                    </div>

                    <div class="tautulli-header-controls">
                        <span class="tautulli-network-pill ${escapeHtml(card.connectionClass || (card.isLan ? 'tautulli-net-lan' : 'tautulli-net-wan'))}" title="Network endpoint (${escapeHtml(card.connectionType || (card.isLan ? 'LAN' : 'WAN'))})">
                            <svg viewBox="0 0 24 24" style="width:10px;height:10px;fill:currentColor;flex-shrink:0;">
                                ${card.connectionType === 'CELLULAR' 
                                    ? '<path d="M2 17h2v4H2v-4zm4-5h2v9H6v-9zm4-4h2v13h-2V8zm4-4h2v17h-2V4zm4-3h2v20h-2V1z"/>' 
                                    : card.isLan 
                                    ? '<path d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2z"/>' 
                                    : '<path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/>'}
                            </svg>
                            ${card.connectionBadge || (card.isLan ? 'LAN' : 'WAN')} • ${escapeHtml(card.locationDisplay)}
                        </span>
                        ${card.syncPlayBadge ? `
                        <span class="tautulli-badge tautulli-badge-syncplay" title="Watch Party: Synced Playback across multiple clients">
                            <svg viewBox="0 0 24 24" style="width:9px;height:9px;fill:currentColor;flex-shrink:0;"><path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/></svg>
                            ${escapeHtml(card.syncPlayBadge)}
                        </span>` : ''}
                        ${card.isMultiIpSharing ? `
                        <span class="tautulli-badge tautulli-badge-multi-ip" title="Security Alert: Account streaming from ${card.distinctWanIpCount} distinct WAN locations concurrently. Possible credential sharing.">
                            <svg viewBox="0 0 24 24" style="width:9px;height:9px;fill:currentColor;flex-shrink:0;"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>
                            MULTI-IP (${card.distinctWanIpCount} WAN)
                        </span>` : ''}
                        ${card.isZombieTranscode ? `
                        <span class="tautulli-badge tautulli-badge-zombie" title="Zombie Transcode Pipeline: 0 playback progress detected for ${card.zombieStallDurationSec}s while transcoding.">
                            <svg viewBox="0 0 24 24" style="width:9px;height:9px;fill:currentColor;flex-shrink:0;"><path d="M12 2L1 21h22L12 2zm1 14h-2v-2h2v2zm0-4h-2v-4h2v4z"/></svg>
                            ZOMBIE (${card.zombieStallDurationSec}s)
                        </span>` : ''}
                        ${card.platformBadge ? `
                        <div class="tautulli-platform-badge" style="background: ${card.platformBadge.bg}; color: ${card.platformBadge.color};" title="${escapeHtml(card.platformBadge.title)}">
                            ${card.platformBadge.svg}
                        </div>` : ''}
                        <div class="tautulli-action-cluster">
                            ${card.isZombieTranscode ? `
                            <button class="tautulli-action-btn tautulli-btn-flush" data-action="force-flush-pipeline" data-session-id="${escapeHtml(card.sessionId)}" data-user="${escapeHtml(card.userName)}" data-title="${escapeHtml(card.primaryTitle)}" title="Force flush zombie transcode pipeline & terminate orphaned session">
                                <svg viewBox="0 0 24 24" style="width:13px;height:13px;fill:currentColor;"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
                            </button>
                            ` : ''}
                            <button class="tautulli-action-btn tautulli-action-btn-info" data-action="inspect-stream" data-session-id="${escapeHtml(card.sessionId)}" title="Stream Telemetry & Diagnostics">
                                <svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/></svg>
                            </button>
                            <button class="tautulli-action-btn" data-action="message-user" data-session-id="${escapeHtml(card.sessionId)}" data-user="${escapeHtml(card.userName)}" title="Send message to player">
                                <svg viewBox="0 0 24 24"><path d="M20 2H4c-1.1 0-1.99.9-1.99 2L2 22l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-2 12H6v-2h12v2zm0-3H6V9h12v2zm0-3H6V6h12v2z"/></svg>
                            </button>
                            <button class="tautulli-action-btn tautulli-action-btn-kill" data-action="kill-stream" data-session-id="${escapeHtml(card.sessionId)}" data-user="${escapeHtml(card.userName)}" data-title="${escapeHtml(card.primaryTitle)}" title="Terminate stream">
                                <svg viewBox="0 0 24 24"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
                        </div>
                    </div>
                </div>

                <!-- Card Body: Poster + Stream Pipeline Matrix (Overlaid onto Fanart Backdrop) -->
                <div class="tautulli-card-body">
                    <!-- Left Poster Artwork -->
                    <a href="${detailHref}" class="tautulli-poster-wrapper" title="View details: ${escapeHtml(card.primaryTitle)}">
                        ${artworkHtml}
                    </a>

                    <!-- Right Media & Stream Pipeline -->
                    <div class="tautulli-media-details">
                        <!-- Media Title & Secondary Line with Content Rating -->
                        <div class="tautulli-titles-container">
                            <div class="tautulli-title-line">
                                <a href="${detailHref}" class="tautulli-title-primary" title="${escapeHtml(card.primaryTitle)}">
                                    ${escapeHtml(card.primaryTitle)}
                                </a>
                                ${card.isAudioItem ? `
                                    <div class="tautulli-audio-spectrum ${card.isPaused ? 'tautulli-spectrum-paused' : ''}" title="${card.isPaused ? 'Audio Paused' : 'Playing Audio'}">
                                        <span class="tautulli-spectrum-bar"></span>
                                        <span class="tautulli-spectrum-bar"></span>
                                        <span class="tautulli-spectrum-bar"></span>
                                        <span class="tautulli-spectrum-bar"></span>
                                    </div>
                                ` : ''}
                                <div class="tautulli-title-secondary">
                                    ${card.officialRating ? `<span class="tautulli-rating-badge">${escapeHtml(card.officialRating)}</span>` : ''}
                                    ${card.secondaryTitle ? `<span>${escapeHtml(card.secondaryTitle)}</span>` : ''}
                                </div>
                            </div>

                            <!-- Engine Status Badges -->
                            <div class="tautulli-badge-row">
                                <span class="tautulli-badge ${badgeClass}">${badgeLabel}</span>
                                ${card.resBadge ? `<span class="tautulli-badge tautulli-badge-res" title="Source Resolution">${escapeHtml(card.resBadge)}</span>` : ''}
                                ${card.isHiResAudio ? `<span class="tautulli-badge tautulli-badge-hires" title="High-Resolution Lossless Studio Quality Master">${escapeHtml(card.hiResBadgeText)}</span>` : ''}
                                ${card.bandwidthSavingsBadge ? `<span class="tautulli-badge tautulli-badge-savings" title="Bandwidth Savings Efficiency Ratio">${escapeHtml(card.bandwidthSavingsBadge)}</span>` : ''}
                                ${hwBadgeHtml}
                                ${speedHtml}
                                ${card.isSlowTranscode ? `<span class="tautulli-badge tautulli-speed-slow ${card.isSevereStutter ? 'tautulli-stutter-alarm' : ''}" title="${card.isSevereStutter ? 'SEVERE STUTTER ALARM: Transcode speed < 1.0x for consecutive intervals. Client is starving buffer.' : 'Transcode speed < 1.0x! Client will experience buffering.'}"><svg viewBox="0 0 24 24" style="width:9px;height:9px;fill:currentColor;flex-shrink:0;"><path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/></svg>${card.isSevereStutter ? 'STUTTER ALARM (&lt;1.0x)' : 'BUFFERING (&lt;1.0x)'}</span>` : ''}
                                ${card.hdrBadge ? `<span class="tautulli-badge ${card.isToneMapped ? 'tautulli-badge-tonemap' : 'tautulli-badge-hdr'}" title="${escapeHtml(card.toneMappingDetail || card.hdrStandardDesc || 'High Dynamic Range')}">${escapeHtml(card.hdrBadge)}</span>` : ''}
                                ${card.bottleneck ? `<span class="tautulli-badge ${card.bottleneck.badgeClass}" title="${escapeHtml(card.bottleneck.title)}">${escapeHtml(card.bottleneck.badgeText)}</span>` : ''}
                                ${card.audioBadge ? `<span class="tautulli-badge tautulli-badge-audio" title="High Fidelity Audio">${escapeHtml(card.audioBadge)}</span>` : ''}
                                ${card.audioChannelsBadge ? `<span class="tautulli-badge tautulli-badge-surround" title="Audio Channels">${escapeHtml(card.audioChannelsBadge)}</span>` : ''}
                                ${card.isMuted ? `<span class="tautulli-badge" style="background:rgba(239,68,68,0.15);color:#f87171;border:1px solid rgba(239,68,68,0.3);" title="Player is muted"><svg viewBox="0 0 24 24" style="width:9px;height:9px;fill:currentColor;flex-shrink:0;"><path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/></svg>MUTED</span>` : ''}
                                ${burnInHtml}
                            </div>
                        </div>

                        <!-- Stream Pipeline Chips -->
                        <div class="tautulli-pipeline-grid">
                            <div class="tautulli-chip" title="Video stream specs: ${escapeHtml(card.videoDisplay)}">
                                <span class="tautulli-chip-icon"><svg viewBox="0 0 24 24"><path d="M18 4l2 4h-3l-2-4h-2l2 4h-3l-2-4H8l2 4H7L5 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V4h-4z"/></svg></span>
                                <span>${escapeHtml(card.videoChip)}</span>
                            </div>
                            <div class="tautulli-chip" title="Audio stream specs: ${escapeHtml(card.audioDisplay)}">
                                <span class="tautulli-chip-icon"><svg viewBox="0 0 24 24"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/></svg></span>
                                <span>${escapeHtml(card.audioChip)}</span>
                            </div>
                            <div class="tautulli-chip" title="Container format: ${escapeHtml(card.containerDisplay)}">
                                <span class="tautulli-chip-icon"><svg viewBox="0 0 24 24"><path d="M20 6h-4V4c0-1.11-.89-2-2-2h-4c-1.11 0-2 .89-2 2v2H4c-1.11 0-1.99.89-1.99 2L2 19c0 1.11.89 2 2 2h16c1.11 0 2-.89 2-2V8c0-1.11-.89-2-2-2zm-6 0h-4V4h4v2z"/></svg></span>
                                <span>${escapeHtml(card.containerChip)}</span>
                            </div>
                            <div class="tautulli-chip" title="Bandwidth & Quality: ${escapeHtml(card.qualityDisplay)}">
                                <span class="tautulli-chip-icon"><svg viewBox="0 0 24 24"><path d="M7 2v11h3v9l7-12h-4l4-8z"/></svg></span>
                                <span><strong>${escapeHtml(card.bandwidthDisplay)}</strong></span>
                            </div>
                            ${card.subChip ? `
                            <div class="tautulli-chip" title="Subtitle stream: ${escapeHtml(card.subtitleDisplay)}">
                                <span class="tautulli-chip-icon"><svg viewBox="0 0 24 24"><path d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 14H4V6h16v12zM6 10h2v2H6zm0 4h8v2H6zm10 0h2v2h-2zm-6-4h8v2h-8z"/></svg></span>
                                <span>${escapeHtml(card.subChip)}</span>
                            </div>` : ''}
                        </div>

                        <!-- Transcode Reason Banner (if applicable) -->
                        ${reasonsBannerHtml}
                    </div>
                </div>

                <!-- Card Footer: Interactive Timeline & Playback Status -->
                <div class="tautulli-card-footer">
                    <div class="tautulli-progress-row">
                        ${stateIconHtml}
                        <div class="tautulli-progress-track">
                            ${card.transcodeCompletionPercentage != null ? `<div class="tautulli-progress-buffer" style="width: ${card.transcodeCompletionPercentage}%;" title="Transcode Buffer: ${card.transcodeCompletionPercentage}%"></div>` : ''}
                            <div class="tautulli-progress-fill ${card.isPaused ? 'paused' : ''}" style="width: ${card.progressPercent}%;"></div>
                        </div>
                    </div>
                    <div class="tautulli-time-row">
                        <span class="tautulli-time-progress">${escapeHtml(card.timeProgressStr)}</span>
                        <div style="display: flex; align-items: center; gap: 8px;">
                            ${card.transcodeCompletionPercentage != null ? `<span style="color: #94a3b8; font-family: monospace; font-size: 10px;">Buffer: ${card.transcodeCompletionPercentage}%</span>` : ''}
                            <span class="${etaClass}">${escapeHtml(card.etaStr)}</span>
                        </div>
                    </div>
                </div>
            </div>
        `;
    }

    /**
     * Tautulli-Inspired Feature 5: Fetches server top watched statistics for the collapsible leaderboard drawer (Top 3 Combined).
     */
    async function fetchWatchStatistics() {
        const now = Date.now();
        if (isFetchingWatchStats) return cachedWatchStats;
        if (cachedWatchStats && (now - lastWatchStatsFetchTime < 120000)) {
            return cachedWatchStats;
        }

        const apiClient = getApiClient();
        if (!apiClient || typeof apiClient.getItems !== 'function') {
            return cachedWatchStats || { topCombined: [], topSeries: [], topMovies: [] };
        }

        isFetchingWatchStats = true;
        lastWatchStatsFetchTime = now;

        try {
            const userId = typeof apiClient.getCurrentUserId === 'function' ? apiClient.getCurrentUserId() : undefined;
            const [topMoviesResp, topEpisodesResp] = await Promise.allSettled([
                apiClient.getItems(userId, {
                    SortBy: 'PlayCount,SortName',
                    SortOrder: 'Descending',
                    IncludeItemTypes: 'Movie',
                    Limit: 10,
                    Recursive: true,
                    Fields: 'PrimaryImageAspectRatio,UserData'
                }),
                apiClient.getItems(userId, {
                    SortBy: 'PlayCount,SortName',
                    SortOrder: 'Descending',
                    IncludeItemTypes: 'Episode',
                    Limit: 50,
                    Recursive: true,
                    Fields: 'SeriesId,SeriesName,UserData'
                })
            ]);

            const movieItems = (topMoviesResp.status === 'fulfilled' && topMoviesResp.value && topMoviesResp.value.Items) ? topMoviesResp.value.Items : [];
            const episodeItems = (topEpisodesResp.status === 'fulfilled' && topEpisodesResp.value && topEpisodesResp.value.Items) ? topEpisodesResp.value.Items : [];

            // Aggregate watched episode counts per TV series
            const seriesPlayMap = new Map();
            episodeItems.forEach((ep) => {
                const sid = ep.SeriesId || ep.SeriesName;
                const plays = (ep.UserData && ep.UserData.PlayCount) || ep.PlayCount || (ep.UserData && ep.UserData.Played ? 1 : 0);
                if (sid && plays > 0) {
                    if (!seriesPlayMap.has(sid)) {
                        seriesPlayMap.set(sid, {
                            id: ep.SeriesId || ep.Id,
                            name: ep.SeriesName || ep.Name,
                            playCount: 0,
                            year: ep.ProductionYear || '',
                            type: 'TV Series'
                        });
                    }
                    seriesPlayMap.get(sid).playCount += plays;
                }
            });

            const combinedList = [];

            // Movies
            movieItems.forEach((m) => {
                const plays = (m.UserData && m.UserData.PlayCount) || m.PlayCount || 0;
                combinedList.push({
                    id: m.Id,
                    name: m.Name,
                    playCount: plays,
                    year: m.ProductionYear || '',
                    type: 'Movie',
                    imgUrl: (typeof apiClient.getImageUrl === 'function')
                        ? apiClient.getImageUrl(m.Id, { type: 'Primary', width: 120 })
                        : null
                });
            });

            // Series
            seriesPlayMap.forEach((s) => {
                combinedList.push({
                    id: s.id,
                    name: s.name,
                    playCount: s.playCount,
                    year: s.year,
                    type: 'TV Series',
                    imgUrl: (typeof apiClient.getImageUrl === 'function')
                        ? apiClient.getImageUrl(s.id, { type: 'Primary', width: 120 })
                        : null
                });
            });

            // Sort all by play count descending
            combinedList.sort((a, b) => b.playCount - a.playCount);

            // Deduplicate items by name
            const seenNames = new Set();
            const uniqueCombined = [];
            for (const item of combinedList) {
                const k = (item.name || '').toLowerCase().trim();
                if (!seenNames.has(k)) {
                    seenNames.add(k);
                    uniqueCombined.push(item);
                }
            }

            // Take Top 3 items! Prioritize items with plays > 0
            const withPlays = uniqueCombined.filter((it) => it.playCount > 0);
            const finalTop3 = withPlays.length > 0 ? withPlays.slice(0, 3) : uniqueCombined.slice(0, 3);

            cachedWatchStats = {
                topCombined: finalTop3,
                topSeries: finalTop3.filter((i) => i.type === 'TV Series'),
                topMovies: finalTop3.filter((i) => i.type === 'Movie')
            };
            return cachedWatchStats;
        } catch (err) {
            console.warn('[PlaybackCard] Failed to fetch watch statistics:', err);
        } finally {
            isFetchingWatchStats = false;
        }

        if (!cachedWatchStats) {
            cachedWatchStats = {
                topCombined: [],
                topSeries: [],
                topMovies: []
            };
        }
        return cachedWatchStats;
    }

    /**
     * Renders the Tautulli-inspired Watch Statistics Mini-Drawer (Top 3 Combined Leaderboard).
     */
    function renderWatchStatisticsDrawer(stats) {
        if (!stats) return '';
        const top3 = stats.topCombined || [];
        if (top3.length === 0) return '';

        return `
            <div class="tautulli-stats-drawer" id="tautulli-watch-stats-drawer">
                <div class="tautulli-stats-header">
                    <div class="tautulli-stats-title">
                        <svg viewBox="0 0 24 24" style="width:14px;height:14px;fill:#38bdf8;flex-shrink:0;"><path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zM9 17H7v-7h2v7zm4 0h-2V7h2v10zm4 0h-2v-4h2v4z"/></svg>
                        <span>Top 3 Watched (Server Leaderboard)</span>
                    </div>
                    <button class="tautulli-modal-tool-btn" data-action="toggle-watch-stats" style="font-size:10px;padding:3px 8px;" title="Collapse watch statistics drawer">
                        Hide Stats ✕
                    </button>
                </div>
                <div class="tautulli-stats-top3-grid">
                    ${top3.map((item, idx) => {
                        const rankClass = idx === 0 ? 'tautulli-stats-rank-1' : (idx === 1 ? 'tautulli-stats-rank-2' : 'tautulli-stats-rank-3');
                        const rankLabel = `#${idx + 1}`;
                        const metaStr = [item.type, item.year].filter(Boolean).join(' · ');
                        return `
                            <a href="#!/details?id=${encodeURIComponent(item.id)}" class="tautulli-stats-top3-card" title="${escapeHtml(item.name)} (${item.playCount} plays)">
                                <div class="tautulli-stats-top3-rank ${rankClass}">${rankLabel}</div>
                                ${item.imgUrl ? `<img class="tautulli-stats-thumb" src="${escapeHtml(item.imgUrl)}" alt="${escapeHtml(item.name)}" loading="lazy" />` : '<div class="tautulli-stats-thumb"></div>'}
                                <div class="tautulli-stats-info">
                                    <div class="tautulli-stats-name">${escapeHtml(item.name)}</div>
                                    <div class="tautulli-stats-meta">${escapeHtml(metaStr)}</div>
                                </div>
                                <div class="tautulli-stats-metric">${item.playCount} play${item.playCount === 1 ? '' : 's'}</div>
                            </a>
                        `;
                    }).join('')}
                </div>
            </div>
        `;
    }

    /**
     * Renders the overall activity container including summary header and cards.
     */
    function renderContainer(cards, idleSessions) {
        const statsDrawerHtml = (showWatchStats && cachedWatchStats) ? renderWatchStatisticsDrawer(cachedWatchStats) : '';
        const privacyBtnClass = isPrivacyMode ? 'tautulli-tool-btn active' : 'tautulli-tool-btn';
        const statsBtnClass = showWatchStats ? 'tautulli-tool-btn active' : 'tautulli-tool-btn';

        if (cards.length === 0) {
            return `
                <div class="tautulli-activity-banner">
                    <div class="tautulli-activity-left">
                        <div class="tautulli-activity-title">
                            <div class="tautulli-activity-pulse" style="background:#64748b;box-shadow:none;"></div>
                            <span>Activity</span>
                        </div>
                        <div class="tautulli-activity-stats">
                            <span>Sessions: <span class="tautulli-activity-stat-highlight">0 streams</span></span>
                            <span>|</span>
                            <span>Bandwidth: <span class="tautulli-activity-stat-highlight">0 kbps</span></span>
                        </div>
                    </div>
                    <div class="tautulli-activity-tools">
                        <button class="${statsBtnClass}" data-action="toggle-watch-stats" title="Toggle Watch Statistics Leaderboards">
                            <svg style="width:13px;height:13px;" fill="currentColor" viewBox="0 0 24 24"><path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zM9 17H7v-7h2v7zm4 0h-2V7h2v10zm4 0h-2v-4h2v4z"/></svg>
                            <span>${showWatchStats ? 'Stats On' : 'Stats'}</span>
                        </button>
                        <button class="tautulli-tool-btn" data-action="open-stream-guard" title="Smart Stream Guard: Automated stream rules & policies">
                            <svg style="width:13px;height:13px;" fill="currentColor" viewBox="0 0 24 24"><path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm-2 16l-4-4 1.41-1.41L10 14.17l6.59-6.59L18 9l-8 8z"/></svg>
                            <span>Stream Guard</span>
                            <span class="tautulli-guard-badge" title="Active guard policies">${(streamGuardRules.killPausedEnabled ? 1 : 0) + (streamGuardRules.kill4kSwEnabled ? 1 : 0) + (streamGuardRules.maxConcurrentStreams > 0 ? 1 : 0)}</span>
                        </button>
                        <button class="tautulli-tool-btn" data-action="open-servarr-modal" title="Servarr Remediations: Connect Bazarr, Radarr &amp; Sonarr for automated media &amp; subtitle fixes">
                            <svg style="width:13px;height:13px;" fill="currentColor" viewBox="0 0 24 24"><path d="M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96zM13 13v4h-2v-4H8l4-4 4 4h-3z"/></svg>
                            <span>Servarr</span>
                            ${(servarrConfig.bazarrUrl && servarrConfig.bazarrApiKey) ? '<span class="tautulli-guard-badge" title="Servarr Connected">✓</span>' : ''}
                        </button>
                        <button class="${privacyBtnClass}" data-action="toggle-privacy" title="Mask IP addresses and usernames for streaming/screenshots">
                            <svg style="width:13px;height:13px;" fill="currentColor" viewBox="0 0 24 24"><path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z"/></svg>
                            <span>${isPrivacyMode ? 'Privacy On' : 'Privacy'}</span>
                        </button>
                    </div>
                </div>
                <div class="tautulli-empty-container">
                    <svg class="tautulli-empty-icon" viewBox="0 0 24 24">
                        <path d="M21 3H3c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h5v2h8v-2h5c1.1 0 1.99-.9 1.99-2L23 5c0-1.1-.9-2-2-2zm0 14H3V5h18v12z"/>
                    </svg>
                    <div class="tautulli-empty-text">No active streams</div>
                    ${(idleSessions && idleSessions.length > 0) ? `
                    <div class="tautulli-connected-devices-container">
                        <div class="tautulli-connected-devices-title">
                            <svg style="width:12px;height:12px;" fill="currentColor" viewBox="0 0 24 24"><path d="M4 6h16v10H4z m-2 12h20v2H2z"/></svg>
                            <span>Connected Devices (${idleSessions.length})</span>
                        </div>
                        <div class="tautulli-connected-devices-grid">
                            ${idleSessions.map(s => {
                                const devName = escapeHtml(resolveDeviceModel(s));
                                const client = escapeHtml(s.Client || '');
                                const user = escapeHtml(s.UserName || 'User');
                                return `
                                    <div class="tautulli-connected-device-chip" data-action="edit-device-alias" data-device-key="${escapeHtml(s.DeviceId || s.DeviceName || s.Id)}" data-current-name="${devName}" style="cursor:pointer;" title="Click to rename or set accurate device model (e.g. iPhone 16 Pro Max)">
                                        <div class="tautulli-connected-device-icon">
                                            <svg style="width:14px;height:14px;" fill="currentColor" viewBox="0 0 24 24"><path d="M20 18c1.1 0 1.99-.9 1.99-2L22 6c0-1.1-.9-2-2-2H4c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2H0v2h24v-2h-4zM4 6h16v10H4V6z"/></svg>
                                        </div>
                                        <div class="tautulli-connected-device-info">
                                            <div class="tautulli-connected-device-name">${devName} ✎</div>
                                            <div class="tautulli-connected-device-meta">${user} · ${client}</div>
                                        </div>
                                        <div class="tautulli-connected-device-status" title="Active Jellyfin Session">Online</div>
                                    </div>
                                `;
                            }).join('')}
                        </div>
                    </div>` : ''}
                </div>
                ${statsDrawerHtml}
            `;
        }

        // Aggregate statistics for the Tautulli Activity Banner
        const totalStreams = cards.length;
        const directPlayCount = cards.filter((c) => c.isDirectPlay).length;
        const directStreamCount = cards.filter((c) => c.isDirectStream).length;
        const transcodeCount = cards.filter((c) => c.isTranscode).length;
        const zombieCount = cards.filter((c) => c.isZombieTranscode).length;
        const wanCount = cards.filter((c) => !c.isLan).length;
        const pausedCount = cards.filter((c) => c.isPaused).length;

        // Bandwidth aggregation (Total, LAN, WAN upload)
        let lanBandwidth = 0;
        let wanBandwidth = 0;
        cards.forEach((c) => {
            const bw = c.bandwidthNumber || 0;
            if (c.isLan) {
                lanBandwidth += bw;
            } else {
                wanBandwidth += bw;
            }
        });
        const totalBandwidth = lanBandwidth + wanBandwidth;

        // P1.1 Live Bandwidth Rolling History update
        bandwidthHistory.push({
            time: Date.now(),
            total: totalBandwidth,
            wan: wanBandwidth,
            lan: lanBandwidth
        });
        if (bandwidthHistory.length > MAX_BANDWIDTH_HISTORY) {
            bandwidthHistory.shift();
        }
        const sparklineHtml = renderBandwidthSparkline(bandwidthHistory, 104, 22);

        // P1.2 Multi-IP Account Sharing Detection for Activity Banner
        const hasMultiIpAlert = cards.some((c) => c.isMultiIpSharing);
        const multiIpAlertBannerHtml = hasMultiIpAlert
            ? `
                <div class="tautulli-security-alert-pill" title="Security Warning: Multiple remote WAN IP addresses detected concurrently under the same user account. Possible credential sharing.">
                    <svg style="width:11px;height:11px;" fill="currentColor" viewBox="0 0 24 24"><path d="M12 2L1 21h22L12 2zm1 14h-2v-2h2v2zm0-4h-2v-4h2v4z"/></svg>
                    <span>Multi-IP Alert</span>
                </div>
            `
            : '';

        // P1.5 Zombie Pipeline & Transcode Watchdog Banner Pill
        const pipelineStatusHtml = zombieCount > 0
            ? `
                <div class="tautulli-pipeline-pill tautulli-pipeline-zombie" title="Zombie FFmpeg Warning: Stalled transcode pipeline(s) detected with no playback progress for >=15 seconds.">
                    <svg viewBox="0 0 24 24" style="width:10px;height:10px;fill:currentColor;flex-shrink:0;"><path d="M12 2L1 21h22L12 2zm1 14h-2v-2h2v2zm0-4h-2v-4h2v4z"/></svg>
                    <span>Zombie FFmpeg: ${zombieCount} Stalled</span>
                </div>
            `
            : (transcodeCount > 0
                ? `
                    <div class="tautulli-pipeline-pill" title="Active Transcode Pipelines: Real-time FFmpeg worker processes">
                        <svg viewBox="0 0 24 24" style="width:10px;height:10px;fill:currentColor;flex-shrink:0;"><path d="M7 2v11h3v9l7-12h-4l4-8z"/></svg>
                        <span>${transcodeCount} Active Pipeline${transcodeCount > 1 ? 's' : ''}</span>
                    </div>
                `
                : '');

        const breakdownParts = [];
        if (directPlayCount > 0) breakdownParts.push(`${directPlayCount} direct play${directPlayCount > 1 ? 's' : ''}`);
        if (directStreamCount > 0) breakdownParts.push(`${directStreamCount} direct stream${directStreamCount > 1 ? 's' : ''}`);
        if (transcodeCount > 0) breakdownParts.push(`${transcodeCount} transcode${transcodeCount > 1 ? 's' : ''}`);

        const breakdownStr = breakdownParts.length > 0 ? `(${breakdownParts.join(', ')})` : '';

        // Bandwidth detail string (matching Tautulli activity header)
        let bandwidthDetail = formatBitrate(totalBandwidth);
        if (totalBandwidth > 0) {
            if (wanBandwidth > 0 && lanBandwidth > 0) {
                bandwidthDetail = `${formatBitrate(totalBandwidth)} (LAN: ${formatBitrate(lanBandwidth)} | WAN: ${formatBitrate(wanBandwidth)})`;
            } else if (wanBandwidth > 0) {
                bandwidthDetail = `${formatBitrate(totalBandwidth)} (WAN: ${formatBitrate(wanBandwidth)})`;
            } else {
                bandwidthDetail = `${formatBitrate(totalBandwidth)} (LAN: ${formatBitrate(lanBandwidth)})`;
            }
        }

        const lanPercent = totalBandwidth > 0 ? Math.round((lanBandwidth / totalBandwidth) * 100) : 0;
        const wanPercent = totalBandwidth > 0 ? (100 - lanPercent) : 0;
        const bandwidthVisualHtml = totalBandwidth > 0
            ? `<div class="tautulli-bandwidth-visual" title="LAN: ${formatBitrate(lanBandwidth)} (${lanPercent}%) | WAN: ${formatBitrate(wanBandwidth)} (${wanPercent}%)"><div class="tautulli-bandwidth-bar-lan" style="width:${lanPercent}%;"></div><div class="tautulli-bandwidth-bar-wan" style="width:${wanPercent}%;"></div></div>`
            : '';

        // Filter active cards based on current user selection
        let displayedCards = cards;
        if (currentFilter === 'transcode') {
            displayedCards = cards.filter((c) => c.isTranscode);
        } else if (currentFilter === 'wan') {
            displayedCards = cards.filter((c) => !c.isLan);
        } else if (currentFilter === 'paused') {
            displayedCards = cards.filter((c) => c.isPaused);
        }

        const cardsContentHtml = displayedCards.length > 0
            ? `<div class="tautulli-grid">${displayedCards.map(renderSessionCard).join('')}</div>`
            : `
                <div class="tautulli-empty-container">
                    <div class="tautulli-empty-text">No active streams matching filter "${escapeHtml(currentFilter)}"</div>
                </div>
            `;

        return `
            <div class="tautulli-activity-banner">
                <div class="tautulli-activity-left">
                    <div class="tautulli-activity-title">
                        <div class="tautulli-activity-pulse"></div>
                        <span>Activity</span>
                    </div>
                    <div class="tautulli-activity-stats">
                        <span>Sessions: <span class="tautulli-activity-stat-highlight">${totalStreams} stream${totalStreams > 1 ? 's' : ''}</span> ${breakdownStr}</span>
                        <span>|</span>
                        <span>Bandwidth: <span class="tautulli-activity-stat-highlight">${bandwidthDetail}</span>${bandwidthVisualHtml}${sparklineHtml}</span>
                    </div>
                    ${multiIpAlertBannerHtml}
                    ${pipelineStatusHtml}
                    ${totalStreams > 1 ? `
                    <div class="tautulli-filter-group">
                        <button class="tautulli-filter-pill ${currentFilter === 'all' ? 'active' : ''}" data-action="set-filter" data-filter="all">All (${totalStreams})</button>
                        ${transcodeCount > 0 ? `<button class="tautulli-filter-pill ${currentFilter === 'transcode' ? 'active' : ''}" data-action="set-filter" data-filter="transcode">Transcode (${transcodeCount})</button>` : ''}
                        ${wanCount > 0 ? `<button class="tautulli-filter-pill ${currentFilter === 'wan' ? 'active' : ''}" data-action="set-filter" data-filter="wan">WAN (${wanCount})</button>` : ''}
                        ${pausedCount > 0 ? `<button class="tautulli-filter-pill ${currentFilter === 'paused' ? 'active' : ''}" data-action="set-filter" data-filter="paused">Paused (${pausedCount})</button>` : ''}
                    </div>` : ''}
                </div>

                <div class="tautulli-activity-tools">
                    <button class="${statsBtnClass}" data-action="toggle-watch-stats" title="Toggle Watch Statistics Leaderboards">
                        <svg style="width:13px;height:13px;" fill="currentColor" viewBox="0 0 24 24"><path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zM9 17H7v-7h2v7zm4 0h-2V7h2v10zm4 0h-2v-4h2v4z"/></svg>
                        <span>${showWatchStats ? 'Stats On' : 'Stats'}</span>
                    </button>
                    <button class="tautulli-tool-btn" data-action="open-stream-guard" title="Smart Stream Guard: Automated stream rules & policies">
                        <svg style="width:13px;height:13px;" fill="currentColor" viewBox="0 0 24 24"><path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm-2 16l-4-4 1.41-1.41L10 14.17l6.59-6.59L18 9l-8 8z"/></svg>
                        <span>Stream Guard</span>
                        <span class="tautulli-guard-badge" title="Active guard policies">${(streamGuardRules.killPausedEnabled ? 1 : 0) + (streamGuardRules.kill4kSwEnabled ? 1 : 0) + (streamGuardRules.maxConcurrentStreams > 0 ? 1 : 0)}</span>
                    </button>
                    <button class="tautulli-tool-btn" data-action="open-servarr-modal" title="Servarr Remediations: Connect Bazarr, Radarr &amp; Sonarr for automated media &amp; subtitle fixes">
                        <svg style="width:13px;height:13px;" fill="currentColor" viewBox="0 0 24 24"><path d="M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96zM13 13v4h-2v-4H8l4-4 4 4h-3z"/></svg>
                        <span>Servarr</span>
                        ${(servarrConfig.bazarrUrl && servarrConfig.bazarrApiKey) ? '<span class="tautulli-guard-badge" title="Servarr Connected">✓</span>' : ''}
                    </button>
                    <button class="${privacyBtnClass}" data-action="toggle-privacy" title="Mask IP addresses and usernames for streaming/screenshots">
                        <svg style="width:13px;height:13px;" fill="currentColor" viewBox="0 0 24 24"><path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z"/></svg>
                        <span>${isPrivacyMode ? 'Privacy On' : 'Privacy'}</span>
                    </button>
                </div>
            </div>
            ${cardsContentHtml}
            ${statsDrawerHtml}
        `;
    }

    /**
     * Renders and displays the Stream Details Inspector modal.
     */
    /**
     * Keydown handler to dismiss the inspector modal via Escape key.
     */
    function handleModalEscape(e) {
        if (e.key === 'Escape') {
            closeStreamInspectorModal();
        }
    }

    /**
     * Copies text to clipboard with fallback.
     */
    function copyTextToClipboard(text, btnElement) {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(() => {
                const lbl = btnElement && btnElement.querySelector('.copy-label');
                if (lbl) lbl.textContent = '✓ Copied!';
                setTimeout(() => { if (lbl) lbl.textContent = 'Copy Telemetry'; }, 2000);
            }).catch(() => fallbackPromptCopy(text));
        } else {
            fallbackPromptCopy(text);
        }
    }

    function fallbackPromptCopy(text) {
        try {
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.style.position = 'fixed';
            ta.style.left = '-9999px';
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            ta.remove();
        } catch (e) {
            window.prompt('Copy telemetry data:', text);
        }
    }

    /**
     * Renders and displays the Stream Details Inspector modal.
     */
    function openStreamInspectorModal(card) {
        if (!card) return;
        closeStreamInspectorModal();

        const backdrop = document.createElement('div');
        backdrop.id = 'tautulli-inspector-modal-backdrop';
        backdrop.className = 'tautulli-modal-backdrop';
        backdrop.onclick = function (e) {
            if (e.target === backdrop) {
                closeStreamInspectorModal();
            }
        };

        const modal = document.createElement('div');
        modal.className = 'tautulli-modal';
        modal.innerHTML = `
            <div class="tautulli-modal-header">
                <div class="tautulli-modal-title">
                    <svg viewBox="0 0 24 24" style="width:16px;height:16px;fill:currentColor;flex-shrink:0;"><path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zM9 17H7v-7h2v7zm4 0h-2V7h2v10zm4 0h-2v-4h2v4z"/></svg>
                    <span>Stream Diagnostics &amp; Telemetry</span>
                </div>
                <div class="tautulli-modal-header-actions">
                    <button class="tautulli-modal-tool-btn" data-action="copy-telemetry" title="Copy raw session telemetry to clipboard">
                        <svg style="width:12px;height:12px;" fill="currentColor" viewBox="0 0 24 24"><path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg>
                        <span class="copy-label">Copy Telemetry</span>
                    </button>
                    <button class="tautulli-modal-close" data-action="close-modal" title="Close">
                        <svg style="width:14px;height:14px;" fill="currentColor" viewBox="0 0 24 24"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
                    </button>
                </div>
            </div>

            <!-- P1.3 Bottleneck Splitter (Root Cause Diagnosis) -->
            <div class="tautulli-modal-section">
                <div class="tautulli-modal-section-title">
                    <svg viewBox="0 0 24 24" style="width:13px;height:13px;fill:currentColor;flex-shrink:0;"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/></svg>
                    <span>Bottleneck Splitter (Root Cause Analysis)</span>
                </div>
                <table class="tautulli-modal-table">
                    <tr><td>Performance State</td><td><span class="tautulli-badge ${card.bottleneck ? card.bottleneck.badgeClass : 'tautulli-bottleneck-healthy'}">${escapeHtml(card.bottleneck ? card.bottleneck.badgeText : 'Pipeline Healthy')}</span></td></tr>
                    <tr><td>Primary Diagnosis</td><td><strong>${escapeHtml(card.bottleneck ? card.bottleneck.shortName : 'Optimal')}</strong></td></tr>
                    <tr><td>Technical Finding</td><td>${escapeHtml(card.bottleneck ? card.bottleneck.explanation : 'Encoder speed and transmission throughput are balanced.')}</td></tr>
                    <tr><td>Admin Recommendation</td><td style="color:#38bdf8;">${escapeHtml(card.bottleneck ? card.bottleneck.recommendation : 'No intervention needed.')}</td></tr>
                </table>
            </div>

            <!-- Media Source Telemetry -->
            <div class="tautulli-modal-section">
                <div class="tautulli-modal-section-title">
                    <svg viewBox="0 0 24 24" style="width:13px;height:13px;fill:currentColor;flex-shrink:0;"><path d="M18 4l2 4h-3l-2-4h-2l2 4h-3l-2-4H8l2 4H7L5 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V4h-4z"/></svg>
                    <span>Media Source Specs</span>
                </div>
                <table class="tautulli-modal-table">
                    <tr><td>Media Title</td><td>${escapeHtml(card.primaryTitle)}</td></tr>
                    <tr><td>Production Year &amp; Duration</td><td>${escapeHtml(card.secondaryTitle || 'N/A')}</td></tr>
                    <tr><td>Container</td><td>${escapeHtml(card.containerDisplay)}</td></tr>
                    <tr><td>Video Codec &amp; Resolution</td><td>${escapeHtml(card.videoDisplay)}</td></tr>
                    ${card.videoProfile ? `<tr><td>Video Profile &amp; Bit Depth</td><td>${escapeHtml(card.videoProfile)} (${escapeHtml(card.videoBitDepth || '8-bit')})</td></tr>` : ''}
                    ${card.videoFrameRate ? `<tr><td>Source Frame Rate</td><td>${escapeHtml(card.videoFrameRate)}</td></tr>` : ''}
                    ${card.colorSpace ? `<tr><td>Color Space / Gamut</td><td>${escapeHtml(card.colorSpace)}${card.colorPrimaries ? ` (${escapeHtml(card.colorPrimaries.toUpperCase())})` : ''} ${card.hdrBadge ? `[${escapeHtml(card.hdrBadge)}]` : ''}</td></tr>` : ''}
                    ${card.colorTransfer ? `<tr><td>Transfer Characteristics</td><td>${escapeHtml(card.colorTransfer)} ${card.hdrStandardDesc ? `(${escapeHtml(card.hdrStandardDesc)})` : ''}</td></tr>` : ''}
                    ${card.isToneMapped ? `<tr><td>HDR Tone Mapping</td><td><span style="color:#f59e0b;font-weight:600;">Active · ${escapeHtml(card.toneMappingDetail)}</span></td></tr>` : ''}
                    <tr><td>Stream Bitrate</td><td>${escapeHtml(card.bandwidthDisplay)}</td></tr>
                </table>
            </div>

            <!-- Audio & Subtitles -->
            <div class="tautulli-modal-section">
                <div class="tautulli-modal-section-title">
                    <svg viewBox="0 0 24 24" style="width:13px;height:13px;fill:currentColor;flex-shrink:0;"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/></svg>
                    <span>Audio &amp; Subtitle Specs</span>
                </div>
                <table class="tautulli-modal-table">
                    <tr><td>Audio Stream</td><td>${escapeHtml(card.audioDisplay)}</td></tr>
                    ${card.audioSampleRate ? `<tr><td>Audio Sample Rate</td><td>${escapeHtml(card.audioSampleRate)}</td></tr>` : ''}
                    ${card.audioBitRate ? `<tr><td>Audio Bitrate</td><td>${escapeHtml(card.audioBitRate)}</td></tr>` : ''}
                    ${card.audioBadge ? `<tr><td>Audio Fidelity</td><td><span style="color:#a5b4fc;font-weight:700;">${escapeHtml(card.audioBadge)}</span></td></tr>` : ''}
                    <tr><td>Subtitle Stream</td><td>${escapeHtml(card.subtitleDisplay)}</td></tr>
                    ${card.isSubtitleBurnIn ? `<tr><td>Subtitle Burn-In</td><td><span style="color:#fbbf24;font-weight:700;">Active (Subtitles Forcing Transcode)</span></td></tr>` : ''}
                    ${card.canRemediateSubtitlesWithBazarr ? `
                    <tr><td>Subtitle Remediation</td><td>
                        <div style="display:flex;align-items:center;gap:8px;">
                            <span style="color:#fbbf24;font-size:11px;">Image subtitles forcing transcode</span>
                            <button class="tautulli-servarr-btn" data-action="fetch-srt-bazarr" data-session-id="${escapeHtml(card.sessionId)}" data-title="${escapeHtml(card.mediaItemName || card.primaryTitle)}" style="padding:2px 8px;font-size:10.5px;">
                                <svg viewBox="0 0 24 24" style="width:11px;height:11px;fill:currentColor;"><path d="M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96zM13 13v4h-2v-4H8l4-4 4 4h-3z"/></svg>
                                <span>Fetch SRT (Bazarr)</span>
                            </button>
                        </div>
                    </td></tr>` : ''}
                </table>
            </div>

            <!-- Transcode Pipeline -->
            ${card.isTranscode ? `
            <div class="tautulli-modal-section">
                <div class="tautulli-modal-section-title">
                    <svg viewBox="0 0 24 24" style="width:13px;height:13px;fill:currentColor;flex-shrink:0;"><path d="M7 2v11h3v9l7-12h-4l4-8z"/></svg>
                    <span style="color:#f87171;">Transcode Pipeline</span>
                </div>
                <table class="tautulli-modal-table">
                    <tr><td>Hardware Acceleration</td><td>${escapeHtml(card.hwAccelBadge || (card.isSwTranscode ? 'Software (CPU)' : 'None'))}</td></tr>
                    ${card.transcodeFps ? `<tr><td>Transcoding FPS &amp; Speed</td><td>${escapeHtml(card.transcodeFps)} fps (${escapeHtml(card.transcodeSpeedMultiplier)}x real-time)</td></tr>` : ''}
                    ${card.transcodeCompletionPercentage != null ? `<tr><td>Transcode Buffer Ahead</td><td>${card.transcodeCompletionPercentage}% completed</td></tr>` : ''}
                    <tr><td>Throttled State</td><td>${card.isThrottled ? '<span style="color:#34d399;">Active (Throttled / Power Saving)</span>' : 'Unthrottled'}</td></tr>
                    ${card.transcodeReasons.length > 0 ? `<tr><td>Transcode Triggers</td><td>${escapeHtml(card.transcodeReasons.map(formatTranscodeReason).join(', '))}</td></tr>` : ''}
                    ${card.isZombieTranscode ? `
                    <tr><td>Pipeline Watchdog</td><td><span style="color:#ef4444;font-weight:700;"><svg viewBox="0 0 24 24" style="width:11px;height:11px;fill:currentColor;vertical-align:text-bottom;margin-right:4px;"><path d="M12 2L1 21h22L12 2zm1 14h-2v-2h2v2zm0-4h-2v-4h2v4z"/></svg>Zombie Stalled (${card.zombieStallDurationSec}s no progress)</span></td></tr>
                    <tr><td>Pipeline Action</td><td>
                        <button class="tautulli-btn-flush" data-action="force-flush-pipeline" data-session-id="${escapeHtml(card.sessionId)}" data-user="${escapeHtml(card.userName)}" data-title="${escapeHtml(card.primaryTitle)}" style="display:inline-flex;padding:3px 10px;border-radius:4px;cursor:pointer;font-size:11px;font-weight:700;">
                            Force Flush Pipeline
                        </button>
                    </td></tr>
                    ` : '<tr><td>Pipeline Watchdog</td><td><span style="color:#34d399;font-weight:600;">Normal Active Flow</span></td></tr>'}
                </table>
            </div>` : ''}

            <!-- Servarr Media Deep Links -->
            <div class="tautulli-modal-section">
                <div class="tautulli-modal-section-title">
                    <svg viewBox="0 0 24 24" style="width:13px;height:13px;fill:currentColor;flex-shrink:0;"><path d="M3.9 12c0-1.71 1.39-3.1 3.1-3.1h4V7H7c-2.76 0-5 2.24-5 5s2.24 5 5 5h4v-1.9H7c-1.71 0-3.1-1.39-3.1-3.1zM8 13h8v-2H8v2zm9-6h-4v1.9h4c1.71 0 3.1 1.39 3.1 3.1s-1.39 3.1-3.1 3.1h-4V17h4c2.76 0 5-2.24 5-5s-2.24-5-5-5z"/></svg>
                    <span>Servarr Automation Deep Links</span>
                </div>
                <table class="tautulli-modal-table">
                    <tr><td>Media Identity</td><td>${escapeHtml(card.mediaItemName || card.primaryTitle)} ${card.mediaItemYear ? `(${card.mediaItemYear})` : ''} [${escapeHtml(card.mediaItemType || 'Media')}]</td></tr>
                    <tr><td>Remediation Links</td><td>
                        <div style="display:flex;flex-wrap:wrap;align-items:center;gap:6px;">
                            ${servarrConfig.bazarrUrl ? `
                            <a href="${servarrConfig.bazarrUrl.replace(/\/$/, '')}/series" target="_blank" rel="noopener noreferrer" class="tautulli-servarr-btn" style="text-decoration:none;">
                                <span>Open in Bazarr ➔</span>
                            </a>` : ''}
                            ${(card.mediaItemType === 'Episode' || card.seriesName) ? (servarrConfig.sonarrUrl ? `
                            <a href="${servarrConfig.sonarrUrl.replace(/\/$/, '')}/series" target="_blank" rel="noopener noreferrer" class="tautulli-servarr-btn" style="text-decoration:none;">
                                <span>Open in Sonarr ➔</span>
                            </a>` : '') : (servarrConfig.radarrUrl ? `
                            <a href="${servarrConfig.radarrUrl.replace(/\/$/, '')}/movies" target="_blank" rel="noopener noreferrer" class="tautulli-servarr-btn" style="text-decoration:none;">
                                <span>Open in Radarr ➔</span>
                            </a>` : '')}
                            <button class="tautulli-tool-btn" data-action="open-servarr-modal" style="font-size:10px;padding:3px 8px;">
                                <span>Configure Servarr URLs</span>
                            </button>
                        </div>
                    </td></tr>
                </table>
            </div>

            <!-- Client & Player -->
            <div class="tautulli-modal-section">
                <div class="tautulli-modal-section-title">
                    <svg viewBox="0 0 24 24" style="width:13px;height:13px;fill:currentColor;flex-shrink:0;"><path d="M4 6h16v10H4V6zm16 12H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2h16c1.1 0 2 .9 2 2v10c0 1.1-.9 2-2 2zm-8 1.5c.83 0 1.5-.67 1.5-1.5s-.67-1.5-1.5-1.5-1.5.67-1.5 1.5.67 1.5 1.5 1.5z"/></svg>
                    <span>Client &amp; Network</span>
                </div>
                <table class="tautulli-modal-table">
                    <tr><td>User Account</td><td>${escapeHtml(card.userName)}</td></tr>
                    <tr><td>Device Name</td><td>${escapeHtml(card.player)}</td></tr>
                    <tr><td>Client App</td><td>${escapeHtml(card.product)}</td></tr>
                    <tr><td>Network Endpoint</td><td>${card.isLan ? 'LAN (Local Private Network)' : `WAN (Remote Endpoint: ${escapeHtml(card.locationDisplay)})`}</td></tr>
                    <tr><td>Multi-Location Check</td><td>${card.isMultiIpSharing ? `<span style="color:#f87171;font-weight:700;">Flagged: ${card.distinctWanIpCount} Distinct WAN IPs streaming concurrently</span>` : '<span style="color:#34d399;">Authorized Single Household</span>'}</td></tr>
                    ${card.isMuted ? `<tr><td>Audio State</td><td><span style="color:#f87171;font-weight:700;">Muted</span></td></tr>` : ''}
                    ${card.volumeLevel != null ? `<tr><td>Volume Level</td><td>${card.volumeLevel}%</td></tr>` : ''}
                    <tr><td>Session ID</td><td style="font-size:10px;word-break:break-all;">${escapeHtml(card.sessionId)}</td></tr>
                </table>
            </div>
        `;

        const copyBtn = modal.querySelector('[data-action="copy-telemetry"]');
        if (copyBtn) {
            copyBtn.onclick = function () {
                const diag = {
                    title: card.primaryTitle,
                    media: card.secondaryTitle,
                    playMethod: card.playMethod,
                    bottleneck: card.bottleneck ? card.bottleneck.shortName : 'Healthy',
                    container: card.containerDisplay,
                    video: card.videoDisplay,
                    videoProfile: card.videoProfile,
                    videoBitDepth: card.videoBitDepth,
                    framerate: card.videoFrameRate,
                    colorSpace: card.colorSpace,
                    colorTransfer: card.colorTransfer,
                    colorPrimaries: card.colorPrimaries,
                    toneMapping: card.toneMappingDetail || (card.isToneMapped ? 'Active' : 'Direct'),
                    hdr: card.hdrBadge,
                    resolution: card.resBadge,
                    audio: card.audioDisplay,
                    audioChannels: card.audioChannelsBadge,
                    audioFidelity: card.audioBadge,
                    sampleRate: card.audioSampleRate,
                    audioBitrate: card.audioBitRate,
                    subtitles: card.subtitleDisplay,
                    subBurnIn: card.isSubtitleBurnIn,
                    bitrate: card.bandwidthDisplay,
                    transcodeReasons: card.transcodeReasons,
                    hwAccel: card.hwAccelBadge || (card.isSwTranscode ? 'Software' : 'None'),
                    fps: card.transcodeFps,
                    speed: card.transcodeSpeedMultiplier ? `${card.transcodeSpeedMultiplier}x` : null,
                    user: card.userName,
                    client: card.product,
                    device: card.player,
                    network: card.isLan ? 'LAN' : 'WAN',
                    location: card.locationDisplay,
                    multiIpSharing: card.isMultiIpSharing ? `${card.distinctWanIpCount} WAN IPs` : 'None',
                    sessionId: card.sessionId
                };
                copyTextToClipboard(JSON.stringify(diag, null, 2), copyBtn);
            };
        }

        modal.onclick = function (e) {
            const target = e.target.closest('[data-action]');
            if (!target) return;
            const action = target.getAttribute('data-action');
            if (action === 'close-modal') {
                closeStreamInspectorModal();
            } else if (action === 'force-flush-pipeline') {
                closeStreamInspectorModal();
                handleFlushPipeline(card.sessionId, card.userName, card.primaryTitle);
            } else if (action === 'fetch-srt-bazarr') {
                handleFetchSrtBazarr(card.sessionId, card.mediaItemName || card.primaryTitle);
            } else if (action === 'open-servarr-modal') {
                closeStreamInspectorModal();
                openServarrModal();
            }
        };

        backdrop.appendChild(modal);
        document.body.appendChild(backdrop);
        document.addEventListener('keydown', handleModalEscape);
    }

    /**
     * Closes the active stream inspector modal if open.
     */
    function closeStreamInspectorModal() {
        document.removeEventListener('keydown', handleModalEscape);
        const existing = document.getElementById('tautulli-inspector-modal-backdrop');
        if (existing) {
            existing.remove();
        }
    }

    /**
     * Keydown handler to dismiss the Stream Guard modal via Escape key.
     */
    function handleGuardModalEscape(e) {
        if (e.key === 'Escape') {
            closeStreamGuardModal();
        }
    }

    /**
     * Renders and displays the Smart Stream Guard configuration modal.
     */
    function openStreamGuardModal() {
        closeStreamGuardModal();

        const backdrop = document.createElement('div');
        backdrop.id = 'tautulli-guard-modal-backdrop';
        backdrop.className = 'tautulli-modal-backdrop';
        backdrop.onclick = function (e) {
            if (e.target === backdrop) {
                closeStreamGuardModal();
            }
        };

        const modal = document.createElement('div');
        modal.className = 'tautulli-modal';
        modal.innerHTML = `
            <div class="tautulli-modal-header">
                <div class="tautulli-modal-title">
                    <svg viewBox="0 0 24 24" style="width:16px;height:16px;fill:currentColor;flex-shrink:0;"><path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm-2 16l-4-4 1.41-1.41L10 14.17l6.59-6.59L18 9l-8 8z"/></svg>
                    <span>Smart Stream Guard (Automated Rules)</span>
                </div>
                <div class="tautulli-modal-header-actions">
                    <button class="tautulli-modal-close" data-action="close-guard-modal" title="Close">
                        <svg style="width:14px;height:14px;" fill="currentColor" viewBox="0 0 24 24"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
                    </button>
                </div>
            </div>

            <!-- Rule 1: Auto-Kill Paused Streams -->
            <div class="tautulli-rule-card">
                <div class="tautulli-rule-row">
                    <div>
                        <div class="tautulli-rule-title">Auto-Kill Paused Streams</div>
                        <div class="tautulli-rule-desc">Automatically terminates sessions paused longer than threshold to free transcode slots and network sockets.</div>
                    </div>
                    <label class="tautulli-switch">
                        <input type="checkbox" id="guard-rule-paused" ${streamGuardRules.killPausedEnabled ? 'checked' : ''}>
                        <span class="tautulli-slider"></span>
                    </label>
                </div>
                <div style="display:flex;align-items:center;gap:8px;font-size:11.5px;color:#cbd5e1;padding-top:4px;">
                    <span>Terminate after:</span>
                    <input type="number" id="guard-paused-minutes" class="tautulli-rule-input" min="1" max="120" value="${streamGuardRules.killPausedMinutes}">
                    <span>minutes of inactivity</span>
                </div>
            </div>

            <!-- Rule 2: Block 4K Software Transcodes -->
            <div class="tautulli-rule-card">
                <div class="tautulli-rule-row">
                    <div>
                        <div class="tautulli-rule-title">Block 4K CPU Software Transcodes</div>
                        <div class="tautulli-rule-desc">Instantly terminates unaccelerated 4K CPU transcodes that peg CPU at 100% and alerts the client player with educational advice.</div>
                    </div>
                    <label class="tautulli-switch">
                        <input type="checkbox" id="guard-rule-4k" ${streamGuardRules.kill4kSwEnabled ? 'checked' : ''}>
                        <span class="tautulli-slider"></span>
                    </label>
                </div>
            </div>

            <!-- Rule 3: Concurrent Streams per User Cap -->
            <div class="tautulli-rule-card">
                <div class="tautulli-rule-row">
                    <div>
                        <div class="tautulli-rule-title">Concurrent Streams Limit per User</div>
                        <div class="tautulli-rule-desc">Prevents account sharing by terminating the newest excess playback session if a user exceeds maximum simultaneous streams.</div>
                    </div>
                    <div style="display:flex;align-items:center;gap:8px;">
                        <input type="number" id="guard-concurrent-limit" class="tautulli-rule-input" min="0" max="10" value="${streamGuardRules.maxConcurrentStreams}">
                        <span style="font-size:11px;color:#94a3b8;">(0 = unlimited)</span>
                    </div>
                </div>
            </div>

            <!-- Auto-Kill Event Log -->
            <div style="margin-top:16px;">
                <div style="font-size:11px;font-weight:700;text-transform:uppercase;color:#38bdf8;margin-bottom:8px;display:flex;align-items:center;justify-content:space-between;">
                    <span>Recent Guard Enforcement Log (${autoKillEventsLog.length})</span>
                    ${autoKillEventsLog.length > 0 ? `<span style="font-size:10px;color:#94a3b8;cursor:pointer;" id="guard-clear-log">Clear Log</span>` : ''}
                </div>
                <div style="max-height:140px;overflow-y:auto;border-radius:8px;background:rgba(0,0,0,0.3);border:1px solid rgba(255,255,255,0.06);padding:6px 10px;">
                    ${autoKillEventsLog.length === 0 
                        ? `<div style="font-size:11px;color:#64748b;text-align:center;padding:12px 0;">No automated enforcement actions triggered yet</div>`
                        : autoKillEventsLog.map(item => `
                            <div style="font-size:11px;padding:4px 0;border-bottom:1px solid rgba(255,255,255,0.04);display:flex;justify-content:space-between;gap:8px;">
                                <span style="color:#f87171;font-weight:600;">[Auto-Killed] ${escapeHtml(item.userName)}</span>
                                <span style="color:#94a3b8;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(item.title)}</span>
                                <span style="color:#fbbf24;font-size:10px;flex-shrink:0;">${escapeHtml(item.reason)}</span>
                            </div>
                        `).join('')}
                </div>
            </div>

            <div style="margin-top:18px;display:flex;justify-content:flex-end;gap:8px;">
                <button class="tautulli-modal-tool-btn" id="guard-save-btn" style="background:rgba(0,164,220,0.3);border-color:#38bdf8;color:#ffffff;font-size:12px;padding:6px 16px;">
                    Save &amp; Apply Guard Rules
                </button>
            </div>
        `;

        modal.querySelector('[data-action="close-guard-modal"]').onclick = closeStreamGuardModal;

        const clearLogBtn = modal.querySelector('#guard-clear-log');
        if (clearLogBtn) {
            clearLogBtn.onclick = function () {
                autoKillEventsLog.length = 0;
                openStreamGuardModal();
            };
        }

        const saveBtn = modal.querySelector('#guard-save-btn');
        if (saveBtn) {
            saveBtn.onclick = function () {
                const pausedChk = modal.querySelector('#guard-rule-paused');
                const pausedMin = modal.querySelector('#guard-paused-minutes');
                const fourKChk = modal.querySelector('#guard-rule-4k');
                const concurrentInp = modal.querySelector('#guard-concurrent-limit');

                streamGuardRules.killPausedEnabled = pausedChk ? pausedChk.checked : false;
                streamGuardRules.killPausedMinutes = pausedMin ? Math.max(1, parseInt(pausedMin.value, 10) || 15) : 15;
                streamGuardRules.kill4kSwEnabled = fourKChk ? fourKChk.checked : false;
                streamGuardRules.maxConcurrentStreams = concurrentInp ? Math.max(0, parseInt(concurrentInp.value, 10) || 0) : 0;

                saveStreamGuardRules(streamGuardRules);
                closeStreamGuardModal();
                lastRenderedHash = '';
                fetchAndRenderSessions();
            };
        }

        backdrop.appendChild(modal);
        document.body.appendChild(backdrop);
        document.addEventListener('keydown', handleGuardModalEscape);
    }

    /**
     * Closes the active Stream Guard modal if open.
     */
    function closeStreamGuardModal() {
        document.removeEventListener('keydown', handleGuardModalEscape);
        const existing = document.getElementById('tautulli-guard-modal-backdrop');
        if (existing) {
            existing.remove();
        }
    }

    /**
     * Keydown handler to dismiss the Servarr Remediation modal via Escape key.
     */
    function handleServarrModalEscape(e) {
        if (e.key === 'Escape') {
            closeServarrModal();
        }
    }

    /**
     * Renders and displays the Servarr Remediation Suite configuration modal.
     */
    function openServarrModal() {
        closeServarrModal();

        const backdrop = document.createElement('div');
        backdrop.id = 'tautulli-servarr-modal-backdrop';
        backdrop.className = 'tautulli-modal-backdrop';
        backdrop.onclick = function (e) {
            if (e.target === backdrop) {
                closeServarrModal();
            }
        };

        const modal = document.createElement('div');
        modal.className = 'tautulli-modal';
        modal.innerHTML = `
            <div class="tautulli-modal-header">
                <div class="tautulli-modal-title">
                    <svg viewBox="0 0 24 24" style="width:16px;height:16px;fill:currentColor;flex-shrink:0;"><path d="M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96zM13 13v4h-2v-4H8l4-4 4 4h-3z"/></svg>
                    <span>Servarr Remediation Suite (Bazarr · Radarr · Sonarr)</span>
                </div>
                <div class="tautulli-modal-header-actions">
                    <button class="tautulli-modal-close" data-action="close-servarr-modal" title="Close">
                        <svg style="width:14px;height:14px;" fill="currentColor" viewBox="0 0 24 24"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
                    </button>
                </div>
            </div>

            <!-- Bazarr Configuration -->
            <div class="tautulli-rule-card">
                <div class="tautulli-rule-row">
                    <div>
                        <div class="tautulli-rule-title">Bazarr (Subtitle Automation)</div>
                        <div class="tautulli-rule-desc">Automatically trigger searches for text SRT subtitles when PGS/VOBSUB subtitles force CPU transcode burn-in.</div>
                    </div>
                </div>
                <div class="tautulli-form-row">
                    <label class="tautulli-form-label">Bazarr Base URL</label>
                    <input type="text" id="servarr-bazarr-url" class="tautulli-input" placeholder="http://192.168.1.50:6767" value="${escapeHtml(servarrConfig.bazarrUrl || '')}">
                </div>
                <div class="tautulli-form-row" style="margin-top:6px;">
                    <label class="tautulli-form-label">Bazarr API Key</label>
                    <input type="password" id="servarr-bazarr-api-key" class="tautulli-input" placeholder="Enter API Key from Bazarr Settings &gt; General" value="${escapeHtml(servarrConfig.bazarrApiKey || '')}">
                </div>
            </div>

            <!-- Radarr Configuration -->
            <div class="tautulli-rule-card">
                <div class="tautulli-rule-row">
                    <div>
                        <div class="tautulli-rule-title">Radarr (Movie Management)</div>
                        <div class="tautulli-rule-desc">Quickly inspect movie quality profiles, storage file paths, and trigger automatic media upgrades.</div>
                    </div>
                </div>
                <div class="tautulli-form-row">
                    <label class="tautulli-form-label">Radarr Base URL</label>
                    <input type="text" id="servarr-radarr-url" class="tautulli-input" placeholder="http://192.168.1.50:7878" value="${escapeHtml(servarrConfig.radarrUrl || '')}">
                </div>
                <div class="tautulli-form-row" style="margin-top:6px;">
                    <label class="tautulli-form-label">Radarr API Key</label>
                    <input type="password" id="servarr-radarr-api-key" class="tautulli-input" placeholder="Enter API Key from Radarr Settings &gt; General" value="${escapeHtml(servarrConfig.radarrApiKey || '')}">
                </div>
            </div>

            <!-- Sonarr Configuration -->
            <div class="tautulli-rule-card">
                <div class="tautulli-rule-row">
                    <div>
                        <div class="tautulli-rule-title">Sonarr (TV Show Management)</div>
                        <div class="tautulli-rule-desc">Quickly inspect series quality profiles, episode paths, and trigger automatic episode upgrades.</div>
                    </div>
                </div>
                <div class="tautulli-form-row">
                    <label class="tautulli-form-label">Sonarr Base URL</label>
                    <input type="text" id="servarr-sonarr-url" class="tautulli-input" placeholder="http://192.168.1.50:8989" value="${escapeHtml(servarrConfig.sonarrUrl || '')}">
                </div>
                <div class="tautulli-form-row" style="margin-top:6px;">
                    <label class="tautulli-form-label">Sonarr API Key</label>
                    <input type="password" id="servarr-sonarr-api-key" class="tautulli-input" placeholder="Enter API Key from Sonarr Settings &gt; General" value="${escapeHtml(servarrConfig.sonarrApiKey || '')}">
                </div>
            </div>

            <div style="margin-top:18px;display:flex;justify-content:flex-end;gap:8px;">
                <button class="tautulli-modal-tool-btn" id="servarr-save-btn" style="background:rgba(0,164,220,0.3);border-color:#38bdf8;color:#ffffff;font-size:12px;padding:6px 16px;">
                    Save Servarr Configuration
                </button>
            </div>
        `;

        modal.querySelector('[data-action="close-servarr-modal"]').onclick = closeServarrModal;

        const saveBtn = modal.querySelector('#servarr-save-btn');
        if (saveBtn) {
            saveBtn.onclick = function () {
                const bUrl = modal.querySelector('#servarr-bazarr-url');
                const bKey = modal.querySelector('#servarr-bazarr-api-key');
                const rUrl = modal.querySelector('#servarr-radarr-url');
                const rKey = modal.querySelector('#servarr-radarr-api-key');
                const sUrl = modal.querySelector('#servarr-sonarr-url');
                const sKey = modal.querySelector('#servarr-sonarr-api-key');

                servarrConfig.bazarrUrl = bUrl ? bUrl.value.trim() : '';
                servarrConfig.bazarrApiKey = bKey ? bKey.value.trim() : '';
                servarrConfig.radarrUrl = rUrl ? rUrl.value.trim() : '';
                servarrConfig.radarrApiKey = rKey ? rKey.value.trim() : '';
                servarrConfig.sonarrUrl = sUrl ? sUrl.value.trim() : '';
                servarrConfig.sonarrApiKey = sKey ? sKey.value.trim() : '';

                saveServarrConfig(servarrConfig);
                closeServarrModal();
                lastRenderedHash = '';
                fetchAndRenderSessions();
            };
        }

        backdrop.appendChild(modal);
        document.body.appendChild(backdrop);
        document.addEventListener('keydown', handleServarrModalEscape);
    }

    /**
     * Closes the active Servarr Remediation modal if open.
     */
    function closeServarrModal() {
        document.removeEventListener('keydown', handleServarrModalEscape);
        const existing = document.getElementById('tautulli-servarr-modal-backdrop');
        if (existing) {
            existing.remove();
        }
    }

    /**
     * Executes automatic termination of a non-compliant playback session (Smart Stream Guard).
     */
    async function executeAutoKill(sessionId, userName, mediaTitle, ruleReason, clientMessage) {
        if (!window.ApiClient || !sessionId) return;
        try {
            // Log the auto-kill event
            autoKillEventsLog.unshift({
                id: sessionId,
                time: new Date().toLocaleTimeString(),
                userName: userName || 'User',
                title: mediaTitle || 'Media',
                reason: ruleReason
            });
            if (autoKillEventsLog.length > 30) autoKillEventsLog.pop();

            // Send polite educational on-screen message to client player first
            if (clientMessage && typeof window.ApiClient.ajax === 'function') {
                try {
                    await window.ApiClient.ajax({
                        type: 'POST',
                        url: window.ApiClient.getUrl(`Sessions/${sessionId}/Message`),
                        data: JSON.stringify({
                            Text: clientMessage,
                            Header: 'Playback Notice',
                            TimeoutMs: 6000
                        }),
                        contentType: 'application/json'
                    });
                } catch (msgErr) {
                    console.warn('[PlaybackCard] Could not send notice prior to auto-kill:', msgErr);
                }
            }

            // Terminate the playback session
            if (typeof window.ApiClient.sendPlaystateCommand === 'function') {
                await window.ApiClient.sendPlaystateCommand(sessionId, 'Stop');
            } else if (typeof window.ApiClient.ajax === 'function') {
                await window.ApiClient.ajax({
                    type: 'POST',
                    url: window.ApiClient.getUrl(`Sessions/${sessionId}/Playing/Stop`)
                });
            }
            console.info(`[PlaybackCard] Stream Guard auto-killed session ${sessionId} (${userName}): ${ruleReason}`);
        } catch (err) {
            console.error('[PlaybackCard] Failed to auto-kill session:', err);
        }
    }

    /**
     * Evaluates active sessions against Smart Stream Guard rules after each poll.
     */
    async function evaluateAutoKillRules(cards) {
        if (!cards || cards.length === 0) return;

        // Rule 1: Auto-Kill Paused Streams
        if (streamGuardRules.killPausedEnabled && streamGuardRules.killPausedMinutes > 0) {
            const maxPausedSeconds = streamGuardRules.killPausedMinutes * 60;
            for (const card of cards) {
                if (card.isPaused && card.pausedDurationSeconds >= maxPausedSeconds) {
                    await executeAutoKill(
                        card.sessionId,
                        card.userName,
                        card.primaryTitle,
                        `Paused > ${streamGuardRules.killPausedMinutes}m`,
                        `Playback was automatically closed after being paused for more than ${streamGuardRules.killPausedMinutes} minutes to conserve server resources.`
                    );
                    return; // one action per evaluation cycle
                }
            }
        }

        // Rule 2: Block 4K CPU Software Transcodes
        if (streamGuardRules.kill4kSwEnabled) {
            for (const card of cards) {
                if (card.isTranscode && card.isSwTranscode && card.is4k) {
                    await executeAutoKill(
                        card.sessionId,
                        card.userName,
                        card.primaryTitle,
                        '4K Software Transcode Blocked',
                        '4K CPU transcoding is disabled to protect server performance. Please select Original Quality or 1080p.'
                    );
                    return;
                }
            }
        }

        // Rule 3: Concurrent Streams per User Cap
        if (streamGuardRules.maxConcurrentStreams > 0) {
            const userCounts = new Map();
            for (const card of cards) {
                const uid = card.userId || card.userName;
                const list = userCounts.get(uid) || [];
                list.push(card);
                userCounts.set(uid, list);
            }

            for (const [uid, list] of userCounts.entries()) {
                if (list.length > streamGuardRules.maxConcurrentStreams) {
                    // Kill the newest excess stream
                    const excessCard = list[list.length - 1];
                    await executeAutoKill(
                        excessCard.sessionId,
                        excessCard.userName,
                        excessCard.primaryTitle,
                        `Concurrent Cap (> ${streamGuardRules.maxConcurrentStreams})`,
                        `Maximum simultaneous streams limit (${streamGuardRules.maxConcurrentStreams}) reached for this account.`
                    );
                    return;
                }
            }
        }
    }

    /**
     * Attaches interactive event listeners to container elements (Stop, Message, PlayPause, Privacy, Filter, Inspect).
     */
    function attachContainerEvents(container) {
        container.onclick = function (e) {
            const target = e.target.closest('[data-action]');
            if (!target) return;

            const action = target.getAttribute('data-action');
            if (action === 'edit-device-alias') {
                e.preventDefault();
                e.stopPropagation();
                const key = target.getAttribute('data-device-key');
                const currentName = target.getAttribute('data-current-name') || '';
                const newName = prompt('Enter accurate device model / nickname (e.g. iPhone 16 Pro Max):', currentName);
                if (newName !== null) {
                    saveDeviceAlias(key, newName);
                    lastRenderedHash = '';
                    fetchAndRenderSessions();
                }
                return;
            }

            if (action === 'toggle-privacy') {
                e.preventDefault();
                isPrivacyMode = !isPrivacyMode;
                lastRenderedHash = '';
                fetchAndRenderSessions();
                return;
            }

            if (action === 'toggle-watch-stats') {
                e.preventDefault();
                showWatchStats = !showWatchStats;
                lastRenderedHash = '';
                fetchAndRenderSessions();
                return;
            }

            if (action === 'set-filter') {
                e.preventDefault();
                currentFilter = target.getAttribute('data-filter') || 'all';
                lastRenderedHash = '';
                fetchAndRenderSessions();
                return;
            }

            const sessionId = target.getAttribute('data-session-id');
            const userName = target.getAttribute('data-user') || 'User';
            const mediaTitle = target.getAttribute('data-title') || 'Media';

            if (action === 'open-stream-guard') {
                e.preventDefault();
                openStreamGuardModal();
                return;
            }

            if (action === 'open-servarr-modal') {
                e.preventDefault();
                openServarrModal();
                return;
            }

            if (action === 'force-flush-pipeline') {
                e.preventDefault();
                handleFlushPipeline(sessionId, userName, mediaTitle);
                return;
            }

            if (action === 'fetch-srt-bazarr') {
                e.preventDefault();
                const title = target.getAttribute('data-title') || mediaTitle;
                handleFetchSrtBazarr(sessionId, title);
                return;
            }

            if (action === 'toggle-doctor') {
                e.preventDefault();
                const docPanel = container.querySelector(`#tautulli-doctor-${sessionId}`);
                if (docPanel) {
                    docPanel.style.display = docPanel.style.display === 'none' ? 'flex' : 'none';
                }
                return;
            }

            if (action === 'send-fix-tip') {
                e.preventDefault();
                const tipText = target.getAttribute('data-tip') || 'Please check playback settings.';
                handleSendMessage(sessionId, userName, tipText);
                return;
            }

            if (action === 'inspect-stream') {
                e.preventDefault();
                const card = currentCardModels.find((c) => c.sessionId === sessionId);
                if (card) {
                    openStreamInspectorModal(card);
                }
            } else if (action === 'kill-stream') {
                e.preventDefault();
                handleKillStream(sessionId, userName, mediaTitle);
            } else if (action === 'message-user') {
                e.preventDefault();
                handleSendMessage(sessionId, userName);
            } else if (action === 'toggle-play') {
                e.preventDefault();
                const isPaused = target.getAttribute('data-paused') === 'true';
                handleTogglePlayPause(sessionId, isPaused);
            }
        };
    }

    /**
     * Polls ApiClient.getSessions() and updates the DOM cleanly.
     */
    async function fetchAndRenderSessions() {
        const apiClient = getApiClient();
        if (!isDashboardActive || isFetching || !apiClient) {
            return;
        }

        const container = document.getElementById(CONFIG.CONTAINER_ID);
        if (!container) {
            return;
        }

        isFetching = true;
        try {
            const rawSessions = await apiClient.getSessions();
            if (!isDashboardActive) return; // View changed while awaiting promise

            // Filter for active playback sessions with active media item
            const activeSessions = (rawSessions || []).filter((s) => s && s.NowPlayingItem != null);
            const idleSessions = (rawSessions || []).filter((s) => s && s.NowPlayingItem == null);

            // Clean up pause timestamps for terminated sessions to prevent memory leaks
            const activeSessionIds = new Set(activeSessions.map((s) => s.Id));
            for (const sid of sessionPausedTimestamps.keys()) {
                if (!activeSessionIds.has(sid)) {
                    sessionPausedTimestamps.delete(sid);
                }
            }

            // Proactively cache real media bitrate from Jellyfin if not in session payload
            activeSessions.forEach((s) => {
                const it = s.NowPlayingItem;
                if (it && it.Id && !itemBitrateCache.has(it.Id)) {
                    if (!it.Bitrate && !(it.MediaSources && it.MediaSources[0] && it.MediaSources[0].Bitrate)) {
                        const uid = typeof apiClient.getCurrentUserId === 'function' ? apiClient.getCurrentUserId() : undefined;
                        if (typeof apiClient.getItem === 'function') {
                            apiClient.getItem(uid, it.Id).then((fullItem) => {
                                if (fullItem) {
                                    const br = fullItem.Bitrate ||
                                        (fullItem.MediaSources && fullItem.MediaSources[0] && fullItem.MediaSources[0].Bitrate) ||
                                        (fullItem.Size && fullItem.RunTimeTicks ? Math.round((fullItem.Size * 8) / (fullItem.RunTimeTicks / 10000000)) : 0);
                                    if (br > 0) {
                                        itemBitrateCache.set(it.Id, br);
                                        lastRenderedHash = '';
                                    }
                                }
                            }).catch(() => {});
                        }
                    }
                }
            });

            const cards = activeSessions.map((s, idx) => mapSessionToCardModel(s, idx));

            // P1.2 Multi-IP concurrent account sharing cross-analysis
            const userWanMap = new Map(); // userId -> Set of distinct clean WAN IPs
            cards.forEach((c) => {
                if (!c.isLan && c.rawCleanIp) {
                    const uid = c.userId || c.userName;
                    if (!userWanMap.has(uid)) {
                        userWanMap.set(uid, new Set());
                    }
                    userWanMap.get(uid).add(c.rawCleanIp);
                }
            });

            cards.forEach((c) => {
                const uid = c.userId || c.userName;
                const wanSet = userWanMap.get(uid);
                if (wanSet && wanSet.size > 1) {
                    c.isMultiIpSharing = true;
                    c.distinctWanIpCount = wanSet.size;
                    c.wanIpList = Array.from(wanSet);
                } else {
                    c.isMultiIpSharing = false;
                    c.distinctWanIpCount = 1;
                }
                c.bottleneck = computeBottleneckDiagnostic(c);
            });

            // Tautulli Feature 4: SyncPlay watch party group clustering
            const syncPlayGroupMap = new Map();
            cards.forEach((c) => {
                if (c.syncPlayGroupId) {
                    syncPlayGroupMap.set(c.syncPlayGroupId, (syncPlayGroupMap.get(c.syncPlayGroupId) || 0) + 1);
                }
            });
            cards.forEach((c) => {
                if (c.syncPlayGroupId && syncPlayGroupMap.has(c.syncPlayGroupId)) {
                    const count = syncPlayGroupMap.get(c.syncPlayGroupId);
                    c.syncPlayMembersCount = count;
                    c.syncPlayBadge = `SyncPlay (${count} Member${count > 1 ? 's' : ''})`;
                }
            });

            // Tautulli Feature 5: Watch statistics drawer data fetching (cached for 2 minutes)
            if (showWatchStats && (!cachedWatchStats || Date.now() - lastWatchStatsFetchTime > 120000)) {
                await fetchWatchStatistics();
            }

            currentCardModels = cards;

            // Compute hash of content to avoid redundant DOM mutations
            const contentHash = JSON.stringify({
                placement: placementMode,
                privacy: isPrivacyMode,
                filter: currentFilter,
                showStats: showWatchStats,
                idleCount: idleSessions.length,
                statsItemsCount: cachedWatchStats ? ((cachedWatchStats.topCombined || []).length) : 0,
                cards: cards.map((c) => ({
                    id: c.sessionId,
                    method: c.playMethod,
                    paused: c.isPaused,
                    pauseSec: Math.floor(c.pausedDurationSeconds / 5), // re-render every 5s if paused
                    pos: c.timeProgressStr,
                    buf: c.transcodeCompletionPercentage,
                    bw: c.bandwidthDisplay,
                    hw: c.hwAccelBadge,
                    speed: c.transcodeSpeedMultiplier,
                    stutter: c.isSevereStutter,
                    multiIp: c.isMultiIpSharing,
                    bottleneck: c.bottleneck ? c.bottleneck.key : '',
                    savings: c.bandwidthSavingsBadge || '',
                    conn: c.connectionType || '',
                    sync: c.syncPlayBadge || '',
                    hires: c.isHiResAudio || false,
                    zombie: c.isZombieTranscode || false,
                    bazarr: c.canRemediateSubtitlesWithBazarr || false
                }))
            });

            if (contentHash !== lastRenderedHash) {
                lastRenderedHash = contentHash;
                container.innerHTML = renderContainer(cards, idleSessions);
                attachContainerEvents(container);
            }

            // Smart Stream Guard automated policy evaluation
            await evaluateAutoKillRules(cards);
        } catch (err) {
            console.warn('[PlaybackCard] Failed to fetch active playback sessions:', err);
        } finally {
            isFetching = false;
        }
    }

    /**
     * Advances playback elapsed time and updates progress bars smoothly on a 1-second interval
     * between 3-second API poll intervals, keeping the UI alive and responsive without network overhead.
     */
    function startLiveTicker() {
        stopLiveTicker();
        liveTickerIntervalId = setInterval(() => {
            if (!isDashboardActive || currentCardModels.length === 0) return;

            const container = document.getElementById(CONFIG.CONTAINER_ID);
            if (!container) return;

            currentCardModels.forEach((card) => {
                const cardEl = container.querySelector(`.tautulli-card[data-session-id="${card.sessionId}"]`);
                if (!cardEl) return;

                if (!card.isPaused) {
                    if (card.totalSeconds > 0 && card.currentSeconds < card.totalSeconds) {
                        card.currentSeconds += 1;
                        const progressRatio = Math.min(1, card.currentSeconds / card.totalSeconds);
                        const percentStr = (progressRatio * 100).toFixed(1);

                        const fillEl = cardEl.querySelector('.tautulli-progress-fill');
                        if (fillEl) {
                            fillEl.style.width = `${percentStr}%`;
                        }

                        const timeProgressEl = cardEl.querySelector('.tautulli-time-progress');
                        if (timeProgressEl) {
                            timeProgressEl.textContent = `${formatDuration(card.currentSeconds)} / ${formatDuration(card.totalSeconds)}`;
                        }

                        const remainingSec = Math.max(0, card.totalSeconds - card.currentSeconds);
                        const etaEl = cardEl.querySelector('.tautulli-time-eta');
                        if (etaEl) {
                            etaEl.textContent = formatETA(remainingSec, false, 0);
                        }
                    }
                } else {
                    card.pausedDurationSeconds += 1;
                    const pausedEl = cardEl.querySelector('.tautulli-time-paused');
                    if (pausedEl) {
                        pausedEl.textContent = formatETA(0, true, card.pausedDurationSeconds);
                    }
                }
            });
        }, 1000);
    }

    /**
     * Stops the 1-second live ticker interval.
     */
    function stopLiveTicker() {
        if (liveTickerIntervalId != null) {
            clearInterval(liveTickerIntervalId);
            liveTickerIntervalId = null;
        }
    }

    /**
     * Starts the polling timer.
     */
    function startPolling() {
        stopPolling();
        isDashboardActive = true;
        lastRenderedHash = '';
        fetchAndRenderSessions();
        pollIntervalId = setInterval(fetchAndRenderSessions, CONFIG.POLL_INTERVAL_MS);
        startLiveTicker();
    }

    /**
     * Stops the polling timer to prevent memory leaks and unnecessary network calls.
     */
    function stopPolling() {
        isDashboardActive = false;
        if (pollIntervalId != null) {
            clearInterval(pollIntervalId);
            pollIntervalId = null;
        }
        stopLiveTicker();
    }

    /**
     * Helper to check if an element is inside any sidebar, navigation drawer, or panel across Jellyfin versions (including MUI Drawer).
     */
    function isInsideSidebar(el) {
        if (!el || typeof el.closest !== 'function') return false;
        return Boolean(el.closest([
            '.MuiDrawer-root',
            '.MuiDrawer-docked',
            '.MuiDrawer-paper',
            '[class*="MuiDrawer"]',
            '[class*="drawer"]',
            '[class*="Drawer"]',
            '.mainDrawer',
            '.sidebar',
            '.sidebarLinks',
            '.navMenu',
            '.drawer-content',
            'nav',
            'aside',
            '[data-role="panel"]',
            '[role="navigation"]',
            '.mainAnimatedPages > .drawer'
        ].join(',')));
    }

    /**
     * Retrieves the main dashboard content container, strictly excluding navigation sidebars.
     */
    function getDashboardContentRoot() {
        const primarySelectors = [
            '#dashboardPage .content-primary',
            '.dashboardPage .content-primary',
            '.content-primary',
            '#dashboardPage',
            '.dashboardPage',
            '.dashboardForm',
            'div[data-role="page"]:not(.hide)',
            '.view:not(.hide)'
        ];
        for (const sel of primarySelectors) {
            try {
                const el = document.querySelector(sel);
                if (el && !isInsideSidebar(el)) return el;
            } catch (e) {}
        }
        return null;
    }

    /**
     * Finds the Devices section in the dashboard to enable seamless in-place replacement.
     */
    function findDevicesSection(viewElement) {
        const root = (viewElement && typeof viewElement.querySelector === 'function' && !isInsideSidebar(viewElement) && viewElement !== document.body)
            ? viewElement
            : getDashboardContentRoot();

        if (!root) return null;

        function isValidTarget(el) {
            if (!el || typeof el.closest !== 'function') return false;
            if (isInsideSidebar(el)) return false;
            if (el === root || el === document.body) return false;
            return true;
        }

        // 1. Jellyfin 12 (MUI) / React dashboard: Widget with link to "/dashboard/devices" or "/devices"
        try {
            const deviceLinks = Array.from(root.querySelectorAll('a[href*="devices"], button[href*="devices"], a[to*="devices"], [data-testid="ChevronRightIcon"]'));
            for (const el of deviceLinks) {
                if (isInsideSidebar(el)) continue;
                const href = (el.getAttribute('href') || el.getAttribute('to') || '').toLowerCase();
                const text = (el.textContent || '').trim().toLowerCase();
                if (href.includes('devices') || text.includes('devices')) {
                    // In MUI, Widget renders: <Box><Button to="/dashboard/devices"><Typography>Devices</Typography></Button>{children}</Box>
                    const widgetBox = el.closest('.MuiBox-root') || el.parentElement;
                    if (widgetBox && isValidTarget(widgetBox)) {
                        return widgetBox;
                    }
                }
            }
        } catch (e) {}

        // 2. Direct active devices class or ID inside dashboard (Jellyfin 10.8 / 10.9)
        const directSelectors = [
            '.activeDevices',
            '#activeDevices',
            '.active-devices',
            '[data-section="devices"]',
            '.devicesSection',
            '.dashboardDevices'
        ];
        for (const sel of directSelectors) {
            try {
                const candidates = Array.from(root.querySelectorAll(sel));
                for (const el of candidates) {
                    if (!isValidTarget(el)) continue;
                    const parentSection = el.closest('.dashboardSection, .dashboardColumnSection, section, .MuiBox-root, div[class*="section"], div[class*="Section"]');
                    return parentSection || el;
                }
            } catch (e) {}
        }

        // 3. Headings matching "Devices" inside dashboard
        try {
            const headings = Array.from(root.querySelectorAll('h1, h2, h3, h4, .sectionTitle, .sectionTitleContainer, .MuiTypography-h3, .MuiTypography-h2, .MuiTypography-root'));
            for (const el of headings) {
                if (isInsideSidebar(el)) continue;
                const text = (el.textContent || '').trim().toLowerCase();
                if (text === 'devices' || text.startsWith('devices')) {
                    const parentSection = el.closest('.dashboardSection, .dashboardColumnSection, section, .MuiBox-root, div[class*="section"], div[class*="Section"]');
                    if (parentSection && isValidTarget(parentSection)) {
                        return parentSection;
                    }
                    let curr = el;
                    while (curr && curr.parentElement && curr.parentElement !== root && curr.parentElement !== document.body) {
                        if (isInsideSidebar(curr.parentElement)) break;
                        if (curr.parentElement.querySelector('.activeDevices, .card, .MuiCard-root, [data-role="controlgroup"]')) {
                            return curr.parentElement;
                        }
                        curr = curr.parentElement;
                    }
                    if (isValidTarget(el.parentElement)) return el.parentElement;
                }
            }
        } catch (e) {}

        return null;
    }

    /**
     * Searches for the optimal insertion point across Jellyfin 10.8, 10.9, and 10.10/12 dashboard layouts.
     */
    function findDashboardTarget(viewElement) {
        const root = (viewElement && typeof viewElement.querySelector === 'function' && !isInsideSidebar(viewElement) && viewElement !== document.body)
            ? viewElement
            : getDashboardContentRoot();

        if (!root) return null;

        // In Jellyfin 12 MUI, find the left column Stack (which holds ServerInfo and ItemCounts)
        try {
            const muiStack = root.querySelector('.MuiGrid-item .MuiStack-root, .content-primary .MuiStack-root');
            if (muiStack && !isInsideSidebar(muiStack)) return muiStack;
        } catch (e) {}

        const candidateSelectors = [
            '.activeDevices',
            '#activeDevices',
            '.dashboardServerActivity',
            '#dashboardServerActivity',
            '.dashboardForm',
            '.dashboardGeneralForm',
            '.content-primary',
            '#dashboardPage',
            '.dashboardPage'
        ];

        for (const sel of candidateSelectors) {
            try {
                const el = root.querySelector(sel);
                if (el && !isInsideSidebar(el)) return el;
            } catch (e) {}
        }

        return root;
    }

    /**
     * Finds the dashboard form container and prepends the playback card container cleanly.
     */
    function setupDashboardContainer(viewElement) {
        injectStyles();

        // Remove any existing instance to prevent duplicates
        const existing = document.getElementById(CONFIG.CONTAINER_ID);
        if (existing) {
            existing.remove();
        }

        const container = document.createElement('div');
        container.id = CONFIG.CONTAINER_ID;
        container.innerHTML = `
            <div class="tautulli-empty-container">
                <div class="tautulli-empty-text">Loading live playback sessions...</div>
            </div>
        `;

        // Always target and replace the Devices section
        const devicesTarget = findDevicesSection(viewElement);
        if (devicesTarget && devicesTarget.parentNode) {
            defaultDevicesElement = devicesTarget;
            devicesTarget.style.setProperty('display', 'none', 'important');
            devicesTarget.setAttribute('data-playbackcard-replaced', 'true');
            devicesTarget.parentNode.insertBefore(container, devicesTarget);
            attachContainerEvents(container);
            return true;
        }

        // Fallback: If devices section not yet in DOM, insert into dashboard target
        const target = findDashboardTarget(viewElement);
        if (!target) {
            return false;
        }

        if (target.classList && target.classList.contains('MuiStack-root')) {
            target.appendChild(container);
        } else if (target.classList && (target.classList.contains('activeDevices') || target.classList.contains('dashboardServerActivity') || target.id === 'activeDevices')) {
            if (target.parentNode) {
                target.parentNode.insertBefore(container, target);
            } else {
                target.insertBefore(container, target.firstChild);
            }
        } else {
            target.insertBefore(container, target.firstChild);
        }

        attachContainerEvents(container);
        return true;
    }

    /**
     * Determines whether the given element or URL corresponds to the admin dashboard.
     */
    function isDashboardView(element) {
        const path = (window.location.hash || window.location.pathname || '').toLowerCase();
        if (path.includes('dashboard') || path.includes('serverstatus') || path.includes('dashboard.html')) {
            return true;
        }
        if (document.querySelector('.activeDevices') || document.querySelector('.dashboardServerActivity') || document.querySelector('.dashboardForm')) {
            return true;
        }
        if (element && typeof element.querySelector === 'function') {
            if (element.querySelector('.activeDevices') || element.querySelector('.dashboardServerActivity') || element.querySelector('.dashboardForm')) {
                return true;
            }
        }
        return false;
    }

    /**
     * Lifecycle handler: viewshow
     */
    function onViewShow(e) {
        const view = e.target || (e.detail && e.detail.element);
        if (isDashboardView(view)) {
            if (setupDashboardContainer(view)) {
                startPolling();
            }
        } else {
            stopPolling();
        }
    }

    /**
     * Lifecycle handler: viewhide & viewdestroy
     */
    function onViewTearDown(e) {
        const view = e.target || (e.detail && e.detail.element);
        if (isDashboardView(view)) {
            stopPolling();
            closeStreamInspectorModal();
            if (defaultDevicesElement && defaultDevicesElement.style) {
                defaultDevicesElement.style.display = '';
            }
            const container = document.getElementById(CONFIG.CONTAINER_ID);
            if (container) {
                container.remove();
            }
        }
    }

    /**
     * Heartbeat guard: Ensures container mounts immediately even if custom JS loaded after viewshow event.
     */
    function checkAndMount() {
        if (isDashboardView(document.body)) {
            const existing = document.getElementById(CONFIG.CONTAINER_ID);
            const isAttached = existing && document.body && (typeof document.body.contains === 'function' ? document.body.contains(existing) : true);

            const devicesTarget = findDevicesSection(document.body);
            if (devicesTarget && devicesTarget.parentNode) {
                // Ensure default devices section stays hidden
                if (devicesTarget.style && devicesTarget.style.display !== 'none') {
                    devicesTarget.style.setProperty('display', 'none', 'important');
                }
                // If container is inside the sidebar OR mounted elsewhere, relocate it to replace devicesTarget!
                if (existing && (isInsideSidebar(existing) || existing.nextSibling !== devicesTarget)) {
                    devicesTarget.parentNode.insertBefore(existing, devicesTarget);
                }
            }

            if (!existing || !isAttached) {
                if (setupDashboardContainer(document.body)) {
                    startPolling();
                }
            } else if (!isDashboardActive) {
                startPolling();
            }
        } else {
            if (isDashboardActive) {
                stopPolling();
                if (defaultDevicesElement && defaultDevicesElement.style) {
                    defaultDevicesElement.style.display = '';
                }
                const existing = document.getElementById(CONFIG.CONTAINER_ID);
                if (existing) {
                    existing.remove();
                }
            }
        }
    }

    // Register lifecycle event listeners on document and window router
    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
        document.addEventListener('viewshow', onViewShow);
        document.addEventListener('viewhide', onViewTearDown);
        document.addEventListener('viewdestroy', onViewTearDown);
    }
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
        window.addEventListener('hashchange', checkAndMount);
        window.addEventListener('popstate', checkAndMount);
    }

    // Run immediate check and continuous 1-second watcher
    checkAndMount();
    setInterval(checkAndMount, 1000);

    console.info('[PlaybackCard] Jellyfin Playback Info Card v0.1.0 initialized successfully.');
})();
