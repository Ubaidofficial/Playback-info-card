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
    let isDashboardActive = false;
    let isFetching = false;
    let lastRenderedHash = '';
    let isPrivacyMode = false;
    const sessionPausedTimestamps = new Map(); // sessionId -> timestamp when pause was first detected

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
            /* Container & Activity Banner */
            #${CONFIG.CONTAINER_ID} {
                width: 100%;
                margin: 0 0 28px 0;
                padding: 0;
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
                box-sizing: border-box;
                color: #e0e0e0;
                -webkit-font-smoothing: antialiased;
            }

            /* Activity Banner - Moonfin Liquid Glass */
            .tautulli-activity-banner {
                display: flex;
                align-items: center;
                justify-content: space-between;
                flex-wrap: wrap;
                gap: 12px;
                padding: 12px 18px;
                margin-bottom: 20px;
                background: linear-gradient(135deg, rgba(255, 255, 255, 0.05) 0%, rgba(255, 255, 255, 0.01) 100%), rgba(16, 16, 22, 0.72);
                backdrop-filter: blur(24px) saturate(190%) contrast(105%);
                -webkit-backdrop-filter: blur(24px) saturate(190%) contrast(105%);
                border: 1px solid rgba(255, 255, 255, 0.09);
                border-radius: 12px;
                box-shadow: inset 0 1px 1px 0 rgba(255, 255, 255, 0.12), 0 8px 32px 0 rgba(0, 0, 0, 0.35);
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
                color: #a0a0a0;
                display: flex;
                align-items: center;
                gap: 12px;
                flex-wrap: wrap;
            }

            .tautulli-activity-stat-highlight {
                color: #ffffff;
                font-weight: 600;
            }

            .tautulli-activity-tools {
                display: flex;
                align-items: center;
                gap: 8px;
            }

            .tautulli-tool-btn {
                background: rgba(255, 255, 255, 0.06);
                border: 1px solid rgba(255, 255, 255, 0.1);
                color: #cccccc;
                border-radius: 7px;
                padding: 5px 10px;
                font-size: 11px;
                cursor: pointer;
                display: flex;
                align-items: center;
                gap: 6px;
                backdrop-filter: blur(8px);
                transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
            }

            .tautulli-tool-btn:hover {
                background: rgba(255, 255, 255, 0.14);
                border-color: rgba(255, 255, 255, 0.2);
                color: #ffffff;
                transform: scale(1.04);
            }

            .tautulli-tool-btn.active {
                background: rgba(0, 164, 220, 0.25);
                border-color: rgba(0, 164, 220, 0.55);
                color: #00c9ff;
                box-shadow: 0 0 12px rgba(0, 164, 220, 0.3);
            }

            /* Responsive Session Grid */
            .tautulli-grid {
                display: grid;
                grid-template-columns: repeat(auto-fill, minmax(460px, 1fr));
                gap: 22px;
                width: 100%;
                box-sizing: border-box;
            }

            @media (max-width: 520px) {
                .tautulli-grid {
                    grid-template-columns: 1fr;
                }
            }

            /* Session Card - Moonfin Liquid Glass Stream Architecture */
            .tautulli-card {
                position: relative;
                display: flex;
                flex-direction: column;
                border-radius: 18px;
                overflow: hidden;
                background: linear-gradient(135deg, rgba(255, 255, 255, 0.055) 0%, rgba(255, 255, 255, 0.012) 100%), rgba(14, 15, 22, 0.78);
                backdrop-filter: blur(30px) saturate(190%) contrast(105%);
                -webkit-backdrop-filter: blur(30px) saturate(190%) contrast(105%);
                border: 1px solid rgba(255, 255, 255, 0.10);
                box-shadow: inset 0 1px 1px 0 rgba(255, 255, 255, 0.18), inset 0 -1px 0 0 rgba(255, 255, 255, 0.03), 0 18px 46px -10px rgba(0, 0, 0, 0.65);
                transition: transform 0.28s cubic-bezier(0.16, 1, 0.3, 1), box-shadow 0.28s cubic-bezier(0.16, 1, 0.3, 1), border-color 0.28s ease;
            }

            .tautulli-card:hover {
                transform: translateY(-2px);
                border-color: rgba(0, 198, 255, 0.38);
                box-shadow: inset 0 1px 1.5px 0 rgba(255, 255, 255, 0.25), 0 22px 52px -10px rgba(0, 0, 0, 0.75), 0 0 26px -4px rgba(0, 198, 255, 0.2);
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
                filter: blur(54px) saturate(190%) brightness(0.25);
                opacity: 0.65;
                pointer-events: none;
                z-index: 0;
            }

            /* Right-Side Fanart Backdrop with Frosted Liquid Glass Vignette Mask (Tautulli + Moonfin) */
            .tautulli-card-fanart-backdrop {
                position: absolute;
                top: 0;
                right: 0;
                width: 72%;
                height: 100%;
                background-size: cover;
                background-position: center right;
                opacity: 0.35;
                pointer-events: none;
                z-index: 0;
                mask-image: linear-gradient(to right, transparent 0%, rgba(0, 0, 0, 0.75) 25%, black 100%);
                -webkit-mask-image: linear-gradient(to right, transparent 0%, rgba(0, 0, 0, 0.75) 25%, black 100%);
            }

            /* Card Header: User & Client Strip */
            .tautulli-card-header {
                position: relative;
                z-index: 1;
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 10px;
                padding: 10px 14px;
                background: rgba(0, 0, 0, 0.38);
                border-bottom: 1px solid rgba(255, 255, 255, 0.06);
                backdrop-filter: blur(12px);
                -webkit-backdrop-filter: blur(12px);
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
                background: linear-gradient(135deg, #e91e63, #9c27b0);
                border: 1px solid rgba(255, 255, 255, 0.2);
                box-shadow: 0 2px 8px rgba(0, 0, 0, 0.4);
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
                background: rgba(255, 255, 255, 0.06);
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
                border-radius: 7px;
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
                border-radius: 8px;
                display: flex;
                align-items: center;
                justify-content: center;
                background: rgba(255, 255, 255, 0.07);
                border: 1px solid rgba(255, 255, 255, 0.12);
                color: #94a3b8;
                cursor: pointer;
                backdrop-filter: blur(10px);
                -webkit-backdrop-filter: blur(10px);
                transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
            }

            .tautulli-action-btn:hover {
                background: rgba(255, 255, 255, 0.18);
                border-color: rgba(255, 255, 255, 0.28);
                color: #ffffff;
                transform: scale(1.08);
            }

            .tautulli-action-btn-kill:hover {
                background: rgba(239, 68, 68, 0.25);
                border-color: rgba(239, 68, 68, 0.6);
                color: #f87171;
                box-shadow: 0 0 12px rgba(239, 68, 68, 0.4);
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
                background: rgba(0, 0, 0, 0.22);
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
                box-shadow: 0 8px 24px rgba(0, 0, 0, 0.55);
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
                transform: scale(1.06);
                filter: brightness(1.08);
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
                letter-spacing: -0.015em;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
                transition: color 0.2s ease;
            }

            .tautulli-title-primary:hover {
                color: #00c9ff;
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
                background: rgba(255, 255, 255, 0.08);
                border: 1px solid rgba(255, 255, 255, 0.14);
                font-size: 9.5px;
                font-weight: 600;
                color: #cbd5e1;
                letter-spacing: 0.02em;
                line-height: 1.2;
            }

            /* Badge Pill Row */
            .tautulli-badge-row {
                display: flex;
                align-items: center;
                gap: 6px;
                flex-wrap: wrap;
            }

            .tautulli-badge {
                display: inline-flex;
                align-items: center;
                gap: 4px;
                padding: 2.5px 8px;
                border-radius: 9999px;
                font-size: 9.5px;
                font-weight: 700;
                text-transform: uppercase;
                letter-spacing: 0.04em;
                line-height: 1.3;
                box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.15);
            }

            .tautulli-badge-directplay {
                background: linear-gradient(180deg, rgba(16, 185, 129, 0.25) 0%, rgba(16, 185, 129, 0.12) 100%);
                color: #34d399;
                border: 1px solid rgba(16, 185, 129, 0.4);
                box-shadow: 0 0 10px -2px rgba(16, 185, 129, 0.3);
            }

            .tautulli-badge-directstream {
                background: linear-gradient(180deg, rgba(56, 189, 248, 0.25) 0%, rgba(56, 189, 248, 0.12) 100%);
                color: #38bdf8;
                border: 1px solid rgba(56, 189, 248, 0.4);
                box-shadow: 0 0 10px -2px rgba(56, 189, 248, 0.3);
            }

            .tautulli-badge-transcode {
                background: linear-gradient(180deg, rgba(239, 68, 68, 0.25) 0%, rgba(239, 68, 68, 0.12) 100%);
                color: #f87171;
                border: 1px solid rgba(239, 68, 68, 0.45);
                box-shadow: 0 0 12px -2px rgba(239, 68, 68, 0.35);
            }

            .tautulli-badge-hw {
                background: linear-gradient(180deg, rgba(168, 85, 247, 0.28) 0%, rgba(168, 85, 247, 0.14) 100%);
                color: #d8b4fe;
                border: 1px solid rgba(168, 85, 247, 0.45);
                box-shadow: 0 0 12px -2px rgba(168, 85, 247, 0.3);
            }

            .tautulli-badge-sw {
                background: linear-gradient(180deg, rgba(245, 158, 11, 0.25) 0%, rgba(245, 158, 11, 0.12) 100%);
                color: #fbbf24;
                border: 1px solid rgba(245, 158, 11, 0.45);
                box-shadow: 0 0 10px -2px rgba(245, 158, 11, 0.25);
            }

            .tautulli-speed-good {
                color: #34d399;
                background: rgba(16, 185, 129, 0.14);
                border: 1px solid rgba(16, 185, 129, 0.3);
            }

            .tautulli-speed-slow {
                color: #f87171;
                background: rgba(239, 68, 68, 0.15);
                border: 1px solid rgba(239, 68, 68, 0.35);
            }

            .tautulli-badge-burnin {
                background: rgba(245, 158, 11, 0.22);
                color: #fbbf24;
                border: 1px solid rgba(245, 158, 11, 0.45);
                box-shadow: 0 0 8px rgba(245, 158, 11, 0.3);
            }

            .tautulli-badge-hdr {
                background: linear-gradient(180deg, rgba(245, 158, 11, 0.28) 0%, rgba(245, 158, 11, 0.14) 100%);
                color: #fbbf24;
                border: 1px solid rgba(245, 158, 11, 0.5);
                box-shadow: 0 0 10px -2px rgba(245, 158, 11, 0.35);
            }

            .tautulli-badge-audio {
                background: linear-gradient(180deg, rgba(99, 102, 241, 0.28) 0%, rgba(99, 102, 241, 0.14) 100%);
                color: #a5b4fc;
                border: 1px solid rgba(99, 102, 241, 0.45);
                box-shadow: 0 0 10px -2px rgba(99, 102, 241, 0.35);
            }

            /* Stream Pipeline Chips */
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
                padding: 3px 8px;
                border-radius: 7px;
                background: rgba(255, 255, 255, 0.05);
                border: 1px solid rgba(255, 255, 255, 0.08);
                font-size: 11px;
                color: #cbd5e1;
                backdrop-filter: blur(8px);
                -webkit-backdrop-filter: blur(8px);
            }

            .tautulli-chip strong {
                color: #f1f5f9;
                font-weight: 600;
            }

            .tautulli-chip-icon {
                font-size: 11px;
            }

            /* Transcode Reason Banner */
            .tautulli-reason-banner {
                font-size: 10.5px;
                color: rgba(251, 191, 36, 0.95);
                background: rgba(245, 158, 11, 0.12);
                border: 1px solid rgba(245, 158, 11, 0.25);
                border-radius: 7px;
                padding: 3.5px 8px;
                display: flex;
                align-items: center;
                gap: 6px;
                overflow: hidden;
                white-space: nowrap;
                text-overflow: ellipsis;
            }

            .tautulli-reason-label {
                font-weight: 700;
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
                padding: 10px 14px 12px 14px;
                background: rgba(10, 10, 14, 0.92);
                border-top: 1px solid rgba(255, 255, 255, 0.05);
                display: flex;
                flex-direction: column;
                gap: 6px;
                backdrop-filter: blur(12px);
                -webkit-backdrop-filter: blur(12px);
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
                border: 1px solid rgba(255, 255, 255, 0.12);
                color: #ffffff;
                cursor: pointer;
                transition: transform 0.2s cubic-bezier(0.16, 1, 0.3, 1), background 0.2s ease;
            }

            .tautulli-state-icon:hover {
                transform: scale(1.12);
                background: rgba(255, 255, 255, 0.15);
            }

            .tautulli-state-icon svg {
                width: 13px;
                height: 13px;
                fill: currentColor;
            }

            .tautulli-state-playing {
                color: #34d399;
            }

            .tautulli-state-paused {
                color: #fbbf24;
            }

            .tautulli-progress-track {
                flex: 1;
                height: 4px;
                border-radius: 9999px;
                background: rgba(255, 255, 255, 0.09);
                overflow: hidden;
                position: relative;
            }

            .tautulli-progress-buffer {
                position: absolute;
                top: 0;
                left: 0;
                height: 100%;
                background: rgba(255, 255, 255, 0.22);
                border-radius: 9999px;
                transition: width 0.35s ease;
                z-index: 1;
            }

            .tautulli-progress-fill {
                position: relative;
                z-index: 2;
                height: 100%;
                border-radius: 9999px;
                background: linear-gradient(90deg, #0072ff 0%, #00c6ff 100%);
                box-shadow: 0 0 12px rgba(0, 198, 255, 0.85), 0 0 4px #0072ff;
                transition: width 0.35s cubic-bezier(0.16, 1, 0.3, 1);
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
                color: #00c9ff;
                letter-spacing: 0.02em;
                text-shadow: 0 0 10px rgba(0, 201, 255, 0.4);
            }

            .tautulli-time-paused {
                color: #fbbf24;
                font-weight: 700;
                text-shadow: 0 0 10px rgba(245, 158, 11, 0.4);
            }

            /* Empty State Container */
            .tautulli-empty-container {
                display: flex;
                flex-direction: column;
                align-items: center;
                justify-content: center;
                padding: 32px 20px;
                background: rgba(20, 20, 20, 0.65);
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
        return `ETA: ${pad(hours)}:${pad(minutes)}`;
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
     * Generates a stable color from a username string for the avatar fallback.
     */
    function getAvatarColor(name) {
        if (!name) return '#e91e63';
        let hash = 0;
        for (let i = 0; i < name.length; i++) {
            hash = name.charCodeAt(i) + ((hash << 5) - hash);
        }
        const colors = [
            '#e91e63', '#9c27b0', '#673ab7', '#3f51b5',
            '#2196f3', '#009688', '#4caf50', '#ff9800', '#f44336'
        ];
        return colors[Math.abs(hash) % colors.length];
    }

    /**
     * Returns an SVG icon and signature brand color for client / device badges (Tautulli style).
     */
    function getPlatformBadge(client, deviceName) {
        const combined = `${client || ''} ${deviceName || ''}`.toLowerCase();

        if (combined.includes('android') || combined.includes('pixel') || combined.includes('samsung') || combined.includes('shield')) {
            return {
                bg: '#3ddc84',
                color: '#000000',
                title: 'Android / Google TV',
                svg: `<svg viewBox="0 0 24 24"><path d="M6 18c0 .55.45 1 1 1h1v3.5c0 .83.67 1.5 1.5 1.5s1.5-.67 1.5-1.5V19h2v3.5c0 .83.67 1.5 1.5 1.5s1.5-.67 1.5-1.5V19h1c.55 0 1-.45 1-1V8H6v10zM3.5 8C2.67 8 2 8.67 2 9.5v7c0 .83.67 1.5 1.5 1.5S5 17.33 5 16.5v-7C5 8.67 4.33 8 3.5 8zm17 0c-.83 0-1.5.67-1.5 1.5v7c0 .83.67 1.5 1.5 1.5s1.5-.67 1.5-1.5v-7c0-.83-.67-1.5-1.5-1.5zm-4.97-5.84l1.3-1.3c.2-.2.2-.51 0-.71-.2-.2-.51-.2-.71 0l-1.48 1.48C13.85 1.23 12.95 1 12 1c-.96 0-1.86.23-2.66.63L7.85.15c-.2-.2-.51-.2-.71 0-.2.2-.2.51 0 .71l1.31 1.31C6.97 3.26 6 5.01 6 7h12c0-1.99-.97-3.75-2.47-4.84zM10 5H9V4h1v1zm5 0h-1V4h1v1z"/></svg>`
            };
        }
        if (combined.includes('safari')) {
            return {
                bg: '#00a4dc',
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
                color: '#111111',
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
        if (combined.includes('roku')) {
            return {
                bg: '#662d91',
                color: '#ffffff',
                title: 'Roku',
                svg: `<svg viewBox="0 0 24 24"><path d="M21 3H3c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h5v2h8v-2h5c1.1 0 1.99-.9 1.99-2L23 5c0-1.1-.9-2-2-2zm0 14H3V5h18v12z"/></svg>`
            };
        }
        return {
            bg: '#00a4dc',
            color: '#ffffff',
            title: client || 'Web Player',
            svg: `<svg viewBox="0 0 24 24"><path d="M20 18c1.1 0 1.99-.9 1.99-2L22 6c0-1.1-.9-2-2-2H4c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2H0v2h24v-2h-4zM4 6h16v10H4V6z"/></svg>`
        };
    }

    /**
     * Resolves the poster/primary artwork URL for an active session.
     */
    function getPosterUrl(session) {
        if (!window.ApiClient || !session.NowPlayingItem) return null;
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
    async function handleSendMessage(sessionId, userName) {
        if (!window.ApiClient) return;
        const msg = window.prompt(`Send on-screen message to ${userName}:`, 'Server restart in 5 minutes.');
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
            containerDisplay = `Converting (${origContainer} → ${targetContainer})`;
        } else if (isDirectStream) {
            containerDisplay = `Direct Stream (${origContainer})`;
        }

        // Video
        const origVideoCodec = (videoStream.Codec || 'H264').toUpperCase();
        const origVideoRes = videoStream.Height
            ? (videoStream.Height >= 2160 ? '4K' : videoStream.Height >= 1080 ? '1080p' : videoStream.Height >= 720 ? '720p' : `${videoStream.Height}p`)
            : '1080p';
        let videoDisplay = `${isDirectStream ? 'Direct Stream' : isDirectPlay ? 'Direct Play' : 'Transcode'} (${origVideoCodec} ${origVideoRes})`;
        let videoChip = `${origVideoRes} ${origVideoCodec}`;

        if (isTranscode && transcodeInfo && !transcodeInfo.IsVideoDirect) {
            const targetCodec = (transcodeInfo.VideoCodec || 'H264').toUpperCase();
            const targetRes = transcodeInfo.Height ? (transcodeInfo.Height >= 2160 ? '4K' : `${transcodeInfo.Height}p`) : origVideoRes;
            videoDisplay = `Transcode (${origVideoCodec} ${origVideoRes} → ${targetCodec} ${targetRes})`;
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
            audioDisplay = `Transcode (${origAudioDesc} → ${targetAudioCodec} ${targetChannels})`;
            audioChip = `${origAudioDesc} ➔ ${targetAudioCodec} ${targetChannels}`;
        }

        // HDR Detection (HDR10, HDR10+, Dolby Vision, HLG, BT2020)
        let hdrBadge = null;
        const videoRange = (videoStream.VideoRange || videoStream.VideoRangeType || '').toUpperCase();
        const colorSpace = (videoStream.ColorSpace || '').toUpperCase();
        const isHdr = videoRange.includes('HDR') || videoRange.includes('DOVI') || videoRange.includes('HLG') || colorSpace.includes('BT2020');
        if (isHdr) {
            let hdrName = 'HDR';
            if (videoRange.includes('DOVI') || (videoStream.Title && videoStream.Title.toUpperCase().includes('DV'))) {
                hdrName = '✨ Dolby Vision';
            } else if (videoRange.includes('HDR10+') || videoRange.includes('HDR10PLUS')) {
                hdrName = 'HDR10+';
            } else if (videoRange.includes('HDR10')) {
                hdrName = 'HDR10';
            } else if (videoRange.includes('HLG')) {
                hdrName = 'HLG';
            }

            if (isTranscode && transcodeInfo && !transcodeInfo.IsVideoDirect) {
                hdrBadge = `${hdrName} ➔ SDR`;
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
        const currentBitrate = (transcodeInfo && transcodeInfo.Bitrate) || item.Bitrate || 0;
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

        return {
            sessionId: session.Id,
            itemId: item.Id,
            userId: session.UserId,
            product: session.Client || 'Jellyfin Web',
            player: session.DeviceName || 'Browser',
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
            officialRating: item.OfficialRating || null,
            isSubtitleBurnIn,
            transcodeReasons,
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
            deviceName: session.DeviceName,
            isAudioItem
        };
    }

    /**
     * Renders an individual session card element HTML string.
     */
    function renderSessionCard(card) {
        // Stream Badge
        let badgeClass = 'tautulli-badge-directplay';
        let badgeLabel = 'Direct Play';

        if (card.isTranscode) {
            badgeClass = 'tautulli-badge-transcode';
            badgeLabel = card.isThrottled ? 'Transcode (Throttled)' : 'Transcode';
        } else if (card.isDirectStream) {
            badgeClass = 'tautulli-badge-directstream';
            badgeLabel = 'Direct Stream';
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
            burnInHtml = `<span class="tautulli-badge tautulli-badge-burnin" title="Subtitle format forcing transcode">⚠️ Sub Burn-In</span>`;
        }

        // Transcode Reasons banner HTML
        let reasonsBannerHtml = '';
        if (card.isTranscode && card.transcodeReasons.length > 0) {
            const reasonsText = card.transcodeReasons.map(formatTranscodeReason).join(', ');
            reasonsBannerHtml = `
                <div class="tautulli-reason-banner" title="Transcoding trigger: ${escapeHtml(reasonsText)}">
                    <span class="tautulli-reason-label">ℹ️ Transcode Reason:</span>
                    <span class="tautulli-reason-val">${escapeHtml(reasonsText)}</span>
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
                            <span class="tautulli-device-text" title="${escapeHtml(card.player)}">${escapeHtml(card.player)}</span>
                            <span class="tautulli-meta-dot">•</span>
                            <span class="tautulli-client-badge" title="${escapeHtml(card.product)}">${escapeHtml(card.product)}</span>
                        </div>
                    </div>

                    <div class="tautulli-header-controls">
                        <span class="tautulli-network-pill ${card.isLan ? 'tautulli-net-lan' : 'tautulli-net-wan'}" title="Network endpoint">
                            ${card.isLan ? '🔒 LAN' : 'WAN'} ${escapeHtml(card.locationDisplay)}
                        </span>
                        ${card.platformBadge ? `
                        <div class="tautulli-platform-badge" style="background: ${card.platformBadge.bg}; color: ${card.platformBadge.color};" title="${escapeHtml(card.platformBadge.title)}">
                            ${card.platformBadge.svg}
                        </div>` : ''}
                        <div class="tautulli-action-cluster">
                            <button class="tautulli-action-btn" data-action="message-user" data-session-id="${escapeHtml(card.sessionId)}" data-user="${escapeHtml(card.userName)}" title="Send message to player">
                                <svg viewBox="0 0 24 24"><path d="M20 2H4c-1.1 0-1.99.9-1.99 2L2 22l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-2 12H6v-2h12v2zm0-3H6V9h12v2zm0-3H6V6h12v2z"/></svg>
                            </button>
                            <button class="tautulli-action-btn tautulli-action-btn-kill" data-action="kill-stream" data-session-id="${escapeHtml(card.sessionId)}" data-user="${escapeHtml(card.userName)}" data-title="${escapeHtml(card.primaryTitle)}" title="Terminate stream">
                                <svg viewBox="0 0 24 24"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
                            </button>
                        </div>
                    </div>
                </div>

                <!-- Card Body: Poster + Stream Pipeline Matrix (Overlaid onto Fanart Backdrop) -->
                <div class="tautulli-card-body">
                    <!-- Left Poster Artwork -->
                    <a href="${detailHref}" class="tautulli-poster-wrapper" title="View details: ${escapeHtml(card.primaryTitle)}">
                        ${posterHtml}
                    </a>

                    <!-- Right Media & Stream Pipeline -->
                    <div class="tautulli-media-details">
                        <!-- Media Title & Secondary Line with Content Rating -->
                        <div class="tautulli-titles-container">
                            <div class="tautulli-title-line">
                                <a href="${detailHref}" class="tautulli-title-primary" title="${escapeHtml(card.primaryTitle)}">
                                    ${escapeHtml(card.primaryTitle)}
                                </a>
                                <div class="tautulli-title-secondary">
                                    ${card.officialRating ? `<span class="tautulli-rating-badge">${escapeHtml(card.officialRating)}</span>` : ''}
                                    ${card.secondaryTitle ? `<span>${escapeHtml(card.secondaryTitle)}</span>` : ''}
                                </div>
                            </div>

                            <!-- Engine Status Badges -->
                            <div class="tautulli-badge-row">
                                <span class="tautulli-badge ${badgeClass}">${badgeLabel}</span>
                                ${hwBadgeHtml}
                                ${speedHtml}
                                ${card.hdrBadge ? `<span class="tautulli-badge tautulli-badge-hdr" title="High Dynamic Range">${escapeHtml(card.hdrBadge)}</span>` : ''}
                                ${card.audioBadge ? `<span class="tautulli-badge tautulli-badge-audio" title="High Fidelity Audio">${escapeHtml(card.audioBadge)}</span>` : ''}
                                ${burnInHtml}
                            </div>
                        </div>

                        <!-- Stream Pipeline Chips -->
                        <div class="tautulli-pipeline-grid">
                            <div class="tautulli-chip" title="Video stream specs: ${escapeHtml(card.videoDisplay)}">
                                <span class="tautulli-chip-icon">🎬</span>
                                <span>${escapeHtml(card.videoChip)}</span>
                            </div>
                            <div class="tautulli-chip" title="Audio stream specs: ${escapeHtml(card.audioDisplay)}">
                                <span class="tautulli-chip-icon">🔊</span>
                                <span>${escapeHtml(card.audioChip)}</span>
                            </div>
                            <div class="tautulli-chip" title="Container format: ${escapeHtml(card.containerDisplay)}">
                                <span class="tautulli-chip-icon">📦</span>
                                <span>${escapeHtml(card.containerChip)}</span>
                            </div>
                            <div class="tautulli-chip" title="Bandwidth & Quality: ${escapeHtml(card.qualityDisplay)}">
                                <span class="tautulli-chip-icon">⚡</span>
                                <span><strong>${escapeHtml(card.bandwidthDisplay)}</strong></span>
                            </div>
                            ${card.subChip ? `
                            <div class="tautulli-chip" title="Subtitle stream: ${escapeHtml(card.subtitleDisplay)}">
                                <span class="tautulli-chip-icon">💬</span>
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
                            <div class="tautulli-progress-fill" style="width: ${card.progressPercent}%;"></div>
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
     * Renders the overall activity container including summary header and cards.
     */
    function renderContainer(cards) {
        if (cards.length === 0) {
            return `
                <div class="tautulli-empty-container">
                    <svg class="tautulli-empty-icon" viewBox="0 0 24 24">
                        <path d="M21 3H3c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h5v2h8v-2h5c1.1 0 1.99-.9 1.99-2L23 5c0-1.1-.9-2-2-2zm0 14H3V5h18v12z"/>
                    </svg>
                    <div class="tautulli-empty-text">No active streams</div>
                </div>
            `;
        }

        // Aggregate statistics for the Tautulli Activity Banner
        const totalStreams = cards.length;
        const directPlayCount = cards.filter((c) => c.isDirectPlay).length;
        const directStreamCount = cards.filter((c) => c.isDirectStream).length;
        const transcodeCount = cards.filter((c) => c.isTranscode).length;

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

        const privacyBtnClass = isPrivacyMode ? 'tautulli-tool-btn active' : 'tautulli-tool-btn';

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
                        <span>Bandwidth: <span class="tautulli-activity-stat-highlight">${bandwidthDetail}</span></span>
                    </div>
                </div>

                <div class="tautulli-activity-tools">
                    <button class="${privacyBtnClass}" data-action="toggle-privacy" title="Mask IP addresses and usernames for streaming/screenshots">
                        <svg style="width:13px;height:13px;" fill="currentColor" viewBox="0 0 24 24"><path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z"/></svg>
                        <span>${isPrivacyMode ? 'Privacy On' : 'Privacy'}</span>
                    </button>
                </div>
            </div>
            <div class="tautulli-grid">
                ${cards.map(renderSessionCard).join('')}
            </div>
        `;
    }

    /**
     * Attaches interactive event listeners to container elements (Stop, Message, PlayPause, Privacy).
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
            }
        };
    }

    /**
     * Polls ApiClient.getSessions() and updates the DOM cleanly.
     */
    async function fetchAndRenderSessions() {
        if (!isDashboardActive || isFetching || !window.ApiClient) {
            return;
        }

        const container = document.getElementById(CONFIG.CONTAINER_ID);
        if (!container) {
            return;
        }

        isFetching = true;
        try {
            const rawSessions = await window.ApiClient.getSessions();
            if (!isDashboardActive) return; // View changed while awaiting promise

            // Filter for active playback sessions with active media item
            const activeSessions = (rawSessions || []).filter((s) => s && s.NowPlayingItem != null);

            // Clean up pause timestamps for terminated sessions to prevent memory leaks
            const activeSessionIds = new Set(activeSessions.map((s) => s.Id));
            for (const sid of sessionPausedTimestamps.keys()) {
                if (!activeSessionIds.has(sid)) {
                    sessionPausedTimestamps.delete(sid);
                }
            }

            const cards = activeSessions.map((s, idx) => mapSessionToCardModel(s, idx));

            // Compute hash of content to avoid redundant DOM mutations
            const contentHash = JSON.stringify({
                privacy: isPrivacyMode,
                cards: cards.map((c) => ({
                    id: c.sessionId,
                    method: c.playMethod,
                    paused: c.isPaused,
                    pauseSec: Math.floor(c.pausedDurationSeconds / 5), // re-render every 5s if paused
                    pos: c.timeProgressStr,
                    buf: c.transcodeCompletionPercentage,
                    bw: c.bandwidthDisplay,
                    hw: c.hwAccelBadge,
                    speed: c.transcodeSpeedMultiplier
                }))
            });

            if (contentHash !== lastRenderedHash) {
                lastRenderedHash = contentHash;
                container.innerHTML = renderContainer(cards);
                attachContainerEvents(container);
            }
        } catch (err) {
            console.warn('[PlaybackCard] Failed to fetch active playback sessions:', err);
        } finally {
            isFetching = false;
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

        // Target .dashboardForm or .content-primary inside view or document
        const target =
            (viewElement && (viewElement.querySelector('.dashboardForm') || viewElement.querySelector('.content-primary'))) ||
            document.querySelector('.dashboardForm') ||
            document.querySelector('.content-primary');

        if (!target) {
            return false;
        }

        const container = document.createElement('div');
        container.id = CONFIG.CONTAINER_ID;
        container.innerHTML = `
            <div class="tautulli-empty-container">
                <div class="tautulli-empty-text">Loading live playback sessions...</div>
            </div>
        `;

        // Prepend directly at the absolute top of the dashboard form
        target.insertBefore(container, target.firstChild);
        attachContainerEvents(container);
        return true;
    }

    /**
     * Determines whether the given element or URL corresponds to the admin dashboard.
     */
    function isDashboardView(element) {
        if (!element) return false;
        if (element.classList && (element.classList.contains('dashboardForm') || element.classList.contains('dashboardGeneralForm'))) {
            return true;
        }
        if (element.querySelector && (element.querySelector('.dashboardForm') || element.querySelector('.dashboardGeneralForm'))) {
            return true;
        }
        const path = window.location.hash || window.location.pathname || '';
        return path.includes('dashboard') || path.includes('dashboard.html');
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
            const container = document.getElementById(CONFIG.CONTAINER_ID);
            if (container) {
                container.remove();
            }
        }
    }

    // Register lifecycle event listeners on document
    document.addEventListener('viewshow', onViewShow);
    document.addEventListener('viewhide', onViewTearDown);
    document.addEventListener('viewdestroy', onViewTearDown);

    // Initial check in case script is loaded while already on dashboard view
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            if (isDashboardView(document.body)) {
                if (setupDashboardContainer(document.body)) {
                    startPolling();
                }
            }
        });
    } else {
        if (isDashboardView(document.body)) {
            if (setupDashboardContainer(document.body)) {
                startPolling();
            }
        }
    }

    console.info('[PlaybackCard] Jellyfin Playback Info Card v0.1.0 initialized successfully.');
})();
