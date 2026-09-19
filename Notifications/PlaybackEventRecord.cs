using System;
using System.Collections.Generic;

namespace Jellyfin.Plugin.PlaybackCard.Notifications;

/// <summary>
/// Internal, transient representation of a playback event.
/// Held in-memory only for filtering, deduplication, and coalescing.
/// Never exported to outbound webhook bodies or serialized externally.
/// </summary>
public sealed class PlaybackEventRecord
{
    /// <summary>
    /// Internal unique session key derived from ephemeral session or fallback composite key.
    /// Used only in-memory for progress coalescing and deduplication.
    /// </summary>
    internal string InternalSessionKey { get; init; } = string.Empty;

    /// <summary>
    /// The playback event type.
    /// </summary>
    public NotificationEventType EventType { get; init; }

    /// <summary>
    /// UTC timestamp of the event.
    /// </summary>
    public DateTimeOffset Timestamp { get; init; } = DateTimeOffset.UtcNow;

    /// <summary>
    /// Media title.
    /// </summary>
    public string MediaTitle { get; init; } = string.Empty;

    /// <summary>
    /// Series name if episode.
    /// </summary>
    public string? SeriesName { get; init; }

    /// <summary>
    /// Season index if episode.
    /// </summary>
    public int? SeasonNumber { get; init; }

    /// <summary>
    /// Episode index if episode.
    /// </summary>
    public int? EpisodeNumber { get; init; }

    /// <summary>
    /// Production year if available.
    /// </summary>
    public int? ProductionYear { get; init; }

    /// <summary>
    /// Item type string (e.g. Movie, Episode, Audio).
    /// </summary>
    public string ItemType { get; init; } = string.Empty;

    /// <summary>
    /// Jellyfin user ID.
    /// </summary>
    public string? UserId { get; init; }

    /// <summary>
    /// Jellyfin username.
    /// </summary>
    public string? Username { get; init; }

    /// <summary>
    /// Client app title reported by client.
    /// </summary>
    public string ClientName { get; init; } = string.Empty;

    /// <summary>
    /// Client device model reported by client.
    /// </summary>
    public string DeviceName { get; init; } = string.Empty;

    /// <summary>
    /// Client application version reported by client.
    /// </summary>
    public string ApplicationVersion { get; init; } = string.Empty;

    /// <summary>
    /// Playback method (DirectPlay, DirectStream, Transcode, Remux).
    /// </summary>
    public string PlayMethod { get; init; } = string.Empty;

    /// <summary>
    /// Whether playback is currently paused.
    /// </summary>
    public bool IsPaused { get; init; }

    /// <summary>
    /// Current playback position.
    /// </summary>
    public TimeSpan Position { get; init; } = TimeSpan.Zero;

    /// <summary>
    /// Total media runtime.
    /// </summary>
    public TimeSpan? TotalDuration { get; init; }

    /// <summary>
    /// Playback progress percentage (0-100).
    /// </summary>
    public int? PlaybackPercentage { get; init; }

    /// <summary>
    /// Whether video is direct stream/copy without re-encoding.
    /// </summary>
    public bool? IsVideoDirect { get; init; }

    /// <summary>
    /// Whether audio is direct stream/copy without re-encoding.
    /// </summary>
    public bool? IsAudioDirect { get; init; }

    /// <summary>
    /// Whether this is a container remux (video and audio direct, but container changed).
    /// </summary>
    public bool IsContainerRemux { get; init; }

    /// <summary>
    /// Truthful video stream status ("Video Direct", "Video Transcoded", or "Video status unavailable").
    /// </summary>
    public string VideoStatus { get; init; } = "Video status unavailable";

    /// <summary>
    /// Truthful audio stream status ("Audio Direct", "Audio Transcoded", or "Audio status unavailable").
    /// </summary>
    public string AudioStatus { get; init; } = "Audio status unavailable";

    /// <summary>
    /// Video codec string if supplied.
    /// </summary>
    public string? VideoCodec { get; init; }

    /// <summary>
    /// Audio codec string if supplied.
    /// </summary>
    public string? AudioCodec { get; init; }

    /// <summary>
    /// Source container format if supplied.
    /// </summary>
    public string? SourceContainer { get; init; }

    /// <summary>
    /// Output container format if supplied.
    /// </summary>
    public string? Container { get; init; }

    /// <summary>
    /// Video resolution string (e.g. 1920x1080).
    /// </summary>
    public string? Resolution { get; init; }

    /// <summary>
    /// Dynamic range (SDR, HDR10, Dolby Vision).
    /// </summary>
    public string? DynamicRange { get; init; }

    /// <summary>
    /// Video framerate string.
    /// </summary>
    public string? FrameRate { get; init; }

    /// <summary>
    /// Audio channels label (e.g. 5.1, Stereo).
    /// </summary>
    public string? AudioChannels { get; init; }

    /// <summary>
    /// Audio stream language.
    /// </summary>
    public string? AudioLanguage { get; init; }

    /// <summary>
    /// Active subtitle language.
    /// </summary>
    public string? SubtitleLanguage { get; init; }

    /// <summary>
    /// Total media/stream bitrate in bps if supplied.
    /// </summary>
    public long? Bitrate { get; init; }

    /// <summary>
    /// Hardware transcode engine (e.g. NVENC, QSV, VAAPI, AMF, Software).
    /// </summary>
    public string? TranscodeEngine { get; init; }

    /// <summary>
    /// Transcode reasons supplied by Jellyfin transcode telemetry.
    /// </summary>
    public IReadOnlyList<string> TranscodeReasons { get; init; } = Array.Empty<string>();

    /// <summary>
    /// Mapped human-readable explanation of why transcoding is occurring, or "Reason not reported by server".
    /// </summary>
    public string TranscodeReasonsWhy { get; init; } = "Reason not reported by server";

    /// <summary>
    /// Whether item was played to completion.
    /// </summary>
    public bool PlayedToCompletion { get; init; }

    /// <summary>
    /// On-disk path to the item's cached Primary image, if one exists locally. Internal only,
    /// like <see cref="InternalSessionKey"/> -- this is a local file path, which must never reach
    /// <see cref="PlaybackNotificationPayload"/> (the strict outbound allow-listed DTO explicitly
    /// documented to exclude file paths). Senders read the bytes from this path themselves, right
    /// before dispatch, rather than this record or the payload ever carrying raw image bytes.
    /// </summary>
    internal string? PrimaryImagePath { get; init; }

    /// <summary>
    /// Projects this internal event record to the strict outbound allow-listed DTO.
    /// Strictly excludes RemoteEndPoint, IP addresses, internal session identifiers,
    /// file paths, auth tokens, and raw session objects.
    /// </summary>
    public PlaybackNotificationPayload ToOutboundPayload(bool includeUsername, bool includeClientDevice)
    {
        return new PlaybackNotificationPayload
        {
            EventType = EventType,
            Timestamp = Timestamp,
            MediaTitle = MediaTitle,
            SeriesName = SeriesName,
            SeasonNumber = SeasonNumber,
            EpisodeNumber = EpisodeNumber,
            ProductionYear = ProductionYear,
            ItemType = ItemType,
            Username = includeUsername ? Username : null,
            ClientName = includeClientDevice ? ClientName : null,
            DeviceName = includeClientDevice ? DeviceName : null,
            ApplicationVersion = includeClientDevice ? ApplicationVersion : null,
            PlayMethod = PlayMethod,
            IsPaused = IsPaused,
            Position = Position,
            TotalDuration = TotalDuration,
            PlaybackPercentage = PlaybackPercentage,
            IsVideoDirect = IsVideoDirect,
            IsAudioDirect = IsAudioDirect,
            IsContainerRemux = IsContainerRemux,
            VideoStatus = VideoStatus,
            AudioStatus = AudioStatus,
            VideoCodec = VideoCodec,
            AudioCodec = AudioCodec,
            SourceContainer = SourceContainer,
            Container = Container,
            Resolution = Resolution,
            DynamicRange = DynamicRange,
            FrameRate = FrameRate,
            AudioChannels = AudioChannels,
            AudioLanguage = AudioLanguage,
            SubtitleLanguage = SubtitleLanguage,
            Bitrate = Bitrate,
            TranscodeEngine = TranscodeEngine,
            TranscodeReasons = TranscodeReasons,
            TranscodeReasonsWhy = TranscodeReasonsWhy
        };
    }
}
