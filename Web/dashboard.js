/**
 * Playback Info Card - Primary Dashboard Integration (v0.2.4.0)
 * Completely replaces Jellyfin's standard stock Devices section on the default
 * Dashboard with the NOW PLAYING telemetry grid and active connected device telemetry.
 */

(function (global) {
    'use strict';

    var VERSION = '0.2.4.0';
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

    function extractTranscoderEngine(hwType, isVideoDirect) {
        // Hardware encoders only apply when video is actively transcoded (never for direct video / remux)
        if (isVideoDirect === true) return null;
        if (!hwType) return null;
        var hw = String(hwType).toLowerCase();
        if (hw === 'none' || hw === 'software' || hw === '0') return null;
        if (hw.indexOf('nvenc') !== -1 || hw.indexOf('cuda') !== -1) return 'NVENC';
        if (hw.indexOf('qsv') !== -1 || hw.indexOf('quicksync') !== -1) return 'QSV';
        if (hw.indexOf('vaapi') !== -1) return 'VAAPI';
        if (hw.indexOf('amf') !== -1 || hw.indexOf('vce') !== -1) return 'AMF';
        if (hw.indexOf('videotoolbox') !== -1) return 'VideoToolbox';
        return hwType;
    }

    function formatFrameRate(fps) {
        if (typeof fps !== 'number' || !isFinite(fps) || fps <= 0 || fps > 240) {
            return null;
        }
        if (Math.abs(fps - 23.976) < 0.005) return '23.976 fps';
        if (Math.abs(fps - 29.97) < 0.005) return '29.97 fps';
        if (Math.abs(fps - 59.94) < 0.005) return '59.94 fps';
        if (Math.abs(fps - Math.round(fps)) < 0.01) {
            return Math.round(fps) + ' fps';
        }
        var formatted = parseFloat(fps.toFixed(3));
        return formatted + ' fps';
    }

    function getTruthfulFrameRate(session, item, videoStream) {
        if (videoStream) {
            if (typeof videoStream.RealFrameRate === 'number' && isFinite(videoStream.RealFrameRate)) {
                var formattedReal = formatFrameRate(videoStream.RealFrameRate);
                if (formattedReal) return formattedReal;
            }
            if (typeof videoStream.AverageFrameRate === 'number' && isFinite(videoStream.AverageFrameRate)) {
                var formattedAvg = formatFrameRate(videoStream.AverageFrameRate);
                if (formattedAvg) return formattedAvg;
            }
        }
        var cand = (item && item.Framerate) || (session && session.Framerate);
        if (typeof cand === 'number' && isFinite(cand)) {
            var formattedCand = formatFrameRate(cand);
            if (formattedCand) return formattedCand;
        }
        var tInfo = session && session.TranscodingInfo;
        if (tInfo && typeof tInfo.Framerate === 'number' && isFinite(tInfo.Framerate)) {
            var formattedTInfo = formatFrameRate(tInfo.Framerate);
            if (formattedTInfo) return formattedTInfo;
        }
        return null;
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

    function getTruthfulTranscodeReasons(session) {
        if (!session || typeof session !== 'object') return null;
        var tInfo = session.TranscodingInfo;
        var raw = [];
        if (Array.isArray(session.TranscodeReasons) && session.TranscodeReasons.length > 0) {
            raw = session.TranscodeReasons;
        } else if (tInfo && Array.isArray(tInfo.TranscodeReasons) && tInfo.TranscodeReasons.length > 0) {
            raw = tInfo.TranscodeReasons;
        } else if (typeof session.TranscodeReasonsWhy === 'string' && session.TranscodeReasonsWhy.trim().length > 0) {
            return session.TranscodeReasonsWhy.trim();
        }

        var valid = raw.filter(function (r) {
            return r != null && String(r).trim().length > 0 && String(r) !== '0' && String(r).toLowerCase() !== 'none';
        });

        if (valid.length > 0) {
            return valid.map(formatTranscodeReason).join(', ');
        }
        return null;
    }

    function classifyPlaybackSession(session) {
        if (!session || typeof session !== 'object') {
            return {
                method: 'DirectPlay',
                badgeText: 'Direct Play',
                badgeClass: 'direct-play',
                isPaused: false,
                isVideoDirect: true,
                isAudioDirect: true,
                isRemux: false,
                isDirectStream: false,
                isTranscode: false
            };
        }

        var ps = session.PlayState || {};
        var isPaused = session.IsPaused != null ? Boolean(session.IsPaused) : Boolean(ps.IsPaused);
        var rawMethod = session.PlayMethod || ps.PlayMethod || 'DirectPlay';
        var tInfo = session.TranscodingInfo;
        var item = session.NowPlayingItem || {};

        var isVideoDirect = null;
        var isAudioDirect = null;

        if (typeof session.IsVideoDirect === 'boolean') isVideoDirect = session.IsVideoDirect;
        else if (tInfo && typeof tInfo.IsVideoDirect === 'boolean') isVideoDirect = tInfo.IsVideoDirect;
        else if (tInfo && rawMethod === 'Transcode') isVideoDirect = false;
        else if (rawMethod === 'DirectPlay') isVideoDirect = true;

        if (typeof session.IsAudioDirect === 'boolean') isAudioDirect = session.IsAudioDirect;
        else if (tInfo && typeof tInfo.IsAudioDirect === 'boolean') isAudioDirect = tInfo.IsAudioDirect;
        else if (rawMethod === 'DirectPlay') isAudioDirect = true;

        var containerChanged = Boolean(
            item.Container && tInfo && tInfo.Container &&
            item.Container.toLowerCase() !== tInfo.Container.toLowerCase()
        );

        // Remux: Video is Direct AND Audio is Direct, but container changed or explicit Remux
        var isRemux = Boolean(
            session.IsContainerRemux ||
            rawMethod === 'Remux' ||
            (isVideoDirect === true && isAudioDirect === true && (containerChanged || (tInfo && rawMethod === 'Transcode')))
        );

        var isDirectStream = (rawMethod === 'DirectStream' && !isRemux);

        var isTranscode = !isRemux && !isDirectStream && (
            rawMethod === 'Transcode' ||
            isVideoDirect === false ||
            isAudioDirect === false ||
            (tInfo && (tInfo.IsVideoDirect === false || tInfo.IsAudioDirect === false))
        );

        var method = 'DirectPlay';
        var badgeText = 'Direct Play';
        var badgeClass = 'direct-play';

        if (isPaused) {
            badgeClass = 'paused';
            badgeText = 'Paused';
        } else if (isRemux) {
            method = 'Remux';
            badgeText = 'Remux';
            badgeClass = 'remux';
        } else if (isDirectStream) {
            method = 'DirectStream';
            badgeText = 'Direct Stream';
            badgeClass = 'direct-stream';
        } else if (isTranscode) {
            method = 'Transcode';
            badgeText = 'Transcode';
            badgeClass = 'transcode';
        }

        return {
            method: method,
            badgeText: badgeText,
            badgeClass: badgeClass,
            isPaused: isPaused,
            isVideoDirect: isVideoDirect,
            isAudioDirect: isAudioDirect,
            isRemux: isRemux,
            isDirectStream: isDirectStream,
            isTranscode: isTranscode
        };
    }

    function isHdrToSdr(videoStream, tInfo) {
        if (!videoStream || !tInfo) return false;
        var hdr = extractDynamicRangePill(videoStream);
        if (!hdr) return false;
        if (tInfo.IsVideoDirect === false) {
            return true;
        }
        return false;
    }

    function resolveArtworkUrls(session, item, apiClient) {
        var posterUrl = '';
        var backdropUrl = '';
        if (!apiClient) return { posterUrl: posterUrl, backdropUrl: backdropUrl };

        var token = '';
        if (typeof apiClient.accessToken === 'function') token = apiClient.accessToken() || '';
        else if (apiClient.accessToken) token = String(apiClient.accessToken);

        var posterItemId = null;
        var posterTag = null;

        if (item && (item.SeriesPrimaryImageTag || (item.Type === 'Episode' && item.SeriesId))) {
            posterItemId = item.SeriesId || session.ItemId || item.Id;
            posterTag = item.SeriesPrimaryImageTag || session.PrimaryImageTag || item.PrimaryImageTag || null;
        } else {
            posterItemId = (session && session.ItemId) || (item && item.Id);
            posterTag = (session && session.PrimaryImageTag) || (item && item.PrimaryImageTag) || null;
        }

        if (posterItemId) {
            var pOpts = { type: 'Primary', maxWidth: 300, quality: 90 };
            if (posterTag) pOpts.tag = posterTag;
            if (token) pOpts.api_key = token;

            if (typeof apiClient.getImageUrl === 'function') {
                posterUrl = apiClient.getImageUrl(posterItemId, pOpts);
            } else if (typeof apiClient.getUrl === 'function') {
                posterUrl = apiClient.getUrl('Items/' + posterItemId + '/Images/Primary', pOpts);
            }
        }

        var backdropItemId = (session && session.ItemId) || (item && item.Id);
        var backdropTag = (item && item.BackdropImageTags && item.BackdropImageTags.length > 0)
            ? item.BackdropImageTags[0]
            : (item && item.SeriesBackdropImageTags && item.SeriesBackdropImageTags.length > 0 ? item.SeriesBackdropImageTags[0] : null);

        if (backdropItemId && backdropTag) {
            var bOpts = { type: 'Backdrop', maxWidth: 800, quality: 80, tag: backdropTag };
            if (token) bOpts.api_key = token;

            if (typeof apiClient.getImageUrl === 'function') {
                backdropUrl = apiClient.getImageUrl(backdropItemId, bOpts);
            } else if (typeof apiClient.getUrl === 'function') {
                backdropUrl = apiClient.getUrl('Items/' + backdropItemId + '/Images/Backdrop', bOpts);
            }
        }

        return { posterUrl: posterUrl, backdropUrl: backdropUrl };
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

    function isExcludedNavigation(el) {
        if (!el) return false;
        if (typeof el.closest === 'function') {
            return Boolean(el.closest('nav, aside, header, .MuiDrawer-root, .mainDrawer, .sidebar, [role="navigation"], .MuiAppBar-root, dialog, .MuiDialog-root, .header, #header'));
        }
        var cur = el;
        while (cur && cur !== document.body && cur !== document.documentElement) {
            var tag = (cur.tagName || '').toLowerCase();
            var cls = (cur.className || '').toString().toLowerCase();
            var role = (cur.getAttribute && cur.getAttribute('role')) || '';
            if (tag === 'nav' || tag === 'aside' || tag === 'header' || tag === 'dialog' ||
                cls.indexOf('muidrawer') !== -1 || cls.indexOf('maindrawer') !== -1 ||
                cls.indexOf('sidebar') !== -1 || cls.indexOf('muiappbar') !== -1 ||
                cls.indexOf('muidialog') !== -1 || role === 'navigation') {
                return true;
            }
            cur = cur.parentElement;
        }
        return false;
    }

    function getDashboardContentRoot() {
        if (typeof document === 'undefined') return null;
        if (typeof document.querySelector === 'function') {
            var activePage = document.querySelector('#dashboardPage:not(.hide), #devicesPage:not(.hide), .page.page-current:not(.hide), [data-role="page"].page-current:not(.hide), .page:not(.hide)');
            if (activePage && typeof activePage.querySelectorAll === 'function') {
                var content = (typeof activePage.querySelector === 'function')
                    ? (activePage.querySelector('.content-primary, [data-role="content"], main, [role="main"]') || activePage)
                    : activePage;
                if (content && typeof content.querySelectorAll === 'function') {
                    return content;
                }
            }
            var main = document.querySelector('main, [role="main"], #mainContainer');
            if (main && typeof main.querySelectorAll === 'function') return main;
        }
        return (typeof document.body !== 'undefined' && typeof document.body.querySelectorAll === 'function') ? document.body : document;
    }

    function findWidgetContainerFromTarget(targetNode, scope) {
        if (!targetNode) return null;
        if (isExcludedNavigation(targetNode)) return null;

        var cur = targetNode;
        var bestCandidate = null;

        while (cur && cur !== scope && cur !== document.body && cur !== document.documentElement) {
            var p = cur.parentElement || cur.parentNode;
            if (!p) break;

            var curCls = (cur.className || '').toString().toLowerCase();
            var curId = (cur.id || '').toString().toLowerCase();
            var pCls = (p.className || '').toString().toLowerCase();
            var pId = (p.id || '').toString().toLowerCase();

            var isTooBroad = curId === 'dashboardpage' ||
                             curId === 'devicespage' ||
                             curId === 'maincontainer' ||
                             curCls.indexOf('content-primary') !== -1 ||
                             cur.tagName === 'MAIN' ||
                             (typeof cur.getAttribute === 'function' && cur.getAttribute('role') === 'main');

            if (isTooBroad) {
                break;
            }

            var hasOtherWidgets = false;
            try {
                if (typeof cur.querySelectorAll === 'function') {
                    var otherWidgets = cur.querySelectorAll(
                        'a[href*="serverinfo"], a[href*="activity"], a[href*="tasks"], a[href*="logs"], a[href*="paths"], ' +
                        '[data-testid*="serverinfo"], [data-testid*="activity"], [data-testid*="task"]'
                    );
                    if (otherWidgets && otherWidgets.length > 0) {
                        hasOtherWidgets = true;
                    }
                    var otherHeadings = cur.querySelectorAll('h1, h2, h3, h4, .sectionTitle');
                    var nonDeviceHeadings = 0;
                    for (var h = 0; h < otherHeadings.length; h++) {
                        var hTxt = (otherHeadings[h].textContent || '').trim().toLowerCase();
                        if (hTxt && hTxt !== 'devices' && hTxt !== 'active devices') {
                            nonDeviceHeadings++;
                        }
                    }
                    if (nonDeviceHeadings > 0) {
                        hasOtherWidgets = true;
                    }
                }
            } catch (_) {}

            if (hasOtherWidgets) {
                break;
            }

            var isParentContainer = pCls.indexOf('muistack') !== -1 ||
                                    pCls.indexOf('muigrid') !== -1 ||
                                    pCls.indexOf('content-primary') !== -1 ||
                                    pCls.indexOf('verticalsection') !== -1 ||
                                    pCls.indexOf('dashboardsection') !== -1 ||
                                    pCls.indexOf('dashboardcontent') !== -1 ||
                                    pId === 'dashboardpage' ||
                                    pId === 'devicespage' ||
                                    pId === 'maincontainer' ||
                                    p.tagName === 'MAIN' ||
                                    (typeof p.getAttribute === 'function' && p.getAttribute('data-role') === 'content');

            if (isParentContainer) {
                return cur;
            }

            if (curCls.indexOf('verticalsection') !== -1 ||
                curCls.indexOf('dashboardsection') !== -1 ||
                curCls.indexOf('section') !== -1 ||
                curCls.indexOf('muipaper') !== -1 ||
                curCls.indexOf('muicard') !== -1) {
                bestCandidate = cur;
            }

            cur = cur.parentElement || cur.parentNode;
        }

        return bestCandidate || targetNode;
    }

    function findStockDevicesSection(root) {
        if (typeof document === 'undefined') return null;
        var scope = root || getDashboardContentRoot() || document;

        // If scope itself is the stock devices section
        if (scope && scope.id !== CONTAINER_ID && (scope.id === 'activeDevices' || (scope.className && scope.className.indexOf('activeDevices') !== -1))) {
            return scope;
        }

        // 1. Headings with exact text "devices" or "active devices" inside dashboard content
        var headings = (typeof scope.querySelectorAll === 'function')
            ? scope.querySelectorAll('h1, h2, h3, h4, h5, h6, .sectionTitle, [class*="sectionTitle"], [class*="Typography"]')
            : [];

        for (var j = 0; j < headings.length; j++) {
            var h = headings[j];
            if (typeof h.closest === 'function' && h.closest('#' + CONTAINER_ID)) continue;
            if (isExcludedNavigation(h)) continue;

            var text = (h.textContent || '').trim().toLowerCase();
            var i18n = typeof h.getAttribute === 'function' ? h.getAttribute('data-i18n-key') : null;
            if (text === 'devices' || text === 'active devices' || i18n === 'HeaderDevices') {
                var hContainer = findWidgetContainerFromTarget(h, scope);
                if (hContainer && hContainer.id !== CONTAINER_ID && !isExcludedNavigation(hContainer)) {
                    return hContainer;
                }
            }
        }

        // 2. Classic / legacy stock Jellyfin Devices selectors
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
            var el = (typeof scope.querySelector === 'function')
                ? scope.querySelector(selectors[i])
                : (typeof document.querySelector === 'function' ? document.querySelector(selectors[i]) : null);
            if (el && el.id !== CONTAINER_ID && !isExcludedNavigation(el)) {
                if (typeof el.closest === 'function' && el.closest('#' + CONTAINER_ID)) continue;
                var elContainer = findWidgetContainerFromTarget(el, scope);
                if (elContainer && elContainer.id !== CONTAINER_ID && !isExcludedNavigation(elContainer)) {
                    return elContainer;
                }
            }
        }

        // 3. Elements containing active stock device text (e.g. Chrome...Jellyfin Web, Safari iPhone, Moonfin)
        var deviceTextNodes = (typeof scope.querySelectorAll === 'function')
            ? scope.querySelectorAll('[class*="card"], [class*="Card"], [class*="device"], [class*="Device"], .paperList > div, [data-testid*="device"]')
            : [];
        for (var d = 0; d < deviceTextNodes.length; d++) {
            var dNode = deviceTextNodes[d];
            if (typeof dNode.closest === 'function' && dNode.closest('#' + CONTAINER_ID)) continue;
            if (isExcludedNavigation(dNode)) continue;
            var dText = (dNode.textContent || '').trim();
            if (/Chrome.*Jellyfin Web|Safari.*iPhone|Moonfin/i.test(dText)) {
                var dContainer = findWidgetContainerFromTarget(dNode, scope);
                if (dContainer && dContainer.id !== CONTAINER_ID && !isExcludedNavigation(dContainer)) {
                    return dContainer;
                }
            }
        }

        // 4. In-page links/buttons to devices (that are inside the dashboard main content, not in nav/drawer)
        var deviceLinks = (typeof scope.querySelectorAll === 'function')
            ? scope.querySelectorAll('a[href*="dashboard/devices"], a[href$="/devices"], a[href*="#/devices"], a[href*="#/dashboard/devices"], button[to*="devices"], a[to*="devices"]')
            : [];

        for (var l = 0; l < deviceLinks.length; l++) {
            var link = deviceLinks[l];
            if (typeof link.closest === 'function' && link.closest('#' + CONTAINER_ID)) continue;
            if (isExcludedNavigation(link)) continue;

            var lContainer = findWidgetContainerFromTarget(link, scope);
            if (lContainer && lContainer.id !== CONTAINER_ID && !isExcludedNavigation(lContainer)) {
                return lContainer;
            }
        }

        return null;
    }

    function cleanupLingeringStockDevices(container) {
        if (typeof document === 'undefined') return;
        try {
            var root = getDashboardContentRoot() || document;
            if (typeof root.querySelectorAll !== 'function') return;
            var lingeringHeadings = root.querySelectorAll('h1, h2, h3, h4, h5, h6, .sectionTitle, [class*="sectionTitle"]');
            for (var i = 0; i < lingeringHeadings.length; i++) {
                var h = lingeringHeadings[i];
                if (isExcludedNavigation(h)) continue;
                if (container && (h === container || (typeof container.contains === 'function' && container.contains(h)))) continue;
                var text = (h.textContent || '').trim().toLowerCase();
                if (text === 'devices' || text === 'active devices') {
                    var p = h.parentElement;
                    if (p && p !== document.body && p !== root && (!p.id || p.id.indexOf('Page') === -1)) {
                        p.style.display = 'none';
                        if (p.parentNode) p.parentNode.removeChild(p);
                    } else {
                        h.style.display = 'none';
                        if (h.parentNode) h.parentNode.removeChild(h);
                    }
                }
            }
        } catch (_) {}
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

            // In-place replacement of the stock Devices widget
            if (typeof devicesSection.replaceWith === 'function') {
                devicesSection.replaceWith(existing);
            } else if (devicesSection.parentNode) {
                devicesSection.parentNode.insertBefore(existing, devicesSection);
                devicesSection.parentNode.removeChild(devicesSection);
            }

            // Ensure stock devices section is completely hidden and removed
            devicesSection.style.display = 'none';
            if (devicesSection.parentNode) {
                devicesSection.parentNode.removeChild(devicesSection);
            }

            // Cleanup any remaining stock device headings or cards outside our container
            cleanupLingeringStockDevices(existing);

            return existing;
        }

        // If existing is already mounted and no stock devices section is found
        if (existing && existing.parentNode) {
            cleanupLingeringStockDevices(existing);
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
            var playState = session.PlayState || {};
            var tInfo = session.TranscodingInfo;

            // Media Streams extraction
            var mediaStreams = item.MediaStreams || [];
            var videoStream = null;
            var audioStream = null;
            for (var i = 0; i < mediaStreams.length; i++) {
                if (!videoStream && mediaStreams[i].Type === 'Video') videoStream = mediaStreams[i];
                if (!audioStream && mediaStreams[i].Type === 'Audio') audioStream = mediaStreams[i];
            }

            // Title, Subtitle, Season/Episode metadata
            var title = '';
            var subtitle = '';
            var isEpisode = (item.Type === 'Episode' || Boolean(session.SeriesName || item.SeriesName));

            if (isEpisode) {
                title = escapeHtml(session.SeriesName || item.SeriesName || session.MediaTitle || item.Name || 'Unknown Series');
                var epParts = [];
                var sNum = session.SeasonNumber != null ? session.SeasonNumber : item.ParentIndexNumber;
                var eNum = session.EpisodeNumber != null ? session.EpisodeNumber : item.IndexNumber;
                if (sNum != null && eNum != null) {
                    epParts.push('S' + sNum + ':E' + eNum);
                } else if (sNum != null) {
                    epParts.push('Season ' + sNum);
                } else if (eNum != null) {
                    epParts.push('Ep ' + eNum);
                }

                var epTitle = item.Name || session.MediaTitle;
                if (epTitle && epTitle !== title) {
                    epParts.push('"' + escapeHtml(epTitle) + '"');
                }

                var year = session.ProductionYear || item.ProductionYear;
                if (year) {
                    epParts.push(String(year));
                }
                subtitle = epParts.join(' &bull; ');
            } else {
                title = escapeHtml(session.MediaTitle || item.Name || 'Unknown Media');
                var yearVal = session.ProductionYear || item.ProductionYear;
                if (yearVal) {
                    subtitle = escapeHtml(String(yearVal));
                }
            }

            // Unified Classification
            var classification = classifyPlaybackSession(session);
            var isPaused = classification.isPaused;
            var badgeClass = classification.badgeClass;
            var badgeText = classification.badgeText;
            var isVideoDirect = classification.isVideoDirect;
            var isAudioDirect = classification.isAudioDirect;

            var stateIcon = '<svg class="badge-icon" viewBox="0 0 24 24"><polygon points="5 3 19 12 5 21 5 3"/></svg>';
            if (isPaused) {
                stateIcon = '<svg class="badge-icon" viewBox="0 0 24 24"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>';
            }

            var videoBadgeText = (isVideoDirect === true) ? 'Video: Direct' : (isVideoDirect === false ? 'Video: Transcode' : 'Video: Direct');
            var videoBadgeCls = (isVideoDirect === false) ? 'stream-badge video-transcode' : 'stream-badge video-direct';

            var audioBadgeText = (isAudioDirect === true) ? 'Audio: Direct' : (isAudioDirect === false ? 'Audio: Transcode' : 'Audio: Direct');
            var audioBadgeCls = (isAudioDirect === false) ? 'stream-badge audio-transcode' : 'stream-badge audio-direct';

            // Top essential badges
            var pills = [];
            var resPill = extractResolutionPill(item.Width || (videoStream && videoStream.Width), item.Height || (videoStream && videoStream.Height));
            if (resPill) pills.push({ text: resPill, cls: 'res' });

            pills.push({ text: badgeText, cls: '' });

            var vCodec = session.VideoCodec || (tInfo && tInfo.VideoCodec) || (videoStream && videoStream.Codec ? videoStream.Codec.toUpperCase() : '');
            if (vCodec) {
                if (vCodec === 'H264' || vCodec === 'h264') vCodec = 'H.264';
                else if (vCodec === 'HEVC' || vCodec === 'hevc') vCodec = 'HEVC';
                pills.push({ text: vCodec, cls: '' });
            }

            var audioBadges = extractAudioBadges(audioStream);
            if (audioBadges.length > 0) {
                pills.push({ text: audioBadges[0], cls: 'audio' });
            }

            var containerVal = (session.Container || (tInfo && tInfo.Container) || item.Container || '').toUpperCase();
            if (containerVal) {
                pills.push({ text: containerVal, cls: '' });
            }

            // Extended mode badges
            if (displayMode === 'extended') {
                var hdrPill = extractDynamicRangePill(videoStream);
                if (hdrPill) pills.push({ text: hdrPill, cls: 'hdr' });

                if (audioBadges.length > 1) {
                    pills.push({ text: audioBadges[1], cls: 'audio' });
                }

                var subBadge = extractSubtitleBadge(session, item);
                if (subBadge) pills.push({ text: subBadge, cls: 'sub' });
            }

            // Maximum five badges on compact/narrow screens
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

            // Truthful telemetry fields
            var sourceVideoCodec = (videoStream && videoStream.Codec) ? videoStream.Codec.toUpperCase() : (session.VideoCodec ? session.VideoCodec.toUpperCase() : null);
            var outputVideoCodec = (tInfo && tInfo.VideoCodec) ? tInfo.VideoCodec.toUpperCase() : (isVideoDirect === true ? sourceVideoCodec : null);

            var sourceAudioCodec = (audioStream && audioStream.Codec) ? audioStream.Codec.toUpperCase() : (session.AudioCodec ? session.AudioCodec.toUpperCase() : null);
            var outputAudioCodec = (tInfo && tInfo.AudioCodec) ? tInfo.AudioCodec.toUpperCase() : (isAudioDirect === true ? sourceAudioCodec : null);

            var sourceResolution = (item.Width && item.Height) ? (item.Width + 'x' + item.Height) : ((videoStream && videoStream.Width && videoStream.Height) ? (videoStream.Width + 'x' + videoStream.Height) : null);
            var outputResolution = (tInfo && tInfo.Width && tInfo.Height) ? (tInfo.Width + 'x' + tInfo.Height) : (session.Resolution || (isVideoDirect === true ? sourceResolution : null));

            var frameRateStr = getTruthfulFrameRate(session, item, videoStream);

            var rawHw = tInfo ? tInfo.HardwareAccelerationType : session.TranscodeEngine;
            var hardwareEngineStr = extractTranscoderEngine(rawHw, isVideoDirect);

            var bitrateStr = null;
            if (tInfo && typeof tInfo.Bitrate === 'number' && isFinite(tInfo.Bitrate) && tInfo.Bitrate > 0) {
                bitrateStr = (tInfo.Bitrate / 1000000).toFixed(1) + ' Mbps';
            } else if (videoStream && typeof videoStream.BitRate === 'number' && isFinite(videoStream.BitRate) && videoStream.BitRate > 0) {
                bitrateStr = (videoStream.BitRate / 1000000).toFixed(1) + ' Mbps';
            }

            var sourceContainer = (item.Container || session.Container || containerVal || '').toUpperCase() || null;
            var outputContainer = (tInfo && tInfo.Container) ? tInfo.Container.toUpperCase() : (classification.isRemux ? (tInfo && tInfo.Container ? tInfo.Container.toUpperCase() : null) : (isVideoDirect === true && isAudioDirect === true ? sourceContainer : null));

            var containerConversionHtml = '';
            if (item.Container && tInfo && tInfo.Container && item.Container.toLowerCase() !== tInfo.Container.toLowerCase()) {
                containerConversionHtml = escapeHtml(item.Container.toUpperCase()) + ' &rarr; ' + escapeHtml(tInfo.Container.toUpperCase());
            } else if (containerVal) {
                containerConversionHtml = escapeHtml(containerVal);
            }

            var serverReasons = getTruthfulTranscodeReasons(session);

            // Extended mode inline summary row (only truthful values, no fabricated QSV or 2191 fps)
            var metaParts = [];
            if (hardwareEngineStr) metaParts.push('Engine: ' + escapeHtml(hardwareEngineStr));
            if (outputVideoCodec || sourceVideoCodec) metaParts.push('Video: ' + escapeHtml(outputVideoCodec || sourceVideoCodec));
            if (outputAudioCodec || sourceAudioCodec) metaParts.push('Audio: ' + escapeHtml(outputAudioCodec || sourceAudioCodec));
            if (containerConversionHtml) metaParts.push('Container: ' + containerConversionHtml);
            if (outputResolution) metaParts.push('Resolution: ' + escapeHtml(outputResolution));
            if (frameRateStr) metaParts.push(escapeHtml(frameRateStr));
            if (bitrateStr) metaParts.push('Bitrate: ' + escapeHtml(bitrateStr));

            var cardWhyHtml = '';
            if (serverReasons) {
                cardWhyHtml = '<div class="playback-details-row playback-transcode-reasons"><strong>Why:</strong> ' + escapeHtml(serverReasons) + '</div>';
            } else if (classification.method === 'Transcode') {
                cardWhyHtml = '<div class="playback-details-row playback-transcode-reasons"><strong>Why:</strong> Reason not reported by server</div>';
            }

            // Info Drawer Complete 22-Field Technical Breakdown
            var hdrStatus = extractDynamicRangePill(videoStream) || 'SDR';
            var hdrToSdrVal = isHdrToSdr(videoStream, tInfo) ? 'Active (Tone mapping)' : 'Not reported';
            var audioChannelsLayout = (audioStream && (audioStream.ChannelLayout || (audioStream.Channels ? (audioStream.Channels + ' ch') : null))) || null;

            var gridRows = [
                { key: 'User', val: escapeHtml(session.UserName || 'Not reported') },
                { key: 'Client', val: escapeHtml(session.Client || 'Not reported') },
                { key: 'Client Version', val: session.ApplicationVersion ? ('v' + escapeHtml(session.ApplicationVersion)) : 'Not reported' },
                { key: 'Device', val: escapeHtml(session.DeviceName || session.Client || 'Not reported') },
                { key: 'Playback State', val: isPaused ? 'Paused' : 'Playing' },
                { key: 'Playback Method', val: escapeHtml(classification.badgeText) },
                { key: 'Video Status', val: isVideoDirect === true ? 'Direct' : (isVideoDirect === false ? 'Transcode' : 'Not reported') },
                { key: 'Video Source Codec', val: escapeHtml(sourceVideoCodec || 'Not reported') },
                { key: 'Video Output Codec', val: escapeHtml(outputVideoCodec || (isVideoDirect === true ? (sourceVideoCodec || 'Direct (Source Codec)') : 'Not reported')) },
                { key: 'Source Resolution', val: escapeHtml(sourceResolution || 'Not reported') },
                { key: 'Output Resolution', val: escapeHtml(outputResolution || (isVideoDirect === true ? (sourceResolution || 'Direct') : 'Not reported')) },
                { key: 'Frame Rate', val: escapeHtml(frameRateStr || 'Not reported') },
                { key: 'HDR Status', val: escapeHtml(hdrStatus) },
                { key: 'HDR to SDR Conversion', val: escapeHtml(hdrToSdrVal) },
                { key: 'Audio Status', val: isAudioDirect === true ? 'Direct' : (isAudioDirect === false ? 'Transcode' : 'Not reported') },
                { key: 'Audio Source Codec', val: escapeHtml(sourceAudioCodec || 'Not reported') },
                { key: 'Audio Output Codec', val: escapeHtml(outputAudioCodec || (isAudioDirect === true ? (sourceAudioCodec || 'Direct (Source Codec)') : 'Not reported')) },
                { key: 'Audio Channel Layout', val: escapeHtml(audioChannelsLayout || 'Not reported') },
                { key: 'Source Container', val: escapeHtml(sourceContainer || 'Not reported') },
                { key: 'Output Container', val: escapeHtml(outputContainer || (isVideoDirect === true && isAudioDirect === true ? (sourceContainer || 'Direct') : 'Not reported')) },
                { key: 'Bitrate', val: escapeHtml(bitrateStr || 'Not reported') },
                { key: 'Hardware Engine', val: escapeHtml(hardwareEngineStr || 'Not reported') },
                { key: 'Transcode Reason', val: escapeHtml(serverReasons || 'Reason not reported by server'), fullWidth: true }
            ];

            var gridRowsHtml = gridRows.map(function (row) {
                return '<div class="playback-info-row' + (row.fullWidth ? ' full-width' : '') + '">' +
                    '<span class="playback-info-key">' + escapeHtml(row.key) + '</span>' +
                    '<span class="playback-info-val">' + row.val + '</span>' +
                '</div>';
            }).join('');

            var isDrawerOpen = (displayMode === 'extended') || Boolean(showAllDetails);
            var infoBtnHtml = '<button type="button" class="playback-btn-info" data-action="toggle-info" aria-expanded="' + (isDrawerOpen ? 'true' : 'false') + '" aria-controls="' + detailsDomId + '" id="btn-info-' + cardDomId + '" title="Toggle technical stream details">' +
                '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg> Info</button>';

            var detailsPanelHtml = '<div id="' + detailsDomId + '" class="playback-details-panel' + (isDrawerOpen ? ' open' : '') + '" role="region" aria-label="Stream Details">' +
                '<div class="playback-drawer-header">' +
                    '<div class="playback-drawer-title-wrap">' +
                        '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>' +
                        '<span class="playback-drawer-title">Technical Stream Details</span>' +
                    '</div>' +
                    '<button type="button" class="playback-drawer-close" data-action="close-info" aria-label="Close details">&times;</button>' +
                '</div>' +
                '<div class="playback-stream-badges">' +
                    '<span class="' + videoBadgeCls + '">' + escapeHtml(videoBadgeText) + '</span>' +
                    '<span class="' + audioBadgeCls + '">' + escapeHtml(audioBadgeText) + '</span>' +
                '</div>' +
                (metaParts.length > 0 ? '<div class="playback-details-row playback-extended-summary"><strong>Stream:</strong> ' + metaParts.join(' &bull; ') + '</div>' : '') +
                cardWhyHtml +
                '<div class="playback-info-grid">' +
                    gridRowsHtml +
                '</div>' +
            '</div>';

            // Artwork
            var apiClient = getApiClient();
            var art = resolveArtworkUrls(session, item, apiClient);
            var posterUrl = art.posterUrl;
            var backdropUrl = art.backdropUrl;

            var backdropStyle = backdropUrl ? ' style="background-image: url(\'' + escapeHtml(backdropUrl) + '\');"' : '';
            var posterHtml = '';
            if (posterUrl) {
                posterHtml = '<img class="playback-poster" src="' + escapeHtml(posterUrl) + '" alt="' + title + '" onerror="this.parentNode.innerHTML=\'<div class=\\\'playback-poster-fallback\\\' aria-label=\\\'No artwork\\\'><svg viewBox=\\\'0 0 24 24\\\' width=\\\'24\\\' height=\\\'24\\\' fill=\\\'none\\\' stroke=\\\'currentColor\\\' stroke-width=\\\'1.5\\\'><rect x=\\\'2\\\' y=\\\'3\\\' width=\\\'20\\\' height=\\\'18\\\' rx=\\\'3\\\' stroke=\\\'currentColor\\\'/><path d=\\\'M7 3v18M17 3v18M2 9h20M2 15h20\\\' stroke=\\\'currentColor\\\'/></svg></div>\';" />';
            } else {
                state.artworkFallbackCount++;
                posterHtml = '<div class="playback-poster-fallback" aria-label="No artwork"><svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="3" width="20" height="18" rx="3" stroke="currentColor"/><path d="M7 3v18M17 3v18M2 9h20M2 15h20" stroke="currentColor"/></svg></div>';
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
        var counts = { total: Array.isArray(sessions) ? sessions.length : 0, directPlay: 0, remux: 0, directStream: 0, transcode: 0, paused: 0 };
        if (!Array.isArray(sessions)) return counts;
        for (var i = 0; i < sessions.length; i++) {
            var c = classifyPlaybackSession(sessions[i]);
            if (c.isPaused) {
                counts.paused++;
            } else if (c.method === 'Remux') {
                counts.remux++;
            } else if (c.method === 'DirectStream') {
                counts.directStream++;
            } else if (c.method === 'Transcode') {
                counts.transcode++;
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
                    (counts.remux > 0 ? '<span class="playback-count-chip count-remux"><span class="count-val">' + counts.remux + '</span> Remux</span>' : '') +
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
        if (!container) return;
        if (typeof container.getAttribute === 'function' && container.getAttribute('data-events-attached') === 'true') return;
        if (typeof container.setAttribute === 'function') container.setAttribute('data-events-attached', 'true');
        if (typeof container.addEventListener !== 'function') return;

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
                            var closeBtn = panel.querySelector('[data-action="close-info"]');
                            if (closeBtn && typeof closeBtn.focus === 'function') {
                                closeBtn.focus();
                            }
                        }
                    }
                }
                return;
            }

            // Close single card info drawer via close button
            var drawerCloseBtn = target.closest('[data-action="close-info"]');
            if (drawerCloseBtn) {
                var panelToClose = drawerCloseBtn.closest('.playback-details-panel');
                if (panelToClose) {
                    panelToClose.classList.remove('open');
                    var panelId = panelToClose.id;
                    var trig = container.querySelector('[aria-controls="' + panelId + '"]');
                    if (trig) {
                        trig.setAttribute('aria-expanded', 'false');
                        if (typeof trig.focus === 'function') trig.focus();
                    }
                }
                return;
            }
        });

        // Global Escape key listener to close drawer and restore focus
        if (typeof document !== 'undefined' && !container._playbackEscBound) {
            container._playbackEscBound = true;
            document.addEventListener('keydown', function (e) {
                if (e.key === 'Escape' || e.key === 'Esc' || e.keyCode === 27) {
                    var openPanels = container.querySelectorAll('.playback-details-panel.open');
                    for (var i = 0; i < openPanels.length; i++) {
                        var p = openPanels[i];
                        p.classList.remove('open');
                        var trigBtn = container.querySelector('[aria-controls="' + p.id + '"]');
                        if (trigBtn) {
                            trigBtn.setAttribute('aria-expanded', 'false');
                            if (typeof trigBtn.focus === 'function') trigBtn.focus();
                        }
                    }
                }
            });
        }
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
        isExcludedNavigation: isExcludedNavigation,
        getDashboardContentRoot: getDashboardContentRoot,
        findStockDevicesSection: findStockDevicesSection,
        cleanupLingeringStockDevices: cleanupLingeringStockDevices,
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
        classifyPlaybackSession: classifyPlaybackSession,
        formatFrameRate: formatFrameRate,
        getTruthfulFrameRate: getTruthfulFrameRate,
        getTruthfulTranscodeReasons: getTruthfulTranscodeReasons,
        isHdrToSdr: isHdrToSdr,
        resolveArtworkUrls: resolveArtworkUrls,
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
