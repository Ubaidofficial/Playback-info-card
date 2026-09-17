/**
 * Playback Info Card - Primary Dashboard Integration (v0.2.3.6)
 * Completely replaces Jellyfin's standard stock Devices section on the default
 * Dashboard with the NOW PLAYING telemetry grid and active connected device telemetry.
 */

(function (global) {
    'use strict';

    var VERSION = '0.2.3.6';
    var CONTAINER_ID = 'playback-card-nowplaying-container';
    var POLL_INTERVAL_MS = 3000;

    var state = {
        version: VERSION,
        activeSessions: [],
        allSessions: [],
        displayMode: 'compact', // compact (default) | extended
        showAllDetails: false,
        pollTimer: null,
        isPolling: false,
        isDashboardActive: false,
        isNonAdmin: false,
        lastRenderedJson: '',
        artworkFallbackCount: 0,
        renderErrors: 0
    };

    function escapeHtml(str) {
        if (!str) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function formatTicks(ticks) {
        if (!ticks || typeof ticks !== 'number' || !isFinite(ticks) || ticks <= 0) return '0:00';
        var totalSeconds = Math.floor(ticks / 10000000);
        var hours = Math.floor(totalSeconds / 3600);
        var minutes = Math.floor((totalSeconds % 3600) / 60);
        var seconds = totalSeconds % 60;
        var paddedSeconds = seconds < 10 ? '0' + seconds : String(seconds);
        if (hours > 0) {
            var paddedMinutes = minutes < 10 ? '0' + minutes : String(minutes);
            return hours + ':' + paddedMinutes + ':' + paddedSeconds;
        }
        return minutes + ':' + paddedSeconds;
    }

    function formatRelativeTime(dateStr) {
        if (!dateStr) return 'Active';
        var d = new Date(dateStr);
        var time = d.getTime();
        if (isNaN(time) || time <= 0) return 'Active';
        var diffMs = Date.now() - time;
        if (diffMs < 0) return 'Active now';
        var diffSec = Math.floor(diffMs / 1000);
        if (diffSec < 60) return 'Just now';
        var diffMin = Math.floor(diffSec / 60);
        if (diffMin < 60) return diffMin + 'm ago';
        var diffHours = Math.floor(diffMin / 60);
        if (diffHours < 24) return diffHours + 'h ago';
        var diffDays = Math.floor(diffHours / 24);
        return diffDays + 'd ago';
    }

    function extractResolutionPill(width, height) {
        if (!width && !height) return '';
        var w = Number(width) || 0;
        var h = Number(height) || 0;
        if (w >= 3800 || h >= 2000) return '4K';
        if (w >= 2500 || h >= 1400) return '1440p';
        if (w >= 1900 || h >= 1000) return '1080p';
        if (w >= 1200 || h >= 700) return '720p';
        if (w >= 700 || h >= 460) return '480p';
        if (h > 0) return h + 'p';
        return '';
    }

    function extractDynamicRangePill(videoStream) {
        if (!videoStream) return '';
        var range = (videoStream.VideoRange || videoStream.VideoRangeType || '').toUpperCase();
        if (range.indexOf('DOVI') !== -1 || range.indexOf('DOLBY') !== -1) return 'DV';
        if (range.indexOf('HDR10+') !== -1) return 'HDR10+';
        if (range.indexOf('HDR') !== -1) return 'HDR';
        if (range.indexOf('HLG') !== -1) return 'HLG';
        return '';
    }

    function extractAudioBadges(audioStream) {
        if (!audioStream) return [];
        var badges = [];
        var layout = audioStream.ChannelLayout || '';
        var channels = audioStream.Channels;
        if (layout.indexOf('7.1') !== -1 || channels === 8) badges.push('7.1');
        else if (layout.indexOf('5.1') !== -1 || channels === 6) badges.push('5.1');
        else if (channels === 2) badges.push('Stereo');
        else if (channels === 1) badges.push('Mono');
        else if (channels) badges.push(channels + ' ch');

        var codec = (audioStream.Codec || '').toUpperCase();
        if (codec) {
            if (codec === 'EAC3' || codec === 'EC-3') codec = 'E-AC3';
            else if (codec === 'TRUEHD') codec = 'TrueHD';
            else if (codec === 'DTS-HD') codec = 'DTS-HD';
            badges.push(codec);
        }
        return badges;
    }

    function extractSubtitleBadge(session, item) {
        var subIndex = (session && session.PlayState && session.PlayState.SubtitleStreamIndex != null)
            ? session.PlayState.SubtitleStreamIndex
            : ((session && session.SubtitleStreamIndex != null) ? session.SubtitleStreamIndex : -1);

        if (subIndex === -1) return null;

        var mediaStreams = (item && item.MediaStreams) || [];
        for (var i = 0; i < mediaStreams.length; i++) {
            var s = mediaStreams[i];
            if (s.Type === 'Subtitle' && (s.Index === subIndex || subIndex === -2)) {
                var title = (s.Title || '').toLowerCase();
                var isCC = s.IsHearingImpaired || title.indexOf('sdh') !== -1 || title.indexOf('cc') !== -1;
                if (isCC) return 'CC';
                var lang = s.Language || s.DisplayTitle || 'Sub';
                return lang.length > 3 ? lang.substring(0, 3).toUpperCase() : lang.toUpperCase();
            }
        }
        return null;
    }

    function extractTranscoderEngine(hwType) {
        if (!hwType) return 'Software';
        var hw = String(hwType).toLowerCase();
        if (hw.indexOf('nvenc') !== -1 || hw.indexOf('cuda') !== -1) return 'NVENC';
        if (hw.indexOf('qsv') !== -1 || hw.indexOf('quicksync') !== -1) return 'QSV';
        if (hw.indexOf('vaapi') !== -1) return 'VAAPI';
        if (hw.indexOf('amf') !== -1 || hw.indexOf('vce') !== -1) return 'AMF';
        if (hw.indexOf('videotoolbox') !== -1) return 'VideoToolbox';
        return hwType;
    }

    function formatTranscodeReason(reason) {
        if (!reason) return '';
        var r = String(reason);
        var map = {
            'ContainerNotSupported': 'Container not supported',
            'VideoCodecNotSupported': 'Video codec not supported',
            'AudioCodecNotSupported': 'Audio codec not supported',
            'SubtitleCodecNotSupported': 'Subtitle codec not supported',
            'AudioIsExternal': 'External audio track',
            'SecondaryAudioNotSupported': 'Secondary audio track not supported',
            'VideoProfileNotSupported': 'Video profile not supported',
            'VideoLevelNotSupported': 'Video level not supported',
            'VideoResolutionNotSupported': 'Resolution exceeds client limit',
            'VideoBitrateNotSupported': 'Bitrate exceeds allowable maximum',
            'VideoFramerateNotSupported': 'Framerate exceeds display capability',
            'RefFramesNotSupported': 'Reference frames not supported',
            'AnamorphicVideoNotSupported': 'Anamorphic video not supported',
            'InterlacedVideoNotSupported': 'Interlaced video requires deinterlacing',
            'DirectPlayError': 'Direct playback error occurred'
        };
        return map[r] || r;
    }

    function getPlatformIconSvg(clientName, deviceName) {
        var str = ((clientName || '') + ' ' + (deviceName || '')).toLowerCase();
        if (str.indexOf('android tv') !== -1 || str.indexOf('androidtv') !== -1 || str.indexOf('moonfin') !== -1 || str.indexOf('fire tv') !== -1 || str.indexOf('shield') !== -1) {
            return '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M21 3H3c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h5v2h8v-2h5c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 14H3V5h18v12z"/></svg>';
        }
        if (str.indexOf('android') !== -1) {
            return '<svg viewBox="0 0 24 24" width="20" height="20" fill="#3ddc84"><path d="M17.523 15.3414c-.5511 0-.9993-.4486-.9993-1.0003 0-.5516.4482-.9998.9993-.9998.5516 0 .9997.4482.9997.9998 0 .5517-.4481 1.0003-.9997 1.0003m-11.046 0c-.5511 0-.9993-.4486-.9993-1.0003 0-.5516.4482-.9998.9993-.9998.5516 0 .9998.4482.9998.9998 0 .5517-.4482 1.0003-.9998 1.0003m11.4045-6.02l1.9973-3.4592a.416.416 0 00-.1521-.5676.416.416 0 00-.5676.1521l-2.0223 3.503C15.5902 8.4114 13.8533 8.167 12 8.167c-1.8533 0-3.5902.2444-5.1367.783L4.841 5.447a.416.416 0 00-.5676-.1521.416.416 0 00-.1521.5676l1.9973 3.4592C2.6889 11.1867.3432 14.6589 0 18.761h24c-.3432-4.1021-2.6889-7.5743-6.1185-9.4396"/></svg>';
        }
        if (str.indexOf('apple') !== -1 || str.indexOf('ios') !== -1 || str.indexOf('iphone') !== -1 || str.indexOf('ipad') !== -1 || str.indexOf('safari') !== -1) {
            return '<svg viewBox="0 0 24 24" width="20" height="20" fill="#a2aaad"><path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.81-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M15.97 6.37c.62-.75 1.04-1.8 0.92-2.85-.9.04-1.98.6-2.62 1.35-.57.65-1.07 1.72-.94 2.74 1 .08 2.02-.49 2.64-1.24z"/></svg>';
        }
        if (str.indexOf('roku') !== -1) {
            return '<svg viewBox="0 0 24 24" width="20" height="20" fill="#6c3c97"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 14H9v-4.5H7.5V10H11v6zm4.5 0h-2V8h2c1.66 0 3 1.34 3 3s-1.34 3-3 3zm0-4h-1v2h1c.55 0 1-.45 1-1s-.45-1-1-1z"/></svg>';
        }
        if (str.indexOf('windows') !== -1) {
            return '<svg viewBox="0 0 24 24" width="20" height="20" fill="#00a4ef"><path d="M0 3.449L9.75 2.1v9.451H0m10.949-9.602L24 0v11.4H10.949M0 12.6h9.75v9.451L0 20.699M10.949 12.6H24V24l-12.95-1.801"/></svg>';
        }
        if (str.indexOf('chrome') !== -1) {
            return '<svg viewBox="0 0 24 24" width="20" height="20" fill="#fbbc05"><path d="M12 0C8.21 0 4.831 1.757 2.632 4.501l3.953 6.848A5.454 5.454 0 0 1 12 6.545h10.73A11.944 11.944 0 0 0 12 0zm-8.89 6.273A11.936 11.936 0 0 0 0 12c0 5.617 3.868 10.332 9.07 11.648l3.953-6.848a5.454 5.454 0 0 1-5.69-2.825zm14.39 3.018a5.454 5.454 0 0 1-.806 8.164L12.74 24C18.969 24 24 18.969 24 12.741c0-1.157-.164-2.276-.468-3.332zM12 7.636a4.364 4.364 0 1 0 0 8.728 4.364 4.364 0 0 0 0-8.728z"/></svg>';
        }
        // Default generic screen/player icon
        return '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M20 3H4c-1.1 0-2 .9-2 2v11c0 1.1.9 2 2 2h3l-1 2v1h12v-1l-1-2h3c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 13H4V5h16v11z"/></svg>';
    }

    function getApiClient() {
        if (typeof window !== 'undefined') {
            if (window.ApiClient) return window.ApiClient;
            if (window.Dashboard && typeof window.Dashboard.getCurrentApiClient === 'function') {
                return window.Dashboard.getCurrentApiClient();
            }
            if (window.ConnectionManager && window.ConnectionManager.currentApiClient) {
                return window.ConnectionManager.currentApiClient;
            }
            if (window.require) {
                try {
                    var cm = window.require('connectionManager');
                    if (cm && cm.currentApiClient) return cm.currentApiClient;
                } catch (_) {}
            }
        }
        return null;
    }

    function isDashboardPage() {
        if (typeof window === 'undefined') return false;
        var hash = ((window.location && window.location.hash) || '').toLowerCase();
        var path = ((window.location && window.location.pathname) || '').toLowerCase();
        var isHashMatch = hash.indexOf('dashboard') !== -1 || hash.indexOf('devices') !== -1;
        var isPathMatch = path.indexOf('dashboard') !== -1 || path.indexOf('devices') !== -1;

        if (isHashMatch || isPathMatch) {
            return true;
        }

        // If hash or path explicitly points to another view (e.g. #/settings, #/home), it is not dashboard
        if (hash && hash.length > 2 && !isHashMatch) {
            return false;
        }

        if (typeof document !== 'undefined') {
            if (typeof document.querySelector === 'function') {
                var activeView = document.querySelector('.page.page-current:not(.hide), [data-role="page"].page-current:not(.hide), .page:not(.hide), [data-role="page"]:not(.hide)');
                if (activeView) {
                    var id = (activeView.id || '').toLowerCase();
                    var cls = (activeView.className || '').toLowerCase();
                    if (id.indexOf('dashboard') !== -1 || id.indexOf('devices') !== -1 ||
                        cls.indexOf('dashboard') !== -1 || cls.indexOf('devices') !== -1) {
                        return true;
                    }
                    return false;
                }
            }
            var dashPage = typeof document.getElementById === 'function' ? document.getElementById('dashboardPage') : null;
            if (dashPage && !dashPage.classList.contains('hide')) {
                return true;
            }
            var devPage = typeof document.getElementById === 'function' ? document.getElementById('devicesPage') : null;
            if (devPage && !devPage.classList.contains('hide')) {
                return true;
            }
        }
        return false;
    }

    function findWidgetContainerFromTarget(targetNode, scope) {
        if (!targetNode) return null;
        var cur = targetNode;
        while (cur && cur !== scope && cur !== document.body && cur !== document.documentElement) {
            var p = cur.parentElement;
            if (!p) break;
            var pCls = (p.className || '').toLowerCase();
            var pId = (p.id || '').toLowerCase();

            var isParentColumn = pCls.indexOf('muistack') !== -1 ||
                                 pCls.indexOf('muigrid') !== -1 ||
                                 pCls.indexOf('content-primary') !== -1 ||
                                 pCls.indexOf('verticalsection') !== -1 ||
                                 pCls.indexOf('dashboardsection') !== -1 ||
                                 pId === 'dashboardpage' ||
                                 pId === 'devicespage' ||
                                 (typeof p.getAttribute === 'function' && p.getAttribute('data-role') === 'content');

            var isTooBroad = cur.classList && (
                cur.classList.contains('content-primary') ||
                cur.id === 'dashboardPage' ||
                cur.id === 'devicesPage'
            );

            if (isParentColumn && !isTooBroad) {
                var hasOtherWidgets = false;
                try {
                    var otherLinks = (typeof cur.querySelectorAll === 'function')
                        ? cur.querySelectorAll('a[href*="activity"], a[href*="serverinfo"], a[href*="tasks"], a[href*="logs"], a[href*="paths"]')
                        : [];
                    if (otherLinks && otherLinks.length > 0) {
                        hasOtherWidgets = true;
                    }
                } catch (_) {}

                if (!hasOtherWidgets) {
                    return cur;
                }
            }
            cur = cur.parentElement;
        }
        return targetNode.parentElement || targetNode;
    }

    function findStockDevicesSection(root) {
        if (typeof document === 'undefined') return null;
        var scope = root || document;

        // 1. Modern Jellyfin 12.1 React/MUI: Link or button to devices
        var deviceLinks = (typeof scope.querySelectorAll === 'function')
            ? scope.querySelectorAll('a[href*="dashboard/devices"], a[href$="/devices"], a[href*="#/devices"], a[href*="#/dashboard/devices"], button[to*="devices"], a[to*="devices"]')
            : [];

        for (var l = 0; l < deviceLinks.length; l++) {
            var link = deviceLinks[l];
            if (typeof link.closest === 'function' && link.closest('#' + CONTAINER_ID)) {
                continue;
            }
            var container = findWidgetContainerFromTarget(link, scope);
            if (container && container.id !== CONTAINER_ID) {
                return container;
            }
        }

        // 2. Headings with text "devices" or "active devices"
        var headings = (typeof scope.querySelectorAll === 'function')
            ? scope.querySelectorAll('h1, h2, h3, h4, .sectionTitle, [class*="Typography"]')
            : [];

        for (var j = 0; j < headings.length; j++) {
            var h = headings[j];
            if (typeof h.closest === 'function' && h.closest('#' + CONTAINER_ID)) {
                continue;
            }
            var text = (h.textContent || '').trim().toLowerCase();
            var i18n = typeof h.getAttribute === 'function' ? h.getAttribute('data-i18n-key') : null;
            if (text === 'devices' || text === 'active devices' || i18n === 'HeaderDevices') {
                var hContainer = findWidgetContainerFromTarget(h, scope);
                if (hContainer && hContainer.id !== CONTAINER_ID) {
                    return hContainer;
                }
            }
        }

        // 3. Classic / legacy stock Jellyfin Devices selectors
        var selectors = [
            '.activeDevices',
            '#activeDevices',
            '.dashboardDevices',
            '.devicesList',
            '.deviceSection',
            '.devicesSection',
            '[data-role="devicesList"]'
        ];

        for (var i = 0; i < selectors.length; i++) {
            var el = (typeof scope.querySelector === 'function') ? scope.querySelector(selectors[i]) : null;
            if (el && el.id !== CONTAINER_ID) {
                if (typeof el.closest === 'function' && el.closest('#' + CONTAINER_ID)) {
                    continue;
                }
                if (typeof el.closest === 'function') {
                    var sec = el.closest('.verticalSection, .section, .dashboardSection');
                    if (sec && sec !== scope && !sec.classList.contains('content-primary') && (!sec.id || sec.id.indexOf('Page') === -1)) {
                        var titles = sec.querySelectorAll('.sectionTitle, h2, h3');
                        if (titles.length <= 1) {
                            return sec;
                        }
                    }
                }
                return el;
            }
        }

        return null;
    }

    function ensureContainerInserted() {
        if (typeof document === 'undefined') return null;

        var existing = document.getElementById(CONTAINER_ID);
        var devicesSection = findStockDevicesSection();

        if (devicesSection && devicesSection.parentNode) {
            if (!existing) {
                existing = document.createElement('div');
                existing.id = CONTAINER_ID;
                attachContainerEvents(existing);
            }

            // Mount the NOW PLAYING container in the Devices section's exact location
            devicesSection.parentNode.insertBefore(existing, devicesSection);

            // Do not remove the original Devices section until NOW PLAYING has mounted successfully
            var isMounted = false;
            try {
                isMounted = Boolean(existing.parentNode && (typeof document.contains !== 'function' || document.contains(existing)));
            } catch (_) {
                isMounted = Boolean(existing.parentNode);
            }

            if (isMounted) {
                // Completely replace / remove original stock Devices section
                devicesSection.style.display = 'none';
                if (devicesSection.parentNode) {
                    devicesSection.parentNode.removeChild(devicesSection);
                }
            }

            return existing;
        }

        // If existing is already mounted and no stock devices section is found
        if (existing) {
            return existing;
        }

        // CRITICAL: Zero fallback to mainContent.firstChild or top of page!
        // If stock Devices section is not yet rendered, wait for MutationObserver.
        console.warn('[PlaybackCard] Stock Devices section not found in DOM yet; waiting for render.');
        return null;
    }

    function renderSessionCard(session, index, displayMode, showAllDetails) {
        try {
            if (!session || typeof session !== 'object') {
                return '';
            }

            var cardIdx = typeof index === 'number' ? (index + 1) : 1;
            var cardDomId = 'dash-card-' + cardIdx;
            var detailsDomId = 'details-' + cardDomId;

            var user = escapeHtml(session.UserName || (session.MediaTitle ? 'My Session' : 'Unknown User'));
            var client = escapeHtml(session.Client || 'Playback Client');
            var device = escapeHtml(session.DeviceName || '');
            var clientDevice = client + (device ? ' &mdash; ' + device : '');
            if (session.ApplicationVersion) {
                clientDevice += ' (v' + escapeHtml(session.ApplicationVersion) + ')';
            }

            var platformIconSvg = getPlatformIconSvg(session.Client, session.DeviceName);

            var item = session.NowPlayingItem || {};
            var title = escapeHtml(session.MediaTitle || item.Name || 'Unknown Media');
            var subtitle = '';
            if (session.SeriesName || item.SeriesName) {
                subtitle = escapeHtml(session.SeriesName || item.SeriesName);
                var sNum = session.SeasonNumber != null ? session.SeasonNumber : (item.SeasonName || item.ParentIndexNumber);
                if (sNum) {
                    subtitle += ' &bull; ' + (typeof sNum === 'number' ? 'Season ' + sNum : escapeHtml(String(sNum)));
                }
                var epNum = session.EpisodeNumber != null ? session.EpisodeNumber : item.IndexNumber;
                if (epNum != null) {
                    subtitle += ' &bull; Ep ' + escapeHtml(String(epNum));
                }
            } else if (session.ProductionYear || item.ProductionYear) {
                subtitle = escapeHtml(String(session.ProductionYear || item.ProductionYear));
            }

            var playState = session.PlayState || {};
            var isPaused = session.IsPaused != null ? Boolean(session.IsPaused) : Boolean(playState.IsPaused);
            var playMethod = session.PlayMethod || playState.PlayMethod || 'DirectPlay';

            var tInfo = session.TranscodingInfo;
            var isRemux = Boolean(session.IsContainerRemux || (tInfo && tInfo.IsVideoDirect && (!tInfo.IsAudioDirect || (tInfo.Container && item.Container && tInfo.Container.toLowerCase() !== item.Container.toLowerCase()))));

            var badgeClass = 'direct-play';
            var badgeText = 'Direct Play';
            var stateIcon = '<svg class="badge-icon" viewBox="0 0 24 24"><polygon points="5 3 19 12 5 21 5 3"/></svg>';

            if (isPaused) {
                badgeClass = 'paused';
                badgeText = 'Paused';
                stateIcon = '<svg class="badge-icon" viewBox="0 0 24 24"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>';
            } else if (isRemux || playMethod === 'Remux') {
                badgeClass = 'remux';
                badgeText = 'Remux';
            } else if (playMethod === 'DirectStream') {
                badgeClass = 'direct-stream';
                badgeText = 'Direct Stream';
            } else if (playMethod === 'Transcode' || tInfo) {
                badgeClass = 'transcode';
                badgeText = 'Transcode';
            }

            // Video & Audio Direct/Transcode determination
            var isVideoDirect = null;
            var isAudioDirect = null;
            if (typeof session.IsVideoDirect === 'boolean') {
                isVideoDirect = session.IsVideoDirect;
            } else if (tInfo && typeof tInfo.IsVideoDirect === 'boolean') {
                isVideoDirect = tInfo.IsVideoDirect;
            } else if (playMethod === 'DirectPlay') {
                isVideoDirect = true;
            }

            if (typeof session.IsAudioDirect === 'boolean') {
                isAudioDirect = session.IsAudioDirect;
            } else if (tInfo && typeof tInfo.IsAudioDirect === 'boolean') {
                isAudioDirect = tInfo.IsAudioDirect;
            } else if (playMethod === 'DirectPlay') {
                isAudioDirect = true;
            }

            var videoBadgeText = (isVideoDirect === true) ? 'Video: Direct' : (isVideoDirect === false ? 'Video: Transcode' : 'Video: Direct');
            var videoBadgeCls = (isVideoDirect === false) ? 'stream-badge video-transcode' : 'stream-badge video-direct';

            var audioBadgeText = (isAudioDirect === true) ? 'Audio: Direct' : (isAudioDirect === false ? 'Audio: Transcode' : 'Audio: Direct');
            var audioBadgeCls = (isAudioDirect === false) ? 'stream-badge audio-transcode' : 'stream-badge audio-direct';

            // Accessible Info toggle button
            var isDrawerOpen = (displayMode === 'extended') || Boolean(showAllDetails);
            var infoBtnHtml = '<button type="button" class="playback-btn-info" data-action="toggle-info" aria-expanded="' + (isDrawerOpen ? 'true' : 'false') + '" aria-controls="' + detailsDomId + '" id="btn-info-' + cardDomId + '" title="Toggle stream details">' +
                '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg> Info</button>';

            // Media Streams extraction
            var mediaStreams = item.MediaStreams || [];
            var videoStream = null;
            var audioStream = null;
            for (var i = 0; i < mediaStreams.length; i++) {
                if (!videoStream && mediaStreams[i].Type === 'Video') videoStream = mediaStreams[i];
                if (!audioStream && mediaStreams[i].Type === 'Audio') audioStream = mediaStreams[i];
            }

            // Ordered Top 5 Essential Badges for compact/mobile layout:
            // 1. Resolution
            // 2. Play Method (Direct Play / Direct Stream / Remux / Transcode)
            // 3. Video Codec
            // 4. Audio Channels
            // 5. Container
            var pills = [];
            var resPill = extractResolutionPill(item.Width || (videoStream && videoStream.Width), item.Height || (videoStream && videoStream.Height));
            if (resPill) pills.push({ text: resPill, cls: 'res' });

            // Method pill
            pills.push({ text: badgeText, cls: '' });

            // Video codec
            var vCodec = session.VideoCodec || (tInfo && tInfo.VideoCodec) || (videoStream && videoStream.Codec ? videoStream.Codec.toUpperCase() : '');
            if (vCodec) {
                if (vCodec === 'H264' || vCodec === 'h264') vCodec = 'H.264';
                else if (vCodec === 'HEVC' || vCodec === 'hevc') vCodec = 'HEVC';
                pills.push({ text: vCodec, cls: '' });
            }

            // Audio channels
            var audioBadges = extractAudioBadges(audioStream);
            if (audioBadges.length > 0) {
                pills.push({ text: audioBadges[0], cls: 'audio' });
            }

            // Container
            var containerVal = (session.Container || (tInfo && tInfo.Container) || item.Container || '').toUpperCase();
            if (containerVal) {
                pills.push({ text: containerVal, cls: '' });
            }

            // If in extended mode, add additional secondary badges (HDR, secondary audio, subtitle)
            if (displayMode === 'extended') {
                var hdrPill = extractDynamicRangePill(videoStream);
                if (hdrPill) pills.push({ text: hdrPill, cls: 'hdr' });

                if (audioBadges.length > 1) {
                    pills.push({ text: audioBadges[1], cls: 'audio' });
                }

                var subBadge = extractSubtitleBadge(session, item);
                if (subBadge) pills.push({ text: subBadge, cls: 'sub' });
            }

            // Mobile/Compact limit: exactly cap at top 5 essential badges
            var renderedPills = (displayMode === 'compact' && pills.length > 5) ? pills.slice(0, 5) : pills;

            var pillHtml = renderedPills.map(function (p) {
                return '<span class="playback-pill ' + p.cls + '">' + escapeHtml(p.text) + '</span>';
            }).join('');

            // Progress calculations
            var positionTicks = (typeof session.PositionTicks === 'number' && isFinite(session.PositionTicks))
                ? session.PositionTicks
                : ((typeof playState.PositionTicks === 'number' && isFinite(playState.PositionTicks) && playState.PositionTicks > 0)
                    ? playState.PositionTicks
                    : 0);

            var runtimeTicks = (typeof session.RunTimeTicks === 'number' && isFinite(session.RunTimeTicks))
                ? session.RunTimeTicks
                : ((typeof item.RunTimeTicks === 'number' && isFinite(item.RunTimeTicks) && item.RunTimeTicks > 0)
                    ? item.RunTimeTicks
                    : 0);

            var percent = 0;
            if (typeof session.PlaybackPercentage === 'number' && isFinite(session.PlaybackPercentage)) {
                percent = Math.min(100, Math.max(0, session.PlaybackPercentage));
            } else if (runtimeTicks > 0) {
                percent = Math.min(100, Math.max(0, (positionTicks / runtimeTicks) * 100));
            }

            // Truthful How and Why transcode details
            var metaParts = [];
            var engine = session.TranscodeEngine || (tInfo ? extractTranscoderEngine(tInfo.HardwareAccelerationType) : '');
            if (engine) metaParts.push('Engine: ' + escapeHtml(engine));

            var streamVideoCodec = session.VideoCodec || (tInfo && tInfo.VideoCodec);
            if (streamVideoCodec) metaParts.push('Video: ' + escapeHtml(streamVideoCodec.toUpperCase()));

            var streamAudioCodec = session.AudioCodec || (tInfo && tInfo.AudioCodec);
            if (streamAudioCodec) metaParts.push('Audio: ' + escapeHtml(streamAudioCodec.toUpperCase()));

            var containerStr = session.Container || (tInfo && tInfo.Container) || item.Container;
            if (containerStr) {
                var cConversion = (item.Container && tInfo && tInfo.Container && item.Container.toLowerCase() !== tInfo.Container.toLowerCase())
                    ? (escapeHtml(item.Container.toUpperCase()) + ' &rarr; ' + escapeHtml(tInfo.Container.toUpperCase()))
                    : escapeHtml(containerStr.toUpperCase());
                metaParts.push('Container: ' + cConversion);
            }

            if (session.Resolution) metaParts.push('Resolution: ' + escapeHtml(session.Resolution));

            if (tInfo && typeof tInfo.Framerate === 'number' && isFinite(tInfo.Framerate) && tInfo.Framerate > 0) {
                metaParts.push(Math.round(tInfo.Framerate) + ' fps');
            }

            if (tInfo && typeof tInfo.Bitrate === 'number' && isFinite(tInfo.Bitrate) && tInfo.Bitrate > 0) {
                var mbps = (tInfo.Bitrate / 1000000).toFixed(1);
                metaParts.push('Bitrate: ' + mbps + ' Mbps');
            }

            var reasonsWhyHtml = '';
            if (session.TranscodeReasonsWhy) {
                reasonsWhyHtml = escapeHtml(session.TranscodeReasonsWhy);
            } else if (Array.isArray(session.TranscodeReasons) && session.TranscodeReasons.length > 0) {
                var validReasons = session.TranscodeReasons.map(formatTranscodeReason);
                reasonsWhyHtml = escapeHtml(validReasons.join(', '));
            } else if (tInfo && Array.isArray(tInfo.TranscodeReasons) && tInfo.TranscodeReasons.length > 0) {
                var validTReasons = tInfo.TranscodeReasons.filter(function (r) { return r != null; }).map(formatTranscodeReason);
                if (validTReasons.length > 0) {
                    reasonsWhyHtml = escapeHtml(validTReasons.join(', '));
                }
            } else if (playMethod === 'Transcode' || tInfo) {
                reasonsWhyHtml = 'Reason not reported by server';
            }

            var detailsPanelHtml = '<div id="' + detailsDomId + '" class="playback-details-panel' + (isDrawerOpen ? ' open' : '') + '" role="region" aria-label="Stream Details">' +
                '<div class="playback-stream-badges">' +
                    '<span class="' + videoBadgeCls + '">' + escapeHtml(videoBadgeText) + '</span>' +
                    '<span class="' + audioBadgeCls + '">' + escapeHtml(audioBadgeText) + '</span>' +
                '</div>' +
                (metaParts.length > 0 ? '<div class="playback-details-row"><strong>Stream:</strong> ' + metaParts.join(' &bull; ') + '</div>' : '') +
                (reasonsWhyHtml ? '<div class="playback-details-row playback-transcode-reasons"><strong>Why:</strong> ' + reasonsWhyHtml + '</div>' : '') +
            '</div>';

            // Artwork
            var apiClient = getApiClient();
            var posterUrl = '';
            var backdropUrl = '';
            var itemId = session.ItemId || item.Id;
            var primaryTag = session.PrimaryImageTag || item.PrimaryImageTag;

            if (apiClient && typeof apiClient.getImageUrl === 'function' && itemId) {
                if (primaryTag) {
                    posterUrl = apiClient.getImageUrl(itemId, { type: 'Primary', tag: primaryTag, maxWidth: 200 });
                }
                if (item.BackdropImageTags && item.BackdropImageTags.length > 0) {
                    backdropUrl = apiClient.getImageUrl(itemId, { type: 'Backdrop', tag: item.BackdropImageTags[0], maxWidth: 600 });
                }
            }

            var backdropStyle = backdropUrl ? ' style="background-image: url(\'' + escapeHtml(backdropUrl) + '\');"' : '';
            var posterHtml = '';
            if (posterUrl) {
                posterHtml = '<img class="playback-poster" src="' + escapeHtml(posterUrl) + '" alt="' + title + '" onerror="this.parentNode.innerHTML=\'<div class=\\\'playback-poster-fallback\\\'><svg viewBox=\\\'0 0 24 24\\\' width=\\\'24\\\' height=\\\'24\\\' fill=\\\'none\\\' stroke=\\\'currentColor\\\' stroke-width=\\\'1.5\\\'><rect x=\\\'2\\\' y=\\\'2\\\' width=\\\'20\\\' height=\\\'20\\\' rx=\\\'3\\\'/><path d=\\\'M7 2v20M17 2v20M2 12h20\\\'/></svg></div>\';" />';
            } else {
                state.artworkFallbackCount++;
                posterHtml = '<div class="playback-poster-fallback"><svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="2" width="20" height="20" rx="3"/><path d="M7 2v20M17 2v20M2 12h20"/></svg></div>';
            }

            return '<div class="playback-card" data-card-id="' + escapeHtml(cardDomId) + '">' +
                '<div class="playback-card-backdrop"' + backdropStyle + '></div>' +
                '<div class="playback-card-inner">' +
                    '<div class="playback-card-header">' +
                        '<div class="playback-card-user-group">' +
                            '<span class="playback-platform-icon" title="' + client + '">' + platformIconSvg + '</span>' +
                            '<div class="playback-card-user-info">' +
                                '<div class="playback-card-user">' + user + '</div>' +
                                '<div class="playback-card-client">' + clientDevice + '</div>' +
                            '</div>' +
                        '</div>' +
                        '<div class="playback-badge-group">' +
                            '<span class="playback-badge ' + badgeClass + '">' + stateIcon + ' ' + badgeText + '</span>' +
                            infoBtnHtml +
                        '</div>' +
                    '</div>' +
                    '<div class="playback-card-main">' +
                        '<div class="playback-poster-wrap">' + posterHtml + '</div>' +
                        '<div class="playback-card-body">' +
                            '<div class="playback-card-title">' + title + '</div>' +
                            (subtitle ? '<div class="playback-card-subtitle">' + subtitle + '</div>' : '') +
                            (pillHtml ? '<div class="playback-pill-row">' + pillHtml + '</div>' : '') +
                        '</div>' +
                    '</div>' +
                    '<div class="playback-card-progress">' +
                        '<div class="playback-progress-bar-track">' +
                            '<div class="playback-progress-bar-fill" style="width: ' + percent.toFixed(1) + '%;"></div>' +
                        '</div>' +
                        '<div class="playback-progress-times">' +
                            '<span>' + formatTicks(positionTicks) + '</span>' +
                            '<span>' + formatTicks(runtimeTicks) + '</span>' +
                        '</div>' +
                    '</div>' +
                    detailsPanelHtml +
                '</div>' +
            '</div>';
        } catch (err) {
            console.error('[PlaybackCard] Card render error:', err);
            state.renderErrors++;
            return '<div class="playback-card error-card"><div class="playback-card-inner"><p style="color:#fca5a5;margin:0;font-size:0.85rem;">Failed to render playback card.</p></div></div>';
        }
    }

    function calculateSessionCounts(sessions) {
        var counts = { directPlay: 0, directStream: 0, transcode: 0, paused: 0 };
        for (var i = 0; i < sessions.length; i++) {
            var s = sessions[i];
            var ps = s.PlayState || {};
            var isPaused = s.IsPaused != null ? Boolean(s.IsPaused) : Boolean(ps.IsPaused);
            if (isPaused) {
                counts.paused++;
                continue;
            }

            var method = s.PlayMethod || ps.PlayMethod || 'DirectPlay';
            var tInfo = s.TranscodingInfo;
            var isRemux = Boolean(s.IsContainerRemux || (tInfo && tInfo.IsVideoDirect && !tInfo.IsAudioDirect));

            if (method === 'Transcode' || (tInfo && !tInfo.IsVideoDirect)) {
                counts.transcode++;
            } else if (method === 'DirectStream' || isRemux || method === 'Remux') {
                counts.directStream++;
            } else {
                counts.directPlay++;
            }
        }
        return counts;
    }

    function renderConnectedDeviceItem(session) {
        if (!session || typeof session !== 'object') return '';
        var client = escapeHtml(session.Client || 'Playback Client');
        var device = escapeHtml(session.DeviceName || client);
        var user = escapeHtml(session.UserName || 'Unknown User');
        var version = session.ApplicationVersion ? ('v' + escapeHtml(session.ApplicationVersion)) : '';
        var platformIcon = getPlatformIconSvg(session.Client, session.DeviceName);
        var lastActive = formatRelativeTime(session.LastActivityDate);

        var isPlaying = Boolean(session.NowPlayingItem || session.MediaTitle);
        var playStatus = '';
        if (isPlaying) {
            var mediaTitle = escapeHtml(session.MediaTitle || (session.NowPlayingItem && session.NowPlayingItem.Name) || 'Media');
            var isPaused = session.IsPaused != null ? Boolean(session.IsPaused) : Boolean(session.PlayState && session.PlayState.IsPaused);
            if (isPaused) {
                playStatus = '<span class="playback-device-status status-paused">Paused: ' + mediaTitle + '</span>';
            } else {
                playStatus = '<span class="playback-device-status status-playing">Playing: ' + mediaTitle + '</span>';
            }
        } else {
            playStatus = '<span class="playback-device-status status-idle">Idle &bull; ' + escapeHtml(lastActive) + '</span>';
        }

        return '<div class="playback-device-card" data-device-id="' + escapeHtml(session.Id || '') + '">' +
            '<div class="playback-device-icon" title="' + client + '">' + platformIcon + '</div>' +
            '<div class="playback-device-info">' +
                '<div class="playback-device-top-row">' +
                    '<span class="playback-device-name">' + device + '</span>' +
                    (version ? '<span class="playback-device-ver">' + version + '</span>' : '') +
                '</div>' +
                '<div class="playback-device-meta">' +
                    '<span class="playback-device-client">' + client + '</span>' +
                    '<span class="playback-meta-sep">&bull;</span>' +
                    '<span class="playback-device-user">' + user + '</span>' +
                '</div>' +
                '<div class="playback-device-status-row">' + playStatus + '</div>' +
            '</div>' +
        '</div>';
    }

    function renderDashboardContainer(container, sessions, allSessions) {
        var activeSessions = Array.isArray(sessions) ? sessions : [];
        var connectedSessions = Array.isArray(allSessions)
            ? allSessions
            : (Array.isArray(state.allSessions) && state.allSessions.length > 0 ? state.allSessions : activeSessions);

        var counts = calculateSessionCounts(activeSessions);
        var isCompact = (state.displayMode === 'compact');

        var headerHtml = '<div class="playback-dashboard-header">' +
            '<div class="playback-dashboard-title-group">' +
                '<h2 class="playback-dashboard-title">' +
                    '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polygon points="10 8 16 12 10 16 10 8" fill="currentColor"/></svg>' +
                    'NOW PLAYING' +
                '</h2>' +
                '<div class="playback-live-indicator"><span class="playback-live-dot"></span> Live</div>' +
                '<div class="playback-dashboard-counts">' +
                    '<span class="playback-count-chip count-dp"><span class="count-val">' + counts.directPlay + '</span> Direct Play</span>' +
                    '<span class="playback-count-chip count-ds"><span class="count-val">' + counts.directStream + '</span> Direct Stream</span>' +
                    '<span class="playback-count-chip count-tc"><span class="count-val">' + counts.transcode + '</span> Transcode</span>' +
                    (counts.paused > 0 ? '<span class="playback-count-chip count-paused"><span class="count-val">' + counts.paused + '</span> Paused</span>' : '') +
                '</div>' +
            '</div>' +
            '<div class="playback-dashboard-controls">' +
                '<div class="playback-mode-toggle" role="group" aria-label="Display density">' +
                    '<button type="button" class="playback-mode-btn' + (isCompact ? ' active' : '') + '" data-mode="compact">Compact</button>' +
                    '<button type="button" class="playback-mode-btn' + (!isCompact ? ' active' : '') + '" data-mode="extended">Extended</button>' +
                '</div>' +
                '<button type="button" class="playback-btn-toggle-details" data-action="toggle-all-details">' +
                    (state.showAllDetails ? 'Hide Details' : 'Show Details') +
                '</button>' +
            '</div>' +
        '</div>';

        var contentHtml = '';
        if (activeSessions.length === 0) {
            contentHtml = '<div class="playback-dashboard-empty">' +
                '<p>No active playback</p>' +
                '</div>';
        } else {
            var cardsHtml = activeSessions.map(function (s, idx) {
                return renderSessionCard(s, idx, state.displayMode, state.showAllDetails);
            }).join('');
            contentHtml = '<div class="playback-dashboard-grid">' + cardsHtml + '</div>';
        }

        var connectedDevicesHtml = '';
        if (connectedSessions.length > 0) {
            var devCards = connectedSessions.map(renderConnectedDeviceItem).filter(Boolean).join('');
            if (devCards) {
                connectedDevicesHtml = '<div class="playback-connected-devices">' +
                    '<div class="playback-devices-header">' +
                        '<h3 class="playback-devices-title">' +
                            '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>' +
                            'Connected Devices' +
                        '</h3>' +
                        '<span class="playback-devices-count">' + connectedSessions.length + '</span>' +
                    '</div>' +
                    '<div class="playback-devices-grid">' + devCards + '</div>' +
                '</div>';
            }
        }

        container.innerHTML = headerHtml + contentHtml + connectedDevicesHtml;
    }

    function attachContainerEvents(container) {
        if (!container || container.getAttribute('data-events-attached') === 'true') return;
        container.setAttribute('data-events-attached', 'true');

        container.addEventListener('click', function (e) {
            var target = e.target;
            if (!target) return;

            // Toggle mode button (Compact / Extended)
            var modeBtn = target.closest('.playback-mode-btn');
            if (modeBtn) {
                var newMode = modeBtn.getAttribute('data-mode');
                if (newMode && newMode !== state.displayMode) {
                    state.displayMode = newMode;
                    renderDashboardContainer(container, state.activeSessions, state.allSessions);
                }
                return;
            }

            // Toggle all details button
            var allDetailsBtn = target.closest('[data-action="toggle-all-details"]');
            if (allDetailsBtn) {
                state.showAllDetails = !state.showAllDetails;
                renderDashboardContainer(container, state.activeSessions, state.allSessions);
                return;
            }

            // Toggle single card info drawer
            var infoBtn = target.closest('[data-action="toggle-info"]');
            if (infoBtn) {
                var controlsId = infoBtn.getAttribute('aria-controls');
                if (controlsId) {
                    var panel = document.getElementById(controlsId);
                    if (panel) {
                        var isOpen = panel.classList.contains('open');
                        if (isOpen) {
                            panel.classList.remove('open');
                            infoBtn.setAttribute('aria-expanded', 'false');
                        } else {
                            panel.classList.add('open');
                            infoBtn.setAttribute('aria-expanded', 'true');
                        }
                    }
                }
                return;
            }
        });
    }

    async function pollSessions() {
        if (!isDashboardPage()) {
            stopPolling();
            return;
        }

        var apiClient = getApiClient();
        if (!apiClient) return;

        try {
            var sessions = null;

            // Non-admin mode check
            if (!state.isNonAdmin && typeof apiClient.getSessions === 'function') {
                try {
                    sessions = await apiClient.getSessions();
                } catch (adminErr) {
                    // Fall back to personal self sessions on 401/403
                    if (adminErr && (adminErr.status === 401 || adminErr.status === 403 || adminErr.statusCode === 403)) {
                        state.isNonAdmin = true;
                    }
                }
            }

            if (sessions == null) {
                // Fetch personal sessions endpoint
                var selfUrl = (typeof apiClient.getUrl === 'function')
                    ? apiClient.getUrl('PlaybackCard/Self/Sessions')
                    : '/PlaybackCard/Self/Sessions';

                if (typeof apiClient.getJSON === 'function') {
                    sessions = await apiClient.getJSON(selfUrl);
                } else {
                    var headers = {};
                    if (typeof apiClient.accessToken === 'function' && apiClient.accessToken()) {
                        headers['Authorization'] = 'MediaBrowser Token="' + apiClient.accessToken() + '"';
                    }
                    var resp = await fetch(selfUrl, { headers: headers });
                    if (resp.ok) {
                        sessions = await resp.json();
                    }
                }
            }

            if (Array.isArray(sessions)) {
                state.allSessions = sessions;
                // Filter to active playback streams
                var active = sessions.filter(function (s) {
                    return s && (s.NowPlayingItem != null || s.MediaTitle != null);
                });
                state.activeSessions = active;

                var container = ensureContainerInserted();
                if (container) {
                    renderDashboardContainer(container, active, sessions);
                }
            }
        } catch (pollErr) {
            console.warn('[PlaybackCard] Dashboard session poll error:', pollErr);
        }
    }

    function startPolling() {
        if (state.isPolling) return;
        state.isPolling = true;
        pollSessions();
        if (typeof window !== 'undefined' && typeof window.setInterval === 'function') {
            state.pollTimer = window.setInterval(pollSessions, POLL_INTERVAL_MS);
        } else if (typeof setInterval === 'function') {
            state.pollTimer = setInterval(pollSessions, POLL_INTERVAL_MS);
            if (state.pollTimer && typeof state.pollTimer.unref === 'function') {
                state.pollTimer.unref();
            }
        }
    }

    function stopPolling() {
        if (state.pollTimer) {
            if (typeof window !== 'undefined' && typeof window.clearInterval === 'function') {
                window.clearInterval(state.pollTimer);
            } else if (typeof clearInterval === 'function') {
                clearInterval(state.pollTimer);
            }
            state.pollTimer = null;
        }
        state.isPolling = false;
    }

    function handleRouteOrDomChange() {
        if (isDashboardPage()) {
            ensureContainerInserted();
            startPolling();
        } else {
            stopPolling();
        }
    }

    function init() {
        if (typeof window === 'undefined' || typeof document === 'undefined') return;

        // Listen for SPA navigation events
        if (typeof window.addEventListener === 'function') {
            window.addEventListener('popstate', handleRouteOrDomChange);
            window.addEventListener('hashchange', handleRouteOrDomChange);
        }
        if (typeof document.addEventListener === 'function') {
            document.addEventListener('viewshow', handleRouteOrDomChange);
            document.addEventListener('pageshow', handleRouteOrDomChange);
            document.addEventListener('viewhide', handleRouteOrDomChange);
        }

        // MutationObserver to detect dynamic page changes
        var targetNode = (typeof document.getElementById === 'function' ? document.getElementById('mainContainer') : null) || (typeof document.body !== 'undefined' ? document.body : null);
        if (targetNode && typeof MutationObserver !== 'undefined') {
            var observerTimeout = null;
            var observer = new MutationObserver(function (mutations) {
                if (isDashboardPage()) {
                    var container = typeof document.getElementById === 'function' ? document.getElementById(CONTAINER_ID) : null;
                    var stockDevices = findStockDevicesSection();
                    if (!container || stockDevices) {
                        if (observerTimeout) clearTimeout(observerTimeout);
                        observerTimeout = setTimeout(function () {
                            if (isDashboardPage()) {
                                var inserted = ensureContainerInserted();
                                if (inserted && (state.activeSessions || state.allSessions)) {
                                    renderDashboardContainer(inserted, state.activeSessions, state.allSessions);
                                }
                                if (!state.isPolling) {
                                    startPolling();
                                }
                            }
                        }, 50);
                    }
                }
            });
            observer.observe(targetNode, { childList: true, subtree: true });
        }

        // Initial check
        handleRouteOrDomChange();
    }

    // Initialize in browser environment (avoid auto-running during Node.js tests)
    if (typeof document !== 'undefined' && typeof module === 'undefined') {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', init);
        } else {
            init();
        }
    }

    // Export for testing and global inspection
    var exportObj = {
        version: VERSION,
        state: state,
        isDashboardPage: isDashboardPage,
        findStockDevicesSection: findStockDevicesSection,
        ensureContainerInserted: ensureContainerInserted,
        renderSessionCard: renderSessionCard,
        calculateSessionCounts: calculateSessionCounts,
        renderDashboardContainer: renderDashboardContainer,
        formatTicks: formatTicks,
        formatRelativeTime: formatRelativeTime,
        renderConnectedDeviceItem: renderConnectedDeviceItem,
        extractResolutionPill: extractResolutionPill,
        extractDynamicRangePill: extractDynamicRangePill,
        extractAudioBadges: extractAudioBadges,
        extractSubtitleBadge: extractSubtitleBadge,
        extractTranscoderEngine: extractTranscoderEngine,
        formatTranscodeReason: formatTranscodeReason,
        getPlatformIconSvg: getPlatformIconSvg,
        startPolling: startPolling,
        stopPolling: stopPolling,
        pollSessions: pollSessions,
        init: init
    };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = exportObj;
    }
    if (typeof global !== 'undefined') {
        global.__playbackCardDashboardController = exportObj;
    }

})(typeof window !== 'undefined' ? window : globalThis);
