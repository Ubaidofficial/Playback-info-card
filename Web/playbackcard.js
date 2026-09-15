/**
 * Jellyfin Playback Info Card (Jellyfin.Plugin.PlaybackCard) - v0.2.0
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
 * - Interactive Session Controls (Kill Stream, Send Message to Device, Pause/Resume, Mute/Unmute).
 * - Bandwidth Breakdown in Activity Banner (Total Bandwidth, LAN Bandwidth, WAN Upload).
 * - Admin Privacy Mode (1-click toggle to mask IPs and usernames for screenshots/streaming).
 * - Deep-Navigation Links (Click poster/title to open media details, click user for user settings).
 * - Fluid 1-Second Client Progress Interpolation at 60fps.
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
        PLUGIN_ID: 'b7e6f831-2794-4d82-8419-7c48ef2e2a39',
        POLL_INTERVAL_MS: 3000,
        SHOW_IDLE_SESSIONS: false,
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
    let etaDisplayMode = 'clock'; // 'clock' | 'remaining'
    try {
        etaDisplayMode = localStorage.getItem('jellyfin_playbackcard_eta_mode') || 'clock';
    } catch (e) {}
    const sessionPausedTimestamps = new Map(); // sessionId -> timestamp when pause was first detected

    // Rolling Telemetry History
    const MAX_BANDWIDTH_HISTORY = 16;
    const bandwidthHistory = []; // { time, total, wan, lan }

    const itemBitrateCache = new Map(); // itemId -> bitrate in bps

    // Placement state: locked to 'replace-devices' in place of default Devices section
    const placementMode = 'replace-devices';
    try {
        localStorage.removeItem('jellyfin_playbackcard_placement');
    } catch (e) {}
    let defaultDevicesElement = null;

    /**
     * Loads plugin configuration from the Jellyfin server.
     * Updates polling interval, accent color, and show idle sessions.
     */
    let isConfigLoaded = false;
    async function loadServerConfiguration() {
        // When running standalone in the browser (e.g. via DevTools console or user script),
        // querying the server plugin endpoint triggers an HTTP 401 because the plugin
        // assembly is not installed in the Jellyfin server. Only query if actually installed.
        const isInstalledPlugin = Boolean(
            (typeof document !== 'undefined' && typeof document.querySelector === 'function' && document.querySelector(`script[src*="${CONFIG.PLUGIN_ID}"]`)) ||
            (typeof window !== 'undefined' && window.location && typeof window.location.href === 'string' && window.location.href.includes(CONFIG.PLUGIN_ID)) ||
            (typeof window !== 'undefined' && window.PlaybackInfoEnableServerConfig === true)
        );
        if (!isInstalledPlugin) {
            return;
        }

        const apiClient = getApiClient();
        if (!apiClient || typeof apiClient.getPluginConfiguration !== 'function') return;
        try {
            let config = null;
            try {
                if (typeof apiClient.getPluginConfiguration === 'function') {
                    config = await apiClient.getPluginConfiguration(CONFIG.PLUGIN_ID);
                }
            } catch (_) {
                // Plugin not installed or running standalone — safely ignore
            }
            if (config && typeof config === 'object') {
                isConfigLoaded = true;
                if (config.PollingIntervalSeconds && config.PollingIntervalSeconds >= 1) {
                    const newInterval = config.PollingIntervalSeconds * 1000;
                    if (newInterval !== CONFIG.POLL_INTERVAL_MS) {
                        CONFIG.POLL_INTERVAL_MS = newInterval;
                        if (isDashboardActive && pollIntervalId != null) {
                            clearInterval(pollIntervalId);
                            pollIntervalId = setInterval(fetchAndRenderSessions, CONFIG.POLL_INTERVAL_MS);
                        }
                    }
                }
                if (config.AccentColor) {
                    const cleanAccent = config.AccentColor.trim();
                    if (cleanAccent && cleanAccent !== CONFIG.ACCENT_COLOR) {
                        CONFIG.ACCENT_COLOR = cleanAccent;
                        injectStyles();
                    }
                }
                if (typeof config.ShowIdleSessions === 'boolean') {
                    CONFIG.SHOW_IDLE_SESSIONS = config.ShowIdleSessions;
                }
            }
        } catch (err) {
            // Configuration might not be present or server running older version
        }
    }

    /**
     * Formats an ISO date string into relative time ago (e.g. "5m ago", "2h ago", "1d ago").
     */
    function formatTimeAgo(dateStr) {
        if (!dateStr) return 'Recently';
        try {
            const date = new Date(dateStr);
            const diffSec = Math.floor((Date.now() - date.getTime()) / 1000);
            if (isNaN(diffSec) || diffSec < 60) return 'Just now';
            if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
            if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
            return `${Math.floor(diffSec / 86400)}d ago`;
        } catch (e) {
            return 'Recently';
        }
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
        return cleanDeviceName(session.DeviceName || session.Client || 'Browser');
    }

    /**
     * Injects custom CSS styling for the Liquid Glass theme and Tautulli/Jellywatch card anatomy.
     */
    function injectStyles() {
        let styleElement = document.getElementById(CONFIG.STYLES_ID);
        if (!styleElement) {
            styleElement = document.createElement('style');
            styleElement.id = CONFIG.STYLES_ID;
            document.head.appendChild(styleElement);
        }

        styleElement.textContent = `
            :root {
                /* Playback Card Accent Token */
                --jpc-accent: ${CONFIG.ACCENT_COLOR || '#00a4dc'};
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
                --lg-card-bg: linear-gradient(155deg, rgba(255, 255, 255, 0.06) 0%, rgba(255, 255, 255, 0.02) 50%, rgba(9, 10, 16, 0.72) 100%), #090a10;
                --lg-card-border: 1px solid rgba(255, 255, 255, 0.18);
                --lg-chip-bg: rgba(255, 255, 255, 0.04);
                --lg-chip-border: 1px solid rgba(255, 255, 255, 0.08);
                --lg-control-bg: rgba(255, 255, 255, 0.06);
                --lg-control-border: 1px solid rgba(255, 255, 255, 0.12);
                /* GlassFin (KBH-Reeper) Specular Light Sweep & Accent Tokens */
                --gf-hover-v: linear-gradient(0deg, transparent, rgba(255, 255, 255, 0.08) 45%, rgba(255, 255, 255, 0.16) 50%, rgba(255, 255, 255, 0.08) 55%, transparent);
                --gf-active-accent: var(--jpc-accent, rgba(0, 164, 220, 0.85));
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

            /* Moonfin Glass Noise Grain Texture (3% opacity physical texture) */
            .tautulli-card::before {
                content: '';
                position: absolute;
                inset: 0;
                pointer-events: none;
                z-index: 3;
                border-radius: 18px;
                background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='200' height='200'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='200' height='200' filter='url(%23n)' opacity='1'/%3E%3C/svg%3E");
                background-size: 180px 180px;
                opacity: 0.028;
                mix-blend-mode: overlay;
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
                opacity: 0.40;
                filter: blur(8px) saturate(125%) brightness(0.65);
                pointer-events: none;
                z-index: 0;
                mask-image: linear-gradient(to right, transparent 0%, rgba(0, 0, 0, 0.6) 30%, rgba(0, 0, 0, 0.96) 65%, black 100%);
                -webkit-mask-image: linear-gradient(to right, transparent 0%, rgba(0, 0, 0, 0.6) 30%, rgba(0, 0, 0, 0.96) 65%, black 100%);
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

            .tautulli-action-btn-mute:hover {
                background: rgba(56, 189, 248, 0.2);
                border-color: rgba(56, 189, 248, 0.5);
                color: #38bdf8;
                box-shadow: 0 0 12px rgba(56, 189, 248, 0.3), inset 0 1px 0 rgba(255, 255, 255, 0.2);
            }

            .tautulli-action-btn-mute.muted {
                background: rgba(239, 68, 68, 0.2);
                border-color: rgba(239, 68, 68, 0.5);
                color: #f87171;
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
                gap: 12px;
                padding: 12px 14px;
                background: transparent;
                min-height: 158px;
            }

            .tautulli-poster-wrapper {
                position: relative;
                width: 120px;
                min-width: 120px;
                max-width: 120px;
                aspect-ratio: 2 / 3;
                border-radius: 10px;
                overflow: hidden;
                background: rgba(10, 10, 15, 0.9);
                border: 1px solid rgba(255, 255, 255, 0.12);
                box-shadow: 0 4px 16px -2px rgba(0, 0, 0, 0.7), inset 0 1px 0 rgba(255,255,255,0.08);
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
                transform: scale(1.04);
                filter: brightness(1.08);
            }
            /* Moonfin Holographic Shimmer Sweep on Poster Hover */
            .tautulli-poster-wrapper::after {
                content: '';
                position: absolute;
                top: 0; left: -75%;
                width: 50%;
                height: 100%;
                background: linear-gradient(
                    105deg,
                    transparent 20%,
                    rgba(255,255,255,0.08) 40%,
                    rgba(255,255,255,0.22) 50%,
                    rgba(255,255,255,0.08) 60%,
                    transparent 80%
                );
                transform: skewX(-15deg);
                pointer-events: none;
                z-index: 4;
                opacity: 0;
                transition: left 0.55s cubic-bezier(0.16,1,0.3,1), opacity 0.25s ease;
            }
            .tautulli-poster-wrapper:hover::after {
                left: 135%;
                opacity: 1;
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

            /* Authentic Tautulli Spec Grid (2-Column Key-Value) */
            .tautulli-spec-table {
                flex: 1;
                display: flex;
                flex-direction: column;
                gap: 4px;
                min-width: 0;
                padding-right: 42px;
                position: relative;
            }
            /* Readable scrim — soft mask dissolve from left so text is readable yet fanart bleeds through */
            .tautulli-spec-table::before {
                content: '';
                position: absolute;
                inset: -14px -14px -14px -18px;
                background: linear-gradient(to right, rgba(5,6,14,0.88) 0%, rgba(5,6,14,0.78) 40%, rgba(5,6,14,0.65) 75%, rgba(5,6,14,0.45) 100%);
                pointer-events: none;
                z-index: 0;
            }
            /* .tautulli-spec-row z-index set in its own rule below */

            .tautulli-spec-row {
                display: flex;
                align-items: baseline;
                font-size: 11px;
                line-height: 1.35;
                min-width: 0;
                position: relative;
                z-index: 1;
                gap: 8px;
            }

            .tautulli-spec-label {
                width: 82px;
                flex-shrink: 0;
                color: #7e8fa6;
                font-size: 9.5px;
                font-weight: 700;
                letter-spacing: 0.06em;
                text-transform: uppercase;
                user-select: none;
            }

            .tautulli-spec-value {
                color: #d4d8e0;
                font-weight: 500;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
                min-width: 0;
                flex: 1;
                font-variant-numeric: tabular-nums;
            }

            .tautulli-spec-value a {
                color: inherit;
                text-decoration: none;
            }

            .tautulli-spec-value strong {
                color: #ffffff;
                font-weight: 600;
            }

            .tautulli-stream-directplay {
                color: #4ade80 !important;
                font-weight: 600;
            }

            .tautulli-stream-directstream {
                color: #38bdf8 !important;
                font-weight: 600;
            }

            .tautulli-stream-transcode {
                color: #fb923c !important;
                font-weight: 600;
            }

            .tautulli-stream-hw {
                color: #c084fc !important;
                font-weight: 600;
            }

            .tautulli-spec-row-clickable {
                cursor: pointer;
                transition: color 0.15s ease;
                max-width: calc(100% - 112px);
                overflow: hidden;
            }

            .tautulli-spec-row-clickable:hover .tautulli-spec-value {
                text-decoration: underline;
                color: #38bdf8 !important;
            }

            .tautulli-time-stack {
                cursor: pointer;
                transition: opacity 0.15s ease;
            }

            .tautulli-time-stack:hover .tautulli-time-eta {
                opacity: 0.82;
            }

            /* Platform Corner Badge (Top-Right of Spec Area) */
            .tautulli-platform-corner-badge {
                position: absolute;
                top: 12px;
                right: 14px;
                width: 28px;
                height: 28px;
                border-radius: 7px;
                display: flex;
                align-items: center;
                justify-content: center;
                box-shadow: 0 4px 12px rgba(0, 0, 0, 0.35);
                z-index: 3;
                border: 1px solid rgba(255, 255, 255, 0.12);
            }

            .tautulli-platform-corner-badge svg {
                width: 16px;
                height: 16px;
            }

            /* Bottom-Right Floating Time Stack (in Card Body) — Frosted Glass HUD Capsule */
            .tautulli-time-stack {
                position: absolute;
                bottom: 10px;
                right: 12px;
                display: flex;
                flex-direction: column;
                align-items: flex-end;
                gap: 2px;
                padding: 4px 8px;
                background: rgba(10, 12, 20, 0.65);
                backdrop-filter: blur(14px);
                -webkit-backdrop-filter: blur(14px);
                border: 1px solid rgba(255, 255, 255, 0.10);
                border-radius: 7px;
                box-shadow: 0 4px 12px rgba(0, 0, 0, 0.45);
                z-index: 3;
                pointer-events: auto;
                cursor: pointer;
                transition: all 0.2s ease;
            }

            .tautulli-time-stack:hover {
                background: rgba(15, 18, 30, 0.88);
                border-color: rgba(229, 160, 13, 0.45);
                box-shadow: 0 4px 16px rgba(0, 0, 0, 0.6), 0 0 10px rgba(229, 160, 13, 0.25);
            }

            .tautulli-time-progress {
                color: #94a3b8;
                font-family: monospace;
                font-size: 10.5px;
                font-variant-numeric: tabular-nums;
                line-height: 1.2;
            }

            .tautulli-time-eta {
                font-size: 11px;
                font-weight: 700;
                color: #e5a00d;
                letter-spacing: 0.02em;
                font-family: monospace;
                font-variant-numeric: tabular-nums;
                line-height: 1.2;
            }

            .tautulli-time-paused {
                color: #fbbf24;
                font-weight: 700;
                text-shadow: 0 0 8px rgba(245, 158, 11, 0.35);
            }

            /* Timeline Bar: Pill Progress Bar between Card Body and Meta Bar */
            .tautulli-card-timeline {
                position: relative;
                z-index: 2;
                width: 100%;
                height: 4px;
                background: rgba(255, 255, 255, 0.07);
                overflow: hidden;
                box-shadow: inset 0 1px 2px rgba(0,0,0,0.5);
            }

            .tautulli-card-timeline .tautulli-progress-buffer {
                position: absolute;
                top: 0;
                left: 0;
                height: 100%;
                background: rgba(255, 255, 255, 0.22);
                transition: width 0.35s ease;
            }

            .tautulli-card-timeline .tautulli-progress-fill {
                position: relative;
                height: 100%;
                background: #e5a00d;
                box-shadow: 0 0 8px rgba(229, 160, 13, 0.5);
                transition: width 1s linear;
            }

            .tautulli-card-timeline .tautulli-progress-fill.directplay {
                background: #22c55e;
                box-shadow: 0 0 8px rgba(34, 197, 94, 0.5);
            }

            .tautulli-card-timeline .tautulli-progress-fill.directstream {
                background: #38bdf8;
                box-shadow: 0 0 8px rgba(56, 189, 248, 0.5);
            }

            .tautulli-card-timeline .tautulli-progress-fill.hw {
                background: #a855f7;
                box-shadow: 0 0 8px rgba(168, 85, 247, 0.5);
            }

            .tautulli-card-timeline .tautulli-progress-fill.transcode {
                background: #f97316;
                box-shadow: 0 0 8px rgba(249, 115, 22, 0.5);
            }

            .tautulli-card-timeline .tautulli-progress-fill.paused {
                background: #94a3b8;
                box-shadow: 0 0 8px rgba(148, 163, 184, 0.4);
                transition: none;
            }

            .tautulli-card-timeline .tautulli-progress-fill.live {
                background: #ef4444 !important;
                box-shadow: 0 0 8px rgba(239, 68, 68, 0.6) !important;
                transition: none;
            }

            /* Card Meta Bar: 2-Line Left (Play/Title/Rating + Type/Subline) + Right User/Actions */
            .tautulli-card-meta-bar {
                position: relative;
                z-index: 1;
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 12px;
                padding: 8px 14px;
                background: rgba(5, 6, 12, 0.55);
                backdrop-filter: blur(24px) saturate(180%);
                -webkit-backdrop-filter: blur(24px) saturate(180%);
                border-top: 1px solid rgba(255, 255, 255, 0.07);
                box-shadow: inset 0 1px 0 0 rgba(255, 255, 255, 0.04);
            }

            .tautulli-meta-left {
                display: flex;
                flex-direction: column;
                gap: 2px;
                min-width: 0;
                flex: 1;
            }

            .tautulli-meta-line-1 {
                display: flex;
                align-items: center;
                gap: 7px;
                min-width: 0;
            }

            .tautulli-meta-line-2 {
                display: flex;
                align-items: center;
                gap: 6px;
                min-width: 0;
                color: #94a3b8;
                font-size: 11px;
                font-weight: 500;
            }

            .tautulli-meta-play-btn {
                background: none;
                border: none;
                padding: 0;
                cursor: pointer;
                display: flex;
                align-items: center;
                justify-content: center;
                transition: transform 0.15s cubic-bezier(0.16,1,0.3,1), opacity 0.15s ease;
                color: #e5a00d;
                flex-shrink: 0;
                transition: transform 0.15s ease, color 0.15s ease;
            }

            .tautulli-meta-play-btn:hover {
                transform: scale(1.18);
                color: #fbbf24;
            
                transform: scale(1.15);
            }

            .tautulli-meta-play-btn:active {
                transform: scale(0.92);
            }

            .tautulli-meta-play-btn svg {
                width: 13px;
                height: 13px;
                fill: currentColor;
            }

            .tautulli-meta-title {
                font-size: 13.5px;
                font-weight: 700;
                color: #ffffff;
                text-decoration: none;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
                transition: color 0.2s ease;
            }

            .tautulli-meta-title:hover {
                color: #e5a00d;
            }

            .tautulli-meta-type-icon {
                display: inline-flex;
                align-items: center;
                color: #94a3b8;
                flex-shrink: 0;
            }

            .tautulli-meta-type-icon svg {
                width: 12px;
                height: 12px;
                fill: currentColor;
            }

            .tautulli-meta-sub {
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
            }

            .tautulli-meta-right {
                display: flex;
                align-items: center;
                gap: 10px;
                flex-shrink: 0;
            }

            .tautulli-meta-user {
                display: flex;
                align-items: center;
                gap: 6px;
                color: #cbd5e1;
                text-decoration: none;
                font-size: 11.5px;
                font-weight: 600;
                transition: color 0.2s ease;
            }

            .tautulli-meta-user:hover {
                color: #ffffff;
            }

            .tautulli-meta-user .tautulli-user-avatar {
                width: 22px;
                height: 22px;
                font-size: 10px;
                border: 1.5px solid rgba(255,255,255,0.18);
                transition: box-shadow 0.3s ease;
            }

            .tautulli-titles-container {
                display: flex;
                flex-direction: column;
                gap: 6px;
            }

            .tautulli-title-line {
                display: flex;
                align-items: center;
                gap: 8px;
                flex-wrap: wrap;
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
                font-size: 11.5px;
                color: #94a3b8;
                font-weight: 500;
                display: inline-flex;
                align-items: center;
                gap: 6px;
                flex-wrap: wrap;
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


            /* LAN/WAN/CELLULAR Connection Pill (Moonfin-style) */
            .tautulli-net-pill {
                display: inline-block;
                font-size: 8px;
                font-weight: 700;
                letter-spacing: 0.08em;
                text-transform: uppercase;
                padding: 2px 6px;
                border-radius: 4px;
                vertical-align: middle;
                margin-left: 5px;
                line-height: 1.5;
                backdrop-filter: blur(4px);
                -webkit-backdrop-filter: blur(4px);
            }
            .tautulli-net-pill-lan {
                background: rgba(34, 197, 94, 0.12);
                color: #4ade80;
                border: 1px solid rgba(34, 197, 94, 0.28);
            }
            .tautulli-net-pill-wan {
                background: rgba(251, 146, 60, 0.12);
                color: #fb923c;
                border: 1px solid rgba(251, 146, 60, 0.28);
            }
            .tautulli-net-pill-cellular {
                background: rgba(251, 191, 36, 0.12);
                color: #fbbf24;
                border: 1px solid rgba(251, 191, 36, 0.28);
            }

            /* Spec Row Hover Highlight */
            .tautulli-spec-row:hover {
                background: rgba(255, 255, 255, 0.025);
                border-radius: 4px;
            }

            /* Muted spec value (for None subtitle etc.) */
            .tautulli-spec-value-muted {
                color: #475569 !important;
                font-style: italic;
            }


            /* Paused Card — Cool Shift: entire card feels "cold" and inactive */
            .tautulli-card-paused {
                filter: saturate(0.7) brightness(0.88);
                transition: filter 0.45s ease;
            }
            .tautulli-card-paused .tautulli-spec-value {
                color: #9aa5b4 !important;
            }
            .tautulli-card-paused .tautulli-stream-directplay,
            .tautulli-card-paused .tautulli-stream-directstream,
            .tautulli-card-paused .tautulli-stream-hw,
            .tautulli-card-paused .tautulli-stream-transcode {
                color: #9aa5b4 !important;
            }

            /* Paused Poster Dimming */
            .tautulli-poster-paused .tautulli-poster-img {
                filter: brightness(0.5) saturate(0.35);
                transition: filter 0.3s ease;
            }
            .tautulli-poster-paused .tautulli-poster-fallback {
                filter: brightness(0.5) saturate(0.35);
            }

            /* Year Badge (clean, refined pill) */
            .tautulli-year-badge {
                display: inline-block;
                font-size: 9px;
                font-weight: 600;
                color: #94a3b8;
                background: rgba(255, 255, 255, 0.06);
                border: 1px solid rgba(255, 255, 255, 0.12);
                border-radius: 4px;
                padding: 1px 5px;
                margin-right: 6px;
                vertical-align: middle;
                letter-spacing: 0.04em;
                flex-shrink: 0;
            }

            /* Live Bandwidth Pulse Dot */
            .tautulli-bw-pulse {
                display: inline-block;
                width: 5px;
                height: 5px;
                border-radius: 50%;
                background: #22c55e;
                margin-left: 6px;
                vertical-align: 1px;
                animation: tautulli-bw-pulse-anim 2s ease-in-out infinite;
                flex-shrink: 0;
            }
            .tautulli-bw-pulse.paused {
                background: #f59e0b;
                animation: none;
                opacity: 0.6;
            }
            @keyframes tautulli-bw-pulse-anim {
                0%, 100% { opacity: 1; transform: scale(1); }
                50% { opacity: 0.4; transform: scale(0.75); }
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

            /* Live Broadcast Badge & Dot Pulse */
            .tautulli-badge-live {
                background: rgba(239, 68, 68, 0.16) !important;
                color: #f87171 !important;
                border: 1px solid rgba(239, 68, 68, 0.4) !important;
                font-weight: 700;
                letter-spacing: 0.5px;
                display: inline-flex;
                align-items: center;
                gap: 5px;
            }

            .tautulli-live-dot {
                width: 6px;
                height: 6px;
                border-radius: 50%;
                background-color: #ef4444;
                box-shadow: 0 0 6px #ef4444;
                animation: tautulli-live-pulse 1.4s ease-in-out infinite;
                flex-shrink: 0;
            }

            @keyframes tautulli-live-pulse {
                0%, 100% { opacity: 1; transform: scale(1); }
                50% { opacity: 0.3; transform: scale(0.8); }
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


            /* Spec Group Separator (8px breathing room between semantic groups) */
            .tautulli-spec-group-sep {
                height: 0;
                margin-top: 5px;
                border-top: 1px solid rgba(255, 255, 255, 0.045);
                margin-bottom: 1px;
                position: relative;
                z-index: 1;
            }

            /* Stream Decision Live Dot (recording-style indicator) */
            .tautulli-stream-dot {
                display: inline-block;
                width: 5px;
                height: 5px;
                border-radius: 50%;
                margin-right: 5px;
                vertical-align: middle;
                flex-shrink: 0;
                animation: tautulli-stream-dot-pulse 2.4s ease-in-out infinite;
            }
            .tautulli-stream-dot-directplay  { background: #22c55e; box-shadow: 0 0 4px rgba(34,197,94,0.7); }
            .tautulli-stream-dot-directstream { background: #38bdf8; box-shadow: 0 0 4px rgba(56,189,248,0.7); }
            .tautulli-stream-dot-hw          { background: #a855f7; box-shadow: 0 0 4px rgba(168,85,247,0.7); }
            .tautulli-stream-dot-transcode   { background: #f97316; box-shadow: 0 0 4px rgba(249,115,22,0.7); }
            @keyframes tautulli-stream-dot-pulse {
                0%, 100% { opacity: 1; transform: scale(1); }
                50%       { opacity: 0.5; transform: scale(0.72); }
            }

            /* Skeleton Loading Shimmer */
            .tautulli-skeleton-wrap {
                padding: 0;
            }
            .tautulli-skeleton-card {
                display: flex;
                gap: 14px;
                padding: 14px;
                background: linear-gradient(155deg, rgba(255,255,255,0.03) 0%, rgba(9,10,16,0.85) 100%);
                border: 1px solid rgba(255,255,255,0.08);
                border-radius: 18px;
                min-height: 158px;
                overflow: hidden;
            }
            .tautulli-skeleton-poster {
                width: 105px;
                min-width: 105px;
                aspect-ratio: 2/3;
                border-radius: 10px;
                background: rgba(255,255,255,0.06);
                overflow: hidden;
                position: relative;
            }
            .tautulli-skeleton-body {
                flex: 1;
                display: flex;
                flex-direction: column;
                gap: 10px;
                justify-content: center;
            }
            .tautulli-skeleton-line {
                height: 9px;
                border-radius: 4px;
                background: rgba(255,255,255,0.06);
                overflow: hidden;
                position: relative;
            }
            .tautulli-skeleton-line.w-40 { width: 40%; }
            .tautulli-skeleton-line.w-50 { width: 50%; }
            .tautulli-skeleton-line.w-60 { width: 60%; }
            .tautulli-skeleton-line.w-70 { width: 70%; }
            .tautulli-skeleton-line.w-80 { width: 80%; }

            .tautulli-skeleton-poster::after,
            .tautulli-skeleton-line::after {
                content: '';
                position: absolute;
                inset: 0;
                background: linear-gradient(
                    90deg,
                    transparent 0%,
                    rgba(255,255,255,0.09) 40%,
                    rgba(255,255,255,0.16) 50%,
                    rgba(255,255,255,0.09) 60%,
                    transparent 100%
                );
                animation: tautulli-skeleton-shimmer 1.6s ease-in-out infinite;
                transform: translateX(-100%);
            }
            @keyframes tautulli-skeleton-shimmer {
                0%   { transform: translateX(-100%); }
                100% { transform: translateX(100%); }
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
            }
        `;
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
     * Formats file size in bytes into clean human-readable strings (e.g. 4.8 GB, 850 MB).
     */
    function formatFileSize(bytes) {
        if (!bytes || isNaN(bytes) || bytes <= 0) return null;
        if (bytes >= 1073741824) {
            return `${(bytes / 1073741824).toFixed(2)} GB`;
        }
        if (bytes >= 1048576) {
            return `${(bytes / 1048576).toFixed(1)} MB`;
        }
        return `${Math.round(bytes / 1024)} KB`;
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
                return `\u23f8 ${formatDuration(pausedSeconds)}`;
            }
            return '\u23f8 Paused';
        }
        if (!remainingSeconds || remainingSeconds <= 0) {
            return '--:--';
        }
        if (etaDisplayMode === 'remaining') {
            if (remainingSeconds < 3600) {
                const mins = Math.max(1, Math.round(remainingSeconds / 60));
                return `-${mins}m`;
            }
            const hrs = Math.floor(remainingSeconds / 3600);
            const mins = Math.round((remainingSeconds % 3600) / 60);
            return `-${hrs}h ${mins}m`;
        }
        // Clock time mode (default) — clean HH:MM, no "ETA:" prefix
        const etaDate = new Date(Date.now() + remainingSeconds * 1000);
        const hours = etaDate.getHours();
        const minutes = etaDate.getMinutes();
        const pad = (n) => (n < 10 ? '0' + n : n);
        return `${pad(hours)}:${pad(minutes)}`;
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
     * Plain-English mapping for Jellyfin transcode reasons.
     */
    const TRANSCODE_REASONS_MAP = {
        ContainerNotSupported: 'Container not supported by client',
        VideoCodecNotSupported: 'Video codec not supported by client',
        AudioCodecNotSupported: 'Audio codec not supported by client',
        SubtitleCodecNotSupported: 'Subtitle codec requires burn-in',
        AudioIsExternal: 'External audio track not supported',
        SecondaryAudioNotSupported: 'Secondary audio not supported',
        VideoProfileNotSupported: 'Video profile level not supported',
        VideoBitDepthNotSupported: 'Bit depth (10-bit) not supported',
        VideoResolutionNotSupported: 'Resolution exceeds client display limit',
        VideoBitrateNotSupported: 'Bitrate exceeds quality setting',
        AudioBitrateNotSupported: 'Audio bitrate exceeds client limit',
        AudioChannelsNotSupported: 'Audio channels not supported',
        AnamorphicVideoNotSupported: 'Anamorphic video not supported',
        InterlacedVideoNotSupported: 'Interlaced video not supported',
        DirectPlayError: 'Direct play error',
        RefFramesNotSupported: 'Reference frames exceed hardware limits'
    };

    function formatTranscodeReason(reason) {
        if (!reason) return 'Transcoding';
        if (TRANSCODE_REASONS_MAP[reason]) {
            return TRANSCODE_REASONS_MAP[reason];
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
                bg: '#1c1c1e',
                color: '#ffffff',
                title: 'Apple TV',
                svg: `<svg viewBox="0 0 24 24"><path d="M21 3H3c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h5v2h8v-2h5c1.1 0 1.99-.9 1.99-2L23 5c0-1.1-.9-2-2-2zm0 14H3V5h18v12z"/></svg>`
            };
        }
        if (combined.includes('webos') || combined.includes('lg')) {
            return {
                bg: '#a50034',
                color: '#ffffff',
                title: 'LG webOS TV',
                svg: `<svg viewBox="0 0 24 24"><path d="M21 3H3c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h5v2h8v-2h5c1.1 0 1.99-.9 1.99-2L23 5c0-1.1-.9-2-2-2zm0 14H3V5h18v12z"/></svg>`
            };
        }
        if (combined.includes('tizen') || combined.includes('samsung')) {
            return {
                bg: '#0f79af',
                color: '#ffffff',
                title: 'Samsung Tizen TV',
                svg: `<svg viewBox="0 0 24 24"><path d="M21 3H3c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h5v2h8v-2h5c1.1 0 1.99-.9 1.99-2L23 5c0-1.1-.9-2-2-2zm0 14H3V5h18v12z"/></svg>`
            };
        }
        if (combined.includes('playstation') || combined.includes('ps4') || combined.includes('ps5')) {
            return {
                bg: '#003791',
                color: '#ffffff',
                title: 'PlayStation',
                svg: `<svg viewBox="0 0 24 24"><path d="M21 6H3c-1.1 0-2 .9-2 2v8c0 1.1.9 2 2 2h18c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm-10 7H9v2H7v-2H5v-2h2V9h2v2h2v2zm4.5 2c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5zm3-3c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5z"/></svg>`
            };
        }
        if (combined.includes('xbox')) {
            return {
                bg: '#107c10',
                color: '#ffffff',
                title: 'Xbox Console',
                svg: `<svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm3.88 15.53c-1.04.52-2.39.84-3.88.84s-2.84-.32-3.88-.84c-.45-.23-.84-.5-1.19-.8 1.13-1.01 2.99-2.36 5.07-2.36s3.94 1.35 5.07 2.36c-.35.3-.74.57-1.19.8zm2.4-2.28c-.89-.92-2.28-1.99-4.28-2.58 1.62-.97 3.39-1.28 4.14-1.34.46 1.19.64 2.52.14 3.92zm-12.56 0c-.5-1.4-.32-2.73.14-3.92.75.06 2.52.37 4.14 1.34-2 .59-3.39 1.66-4.28 2.58z"/></svg>`
            };
        }
        if (combined.includes('swiftfin')) {
            return {
                bg: '#00a4dc',
                color: '#ffffff',
                title: 'Swiftfin Client',
                svg: `<svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 14h-2v-2h2v2zm0-4h-2V7h2v5z"/></svg>`
            };
        }
        if (combined.includes('infuse')) {
            return {
                bg: '#ff4b3a',
                color: '#ffffff',
                title: 'Infuse Player',
                svg: `<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>`
            };
        }
        if (combined.includes('kodi')) {
            return {
                bg: '#17b2e7',
                color: '#ffffff',
                title: 'Kodi Media Center',
                svg: `<svg viewBox="0 0 24 24"><path d="M12 2L2 12l10 10 10-10L12 2zm0 3.83L18.17 12 12 18.17 5.83 12 12 5.83z"/></svg>`
            };
        }
        if (combined.includes('android') || combined.includes('pixel') || combined.includes('shield')) {
            return {
                bg: '#34a853',
                color: '#ffffff',
                title: 'Android / Google TV',
                svg: `<svg viewBox="0 0 24 24"><path d="M6 18c0 .55.45 1 1 1h1v3.5c0 .83.67 1.5 1.5 1.5s1.5-.67 1.5-1.5V19h2v3.5c0 .83.67 1.5 1.5 1.5s1.5-.67 1.5-1.5V19h1c.55 0 1-.45 1-1V8H6v10zM3.5 8C2.67 8 2 8.67 2 9.5v7c0 .83.67 1.5 1.5 1.5S5 17.33 5 16.5v-7C5 8.67 4.33 8 3.5 8zm17 0c-.83 0-1.5.67-1.5 1.5v7c0 .83.67 1.5 1.5 1.5s1.5-.67 1.5-1.5v-7c0-.83-.67-1.5-1.5-1.5zm-4.97-5.84l1.3-1.3c.2-.2.2-.51 0-.71-.2-.2-.51-.2-.71 0l-1.48 1.48C13.85 1.23 12.95 1 12 1c-.96 0-1.86.23-2.66.63L7.85.15c-.2-.2-.51-.2-.71 0-.2.2-.2.51 0 .71l1.31 1.31C6.97 3.26 6 5.01 6 7h12c0-1.99-.97-3.75-2.47-4.84zM10 5H9V4h1v1zm5 0h-1V4h1v1z"/></svg>`
            };
        }
        if (combined.includes('safari')) {
            return {
                bg: '#0071e3',
                color: '#ffffff',
                title: 'Apple Safari',
                svg: `<svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm-5.5-3.5l2.79-6.29 6.29-2.79-2.79 6.29-6.29 2.79zm4.25-4.25c-.41.41-.41 1.09 0 1.5s1.09.41 1.5 0 .41-1.09 0-1.5-1.09-.41-1.5 0z"/></svg>`
            };
        }
        if (combined.includes('apple') || combined.includes('ios') || combined.includes('macos') || combined.includes('iphone') || combined.includes('ipad')) {
            return {
                bg: '#1c1c1e',
                color: '#ffffff',
                title: 'Apple / iOS / macOS',
                svg: `<svg viewBox="0 0 24 24"><path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.81-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M15.97 6.87c.66-.82 1.11-1.96.99-3.1-.96.04-2.12.65-2.8 1.45-.59.69-1.12 1.83-.98 2.94 1.07.08 2.13-.47 2.79-1.29z"/></svg>`
            };
        }
        if (combined.includes('fire') || combined.includes('amazon')) {
            return {
                bg: '#ff9900',
                color: '#ffffff',
                title: 'Amazon Fire TV',
                svg: `<svg viewBox="0 0 24 24"><path d="M21 3H3c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h5v2h8v-2h5c1.1 0 1.99-.9 1.99-2L23 5c0-1.1-.9-2-2-2zm0 14H3V5h18v12z"/></svg>`
            };
        }
        if (combined.includes('chrome')) {
            return {
                bg: '#ea4335',
                color: '#ffffff',
                title: 'Google Chrome',
                svg: `<svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 4a6 6 0 1 1 0 12 6 6 0 0 1 0-12zm0 2a4 4 0 1 0 0 8 4 4 0 0 0 0-8z"/></svg>`
            };
        }
        if (combined.includes('firefox')) {
            return {
                bg: '#ff7139',
                color: '#ffffff',
                title: 'Mozilla Firefox',
                svg: `<svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8z"/></svg>`
            };
        }
        if (combined.includes('edg')) {
            return {
                bg: '#0078d7',
                color: '#ffffff',
                title: 'Microsoft Edge',
                svg: `<svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8z"/></svg>`
            };
        }
        if (combined.includes('roku')) {
            return {
                bg: '#662d91',
                color: '#ffffff',
                title: 'Roku',
                svg: `<svg viewBox="0 0 24 24"><path d="M21 3H3c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h5v2h8v-2h5c1.1 0 1.99-.9 1.99-2L23 5c0-1.1-.9-2-2-2zm0 14H3V5h18v12z"/></svg>`
            };
        }
        // Jellyfin Web (explicit — shows Jellyfin's characteristic ◈ logo shape)
        if (combined.includes('jellyfin') || combined.includes('jelly fin')) {
            return {
                bg: '#00a4dc',
                color: '#ffffff',
                title: 'Jellyfin Web',
                svg: `<svg viewBox="0 0 24 24"><path d="M12 2L2 12l10 10 10-10L12 2zm0 4.5l6.5 6.5-6.5 6.5-6.5-6.5L12 6.5zm0 3.5l-3 3 3 3 3-3-3-3z"/></svg>`
            };
        }
        // Generic web player fallback (monitor icon)
        return {
            bg: '#334155',
            color: '#ffffff',
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
     * Interactive Action: Toggle Mute / Unmute on client session
     */
    async function handleToggleMute(sessionId, isCurrentlyMuted) {
        if (!window.ApiClient || !sessionId) return;
        const command = isCurrentlyMuted ? 'Unmute' : 'Mute';
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
            console.error('[PlaybackCard] Failed to toggle mute state:', err);
        }
    }


    /**
     * Maps raw Jellyfin session data into Tautulli/Jellywatch card view model.
     */
    function mapSessionToCardModel(session, index) {
        const item = session.NowPlayingItem || {};
        const playState = session.PlayState || {};
        const transcodeInfo = session.TranscodingInfo || null;

        // Extract MediaSource details (file size, path, source container, source bitrate)
        const mediaSource = (item.MediaSources && item.MediaSources[0]) || {};
        let sizeBytes = mediaSource.Size || item.Size || 0;
        if (!sizeBytes && (mediaSource.Bitrate || item.Bitrate) && item.RunTimeTicks) {
            const sec = item.RunTimeTicks / 10000000;
            if (sec > 0) {
                sizeBytes = Math.round(((mediaSource.Bitrate || item.Bitrate) * sec) / 8);
            }
        }
        const fileSizeDisplay = formatFileSize(sizeBytes);
        const filePath = mediaSource.Path || item.Path || '';
        const sourceBitrate = mediaSource.Bitrate || item.Bitrate || item.TotalBitrate || 0;
        const origContainer = (mediaSource.Container || item.Container || 'MKV').toUpperCase();

        // Determine Play Method with Tautulli precision
        let playMethod = playState.PlayMethod || (transcodeInfo ? 'Transcode' : 'DirectPlay');
        let isDirectPlay = playMethod === 'DirectPlay';
        let isDirectStream = playMethod === 'DirectStream' || (transcodeInfo != null && transcodeInfo.IsVideoDirect === true && transcodeInfo.IsAudioDirect === true);
        let isTranscode = !isDirectPlay && !isDirectStream && transcodeInfo != null;
        if (!isDirectPlay && !isDirectStream && !isTranscode) {
            if (transcodeInfo) isTranscode = true;
            else isDirectPlay = true;
        }

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

        // Container display (Tautulli style)
        const targetContainer = (transcodeInfo && transcodeInfo.Container ? transcodeInfo.Container.toUpperCase() : (isTranscode ? 'MP4' : origContainer));
        let containerDisplay = `Direct Play (${origContainer})`;
        if (isTranscode && transcodeInfo) {
            if (transcodeInfo.IsVideoDirect && transcodeInfo.IsAudioDirect) {
                containerDisplay = `Direct Stream (${origContainer} ➔ ${targetContainer})`;
            } else {
                containerDisplay = `Transcode (${origContainer} ➔ ${targetContainer})`;
            }
        } else if (isDirectStream) {
            containerDisplay = `Direct Stream (${origContainer} ➔ ${targetContainer})`;
        }
        const containerChip = (isTranscode && transcodeInfo && (!transcodeInfo.IsVideoDirect || !transcodeInfo.IsAudioDirect)) ? `${origContainer} ➔ ${targetContainer}` : origContainer;

        // HDR Detection & Enhanced Tone Mapping Details (HDR10, HDR10+, Dolby Vision, HLG, BT2020)
        let hdrBadge = null;
        let hdrName = null;
        const videoRange = (videoStream.VideoRange || videoStream.VideoRangeType || '').toUpperCase();
        const colorSpace = (videoStream.ColorSpace || '').toUpperCase();
        const colorTransfer = (videoStream.ColorTransfer || '').toLowerCase();
        const colorPrimaries = (videoStream.ColorPrimaries || '').toLowerCase();
        const isHdr = videoRange.includes('HDR') || videoRange.includes('DOVI') || videoRange.includes('HLG') || colorSpace.includes('BT2020') || colorTransfer === 'smpte2084' || colorTransfer === 'arib-std-b67';
        let hdrStandardDesc = null;
        let isToneMapped = false;
        let toneMappingDetail = null;

        if (isHdr) {
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
                hdrName = 'HDR';
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

        // Video: Codec, Resolution, Bit Depth (10-bit), and HDR Format
        const origVideoCodec = (videoStream.Codec || 'H264').toUpperCase();
        const origResInfo = resolveResolutionInfo(videoStream.Width, videoStream.Height);
        const origVideoRes = origResInfo.short;
        const videoBitDepth = videoStream.BitDepth ? `${videoStream.BitDepth}-bit` : '';

        const sourceVideoParts = [origVideoRes, origVideoCodec];
        if (videoBitDepth) sourceVideoParts.push(videoBitDepth);
        if (hdrName) sourceVideoParts.push(hdrName);
        const sourceVideoDesc = sourceVideoParts.join(' ');

        let videoMethod = 'Direct Play';
        if (isDirectStream || (transcodeInfo && transcodeInfo.IsVideoDirect === true)) {
            videoMethod = isDirectPlay ? 'Direct Play' : 'Direct Stream';
        } else if (isTranscode) {
            videoMethod = 'Transcode';
        }

        let videoDisplay = `${videoMethod} (${sourceVideoDesc})`;
        let videoChip = sourceVideoDesc;
        if (videoMethod === 'Transcode' && transcodeInfo && transcodeInfo.IsVideoDirect === false) {
            const targetCodec = (transcodeInfo.VideoCodec || 'H264').toUpperCase();
            const targetResInfo = resolveResolutionInfo(transcodeInfo.Width, transcodeInfo.Height);
            const targetRes = transcodeInfo.Height ? targetResInfo.short : origVideoRes;
            const targetVideoParts = [targetRes, targetCodec, '8-bit'];
            if (isToneMapped) targetVideoParts.push('SDR');
            const toneMapTag = isToneMapped ? ' · Tone Mapped' : '';
            videoDisplay = `Transcode (${sourceVideoDesc} ➔ ${targetVideoParts.join(' ')}${toneMapTag})`;
            videoChip = `${sourceVideoDesc} ➔ ${targetVideoParts.join(' ')}`;
        } else if (transcodeInfo && transcodeInfo.IsVideoDirect === true && isTranscode) {
            videoDisplay = `Direct Stream (${sourceVideoDesc})`;
        }

        // Audio: Codec, Channels, Spatial Atmos, Bit Depth, Sample Rate, and Bitrate
        const origAudioLang = audioStream.Language ? audioStream.Language.toUpperCase() : '';
        const origAudioCodec = (audioStream.Codec || 'AAC').toUpperCase();
        const origChannels = audioStream.Channels === 6 ? '5.1' : audioStream.Channels === 8 ? '7.1' : audioStream.Channels === 2 ? 'Stereo' : (audioStream.Channels ? `${audioStream.Channels} Ch` : 'Stereo');
        const audioTitleUpper = (audioStream.Title || audioStream.DisplayTitle || '').toUpperCase();
        const isAtmos = audioTitleUpper.includes('ATMOS') || audioTitleUpper.includes('JOC');
        const isLossless = origAudioCodec.includes('TRUEHD') || origAudioCodec.includes('DTS-HD') || origAudioCodec.includes('FLAC') || origAudioCodec.includes('ALAC');

        let audioBadge = null;
        if (isAtmos) {
            audioBadge = 'Dolby Atmos';
        } else if (isLossless) {
            audioBadge = 'Lossless';
        }

        const sourceAudioParts = [];
        if (origAudioLang) sourceAudioParts.push(origAudioLang);
        sourceAudioParts.push(origAudioCodec);
        sourceAudioParts.push(origChannels);
        if (isAtmos) sourceAudioParts.push('Atmos');
        if (audioStream.BitDepth && (isLossless || audioStream.BitDepth >= 24)) {
            sourceAudioParts.push(`${audioStream.BitDepth}-bit`);
        }
        if (audioStream.SampleRate && (audioStream.SampleRate >= 48000 || isLossless)) {
            const khz = (audioStream.SampleRate / 1000).toFixed(1).replace('.0', '');
            sourceAudioParts.push(`${khz}kHz`);
        }
        if (audioStream.BitRate) {
            sourceAudioParts.push(`· ${formatBitrate(audioStream.BitRate)}`);
        }

        const origAudioDesc = sourceAudioParts.join(' ');
        let audioMethod = 'Direct Play';
        if (isDirectStream || (transcodeInfo && transcodeInfo.IsAudioDirect === true)) {
            audioMethod = isDirectPlay ? 'Direct Play' : 'Direct Stream';
        } else if (isTranscode) {
            audioMethod = 'Transcode';
        }

        let audioDisplay = `${audioMethod} (${origAudioDesc})`;
        let audioChip = origAudioDesc || `${origAudioCodec} ${origChannels}`;
        if (audioMethod === 'Transcode' && transcodeInfo && transcodeInfo.IsAudioDirect === false) {
            const targetAudioCodec = (transcodeInfo.AudioCodec || 'AAC').toUpperCase();
            const targetChannels = transcodeInfo.AudioChannels === 6 ? '5.1' : transcodeInfo.AudioChannels === 2 ? 'Stereo' : (transcodeInfo.AudioChannels ? `${transcodeInfo.AudioChannels} Ch` : 'Stereo');
            const targetAudioBitrate = transcodeInfo.AudioBitrate ? ` · ${formatBitrate(transcodeInfo.AudioBitrate)}` : '';
            audioDisplay = `Transcode (${origAudioDesc} ➔ ${targetAudioCodec} ${targetChannels}${targetAudioBitrate})`;
            audioChip = `${origAudioDesc} ➔ ${targetAudioCodec} ${targetChannels}`;
        } else if (transcodeInfo && transcodeInfo.IsAudioDirect === true && isTranscode) {
            audioDisplay = `Direct Stream (${origAudioDesc})`;
        }

        // Subtitles (Explicit 'None' if unselected, exactly matching Tautulli)
        let subtitleDisplay = 'None';
        let subChip = null;
        if (subStream) {
            const subTitle = subStream.DisplayTitle || subStream.Language || 'Subtitles';
            const subCodec = (subStream.Codec || 'Text').toUpperCase();
            const burnInStr = isSubtitleBurnIn ? ' · Burn-in' : (subStream.IsExternal ? ' · External' : ' · Embedded');
            subtitleDisplay = `${subTitle} (${subCodec}${burnInStr})`;
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

        // Tautulli Quality String (Original vs Transcoded quality)
        let qualityDisplay = `Original (${formatBitrate(sourceBitrate || currentBitrate)})`;
        if (isTranscode && transcodeInfo && transcodeInfo.IsVideoDirect === false) {
            const targetRes = transcodeInfo.Height ? resolveResolutionInfo(transcodeInfo.Width, transcodeInfo.Height).short : origVideoRes;
            qualityDisplay = `${targetRes} (${formatBitrate(currentBitrate)})`;
        }

        // Tautulli Stream String, Tooltip & CSS Class
        let streamDisplay = 'Direct Play';
        let streamClass = 'directplay';
        let streamTooltip = 'Direct Play: Native hardware playback without server conversion';
        if (isDirectStream) {
            streamDisplay = `Direct Stream${transcodeInfo && transcodeInfo.IsThrottled ? ' (Throttled)' : ''}`;
            streamClass = 'directstream';
            streamTooltip = `Direct Stream: Container conversion (${origContainer} ➔ ${targetContainer})`;
        } else if (isTranscode) {
            streamClass = hwAccelBadge ? 'hw' : 'transcode';
            const streamParts = [];
            if (hwAccelBadge) streamParts.push(hwAccelBadge);
            if (transcodeFps) streamParts.push(`${transcodeFps} fps`);
            if (transcodeSpeedMultiplier) streamParts.push(`${transcodeSpeedMultiplier}x`);
            if (transcodeInfo && transcodeInfo.IsThrottled) streamParts.push('Throttled');
            streamDisplay = `Transcode${streamParts.length > 0 ? ' (' + streamParts.join(' · ') + ')' : ''}`;

            const reasonList = (transcodeInfo && transcodeInfo.TranscodeReasons) || [];
            const reasonStr = reasonList.length > 0 ? reasonList.map(formatTranscodeReason).join(', ') : 'Server conversion active';
            streamTooltip = `Transcode: ${reasonStr}${hwAccelBadge ? ' · ' + hwAccelBadge : ''}${transcodeSpeedMultiplier ? ' · Speed ' + transcodeSpeedMultiplier + 'x' : ''}`;
        }

        // Tautulli Product & Player Display
        const productDisplay = session.Client || 'Jellyfin Web';
        const playerDisplay = resolveDeviceModel(session) || 'Player';
        const fileBasename = filePath
            ? filePath.replace(/\\/g, '/').split('/').pop() || filePath
            : '';
        const fileDisplay = fileBasename
            ? `${fileBasename}${fileSizeDisplay ? ' · ' + fileSizeDisplay : ''}`
            : `${fileSizeDisplay ? fileSizeDisplay + ' · ' : ''}${origContainer}`;
        const bandwidthDisplay = formatBitrate(currentBitrate);

        // Connection & Location Type (CELLULAR vs WAN vs LAN, matching Tautulli)
        const rawIp = session.RemoteEndPoint || '127.0.0.1';
        const isLan = isLanIp(rawIp);
        let cleanIp = rawIp.trim();
        if (cleanIp.startsWith('[') && cleanIp.includes(']')) {
            cleanIp = cleanIp.substring(1, cleanIp.indexOf(']'));
        } else if (cleanIp.includes('.') && cleanIp.includes(':')) {
            cleanIp = cleanIp.split(':')[0];
        }

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

        let locationDisplay = `${connectionBadge}: ${isPrivacyMode ? '[Protected]' : cleanIp}`;

        // Transcode Reasons (filter out duplicate subtitle notice if burn-in badge is already shown)
        let transcodeReasons = (transcodeInfo && transcodeInfo.TranscodeReasons) || [];
        if (isSubtitleBurnIn) {
            transcodeReasons = transcodeReasons.filter((r) => r !== 'SubtitleCodecNotSupported');
        }

        // Detect Live TV / Infinite Stream
        const isLiveStream = Boolean(
            item.IsLiveStream ||
            (playState && playState.IsLiveStream) ||
            (transcodeInfo && transcodeInfo.IsInfiniteStream) ||
            item.Type === 'LiveTvProgram' ||
            item.Type === 'TvChannel' ||
            item.Type === 'LiveTvChannel' ||
            Boolean(item.ChannelId)
        );

        // Timing & Paused tracking
        const positionTicks = playState.PositionTicks || 0;
        const runTimeTicks = item.RunTimeTicks || 0;
        const progressRatio = runTimeTicks > 0 ? Math.min(1, Math.max(0, positionTicks / runTimeTicks)) : (isLiveStream ? 1.0 : 0);
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

        let timeProgressStr = `${formatDuration(currentSeconds)} / ${formatDuration(totalSeconds)}`;
        let etaStr = formatETA(remainingSeconds, playState.IsPaused, pausedDurationSeconds);

        if (isLiveStream) {
            if (totalSeconds > 0) {
                timeProgressStr = `${formatDuration(currentSeconds)} / ${formatDuration(totalSeconds)}`;
                etaStr = playState.IsPaused ? formatETA(0, true, pausedDurationSeconds) : (remainingSeconds > 0 ? formatETA(remainingSeconds, false, 0) : 'Live Broadcast');
            } else {
                timeProgressStr = currentSeconds > 0 ? `${formatDuration(currentSeconds)} elapsed` : 'Live Broadcast';
                etaStr = playState.IsPaused ? formatETA(0, true, pausedDurationSeconds) : 'Live Stream';
            }
        }

        // Titles & Navigation
        let primaryTitle = item.Name || 'Unknown Title';
        let secondaryTitle = ''; // will be set per-type below
        const isAudioItem = item.Type === 'Audio';

        if (item.Type === 'Episode') {
            primaryTitle = item.SeriesName || item.Name;
            const seasonNum = item.ParentIndexNumber != null ? item.ParentIndexNumber : 1;
            const episodeNum = item.IndexNumber != null ? item.IndexNumber : 1;
            secondaryTitle = `S${seasonNum} · E${episodeNum} · ${item.Name}`;
        } else if (isAudioItem) {
            primaryTitle = item.Name;
            const artists = (item.Artists || []).join(', ') || item.AlbumArtist || 'Artist';
            secondaryTitle = `${artists} · ${item.Album || 'Single'}`;
        } else if (isLiveStream) {
            primaryTitle = item.Name || item.ChannelName || 'Live TV';
            const chName = (item.ChannelName && item.ChannelName !== item.Name) ? item.ChannelName : '';
            const prgTime = totalSeconds > 0 ? formatDuration(totalSeconds) : '';
            secondaryTitle = [chName, prgTime, 'Live Broadcast'].filter(Boolean).join(' · ');
        } else {
            // Year is shown separately as tautulli-year-badge — only show duration here
            const durationStr = totalSeconds > 0 ? formatDuration(totalSeconds) : '';
            secondaryTitle = durationStr;
        }

        let displayName = session.UserName || 'User';
        if (isPrivacyMode) {
            displayName = `User #${index + 1}`;
        }

        // Transcode Completion Buffer
        const transcodeCompletionPercentage = (isTranscode && transcodeInfo && transcodeInfo.CompletionPercentage != null)
            ? Math.min(100, Math.max(0, Math.round(transcodeInfo.CompletionPercentage)))
            : null;

        // Detailed media specs
        const videoProfile = videoStream.Profile || null;
        const videoFrameRate = videoStream.AverageFrameRate ? `${Math.round(videoStream.AverageFrameRate)} fps` : (videoStream.RealFrameRate ? `${Math.round(videoStream.RealFrameRate)} fps` : null);
        const audioSampleRate = audioStream.SampleRate ? `${(audioStream.SampleRate / 1000).toFixed(1)} kHz` : null;
        const audioBitRate = audioStream.BitRate ? formatBitrate(audioStream.BitRate) : null;
        const isMuted = Boolean(playState.IsMuted);
        const volumeLevel = playState.VolumeLevel != null ? Math.round(playState.VolumeLevel) : null;
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
            productDisplay,
            playerDisplay,
            qualityDisplay,
            streamDisplay,
            streamTooltip,
            streamClass,
            fileDisplay,
            fileSizeDisplay,
            filePath,
            origContainer,
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
            audioSampleRate,
            audioBitRate,
            isMuted,
            volumeLevel,
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
            isMuted: Boolean(playState.IsMuted),
            volumeLevel,
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
            isAudioItem,
            isLiveStream
        };

        return model;
    }

    /**
     * Renders an individual session card element HTML string aligned 1:1 with Tautulli.
     */
    function renderSessionCard(card) {
        // Poster image or clean SVG fallback
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
            const streamRing = card.streamClass === 'directplay' ? '0 0 0 1.5px #22c55e, 0 0 8px rgba(34,197,94,0.45)' :
                card.streamClass === 'directstream' ? '0 0 0 1.5px #38bdf8, 0 0 8px rgba(56,189,248,0.45)' :
                card.streamClass === 'hw' ? '0 0 0 1.5px #a855f7, 0 0 8px rgba(168,85,247,0.45)' :
                '0 0 0 1.5px #f97316, 0 0 8px rgba(249,115,22,0.45)';
            avatarHtml = `<div class="tautulli-user-avatar" style="box-shadow: ${streamRing};"><img src="${escapeHtml(card.userAvatarUrl)}" alt="${escapeHtml(card.userName)}" /></div>`;
        } else {
            const initial = (card.userName ? card.userName.charAt(0).toUpperCase() : 'U');
            const bgColor = getAvatarColor(card.userName);
            const streamRingFallback = card.streamClass === 'directplay' ? '0 0 0 1.5px #22c55e, 0 0 8px rgba(34,197,94,0.45)' :
                card.streamClass === 'directstream' ? '0 0 0 1.5px #38bdf8, 0 0 8px rgba(56,189,248,0.45)' :
                card.streamClass === 'hw' ? '0 0 0 1.5px #a855f7, 0 0 8px rgba(168,85,247,0.45)' :
                '0 0 0 1.5px #f97316, 0 0 8px rgba(249,115,22,0.45)';
            avatarHtml = `<div class="tautulli-user-avatar" style="background: ${bgColor}; box-shadow: ${streamRingFallback};">${initial}</div>`;
        }

        // Media Type Icon
        let typeIconSvg = '';
        if (card.isAudioItem || card.mediaItemType === 'Audio') {
            typeIconSvg = '<svg viewBox="0 0 24 24"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg>';
        } else if (card.mediaItemType === 'Episode' || card.seriesName) {
            typeIconSvg = '<svg viewBox="0 0 24 24"><path d="M21 3H3c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h5v2h8v-2h5c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 14H3V5h18v12z"/></svg>';
        } else {
            typeIconSvg = '<svg viewBox="0 0 24 24"><path d="M18 4l2 4h-3l-2-4h-2l2 4h-3l-2-4H8l2 4H7L5 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V4h-4z"/></svg>';
        }

        // Direct detail link
        const detailHref = card.itemId ? `#!/details?id=${encodeURIComponent(card.itemId)}` : '#';
        const userHref = card.userId ? `#!/useredit.html?userId=${encodeURIComponent(card.userId)}` : '#';

        return `
            <div class="tautulli-card${card.isPaused ? ' tautulli-card-paused' : ''}" data-session-id="${escapeHtml(card.sessionId)}" style="
                --stream-accent: ${
                    card.streamClass === 'directplay' ? '#22c55e' :
                    card.streamClass === 'directstream' ? '#38bdf8' :
                    card.streamClass === 'hw' ? '#a855f7' :
                    '#f97316'
                };
                --stream-glow: ${
                    card.streamClass === 'directplay' ? 'rgba(34,197,94,0.10)' :
                    card.streamClass === 'directstream' ? 'rgba(56,189,248,0.10)' :
                    card.streamClass === 'hw' ? 'rgba(168,85,247,0.10)' :
                    'rgba(249,115,22,0.10)'
                };
                box-shadow:
                    inset 3px 0 0 0 var(--stream-accent),
                    inset 0 1px 0 0 rgba(255,255,255,0.22),
                    inset 0 0 0 1px rgba(255,255,255,0.10),
                    inset -1px 0 0 0 rgba(244,114,182,0.05),
                    inset 0 -1px 0 0 rgba(255,255,255,0.03),
                    0 0 28px 2px var(--stream-glow),
                    0 24px 52px -8px rgba(0,0,0,0.88),
                    0 8px 24px -4px rgba(0,0,0,0.6);
            ">
                ${card.posterUrl ? `<div class="tautulli-card-ambient-bg" style="background-image: url('${escapeHtml(card.posterUrl)}');"></div>` : ''}
                ${card.backdropUrl ? `<div class="tautulli-card-fanart-backdrop" style="background-image: url('${escapeHtml(card.backdropUrl)}');"></div>` : ''}

                <!-- Card Body: Poster + Authentic Tautulli Spec Grid + Floating Time Stack -->
                <div class="tautulli-card-body">
                    <!-- Left Poster Artwork -->
                    <a href="${detailHref}" class="tautulli-poster-wrapper${card.isPaused ? ' tautulli-poster-paused' : ''}" title="View details: ${escapeHtml(card.primaryTitle)}">
                        ${artworkHtml}
                    </a>

                    <!-- Platform Corner Badge -->
                    ${card.platformBadge ? `
                    <div class="tautulli-platform-corner-badge" style="background: ${card.platformBadge.bg}; color: ${card.platformBadge.color};" title="${escapeHtml(card.platformBadge.title)}">
                        ${card.platformBadge.svg}
                    </div>` : ''}

                    <!-- 2-Column Key-Value Spec Grid -->
                    <div class="tautulli-spec-table">
                        <div class="tautulli-spec-row">
                            <span class="tautulli-spec-label">PRODUCT</span>
                            <span class="tautulli-spec-value" title="${escapeHtml(card.productDisplay)}">${escapeHtml(card.productDisplay)}</span>
                        </div>
                        <div class="tautulli-spec-row">
                            <span class="tautulli-spec-label">PLAYER</span>
                            <span class="tautulli-spec-value" title="${escapeHtml(card.playerDisplay)}">${escapeHtml(card.playerDisplay)}</span>
                        </div>
                        <div class="tautulli-spec-row">
                            <span class="tautulli-spec-label">QUALITY</span>
                            <span class="tautulli-spec-value" title="${escapeHtml(card.qualityDisplay)}">${escapeHtml(card.qualityDisplay)}</span>
                        </div>
                        <div class="tautulli-spec-group-sep"></div>
                        <div class="tautulli-spec-row">
                            <span class="tautulli-spec-label">STREAM</span>
                            <span class="tautulli-spec-value tautulli-stream-${escapeHtml(card.streamClass)}" title="${escapeHtml(card.streamTooltip || card.streamDisplay)}"><span class="tautulli-stream-dot tautulli-stream-dot-${escapeHtml(card.streamClass)}"></span>${escapeHtml(card.streamDisplay)}</span>
                        </div>
                        <div class="tautulli-spec-row">
                            <span class="tautulli-spec-label">CONTAINER</span>
                            <span class="tautulli-spec-value" title="${escapeHtml(card.containerDisplay)}">${escapeHtml(card.containerChip)}</span>
                        </div>
                        ${!card.isAudioItem ? `
                        <div class="tautulli-spec-row">
                            <span class="tautulli-spec-label">VIDEO</span>
                            <span class="tautulli-spec-value" title="${escapeHtml(card.videoDisplay)}">${escapeHtml(card.videoDisplay)}</span>
                        </div>` : ''}
                        <div class="tautulli-spec-row">
                            <span class="tautulli-spec-label">AUDIO</span>
                            <span class="tautulli-spec-value" title="${escapeHtml(card.audioDisplay)}">${escapeHtml(card.audioDisplay)}</span>
                        </div>
                        ${!card.isAudioItem ? `
                        <div class="tautulli-spec-row">
                            <span class="tautulli-spec-label">SUBTITLE</span>
                            <span class="tautulli-spec-value${card.subtitleDisplay === 'None' ? ' tautulli-spec-value-muted' : ''}" title="${escapeHtml(card.subtitleDisplay)}">${escapeHtml(card.subtitleDisplay)}</span>
                        </div>` : ''}
                        <div class="tautulli-spec-group-sep"></div>
                        <div class="tautulli-spec-row">
                            <span class="tautulli-spec-label">LOCATION</span>
                            <span class="tautulli-spec-value" title="${escapeHtml(card.locationDisplay)}">${escapeHtml(card.locationDisplay)} <span class="tautulli-net-pill tautulli-net-pill-${card.connectionType ? card.connectionType.toLowerCase() : 'lan'}">${escapeHtml(card.connectionType || 'LAN')}</span></span>
                        </div>
                        <div class="tautulli-spec-row">
                            <span class="tautulli-spec-label">BANDWIDTH</span>
                            <span class="tautulli-spec-value" title="${escapeHtml(card.bandwidthDisplay)}"><strong>${escapeHtml(card.bandwidthDisplay)}</strong><span class="tautulli-bw-pulse${card.isPaused ? ' paused' : ''}"></span></span>
                        </div>
                        <div class="tautulli-spec-row tautulli-spec-row-clickable" data-action="copy-filepath" data-filepath="${escapeHtml(card.filePath || card.fileDisplay)}" title="Click to copy file path: ${escapeHtml(card.filePath || card.fileDisplay)}">
                            <span class="tautulli-spec-label">FILE</span>
                            <span class="tautulli-spec-value" title="${escapeHtml(card.filePath || card.fileDisplay)}">${escapeHtml(card.fileDisplay)}</span>
                        </div>
                    </div>

                    <!-- Bottom-Right Floating Time Stack -->
                    <div class="tautulli-time-stack" data-action="toggle-eta-mode" title="Click to toggle between Clock Time and Time Remaining">
                        <span class="tautulli-time-eta ${card.isPaused ? 'tautulli-time-paused' : ''}">${escapeHtml(card.etaStr)}</span>
                        <span class="tautulli-time-progress">${escapeHtml(card.timeProgressStr)}</span>
                    </div>
                </div>

                <!-- Timeline Bar (Sleek Horizontal Line) -->
                <div class="tautulli-card-timeline">
                    ${card.transcodeCompletionPercentage != null ? `<div class="tautulli-progress-buffer" style="width: ${card.transcodeCompletionPercentage}%;"></div>` : ''}
                    <div class="tautulli-progress-fill ${escapeHtml(card.streamClass)} ${card.isLiveStream ? 'live' : ''} ${card.isPaused ? 'paused' : ''}" style="width: ${card.progressPercent}%; box-shadow: ${card.isPaused ? 'none' : (
                card.streamClass === 'directplay' ? '0 0 6px 0 rgba(34,197,94,0.55)' :
                card.streamClass === 'directstream' ? '0 0 6px 0 rgba(56,189,248,0.55)' :
                card.streamClass === 'hw' ? '0 0 6px 0 rgba(168,85,247,0.55)' :
                '0 0 6px 0 rgba(249,115,22,0.55)'
            )};"></div>
                </div>

                <!-- Bottom Meta Bar: Title, Subline, Rating, User & Stream Actions -->
                <div class="tautulli-card-meta-bar">
                    <div class="tautulli-meta-left">
                        <div class="tautulli-meta-line-1">
                            <button class="tautulli-meta-play-btn ${card.isPaused ? 'paused' : 'playing'}" data-action="toggle-play" data-session-id="${escapeHtml(card.sessionId)}" data-paused="${card.isPaused ? 'true' : 'false'}" title="${card.isPaused ? 'Click to Resume' : 'Click to Pause'}">
                                ${card.isPaused 
                                    ? '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>'
                                    : '<svg viewBox="0 0 24 24"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>'}
                            </button>
                            <a href="${detailHref}" class="tautulli-meta-title" title="${escapeHtml(card.primaryTitle)}">
                                ${escapeHtml(card.primaryTitle)}
                            </a>
                            ${card.officialRating ? `<span class="tautulli-rating-badge">${escapeHtml(card.officialRating)}</span>` : ''}
                        </div>
                        <div class="tautulli-meta-line-2">
                            <span class="tautulli-meta-type-icon">${typeIconSvg}</span>
                            ${(card.mediaItemYear && !card.isAudioItem && !card.isLiveStream) ? `<span class="tautulli-year-badge">${escapeHtml(String(card.mediaItemYear))}</span>` : ''}
                            <span class="tautulli-meta-sub">${escapeHtml(card.secondaryTitle || '')}</span>
                        </div>
                    </div>
                    <div class="tautulli-meta-right">
                        <a href="${userHref}" class="tautulli-meta-user" title="User: ${escapeHtml(card.userName)}">
                            ${avatarHtml}
                            <span class="tautulli-meta-username">${escapeHtml(card.userName)}</span>
                        </a>
                        <div class="tautulli-action-cluster">
                            <button class="tautulli-action-btn tautulli-action-btn-mute ${card.isMuted ? 'muted' : ''}" data-action="toggle-mute" data-session-id="${escapeHtml(card.sessionId)}" data-muted="${card.isMuted ? 'true' : 'false'}" title="${card.isMuted ? 'Unmute Player' : 'Mute Player'}">
                                ${card.isMuted 
                                    ? '<svg viewBox="0 0 24 24"><path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27l4.73 4.73H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/></svg>' 
                                    : '<svg viewBox="0 0 24 24"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/></svg>'}
                            </button>
                            <button class="tautulli-action-btn" data-action="message-user" data-session-id="${escapeHtml(card.sessionId)}" data-user="${escapeHtml(card.userName)}" title="Send message to player">
                                <svg viewBox="0 0 24 24"><path d="M20 2H4c-1.1 0-1.99.9-1.99 2L2 22l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-2 12H6v-2h12v2zm0-3H6V9h12v2zm0-3H6V6h12v2z"/></svg>
                            </button>
                            <button class="tautulli-action-btn tautulli-action-btn-kill" data-action="kill-stream" data-session-id="${escapeHtml(card.sessionId)}" data-user="${escapeHtml(card.userName)}" data-title="${escapeHtml(card.primaryTitle)}" title="Terminate stream">
                                <svg viewBox="0 0 24 24"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        `;
    }


    /**
     * Renders the connected devices grid chips.
     */
    function renderConnectedDevicesHtml(idleSessions) {
        if (!idleSessions || idleSessions.length === 0) return '';
        return `
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
                            <div class="tautulli-connected-device-chip">
                                <div class="tautulli-connected-device-icon">
                                    <svg style="width:14px;height:14px;" fill="currentColor" viewBox="0 0 24 24"><path d="M20 18c1.1 0 1.99-.9 1.99-2L22 6c0-1.1-.9-2-2-2H4c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2H0v2h24v-2h-4zM4 6h16v10H4V6z"/></svg>
                                </div>
                                <div class="tautulli-connected-device-info">
                                    <div class="tautulli-connected-device-name">${devName}</div>
                                    <div class="tautulli-connected-device-meta">${user} · ${client}</div>
                                </div>
                                <div class="tautulli-connected-device-status" title="Active Jellyfin Session">Online</div>
                            </div>
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
        const privacyBtnClass = isPrivacyMode ? 'tautulli-tool-btn active' : 'tautulli-tool-btn';

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
                            ${(idleSessions && idleSessions.length > 0) ? `<span>|</span><span>Connected: <span class="tautulli-activity-stat-highlight">${idleSessions.length} device${idleSessions.length > 1 ? 's' : ''}</span></span>` : ''}
                        </div>
                    </div>
                    <div class="tautulli-activity-tools">
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
                    ${renderConnectedDevicesHtml(idleSessions)}
                </div>
            `;
        }

        // Aggregate statistics for the Tautulli Activity Banner
        const totalStreams = cards.length;
        const directPlayCount = cards.filter((c) => c.isDirectPlay).length;
        const directStreamCount = cards.filter((c) => c.isDirectStream).length;
        const transcodeCount = cards.filter((c) => c.isTranscode).length;
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

        // Bandwidth Rolling History update
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
                        <span><span class="tautulli-activity-stat-highlight">${totalStreams}</span> stream${totalStreams !== 1 ? 's' : ''} ${breakdownStr}</span>
                        <span>|</span>
                        <span>Bandwidth: <span class="tautulli-activity-stat-highlight">${bandwidthDetail}</span>${bandwidthVisualHtml}${sparklineHtml}</span>
                        ${(idleSessions && idleSessions.length > 0) ? `<span>|</span><span>Connected: <span class="tautulli-activity-stat-highlight">${idleSessions.length} device${idleSessions.length > 1 ? 's' : ''}</span></span>` : ''}
                    </div>
                    ${totalStreams > 1 ? `
                    <div class="tautulli-filter-group">
                        <button class="tautulli-filter-pill ${currentFilter === 'all' ? 'active' : ''}" data-action="set-filter" data-filter="all">All (${totalStreams})</button>
                        ${transcodeCount > 0 ? `<button class="tautulli-filter-pill ${currentFilter === 'transcode' ? 'active' : ''}" data-action="set-filter" data-filter="transcode">Transcode (${transcodeCount})</button>` : ''}
                        ${wanCount > 0 ? `<button class="tautulli-filter-pill ${currentFilter === 'wan' ? 'active' : ''}" data-action="set-filter" data-filter="wan">WAN (${wanCount})</button>` : ''}
                        ${pausedCount > 0 ? `<button class="tautulli-filter-pill ${currentFilter === 'paused' ? 'active' : ''}" data-action="set-filter" data-filter="paused">Paused (${pausedCount})</button>` : ''}
                    </div>` : ''}
                </div>

                <div class="tautulli-activity-tools">
                    <button class="${privacyBtnClass}" data-action="toggle-privacy" title="Mask IP addresses and usernames for streaming/screenshots">
                        <svg style="width:13px;height:13px;" fill="currentColor" viewBox="0 0 24 24"><path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z"/></svg>
                        <span>${isPrivacyMode ? 'Privacy On' : 'Privacy'}</span>
                    </button>
                </div>
            </div>
            ${cardsContentHtml}
            ${(CONFIG.SHOW_IDLE_SESSIONS && idleSessions && idleSessions.length > 0) ? renderConnectedDevicesHtml(idleSessions) : ''}
        `;
    }

    /**
     * Fallback clipboard copy for non-HTTPS (local IP) environments.
     */
    function copyToClipboardFallback(text) {
        try {
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.style.position = 'fixed';
            ta.style.opacity = '0';
            document.body.appendChild(ta);
            ta.select();
            const success = document.execCommand('copy');
            ta.remove();
            return success;
        } catch (e) {
            return false;
        }
    }

    /**
     * Attaches interactive event listeners to container elements (Stop, Message, PlayPause, Mute, Privacy, Filter, Stats).
     */
    function attachContainerEvents(container) {
        container.onclick = function (e) {
            const target = e.target.closest('[data-action]');
            if (!target) return;

            const action = target.getAttribute('data-action');

            if (action === 'toggle-privacy') {
                e.preventDefault();
                isPrivacyMode = !isPrivacyMode;
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

            if (action === 'copy-filepath') {
                e.preventDefault();
                e.stopPropagation();
                const path = target.getAttribute('data-filepath');
                if (path) {
                    const markCopied = () => {
                        const valEl = target.querySelector('.tautulli-spec-value');
                        if (valEl) {
                            const origText = valEl.textContent;
                            valEl.textContent = '✓ Copied!';
                            valEl.style.color = '#34d399';
                            setTimeout(() => {
                                valEl.textContent = origText;
                                valEl.style.color = '';
                            }, 2000);
                        }
                    };
                    if (navigator.clipboard && navigator.clipboard.writeText) {
                        navigator.clipboard.writeText(path).then(markCopied).catch(() => {
                            if (copyToClipboardFallback(path)) markCopied();
                        });
                    } else if (copyToClipboardFallback(path)) {
                        markCopied();
                    }
                }
                return;
            }

            if (action === 'toggle-eta-mode') {
                e.preventDefault();
                e.stopPropagation();
                etaDisplayMode = (etaDisplayMode === 'clock') ? 'remaining' : 'clock';
                try {
                    localStorage.setItem('jellyfin_playbackcard_eta_mode', etaDisplayMode);
                } catch (err) {}
                lastRenderedHash = '';
                fetchAndRenderSessions();
                return;
            }

            const sessionId = target.getAttribute('data-session-id');
            const userName = target.getAttribute('data-user') || 'User';
            const mediaTitle = target.getAttribute('data-title') || 'Media';

            if (action === 'kill-stream') {
                e.preventDefault();
                handleKillStream(sessionId, userName, mediaTitle);
            } else if (action === 'message-user') {
                e.preventDefault();
                handleSendMessage(sessionId, userName);
            } else if (action === 'toggle-play') {
                e.preventDefault();
                const isPaused = target.getAttribute('data-paused') === 'true';
                handleTogglePlayPause(sessionId, isPaused);
            } else if (action === 'toggle-mute') {
                e.preventDefault();
                const isMuted = target.getAttribute('data-muted') === 'true';
                handleToggleMute(sessionId, isMuted);
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

            currentCardModels = cards;

            // Compute hash of content to avoid redundant DOM mutations
            const contentHash = JSON.stringify({
                placement: placementMode,
                privacy: isPrivacyMode,
                filter: currentFilter,
                etaMode: etaDisplayMode,
                idleCount: idleSessions.length,
                cards: cards.map((c) => ({
                    id: c.sessionId,
                    method: c.playMethod,
                    paused: c.isPaused,
                    muted: c.isMuted,
                    buf: c.transcodeCompletionPercentage,
                    bw: c.bandwidthDisplay,
                    hw: c.hwAccelBadge,
                    speed: c.transcodeSpeedMultiplier,
                    savings: c.bandwidthSavingsBadge || '',
                    conn: c.connectionType || '',
                    sync: c.syncPlayBadge || '',
                    hires: c.isHiResAudio || false
                }))
            });

            if (contentHash !== lastRenderedHash) {
                lastRenderedHash = contentHash;
                container.innerHTML = renderContainer(cards, idleSessions);
                attachContainerEvents(container);
            } else {
                // In-place smooth re-sync on poll: updates progress & ETA without DOM teardown
                cards.forEach((card) => {
                    const cardEl = container.querySelector(`.tautulli-card[data-session-id="${card.sessionId}"]`);
                    if (!cardEl) return;
                    if (!card.isPaused) {
                        const fillEl = cardEl.querySelector('.tautulli-progress-fill');
                        if (fillEl && card.totalSeconds > 0) {
                            fillEl.style.width = `${card.progressPercent}%`;
                        }
                        const timeProgressEl = cardEl.querySelector('.tautulli-time-progress');
                        if (timeProgressEl) {
                            timeProgressEl.textContent = card.timeProgressStr;
                        }
                        const etaEl = cardEl.querySelector('.tautulli-time-eta');
                        if (etaEl) {
                            etaEl.textContent = card.etaStr;
                        }
                    }
                });
            }

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
                            etaEl.textContent = card.isLiveStream ? 'Live Stream' : formatETA(remainingSec, false, 0);
                        }
                    } else if (card.isLiveStream) {
                        card.currentSeconds += 1;
                        const fillEl = cardEl.querySelector('.tautulli-progress-fill');
                        if (fillEl) {
                            fillEl.style.width = '100%';
                        }
                        const timeProgressEl = cardEl.querySelector('.tautulli-time-progress');
                        if (timeProgressEl) {
                            timeProgressEl.textContent = `${formatDuration(card.currentSeconds)} elapsed`;
                        }
                        const etaEl = cardEl.querySelector('.tautulli-time-eta');
                        if (etaEl) {
                            etaEl.textContent = 'Live Stream';
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
        loadServerConfiguration();
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
            <div class="tautulli-skeleton-wrap">
                <div class="tautulli-skeleton-card">
                    <div class="tautulli-skeleton-poster"></div>
                    <div class="tautulli-skeleton-body">
                        <div class="tautulli-skeleton-line w-60"></div>
                        <div class="tautulli-skeleton-line w-40"></div>
                        <div class="tautulli-skeleton-line w-80"></div>
                        <div class="tautulli-skeleton-line w-50"></div>
                        <div class="tautulli-skeleton-line w-70"></div>
                    </div>
                </div>
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

    console.info('[PlaybackCard] Jellyfin Playback Info Card v0.2.0 initialized successfully.');
})();
