/**
 * Playback Info Card - Primary Dashboard Integration (v0.2.5.0)
 * Completely replaces Jellyfin's standard stock Devices section on the default
 * Dashboard with the NOW PLAYING telemetry grid and active connected device telemetry.
 */

(function (global) {
    'use strict';

    var VERSION = '0.2.5.0';
    var ASSET_REVISION = '0.2.5.0';
    var CONTAINER_ID = 'playback-card-nowplaying-container';
    var DRAWER_OVERLAY_ID = 'playback-drawer-overlay';
    var DRAWER_PANEL_ID = 'playback-drawer-panel';
    var POLL_INTERVAL_MS = 3000;
    var DRAWER_MISSING_POLL_TOLERANCE = 2;

    var state = {
        version: VERSION,
        assetRevision: ASSET_REVISION,
        activeSessions: [],
        allSessions: [],
        displayMode: 'compact', // compact (default) | extended
        showAllDetails: false,
        pollTimer: null,
        isPolling: false,
        isDashboardActive: false,
        isNonAdmin: false,
        artworkFallbackCount: 0,
        renderErrors: 0,
        cardSessionMap: {},
        drawer: {
            open: false,
            sessionId: null,
            cardDomId: null,
            missingPolls: 0,
            lastFocusEl: null
        }
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

    // Like extractDynamicRangePill, but also surfaces an explicit "SDR" badge when a video
    // stream is known and genuinely not HDR/DV/HLG (never guessed when no stream is known at all).
    function extractDynamicRangeCompactPill(videoStream) {
        var pill = extractDynamicRangePill(videoStream);
        if (pill) return pill;
        return videoStream ? 'SDR' : '';
    }

    function extractBitDepthPill(videoStream) {
        if (!videoStream || !videoStream.BitDepth) return '';
        var bitDepth = Number(videoStream.BitDepth);
        if (!bitDepth || bitDepth <= 0) return '';
        return bitDepth + '-bit';
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

    function extractAtmosBadge(audioStream) {
        if (!audioStream) return '';
        var text = ((audioStream.Profile || '') + ' ' + (audioStream.Title || '') + ' ' + (audioStream.DisplayTitle || '')).toLowerCase();
        if (text.indexOf('atmos') !== -1) return 'Atmos';
        if (text.indexOf('dts:x') !== -1 || text.indexOf('dts-x') !== -1 || text.indexOf('dtsx') !== -1) return 'DTS:X';
        return '';
    }

    function extractAudioLanguage(audioStream) {
        if (!audioStream || !audioStream.Language) return '';
        var lang = String(audioStream.Language).toUpperCase();
        return lang.length > 3 ? lang.substring(0, 3) : lang;
    }

    // Estimated finish time, computed from real remaining playback duration -- never
    // shown for a paused session (there is no true ETA while paused).
    function formatEta(remainingTicks, nowMs) {
        if (typeof remainingTicks !== 'number' || !isFinite(remainingTicks) || remainingTicks <= 0) return null;
        var finish = new Date((typeof nowMs === 'number' ? nowMs : Date.now()) + Math.round(remainingTicks / 10000));
        var hours = finish.getHours();
        var minutes = finish.getMinutes();
        var ampm = hours >= 12 ? 'PM' : 'AM';
        var hours12 = hours % 12;
        if (hours12 === 0) hours12 = 12;
        var paddedMinutes = minutes < 10 ? '0' + minutes : String(minutes);
        return hours12 + ':' + paddedMinutes + ' ' + ampm;
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
            'DirectPlayError': 'Direct playback error occurred',
            'ContainerBitrateExceedsLimit': 'Container bitrate exceeds client network profile limit',
            'AudioBitrateNotSupported': 'Audio bitrate exceeds client decoder capabilities',
            'AudioChannelsNotSupported': 'Audio channel layout exceeds playback target'
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

        // The underlying method is independent of pause state -- a paused Remux is still
        // a Remux. badgeText/badgeClass (the legacy combined display value) still collapse
        // to "Paused" when paused; callers that need the pure method (e.g. the card's
        // separate state/method badges) must read `method`, not `badgeText`.
        var method = 'DirectPlay';
        if (isRemux) method = 'Remux';
        else if (isDirectStream) method = 'DirectStream';
        else if (isTranscode) method = 'Transcode';

        var badgeText = 'Direct Play';
        var badgeClass = 'direct-play';

        if (isPaused) {
            badgeClass = 'paused';
            badgeText = 'Paused';
        } else if (isRemux) {
            badgeText = 'Remux';
            badgeClass = 'remux';
        } else if (isDirectStream) {
            badgeText = 'Direct Stream';
            badgeClass = 'direct-stream';
        } else if (isTranscode) {
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

    // The user's own Jellyfin profile avatar (their own chosen image on their own server --
    // not an external service). Feature-detects the API since this is best-effort polish,
    // never a required field; returns '' whenever anything is missing or unsupported.
    function resolveUserAvatarUrl(session, apiClient) {
        if (!session || !apiClient || !session.UserId) return '';
        if (typeof apiClient.getUserImageUrl !== 'function') return '';
        try {
            var opts = { type: 'Primary', maxWidth: 64, quality: 90 };
            if (session.UserPrimaryImageTag) opts.tag = session.UserPrimaryImageTag;
            return apiClient.getUserImageUrl(session.UserId, opts) || '';
        } catch (_) {
            return '';
        }
    }

    function resolveArtworkUrls(session, item, apiClient) {
        var posterUrl = '';
        var backdropUrl = '';
        if (!apiClient) return { posterUrl: posterUrl, backdropUrl: backdropUrl };

        var token = '';
        if (typeof apiClient.accessToken === 'function') token = apiClient.accessToken() || '';
        else if (apiClient.accessToken) token = String(apiClient.accessToken);

        function buildImageUrl(itemId, opts) {
            if (!itemId) return '';
            if (typeof apiClient.getImageUrl === 'function') return apiClient.getImageUrl(itemId, opts) || '';
            if (typeof apiClient.getUrl === 'function') return apiClient.getUrl('Items/' + itemId + '/Images/' + opts.type, opts) || '';
            return '';
        }

        // Poster resolution chain: item ID + primary image tag -> primary image item ID
        // -> series ID + series image tag (episode-to-series fallback) -> session-level tag.
        var posterItemId = null;
        var posterTag = null;

        if (item && item.PrimaryImageTag && item.Id) {
            posterItemId = item.Id;
            posterTag = item.PrimaryImageTag;
        } else if (item && item.PrimaryImageItemId) {
            posterItemId = item.PrimaryImageItemId;
            posterTag = item.PrimaryImageTag || null;
        } else if (item && (item.SeriesPrimaryImageTag || (item.Type === 'Episode' && item.SeriesId))) {
            posterItemId = item.SeriesId || (session && session.ItemId) || item.Id;
            posterTag = item.SeriesPrimaryImageTag || (session && session.PrimaryImageTag) || item.PrimaryImageTag || null;
        } else {
            posterItemId = (session && session.ItemId) || (item && item.Id);
            posterTag = (session && session.PrimaryImageTag) || (item && item.PrimaryImageTag) || null;
        }

        if (posterItemId) {
            var pOpts = { type: 'Primary', maxWidth: 300, quality: 90 };
            if (posterTag) pOpts.tag = posterTag;
            if (token) pOpts.api_key = token;
            posterUrl = buildImageUrl(posterItemId, pOpts);
        }

        // Backdrop resolution chain: item backdrop tags -> parent backdrop ID + tags
        // -> series backdrop tags (episode-to-series fallback). ID and tag always resolved together.
        var backdropItemId = null;
        var backdropTag = null;

        if (item && item.BackdropImageTags && item.BackdropImageTags.length > 0) {
            backdropItemId = (session && session.ItemId) || item.Id;
            backdropTag = item.BackdropImageTags[0];
        } else if (item && item.ParentBackdropItemId && item.ParentBackdropImageTags && item.ParentBackdropImageTags.length > 0) {
            backdropItemId = item.ParentBackdropItemId;
            backdropTag = item.ParentBackdropImageTags[0];
        } else if (item && item.SeriesId && item.SeriesBackdropImageTags && item.SeriesBackdropImageTags.length > 0) {
            backdropItemId = item.SeriesId;
            backdropTag = item.SeriesBackdropImageTags[0];
        }

        if (backdropItemId && backdropTag) {
            var bOpts = { type: 'Backdrop', maxWidth: 800, quality: 80, tag: backdropTag };
            if (token) bOpts.api_key = token;
            backdropUrl = buildImageUrl(backdropItemId, bOpts);
        }

        return { posterUrl: posterUrl, backdropUrl: backdropUrl };
    }

    // Real, locally-bundled brand-colored SVG glyphs (no CDN, no emoji, no runtime fetches).
    var BRAND_SVG = {
        jellyfinWeb: '<svg viewBox="0 0 24 24" width="20" height="20"><rect x="2" y="4" width="20" height="13" rx="2" fill="none" stroke="#00A4DC" stroke-width="2"/><path d="M9 20h6M12 17v3" stroke="#00A4DC" stroke-width="2" fill="none"/><circle cx="12" cy="10.5" r="3" fill="#00A4DC"/></svg>',
        jellyfinMobile: '<svg viewBox="0 0 24 24" width="20" height="20"><rect x="6" y="2" width="12" height="20" rx="2" fill="none" stroke="#00A4DC" stroke-width="2"/><circle cx="12" cy="17.5" r="1.3" fill="#00A4DC"/><circle cx="12" cy="9" r="2.6" fill="#00A4DC"/></svg>',
        jellyfinTv: '<svg viewBox="0 0 24 24" width="20" height="20"><rect x="2" y="3" width="20" height="14" rx="2" fill="none" stroke="#00A4DC" stroke-width="2"/><path d="M8 21h8M12 17v4" stroke="#00A4DC" stroke-width="2"/><circle cx="12" cy="10" r="3" fill="#00A4DC"/></svg>',
        jellyfinDesktop: '<svg viewBox="0 0 24 24" width="20" height="20"><rect x="2" y="4" width="20" height="12" rx="1" fill="none" stroke="#00A4DC" stroke-width="2"/><path d="M8 20h8M12 16v4" stroke="#00A4DC" stroke-width="2"/><circle cx="12" cy="10" r="2.5" fill="#00A4DC"/></svg>',
        chrome: '<svg viewBox="0 0 24 24" width="20" height="20"><circle cx="12" cy="12" r="9" fill="none" stroke="#EA4335" stroke-width="6" stroke-dasharray="18.84 37.7" transform="rotate(-90 12 12)"/><circle cx="12" cy="12" r="9" fill="none" stroke="#34A853" stroke-width="6" stroke-dasharray="18.84 37.7" stroke-dashoffset="-18.84" transform="rotate(-90 12 12)"/><circle cx="12" cy="12" r="9" fill="none" stroke="#FBBC05" stroke-width="6" stroke-dasharray="18.84 37.7" stroke-dashoffset="-37.68" transform="rotate(-90 12 12)"/><circle cx="12" cy="12" r="4" fill="#4285F4" stroke="#fff" stroke-width="1"/></svg>',
        edge: '<svg viewBox="0 0 24 24" width="20" height="20"><circle cx="12" cy="12" r="10" fill="#0078D7"/><path d="M4 13c2-5 8-7 12-4-3-1-7 0-8 4-1 3 1 6 5 6 2 0 4-1 5-3-1 4-5 6-9 5-4-1-6-5-5-8z" fill="#00B7C3"/></svg>',
        firefox: '<svg viewBox="0 0 24 24" width="20" height="20"><circle cx="12" cy="12" r="10" fill="#FF9500"/><path d="M12 4c3 3 1 5 3 7 1 1 2 3 1 5-1 3-4 4-6 3 2 0 3-2 2-4-1 2-3 2-4 1-2-1-2-3-1-5 1 1 2 1 3 0-2-2-2-5 2-7z" fill="#D6270C"/></svg>',
        safari: '<svg viewBox="0 0 24 24" width="20" height="20"><circle cx="12" cy="12" r="10" fill="#fff"/><circle cx="12" cy="12" r="10" fill="none" stroke="#3fa4dc" stroke-width="1.5"/><polygon points="12,4 14.2,12 12,12" fill="#ff3b30"/><polygon points="12,4 9.8,12 12,12" fill="#e2e2e2"/><polygon points="12,20 9.8,12 12,12" fill="#c7c7c7"/><polygon points="12,20 14.2,12 12,12" fill="#8e8e93"/></svg>',
        brave: '<svg viewBox="0 0 24 24" width="20" height="20"><path d="M12 2l7 3v6c0 5-3 8.5-7 11-4-2.5-7-6-7-11V5z" fill="#FB542B"/><path d="M12 5l4 1.7v4.3c0 3-1.7 5.3-4 6.8-2.3-1.5-4-3.8-4-6.8V6.7z" fill="#fff" opacity="0.85"/></svg>',
        android: '<svg viewBox="0 0 24 24" width="20" height="20" fill="#3ddc84"><path d="M17.523 15.3414c-.5511 0-.9993-.4486-.9993-1.0003 0-.5516.4482-.9998.9993-.9998.5516 0 .9997.4482.9997.9998 0 .5517-.4481 1.0003-.9997 1.0003m-11.046 0c-.5511 0-.9993-.4486-.9993-1.0003 0-.5516.4482-.9998.9993-.9998.5516 0 .9998.4482.9998.9998 0 .5517-.4482 1.0003-.9998 1.0003m11.4045-6.02l1.9973-3.4592a.416.416 0 00-.1521-.5676.416.416 0 00-.5676.1521l-2.0223 3.503C15.5902 8.4114 13.8533 8.167 12 8.167c-1.8533 0-3.5902.2444-5.1367.783L4.841 5.447a.416.416 0 00-.5676-.1521.416.416 0 00-.1521.5676l1.9973 3.4592C2.6889 11.1867.3432 14.6589 0 18.761h24c-.3432-4.1021-2.6889-7.5743-6.1185-9.4396" transform="translate(0,1) scale(0.85)"/></svg>',
        androidTv: '<svg viewBox="0 0 24 24" width="20" height="20" fill="#3ddc84"><path d="M21 3H3c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h5v2h8v-2h5c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 14H3V5h18v12z"/></svg>',
        apple: '<svg viewBox="0 0 24 24" width="20" height="20" fill="#a2aaad"><path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.81-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M15.97 6.37c.62-.75 1.04-1.8 0.92-2.85-.9.04-1.98.6-2.62 1.35-.57.65-1.07 1.72-.94 2.74 1 .08 2.02-.49 2.64-1.24z"/></svg>',
        windows: '<svg viewBox="0 0 24 24" width="20" height="20" fill="#00a4ef"><path d="M0 3.449L9.75 2.1v9.451H0m10.949-9.602L24 0v11.4H10.949M0 12.6h9.75v9.451L0 20.699M10.949 12.6H24V24l-12.95-1.801"/></svg>',
        roku: '<svg viewBox="0 0 24 24" width="20" height="20" fill="#6c3c97"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 14H9v-4.5H7.5V10H11v6zm4.5 0h-2V8h2c1.66 0 3 1.34 3 3s-1.34 3-3 3zm0-4h-1v2h1c.55 0 1-.45 1-1s-.45-1-1-1z"/></svg>',
        firetv: '<svg viewBox="0 0 24 24" width="20" height="20"><circle cx="12" cy="12" r="10" fill="#232F3E"/><path d="M12 5c2 3 0 4 2 6 1 1 1 3 0 4-1 2-3 2-4 1 1 0 2-1 1-2-1 2-3 1-3-1 0-2 1-3 2-4-1 0-1-1 0-2 0 0 1-1 2-2z" fill="#FF9900"/></svg>',
        chromecast: '<svg viewBox="0 0 24 24" width="20" height="20"><rect x="2" y="4" width="20" height="14" rx="2" fill="none" stroke="#9e9e9e" stroke-width="1.5"/><path d="M6 15a6 6 0 0 1 6-6" stroke="#4285F4" stroke-width="2" fill="none"/><path d="M6 15a9 9 0 0 1 9-9" stroke="#34A853" stroke-width="2" fill="none" opacity="0.9"/><circle cx="6" cy="15" r="1.6" fill="#EA4335"/></svg>',
        appletv: '<svg viewBox="0 0 24 24" width="20" height="20"><rect x="2" y="5" width="20" height="12" rx="2" fill="#1d1d1f"/><circle cx="12" cy="11" r="3.2" fill="#fff"/></svg>',
        tizen: '<svg viewBox="0 0 24 24" width="20" height="20"><circle cx="12" cy="12" r="10" fill="#1428A0"/><ellipse cx="12" cy="12" rx="7" ry="4" fill="#fff"/><ellipse cx="12" cy="12" rx="3" ry="4" fill="#1428A0"/></svg>',
        webos: '<svg viewBox="0 0 24 24" width="20" height="20"><circle cx="12" cy="12" r="10" fill="#A50034"/><circle cx="12" cy="12" r="5.5" fill="none" stroke="#fff" stroke-width="2"/><circle cx="17" cy="9" r="1.5" fill="#fff"/></svg>',
        xbox: '<svg viewBox="0 0 24 24" width="20" height="20"><circle cx="12" cy="12" r="10" fill="#107C10"/><path d="M8 7c2 2 3 3.5 4 5 1-1.5 2-3 4-5 1.5 1 2.5 3 2.5 5-2-3-3.5-2-4.5-1-1 1-1.5 1.5-2 2-.5-.5-1-1-2-2-1-1-2.5-2-4.5 1 0-2 1-4 2.5-5z" fill="#fff"/></svg>',
        playstation: '<svg viewBox="0 0 24 24" width="20" height="20"><circle cx="12" cy="12" r="10" fill="#003791"/><path d="M9 6.5v11l2-.7V8.3c0-.4.2-.6.6-.4.5.2.5.7.5 1.1v3.7c1.6.7 3-.1 3-1.9 0-2-1.4-3-3.4-3.7-1-.4-2-.6-2.7-.6zM15 15.5l2.5-.9c.7-.2.8-.6.2-.9l-2.7-1v1l1.3.5c.2.1.2.3 0 .3l-1.3.5v.5z" fill="#fff"/></svg>',
        dlna: '<svg viewBox="0 0 24 24" width="20" height="20"><circle cx="12" cy="5" r="2" fill="#8a8a8a"/><circle cx="5" cy="18" r="2" fill="#8a8a8a"/><circle cx="19" cy="18" r="2" fill="#8a8a8a"/><path d="M12 7v6M12 13 6 16M12 13l6 3" stroke="#8a8a8a" stroke-width="1.5" fill="none"/></svg>',
        swiftfin: '<svg viewBox="0 0 24 24" width="20" height="20"><circle cx="12" cy="12" r="10" fill="#0b1f3a"/><path d="M6 14c3 1 6 1 9-1-1 3-4 5-7 4.5C5.5 17 4.5 15 6 14z" fill="#FF6B57"/><path d="M8 9c3-2 7-2 10 0-2-.5-5 0-6.5 2C10 12.5 8.5 13 7 12.5 6 11.5 6.5 10 8 9z" fill="#34AADC"/></svg>',
        finamp: '<svg viewBox="0 0 24 24" width="20" height="20"><circle cx="12" cy="12" r="10" fill="#1DB5A6"/><path d="M14 6v8.2a2.6 2.6 0 1 1-1.5-2.4V9l-3 .7v6.2A2.6 2.6 0 1 1 8 13.5V8.5l6-1.4z" fill="#fff"/></svg>',
        findroid: '<svg viewBox="0 0 24 24" width="20" height="20"><circle cx="12" cy="12" r="10" fill="#0F9D58"/><polygon points="9,7.5 17,12 9,16.5" fill="#fff"/></svg>',
        streamyfin: '<svg viewBox="0 0 24 24" width="20" height="20"><circle cx="12" cy="12" r="10" fill="#8B5CF6"/><polygon points="9.5,7.5 17,12 9.5,16.5" fill="#fff"/><circle cx="12" cy="12" r="10" fill="none" stroke="#EC4899" stroke-width="1"/></svg>',
        moonfin: '<svg viewBox="0 0 24 24" width="20" height="20"><circle cx="12" cy="12" r="10" fill="#312E81"/><path d="M14.5 6.5A6 6 0 1 0 14.5 17.5 7 7 0 1 1 14.5 6.5z" fill="#C7D2FE"/></svg>',
        infuse: '<svg viewBox="0 0 24 24" width="20" height="20"><circle cx="12" cy="12" r="10" fill="#1173D4"/><polygon points="9.5,7.5 17,12 9.5,16.5" fill="#fff"/></svg>',
        kodi: '<svg viewBox="0 0 24 24" width="20" height="20"><circle cx="12" cy="12" r="10" fill="#17B2E7"/><path d="M8 7v10M8 12l5-5v5l-5 5" stroke="#fff" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
        generic: '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M20 3H4c-1.1 0-2 .9-2 2v11c0 1.1.9 2 2 2h3l-1 2v1h12v-1l-1-2h3c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 13H4V5h16v11z"/></svg>'
    };

    function detectBrowserBrand(str) {
        if (!str) return null;
        if (str.indexOf('edg') !== -1) return { key: 'edge', label: 'Edge', svg: BRAND_SVG.edge };
        if (str.indexOf('brave') !== -1) return { key: 'brave', label: 'Brave', svg: BRAND_SVG.brave };
        if (str.indexOf('firefox') !== -1) return { key: 'firefox', label: 'Firefox', svg: BRAND_SVG.firefox };
        if (str.indexOf('chrome') !== -1) return { key: 'chrome', label: 'Chrome', svg: BRAND_SVG.chrome };
        if (str.indexOf('safari') !== -1) return { key: 'safari', label: 'Safari', svg: BRAND_SVG.safari };
        return null;
    }

    /**
     * Resolves the correct locally-bundled brand icon for a session.
     * Priority: exact Jellyfin application -> browser -> streaming/device platform -> operating system -> neutral fallback.
     * Accepts either resolveClientBrand({client, deviceName, appVersion}) or legacy positional (clientName, deviceName).
     */
    function resolveClientBrand(input, legacyDeviceName) {
        var clientName = '';
        var deviceName = '';
        if (typeof input === 'object' && input !== null) {
            clientName = input.client || input.clientName || '';
            deviceName = input.deviceName || '';
        } else {
            clientName = input || '';
            deviceName = legacyDeviceName || '';
        }

        var c = String(clientName).toLowerCase();
        var d = String(deviceName).toLowerCase();
        var combined = (c + ' ' + d).trim();

        function brand(key, label, svg) { return { key: key, label: label, svg: svg }; }

        // 1. Exact third-party Jellyfin-application identity (overrides generic OS identity)
        if (c.indexOf('swiftfin') !== -1) return brand('swiftfin', 'Swiftfin', BRAND_SVG.swiftfin);
        if (c.indexOf('finamp') !== -1) return brand('finamp', 'Finamp', BRAND_SVG.finamp);
        if (c.indexOf('findroid') !== -1) return brand('findroid', 'Findroid', BRAND_SVG.findroid);
        if (c.indexOf('streamyfin') !== -1) return brand('streamyfin', 'Streamyfin', BRAND_SVG.streamyfin);
        if (c.indexOf('moonfin') !== -1 || d.indexOf('moonfin') !== -1) return brand('moonfin', 'Moonfin', BRAND_SVG.moonfin);
        if (c.indexOf('infuse') !== -1) return brand('infuse', 'Infuse', BRAND_SVG.infuse);
        if (c.indexOf('kodi') !== -1) return brand('kodi', 'Kodi', BRAND_SVG.kodi);

        // 1b. Official Jellyfin clients (exact application identity, then sub-variant, then browser override for Web)
        if (c.indexOf('jellyfin') !== -1) {
            if (combined.indexOf('android tv') !== -1 || combined.indexOf('androidtv') !== -1 || d.indexOf('shield') !== -1) {
                return brand('jellyfin-androidtv', 'Jellyfin Android TV', BRAND_SVG.jellyfinTv);
            }
            if (c.indexOf('android') !== -1) return brand('jellyfin-android', 'Jellyfin Android', BRAND_SVG.jellyfinMobile);
            // "Jellyfin Web" is unambiguous from the client name alone -- resolve it (and its
            // browser override) BEFORE any device-name-based iOS/tvOS heuristics, since a web
            // session's device name is the browser/platform string (e.g. "Safari iPhone") and
            // must never be mistaken for the native Jellyfin iOS app.
            if (c.indexOf('web') !== -1) {
                var webBrowser = detectBrowserBrand(d);
                if (webBrowser) return webBrowser;
                return brand('jellyfin-web', 'Jellyfin Web', BRAND_SVG.jellyfinWeb);
            }
            if (c.indexOf('tvos') !== -1 || combined.indexOf('apple tv') !== -1) return brand('jellyfin-tvos', 'Jellyfin tvOS', BRAND_SVG.jellyfinTv);
            if (c.indexOf('ios') !== -1) return brand('jellyfin-ios', 'Jellyfin iOS', BRAND_SVG.jellyfinMobile);
            if (c.indexOf('media player') !== -1 || c.indexOf('desktop') !== -1 || c.indexOf('jmp') !== -1) {
                return brand('jellyfin-desktop', 'Jellyfin Media Player', BRAND_SVG.jellyfinDesktop);
            }
            return brand('jellyfin', 'Jellyfin', BRAND_SVG.jellyfinWeb);
        }

        // 3. Streaming / TV device platforms
        if (combined.indexOf('roku') !== -1) return brand('roku', 'Roku', BRAND_SVG.roku);
        if (combined.indexOf('fire tv') !== -1 || combined.indexOf('firetv') !== -1) return brand('firetv', 'Fire TV', BRAND_SVG.firetv);
        if (combined.indexOf('chromecast') !== -1 || combined.indexOf('google tv') !== -1) return brand('chromecast', 'Chromecast', BRAND_SVG.chromecast);
        if (combined.indexOf('apple tv') !== -1) return brand('appletv', 'Apple TV', BRAND_SVG.appletv);
        if (combined.indexOf('tizen') !== -1 || combined.indexOf('samsung') !== -1) return brand('tizen', 'Samsung Tizen', BRAND_SVG.tizen);
        if (combined.indexOf('webos') !== -1 || combined.indexOf(' lg ') !== -1 || combined.indexOf(' lg') !== -1) return brand('webos', 'LG webOS', BRAND_SVG.webos);
        if (combined.indexOf('xbox') !== -1) return brand('xbox', 'Xbox', BRAND_SVG.xbox);
        if (combined.indexOf('playstation') !== -1 || combined.indexOf('ps4') !== -1 || combined.indexOf('ps5') !== -1) return brand('playstation', 'PlayStation', BRAND_SVG.playstation);
        if (combined.indexOf('dlna') !== -1) return brand('dlna', 'DLNA', BRAND_SVG.dlna);

        // 2. Browser (generic/third-party web clients not identified as "Jellyfin Web")
        var browser = detectBrowserBrand(combined);
        if (browser) return browser;

        // 4. Operating system fallback
        if (combined.indexOf('android tv') !== -1 || combined.indexOf('androidtv') !== -1) return brand('androidtv', 'Android TV', BRAND_SVG.androidTv);
        if (combined.indexOf('android') !== -1) return brand('android', 'Android', BRAND_SVG.android);
        if (combined.indexOf('ios') !== -1 || combined.indexOf('iphone') !== -1 || combined.indexOf('ipad') !== -1 || combined.indexOf('apple') !== -1) return brand('apple', 'Apple', BRAND_SVG.apple);
        if (combined.indexOf('windows') !== -1) return brand('windows', 'Windows', BRAND_SVG.windows);

        // 5. Neutral fallback
        return brand('generic', 'Media Client', BRAND_SVG.generic);
    }

    function getPlatformIconSvg(clientName, deviceName) {
        return resolveClientBrand({ client: clientName, deviceName: deviceName }).svg;
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
            if (typeof existing.setAttribute === 'function') {
                existing.setAttribute('data-playback-card-root', 'true');
                existing.setAttribute('data-plugin-version', VERSION);
                existing.setAttribute('data-asset-revision', ASSET_REVISION);
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
            if (typeof existing.setAttribute === 'function') {
                existing.setAttribute('data-playback-card-root', 'true');
                existing.setAttribute('data-plugin-version', VERSION);
                existing.setAttribute('data-asset-revision', ASSET_REVISION);
            }
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

            var clientBrand = resolveClientBrand({ client: session.Client, deviceName: session.DeviceName });
            var platformIconSvg = clientBrand.svg;

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

            // Unified Classification. classification.method is the pure transcode method
            // (DirectPlay/DirectStream/Remux/Transcode), never overridden by pause -- the
            // Playing/Paused state is shown as its own separate badge alongside it.
            var classification = classifyPlaybackSession(session);
            var isPaused = classification.isPaused;
            var isVideoDirect = classification.isVideoDirect;
            var isAudioDirect = classification.isAudioDirect;

            var METHOD_LABELS = { DirectPlay: 'Direct Play', DirectStream: 'Direct Stream', Remux: 'Remux', Transcode: 'Transcode' };
            var METHOD_BADGE_CLASSES = { DirectPlay: 'direct-play', DirectStream: 'direct-stream', Remux: 'remux', Transcode: 'transcode' };
            var methodLabel = METHOD_LABELS[classification.method] || 'Direct Play';
            var methodBadgeCls = METHOD_BADGE_CLASSES[classification.method] || 'direct-play';
            var stateLabel = isPaused ? 'Paused' : 'Playing';
            var stateBadgeCls = isPaused ? 'paused' : 'playing';

            var stateIcon = '<svg class="badge-icon" viewBox="0 0 24 24"><polygon points="5 3 19 12 5 21 5 3"/></svg>';
            if (isPaused) {
                stateIcon = '<svg class="badge-icon" viewBox="0 0 24 24"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>';
            }

            var videoBadgeCls = (isVideoDirect === false) ? 'stream-badge video-transcode' : 'stream-badge video-direct';
            var audioBadgeCls = (isAudioDirect === false) ? 'stream-badge audio-transcode' : 'stream-badge audio-direct';

            // Compact badge priority (section 11): Resolution, HDR/Dynamic range, Method,
            // Video codec, Bit depth, Audio format/channels, Container -- always shown,
            // wrapping onto additional lines on narrow screens rather than being cut off.
            var pills = [];
            var resPill = extractResolutionPill(item.Width || (videoStream && videoStream.Width), item.Height || (videoStream && videoStream.Height));
            if (resPill) pills.push({ text: resPill, cls: 'res' });

            var dynRangePill = extractDynamicRangeCompactPill(videoStream);
            if (dynRangePill) pills.push({ text: dynRangePill, cls: 'hdr' });

            pills.push({ text: methodLabel, cls: methodBadgeCls });

            var vCodec = session.VideoCodec || (tInfo && tInfo.VideoCodec) || (videoStream && videoStream.Codec ? videoStream.Codec.toUpperCase() : '');
            if (vCodec) {
                if (vCodec === 'H264' || vCodec === 'h264') vCodec = 'H.264';
                else if (vCodec === 'HEVC' || vCodec === 'hevc') vCodec = 'HEVC';
                pills.push({ text: vCodec, cls: '' });
            }

            var bitDepthPill = extractBitDepthPill(videoStream);
            if (bitDepthPill) pills.push({ text: bitDepthPill, cls: '' });

            var audioBadges = extractAudioBadges(audioStream);
            if (audioBadges.length > 0) {
                pills.push({ text: audioBadges[0], cls: 'audio' });
            }

            var atmosPill = extractAtmosBadge(audioStream);
            if (atmosPill) pills.push({ text: atmosPill, cls: 'audio' });

            var containerVal = (session.Container || (tInfo && tInfo.Container) || item.Container || '').toUpperCase();
            if (containerVal) {
                pills.push({ text: containerVal, cls: '' });
            }

            // Extended mode adds any further, less-essential badges (section 11).
            if (displayMode === 'extended') {
                if (audioBadges.length > 1) {
                    pills.push({ text: audioBadges[1], cls: 'audio' });
                }

                var subBadge = extractSubtitleBadge(session, item);
                if (subBadge) pills.push({ text: subBadge, cls: 'sub' });
            }

            var pillHtml = pills.map(function (p) {
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

            // Canonical telemetry model (section 8) -- single source of truth shared with
            // the "Show Details" grid below and the singleton Info drawer, so all three
            // always agree.
            var model = buildTelemetryModel(session);

            // Extended mode: icon-led summary rows (section 11), truthful values only --
            // Reason/Engine read "Not applicable" (never a fabricated value) outside Transcode.
            var extendedRowsHtml = '';
            if (displayMode === 'extended') {
                var videoDetail = [
                    (model.sourceVideoCodec || model.outputVideoCodec) ? escapeHtml((model.sourceVideoCodec || '?') + ' → ' + (model.outputVideoCodec || model.sourceVideoCodec || '?')) : null,
                    (model.sourceResolution || model.outputResolution) ? escapeHtml((model.sourceResolution || '?') + ' → ' + (model.outputResolution || model.sourceResolution || '?')) : null,
                    model.frameRateStr ? escapeHtml(model.frameRateStr) : null
                ].filter(Boolean).join('<span class="playback-ext-sep">&bull;</span>');

                var audioDetail = [
                    (model.sourceAudioCodec || model.outputAudioCodec) ? escapeHtml((model.sourceAudioCodec || '?') + ' → ' + (model.outputAudioCodec || model.sourceAudioCodec || '?')) : null,
                    model.audioChannelsLayout ? escapeHtml(model.audioChannelsLayout) : null
                ].filter(Boolean).join('<span class="playback-ext-sep">&bull;</span>');

                var containerDetail = (model.sourceContainer || model.outputContainer)
                    ? escapeHtml((model.sourceContainer || '?') + ' → ' + (model.outputContainer || model.sourceContainer || '?'))
                    : 'Not reported';
                if (model.overallBitrateStr) containerDetail += '<span class="playback-ext-sep">&bull;</span>Overall bitrate: ' + escapeHtml(model.overallBitrateStr);

                extendedRowsHtml = '<div class="playback-ext-rows">' +
                    '<div class="playback-ext-row"><span class="playback-ext-label">Video</span><span class="' + videoBadgeCls + '">' + escapeHtml(model.isVideoDirect === false ? 'Transcode' : 'Direct') + '</span><span class="playback-ext-detail">' + (videoDetail || 'Not reported') + '</span></div>' +
                    '<div class="playback-ext-row"><span class="playback-ext-label">Audio</span><span class="' + audioBadgeCls + '">' + escapeHtml(model.isAudioDirect === false ? 'Transcode' : 'Direct') + '</span><span class="playback-ext-detail">' + (audioDetail || 'Not reported') + '</span></div>' +
                    '<div class="playback-ext-row"><span class="playback-ext-label">Subtitles</span><span class="playback-ext-detail">' + escapeHtml(model.subtitleField || 'Not active') + '</span></div>' +
                    '<div class="playback-ext-row"><span class="playback-ext-label">Container</span><span class="playback-ext-detail">' + containerDetail + '</span></div>' +
                    '<div class="playback-ext-row"><span class="playback-ext-label">HDR</span><span class="playback-ext-detail">' + escapeHtml(model.hdrStatus || 'Not reported') + '<span class="playback-ext-sep">&bull;</span>Tone mapping: ' + escapeHtml(model.hdrToSdrVal) + '</span></div>' +
                    '<div class="playback-ext-row"><span class="playback-ext-label">Engine</span><span class="playback-ext-detail">' + escapeHtml(model.hardwareEngineStr || (classification.method === 'Transcode' ? 'Not reported' : 'Not applicable')) + '</span></div>' +
                    '<div class="playback-ext-row"><span class="playback-ext-label">Reason</span><span class="playback-ext-detail">' + escapeHtml(model.serverReasons || (classification.method === 'Transcode' ? 'Reason not reported by server' : 'Not applicable')) + '</span></div>' +
                '</div>';
            }

            // "Show Details" (global toggle, section 10): the full per-field grid, same
            // canonical fields as the Info drawer minus the identity rows already in the header.
            var showDetailsGridHtml = showAllDetails ? buildInlineDetailGridHtml(model) : '';

            var isSummaryOpen = (displayMode === 'extended') || Boolean(showAllDetails);
            var detailsPanelHtml = '<div id="' + detailsDomId + '" class="playback-details-panel' + (isSummaryOpen ? ' open' : '') + '" role="region" aria-label="Stream Details">' +
                extendedRowsHtml +
                showDetailsGridHtml +
            '</div>';

            // Info button: opens the singleton modal Info drawer (section 14), never an inline panel.
            state.cardSessionMap = state.cardSessionMap || {};
            state.cardSessionMap[cardDomId] = session.Id || null;
            // Compared by stable session ID, not the positional cardDomId -- if session
            // ordering shifts while the drawer is open, the highlighted Info button must
            // still track the actual open session, not whichever card now sits in that slot.
            var infoIsOpenForThisCard = Boolean(state.drawer && state.drawer.open && session.Id && state.drawer.sessionId === session.Id);
            var infoBtnHtml = '<button type="button" class="playback-btn-info" data-action="toggle-info" data-card-id="' + escapeHtml(cardDomId) + '" aria-haspopup="dialog" aria-expanded="' + (infoIsOpenForThisCard ? 'true' : 'false') + '" aria-controls="playback-drawer-panel" id="btn-info-' + cardDomId + '" title="View full technical stream details">' +
                '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg> Info</button>';

            // Artwork
            var apiClient = getApiClient();
            var userAvatarUrl = resolveUserAvatarUrl(session, apiClient);
            var userAvatarHtml = userAvatarUrl
                ? '<img class="playback-user-avatar" src="' + escapeHtml(userAvatarUrl) + '" alt="" onerror="this.remove()" />'
                : '';
            var art = resolveArtworkUrls(session, item, apiClient);
            var posterUrl = art.posterUrl;
            var backdropUrl = art.backdropUrl;

            var backdropStyle = backdropUrl ? ' style="background-image: url(\'' + escapeHtml(backdropUrl) + '\');"' : '';
            var posterHtml = '';
            if (posterUrl) {
                posterHtml = '<img class="playback-poster" data-artwork-role="poster" src="' + escapeHtml(posterUrl) + '" alt="' + title + '" onerror="this.parentNode.innerHTML=\'<div class=\\\'playback-poster-fallback\\\' data-artwork-role=\\\'poster-fallback\\\' aria-label=\\\'No artwork\\\'><svg viewBox=\\\'0 0 24 24\\\' width=\\\'24\\\' height=\\\'24\\\' fill=\\\'none\\\' stroke=\\\'currentColor\\\' stroke-width=\\\'1.5\\\'><rect x=\\\'2\\\' y=\\\'3\\\' width=\\\'20\\\' height=\\\'18\\\' rx=\\\'3\\\' stroke=\\\'currentColor\\\'/><path d=\\\'M7 3v18M17 3v18M2 9h20M2 15h20\\\' stroke=\\\'currentColor\\\'/></svg></div>\';" />';
            } else {
                state.artworkFallbackCount++;
                posterHtml = '<div class="playback-poster-fallback" data-artwork-role="poster-fallback" aria-label="No artwork"><svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="3" width="20" height="18" rx="3" stroke="currentColor"/><path d="M7 3v18M17 3v18M2 9h20M2 15h20" stroke="currentColor"/></svg></div>';
            }

            return '<div class="playback-card" data-card-id="' + escapeHtml(cardDomId) + '" data-playback-card="true" data-playback-method="' + escapeHtml(classification.method) + '">' +
                '<div class="playback-card-backdrop" data-artwork-role="backdrop"' + backdropStyle + '></div>' +
                '<div class="playback-card-inner">' +
                    '<div class="playback-card-header">' +
                        '<div class="playback-card-user-group">' +
                            '<span class="playback-platform-icon" data-client-brand="' + escapeHtml(clientBrand.key) + '" title="' + client + '">' + platformIconSvg + '</span>' +
                            '<div class="playback-card-user-info">' +
                                '<div class="playback-card-user">' + userAvatarHtml + user + '</div>' +
                                '<div class="playback-card-client">' + clientDevice + '</div>' +
                            '</div>' +
                        '</div>' +
                        '<div class="playback-badge-group">' +
                            '<span class="playback-badge state-badge ' + stateBadgeCls + '">' + stateIcon + ' ' + escapeHtml(stateLabel) + '</span>' +
                            '<span class="playback-badge ' + methodBadgeCls + '">' + escapeHtml(methodLabel) + '</span>' +
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
                            (model.etaText ? '<span class="playback-eta">ETA ' + escapeHtml(model.etaText) + '</span>' : '') +
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

    function slugifyFieldKey(key) {
        return String(key).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-+|-+$)/g, '');
    }

    function formatBitrate(bitsPerSecond) {
        if (typeof bitsPerSecond !== 'number' || !isFinite(bitsPerSecond) || bitsPerSecond <= 0) return null;
        if (bitsPerSecond >= 1000000) return (bitsPerSecond / 1000000).toFixed(1) + ' Mbps';
        return Math.round(bitsPerSecond / 1000) + ' kbps';
    }

    /**
     * Canonical telemetry model (section 8): normalizes a session exactly once so the
     * Info drawer's full 26-field breakdown always agrees with the card/header.
     */
    function buildTelemetryModel(session) {
        var item = (session && session.NowPlayingItem) || {};
        var playStateM = (session && session.PlayState) || {};
        var tInfo = session && session.TranscodingInfo;

        var mediaStreams = item.MediaStreams || [];
        var videoStream = null;
        var audioStream = null;
        for (var i = 0; i < mediaStreams.length; i++) {
            if (!videoStream && mediaStreams[i].Type === 'Video') videoStream = mediaStreams[i];
            if (!audioStream && mediaStreams[i].Type === 'Audio') audioStream = mediaStreams[i];
        }

        var classification = classifyPlaybackSession(session);
        var isPaused = classification.isPaused;
        var isVideoDirect = classification.isVideoDirect;
        var isAudioDirect = classification.isAudioDirect;

        var sourceVideoCodec = (videoStream && videoStream.Codec) ? videoStream.Codec.toUpperCase() : ((session && session.VideoCodec) ? session.VideoCodec.toUpperCase() : null);
        var outputVideoCodec = (tInfo && tInfo.VideoCodec) ? tInfo.VideoCodec.toUpperCase() : (isVideoDirect === true ? sourceVideoCodec : null);

        var sourceAudioCodec = (audioStream && audioStream.Codec) ? audioStream.Codec.toUpperCase() : ((session && session.AudioCodec) ? session.AudioCodec.toUpperCase() : null);
        var outputAudioCodec = (tInfo && tInfo.AudioCodec) ? tInfo.AudioCodec.toUpperCase() : (isAudioDirect === true ? sourceAudioCodec : null);

        var sourceResolution = (item.Width && item.Height) ? (item.Width + 'x' + item.Height) : ((videoStream && videoStream.Width && videoStream.Height) ? (videoStream.Width + 'x' + videoStream.Height) : null);
        var outputResolution = (tInfo && tInfo.Width && tInfo.Height) ? (tInfo.Width + 'x' + tInfo.Height) : ((session && session.Resolution) || (isVideoDirect === true ? sourceResolution : null));

        var frameRateStr = getTruthfulFrameRate(session, item, videoStream);

        var rawHw = tInfo ? tInfo.HardwareAccelerationType : (session && session.TranscodeEngine);
        var hardwareEngineStr = extractTranscoderEngine(rawHw, isVideoDirect);

        var containerVal = ((session && session.Container) || (tInfo && tInfo.Container) || item.Container || '').toUpperCase();
        var sourceContainer = (item.Container || (session && session.Container) || containerVal || '').toUpperCase() || null;
        var outputContainer = (tInfo && tInfo.Container) ? tInfo.Container.toUpperCase() : (isVideoDirect === true && isAudioDirect === true ? sourceContainer : null);

        var videoBitrateStr = formatBitrate(videoStream && videoStream.BitRate);
        var audioBitrateStr = formatBitrate(audioStream && audioStream.BitRate);
        var overallBitrateStr = formatBitrate(tInfo && tInfo.Bitrate) ||
            ((videoStream && videoStream.BitRate) || (audioStream && audioStream.BitRate)
                ? formatBitrate((videoStream && videoStream.BitRate || 0) + (audioStream && audioStream.BitRate || 0))
                : null);

        var serverReasons = getTruthfulTranscodeReasons(session);
        var hdrStatus = extractDynamicRangePill(videoStream) || (videoStream ? 'SDR' : null);
        var hdrToSdrVal = isHdrToSdr(videoStream, tInfo) ? 'Active (Tone mapping)' : 'Not reported';
        var audioLanguage = extractAudioLanguage(audioStream);
        var atmosBadge = extractAtmosBadge(audioStream);
        var audioChannelsLayout = (audioStream && (audioStream.ChannelLayout || (audioStream.Channels ? (audioStream.Channels + ' ch') : null))) || null;
        if (audioChannelsLayout && audioLanguage) audioChannelsLayout = audioLanguage + ' ' + audioChannelsLayout;

        // Subtitle delivery method (Encode/Embed/External/Hls) is real, server-reported data --
        // burned-in ("Encode") subtitles are a genuine, common reason a video gets transcoded
        // even when its codec is otherwise compatible, so this is surfaced as fact, not guessed.
        var DELIVERY_METHOD_LABELS = { Encode: 'Burned into video (forces transcode)', Embed: 'Embedded', External: 'External file', Hls: 'Segmented (HLS)', Drop: 'Dropped' };
        var subIndex = (playStateM.SubtitleStreamIndex != null) ? playStateM.SubtitleStreamIndex : ((session && session.SubtitleStreamIndex != null) ? session.SubtitleStreamIndex : -1);
        var subtitleField = null;
        if (subIndex !== -1 && subIndex != null) {
            for (var s = 0; s < mediaStreams.length; s++) {
                if (mediaStreams[s].Type === 'Subtitle' && (mediaStreams[s].Index === subIndex || subIndex === -2)) {
                    var subS = mediaStreams[s];
                    var subTitle = (subS.Title || subS.DisplayTitle || '').toLowerCase();
                    var isCC = Boolean(subS.IsHearingImpaired) || subTitle.indexOf('sdh') !== -1 || subTitle.indexOf('cc') !== -1;
                    var subLabel = subS.DisplayTitle || subS.Language || 'Subtitle';
                    subtitleField = (isCC ? 'Closed Captions' : subLabel) + (subS.Codec ? ' (' + String(subS.Codec).toUpperCase() + ')' : '');
                    var deliveryLabel = subS.DeliveryMethod ? DELIVERY_METHOD_LABELS[subS.DeliveryMethod] : null;
                    if (deliveryLabel) subtitleField += ' — ' + deliveryLabel;
                    break;
                }
            }
        }

        // ETA: real wall-clock estimate from remaining runtime, never shown while paused.
        var positionTicks = (typeof session.PositionTicks === 'number' && isFinite(session.PositionTicks)) ? session.PositionTicks
            : ((typeof playStateM.PositionTicks === 'number' && isFinite(playStateM.PositionTicks)) ? playStateM.PositionTicks : 0);
        var runtimeTicks = (typeof session.RunTimeTicks === 'number' && isFinite(session.RunTimeTicks)) ? session.RunTimeTicks
            : ((typeof item.RunTimeTicks === 'number' && isFinite(item.RunTimeTicks)) ? item.RunTimeTicks : 0);
        var etaText = (!isPaused && runtimeTicks > positionTicks) ? formatEta(runtimeTicks - positionTicks) : null;

        var clientBrand = resolveClientBrand({ client: session && session.Client, deviceName: session && session.DeviceName });

        return {
            session: session,
            item: item,
            tInfo: tInfo,
            videoStream: videoStream,
            audioStream: audioStream,
            classification: classification,
            isPaused: isPaused,
            isVideoDirect: isVideoDirect,
            isAudioDirect: isAudioDirect,
            sourceVideoCodec: sourceVideoCodec,
            outputVideoCodec: outputVideoCodec,
            sourceAudioCodec: sourceAudioCodec,
            outputAudioCodec: outputAudioCodec,
            sourceResolution: sourceResolution,
            outputResolution: outputResolution,
            frameRateStr: frameRateStr,
            hardwareEngineStr: hardwareEngineStr,
            sourceContainer: sourceContainer,
            outputContainer: outputContainer,
            videoBitrateStr: videoBitrateStr,
            audioBitrateStr: audioBitrateStr,
            overallBitrateStr: overallBitrateStr,
            serverReasons: serverReasons,
            hdrStatus: hdrStatus,
            hdrToSdrVal: hdrToSdrVal,
            audioChannelsLayout: audioChannelsLayout,
            audioLanguage: audioLanguage,
            atmosBadge: atmosBadge,
            subtitleField: subtitleField,
            etaText: etaText,
            clientBrand: clientBrand
        };
    }

    /**
     * Builds the Info drawer's full, grouped 26-field technical breakdown (section 14) for one session.
     * Pure function of the session -- safe to call independently of any card render/DOM state.
     */
    /**
     * Single source of truth for the canonical field list (section 8/14), grouped.
     * Consumed by both the singleton Info drawer (all 26 fields, grouped with headers)
     * and the inline per-card "Show Details" grid (same fields minus the identity rows
     * already shown in the card header, flattened with no group headers).
     */
    function buildFieldGroups(m) {
        var c = m.classification;

        function row(key, val) {
            return { key: key, val: val };
        }

        return [
            {
                title: 'Playback',
                rows: [
                    row('User', escapeHtml(m.session.UserName || 'Not reported')),
                    row('Client', escapeHtml(m.session.Client || 'Not reported')),
                    row('Client Version', m.session.ApplicationVersion ? ('v' + escapeHtml(m.session.ApplicationVersion)) : 'Not reported'),
                    row('Device', escapeHtml(m.session.DeviceName || m.session.Client || 'Not reported')),
                    row('Playback State', m.isPaused ? 'Paused' : 'Playing'),
                    row('Playback Method', escapeHtml(c.badgeText))
                ]
            },
            {
                title: 'Video',
                rows: [
                    row('Video Status', m.isVideoDirect === true ? 'Direct' : (m.isVideoDirect === false ? 'Transcode' : 'Not reported')),
                    row('Source Video Codec', escapeHtml(m.sourceVideoCodec || 'Not reported')),
                    row('Output Video Codec', escapeHtml(m.outputVideoCodec || (m.isVideoDirect === true ? (m.sourceVideoCodec || 'Direct (Source Codec)') : 'Not reported'))),
                    row('Source Resolution', escapeHtml(m.sourceResolution || 'Not reported')),
                    row('Output Resolution', escapeHtml(m.outputResolution || (m.isVideoDirect === true ? (m.sourceResolution || 'Direct') : 'Not reported'))),
                    row('Frame Rate', escapeHtml(m.frameRateStr || 'Not reported')),
                    row('HDR Status', escapeHtml(m.hdrStatus || 'Not reported')),
                    row('Tone Mapping / HDR Conversion', escapeHtml(m.hdrToSdrVal))
                ]
            },
            {
                title: 'Audio',
                rows: [
                    row('Audio Status', m.isAudioDirect === true ? 'Direct' : (m.isAudioDirect === false ? 'Transcode' : 'Not reported')),
                    row('Source Audio Codec', escapeHtml(m.sourceAudioCodec || 'Not reported')),
                    row('Output Audio Codec', escapeHtml(m.outputAudioCodec || (m.isAudioDirect === true ? (m.sourceAudioCodec || 'Direct (Source Codec)') : 'Not reported'))),
                    row('Audio Channels / Layout', escapeHtml(m.audioChannelsLayout || 'Not reported')),
                    row('Audio Bitrate', escapeHtml(m.audioBitrateStr || 'Not reported'))
                ]
            },
            {
                title: 'Stream',
                rows: [
                    row('Source Container', escapeHtml(m.sourceContainer || 'Not reported')),
                    row('Output Container', escapeHtml(m.outputContainer || (m.isVideoDirect === true && m.isAudioDirect === true ? (m.sourceContainer || 'Direct') : 'Not reported'))),
                    row('Video Bitrate', escapeHtml(m.videoBitrateStr || 'Not reported')),
                    row('Overall Stream Bitrate', escapeHtml(m.overallBitrateStr || 'Not reported')),
                    row('Hardware Engine', escapeHtml(m.hardwareEngineStr || (c.method === 'Transcode' ? 'Not reported' : 'Not applicable'))),
                    row('Transcode Reason', escapeHtml(m.serverReasons || (c.method === 'Transcode' ? 'Reason not reported by server' : 'Not applicable')))
                ]
            },
            {
                title: 'Subtitles',
                rows: [
                    row('Subtitle Stream / Language', escapeHtml(m.subtitleField || 'Not active'))
                ]
            }
        ];
    }

    function fieldRowHtml(r, withDrawerAttr) {
        return '<div class="playback-info-row"' + (withDrawerAttr ? ' data-drawer-field="' + slugifyFieldKey(r.key) + '"' : '') + '>' +
            '<span class="playback-info-key">' + escapeHtml(r.key) + '</span>' +
            '<span class="playback-info-val">' + r.val + '</span>' +
        '</div>';
    }

    function buildDrawerContentHtml(session) {
        if (!session || typeof session !== 'object') {
            return '<div class="playback-drawer-empty">No session selected.</div>';
        }

        var groups = buildFieldGroups(buildTelemetryModel(session));

        return groups.map(function (group) {
            var rowsHtml = group.rows.map(function (r) { return fieldRowHtml(r, true); }).join('');
            return '<div class="playback-drawer-group">' +
                '<h4 class="playback-drawer-group-title">' + escapeHtml(group.title) + '</h4>' +
                '<div class="playback-info-grid">' + rowsHtml + '</div>' +
            '</div>';
        }).join('');
    }

    var INLINE_GRID_SKIP_KEYS = { 'User': true, 'Client': true, 'Client Version': true, 'Device': true };

    // The "Show Details" inline per-card grid: the same 22 non-identity fields as the
    // drawer (User/Client/Client Version/Device are omitted -- already shown in the card
    // header), flattened into one grid with no group headers.
    function buildInlineDetailGridHtml(model) {
        var groups = buildFieldGroups(model);
        var rowsHtml = groups.reduce(function (acc, group) {
            group.rows.forEach(function (r) {
                if (!INLINE_GRID_SKIP_KEYS[r.key]) acc.push(fieldRowHtml(r, false));
            });
            return acc;
        }, []);
        return '<div class="playback-info-grid">' + rowsHtml.join('') + '</div>';
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
        var deviceClientBrand = resolveClientBrand({ client: session.Client, deviceName: session.DeviceName });
        var platformIcon = deviceClientBrand.svg;
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

        return '<div class="playback-device-card" data-connected-device-card="true">' +
            '<div class="playback-device-icon" data-client-brand="' + escapeHtml(deviceClientBrand.key) + '" title="' + client + '">' + platformIcon + '</div>' +
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

        // Keep state in sync with whatever was just rendered, so the Info drawer (which
        // looks sessions up by ID via state, independent of the calling render pass) can
        // always find the currently-open session regardless of which code path rendered it.
        state.activeSessions = activeSessions;
        state.allSessions = connectedSessions;

        // Reset per-render card->session correlation map (rebuilt below as each card renders).
        state.cardSessionMap = {};

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
                    '<span class="playback-count-chip count-dp" data-count-method="directPlay" data-count-value="' + counts.directPlay + '"><span class="count-val">' + counts.directPlay + '</span> Direct Play</span>' +
                    '<span class="playback-count-chip count-ds" data-count-method="directStream" data-count-value="' + counts.directStream + '"><span class="count-val">' + counts.directStream + '</span> Direct Stream</span>' +
                    '<span class="playback-count-chip count-remux" data-count-method="remux" data-count-value="' + counts.remux + '"><span class="count-val">' + counts.remux + '</span> Remux</span>' +
                    '<span class="playback-count-chip count-tc" data-count-method="transcode" data-count-value="' + counts.transcode + '"><span class="count-val">' + counts.transcode + '</span> Transcode</span>' +
                    '<span class="playback-count-chip count-paused" data-count-method="paused" data-count-value="' + counts.paused + '"><span class="count-val">' + counts.paused + '</span> Paused</span>' +
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

        // The Info drawer is a singleton mounted outside this container's innerHTML,
        // so it must be (re)synced explicitly on every render/poll cycle instead of
        // being torn down and rebuilt with the cards above it.
        ensureDrawerMounted();
        updateDrawerIfOpen(activeSessions, connectedSessions);
    }

    function findSessionById(sessionId) {
        if (!sessionId) return null;
        var pools = [state.activeSessions, state.allSessions];
        for (var p = 0; p < pools.length; p++) {
            var arr = pools[p];
            if (!Array.isArray(arr)) continue;
            for (var i = 0; i < arr.length; i++) {
                if (arr[i] && arr[i].Id === sessionId) return arr[i];
            }
        }
        return null;
    }

    function renderDrawerContent(panel, session) {
        if (!panel || typeof panel.querySelector !== 'function') return;
        var identityEl = panel.querySelector('#playback-drawer-identity');
        var bodyEl = panel.querySelector('#playback-drawer-body');
        if (!session) {
            if (bodyEl) bodyEl.innerHTML = '<div class="playback-drawer-empty">This session has ended.</div>';
            if (identityEl) identityEl.innerHTML = '';
            return;
        }
        var brand = resolveClientBrand({ client: session.Client, deviceName: session.DeviceName });
        if (identityEl) {
            identityEl.innerHTML =
                '<span class="playback-platform-icon" data-client-brand="' + escapeHtml(brand.key) + '">' + brand.svg + '</span>' +
                '<span class="playback-drawer-identity-text">' + escapeHtml(session.UserName || 'Unknown User') + ' &bull; ' + escapeHtml(session.Client || 'Playback Client') + '</span>';
        }
        if (bodyEl) bodyEl.innerHTML = buildDrawerContentHtml(session);
    }

    function lockBodyScroll() {
        if (typeof document === 'undefined' || !document.body || !document.body.style) return;
        if (state.drawerBodyOverflowSaved == null) {
            state.drawerBodyOverflowSaved = document.body.style.overflow || '';
        }
        document.body.style.overflow = 'hidden';
    }

    function unlockBodyScroll() {
        if (typeof document === 'undefined' || !document.body || !document.body.style) return;
        document.body.style.overflow = state.drawerBodyOverflowSaved || '';
        state.drawerBodyOverflowSaved = null;
    }

    function trapDrawerFocus(e) {
        if (typeof document === 'undefined') return;
        var panel = document.getElementById(DRAWER_PANEL_ID);
        if (!panel || typeof panel.querySelectorAll !== 'function') return;
        var focusable = panel.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
        if (!focusable || focusable.length === 0) return;
        var first = focusable[0];
        var last = focusable[focusable.length - 1];
        var active = document.activeElement;
        if (e.shiftKey) {
            if (active === first || active === panel) {
                e.preventDefault();
                if (typeof last.focus === 'function') last.focus();
            }
        } else if (active === last) {
            e.preventDefault();
            if (typeof first.focus === 'function') first.focus();
        }
    }

    /**
     * Mounts the singleton Info drawer (overlay + dialog panel) under document.body exactly once.
     * Idempotent: safe to call on every render. The overlay/panel nodes are never recreated --
     * only their content is refreshed in place -- so the drawer survives polling re-renders.
     */
    function ensureDrawerMounted() {
        if (typeof document === 'undefined' || typeof document.getElementById !== 'function') return null;

        var panel = document.getElementById(DRAWER_PANEL_ID);
        if (panel) return panel;
        if (typeof document.createElement !== 'function' || !document.body || typeof document.body.appendChild !== 'function') {
            return null;
        }

        var overlay = document.createElement('div');
        overlay.id = DRAWER_OVERLAY_ID;

        panel = document.createElement('div');
        panel.id = DRAWER_PANEL_ID;
        if (typeof panel.setAttribute === 'function') {
            panel.setAttribute('role', 'dialog');
            panel.setAttribute('aria-modal', 'true');
            panel.setAttribute('aria-labelledby', 'playback-drawer-title-label');
            panel.setAttribute('tabindex', '-1');
        }
        panel.innerHTML =
            '<div class="playback-drawer-header">' +
                '<div class="playback-drawer-title-wrap">' +
                    '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>' +
                    '<span class="playback-drawer-title" id="playback-drawer-title-label">Technical Stream Details</span>' +
                '</div>' +
                '<button type="button" class="playback-drawer-close" data-action="close-info" aria-label="Close details">&times;</button>' +
            '</div>' +
            '<div class="playback-drawer-identity" id="playback-drawer-identity"></div>' +
            '<div class="playback-drawer-body" id="playback-drawer-body"></div>';

        document.body.appendChild(overlay);
        document.body.appendChild(panel);

        if (typeof panel.addEventListener === 'function') {
            panel.addEventListener('keydown', function (e) {
                if (e.key === 'Tab' || e.keyCode === 9) trapDrawerFocus(e);
            });
        }

        return panel;
    }

    /**
     * Opens the singleton Info drawer for the session bound to a given card. Only one session
     * can be shown at a time; opening a different card's Info re-targets the same drawer.
     */
    function openInfoDrawer(cardDomId, triggerEl) {
        var sessionId = state.cardSessionMap && state.cardSessionMap[cardDomId];
        if (!sessionId) return false;

        var panel = ensureDrawerMounted();
        var overlay = (typeof document !== 'undefined' && typeof document.getElementById === 'function') ? document.getElementById(DRAWER_OVERLAY_ID) : null;

        state.drawer.open = true;
        state.drawer.sessionId = sessionId;
        state.drawer.cardDomId = cardDomId;
        state.drawer.missingPolls = 0;
        state.drawer.lastFocusEl = triggerEl ||
            (typeof document !== 'undefined' && typeof document.getElementById === 'function' ? document.getElementById('btn-info-' + cardDomId) : null);

        renderDrawerContent(panel, findSessionById(sessionId));

        if (panel && panel.classList && typeof panel.classList.add === 'function') panel.classList.add('open');
        if (overlay && overlay.classList && typeof overlay.classList.add === 'function') overlay.classList.add('open');

        lockBodyScroll();

        if (panel && typeof panel.focus === 'function') {
            try { panel.focus(); } catch (_) {}
        }

        return true;
    }

    /**
     * Closes the Info drawer. Only called from: the close button, a backdrop click, Escape,
     * or confirmed session disappearance after DRAWER_MISSING_POLL_TOLERANCE consecutive polls.
     * Never called as a side effect of normal polling/rerendering while the session still exists.
     */
    function closeInfoDrawer(restoreFocus) {
        if (typeof document !== 'undefined' && typeof document.getElementById === 'function') {
            var panel = document.getElementById(DRAWER_PANEL_ID);
            var overlay = document.getElementById(DRAWER_OVERLAY_ID);
            if (panel && panel.classList && typeof panel.classList.remove === 'function') panel.classList.remove('open');
            if (overlay && overlay.classList && typeof overlay.classList.remove === 'function') overlay.classList.remove('open');
        }
        unlockBodyScroll();

        var storedFocusEl = state.drawer.lastFocusEl;
        var sessionId = state.drawer.sessionId;
        state.drawer.open = false;
        state.drawer.sessionId = null;
        state.drawer.cardDomId = null;
        state.drawer.missingPolls = 0;
        state.drawer.lastFocusEl = null;

        if (restoreFocus === false) return;

        // The stored trigger element goes stale the moment a poll/re-render rebuilds the
        // cards grid (container.innerHTML replaces every node), so prefer it only while
        // still attached. Otherwise re-resolve the button by the session's CURRENT card
        // slot (via cardSessionMap), not the positional id captured at open time -- if
        // session ordering shifted while the drawer was open, that slot may now belong
        // to a different session entirely.
        var focusTarget = (storedFocusEl && storedFocusEl.isConnected) ? storedFocusEl : null;
        if (!focusTarget && sessionId && typeof document !== 'undefined' && typeof document.getElementById === 'function') {
            var freshCardDomId = null;
            var map = state.cardSessionMap || {};
            for (var key in map) {
                if (Object.prototype.hasOwnProperty.call(map, key) && map[key] === sessionId) {
                    freshCardDomId = key;
                    break;
                }
            }
            if (freshCardDomId) {
                focusTarget = document.getElementById('btn-info-' + freshCardDomId);
            }
        }
        if (focusTarget && typeof focusTarget.focus === 'function') {
            try { focusTarget.focus(); } catch (_) {}
        }
    }

    /**
     * Re-syncs the open drawer's content on every poll/render cycle. Session still present ->
     * update values in place (fields only, never the overlay/panel nodes). Session missing ->
     * increment a tolerance counter and only close after it is exceeded, so one dropped poll
     * or reordering of the sessions array can never silently close the drawer.
     */
    function updateDrawerIfOpen(activeSessions, allSessions) {
        if (!state.drawer.open) return;

        var session = null;
        var pools = [activeSessions, allSessions];
        for (var p = 0; p < pools.length && !session; p++) {
            var arr = pools[p];
            if (!Array.isArray(arr)) continue;
            for (var i = 0; i < arr.length; i++) {
                if (arr[i] && arr[i].Id === state.drawer.sessionId) {
                    session = arr[i];
                    break;
                }
            }
        }

        if (session) {
            state.drawer.missingPolls = 0;
            if (typeof document !== 'undefined' && typeof document.getElementById === 'function') {
                renderDrawerContent(document.getElementById(DRAWER_PANEL_ID), session);
            }
            return;
        }

        state.drawer.missingPolls++;
        if (state.drawer.missingPolls > DRAWER_MISSING_POLL_TOLERANCE) {
            closeInfoDrawer(true);
        }
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

            // Info button always opens (or refocuses) the singleton modal Info drawer for this card.
            var infoBtn = target.closest('[data-action="toggle-info"]');
            if (infoBtn) {
                var cardId = infoBtn.getAttribute('data-card-id');
                if (cardId) {
                    openInfoDrawer(cardId, infoBtn);
                    renderDashboardContainer(container, state.activeSessions, state.allSessions);
                }
                return;
            }

            // Drawer close button (delegated -- the drawer itself lives outside this container).
            var drawerCloseBtn = target.closest('[data-action="close-info"]');
            if (drawerCloseBtn) {
                closeInfoDrawer(true);
                renderDashboardContainer(container, state.activeSessions, state.allSessions);
                return;
            }
        });

        // Drawer backdrop click-to-close and Escape-to-close are bound once globally,
        // not per container, since the drawer is a page-level singleton.
        if (typeof document !== 'undefined' && !global.__playbackCardDrawerEventsBound) {
            global.__playbackCardDrawerEventsBound = true;
            document.addEventListener('click', function (e) {
                if (!state.drawer.open) return;
                var t = e.target;
                if (t && typeof t.closest === 'function' && t.id === DRAWER_OVERLAY_ID) {
                    closeInfoDrawer(true);
                }
            });
            document.addEventListener('keydown', function (e) {
                if (!state.drawer.open) return;
                if (e.key === 'Escape' || e.key === 'Esc' || e.keyCode === 27) {
                    closeInfoDrawer(true);
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
        resolveClientBrand: resolveClientBrand,
        extractAtmosBadge: extractAtmosBadge,
        extractAudioLanguage: extractAudioLanguage,
        formatEta: formatEta,
        resolveUserAvatarUrl: resolveUserAvatarUrl,
        buildTelemetryModel: buildTelemetryModel,
        buildDrawerContentHtml: buildDrawerContentHtml,
        ensureDrawerMounted: ensureDrawerMounted,
        openInfoDrawer: openInfoDrawer,
        closeInfoDrawer: closeInfoDrawer,
        updateDrawerIfOpen: updateDrawerIfOpen,
        findSessionById: findSessionById,
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
