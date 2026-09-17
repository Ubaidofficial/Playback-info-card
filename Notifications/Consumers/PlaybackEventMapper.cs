using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Session;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.Session;

namespace Jellyfin.Plugin.PlaybackCard.Notifications.Consumers;

/// <summary>
/// Safe mapper that projects Jellyfin SessionInfo and BaseItem into a minimal internal PlaybackEventRecord.
/// Strictly enforces privacy-by-omission: never touches or maps RemoteEndPoint, IP addresses,
/// file paths, auth tokens, cookies, or raw session JSON.
/// Accurately derives truthful video/audio direct status, remux distinction, and transcode reasons.
/// </summary>
public static class PlaybackEventMapper
{
    public static PlaybackEventRecord Map(
        NotificationEventType eventType,
        SessionInfo? session,
        BaseItem? item,
        long? playbackPositionTicks = null,
        bool isPaused = false,
        bool playedToCompletion = false)
    {
        var sessionId = session?.Id;
        var userId = session?.UserId.ToString();
        var username = session?.UserName;
        var clientName = session?.Client ?? "Unknown Client";
        var deviceName = session?.DeviceName ?? "Unknown Device";
        var appVersion = session?.ApplicationVersion ?? string.Empty;

        // Fallback internal key if PlaySessionId is absent
        var internalKey = !string.IsNullOrEmpty(sessionId)
            ? sessionId
            : $"fallback:{userId ?? "anon"}:{item?.Id.ToString() ?? "unknown"}:{clientName}";

        var mediaTitle = item?.Name ?? "Unknown Title";
        string? seriesName = null;
        int? seasonNumber = null;
        int? episodeNumber = null;
        int? productionYear = item?.ProductionYear;
        var itemType = item?.GetType().Name ?? "Unknown";

        if (item is Episode episode)
        {
            seriesName = episode.SeriesName;
            seasonNumber = episode.ParentIndexNumber;
            episodeNumber = episode.IndexNumber;
        }
        else if (item != null)
        {
            seasonNumber = item.ParentIndexNumber;
            episodeNumber = item.IndexNumber;
        }

        // Position and duration calculation
        var positionTicks = playbackPositionTicks ?? session?.PlayState?.PositionTicks ?? 0;
        var position = TimeSpan.FromTicks(Math.Max(0, positionTicks));

        TimeSpan? totalDuration = null;
        if (item?.RunTimeTicks.HasValue == true && item.RunTimeTicks.Value > 0)
        {
            totalDuration = TimeSpan.FromTicks(item.RunTimeTicks.Value);
        }

        int? percentage = null;
        if (totalDuration.HasValue && totalDuration.Value.TotalSeconds > 0)
        {
            var pct = (int)Math.Clamp(Math.Round(position.TotalSeconds / totalDuration.Value.TotalSeconds * 100.0), 0, 100);
            percentage = pct;
        }

        // Stream telemetry extraction
        string? videoCodec = null;
        string? audioCodec = null;
        string? sourceContainer = item?.Container;
        string? outputContainer = null;
        string? resolution = null;
        string? dynamicRange = null;
        string? frameRate = null;
        string? audioChannels = null;
        string? audioLanguage = null;
        string? subtitleLanguage = null;
        long? bitrate = null;
        string? transcodeEngine = null;
        var rawTranscodeReasons = new List<string>();

        bool? isVideoDirect = null;
        bool? isAudioDirect = null;
        var isContainerRemux = false;

        var tInfo = session?.TranscodingInfo;
        var rawPlayMethod = session?.PlayState?.PlayMethod;

        if (tInfo != null)
        {
            outputContainer = tInfo.Container;
            if (!string.IsNullOrEmpty(tInfo.VideoCodec)) videoCodec = tInfo.VideoCodec;
            if (!string.IsNullOrEmpty(tInfo.AudioCodec)) audioCodec = tInfo.AudioCodec;
            if (tInfo.Bitrate.HasValue && tInfo.Bitrate.Value > 0) bitrate = tInfo.Bitrate.Value;

            if (tInfo.Width.HasValue && tInfo.Height.HasValue)
            {
                resolution = $"{tInfo.Width.Value}x{tInfo.Height.Value}";
            }

            if (tInfo.Framerate.HasValue && tInfo.Framerate.Value > 0)
            {
                frameRate = string.Format(CultureInfo.InvariantCulture, "{0:F2} fps", tInfo.Framerate.Value);
            }

            if (tInfo.AudioChannels.HasValue)
            {
                audioChannels = FormatAudioChannels(tInfo.AudioChannels.Value);
            }

            var hwType = tInfo.HardwareAccelerationType.ToString();
            if (!string.IsNullOrWhiteSpace(hwType) && !hwType.Equals("none", StringComparison.OrdinalIgnoreCase))
            {
                transcodeEngine = hwType;
            }

            isVideoDirect = tInfo.IsVideoDirect;
            isAudioDirect = tInfo.IsAudioDirect;

            // Remux detection: video and audio direct, but container differs or remux indicated
            if (tInfo.IsVideoDirect && tInfo.IsAudioDirect)
            {
                isContainerRemux = true;
            }
            else if (tInfo.IsVideoDirect && !string.IsNullOrEmpty(tInfo.Container) && !string.IsNullOrEmpty(sourceContainer) &&
                     !tInfo.Container.Equals(sourceContainer, StringComparison.OrdinalIgnoreCase))
            {
                isContainerRemux = true;
            }

            var reasonsStr = tInfo.TranscodeReasons.ToString();
            if (!string.IsNullOrWhiteSpace(reasonsStr) && !reasonsStr.Equals("0", StringComparison.OrdinalIgnoreCase) && !reasonsStr.Equals("None", StringComparison.OrdinalIgnoreCase))
            {
                var split = reasonsStr.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
                rawTranscodeReasons.AddRange(split);
            }
        }
        else if (rawPlayMethod == PlayMethod.DirectPlay)
        {
            isVideoDirect = true;
            isAudioDirect = true;
        }

        // Determine derived PlayMethod
        string playMethod;
        if (isContainerRemux)
        {
            playMethod = "Remux";
        }
        else if (rawPlayMethod == PlayMethod.DirectPlay)
        {
            playMethod = "DirectPlay";
        }
        else if (rawPlayMethod == PlayMethod.DirectStream)
        {
            playMethod = "DirectStream";
        }
        else if (rawPlayMethod == PlayMethod.Transcode || tInfo != null)
        {
            playMethod = "Transcode";
        }
        else
        {
            playMethod = rawPlayMethod.HasValue ? rawPlayMethod.Value.ToString() : "Unavailable";
        }

        // Derive truthful VideoStatus and AudioStatus
        var videoStatus = isVideoDirect.HasValue
            ? (isVideoDirect.Value ? "Video Direct" : "Video Transcoded")
            : (playMethod == "DirectPlay" ? "Video Direct" : "Video status unavailable");

        var audioStatus = isAudioDirect.HasValue
            ? (isAudioDirect.Value ? "Audio Direct" : "Audio Transcoded")
            : (playMethod == "DirectPlay" ? "Audio Direct" : "Audio status unavailable");

        // Map truthful "Why" transcode reasons
        var transcodeReasonsWhy = MapTranscodeReasons(rawTranscodeReasons);

        // Fallback: extract from item media streams if not populated by transcode info
        IReadOnlyList<MediaStream>? streams = null;
        try
        {
            streams = item?.GetMediaStreams();
        }
        catch
        {
            streams = null;
        }

        if (streams != null)
        {
            var videoStream = streams.FirstOrDefault(s => s.Type == MediaStreamType.Video);
            if (videoStream != null)
            {
                if (string.IsNullOrEmpty(videoCodec)) videoCodec = videoStream.Codec;
                if (string.IsNullOrEmpty(resolution) && videoStream.Width.HasValue && videoStream.Height.HasValue)
                {
                    resolution = $"{videoStream.Width.Value}x{videoStream.Height.Value}";
                }
                if (!string.IsNullOrEmpty(videoStream.VideoRange.ToString()))
                {
                    dynamicRange = videoStream.VideoRange.ToString();
                }
                if (string.IsNullOrEmpty(frameRate))
                {
                    if (videoStream.RealFrameRate.HasValue && videoStream.RealFrameRate.Value > 0)
                    {
                        frameRate = string.Format(CultureInfo.InvariantCulture, "{0:F2} fps", videoStream.RealFrameRate.Value);
                    }
                    else if (videoStream.AverageFrameRate.HasValue && videoStream.AverageFrameRate.Value > 0)
                    {
                        frameRate = string.Format(CultureInfo.InvariantCulture, "{0:F2} fps", videoStream.AverageFrameRate.Value);
                    }
                }
            }

            var audioStream = streams.FirstOrDefault(s => s.Type == MediaStreamType.Audio);
            if (audioStream != null)
            {
                if (string.IsNullOrEmpty(audioCodec)) audioCodec = audioStream.Codec;
                if (string.IsNullOrEmpty(audioChannels) && audioStream.Channels.HasValue)
                {
                    audioChannels = FormatAudioChannels(audioStream.Channels.Value);
                }
                if (string.IsNullOrEmpty(audioLanguage)) audioLanguage = audioStream.Language;
            }

            var subStream = streams.FirstOrDefault(s => s.Type == MediaStreamType.Subtitle);
            if (subStream != null)
            {
                subtitleLanguage = subStream.Language;
            }

            if (bitrate == null && videoStream?.BitRate.HasValue == true)
            {
                bitrate = videoStream.BitRate.Value;
            }
        }

        return new PlaybackEventRecord
        {
            InternalSessionKey = internalKey,
            EventType = eventType,
            Timestamp = DateTimeOffset.UtcNow,
            MediaTitle = mediaTitle,
            SeriesName = seriesName,
            SeasonNumber = seasonNumber,
            EpisodeNumber = episodeNumber,
            ProductionYear = productionYear,
            ItemType = itemType,
            UserId = userId,
            Username = username,
            ClientName = clientName,
            DeviceName = deviceName,
            ApplicationVersion = appVersion,
            PlayMethod = playMethod,
            IsPaused = isPaused,
            Position = position,
            TotalDuration = totalDuration,
            PlaybackPercentage = percentage,
            IsVideoDirect = isVideoDirect,
            IsAudioDirect = isAudioDirect,
            IsContainerRemux = isContainerRemux,
            VideoStatus = videoStatus,
            AudioStatus = audioStatus,
            VideoCodec = videoCodec,
            AudioCodec = audioCodec,
            SourceContainer = sourceContainer,
            Container = outputContainer ?? sourceContainer,
            Resolution = resolution,
            DynamicRange = dynamicRange,
            FrameRate = frameRate,
            AudioChannels = audioChannels,
            AudioLanguage = audioLanguage,
            SubtitleLanguage = subtitleLanguage,
            Bitrate = bitrate,
            TranscodeEngine = transcodeEngine,
            TranscodeReasons = rawTranscodeReasons,
            TranscodeReasonsWhy = transcodeReasonsWhy,
            PlayedToCompletion = playedToCompletion
        };
    }

    private static string FormatAudioChannels(int channels)
    {
        return channels switch
        {
            1 => "Mono",
            2 => "Stereo",
            6 => "5.1",
            8 => "7.1",
            _ => $"{channels}ch"
        };
    }

    public static string MapTranscodeReasons(IReadOnlyList<string> reasons)
    {
        if (reasons == null || reasons.Count == 0)
        {
            return "Reason not reported by server";
        }

        var mapped = new List<string>(reasons.Count);
        foreach (var r in reasons)
        {
            var friendly = r switch
            {
                "ContainerNotSupported" => "Container unsupported",
                "VideoCodecNotSupported" => "Video codec unsupported",
                "AudioCodecNotSupported" => "Audio codec unsupported",
                "SubtitleCodecNotSupported" => "Subtitle incompatibility",
                "AudioIsExternal" => "External audio stream",
                "SecondaryAudioNotSupported" => "Secondary audio unsupported",
                "VideoProfileNotSupported" => "Video profile unsupported",
                "VideoLevelNotSupported" => "Video level unsupported",
                "VideoResolutionNotSupported" => "Resolution unsupported",
                "VideoBitDepthNotSupported" => "Bit depth unsupported",
                "VideoFramerateNotSupported" => "Frame rate unsupported",
                "RefFramesNotSupported" => "Reference frames unsupported",
                "AnamorphicVideoNotSupported" => "Anamorphic video unsupported",
                "InterlacedVideoNotSupported" => "Interlaced video unsupported",
                "AudioChannelsNotSupported" => "Audio channel limit",
                "AudioProfileNotSupported" => "Audio profile unsupported",
                "AudioSampleRateNotSupported" => "Audio sample rate unsupported",
                "AudioBitDepthNotSupported" => "Audio bit depth unsupported",
                "ContainerBitrateExceedsLimit" => "Container bitrate limit exceeded",
                "VideoBitrateNotSupported" => "Video bitrate limit exceeded",
                "AudioBitrateNotSupported" => "Audio bitrate limit exceeded",
                "UnknownVideoStreamInfo" => "Unknown video stream info",
                "UnknownAudioStreamInfo" => "Unknown audio stream info",
                "DirectPlayError" => "Direct play error",
                "VideoRangeTypeNotSupported" => "Video range/HDR incompatibility",
                _ => System.Text.RegularExpressions.Regex.Replace(r, "(\\B[A-Z])", " $1")
            };
            mapped.Add(friendly);
        }

        return string.Join(", ", mapped);
    }
}
