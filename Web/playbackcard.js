/**
 * Jellyfin Playback Info Card (Jellyfin.Plugin.PlaybackCard)
 * 
 * Injects a real-time, Tautulli-inspired visual monitoring grid directly into
 * the Jellyfin Admin Dashboard (/dashboard.html / .dashboardForm).
 * 
 * Features:
 * - Real-time polling of ApiClient.getSessions() every 3 seconds.
 * - Strict memory leak prevention with viewshow/viewhide/viewdestroy lifecycle management.
 * - Isolated DOM rendering (zero scroll reset, zero global state mutation).
 * - Liquid Glass aesthetic with backdrop blur, sleek dark translucent panes, and ambient glow.
 * - Exact Tautulli split-card anatomy: Media poster, telemetry data grid, ETA calculations,
 *   color-coded stream badges, transcode reasons, neon seam progress bar, and user avatar.
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
        COLOR_PAUSED: '#f39c12'
    };

    // State management
    let pollIntervalId = null;
    let isDashboardActive = false;
    let isFetching = false;
    let lastRenderedHash = '';

    /**
     * Injects custom CSS styling for the Liquid Glass theme and Tautulli card anatomy.
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
            }

            .tautulli-activity-banner {
                display: flex;
                align-items: center;
                justify-content: space-between;
                flex-wrap: wrap;
                gap: 10px;
                padding: 10px 16px;
                margin-bottom: 16px;
                background: rgba(20, 20, 20, 0.7);
                backdrop-filter: blur(16px) saturate(180%);
                -webkit-backdrop-filter: blur(16px) saturate(180%);
                border: 1px solid rgba(255, 255, 255, 0.08);
                border-radius: 8px;
                box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
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
                box-shadow: 0 0 8px ${CONFIG.COLOR_DIRECT_PLAY};
                animation: tautulli-pulse 2s infinite ease-in-out;
            }

            @keyframes tautulli-pulse {
                0%, 100% { transform: scale(1); opacity: 0.8; }
                50% { transform: scale(1.3); opacity: 1; }
            }

            .tautulli-activity-stats {
                font-size: 12px;
                color: #a0a0a0;
                display: flex;
                align-items: center;
                gap: 16px;
                flex-wrap: wrap;
            }

            .tautulli-activity-stat-highlight {
                color: #ffffff;
                font-weight: 600;
            }

            /* Responsive Session Grid */
            .tautulli-grid {
                display: grid;
                grid-template-columns: repeat(auto-fill, minmax(460px, 1fr));
                gap: 20px;
                width: 100%;
                box-sizing: border-box;
            }

            @media (max-width: 520px) {
                .tautulli-grid {
                    grid-template-columns: 1fr;
                }
            }

            /* Session Card - Liquid Glass Theme */
            .tautulli-card {
                position: relative;
                display: flex;
                flex-direction: column;
                border-radius: 12px;
                overflow: hidden;
                background: rgba(20, 20, 20, 0.65);
                backdrop-filter: blur(16px) saturate(180%);
                -webkit-backdrop-filter: blur(16px) saturate(180%);
                border: 1px solid rgba(255, 255, 255, 0.08);
                box-shadow: 0 8px 32px 0 rgba(0, 0, 0, 0.37);
                transition: transform 0.2s ease, box-shadow 0.2s ease;
            }

            .tautulli-card:hover {
                transform: translateY(-2px);
                box-shadow: 0 12px 40px 0 rgba(0, 0, 0, 0.5), 0 0 1px rgba(255, 255, 255, 0.2);
            }

            /* Top Block (Split Header) */
            .tautulli-top-block {
                position: relative;
                display: flex;
                min-height: 220px;
                overflow: hidden;
                background: rgba(15, 15, 15, 0.4);
            }

            /* Left Side: Poster Artwork */
            .tautulli-poster-wrapper {
                position: relative;
                width: 135px;
                min-width: 135px;
                max-width: 135px;
                overflow: hidden;
                background: #111;
                display: flex;
                align-items: center;
                justify-content: center;
            }

            .tautulli-poster-img {
                width: 100%;
                height: 100%;
                object-fit: cover;
                display: block;
            }

            .tautulli-poster-fallback {
                display: flex;
                flex-direction: column;
                align-items: center;
                justify-content: center;
                color: #555;
                font-size: 11px;
                text-align: center;
                padding: 10px;
            }

            .tautulli-poster-fallback svg {
                width: 38px;
                height: 38px;
                fill: #444;
                margin-bottom: 6px;
            }

            /* Right Side: Telemetry Data Grid */
            .tautulli-telemetry-panel {
                flex: 1;
                padding: 12px 14px 28px 14px;
                position: relative;
                display: flex;
                flex-direction: column;
                justify-content: flex-start;
                gap: 5px;
                overflow: hidden;
            }

            /* Platform Badge (Top-Right) */
            .tautulli-platform-badge {
                position: absolute;
                top: 10px;
                right: 12px;
                width: 28px;
                height: 28px;
                border-radius: 6px;
                display: flex;
                align-items: center;
                justify-content: center;
                background: rgba(0, 164, 220, 0.2);
                border: 1px solid rgba(0, 164, 220, 0.4);
                color: #00a4dc;
                z-index: 2;
            }

            .tautulli-platform-badge svg {
                width: 16px;
                height: 16px;
                fill: currentColor;
            }

            /* Telemetry Data Rows */
            .tautulli-row {
                display: flex;
                align-items: baseline;
                gap: 8px;
                font-size: 11.5px;
                line-height: 1.4;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
                padding-right: 32px;
            }

            .tautulli-lbl {
                font-size: 10px;
                font-weight: 700;
                letter-spacing: 0.06em;
                color: #888888;
                width: 78px;
                min-width: 78px;
                text-transform: uppercase;
                user-select: none;
            }

            .tautulli-val {
                color: #dedede;
                font-weight: 450;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
                display: flex;
                align-items: center;
                gap: 6px;
            }

            /* Play Method & Reason Badges */
            .tautulli-badge {
                display: inline-flex;
                align-items: center;
                gap: 4px;
                padding: 1px 6px;
                border-radius: 4px;
                font-size: 10px;
                font-weight: 600;
                text-transform: uppercase;
                letter-spacing: 0.04em;
                line-height: 1.3;
            }

            .tautulli-badge-directplay {
                background: rgba(46, 204, 113, 0.16);
                color: ${CONFIG.COLOR_DIRECT_PLAY};
                border: 1px solid rgba(46, 204, 113, 0.35);
            }

            .tautulli-badge-directstream {
                background: rgba(52, 152, 219, 0.16);
                color: ${CONFIG.COLOR_DIRECT_STREAM};
                border: 1px solid rgba(52, 152, 219, 0.35);
            }

            .tautulli-badge-transcode {
                background: rgba(231, 76, 60, 0.16);
                color: ${CONFIG.COLOR_TRANSCODE};
                border: 1px solid rgba(231, 76, 60, 0.35);
            }

            .tautulli-badge-reason {
                background: rgba(243, 156, 18, 0.15);
                color: #f39c12;
                border: 1px solid rgba(243, 156, 18, 0.3);
                font-size: 9.5px;
                padding: 1px 5px;
            }

            /* Floating Time & ETA Overlay */
            .tautulli-time-overlay {
                position: absolute;
                bottom: 8px;
                right: 12px;
                text-align: right;
                display: flex;
                flex-direction: column;
                align-items: flex-end;
                gap: 1px;
                pointer-events: none;
            }

            .tautulli-time-eta {
                font-size: 10.5px;
                font-weight: 600;
                color: #00c9ff;
                letter-spacing: 0.04em;
            }

            .tautulli-time-progress {
                font-size: 10px;
                color: #888888;
                font-variant-numeric: tabular-nums;
            }

            /* Fluid Seam Progress Bar */
            .tautulli-progress-seam {
                position: relative;
                width: 100%;
                height: 4px;
                background: rgba(255, 255, 255, 0.1);
                overflow: hidden;
            }

            .tautulli-progress-fill {
                height: 100%;
                background: ${CONFIG.ACCENT_COLOR};
                box-shadow: 0 0 8px rgba(0, 164, 220, 0.7);
                transition: width 0.3s ease;
            }

            /* Bottom Block (Metadata & User) */
            .tautulli-bottom-block {
                background: rgba(10, 10, 10, 0.85);
                padding: 10px 14px;
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 12px;
            }

            .tautulli-media-info {
                display: flex;
                align-items: center;
                gap: 10px;
                overflow: hidden;
                flex: 1;
            }

            .tautulli-state-icon {
                display: flex;
                align-items: center;
                justify-content: center;
                width: 22px;
                height: 22px;
                min-width: 22px;
                color: #ffffff;
            }

            .tautulli-state-icon svg {
                width: 14px;
                height: 14px;
                fill: currentColor;
            }

            .tautulli-state-playing {
                color: ${CONFIG.COLOR_DIRECT_PLAY};
            }

            .tautulli-state-paused {
                color: ${CONFIG.COLOR_PAUSED};
            }

            .tautulli-titles {
                display: flex;
                flex-direction: column;
                overflow: hidden;
                line-height: 1.25;
            }

            .tautulli-title-primary {
                font-size: 13.5px;
                font-weight: 700;
                color: #ffffff;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
            }

            .tautulli-title-secondary {
                font-size: 11px;
                color: #888888;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
                display: flex;
                align-items: center;
                gap: 6px;
                margin-top: 2px;
            }

            .tautulli-title-year {
                color: #aaaaaa;
            }

            /* User Avatar Badge */
            .tautulli-user-badge {
                display: flex;
                align-items: center;
                gap: 8px;
                min-width: fit-content;
            }

            .tautulli-user-avatar {
                width: 32px;
                height: 32px;
                min-width: 32px;
                border-radius: 50%;
                overflow: hidden;
                display: flex;
                align-items: center;
                justify-content: center;
                font-size: 13px;
                font-weight: 700;
                color: #ffffff;
                background: linear-gradient(135deg, #e91e63, #9c27b0);
                border: 1px solid rgba(255, 255, 255, 0.15);
                box-shadow: 0 2px 6px rgba(0, 0, 0, 0.3);
            }

            .tautulli-user-avatar img {
                width: 100%;
                height: 100%;
                object-fit: cover;
                display: block;
            }

            .tautulli-user-name {
                font-size: 12px;
                color: #cccccc;
                font-weight: 500;
                max-width: 80px;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
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
     * Formats estimated finish time (ETA) based on remaining seconds.
     */
    function formatETA(remainingSeconds, isPaused) {
        if (isPaused) {
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
     * Determines whether an IP is in a private/LAN subnet.
     */
    function isLanIp(ip) {
        if (!ip) return true;
        const cleanIp = ip.split(':')[0].trim();
        return (
            cleanIp === '127.0.0.1' ||
            cleanIp === 'localhost' ||
            cleanIp === '::1' ||
            cleanIp.startsWith('10.') ||
            cleanIp.startsWith('192.168.') ||
            /^172\.(1[6-9]|2\d|3[01])\./.test(cleanIp)
        );
    }

    /**
     * Human-formats transcode reason codes into readable badge labels.
     */
    function formatTranscodeReason(reason) {
        if (!reason) return 'Transcoding';
        // Convert camelCase or PascalCase to spaced words
        return reason
            .replace(/([A-Z])/g, ' $1')
            .replace(/^./, (s) => s.toUpperCase())
            .trim();
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
     * Returns an SVG icon corresponding to client or device type.
     */
    function getPlatformIcon(client, deviceName) {
        const combined = `${client || ''} ${deviceName || ''}`.toLowerCase();

        if (combined.includes('android')) {
            // Android robot icon
            return `<svg viewBox="0 0 24 24"><path d="M6 18c0 .55.45 1 1 1h1v3.5c0 .83.67 1.5 1.5 1.5s1.5-.67 1.5-1.5V19h2v3.5c0 .83.67 1.5 1.5 1.5s1.5-.67 1.5-1.5V19h1c.55 0 1-.45 1-1V8H6v10zM3.5 8C2.67 8 2 8.67 2 9.5v7c0 .83.67 1.5 1.5 1.5S5 17.33 5 16.5v-7C5 8.67 4.33 8 3.5 8zm17 0c-.83 0-1.5.67-1.5 1.5v7c0 .83.67 1.5 1.5 1.5s1.5-.67 1.5-1.5v-7c0-.83-.67-1.5-1.5-1.5zm-4.97-5.84l1.3-1.3c.2-.2.2-.51 0-.71-.2-.2-.51-.2-.71 0l-1.48 1.48C13.85 1.23 12.95 1 12 1c-.96 0-1.86.23-2.66.63L7.85.15c-.2-.2-.51-.2-.71 0-.2.2-.2.51 0 .71l1.31 1.31C6.97 3.26 6 5.01 6 7h12c0-1.99-.97-3.75-2.47-4.84zM10 5H9V4h1v1zm5 0h-1V4h1v1z"/></svg>`;
        }
        if (combined.includes('apple') || combined.includes('safari') || combined.includes('ios') || combined.includes('macos')) {
            // Apple / Safari Compass icon
            return `<svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm-5.5-3.5l2.79-6.29 6.29-2.79-2.79 6.29-6.29 2.79zm4.25-4.25c-.41.41-.41 1.09 0 1.5s1.09.41 1.5 0 .41-1.09 0-1.5-1.09-.41-1.5 0z"/></svg>`;
        }
        if (combined.includes('fire') || combined.includes('tv') || combined.includes('roku') || combined.includes('shield')) {
            // TV Screen icon
            return `<svg viewBox="0 0 24 24"><path d="M21 3H3c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h5v2h8v-2h5c1.1 0 1.99-.9 1.99-2L23 5c0-1.1-.9-2-2-2zm0 14H3V5h18v12z"/></svg>`;
        }
        // Generic Web / Monitor icon
        return `<svg viewBox="0 0 24 24"><path d="M20 18c1.1 0 1.99-.9 1.99-2L22 6c0-1.1-.9-2-2-2H4c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2H0v2h24v-2h-4zM4 6h16v10H4V6z"/></svg>`;
    }

    /**
     * Resolves the poster/primary artwork URL for an active session.
     */
    function getPosterUrl(session) {
        if (!window.ApiClient || !session.NowPlayingItem) return null;
        const item = session.NowPlayingItem;

        // Try item's own Primary tag
        if (item.PrimaryImageTag) {
            return window.ApiClient.getImageUrl(item.Id, {
                type: 'Primary',
                maxHeight: 400,
                tag: item.PrimaryImageTag
            });
        }

        // For TV episodes, fallback to Series Primary image
        if (item.SeriesId && item.SeriesPrimaryImageTag) {
            return window.ApiClient.getImageUrl(item.SeriesId, {
                type: 'Primary',
                maxHeight: 400,
                tag: item.SeriesPrimaryImageTag
            });
        }

        // Fallback to backdrop image if available
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
     * Maps raw Jellyfin session data into Tautulli card view model.
     */
    function mapSessionToCardModel(session) {
        const item = session.NowPlayingItem || {};
        const playState = session.PlayState || {};
        const transcodeInfo = session.TranscodingInfo || null;

        // Determine Play Method
        let playMethod = playState.PlayMethod || (transcodeInfo ? 'Transcode' : 'DirectPlay');
        let isDirectPlay = playMethod === 'DirectPlay';
        let isDirectStream = playMethod === 'DirectStream';
        let isTranscode = playMethod === 'Transcode' || (!isDirectPlay && !isDirectStream && transcodeInfo != null);

        // Codec & Media stream parsing
        const mediaStreams = item.MediaStreams || [];
        const videoStream = mediaStreams.find((s) => s.Type === 'Video') || {};
        const audioStream = mediaStreams.find((s) => s.Type === 'Audio' && (playState.AudioStreamIndex == null || s.Index === playState.AudioStreamIndex)) || {};
        const subStream = mediaStreams.find((s) => s.Type === 'Subtitle' && s.Index === playState.SubtitleStreamIndex) || null;

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

        if (isTranscode && transcodeInfo && !transcodeInfo.IsVideoDirect) {
            const targetCodec = (transcodeInfo.VideoCodec || 'H264').toUpperCase();
            const targetRes = transcodeInfo.Height ? `${transcodeInfo.Height}p` : origVideoRes;
            videoDisplay = `Transcode (${origVideoCodec} ${origVideoRes} → ${targetCodec} ${targetRes})`;
        }

        // Audio
        const origAudioLang = audioStream.Language ? audioStream.Language.toUpperCase() : '';
        const origAudioCodec = (audioStream.Codec || 'AAC').toUpperCase();
        const origChannels = audioStream.Channels === 6 ? '5.1' : audioStream.Channels === 8 ? '7.1' : audioStream.Channels === 2 ? 'Stereo' : (audioStream.Channels ? `${audioStream.Channels} Ch` : 'Stereo');
        const origAudioDesc = [origAudioLang, origAudioCodec, origChannels].filter(Boolean).join(' - ');
        let audioDisplay = `${isDirectPlay ? 'Direct Play' : isDirectStream ? 'Direct Stream' : 'Transcode'} (${origAudioDesc})`;

        if (isTranscode && transcodeInfo && !transcodeInfo.IsAudioDirect) {
            const targetAudioCodec = (transcodeInfo.AudioCodec || 'AAC').toUpperCase();
            const targetChannels = transcodeInfo.AudioChannels === 2 ? 'Stereo' : (transcodeInfo.AudioChannels ? `${transcodeInfo.AudioChannels} Ch` : 'Stereo');
            audioDisplay = `Transcode (${origAudioDesc} → ${targetAudioCodec} ${targetChannels})`;
        }

        // Subtitles
        let subtitleDisplay = 'None';
        if (subStream) {
            const subTitle = subStream.DisplayTitle || subStream.Language || 'Subtitles';
            const subCodec = (subStream.Codec || 'Text').toUpperCase();
            subtitleDisplay = `${subTitle} (${subCodec})`;
        }

        // Bandwidth & Quality
        const currentBitrate = (transcodeInfo && transcodeInfo.Bitrate) || item.Bitrate || 0;
        const qualityDisplay = isTranscode
            ? `Transcode (${formatBitrate(currentBitrate)})`
            : `Original (${formatBitrate(currentBitrate)})`;
        const bandwidthDisplay = formatBitrate(currentBitrate);

        // Location
        const rawIp = session.RemoteEndPoint || '127.0.0.1';
        const isLan = isLanIp(rawIp);
        const cleanIp = rawIp.split(':')[0];
        const locationDisplay = `${isLan ? '🔒 LAN' : 'WAN'}: ${cleanIp}`;

        // Transcode Reasons
        const transcodeReasons = (transcodeInfo && transcodeInfo.TranscodeReasons) || [];

        // Timing & Progress
        const positionTicks = playState.PositionTicks || 0;
        const runTimeTicks = item.RunTimeTicks || 0;
        const progressRatio = runTimeTicks > 0 ? Math.min(1, Math.max(0, positionTicks / runTimeTicks)) : 0;
        const progressPercent = (progressRatio * 100).toFixed(1);

        const currentSeconds = Math.floor(positionTicks / 10000000);
        const totalSeconds = Math.floor(runTimeTicks / 10000000);
        const remainingSeconds = Math.max(0, totalSeconds - currentSeconds);

        const timeProgressStr = `${formatDuration(currentSeconds)} / ${formatDuration(totalSeconds)}`;
        const etaStr = formatETA(remainingSeconds, playState.IsPaused);

        // Titles
        let primaryTitle = item.Name || 'Unknown Title';
        let secondaryTitle = item.ProductionYear ? String(item.ProductionYear) : '';

        if (item.Type === 'Episode') {
            primaryTitle = item.SeriesName || item.Name;
            const seasonNum = item.ParentIndexNumber || 1;
            const episodeNum = item.IndexNumber || 1;
            secondaryTitle = `S${seasonNum}:E${episodeNum} · ${item.Name}`;
        }

        return {
            sessionId: session.Id,
            product: session.Client || 'Jellyfin Web',
            player: session.DeviceName || 'Browser',
            qualityDisplay,
            playMethod,
            isDirectPlay,
            isDirectStream,
            isTranscode,
            isThrottled: Boolean(transcodeInfo && transcodeInfo.IsThrottled),
            transcodeReasons,
            containerDisplay,
            videoDisplay,
            audioDisplay,
            subtitleDisplay,
            locationDisplay,
            bandwidthDisplay,
            bandwidthNumber: currentBitrate,
            etaStr,
            timeProgressStr,
            progressPercent,
            isPaused: Boolean(playState.IsPaused),
            primaryTitle,
            secondaryTitle,
            userName: session.UserName || 'User',
            posterUrl: getPosterUrl(session),
            userAvatarUrl: getUserAvatarUrl(session),
            client: session.Client,
            deviceName: session.DeviceName
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

        // Transcode Reasons badges HTML
        let reasonsHtml = '';
        if (card.isTranscode && card.transcodeReasons.length > 0) {
            reasonsHtml = card.transcodeReasons
                .map((r) => `<span class="tautulli-badge tautulli-badge-reason">${escapeHtml(formatTranscodeReason(r))}</span>`)
                .join(' ');
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

        // Platform icon
        const platformIcon = getPlatformIcon(card.client, card.deviceName);

        // User Avatar image or initials circle
        let avatarHtml = '';
        if (card.userAvatarUrl) {
            avatarHtml = `<div class="tautulli-user-avatar"><img src="${escapeHtml(card.userAvatarUrl)}" alt="${escapeHtml(card.userName)}" /></div>`;
        } else {
            const initial = (card.userName ? card.userName.charAt(0).toUpperCase() : 'U');
            const bgColor = getAvatarColor(card.userName);
            avatarHtml = `<div class="tautulli-user-avatar" style="background: ${bgColor};">${initial}</div>`;
        }

        // Play/Pause icon
        const stateIconHtml = card.isPaused
            ? `<div class="tautulli-state-icon tautulli-state-paused" title="Paused"><svg viewBox="0 0 24 24"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg></div>`
            : `<div class="tautulli-state-icon tautulli-state-playing" title="Playing"><svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg></div>`;

        return `
            <div class="tautulli-card" data-session-id="${escapeHtml(card.sessionId)}">
                <!-- Top Block: Poster & Telemetry Data Grid -->
                <div class="tautulli-top-block">
                    <!-- Left Poster -->
                    <div class="tautulli-poster-wrapper">
                        ${posterHtml}
                    </div>

                    <!-- Right Telemetry Grid -->
                    <div class="tautulli-telemetry-panel">
                        <!-- Top-Right Platform Badge -->
                        <div class="tautulli-platform-badge" title="${escapeHtml(card.product)} · ${escapeHtml(card.player)}">
                            ${platformIcon}
                        </div>

                        <!-- Data Rows -->
                        <div class="tautulli-row">
                            <span class="tautulli-lbl">Product</span>
                            <span class="tautulli-val">${escapeHtml(card.product)}</span>
                        </div>
                        <div class="tautulli-row">
                            <span class="tautulli-lbl">Player</span>
                            <span class="tautulli-val">${escapeHtml(card.player)}</span>
                        </div>
                        <div class="tautulli-row">
                            <span class="tautulli-lbl">Quality</span>
                            <span class="tautulli-val">${escapeHtml(card.qualityDisplay)}</span>
                        </div>
                        <div class="tautulli-row">
                            <span class="tautulli-lbl">Stream</span>
                            <span class="tautulli-val">
                                <span class="tautulli-badge ${badgeClass}">${badgeLabel}</span>
                                ${reasonsHtml}
                            </span>
                        </div>
                        <div class="tautulli-row">
                            <span class="tautulli-lbl">Container</span>
                            <span class="tautulli-val">${escapeHtml(card.containerDisplay)}</span>
                        </div>
                        <div class="tautulli-row">
                            <span class="tautulli-lbl">Video</span>
                            <span class="tautulli-val">${escapeHtml(card.videoDisplay)}</span>
                        </div>
                        <div class="tautulli-row">
                            <span class="tautulli-lbl">Audio</span>
                            <span class="tautulli-val">${escapeHtml(card.audioDisplay)}</span>
                        </div>
                        <div class="tautulli-row">
                            <span class="tautulli-lbl">Subtitle</span>
                            <span class="tautulli-val">${escapeHtml(card.subtitleDisplay)}</span>
                        </div>
                        <div class="tautulli-row">
                            <span class="tautulli-lbl">Location</span>
                            <span class="tautulli-val">${escapeHtml(card.locationDisplay)}</span>
                        </div>
                        <div class="tautulli-row">
                            <span class="tautulli-lbl">Bandwidth</span>
                            <span class="tautulli-val">${escapeHtml(card.bandwidthDisplay)}</span>
                        </div>

                        <!-- Floating Time & ETA -->
                        <div class="tautulli-time-overlay">
                            <span class="tautulli-time-eta">${escapeHtml(card.etaStr)}</span>
                            <span class="tautulli-time-progress">${escapeHtml(card.timeProgressStr)}</span>
                        </div>
                    </div>
                </div>

                <!-- Seam: Fluid Progress Bar -->
                <div class="tautulli-progress-seam">
                    <div class="tautulli-progress-fill" style="width: ${card.progressPercent}%;"></div>
                </div>

                <!-- Bottom Block: Metadata, Titles, & User -->
                <div class="tautulli-bottom-block">
                    <div class="tautulli-media-info">
                        ${stateIconHtml}
                        <div class="tautulli-titles">
                            <div class="tautulli-title-primary" title="${escapeHtml(card.primaryTitle)}">
                                ${escapeHtml(card.primaryTitle)}
                            </div>
                            <div class="tautulli-title-secondary">
                                <span class="tautulli-title-year">${escapeHtml(card.secondaryTitle)}</span>
                            </div>
                        </div>
                    </div>

                    <div class="tautulli-user-badge" title="${escapeHtml(card.userName)}">
                        <span class="tautulli-user-name">${escapeHtml(card.userName)}</span>
                        ${avatarHtml}
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
        const totalBandwidth = cards.reduce((acc, c) => acc + (c.bandwidthNumber || 0), 0);

        const breakdownParts = [];
        if (directPlayCount > 0) breakdownParts.push(`${directPlayCount} direct play${directPlayCount > 1 ? 's' : ''}`);
        if (directStreamCount > 0) breakdownParts.push(`${directStreamCount} direct stream${directStreamCount > 1 ? 's' : ''}`);
        if (transcodeCount > 0) breakdownParts.push(`${transcodeCount} transcode${transcodeCount > 1 ? 's' : ''}`);

        const breakdownStr = breakdownParts.length > 0 ? `(${breakdownParts.join(', ')})` : '';

        return `
            <div class="tautulli-activity-banner">
                <div class="tautulli-activity-title">
                    <div class="tautulli-activity-pulse"></div>
                    <span>Activity</span>
                </div>
                <div class="tautulli-activity-stats">
                    <span>Sessions: <span class="tautulli-activity-stat-highlight">${totalStreams} stream${totalStreams > 1 ? 's' : ''}</span> ${breakdownStr}</span>
                    <span>|</span>
                    <span>Bandwidth: <span class="tautulli-activity-stat-highlight">${formatBitrate(totalBandwidth)}</span></span>
                </div>
            </div>
            <div class="tautulli-grid">
                ${cards.map(renderSessionCard).join('')}
            </div>
        `;
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
            const cards = activeSessions.map(mapSessionToCardModel);

            // Compute hash of content to avoid redundant DOM mutations
            const contentHash = JSON.stringify(cards.map((c) => ({
                id: c.sessionId,
                method: c.playMethod,
                paused: c.isPaused,
                pos: c.timeProgressStr,
                bw: c.bandwidthDisplay
            })));

            if (contentHash !== lastRenderedHash) {
                lastRenderedHash = contentHash;
                container.innerHTML = renderContainer(cards);
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

    console.info('[PlaybackCard] Jellyfin Playback Info Card script initialized successfully.');
})();
