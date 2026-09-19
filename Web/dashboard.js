/**
 * Playback Info Card - Primary Dashboard Integration (v0.2.7.6)
 * Completely replaces Jellyfin's standard stock Devices section on the default
 * Dashboard with the NOW PLAYING telemetry grid and active connected device telemetry.
 */

(function (global) {
    'use strict';

    var VERSION = '0.2.7.6';
    var ASSET_REVISION = '0.2.7.6';
    var CONTAINER_ID = 'playback-card-nowplaying-container';
    var POLL_INTERVAL_MS = 3000;

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
        // One-shot flag: true only for the single render pass immediately after a
        // Compact->Extended click, so the newly-revealed extended-only pill row can play
        // its entrance transition once. Consumed and reset to false right after that
        // render -- an ambient poll re-render (session data refreshing every few seconds)
        // must never see this true, or the row would replay the animation on every poll
        // tick instead of just the moment the user actually switched modes.
        modeAnimatePending: false,
        // Which of the two Info views the Info button opens -- 'down' (default, unchanged
        // from the original behavior: expands that one card's own inline details grid) or
        // 'right' (opens a centered Tautulli-style dialog with the poster on the left and
        // the full field list on the right, instead). A user preference, not a data fact,
        // so it lives in state rather than being derived from anything server-reported.
        infoViewStyle: 'down',
        // Per-card override of the details panel's open/closed state, keyed by stable
        // session ID (not card position) so it survives the next poll's full re-render.
        // A card with no entry here just follows showAllDetails; an entry lets one card
        // be collapsed while others stay open under "Show Details" (or vice versa) --
        // useful once several streams are active and every card expanded at once is too
        // much to scan. Only meaningful while infoViewStyle is 'down'.
        infoOverrides: {},
        // Wall-clock time (client Date.now()) this session was first observed, keyed by
        // stable session ID -- lets the card show how long it's actually been open in
        // real time, distinct from media position (a session stuck at 0:34 for an hour
        // reads very differently from one that just started).
        sessionStartTimes: {},
        // Network location badge (Local/Remote + optional geolocation) -- strictly opt-in,
        // off by default. networkLocationEnabled mirrors the saved setting (re-checked
        // periodically in case an admin toggles it while this dashboard stays open);
        // networkLocationLabels is populated by its own independent poll, keyed by session
        // ID, never by IP.
        networkLocationEnabled: false,
        networkLocationConfigCheckedAt: 0,
        networkLocationLabels: {},

        // First-observed pause timestamp per session ID, tracked client-side across poll
        // cycles -- a session only reports its current paused flag, not how long it's been
        // that way. Set the first time a session is seen paused, cleared the moment it isn't.
        pausedSinceBySession: {},

        // Admin-configured upstream cap for the bandwidth gauge's percentage display, mirrored
        // from the saved setting by ensureNetworkLocationConfigLoaded's periodic config check.
        // 0 = unset. Purely cosmetic, never enforced.
        uploadBandwidthLimitMbps: 0
    };

    var ZOMBIE_STREAM_THRESHOLD_MS = 60 * 60 * 1000; // 1 hour

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

    // Real-world elapsed duration since a session was first observed (wall-clock, not
    // media position) -- "42m" / "1h 12m". Distinct from formatRelativeTime, which
    // reads as "X ago" for a past timestamp rather than a running duration.
    function formatElapsedDuration(startMs, nowMs) {
        if (typeof startMs !== 'number' || !isFinite(startMs)) return null;
        var diffMs = (typeof nowMs === 'number' ? nowMs : Date.now()) - startMs;
        if (diffMs < 60000) return null; // Not worth showing under a minute in
        var totalMinutes = Math.floor(diffMs / 60000);
        var hours = Math.floor(totalMinutes / 60);
        var minutes = totalMinutes % 60;
        if (hours > 0) return hours + 'h ' + minutes + 'm';
        return minutes + 'm';
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

    // Small leading glyphs for the highest-signal compact pills (resolution, dynamic
    // range, audio, subtitle) so they scan at a glance instead of reading as plain text.
    // Codec/bit-depth/container pills stay icon-free to avoid visual noise.
    var PILL_ICONS = {
        res: '<svg class="pill-icon" viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2.4"><rect x="2" y="4" width="20" height="14" rx="2"/><path d="M8 21h8"/></svg>',
        hdr: '<svg class="pill-icon" viewBox="0 0 24 24" width="10" height="10" fill="currentColor"><path d="M12 2l2.2 6.6L21 10l-5.2 4.1L17.4 21 12 17.3 6.6 21 8.2 14.1 3 10l6.8-1.4z"/></svg>',
        audio: '<svg class="pill-icon" viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M11 5 6 9H2v6h4l5 4V5z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/></svg>',
        sub: '<svg class="pill-icon" viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2.2"><rect x="2" y="5" width="20" height="14" rx="2"/><path d="M6 15h4M13 15h5"/></svg>',
        bitrate: '<svg class="pill-icon" viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M4 20V10M10 20V4M16 20v-7M22 20v-3"/></svg>',
        geo: '<svg class="pill-icon" viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M12 22s7-7.58 7-12.5A7 7 0 0 0 5 9.5C5 14.42 12 22 12 22z"/><circle cx="12" cy="9.5" r="2.2"/></svg>'
    };

    function pillIconSvg(cls) {
        return PILL_ICONS[cls] || '';
    }

    // Small warning glyph prefixed onto a pill when a transcode reason specifically
    // targets it (see REASON_PILL_TARGETS/summarizePillWarnings) -- deliberately a
    // different shape from the plain pill icons above so a ringed pill reads as
    // "something's wrong here" at a glance, not just another category badge.
    var PILL_WARN_ICON = '<svg class="pill-warn-icon" viewBox="0 0 24 24" width="9" height="9" fill="currentColor"><path d="M12 2 1 21h22L12 2zm0 6.5a1 1 0 0 1 1 1v5a1 1 0 1 1-2 0v-5a1 1 0 0 1 1-1zm0 9.75a1.15 1.15 0 1 1 0-2.3 1.15 1.15 0 0 1 0 2.3z"/></svg>';

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

    // Maps the 2/3-letter language codes media files are typically tagged with (ISO 639-1/639-2,
    // e.g. "por", "spa", "eng") to a readable English name for pill tooltips. Most files carry only
    // this generic code with no country/region info (Brazil vs. Portugal, Latin America vs. Spain,
    // US vs. UK all collapse to the same 3-letter tag) -- that distinction isn't recoverable from
    // it, so this only expands the language itself, never guesses a region.
    var LANGUAGE_DISPLAY_NAMES = {
        ENG: 'English', EN: 'English',
        POR: 'Portuguese', PT: 'Portuguese',
        SPA: 'Spanish', ES: 'Spanish',
        FRE: 'French', FRA: 'French', FR: 'French',
        GER: 'German', DEU: 'German', DE: 'German',
        ITA: 'Italian', IT: 'Italian',
        JPN: 'Japanese', JA: 'Japanese',
        KOR: 'Korean', KO: 'Korean',
        CHI: 'Chinese', ZHO: 'Chinese', ZH: 'Chinese',
        RUS: 'Russian', RU: 'Russian',
        ARA: 'Arabic', AR: 'Arabic',
        HIN: 'Hindi', HI: 'Hindi',
        DUT: 'Dutch', NLD: 'Dutch', NL: 'Dutch',
        SWE: 'Swedish', SV: 'Swedish',
        NOR: 'Norwegian', NOB: 'Norwegian', NB: 'Norwegian', NO: 'Norwegian',
        DAN: 'Danish', DA: 'Danish',
        FIN: 'Finnish', FI: 'Finnish',
        POL: 'Polish', PL: 'Polish',
        TUR: 'Turkish', TR: 'Turkish',
        GRE: 'Greek', ELL: 'Greek', EL: 'Greek',
        HEB: 'Hebrew', HE: 'Hebrew',
        THA: 'Thai', TH: 'Thai',
        VIE: 'Vietnamese', VI: 'Vietnamese',
        IND: 'Indonesian', ID: 'Indonesian',
        CZE: 'Czech', CES: 'Czech', CS: 'Czech',
        HUN: 'Hungarian', HU: 'Hungarian',
        RUM: 'Romanian', RON: 'Romanian', RO: 'Romanian',
        UKR: 'Ukrainian', UK: 'Ukrainian'
    };

    function getLanguageDisplayName(code) {
        if (!code) return '';
        var upper = String(code).toUpperCase();
        var base = upper.split(/[-_]/)[0];
        return LANGUAGE_DISPLAY_NAMES[upper] || LANGUAGE_DISPLAY_NAMES[base] || upper;
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

    // Severity per Jellyfin transcode-reason code: "red" for a hard incompatibility (the
    // client genuinely cannot play the source at all) vs. "amber" for a soft/negotiated
    // limit (bitrate/profile/level ceilings, external tracks) -- the same distinction
    // Jellyfin itself draws between "can't decode this" and "won't allow this much".
    // An unrecognized code defaults to "amber" (uncertain, not alarming) rather than red.
    var REASON_SEVERITY = {
        ContainerNotSupported: 'red',
        VideoCodecNotSupported: 'red',
        AudioCodecNotSupported: 'red',
        SubtitleCodecNotSupported: 'amber',
        AudioIsExternal: 'amber',
        SecondaryAudioNotSupported: 'amber',
        VideoProfileNotSupported: 'red',
        VideoLevelNotSupported: 'red',
        VideoResolutionNotSupported: 'amber',
        VideoBitrateNotSupported: 'amber',
        VideoFramerateNotSupported: 'amber',
        RefFramesNotSupported: 'red',
        AnamorphicVideoNotSupported: 'amber',
        InterlacedVideoNotSupported: 'amber',
        DirectPlayError: 'red',
        ContainerBitrateExceedsLimit: 'amber',
        AudioBitrateNotSupported: 'amber',
        AudioChannelsNotSupported: 'amber'
    };

    // Which compact pill a given reason code is actually about, so that specific pill
    // can carry a warning ring instead of the reason only ever showing up in the banner
    // below. Several codes legitimately point at the same pill (e.g. every audio-shaped
    // reason rings the audio pill); the caller takes the worst severity among matches.
    var REASON_PILL_TARGETS = {
        VideoCodecNotSupported: 'video',
        VideoProfileNotSupported: 'video',
        VideoLevelNotSupported: 'video',
        RefFramesNotSupported: 'video',
        AnamorphicVideoNotSupported: 'video',
        InterlacedVideoNotSupported: 'video',
        VideoResolutionNotSupported: 'res',
        VideoBitrateNotSupported: 'bitrate',
        ContainerBitrateExceedsLimit: 'bitrate',
        VideoFramerateNotSupported: 'framerate',
        AudioCodecNotSupported: 'audio',
        AudioIsExternal: 'audio',
        SecondaryAudioNotSupported: 'audio',
        AudioChannelsNotSupported: 'audio',
        AudioBitrateNotSupported: 'audio',
        ContainerNotSupported: 'container',
        SubtitleCodecNotSupported: 'sub'
    };

    /**
     * Structured, per-reason breakdown for the itemized "why transcoding" banner and the
     * pill warning rings -- same raw source data as getTruthfulTranscodeReasons() above,
     * but kept as a list of {code, label, severity} instead of one joined string so each
     * reason can be colored and targeted independently. Returns [] (never null) when
     * there is nothing to itemize; callers supply their own single fallback line.
     */
    function getTranscodeReasonDetails(session) {
        if (!session || typeof session !== 'object') return [];
        var tInfo = session.TranscodingInfo;
        var raw = [];
        if (Array.isArray(session.TranscodeReasons) && session.TranscodeReasons.length > 0) {
            raw = session.TranscodeReasons;
        } else if (tInfo && Array.isArray(tInfo.TranscodeReasons) && tInfo.TranscodeReasons.length > 0) {
            raw = tInfo.TranscodeReasons;
        }

        var valid = raw.filter(function (r) {
            return r != null && String(r).trim().length > 0 && String(r) !== '0' && String(r).toLowerCase() !== 'none';
        });

        if (valid.length > 0) {
            return valid.map(function (r) {
                var code = String(r);
                return { code: code, label: formatTranscodeReason(code), severity: REASON_SEVERITY[code] || 'amber' };
            });
        }

        if (typeof session.TranscodeReasonsWhy === 'string' && session.TranscodeReasonsWhy.trim().length > 0) {
            return [{ code: null, label: session.TranscodeReasonsWhy.trim(), severity: 'amber' }];
        }

        return [];
    }

    /**
     * Reduces a reason-details list down to one severity per pill target ("res", "video",
     * "audio", "bitrate", "framerate", "container", "sub"), taking the worst (red beats
     * amber) when more than one reason points at the same pill, plus the human-readable
     * labels responsible so the pill's tooltip can say exactly why it's ringed.
     */
    function summarizePillWarnings(reasonDetails) {
        var byTarget = {};
        (reasonDetails || []).forEach(function (r) {
            var targetKey = r.code ? REASON_PILL_TARGETS[r.code] : null;
            if (!targetKey) return;
            var existing = byTarget[targetKey];
            if (!existing) {
                byTarget[targetKey] = { severity: r.severity, labels: [r.label] };
            } else {
                if (r.severity === 'red') existing.severity = 'red';
                existing.labels.push(r.label);
            }
        });
        return byTarget;
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
        jellyfinWeb: '<svg viewBox="0 0 512 512" width="20" height="20"><defs><linearGradient id="pi-jf-web" x1="110.25" y1="213.3" x2="496.14" y2="436.09"><stop offset="0" stop-color="#AA5CC3"/><stop offset="1" stop-color="#00A4DC"/></linearGradient></defs><path d="M256,201.6c-20.4,0-86.2,119.3-76.2,139.4s142.5,19.9,152.4,0S276.5,201.6,256,201.6z" fill="url(#pi-jf-web)"/><path d="M256,23.3c-61.6,0-259.8,359.4-229.6,420.1s429.3,60,459.2,0S317.6,23.3,256,23.3z M406.5,390.8c-19.6,39.3-281.1,39.8-300.9,0s110.1-275.3,150.4-275.3S426.1,351.4,406.5,390.8z" fill="url(#pi-jf-web)"/></svg>',
        jellyfinMobile: '<svg viewBox="0 0 512 512" width="20" height="20"><defs><linearGradient id="pi-jf-mobile" x1="110.25" y1="213.3" x2="496.14" y2="436.09"><stop offset="0" stop-color="#AA5CC3"/><stop offset="1" stop-color="#00A4DC"/></linearGradient></defs><path d="M256,201.6c-20.4,0-86.2,119.3-76.2,139.4s142.5,19.9,152.4,0S276.5,201.6,256,201.6z" fill="url(#pi-jf-mobile)"/><path d="M256,23.3c-61.6,0-259.8,359.4-229.6,420.1s429.3,60,459.2,0S317.6,23.3,256,23.3z M406.5,390.8c-19.6,39.3-281.1,39.8-300.9,0s110.1-275.3,150.4-275.3S426.1,351.4,406.5,390.8z" fill="url(#pi-jf-mobile)"/></svg>',
        jellyfinTv: '<svg viewBox="0 0 512 512" width="20" height="20"><defs><linearGradient id="pi-jf-tv" x1="110.25" y1="213.3" x2="496.14" y2="436.09"><stop offset="0" stop-color="#AA5CC3"/><stop offset="1" stop-color="#00A4DC"/></linearGradient></defs><path d="M256,201.6c-20.4,0-86.2,119.3-76.2,139.4s142.5,19.9,152.4,0S276.5,201.6,256,201.6z" fill="url(#pi-jf-tv)"/><path d="M256,23.3c-61.6,0-259.8,359.4-229.6,420.1s429.3,60,459.2,0S317.6,23.3,256,23.3z M406.5,390.8c-19.6,39.3-281.1,39.8-300.9,0s110.1-275.3,150.4-275.3S426.1,351.4,406.5,390.8z" fill="url(#pi-jf-tv)"/></svg>',
        jellyfinDesktop: '<svg viewBox="0 0 512 512" width="20" height="20"><defs><linearGradient id="pi-jf-desktop" x1="110.25" y1="213.3" x2="496.14" y2="436.09"><stop offset="0" stop-color="#AA5CC3"/><stop offset="1" stop-color="#00A4DC"/></linearGradient></defs><path d="M256,201.6c-20.4,0-86.2,119.3-76.2,139.4s142.5,19.9,152.4,0S276.5,201.6,256,201.6z" fill="url(#pi-jf-desktop)"/><path d="M256,23.3c-61.6,0-259.8,359.4-229.6,420.1s429.3,60,459.2,0S317.6,23.3,256,23.3z M406.5,390.8c-19.6,39.3-281.1,39.8-300.9,0s110.1-275.3,150.4-275.3S426.1,351.4,406.5,390.8z" fill="url(#pi-jf-desktop)"/></svg>',
        chrome: '<svg viewBox="0 0 48 48" width="20" height="20"><defs><linearGradient id="pi-chrome-a" x1="3.2173" y1="15" x2="44.7812" y2="15"><stop offset="0" stop-color="#d93025"/><stop offset="1" stop-color="#ea4335"/></linearGradient><linearGradient id="pi-chrome-b" x1="20.7219" y1="47.6791" x2="41.5039" y2="11.6837"><stop offset="0" stop-color="#fcc934"/><stop offset="1" stop-color="#fbbc04"/></linearGradient><linearGradient id="pi-chrome-c" x1="26.5981" y1="46.5015" x2="5.8161" y2="10.506"><stop offset="0" stop-color="#1e8e3e"/><stop offset="1" stop-color="#34a853"/></linearGradient></defs><circle cx="24" cy="23.9947" r="12" fill="#fff"/><path d="M24,12H44.7812a23.9939,23.9939,0,0,0-41.5639.0029L13.6079,30l.0093-.0024A11.9852,11.9852,0,0,1,24,12Z" fill="url(#pi-chrome-a)"/><circle cx="24" cy="24" r="9.5" fill="#1a73e8"/><path d="M34.3913,30.0029,24.0007,48A23.994,23.994,0,0,0,44.78,12.0031H23.9989l-.0025.0093A11.985,11.985,0,0,1,34.3913,30.0029Z" fill="url(#pi-chrome-b)"/><path d="M13.6086,30.0031,3.218,12.006A23.994,23.994,0,0,0,24.0025,48L34.3931,30.0029l-.0067-.0068a11.9852,11.9852,0,0,1-20.7778.007Z" fill="url(#pi-chrome-c)"/></svg>',
        edge: '<svg viewBox="0 0 24 24" width="20" height="20" fill="#0078D7"><path d="M21.86 17.86q.14 0 .25.12.1.13.1.25t-.11.33l-.32.46-.43.53-.44.5q-.21.25-.38.42l-.22.23q-.58.53-1.34 1.04-.76.51-1.6.91-.86.4-1.74.64t-1.67.24q-.9 0-1.69-.28-.8-.28-1.48-.78-.68-.5-1.22-1.17-.53-.66-.92-1.44-.38-.77-.58-1.6-.2-.83-.2-1.67 0-1 .32-1.96.33-.97.87-1.8.14.95.55 1.77.41.82 1.02 1.5.6.68 1.38 1.21.78.54 1.64.9.86.36 1.77.56.92.2 1.8.2 1.12 0 2.18-.24 1.06-.23 2.06-.72l.2-.1.2-.05zm-15.5-1.27q0 1.1.27 2.15.27 1.06.78 2.03.51.96 1.24 1.77.74.82 1.66 1.4-1.47-.2-2.8-.74-1.33-.55-2.48-1.37-1.15-.83-2.08-1.9-.92-1.07-1.58-2.33T.36 14.94Q0 13.54 0 12.06q0-.81.32-1.49.31-.68.83-1.23.53-.55 1.2-.96.66-.4 1.35-.66.74-.27 1.5-.39.78-.12 1.55-.12.7 0 1.42.1.72.12 1.4.35.68.23 1.32.57.63.35 1.16.83-.35 0-.7.07-.33.07-.65.23v-.02q-.63.28-1.2.74-.57.46-1.05 1.04-.48.58-.87 1.26-.38.67-.65 1.39-.27.71-.42 1.44-.15.72-.15 1.38zM11.96.06q1.7 0 3.33.39 1.63.38 3.07 1.15 1.43.77 2.62 1.93 1.18 1.16 1.98 2.7.49.94.76 1.96.28 1 .28 2.08 0 .89-.23 1.7-.24.8-.69 1.48-.45.68-1.1 1.22-.64.53-1.45.88-.54.24-1.11.36-.58.13-1.16.13-.42 0-.97-.03-.54-.03-1.1-.12-.55-.1-1.05-.28-.5-.19-.84-.5-.12-.09-.23-.24-.1-.16-.1-.33 0-.15.16-.35.16-.2.35-.5.2-.28.36-.68.16-.4.16-.95 0-1.06-.4-1.96-.4-.91-1.06-1.64-.66-.74-1.52-1.28-.86-.55-1.79-.89-.84-.3-1.72-.44-.87-.14-1.76-.14-1.55 0-3.06.45T.94 7.55q.71-1.74 1.81-3.13 1.1-1.38 2.52-2.35Q6.68 1.1 8.37.58q1.7-.52 3.58-.52Z"/></svg>',
        firefox: '<svg viewBox="0 0 24 24" width="20" height="20" fill="#FF7139"><path d="M20.452 3.445a11.002 11.002 0 00-2.482-1.908C16.944.997 15.098.093 12.477.032c-.734-.017-1.457.03-2.174.144-.72.114-1.398.292-2.118.56-1.017.377-1.996.975-2.574 1.554.583-.349 1.476-.733 2.55-.992a10.083 10.083 0 013.729-.167c2.341.34 4.178 1.381 5.48 2.625a8.066 8.066 0 011.298 1.587c1.468 2.382 1.33 5.376.184 7.142-.85 1.312-2.67 2.544-4.37 2.53-.583-.023-1.438-.152-2.25-.566-2.629-1.343-3.021-4.688-1.118-6.306-.632-.136-1.82.13-2.646 1.363-.742 1.107-.7 2.816-.242 4.028a6.473 6.473 0 01-.59-1.895 7.695 7.695 0 01.416-3.845A8.212 8.212 0 019.45 5.399c.896-1.069 1.908-1.72 2.75-2.005-.54-.471-1.411-.738-2.421-.767C8.31 2.583 6.327 3.061 4.7 4.41a8.148 8.148 0 00-1.976 2.414c-.455.836-.691 1.659-.697 1.678.122-1.445.704-2.994 1.248-4.055-.79.413-1.827 1.668-2.41 3.042C.095 9.37-.2 11.608.14 13.989c.966 5.668 5.9 9.982 11.843 9.982C18.62 23.971 24 18.591 24 11.956a11.93 11.93 0 00-3.548-8.511z"/></svg>',
        safari: '<svg viewBox="0 0 24 24" width="20" height="20"><circle cx="12" cy="12" r="10" fill="#fff"/><circle cx="12" cy="12" r="10" fill="none" stroke="#3fa4dc" stroke-width="1.5"/><polygon points="12,4 14.2,12 12,12" fill="#ff3b30"/><polygon points="12,4 9.8,12 12,12" fill="#e2e2e2"/><polygon points="12,20 9.8,12 12,12" fill="#c7c7c7"/><polygon points="12,20 14.2,12 12,12" fill="#8e8e93"/></svg>',
        brave: '<svg viewBox="0 0 24 24" width="20" height="20" fill="#FB542B"><path d="M15.68 0l2.096 2.38s1.84-.512 2.709.358c.868.87 1.584 1.638 1.584 1.638l-.562 1.381.715 2.047s-2.104 7.98-2.35 8.955c-.486 1.919-.818 2.66-2.198 3.633-1.38.972-3.884 2.66-4.293 2.916-.409.256-.92.692-1.38.692-.46 0-.97-.436-1.38-.692a185.796 185.796 0 01-4.293-2.916c-1.38-.973-1.712-1.714-2.197-3.633-.247-.975-2.351-8.955-2.351-8.955l.715-2.047-.562-1.381s.716-.768 1.585-1.638c.868-.87 2.708-.358 2.708-.358L8.321 0h7.36zm-3.679 14.936c-.14 0-1.038.317-1.758.69-.72.373-1.242.637-1.409.742-.167.104-.065.301.087.409.152.107 2.194 1.69 2.393 1.866.198.175.489.464.687.464.198 0 .49-.29.688-.464.198-.175 2.24-1.759 2.392-1.866.152-.108.254-.305.087-.41-.167-.104-.689-.368-1.41-.741-.72-.373-1.617-.69-1.757-.69zm0-11.278s-.409.001-1.022.206-1.278.46-1.584.46c-.307 0-2.581-.434-2.581-.434S4.119 7.152 4.119 7.849c0 .697.339.881.68 1.243l2.02 2.149c.192.203.59.511.356 1.066-.235.555-.58 1.26-.196 1.977.384.716 1.042 1.194 1.464 1.115.421-.08 1.412-.598 1.776-.834.364-.237 1.518-1.19 1.518-1.554 0-.365-1.193-1.02-1.413-1.168-.22-.15-1.226-.725-1.247-.95-.02-.227-.012-.293.284-.851.297-.559.831-1.304.742-1.8-.089-.495-.95-.753-1.565-.986-.615-.232-1.799-.671-1.947-.74-.148-.068-.11-.133.339-.175.448-.043 1.719-.212 2.292-.052.573.16 1.552.403 1.632.532.079.13.149.134.067.579-.081.445-.5 2.581-.541 2.96-.04.38-.12.63.288.724.409.094 1.097.256 1.333.256s.924-.162 1.333-.256c.408-.093.329-.344.288-.723-.04-.38-.46-2.516-.541-2.961-.082-.445-.012-.45.067-.579.08-.129 1.059-.372 1.632-.532.573-.16 1.845.009 2.292.052.449.042.487.107.339.175-.148.069-1.332.508-1.947.74-.615.233-1.476.49-1.565.986-.09.496.445 1.241.742 1.8.297.558.304.624.284.85-.02.226-1.026.802-1.247.95-.22.15-1.413.804-1.413 1.169 0 .364 1.154 1.317 1.518 1.554.364.236 1.355.755 1.776.834.422.079 1.08-.4 1.464-1.115.384-.716.039-1.422-.195-1.977-.235-.555.163-.863.355-1.066l2.02-2.149c.341-.362.68-.546.68-1.243 0-.697-2.695-3.96-2.695-3.96s-2.274.436-2.58.436c-.307 0-.972-.256-1.585-.461-.613-.205-1.022-.206-1.022-.206z"/></svg>',
        android: '<svg viewBox="0 0 24 24" width="20" height="20" fill="#3ddc84"><path d="M17.523 15.3414c-.5511 0-.9993-.4486-.9993-1.0003 0-.5516.4482-.9998.9993-.9998.5516 0 .9997.4482.9997.9998 0 .5517-.4481 1.0003-.9997 1.0003m-11.046 0c-.5511 0-.9993-.4486-.9993-1.0003 0-.5516.4482-.9998.9993-.9998.5516 0 .9998.4482.9998.9998 0 .5517-.4482 1.0003-.9998 1.0003m11.4045-6.02l1.9973-3.4592a.416.416 0 00-.1521-.5676.416.416 0 00-.5676.1521l-2.0223 3.503C15.5902 8.4114 13.8533 8.167 12 8.167c-1.8533 0-3.5902.2444-5.1367.783L4.841 5.447a.416.416 0 00-.5676-.1521.416.416 0 00-.1521.5676l1.9973 3.4592C2.6889 11.1867.3432 14.6589 0 18.761h24c-.3432-4.1021-2.6889-7.5743-6.1185-9.4396" transform="translate(0,1) scale(0.85)"/></svg>',
        androidTv: '<svg viewBox="0 0 24 24" width="20" height="20" fill="#4285F4"><path d="M3.11 3.245A3.117 3.117 0 0 0 0 6.355V13.7a1.87 1.87 0 0 0 1.878 1.878h2.588V5.124c0-.73.313-1.399.814-1.879zm3.944 0a1.87 1.87 0 0 0-1.879 1.879V7.71h16.947v.021c.73 0 1.398.313 1.878.814v-2.19a3.117 3.117 0 0 0-3.11-3.11zm12.48 5.176v10.455c0 .73-.313 1.399-.814 1.879h2.17a3.117 3.117 0 0 0 3.11-3.11V10.3a1.87 1.87 0 0 0-1.878-1.878zM0 15.475v2.17a3.117 3.117 0 0 0 3.11 3.11h13.836a1.87 1.87 0 0 0 1.878-1.879V16.29H1.878c-.73 0-1.398-.314-1.878-.814"/></svg>',
        apple: '<svg viewBox="0 0 24 24" width="20" height="20" fill="#a2aaad"><path d="M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701"/></svg>',
        windows: '<svg viewBox="0 0 24 24" width="20" height="20" fill="#0078D4"><path d="M0,0H11.377V11.372H0ZM12.623,0H24V11.372H12.623ZM0,12.623H11.377V24H0Zm12.623,0H24V24H12.623"/></svg>',
        roku: '<svg viewBox="0 0 24 24" width="20" height="20" fill="#6c3c97"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 14H9v-4.5H7.5V10H11v6zm4.5 0h-2V8h2c1.66 0 3 1.34 3 3s-1.34 3-3 3zm0-4h-1v2h1c.55 0 1-.45 1-1s-.45-1-1-1z"/></svg>',
        firetv: '<svg viewBox="0 0 24 24" width="20" height="20"><circle cx="12" cy="12" r="10" fill="#232F3E"/><path d="M12 5c2 3 0 4 2 6 1 1 1 3 0 4-1 2-3 2-4 1 1 0 2-1 1-2-1 2-3 1-3-1 0-2 1-3 2-4-1 0-1-1 0-2 0 0 1-1 2-2z" fill="#FF9900"/></svg>',
        chromecast: '<svg viewBox="0 0 24 24" width="20" height="20" fill="#4285F4"><path d="M0 18.5455v3.2727h3.2727c0-1.811-1.4618-3.2727-3.2727-3.2727zm0-4.3637v2.1818c3.011 0 5.4545 2.4437 5.4545 5.4546h2.1819c0-4.2218-3.4146-7.6364-7.6364-7.6364zm0-4.3636V12c5.4218 0 9.8182 4.3964 9.8182 9.8182H12c0-6.6327-5.3782-12-12-12zm21.8182-7.6364H2.1818C.9818 2.1818 0 3.1636 0 4.3636v3.2728h2.1818V4.3636h19.6364v15.2728h-7.6364v2.1818h7.6364c1.2 0 2.1818-.9818 2.1818-2.1818V4.3636c0-1.2-.9818-2.1818-2.1818-2.1818Z"/></svg>',
        appletv: '<svg viewBox="0 0 24 24" width="20" height="20" fill="#a2aaad"><path d="M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701"/></svg>',
        tizen: '<svg viewBox="0 0 24 24" width="20" height="20"><circle cx="12" cy="12" r="10" fill="#1428A0"/><ellipse cx="12" cy="12" rx="7" ry="4" fill="#fff"/><ellipse cx="12" cy="12" rx="3" ry="4" fill="#1428A0"/></svg>',
        webos: '<svg viewBox="0 0 24 24" width="20" height="20"><circle cx="12" cy="12" r="10" fill="#A50034"/><circle cx="12" cy="12" r="5.5" fill="none" stroke="#fff" stroke-width="2"/><circle cx="17" cy="9" r="1.5" fill="#fff"/></svg>',
        xbox: '<svg viewBox="0 0 24 24" width="20" height="20" fill="#107C10"><path d="M4.102 21.033C6.211 22.881 8.977 24 12 24c3.026 0 5.789-1.119 7.902-2.967 1.877-1.912-4.316-8.709-7.902-11.417-3.582 2.708-9.779 9.505-7.898 11.417zm11.16-14.406c2.5 2.961 7.484 10.313 6.076 12.912C23.002 17.48 24 14.861 24 12.004c0-3.34-1.365-6.362-3.57-8.536 0 0-.027-.022-.082-.042-.063-.022-.152-.045-.281-.045-.592 0-1.985.434-4.805 3.246zM3.654 3.426c-.057.02-.082.041-.086.042C1.365 5.642 0 8.664 0 12.004c0 2.854.998 5.473 2.661 7.533-1.401-2.605 3.579-9.951 6.08-12.91-2.82-2.813-4.216-3.245-4.806-3.245-.131 0-.223.021-.281.046v-.002zM12 3.551S9.055 1.828 6.755 1.746c-.903-.033-1.454.295-1.521.339C7.379.646 9.659 0 11.984 0H12c2.334 0 4.605.646 6.766 2.085-.068-.046-.615-.372-1.52-.339C14.946 1.828 12 3.545 12 3.545v.006z"/></svg>',
        playstation: '<svg viewBox="0 0 24 24" width="20" height="20" fill="#0070D1"><path d="M8.984 2.596v17.547l3.915 1.261V6.688c0-.69.304-1.151.794-.991.636.18.76.814.76 1.505v5.875c2.441 1.193 4.362-.002 4.362-3.152 0-3.237-1.126-4.675-4.438-5.827-1.307-.448-3.728-1.186-5.39-1.502zm4.656 16.241l6.296-2.275c.715-.258.826-.625.246-.818-.586-.192-1.637-.139-2.357.123l-4.205 1.5V14.98l.24-.085s1.201-.42 2.913-.615c1.696-.18 3.785.03 5.437.661 1.848.601 2.04 1.472 1.576 2.072-.465.6-1.622 1.036-1.622 1.036l-8.544 3.107V18.86zM1.807 18.6c-1.9-.545-2.214-1.668-1.352-2.32.801-.586 2.16-1.052 2.16-1.052l5.615-2.013v2.313L4.205 17c-.705.271-.825.632-.239.826.586.195 1.637.15 2.343-.12L8.247 17v2.074c-.12.03-.256.044-.39.073-1.939.331-3.996.196-6.038-.479z"/></svg>',
        dlna: '<svg viewBox="0 0 24 24" width="20" height="20"><circle cx="12" cy="5" r="2" fill="#8a8a8a"/><circle cx="5" cy="18" r="2" fill="#8a8a8a"/><circle cx="19" cy="18" r="2" fill="#8a8a8a"/><path d="M12 7v6M12 13 6 16M12 13l6 3" stroke="#8a8a8a" stroke-width="1.5" fill="none"/></svg>',
        swiftfin: '<svg viewBox="0 0 24 24" width="20" height="20"><circle cx="12" cy="12" r="10" fill="#0b1f3a"/><path d="M6 14c3 1 6 1 9-1-1 3-4 5-7 4.5C5.5 17 4.5 15 6 14z" fill="#FF6B57"/><path d="M8 9c3-2 7-2 10 0-2-.5-5 0-6.5 2C10 12.5 8.5 13 7 12.5 6 11.5 6.5 10 8 9z" fill="#34AADC"/></svg>',
        finamp: '<svg viewBox="0 0 1024 1024" width="20" height="20"><path d="M714.529 446.555C723.715 468.075 705.091 496.347 630.419 574.243C550.375 657.745 527.954 672.343 494.87 662.493C461.781 652.644 450.992 628.162 429.643 514.478C397.081 341.096 408.151 331.222 578.394 381.894C664.658 407.572 706.343 427.379 714.529 446.555Z" fill="#AC5FC8"/><path d="M328.327 981.999C512.498 769.508 37.2345 154.135 515.922 233.788C574.611 242.892 624.828 246.977 710.922 238.42C830.701 166.298 817.98 145.145 895 72.3472C501.958 77.1111 650.674 101.298 434.486 64.238C362.004 51.8126 255.113 22.3151 186.481 62.0322C111.95 105.162 129.258 240.433 134.543 311.906C149.935 520.03 183.782 822.738 328.31 982" fill="#03A2DB"/></svg>',
        findroid: '<svg viewBox="0 0 24 24" width="20" height="20"><circle cx="12" cy="12" r="10" fill="#0F9D58"/><polygon points="9,7.5 17,12 9,16.5" fill="#fff"/></svg>',
        streamyfin: '<svg viewBox="0 0 24 24" width="20" height="20"><defs><linearGradient id="pi-streamyfin" x1="20%" y1="10%" x2="80%" y2="90%"><stop offset="0" stop-color="#d16ce8"/><stop offset="1" stop-color="#5b1fee"/></linearGradient></defs><path d="M6.5 4.6c0-2.1 2.3-3.4 4.1-2.3l10.2 6.4c1.7 1.1 1.7 3.5 0 4.6l-10.2 6.4c-1.8 1.1-4.1-.2-4.1-2.3z" fill="url(#pi-streamyfin)"/></svg>',
        moonfin: '<svg viewBox="0 0 1024 1024" width="20" height="20"><defs><linearGradient id="pi-moonfin" x1="302.974" y1="208.6414" x2="709.6098" y2="615.2772"><stop offset="0.1" stop-color="#AA5CC3"/><stop offset="0.4" stop-color="#7672CB"/><stop offset="0.66" stop-color="#3A8CD4"/><stop offset="0.89" stop-color="#00A4DC"/></linearGradient></defs><path fill="url(#pi-moonfin)" d="M580.593,137.312c0.236,1.437-1.764,1.397-2.792,1.682c-9.692,2.687-20.11,4.17-29.967,7.043c-121.791,35.504-202.149,150.49-179.921,278.449c12.427,71.54,55.048,119.207,132.449,97.079c88.146-25.199,99.429-101.063,147.839-164.161c20.295-26.453,44.824-49.573,71.482-69.518c4.092-3.062,44.959-31.555,46.91-29.58c-4.974,18.877-12.625,36.926-17.711,55.778c-17.376,64.396-23.167,162.393,67.715,164.225l-10.013,39.99c-16.446-7.617-33.575-13.262-51.63-15.857c-31.725-4.561-68.255-0.546-99.549,6.166c-81.083,17.391-149.924,71.416-231.798,89.202c-65.253,14.176-171.515,7.963-199.029-64.993c-32.857-87.123-17.129-196.894,34.796-273.239C329.708,156.173,458.551,108.174,580.593,137.312z"/><path fill="#00A4DC" d="M796.599,546.311c-8.783,22.644-20.315,44.297-34.604,63.909c-16.913-7.035-35.708-8.954-53.939-7.959c-101.271,5.523-183.793,95.852-288.454,89.052l14.808,4.677c94.845,28.604,181.214-45.296,270.697-49.677c3.07-0.15,25.483-0.402,25.47,2.49c-42.221,42.774-97.662,73.834-156.791,86.189c-120.75,25.23-242.358-26.603-312.177-126.206l0.484-1.478c25.284,19.74,57.578,33.429,89.297,38.703c134.365,22.345,209.318-77.749,329.022-102.394C719.682,535.531,757.934,534.758,796.599,546.311z"/></svg>',
        infuse: '<svg viewBox="0 0 24 24" width="20" height="20"><circle cx="12" cy="12" r="10" fill="#1173D4"/><polygon points="9.5,7.5 17,12 9.5,16.5" fill="#fff"/></svg>',
        kodi: '<svg viewBox="0 0 24 24" width="20" height="20" fill="#17B2E7"><path d="M12.03.047c-.226 0-.452.107-.669.324-.922.922-1.842 1.845-2.763 2.768-.233.233-.455.48-.703.695-.31.267-.405.583-.399.988.02 1.399.008 2.799.008 4.198 0 1.453-.002 2.907 0 4.36 0 .11.002.223.03.327.087.337.303.393.546.15 1.31-1.31 2.618-2.622 3.928-3.933l4.449-4.453c.43-.431.43-.905 0-1.336L12.697.37c-.216-.217-.442-.324-.668-.324zm7.224 7.23c-.223 0-.445.104-.65.309L14.82 11.37c-.428.429-.427.895 0 1.322l3.76 3.766c.44.44.908.44 1.346.002 1.215-1.216 2.427-2.433 3.644-3.647.182-.18.353-.364.43-.615v-.33c-.077-.251-.246-.436-.428-.617-1.224-1.22-2.443-2.445-3.666-3.668-.205-.205-.429-.307-.652-.307zM4.18 7.611c-.086.014-.145.094-.207.157L.209 11.572c-.28.284-.278.677.004.96l2.043 2.046c.59.59 1.177 1.182 1.767 1.772.169.168.33.139.416-.084.044-.114.062-.242.063-.364.004-1.283.004-2.567.004-3.851h-.002V8.184c0-.085-.01-.169-.022-.252-.019-.135-.072-.258-.207-.309a.186.186 0 0 0-.095-.012zm7.908 6.838c-.224 0-.447.106-.656.315L7.66 18.537c-.433.434-.433.899.002 1.334 1.215 1.216 2.43 2.43 3.643 3.649.18.18.361.354.611.433h.33c.244-.069.423-.226.598-.402 1.222-1.23 2.45-2.453 3.676-3.68.43-.43.427-.905-.004-1.338l-3.772-3.773c-.208-.208-.432-.311-.656-.31z"/></svg>',
        fladder: '<svg viewBox="0 0 24 24" width="20" height="20"><circle cx="12" cy="12" r="10" fill="#F97316"/><path d="M9 7h6v2.2H11v2.3h3.4V13.5H11V17H9V7z" fill="#fff"/></svg>',
        mpvshim: '<svg viewBox="0 0 24 24" width="20" height="20"><circle cx="12" cy="12" r="10" fill="#5C6BC0"/><polygon points="9.5,7.5 17,12 9.5,16.5" fill="#fff"/></svg>',
        linux: '<svg viewBox="0 0 24 24" width="20" height="20" fill="#FCC624"><path d="M12.504 0c-.155 0-.315.008-.48.021-4.226.333-3.105 4.807-3.17 6.298-.076 1.092-.3 1.953-1.05 3.02-.885 1.051-2.127 2.75-2.716 4.521-.278.832-.41 1.684-.287 2.489a.424.424 0 00-.11.135c-.26.268-.45.6-.663.839-.199.199-.485.267-.797.4-.313.136-.658.269-.864.68-.09.189-.136.394-.132.602 0 .199.027.4.055.536.058.399.116.728.04.97-.249.68-.28 1.145-.106 1.484.174.334.535.47.94.601.81.2 1.91.135 2.774.6.926.466 1.866.67 2.616.47.526-.116.97-.464 1.208-.946.587-.003 1.23-.269 2.26-.334.699-.058 1.574.267 2.577.2.025.134.063.198.114.333l.003.003c.391.778 1.113 1.132 1.884 1.071.771-.06 1.592-.536 2.257-1.306.631-.765 1.683-1.084 2.378-1.503.348-.199.629-.469.649-.853.023-.4-.2-.811-.714-1.376v-.097l-.003-.003c-.17-.2-.25-.535-.338-.926-.085-.401-.182-.786-.492-1.046h-.003c-.059-.054-.123-.067-.188-.135a.357.357 0 00-.19-.064c.431-1.278.264-2.55-.173-3.694-.533-1.41-1.465-2.638-2.175-3.483-.796-1.005-1.576-1.957-1.56-3.368.026-2.152.236-6.133-3.544-6.139zm.529 3.405h.013c.213 0 .396.062.584.198.19.135.33.332.438.533.105.259.158.459.166.724 0-.02.006-.04.006-.06v.105a.086.086 0 01-.004-.021l-.004-.024a1.807 1.807 0 01-.15.706.953.953 0 01-.213.335.71.71 0 00-.088-.042c-.104-.045-.198-.064-.284-.133a1.312 1.312 0 00-.22-.066c.05-.06.146-.133.183-.198.053-.128.082-.264.088-.402v-.02a1.21 1.21 0 00-.061-.4c-.045-.134-.101-.2-.183-.333-.084-.066-.167-.132-.267-.132h-.016c-.093 0-.176.03-.262.132a.8.8 0 00-.205.334 1.18 1.18 0 00-.09.4v.019c.002.089.008.179.02.267-.193-.067-.438-.135-.607-.202a1.635 1.635 0 01-.018-.2v-.02a1.772 1.772 0 01.15-.768c.082-.22.232-.406.43-.533a.985.985 0 01.594-.2zm-2.962.059h.036c.142 0 .27.048.399.135.146.129.264.288.344.465.09.199.14.4.153.667v.004c.007.134.006.2-.002.266v.08c-.03.007-.056.018-.083.024-.152.055-.274.135-.393.2.012-.09.013-.18.003-.267v-.015c-.012-.133-.04-.2-.082-.333a.613.613 0 00-.166-.267.248.248 0 00-.183-.064h-.021c-.071.006-.13.04-.186.132a.552.552 0 00-.12.27.944.944 0 00-.023.33v.015c.012.135.037.2.08.334.046.134.098.2.166.268.01.009.02.018.034.024-.07.057-.117.07-.176.136a.304.304 0 01-.131.068 2.62 2.62 0 01-.275-.402 1.772 1.772 0 01-.155-.667 1.759 1.759 0 01.08-.668 1.43 1.43 0 01.283-.535c.128-.133.26-.2.418-.2zm1.37 1.706c.332 0 .733.065 1.216.399.293.2.523.269 1.052.468h.003c.255.136.405.266.478.399v-.131a.571.571 0 01.016.47c-.123.31-.516.643-1.063.842v.002c-.268.135-.501.333-.775.465-.276.135-.588.292-1.012.267a1.139 1.139 0 01-.448-.067 3.566 3.566 0 01-.322-.198c-.195-.135-.363-.332-.612-.465v-.005h-.005c-.4-.246-.616-.512-.686-.71-.07-.268-.005-.47.193-.6.224-.135.38-.271.483-.336.104-.074.143-.102.176-.131h.002v-.003c.169-.202.436-.47.839-.601.139-.036.294-.065.466-.065zm2.8 2.142c.358 1.417 1.196 3.475 1.735 4.473.286.534.855 1.659 1.102 3.024.156-.005.33.018.513.064.646-1.671-.546-3.467-1.089-3.966-.22-.2-.232-.335-.123-.335.59.534 1.365 1.572 1.646 2.757.13.535.16 1.104.021 1.67.067.028.135.06.205.067 1.032.534 1.413.938 1.23 1.537v-.043c-.06-.003-.12 0-.18 0h-.016c.151-.467-.182-.825-1.065-1.224-.915-.4-1.646-.336-1.77.465-.008.043-.013.066-.018.135-.068.023-.139.053-.209.064-.43.268-.662.669-.793 1.187-.13.533-.17 1.156-.205 1.869v.003c-.02.334-.17.838-.319 1.35-1.5 1.072-3.58 1.538-5.348.334a2.645 2.645 0 00-.402-.533 1.45 1.45 0 00-.275-.333c.182 0 .338-.03.465-.067a.615.615 0 00.314-.334c.108-.267 0-.697-.345-1.163-.345-.467-.931-.995-1.788-1.521-.63-.4-.986-.87-1.15-1.396-.165-.534-.143-1.085-.015-1.645.245-1.07.873-2.11 1.274-2.763.107-.065.037.135-.408.974-.396.751-1.14 2.497-.122 3.854a8.123 8.123 0 01.647-2.876c.564-1.278 1.743-3.504 1.836-5.268.048.036.217.135.289.202.218.133.38.333.59.465.21.201.477.335.876.335.039.003.075.006.11.006.412 0 .73-.134.997-.268.29-.134.52-.334.74-.4h.005c.467-.135.835-.402 1.044-.7zm2.185 8.958c.037.6.343 1.245.882 1.377.588.134 1.434-.333 1.791-.765l.211-.01c.315-.007.577.01.847.268l.003.003c.208.199.305.53.391.876.085.4.154.78.409 1.066.486.527.645.906.636 1.14l.003-.007v.018l-.003-.012c-.015.262-.185.396-.498.595-.63.401-1.746.712-2.457 1.57-.618.737-1.37 1.14-2.036 1.191-.664.053-1.237-.2-1.574-.898l-.005-.003c-.21-.4-.12-1.025.056-1.69.176-.668.428-1.344.463-1.897.037-.714.076-1.335.195-1.814.12-.465.308-.797.641-.984l.045-.022zm-10.814.049h.01c.053 0 .105.005.157.014.376.055.706.333 1.023.752l.91 1.664.003.003c.243.533.754 1.064 1.189 1.637.434.598.77 1.131.729 1.57v.006c-.057.744-.48 1.148-1.125 1.294-.645.135-1.52.002-2.395-.464-.968-.536-2.118-.469-2.857-.602-.369-.066-.61-.2-.723-.4-.11-.2-.113-.602.123-1.23v-.004l.002-.003c.117-.334.03-.752-.027-1.118-.055-.401-.083-.71.043-.94.16-.334.396-.4.69-.533.294-.135.64-.202.915-.47h.002v-.002c.256-.268.445-.601.668-.838.19-.201.38-.336.663-.336zm7.159-9.074c-.435.201-.945.535-1.488.535-.542 0-.97-.267-1.28-.466-.154-.134-.28-.268-.373-.335-.164-.134-.144-.333-.074-.333.109.016.129.134.199.2.096.066.215.2.36.333.292.2.68.467 1.167.467.485 0 1.053-.267 1.398-.466.195-.135.445-.334.648-.467.156-.136.149-.267.279-.267.128.016.034.134-.147.332a8.097 8.097 0 01-.69.468zm-1.082-1.583V5.64c-.006-.02.013-.042.029-.05.074-.043.18-.027.26.004.063 0 .16.067.15.135-.006.049-.085.066-.135.066-.055 0-.092-.043-.141-.068-.052-.018-.146-.008-.163-.065zm-.551 0c-.02.058-.113.049-.166.066-.047.025-.086.068-.14.068-.05 0-.13-.02-.136-.068-.01-.066.088-.133.15-.133.08-.031.184-.047.259-.005.019.009.036.03.03.05v.02h.003"/></svg>',
        smarttv: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="#9aa0a6" stroke-width="1.8"><rect x="2.5" y="5" width="19" height="12" rx="1.5"/><path d="M8 21h8M12 17v4M7 2l3 3M17 2l-3 3"/></svg>',
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
        if (c.indexOf('fladder') !== -1) return brand('fladder', 'Fladder', BRAND_SVG.fladder);
        if (c.indexOf('mpv-shim') !== -1 || c.indexOf('mpv shim') !== -1 || c.indexOf('mpvshim') !== -1) return brand('mpvshim', 'MPV Shim', BRAND_SVG.mpvshim);

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
        if (combined.indexOf('vizio') !== -1 || combined.indexOf('hisense') !== -1 || combined.indexOf('vidaa') !== -1 || combined.indexOf('bravia') !== -1) return brand('smarttv', 'Smart TV', BRAND_SVG.smarttv);

        // 2. Browser (generic/third-party web clients not identified as "Jellyfin Web")
        var browser = detectBrowserBrand(combined);
        if (browser) return browser;

        // 4. Operating system fallback
        if (combined.indexOf('android tv') !== -1 || combined.indexOf('androidtv') !== -1) return brand('androidtv', 'Android TV', BRAND_SVG.androidTv);
        if (combined.indexOf('android') !== -1) return brand('android', 'Android', BRAND_SVG.android);
        if (combined.indexOf('ios') !== -1 || combined.indexOf('iphone') !== -1 || combined.indexOf('ipad') !== -1 || combined.indexOf('apple') !== -1 ||
            combined.indexOf('macos') !== -1 || combined.indexOf('mac os') !== -1 || combined.indexOf('macbook') !== -1 ||
            combined.indexOf('imac') !== -1 || combined.indexOf('macintosh') !== -1) {
            return brand('apple', 'Apple', BRAND_SVG.apple);
        }
        if (combined.indexOf('windows') !== -1) return brand('windows', 'Windows', BRAND_SVG.windows);
        if (combined.indexOf('linux') !== -1) return brand('linux', 'Linux', BRAND_SVG.linux);

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

    /**
     * Title/subtitle/episode-label resolution, shared by the card itself and the
     * Info modal so both name the exact same thing the exact same way.
     */
    function resolveTitleParts(session, item) {
        item = item || (session && session.NowPlayingItem) || {};
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
        return { title: title, subtitle: subtitle };
    }

    function renderSessionCard(session, index, displayMode, showAllDetails, allSessions) {
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
            var titleParts = resolveTitleParts(session, item);
            var title = titleParts.title;
            var subtitle = titleParts.subtitle;

            // Unified Classification. classification.method is the pure transcode method
            // (DirectPlay/DirectStream/Remux/Transcode), never overridden by pause -- the
            // Playing/Paused state is shown as its own separate badge alongside it.
            var classification = classifyPlaybackSession(session);
            var isPaused = classification.isPaused;
            var isVideoDirect = classification.isVideoDirect;
            var isAudioDirect = classification.isAudioDirect;

            // Zombie-stream tracking: record the first time this session is observed paused,
            // clear it the moment it isn't.
            var pausedDurationMs = 0;
            if (session.Id) {
                if (isPaused) {
                    if (!state.pausedSinceBySession[session.Id]) {
                        state.pausedSinceBySession[session.Id] = Date.now();
                    }
                    pausedDurationMs = Date.now() - state.pausedSinceBySession[session.Id];
                } else {
                    delete state.pausedSinceBySession[session.Id];
                }
            }

            // Concurrent-streams-per-user: counts only sessions actually playing something,
            // grouped by the real account identity (UserId), never guessed from a display name.
            var concurrentUserStreamCount = 1;
            if (Array.isArray(allSessions) && session.UserId) {
                concurrentUserStreamCount = allSessions.filter(function (s) {
                    return s && s.UserId === session.UserId && (s.NowPlayingItem || s.MediaTitle);
                }).length;
            }

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

            // Canonical telemetry model (section 8) -- single source of truth shared with the
            // compact pill row, the extended-mode rows, and the inline "Show Details"/Info grid
            // below, so all three always agree. Computed early so bitrate/frame rate can also
            // feed the compact pill row, not just the extended rows.
            var model = buildTelemetryModel(session);

            // Per-reason severity ("red" hard-incompatible vs. "amber" soft/negotiated) and
            // which pill each one is actually about -- lets the specific offending pill
            // carry a warning ring instead of the reason only ever surfacing in the banner.
            var reasonDetails = classification.method === 'Transcode' ? getTranscodeReasonDetails(session) : [];
            var pillWarnings = summarizePillWarnings(reasonDetails);

            // Compact badge priority (section 11): Resolution, HDR/Dynamic range, Method,
            // Video codec, Bit depth, Audio format/channels, Container -- always shown,
            // wrapping onto additional lines on narrow screens rather than being cut off.
            var pills = [];
            function pushPill(targetKey, text, cls, title) {
                var warn = targetKey ? pillWarnings[targetKey] : null;
                pills.push({
                    text: text,
                    cls: cls,
                    title: warn ? (title + ' — ⚠ ' + warn.labels.join('; ')) : title,
                    warn: warn ? warn.severity : null
                });
            }

            var resPill = extractResolutionPill(item.Width || (videoStream && videoStream.Width), item.Height || (videoStream && videoStream.Height));
            if (resPill) pushPill('res', resPill, 'res', 'Resolution: ' + resPill);

            var dynRangePill = extractDynamicRangeCompactPill(videoStream);
            if (dynRangePill) pills.push({ text: dynRangePill, cls: 'hdr', title: 'Dynamic Range: ' + dynRangePill });

            pills.push({ text: methodLabel, cls: methodBadgeCls, title: 'Playback Method: ' + methodLabel });

            function formatCodecLabel(codec) {
                if (!codec) return '';
                var upper = String(codec).toUpperCase();
                if (upper === 'H264') return 'H.264';
                if (upper === 'H265') return 'HEVC';
                if (upper === 'EAC3' || upper === 'EC-3') return 'E-AC3';
                if (upper === 'TRUEHD') return 'TrueHD';
                return upper;
            }

            // Video codec: show the real source -> output conversion when transcoding
            // actually changed the codec, not just the delivered format alone -- knowing
            // only "playing as HEVC" hides exactly the fact ("...because H264 wasn't
            // supported") a viewer most wants at a glance. Falls back to the single
            // delivered value when direct (no conversion to show).
            var srcVCodec = formatCodecLabel(model.sourceVideoCodec);
            var outVCodec = formatCodecLabel(model.outputVideoCodec) || srcVCodec || formatCodecLabel(session.VideoCodec);
            if (outVCodec) {
                var vCodecConverted = Boolean(srcVCodec && srcVCodec !== outVCodec);
                var vCodecText = vCodecConverted ? (srcVCodec + '→' + outVCodec) : outVCodec;
                var vCodecTitle = vCodecConverted
                    ? ('Video Codec: source ' + srcVCodec + ', transcoded to ' + outVCodec)
                    : ('Video Codec: ' + outVCodec + ' (Direct, not re-encoded)');
                pushPill('video', vCodecText, '', vCodecTitle);
            }

            var bitDepthPill = extractBitDepthPill(videoStream);
            if (bitDepthPill) pills.push({ text: bitDepthPill, cls: '', title: 'Color Bit Depth: ' + bitDepthPill });

            var audioBadges = extractAudioBadges(audioStream);
            if (audioBadges.length > 0) {
                pushPill('audio', audioBadges[0], 'audio', 'Audio Channels: ' + audioBadges[0]);
            }

            var atmosPill = extractAtmosBadge(audioStream);
            if (atmosPill) pills.push({ text: atmosPill, cls: 'audio', title: 'Spatial Audio Format: ' + atmosPill });

            // Audio codec: same source -> output reasoning as video, and now a core pill
            // (previously Extended-only) -- Compact and Extended carry the same facts.
            var srcACodec = formatCodecLabel(model.sourceAudioCodec);
            var outACodec = formatCodecLabel(model.outputAudioCodec) || srcACodec;
            if (outACodec) {
                var aCodecConverted = Boolean(srcACodec && srcACodec !== outACodec);
                var aCodecText = aCodecConverted ? (srcACodec + '→' + outACodec) : outACodec;
                var aCodecTitle = aCodecConverted
                    ? ('Audio Codec: source ' + srcACodec + ', transcoded to ' + outACodec)
                    : ('Audio Codec: ' + outACodec + ' (Direct, not re-encoded)');
                pushPill('audio', aCodecText, 'audio', aCodecTitle);
            }

            // Container: same reasoning again -- a remux from MKV to TS is a real, useful
            // fact that a plain "TS" pill on its own doesn't convey.
            var srcContainerPill = model.sourceContainer;
            var outContainerPill = model.outputContainer || srcContainerPill || ((session.Container || (tInfo && tInfo.Container) || item.Container || '').toUpperCase() || null);
            if (outContainerPill) {
                var containerConverted = Boolean(srcContainerPill && srcContainerPill !== outContainerPill);
                var containerText = containerConverted ? (srcContainerPill + '→' + outContainerPill) : outContainerPill;
                var containerTitle = containerConverted
                    ? ('Container: source ' + srcContainerPill + ', remuxed to ' + outContainerPill)
                    : ('Container: ' + outContainerPill);
                pushPill('container', containerText, '', containerTitle);
            }

            // Quality/bandwidth and frame rate -- both already computed for the extended rows
            // and the Info grid, just not previously surfaced as a glance-level pill.
            if (model.overallBitrateStr) {
                pushPill('bitrate', model.overallBitrateStr, 'bitrate', 'Overall Bitrate: ' + model.overallBitrateStr);
            }
            if (model.frameRateStr) {
                pushPill('framerate', model.frameRateStr, '', 'Frame Rate: ' + model.frameRateStr);
            }

            // Whether subtitles are on at all is a one-glance fact worth having in Compact,
            // same reasoning as bitrate/frame rate above -- not gated to Extended.
            var subBadge = extractSubtitleBadge(session, item);
            if (subBadge) {
                var subTitle = subBadge.indexOf(':') !== -1 ? subBadge : ('Subtitle: ' + subBadge);
                // subBadge is "Sub: XXX" / "CC: XXX" -- expand just the trailing language code in
                // the hover tooltip (e.g. "Sub: Portuguese") without touching the compact pill text.
                var subLangMatch = /:\s*([A-Za-z]{2,3})$/.exec(subBadge);
                if (subLangMatch) {
                    var subFriendlyLang = getLanguageDisplayName(subLangMatch[1]);
                    if (subFriendlyLang && subFriendlyLang.toUpperCase() !== subLangMatch[1].toUpperCase()) {
                        subTitle = subTitle.slice(0, subTitle.length - subLangMatch[1].length) + subFriendlyLang;
                    }
                }
                pushPill('sub', subBadge, 'sub', subTitle);
            }

            // Network location: strictly opt-in (off by default) and populated by a separate,
            // independently-polled admin-only endpoint -- never derived from anything in this
            // session object itself, so this stays absent unless that poll has actually
            // returned a label for this exact session ID.
            var netLocLabel = session.Id ? state.networkLocationLabels[session.Id] : null;
            if (netLocLabel) {
                pills.push({ text: netLocLabel, cls: 'geo', title: 'Network Location: ' + netLocLabel });
            }

            // Only surface once paused for a while -- a normal "stepped away for a minute"
            // pause isn't a zombie stream, and flagging every brief pause would just be noise.
            if (pausedDurationMs >= 5 * 60 * 1000) {
                var pausedMinutes = Math.floor(pausedDurationMs / 60000);
                var pausedLabel = pausedMinutes >= 60
                    ? ('Paused ' + Math.floor(pausedMinutes / 60) + 'h ' + (pausedMinutes % 60) + 'm')
                    : ('Paused ' + pausedMinutes + 'm');
                var isZombie = pausedDurationMs >= ZOMBIE_STREAM_THRESHOLD_MS;
                pills.push({
                    text: pausedLabel,
                    cls: 'zombie',
                    warn: isZombie ? 'red' : 'amber',
                    title: isZombie
                        ? 'Paused for over an hour -- still holding server resources (transcode temp files, hardware encoder lock if transcoding). Consider stopping it.'
                        : 'Paused a while -- keeps holding server resources for as long as it stays open.'
                });
            }

            if (concurrentUserStreamCount > 1) {
                pills.push({
                    text: concurrentUserStreamCount + ' concurrent streams',
                    cls: 'concurrent',
                    title: 'This account has ' + concurrentUserStreamCount + ' active playback sessions right now.'
                });
            }

            var pillHtml = pills.map(function (p) {
                var warnCls = p.warn ? (' warn-' + p.warn) : '';
                var warnIcon = p.warn ? PILL_WARN_ICON : '';
                return '<span class="playback-pill ' + p.cls + warnCls + '"' + (p.title ? ' title="' + escapeHtml(p.title) + '"' : '') + '>' + warnIcon + pillIconSvg(p.cls) + escapeHtml(p.text) + '</span>';
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

            // Real-world time this session has actually been open, independent of media
            // position -- flags a session stuck at the same spot for a long time.
            var elapsedText = session.Id ? formatElapsedDuration(state.sessionStartTimes[session.Id]) : null;


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

                // Entrance-only animation (section: compact/extended transition) -- animates
                // in exactly once, the render pass right after a Compact->Extended click
                // (state.modeAnimatePending), never on an ambient poll refresh that happens
                // to land while already in Extended (which renders straight into the "open"
                // state so nothing replays/flickers every few seconds).
                var extAnimateIn = Boolean(state.modeAnimatePending);
                extendedRowsHtml = '<div class="playback-ext-rows' + (extAnimateIn ? '' : ' open') + '"' + (extAnimateIn ? ' data-anim-in="true"' : '') + '>' +
                    '<div class="playback-ext-row"><span class="playback-ext-label">Video</span><span class="' + videoBadgeCls + '">' + escapeHtml(model.isVideoDirect === false ? 'Transcode' : 'Direct') + '</span><span class="playback-ext-detail">' + (videoDetail || 'Not reported') + '</span></div>' +
                    '<div class="playback-ext-row"><span class="playback-ext-label">Audio</span><span class="' + audioBadgeCls + '">' + escapeHtml(model.isAudioDirect === false ? 'Transcode' : 'Direct') + '</span><span class="playback-ext-detail">' + (audioDetail || 'Not reported') + '</span></div>' +
                    '<div class="playback-ext-row"><span class="playback-ext-label">Subtitles</span><span class="playback-ext-detail">' + escapeHtml(model.subtitleField || 'Not active') + '</span></div>' +
                    '<div class="playback-ext-row"><span class="playback-ext-label">Container</span><span class="playback-ext-detail">' + containerDetail + '</span></div>' +
                    '<div class="playback-ext-row"><span class="playback-ext-label">HDR</span><span class="playback-ext-detail">' + escapeHtml(model.hdrStatus || 'Not reported') + '<span class="playback-ext-sep">&bull;</span>Tone mapping: ' + escapeHtml(model.hdrToSdrVal) + '</span></div>' +
                    '<div class="playback-ext-row"><span class="playback-ext-label">Engine</span><span class="playback-ext-detail">' + escapeHtml(model.hardwareEngineStr || (classification.method === 'Transcode' ? 'Not reported' : 'Not applicable')) + '</span></div>' +
                '</div>';
                // Reason is deliberately NOT a plain row here -- it's the main thing an admin
                // needs to diagnose a transcode, so it always gets the highlighted callout
                // below instead of being buried as one more line among Video/Audio/HDR/etc.
            }

            // The "why is this transcoding" highlight -- the main thing an admin needs to
            // diagnose a transcode, so it's the same prominent callout in both Compact and
            // Extended (never demoted to a plain text row), and only when actually transcoding.
            // Itemized (one line per real reason, colored by severity) rather than one flat
            // amber sentence, so a hard "codec not supported" failure reads differently from
            // a soft "bitrate throttled" limit.
            var transcodeReasonHtml = '';
            if (classification.method === 'Transcode') {
                var reasonItems = reasonDetails.length > 0 ? reasonDetails : [{ code: null, label: 'Reason not reported by server', severity: 'amber' }];
                var engineSuffix = model.hardwareEngineStr ? (' [' + model.hardwareEngineStr + ']') : '';
                var reasonRowsHtml = reasonItems.map(function (ri, idx) {
                    var sevCls = ri.severity === 'red' ? 'sev-red' : 'sev-amber';
                    var lineText = ri.label + (idx === reasonItems.length - 1 ? engineSuffix : '');
                    return '<div class="playback-transcode-reason ' + sevCls + '">' +
                        '<svg class="playback-transcode-reason-icon" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 9v4M12 17h.01M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/></svg>' +
                        '<span>' + escapeHtml(lineText) + '</span>' +
                    '</div>';
                }).join('');
                transcodeReasonHtml = '<div class="playback-transcode-reasons">' + reasonRowsHtml + '</div>';
            }

            // Info button and "Show Details" (global toggle) both reveal the same full
            // field breakdown inline on the card, grouped into titled sections (Playback/
            // Video/Audio/Stream/Subtitles) rather than one flat list -- this is the
            // original behavior, unchanged, and it's what the Info button still does
            // whenever infoViewStyle is 'down' (the default). A card with an explicit
            // override in infoOverrides follows that instead of the global value, so one
            // card can be collapsed (or expanded) independently of the rest. When
            // infoViewStyle is 'right' instead, Info opens the separate Tautulli-style
            // side panel (showInfoSidePanel) rather than toggling this at all -- a second,
            // additive option, not a replacement for this one.
            state.cardSessionMap = state.cardSessionMap || {};
            state.cardSessionMap[cardDomId] = session.Id || null;
            state.infoOverrides = state.infoOverrides || {};
            var hasOverride = Boolean(session.Id) && Object.prototype.hasOwnProperty.call(state.infoOverrides, session.Id);
            var infoIsOpenForThisCard = hasOverride ? state.infoOverrides[session.Id] : Boolean(showAllDetails);

            var showDetailsGridHtml = infoIsOpenForThisCard ? buildDrawerGroupsHtml(model) : '';

            var isSummaryOpen = (displayMode === 'extended') || infoIsOpenForThisCard;
            var detailsPanelHtml = '<div id="' + detailsDomId + '" class="playback-details-panel' + (isSummaryOpen ? ' open' : '') + '" role="region" aria-label="Stream Details">' +
                extendedRowsHtml +
                showDetailsGridHtml +
            '</div>';

            var infoBtnHtml = (state.infoViewStyle === 'right')
                ? ('<button type="button" class="playback-btn-info" data-action="toggle-info" data-card-id="' + escapeHtml(cardDomId) + '" data-session-id="' + escapeHtml(session.Id || '') + '" aria-haspopup="dialog" aria-label="View full stream details" id="btn-info-' + cardDomId + '" title="View full stream details">' +
                    '<svg class="playback-info-icon" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="12" cy="12" r="10"/><path d="M12 16v-5M12 8h.01"/></svg></button>')
                : ('<button type="button" class="playback-btn-info' + (infoIsOpenForThisCard ? ' expanded' : '') + '" data-action="toggle-info" data-card-id="' + escapeHtml(cardDomId) + '" aria-expanded="' + (infoIsOpenForThisCard ? 'true' : 'false') + '" aria-controls="' + detailsDomId + '" id="btn-info-' + cardDomId + '" aria-label="' + (infoIsOpenForThisCard ? 'Collapse' : 'Expand') + ' full technical stream details" title="' + (infoIsOpenForThisCard ? 'Collapse' : 'Expand') + ' full technical stream details">' +
                    '<svg class="playback-chevron-icon" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M6 9l6 6 6-6"/></svg></button>');

            // Admin-only session controls (Stop / Message). A deliberate, later addition to
            // the project's original read-only-observation scope -- both call Jellyfin's own
            // native Session API (Sessions/{id}/Playing/Stop, Sessions/{id}/Message) via the
            // shared ApiClient, exactly as Jellyfin-web's own remote-control features do.
            // Hidden entirely for non-admins (My Playback self-view).
            var sessionActionsHtml = '';
            if (!state.isNonAdmin && session.Id) {
                var sidAttr = escapeHtml(session.Id);
                sessionActionsHtml =
                    '<button type="button" class="playback-btn-action btn-message" data-action="send-message" data-session-id="' + sidAttr + '" aria-label="Send a message to this session" title="Send a message to this session">' +
                        '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>' +
                    '</button>' +
                    '<button type="button" class="playback-btn-action btn-stop" data-action="stop-session" data-session-id="' + sidAttr + '" aria-label="Stop this session&#39;s playback" title="Stop this session&#39;s playback">' +
                        '<svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="1.5"/></svg>' +
                    '</button>';
            }

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

            // Small watermark badge, like a TV channel bug -- a glance at any card should be
            // enough to know this data is coming from PlayInfo, not a stock Jellyfin widget.
            var brandBadgeHtml = '<div class="playback-brand-badge" aria-hidden="true">' +
                '<svg viewBox="0 0 24 24" width="11" height="11"><path d="M8 5v14l11-7z" fill="#fff"/></svg>' +
                '<span>PlayInfo</span>' +
            '</div>';

            // Progress ring on the poster corner -- glanceable completion without reading
            // the progress bar text, Tautulli-style. Only when we have a real duration to
            // measure against (not live TV / unknown-length streams).
            var posterProgressHtml = '';
            if (runtimeTicks > 0) {
                var ringPct = Math.round(percent);
                posterProgressHtml = '<div class="playback-poster-progress" aria-hidden="true">' +
                    '<svg viewBox="0 0 36 36">' +
                        '<path class="playback-poster-progress-bg" d="M18 2.5 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" fill="none" stroke-width="3"/>' +
                        '<path class="playback-poster-progress-fill" stroke-dasharray="' + ringPct + ', 100" d="M18 2.5 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" fill="none" stroke-width="3"/>' +
                    '</svg>' +
                    '<span class="playback-poster-progress-text">' + ringPct + '%</span>' +
                '</div>';
            }

            // Poster size responds to how much telemetry is showing next to it: large by
            // default (Compact, nothing expanded), medium once Extended's own icon-led
            // rows are showing, and small once either Show Details or this card's own
            // Info panel piles on the full field breakdown -- so a poster twice the
            // card's usual height never happens just because the text column grew.
            var posterSizeCls = Boolean(showDetailsGridHtml)
                ? 'poster-sm'
                : (displayMode === 'extended' ? 'poster-md' : 'poster-lg');

            return '<div class="playback-card" data-card-id="' + escapeHtml(cardDomId) + '" data-playback-card="true" data-playback-method="' + escapeHtml(classification.method) + '">' +
                '<div class="playback-card-backdrop" data-artwork-role="backdrop"' + backdropStyle + '></div>' +
                '<div class="playback-card-top">' +
                    '<div class="playback-poster-wrap ' + posterSizeCls + '">' + posterHtml + brandBadgeHtml + posterProgressHtml + '</div>' +
                    '<div class="playback-card-inner">' +
                        '<div class="playback-card-main">' +
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
                                    sessionActionsHtml +
                                    infoBtnHtml +
                                '</div>' +
                            '</div>' +
                            '<div class="playback-card-body">' +
                                '<div class="playback-card-title">' + title + '</div>' +
                                (subtitle ? '<div class="playback-card-subtitle">' + subtitle + '</div>' : '') +
                                '<div class="playback-card-progress">' +
                                    '<div class="playback-progress-bar-track">' +
                                        '<div class="playback-progress-bar-fill" style="width: ' + percent.toFixed(1) + '%;"></div>' +
                                    '</div>' +
                                    '<div class="playback-progress-times">' +
                                        '<span>' + formatTicks(positionTicks) + '</span>' +
                                        (model.etaText ? '<span class="playback-eta">ETA ' + escapeHtml(model.etaText) + (elapsedText ? ' &bull; ' + escapeHtml(elapsedText) + ' watched' : '') + '</span>' : (elapsedText ? '<span class="playback-eta">' + escapeHtml(elapsedText) + ' watched</span>' : '')) +
                                        '<span>' + formatTicks(runtimeTicks) + '</span>' +
                                    '</div>' +
                                '</div>' +
                                (pillHtml ? '<div class="playback-pill-row">' + pillHtml + '</div>' : '') +
                                transcodeReasonHtml +
                            '</div>' +
                        '</div>' +
                    '</div>' +
                '</div>' +
                detailsPanelHtml +
            '</div>';
        } catch (err) {
            console.error('[PlaybackCard] Card render error:', err);
            state.renderErrors++;
            return '<div class="playback-card error-card"><div class="playback-card-inner"><p style="color:#fca5a5;margin:0;font-size:0.85rem;">Failed to render playback card.</p></div></div>';
        }
    }

    function formatBitrate(bitsPerSecond) {
        if (typeof bitsPerSecond !== 'number' || !isFinite(bitsPerSecond) || bitsPerSecond <= 0) return null;
        if (bitsPerSecond >= 1000000) return (bitsPerSecond / 1000000).toFixed(1) + ' Mbps';
        return Math.round(bitsPerSecond / 1000) + ' kbps';
    }

    /**
     * Canonical telemetry model (section 8): normalizes a session exactly once so the
     * inline "Show Details"/Info grid's full 26-field breakdown always agrees with the
     * card/header.
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
     * Single source of truth for the canonical field list (section 8/14), grouped.
     * Consumed by the inline per-card "Show Details"/Info grid (all fields minus the
     * identity rows already shown in the card header, flattened with no group headers).
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

    function fieldRowHtml(r) {
        return '<div class="playback-info-row">' +
            '<span class="playback-info-key">' + escapeHtml(r.key) + '</span>' +
            '<span class="playback-info-val">' + r.val + '</span>' +
        '</div>';
    }

    var INLINE_GRID_SKIP_KEYS = { 'User': true, 'Client': true, 'Client Version': true, 'Device': true };

    // The "Show Details"/Info inline per-card grid: the full field set minus the identity
    // rows already shown in the card header (User/Client/Client Version/Device), flattened
    // into one grid with no group headers.
    function buildInlineDetailGridHtml(model) {
        var groups = buildFieldGroups(model);
        var rowsHtml = groups.reduce(function (acc, group) {
            group.rows.forEach(function (r) {
                if (!INLINE_GRID_SKIP_KEYS[r.key]) acc.push(fieldRowHtml(r));
            });
            return acc;
        }, []);
        return '<div class="playback-info-grid">' + rowsHtml.join('') + '</div>';
    }

    var DRAWER_GROUP_ICONS = {
        Playback: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polygon points="10 8 16 12 10 16 10 8" fill="currentColor"/></svg>',
        Video: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="4" width="20" height="14" rx="2"/><path d="M8 21h8"/></svg>',
        Audio: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 5 6 9H2v6h4l5 4V5z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/></svg>',
        Stream: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2 2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/></svg>',
        Subtitles: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="5" width="20" height="14" rx="2"/><path d="M6 15h4M13 15h5"/></svg>'
    };

    // Same field data as buildInlineDetailGridHtml, but titled and sectioned for the
    // drawer/bottom-sheet, matching the Playback/Video/Audio/Stream/Subtitles grouping
    // buildFieldGroups already produces.
    function buildDrawerGroupsHtml(model) {
        var groups = buildFieldGroups(model);
        return groups.map(function (group) {
            // Same identity-field omission as buildInlineDetailGridHtml -- User/Client/
            // Client Version/Device are already shown in the card header, so repeating
            // them here would just duplicate what a viewer already read a moment ago.
            var rowsHtml = group.rows.filter(function (r) { return !INLINE_GRID_SKIP_KEYS[r.key]; }).map(fieldRowHtml).join('');
            var icon = DRAWER_GROUP_ICONS[group.title] || '';
            return '<div class="playback-drawer-group">' +
                '<div class="playback-drawer-group-title">' + icon + '<span>' + escapeHtml(group.title.toUpperCase()) + '</span></div>' +
                '<div class="playback-info-grid">' + rowsHtml + '</div>' +
            '</div>';
        }).join('');
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

    // Prominent "at a glance" glass strip shown above the grid: total active streams
    // plus a genuine Direct/Transcoding split so admins don't have to scan every card
    // to see whether anything is actually being transcoded right now. Classified by
    // real method regardless of pause state -- unlike the header's mutually-exclusive
    // Direct Play/Direct Stream/Remux/Transcode/Paused chips, a paused Transcode session
    // must still count as "Transcoding" here, or the two totals would silently omit it.
    // Same tInfo.Bitrate -> videoStream.BitRate fallback the per-card "Overall Bitrate" pill
    // already uses -- kept in sync with that logic rather than duplicating a third copy of it.
    function getSessionBitrateBps(session) {
        if (!session || typeof session !== 'object') return 0;
        var tInfo = session.TranscodingInfo;
        if (tInfo && typeof tInfo.Bitrate === 'number' && isFinite(tInfo.Bitrate) && tInfo.Bitrate > 0) {
            return tInfo.Bitrate;
        }
        var mediaStreams = (session.NowPlayingItem && session.NowPlayingItem.MediaStreams) || [];
        for (var i = 0; i < mediaStreams.length; i++) {
            if (mediaStreams[i].Type === 'Video' && typeof mediaStreams[i].BitRate === 'number' && isFinite(mediaStreams[i].BitRate) && mediaStreams[i].BitRate > 0) {
                return mediaStreams[i].BitRate;
            }
        }
        return 0;
    }

    function buildSummaryStripHtml(activeSessions) {
        var sessions = Array.isArray(activeSessions) ? activeSessions : [];
        if (sessions.length <= 0) return '';
        var directTotal = 0;
        var transcodingTotal = 0;
        var totalBps = 0;
        var lanBps = 0;
        var wanBps = 0;
        var hasLocationData = false;
        for (var i = 0; i < sessions.length; i++) {
            var session = sessions[i];
            var m = classifyPlaybackSession(session).method;
            if (m === 'Remux' || m === 'Transcode') transcodingTotal++;
            else directTotal++;

            var bps = getSessionBitrateBps(session);
            totalBps += bps;
            // Local Network vs Remote is itself strictly opt-in (NetworkLocationDisclosure) --
            // state.networkLocationLabels stays empty when that's off, so this split degrades
            // to "unknown" (no split shown) rather than ever guessing.
            var locLabel = session && session.Id ? state.networkLocationLabels[session.Id] : null;
            if (locLabel) {
                hasLocationData = true;
                if (locLabel === 'Local Network') lanBps += bps;
                else wanBps += bps;
            }
        }
        var streamIcon = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polygon points="10 8 16 12 10 16 10 8" fill="currentColor"/></svg>';
        var directIcon = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M20 6 9 17l-5-5"/></svg>';
        var transcodeIcon = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M21 12a9 9 0 1 1-3.5-7.11"/><path d="M21 3v6h-6"/></svg>';
        var bandwidthIcon = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M4 20V10M10 20V4M16 20v-7M22 20v-3"/></svg>';

        var bandwidthHtml = '';
        if (totalBps > 0) {
            var totalMbps = (totalBps / 1000000).toFixed(1) + ' Mbps';
            var bandwidthLabel = 'Bandwidth';
            if (hasLocationData) {
                bandwidthLabel = 'LAN ' + (lanBps / 1000000).toFixed(1) + ' · WAN ' + (wanBps / 1000000).toFixed(1);
            }
            var bandwidthTitle = 'Total outbound bitrate across active sessions';
            var bandwidthWarnCls = '';
            var uploadLimit = state.uploadBandwidthLimitMbps || 0;
            if (uploadLimit > 0) {
                var relevantBps = hasLocationData ? wanBps : totalBps;
                var pctOfLimit = Math.round((relevantBps / 1000000 / uploadLimit) * 100);
                bandwidthLabel += ' (' + pctOfLimit + '% of ' + uploadLimit + ' Mbps limit)';
                bandwidthTitle += ' — ' + pctOfLimit + '% of your configured ' + uploadLimit + ' Mbps upload limit';
                if (pctOfLimit >= 100) bandwidthWarnCls = ' warn-red';
                else if (pctOfLimit >= 80) bandwidthWarnCls = ' warn-amber';
            }
            bandwidthHtml = '<div class="playback-summary-divider"></div>' +
                '<div class="playback-summary-stat stat-bandwidth' + bandwidthWarnCls + '" title="' + escapeHtml(bandwidthTitle) + '">' + bandwidthIcon +
                    '<span class="playback-summary-value">' + totalMbps + '</span>' +
                    '<span class="playback-summary-label">' + bandwidthLabel + '</span>' +
                '</div>';
        }

        return '<div class="playback-summary-strip">' +
            '<div class="playback-summary-stat">' + streamIcon +
                '<span class="playback-summary-value">' + sessions.length + '</span>' +
                '<span class="playback-summary-label">' + (sessions.length === 1 ? 'Active Stream' : 'Active Streams') + '</span>' +
            '</div>' +
            '<div class="playback-summary-divider"></div>' +
            '<div class="playback-summary-stat stat-direct">' + directIcon +
                '<span class="playback-summary-value">' + directTotal + '</span>' +
                '<span class="playback-summary-label">Direct</span>' +
            '</div>' +
            '<div class="playback-summary-divider"></div>' +
            '<div class="playback-summary-stat stat-transcode' + (transcodingTotal > 0 ? ' active' : '') + '">' + transcodeIcon +
                '<span class="playback-summary-value">' + transcodingTotal + '</span>' +
                '<span class="playback-summary-label">Transcoding</span>' +
            '</div>' + bandwidthHtml +
        '</div>';
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
        var deviceMethod = '';
        if (isPlaying) {
            var mediaTitle = escapeHtml(session.MediaTitle || (session.NowPlayingItem && session.NowPlayingItem.Name) || 'Media');
            var isPaused = session.IsPaused != null ? Boolean(session.IsPaused) : Boolean(session.PlayState && session.PlayState.IsPaused);
            deviceMethod = classifyPlaybackSession(session).method;
            if (isPaused) {
                playStatus = '<span class="playback-device-status status-paused">Paused: ' + mediaTitle + '</span>';
            } else {
                playStatus = '<span class="playback-device-status status-playing">Playing: ' + mediaTitle + '</span>';
            }
        } else {
            playStatus = '<span class="playback-device-status status-idle">Idle &bull; ' + escapeHtml(lastActive) + '</span>';
        }

        return '<div class="playback-device-card"' + (deviceMethod ? ' data-playback-method="' + escapeHtml(deviceMethod) + '"' : '') + ' data-connected-device-card="true">' +
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

        state.activeSessions = activeSessions;
        state.allSessions = connectedSessions;

        // Reset per-render card->session correlation map (rebuilt below as each card renders).
        state.cardSessionMap = {};

        var stillPresent = {};
        for (var si = 0; si < activeSessions.length; si++) {
            if (activeSessions[si] && activeSessions[si].Id) stillPresent[activeSessions[si].Id] = true;
        }

        // Drop any per-card Info override for sessions that are no longer present,
        // otherwise infoOverrides would grow forever as sessions start and stop.
        state.infoOverrides = state.infoOverrides || {};
        for (var openId in state.infoOverrides) {
            if (Object.prototype.hasOwnProperty.call(state.infoOverrides, openId) && !stillPresent[openId]) {
                delete state.infoOverrides[openId];
            }
        }

        // Record first-seen wall-clock time for any newly-observed session, and drop
        // entries for sessions that have ended.
        state.sessionStartTimes = state.sessionStartTimes || {};
        for (var si2 = 0; si2 < activeSessions.length; si2++) {
            var s2 = activeSessions[si2];
            if (s2 && s2.Id && !Object.prototype.hasOwnProperty.call(state.sessionStartTimes, s2.Id)) {
                state.sessionStartTimes[s2.Id] = Date.now();
            }
        }
        for (var startId in state.sessionStartTimes) {
            if (Object.prototype.hasOwnProperty.call(state.sessionStartTimes, startId) && !stillPresent[startId]) {
                delete state.sessionStartTimes[startId];
            }
        }

        var counts = calculateSessionCounts(activeSessions);
        var isCompact = (state.displayMode === 'compact');

        var headerHtml = '<div class="playback-dashboard-header">' +
            '<div class="playback-dashboard-title-group">' +
                '<h2 class="playback-dashboard-title">' +
                    '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polygon points="10 8 16 12 10 16 10 8" fill="currentColor"/></svg>' +
                    'NOW PLAYING' +
                    '<span class="playback-header-brand-badge">PlayInfo</span>' +
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
                '<div class="playback-mode-toggle" role="group" aria-label="Info view style">' +
                    '<button type="button" class="playback-mode-btn' + (state.infoViewStyle !== 'right' ? ' active' : '') + '" data-infoview="down" title="Info expands inline under the card (original behavior)">Down</button>' +
                    '<button type="button" class="playback-mode-btn' + (state.infoViewStyle === 'right' ? ' active' : '') + '" data-infoview="right" title="Info opens a Tautulli-style dialog with poster art and the full field list">Right</button>' +
                '</div>' +
                '<button type="button" class="playback-btn-toggle-details" data-action="toggle-all-details">' +
                    (state.showAllDetails ? 'Hide Details' : 'Show Details') +
                '</button>' +
            '</div>' +
        '</div>';

        var summaryStripHtml = buildSummaryStripHtml(activeSessions);

        var contentHtml = '';
        if (activeSessions.length === 0) {
            contentHtml = '<div class="playback-dashboard-empty">' +
                '<p>No active playback</p>' +
                '</div>';
        } else {
            var cardsHtml = activeSessions.map(function (s, idx) {
                return renderSessionCard(s, idx, state.displayMode, state.showAllDetails, activeSessions);
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

        container.innerHTML = headerHtml + summaryStripHtml + contentHtml + connectedDevicesHtml;

        // Consume the one-shot entrance-animation flag for this render pass only, so an
        // ambient poll re-render never replays it. requestAnimationFrame lets the browser
        // paint the freshly-inserted (collapsed) rows once before the "open" class is
        // added, which is what makes the max-height/opacity change on it a visible
        // transition instead of an instant, invisible jump.
        if (state.modeAnimatePending) {
            state.modeAnimatePending = false;
            if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function' && typeof container.querySelectorAll === 'function') {
                window.requestAnimationFrame(function () {
                    var pending = container.querySelectorAll('[data-anim-in="true"]');
                    for (var pi = 0; pi < pending.length; pi++) {
                        pending[pi].classList.add('open');
                        pending[pi].removeAttribute('data-anim-in');
                    }
                });
            }
        }
    }

    /**
     * Lightweight confirm/prompt modal matching the card's own "liquid glass" styling,
     * used by the Stop/Message session actions instead of native confirm()/prompt() --
     * those work, but a bare OS dialog box next to an otherwise fully custom-styled
     * widget reads as an unfinished seam. Not a general-purpose dialog system; just
     * enough for these two actions (an optional text input, Cancel, and one action button
     * that can be flagged as "danger" for the destructive Stop case).
     */
    // Quick-fill presets for the "Send Message" admin action -- fills the input for review,
    // never sends directly, so an admin can still edit before confirming.
    var MESSAGE_PRESETS = [
        'Server restarting for maintenance in 5 minutes.',
        'Please switch playback quality to reduce transcoding load.',
        'This session has been paused a long time and will be closed shortly.'
    ];

    function showActionModal(opts) {
        if (typeof document === 'undefined') return;
        var scrim = document.createElement('div');
        scrim.className = 'pi-modal-scrim';
        var modal = document.createElement('div');
        modal.className = 'pi-modal';
        var presets = Array.isArray(opts.presets) ? opts.presets : [];
        modal.innerHTML =
            '<div class="pi-modal-title">' + escapeHtml(opts.title || '') + '</div>' +
            '<div class="pi-modal-body">' + escapeHtml(opts.message || '') + '</div>' +
            (presets.length ? '<div class="pi-modal-presets">' + presets.map(function (p, i) {
                return '<button type="button" class="pi-modal-preset-btn" data-preset-index="' + i + '">' + escapeHtml(p) + '</button>';
            }).join('') + '</div>' : '') +
            (opts.showInput ? '<input type="text" class="pi-modal-input" placeholder="' + escapeHtml(opts.inputPlaceholder || '') + '" />' : '') +
            '<div class="pi-modal-actions">' +
                '<button type="button" class="pi-modal-btn pi-modal-cancel">Cancel</button>' +
                '<button type="button" class="pi-modal-btn pi-modal-confirm' + (opts.confirmVariant === 'danger' ? ' danger' : '') + '">' + escapeHtml(opts.confirmLabel || 'Confirm') + '</button>' +
            '</div>';
        scrim.appendChild(modal);
        document.body.appendChild(scrim);

        var input = modal.querySelector('.pi-modal-input');
        var confirmBtn = modal.querySelector('.pi-modal-confirm');
        var cancelBtn = modal.querySelector('.pi-modal-cancel');

        modal.querySelectorAll('.pi-modal-preset-btn').forEach(function (btn) {
            btn.addEventListener('click', function () {
                var idx = parseInt(btn.getAttribute('data-preset-index'), 10);
                if (input && presets[idx] != null) {
                    input.value = presets[idx];
                    input.focus();
                }
            });
        });

        function close() {
            document.removeEventListener('keydown', onKeydown);
            if (scrim.parentNode) scrim.parentNode.removeChild(scrim);
        }
        function confirmAction() {
            var value = input ? input.value : true;
            close();
            if (typeof opts.onConfirm === 'function') opts.onConfirm(value);
        }
        function onKeydown(e) {
            if (e.key === 'Escape') { close(); return; }
            if (e.key === 'Enter' && document.activeElement !== cancelBtn) confirmAction();
        }

        cancelBtn.addEventListener('click', close);
        confirmBtn.addEventListener('click', confirmAction);
        scrim.addEventListener('click', function (e) { if (e.target === scrim) close(); });
        document.addEventListener('keydown', onKeydown);

        if (input) input.focus(); else confirmBtn.focus();
    }

    // Only one Info modal open at a time -- clicking a different card's Info button while
    // one is already open closes it first instead of stacking overlays.
    var closeActiveInfoModal = null;

    /**
     * Single source of truth for the Tautulli-style field set (Product/Player/Quality/
     * Stream/Container/Video/Audio/Subtitle/Location/Bandwidth) shown in the right-side
     * Info panel (see showInfoSidePanel below), kept separate from the render function
     * itself so the panel's data/labels are computed in exactly one place.
     */
    function computeInfoViewData(session) {
        var item = session.NowPlayingItem || {};
        var titleParts = resolveTitleParts(session, item);
        var classification = classifyPlaybackSession(session);
        var model = buildTelemetryModel(session);

        var playState = session.PlayState || {};
        var positionTicks = (typeof session.PositionTicks === 'number' && isFinite(session.PositionTicks))
            ? session.PositionTicks
            : ((typeof playState.PositionTicks === 'number' && isFinite(playState.PositionTicks) && playState.PositionTicks > 0) ? playState.PositionTicks : 0);
        var runtimeTicks = (typeof session.RunTimeTicks === 'number' && isFinite(session.RunTimeTicks))
            ? session.RunTimeTicks
            : ((typeof item.RunTimeTicks === 'number' && isFinite(item.RunTimeTicks) && item.RunTimeTicks > 0) ? item.RunTimeTicks : 0);
        var percent = 0;
        if (typeof session.PlaybackPercentage === 'number' && isFinite(session.PlaybackPercentage)) {
            percent = Math.min(100, Math.max(0, session.PlaybackPercentage));
        } else if (runtimeTicks > 0) {
            percent = Math.min(100, Math.max(0, (positionTicks / runtimeTicks) * 100));
        }

        var reasonDetails = classification.method === 'Transcode' ? getTranscodeReasonDetails(session) : [];
        var warningsHtml = '';
        if (reasonDetails.length > 0) {
            warningsHtml = '<div class="pi-info-warnings">' + reasonDetails.map(function (ri) {
                var sevCls = ri.severity === 'red' ? 'sev-red' : 'sev-amber';
                return '<div class="pi-info-warning ' + sevCls + '">' +
                    '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 9v4M12 17h.01M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/></svg>' +
                    '<span>' + escapeHtml(ri.label) + '</span>' +
                '</div>';
            }).join('') + '</div>';
        }

        var netLocLabel = session.Id ? state.networkLocationLabels[session.Id] : null;
        var qualityVal = (classification.method === 'Transcode' ? 'Transcode' : 'Original') + (model.overallBitrateStr ? ' (' + model.overallBitrateStr + ')' : '');

        // Pure method (never collapsed to "Paused") -- Stream and State are deliberately
        // two separate fields below, same as the original Playback State/Playback Method
        // rows, so pausing a Transcode never hides *which* method it was mid-pause.
        var METHOD_LABELS_INFO = { DirectPlay: 'Direct Play', DirectStream: 'Direct Stream', Remux: 'Remux', Transcode: 'Transcode' };
        var methodVal = METHOD_LABELS_INFO[classification.method] || 'Direct Play';

        var resolutionVal = (model.sourceResolution && model.outputResolution && model.sourceResolution !== model.outputResolution)
            ? (model.sourceResolution + ' → ' + model.outputResolution)
            : (model.outputResolution || model.sourceResolution || 'Not reported');

        var videoVal = model.isVideoDirect === false
            ? ((model.sourceVideoCodec || '?') + ' → ' + (model.outputVideoCodec || model.sourceVideoCodec || '?'))
            : (model.sourceVideoCodec || 'Not reported');

        // Audio codec conversion plus channel layout in the same row (e.g. "TrueHD → AAC
        // (English 7.1)") -- the original's separate "Audio Channels / Layout" row, folded
        // in here instead of adding a whole extra field for it.
        var audioChannelsSuffix = model.audioChannelsLayout ? (' (' + model.audioChannelsLayout + ')') : '';
        var audioVal = (model.isAudioDirect === false
            ? ((model.sourceAudioCodec || '?') + ' → ' + (model.outputAudioCodec || model.sourceAudioCodec || '?'))
            : (model.sourceAudioCodec || 'Not reported')) + audioChannelsSuffix;

        var containerVal = (model.sourceContainer && model.outputContainer && model.sourceContainer !== model.outputContainer)
            ? (model.sourceContainer + ' → ' + model.outputContainer)
            : (model.outputContainer || model.sourceContainer || 'Not reported');

        // HDR status plus whether tone mapping is actually active -- the original's
        // separate "Tone Mapping / HDR Conversion" row, folded into this one instead.
        var hdrVal = (model.hdrStatus || 'Not reported') + (model.hdrToSdrVal && model.hdrToSdrVal.indexOf('Active') === 0 ? ' (Tone-mapped)' : '');

        var reasonFieldVal = model.serverReasons || (classification.method === 'Transcode' ? 'Reason not reported by server' : 'Not applicable');

        // "wide" spans both grid columns and left-aligns -- for values that can run long
        // (a joined, comma-separated Transcode Reason list), so they wrap as normal
        // paragraph text instead of cramming into one narrow right-aligned column.
        function fieldRow(key, val, bad, wide) {
            return '<div class="pi-info-field' + (wide ? ' wide' : '') + '"><span class="pi-info-field-key">' + escapeHtml(key) + '</span><span class="pi-info-field-val' + (bad ? ' bad' : '') + '">' + escapeHtml(val) + '</span></div>';
        }

        var fieldsHtml =
            fieldRow('Product', session.Client || 'Not reported') +
            fieldRow('Player', session.DeviceName || session.Client || 'Not reported') +
            fieldRow('State', model.isPaused ? 'Paused' : 'Playing') +
            fieldRow('Stream', methodVal, classification.method === 'Transcode') +
            fieldRow('Quality', qualityVal, classification.method === 'Transcode') +
            fieldRow('Resolution', resolutionVal, model.isVideoDirect === false) +
            fieldRow('Frame Rate', model.frameRateStr || 'Not reported') +
            fieldRow('Video Bitrate', model.videoBitrateStr || 'Not reported') +
            fieldRow('Audio Bitrate', model.audioBitrateStr || 'Not reported') +
            fieldRow('Bandwidth', model.overallBitrateStr || 'Not reported') +
            fieldRow('Container', containerVal) +
            fieldRow('Engine', model.hardwareEngineStr || (classification.method === 'Transcode' ? 'Not reported' : 'Not applicable')) +
            fieldRow('Video', videoVal, model.isVideoDirect === false) +
            fieldRow('Audio', audioVal, model.isAudioDirect === false) +
            fieldRow('Subtitle', model.subtitleField || 'None') +
            fieldRow('HDR', hdrVal) +
            fieldRow('Location', netLocLabel || 'Not tracked') +
            fieldRow('Transcode Reason', reasonFieldVal, classification.method === 'Transcode', true);

        return {
            titleParts: titleParts,
            classification: classification,
            model: model,
            positionTicks: positionTicks,
            runtimeTicks: runtimeTicks,
            percent: percent,
            warningsHtml: warningsHtml,
            fieldsHtml: fieldsHtml
        };
    }

    /**
     * The Tautulli-style Info dialog: a centered overlay with the poster art on the left
     * and, on the right, the same flat Product/Player/Quality/Stream/Container/Video/
     * Audio/Subtitle/Location/Bandwidth field set Tautulli's own activity popup shows,
     * plus the itemized "why transcoding" list. A standalone document.body node (same
     * pattern as showActionModal above), never part of the poll-driven card grid's
     * innerHTML, so it animates open/closed cleanly and is never touched by an ambient
     * re-render while open. This is purely additive -- it opens only while infoViewStyle
     * is 'right'; the original inline expand-down behavior (infoOverrides) is completely
     * unaffected and unchanged.
     */
    /**
     * Plain-text, sanitized per-session technical report for pasting into a forum post or
     * GitHub issue -- title, playback method, codecs, container, resolution, bitrate, hardware
     * engine, and transcode reason only. Deliberately excludes username, device name, client
     * app, and anything location-related.
     */
    function buildSessionDiagnosticText(session) {
        if (!session || typeof session !== 'object') return '';
        var item = session.NowPlayingItem || {};
        var classification = classifyPlaybackSession(session);
        var titleParts = resolveTitleParts(session, item);
        var tInfo = session.TranscodingInfo;
        var mediaStreams = item.MediaStreams || [];
        var videoStream = null;
        var audioStream = null;
        for (var i = 0; i < mediaStreams.length; i++) {
            if (!videoStream && mediaStreams[i].Type === 'Video') videoStream = mediaStreams[i];
            if (!audioStream && mediaStreams[i].Type === 'Audio') audioStream = mediaStreams[i];
        }

        var sourceContainer = (item.Container || '').toUpperCase() || 'Unknown';
        var outputContainer = (tInfo && tInfo.Container) ? tInfo.Container.toUpperCase() : sourceContainer;
        var containerLine = (outputContainer !== sourceContainer) ? (sourceContainer + ' -> ' + outputContainer) : sourceContainer;

        var sourceVideoCodec = (videoStream && videoStream.Codec ? videoStream.Codec : (session.VideoCodec || 'Unknown')).toString().toUpperCase();
        var outputVideoCodec = (tInfo && tInfo.VideoCodec ? tInfo.VideoCodec : sourceVideoCodec).toString().toUpperCase();
        var videoCodecLine = (classification.isVideoDirect === false && outputVideoCodec !== sourceVideoCodec) ? (sourceVideoCodec + ' -> ' + outputVideoCodec) : sourceVideoCodec;

        var sourceAudioCodec = (audioStream && audioStream.Codec ? audioStream.Codec : (session.AudioCodec || 'Unknown')).toString().toUpperCase();
        var outputAudioCodec = (tInfo && tInfo.AudioCodec ? tInfo.AudioCodec : sourceAudioCodec).toString().toUpperCase();
        var audioCodecLine = (classification.isAudioDirect === false && outputAudioCodec !== sourceAudioCodec) ? (sourceAudioCodec + ' -> ' + outputAudioCodec) : sourceAudioCodec;

        var resolution = (tInfo && tInfo.Width && tInfo.Height)
            ? (tInfo.Width + 'x' + tInfo.Height)
            : ((videoStream && videoStream.Width && videoStream.Height) ? (videoStream.Width + 'x' + videoStream.Height) : 'Unknown');

        var bitrateVal = (tInfo && typeof tInfo.Bitrate === 'number' && tInfo.Bitrate > 0)
            ? tInfo.Bitrate
            : ((videoStream && typeof videoStream.BitRate === 'number' && videoStream.BitRate > 0) ? videoStream.BitRate : 0);
        var bitrateLine = bitrateVal ? (bitrateVal / 1000000).toFixed(1) + ' Mbps' : 'Unknown';

        var hwEngine = (tInfo && tInfo.HardwareAccelerationType && String(tInfo.HardwareAccelerationType).toLowerCase() !== 'none')
            ? tInfo.HardwareAccelerationType
            : 'Software / none';

        var reasonDetails = getTranscodeReasonDetails(session);
        var reasonLine = reasonDetails.length > 0 ? reasonDetails.map(function (r) { return r.label; }).join('; ') : 'Not transcoding';

        return [
            'PlayInfo session diagnostic report',
            'Generated: ' + new Date().toISOString(),
            '',
            'Title: ' + (titleParts.title || 'Unknown'),
            'Play Method: ' + (classification.method || 'Unknown'),
            'Video: ' + (classification.isVideoDirect === false ? 'Transcoded' : 'Direct'),
            'Audio: ' + (classification.isAudioDirect === false ? 'Transcoded' : 'Direct'),
            'Container: ' + containerLine,
            'Video Codec: ' + videoCodecLine,
            'Audio Codec: ' + audioCodecLine,
            'Resolution: ' + resolution,
            'Bitrate: ' + bitrateLine,
            'Hardware Engine: ' + hwEngine,
            'Transcode Reason: ' + reasonLine
        ].join('\n');
    }

    function showInfoSidePanel(session) {
        if (typeof document === 'undefined' || !session) return;
        if (typeof closeActiveInfoModal === 'function') closeActiveInfoModal();

        var item = session.NowPlayingItem || {};
        var data = computeInfoViewData(session);
        var titleParts = data.titleParts;
        var model = data.model;
        var positionTicks = data.positionTicks;
        var runtimeTicks = data.runtimeTicks;
        var percent = data.percent;
        var warningsHtml = data.warningsHtml;
        var fieldsHtml = data.fieldsHtml;

        var apiClient = getApiClient();
        var art = resolveArtworkUrls(session, item, apiClient);

        var posterHtml = art.posterUrl
            ? '<img src="' + escapeHtml(art.posterUrl) + '" alt="" onerror="this.style.display=\'none\'" />'
            : '<div class="pi-info-poster-fallback"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="3" width="20" height="18" rx="3"/><path d="M7 3v18M17 3v18M2 9h20M2 15h20"/></svg></div>';

        var scrim = document.createElement('div');
        scrim.className = 'pi-info-panel-scrim';
        var panel = document.createElement('div');
        panel.className = 'pi-info-panel';
        panel.setAttribute('role', 'dialog');
        panel.setAttribute('aria-modal', 'true');
        panel.setAttribute('aria-label', (titleParts.title || 'Stream details') + ' — stream details');
        panel.innerHTML =
            '<div class="pi-info-panel-art">' +
                posterHtml +
                '<div class="pi-info-panel-art-shine"></div>' +
            '</div>' +
            '<div class="pi-info-panel-content">' +
                '<button type="button" class="pi-info-panel-copy" title="Copy a sanitized technical report for this session (no username, device, or location)">Copy Report</button>' +
                '<button type="button" class="pi-info-panel-close" aria-label="Close">' +
                    '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M6 6l12 12M18 6L6 18"/></svg>' +
                '</button>' +
                '<div class="pi-info-panel-heading">' +
                    '<div class="pi-info-panel-title">' + titleParts.title + '</div>' +
                    (titleParts.subtitle ? '<div class="pi-info-panel-subtitle">' + titleParts.subtitle + '</div>' : '') +
                '</div>' +
                warningsHtml +
                '<div class="pi-info-modal-body">' + fieldsHtml + '</div>' +
                (runtimeTicks > 0 ? (
                '<div class="pi-info-modal-progress">' +
                    '<div class="playback-progress-bar-track"><div class="playback-progress-bar-fill" style="width: ' + percent.toFixed(1) + '%;"></div></div>' +
                    '<div class="playback-progress-times">' +
                        '<span>' + formatTicks(positionTicks) + '</span>' +
                        (model.etaText ? '<span>ETA ' + escapeHtml(model.etaText) + '</span>' : '<span></span>') +
                        '<span>' + formatTicks(runtimeTicks) + '</span>' +
                    '</div>' +
                '</div>'
                ) : '') +
            '</div>';

        scrim.appendChild(panel);
        document.body.appendChild(scrim);

        function close() {
            document.removeEventListener('keydown', onKeydown);
            closeActiveInfoModal = null;
            if (typeof scrim.classList !== 'undefined' && typeof scrim.classList.remove === 'function') scrim.classList.remove('show');
            var remove = function () { if (scrim.parentNode) scrim.parentNode.removeChild(scrim); };
            if (typeof window !== 'undefined' && typeof window.setTimeout === 'function') {
                window.setTimeout(remove, 240);
            } else {
                remove();
            }
        }
        function onKeydown(e) {
            if (e.key === 'Escape') close();
        }

        closeActiveInfoModal = close;
        var closeBtn = panel.querySelector('.pi-info-panel-close');
        if (closeBtn) closeBtn.addEventListener('click', close);

        var copyBtn = panel.querySelector('.pi-info-panel-copy');
        if (copyBtn) {
            copyBtn.addEventListener('click', function () {
                var reportText = buildSessionDiagnosticText(session);
                if (!reportText) {
                    copyBtn.textContent = 'Blocked';
                } else if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
                    navigator.clipboard.writeText(reportText).then(function () {
                        copyBtn.textContent = 'Copied!';
                    }).catch(function () {
                        copyBtn.textContent = 'Failed';
                    });
                } else {
                    copyBtn.textContent = 'Unsupported';
                }
                window.setTimeout(function () { copyBtn.textContent = 'Copy Report'; }, 1800);
            });
        }
        scrim.addEventListener('click', function (e) { if (e.target === scrim) close(); });
        document.addEventListener('keydown', onKeydown);

        // Entrance animation: mount in the closed state, then flip to "show" on the next
        // frame so opacity/transform genuinely transition (a slide in from the right)
        // instead of snapping open.
        if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
            window.requestAnimationFrame(function () { scrim.classList.add('show'); });
        } else {
            scrim.classList.add('show');
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

            // Toggle mode button (Compact / Extended). Switching TO Extended plays a
            // one-shot entrance animation on the newly-revealed pill row (modeAnimatePending,
            // consumed inside renderDashboardContainer); switching back to Compact is
            // instant -- collapsing content doesn't need a matching exit flourish, and
            // avoids delaying the re-render just to choreograph one. Matched by [data-mode]
            // specifically (not the shared .playback-mode-btn class), since the Info-view
            // toggle right next to it reuses that same button styling for a different
            // control (see [data-infoview] below).
            var modeBtn = target.closest('[data-mode]');
            if (modeBtn) {
                var newMode = modeBtn.getAttribute('data-mode');
                if (newMode && newMode !== state.displayMode) {
                    state.displayMode = newMode;
                    state.modeAnimatePending = (newMode === 'extended');
                    renderDashboardContainer(container, state.activeSessions, state.allSessions);
                }
                return;
            }

            // Info view style toggle (Down / Right) -- a display preference, so it just
            // re-renders; it never touches which sessions exist or any per-session state.
            var infoViewBtn = target.closest('[data-infoview]');
            if (infoViewBtn) {
                var newInfoView = infoViewBtn.getAttribute('data-infoview');
                if (newInfoView && newInfoView !== state.infoViewStyle) {
                    state.infoViewStyle = newInfoView;
                    renderDashboardContainer(container, state.activeSessions, state.allSessions);
                }
                return;
            }

            // Toggle all details button -- clears any per-card overrides so the bulk
            // action gives a predictable, all-cards-agree result rather than leaving
            // some cards stuck on an earlier individual override.
            var allDetailsBtn = target.closest('[data-action="toggle-all-details"]');
            if (allDetailsBtn) {
                state.showAllDetails = !state.showAllDetails;
                state.infoOverrides = {};
                renderDashboardContainer(container, state.activeSessions, state.allSessions);
                return;
            }

            // Info either collapses/expands one card's own inline details grid (the
            // original behavior, unchanged, while infoViewStyle is 'down') or opens the
            // Tautulli-style side panel for that one session (a self-contained overlay,
            // never touching the poll-driven grid re-render) while it's 'right'.
            var infoBtn = target.closest('[data-action="toggle-info"]');
            if (infoBtn) {
                if (state.infoViewStyle === 'right') {
                    var infoSessionId = infoBtn.getAttribute('data-session-id');
                    var infoSession = null;
                    if (infoSessionId && Array.isArray(state.activeSessions)) {
                        for (var isi = 0; isi < state.activeSessions.length; isi++) {
                            if (state.activeSessions[isi] && state.activeSessions[isi].Id === infoSessionId) {
                                infoSession = state.activeSessions[isi];
                                break;
                            }
                        }
                    }
                    if (infoSession) showInfoSidePanel(infoSession);
                    return;
                }

                var cardId = infoBtn.getAttribute('data-card-id');
                var sessionId = cardId && state.cardSessionMap ? state.cardSessionMap[cardId] : null;
                if (sessionId) {
                    state.infoOverrides = state.infoOverrides || {};
                    var currentlyOpen = Object.prototype.hasOwnProperty.call(state.infoOverrides, sessionId)
                        ? state.infoOverrides[sessionId]
                        : Boolean(state.showAllDetails);
                    state.infoOverrides[sessionId] = !currentlyOpen;
                    renderDashboardContainer(container, state.activeSessions, state.allSessions);
                }
                return;
            }

            // Stop this session's playback -- confirm first, since it's disruptive to a
            // real person's stream. Uses Jellyfin's own Sessions/{id}/Playing/Stop endpoint
            // via the shared ApiClient, exactly as Jellyfin-web's own session controls do.
            var stopBtn = target.closest('[data-action="stop-session"]');
            if (stopBtn) {
                var stopSessionId = stopBtn.getAttribute('data-session-id');
                if (stopSessionId) {
                    showActionModal({
                        title: 'Stop Playback',
                        message: 'Stop playback for this session? Their stream will end immediately.',
                        confirmLabel: 'Stop Playback',
                        confirmVariant: 'danger',
                        onConfirm: function () {
                            var stopApiClient = getApiClient();
                            if (stopApiClient && typeof stopApiClient.sendPlayStateCommand === 'function') {
                                stopApiClient.sendPlayStateCommand(stopSessionId, 'Stop').catch(function (err) {
                                    console.error('[PlaybackCard] Failed to stop session:', err);
                                });
                            }
                        }
                    });
                }
                return;
            }

            // Send an on-screen message to this session's client, via Jellyfin's own
            // Sessions/{id}/Message endpoint.
            var messageBtn = target.closest('[data-action="send-message"]');
            if (messageBtn) {
                var messageSessionId = messageBtn.getAttribute('data-session-id');
                if (messageSessionId) {
                    showActionModal({
                        title: 'Send Message',
                        message: 'Send an on-screen message to this session.',
                        presets: MESSAGE_PRESETS,
                        showInput: true,
                        inputPlaceholder: 'Message text…',
                        confirmLabel: 'Send',
                        onConfirm: function (value) {
                            var text = (value || '').trim();
                            if (!text) return;
                            var messageApiClient = getApiClient();
                            if (messageApiClient && typeof messageApiClient.sendMessageCommand === 'function') {
                                messageApiClient.sendMessageCommand(messageSessionId, { Header: 'Message from Server', Text: text }).catch(function (err) {
                                    console.error('[PlaybackCard] Failed to send message:', err);
                                });
                            }
                        }
                    });
                }
                return;
            }
        });
    }

    // Minimal admin-authenticated GET helper, matching the same apiClient.getJSON-or-fetch
    // fallback pollSessions already uses for the personal-sessions endpoint below.
    async function fetchAdminJson(apiClient, path) {
        var url = (typeof apiClient.getUrl === 'function') ? apiClient.getUrl(path) : ('/' + path);
        if (typeof apiClient.getJSON === 'function') {
            return await apiClient.getJSON(url);
        }
        var headers = {};
        if (typeof apiClient.accessToken === 'function' && apiClient.accessToken()) {
            headers['Authorization'] = 'MediaBrowser Token="' + apiClient.accessToken() + '"';
        }
        var resp = await fetch(url, { headers: headers });
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        return await resp.json();
    }

    var NETWORK_LOCATION_CONFIG_RECHECK_MS = 60000;

    async function ensureNetworkLocationConfigLoaded(apiClient) {
        var now = Date.now();
        if (now - state.networkLocationConfigCheckedAt < NETWORK_LOCATION_CONFIG_RECHECK_MS) return;
        state.networkLocationConfigCheckedAt = now;
        try {
            var data = await fetchAdminJson(apiClient, 'PlaybackCard/Notifications/Configuration');
            state.networkLocationEnabled = Boolean(data && data.networkLocationDisclosure);
            if (!state.networkLocationEnabled) {
                state.networkLocationLabels = {};
            }
            state.uploadBandwidthLimitMbps = Number(data && data.uploadBandwidthLimitMbps) || 0;
        } catch (err) {
            // Non-critical -- leave the last known value in place rather than flapping the
            // badge on and off because of a single failed config check.
        }
    }

    async function pollNetworkLocations(apiClient) {
        if (!state.networkLocationEnabled) return;
        try {
            var data = await fetchAdminJson(apiClient, 'PlaybackCard/NetworkLocation');
            state.networkLocationLabels = (data && typeof data === 'object') ? data : {};
        } catch (err) {
            // Non-critical: badges just stay absent/stale until the next successful poll.
        }
    }

    async function pollSessions() {
        if (!isDashboardPage()) {
            stopPolling();
            return;
        }

        var apiClient = getApiClient();
        if (!apiClient) return;

        if (!state.isNonAdmin) {
            // Fire-and-forget: never let a network-location hiccup block the actual
            // session poll below.
            ensureNetworkLocationConfigLoaded(apiClient).then(function () {
                return pollNetworkLocations(apiClient);
            }).catch(function () {});
        }

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
        buildSummaryStripHtml: buildSummaryStripHtml,
        renderDashboardContainer: renderDashboardContainer,
        attachContainerEvents: attachContainerEvents,
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
        buildInlineDetailGridHtml: buildInlineDetailGridHtml,
        buildDrawerGroupsHtml: buildDrawerGroupsHtml,
        getTranscodeReasonDetails: getTranscodeReasonDetails,
        summarizePillWarnings: summarizePillWarnings,
        resolveTitleParts: resolveTitleParts,
        showActionModal: showActionModal,
        showInfoSidePanel: showInfoSidePanel,
        computeInfoViewData: computeInfoViewData,
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
