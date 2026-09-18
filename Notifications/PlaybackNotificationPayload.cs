using System;
using System.Collections.Generic;

namespace Jellyfin.Plugin.PlaybackCard.Notifications;

/// <summary>
/// Strict outbound allow-listed data transfer object for external webhook dispatches.
/// Completely excludes RemoteEndPoint, IP addresses, LAN/WAN labels, file paths,
/// internal session identifiers, auth tokens, cookies, passwords, and raw event JSON.
/// </summary>
public sealed class PlaybackNotificationPayload
{
    /// <summary>
    /// Lifecycle event type.
    /// </summary>
    public NotificationEventType EventType { get; init; }

    /// <summary>
    /// UTC timestamp of the event.
    /// </summary>
    public DateTimeOffset Timestamp { get; init; }

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
    /// Item type string.
    /// </summary>
    public string ItemType { get; init; } = string.Empty;

    /// <summary>
    /// Jellyfin username. Included ONLY when UsernameDisclosure is explicitly enabled.
    /// </summary>
    public string? Username { get; init; }

    /// <summary>
    /// Client application name. Included ONLY when ClientDeviceDisclosure is explicitly enabled.
    /// </summary>
    public string? ClientName { get; init; }

    /// <summary>
    /// Client device model. Included ONLY when ClientDeviceDisclosure is explicitly enabled.
    /// </summary>
    public string? DeviceName { get; init; }

    /// <summary>
    /// Client application version. Included ONLY when ClientDeviceDisclosure is explicitly enabled.
    /// </summary>
    public string? ApplicationVersion { get; init; }

    /// <summary>
    /// Play method (DirectPlay, DirectStream, Transcode, Remux).
    /// </summary>
    public string PlayMethod { get; init; } = string.Empty;

    /// <summary>
    /// Whether playback is paused.
    /// </summary>
    public bool IsPaused { get; init; }

    /// <summary>
    /// Playback position.
    /// </summary>
    public TimeSpan Position { get; init; }

    /// <summary>
    /// Total media runtime.
    /// </summary>
    public TimeSpan? TotalDuration { get; init; }

    /// <summary>
    /// Playback percentage (0-100).
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
    /// Video codec string.
    /// </summary>
    public string? VideoCodec { get; init; }

    /// <summary>
    /// Audio codec string.
    /// </summary>
    public string? AudioCodec { get; init; }

    /// <summary>
    /// Source container format.
    /// </summary>
    public string? SourceContainer { get; init; }

    /// <summary>
    /// Output container format.
    /// </summary>
    public string? Container { get; init; }

    /// <summary>
    /// Video resolution string.
    /// </summary>
    public string? Resolution { get; init; }

    /// <summary>
    /// Dynamic range (SDR, HDR10, HLG, Dolby Vision).
    /// </summary>
    public string? DynamicRange { get; init; }

    /// <summary>
    /// Video framerate string.
    /// </summary>
    public string? FrameRate { get; init; }

    /// <summary>
    /// Audio channels label.
    /// </summary>
    public string? AudioChannels { get; init; }

    /// <summary>
    /// Audio language.
    /// </summary>
    public string? AudioLanguage { get; init; }

    /// <summary>
    /// Subtitle language or active CC.
    /// </summary>
    public string? SubtitleLanguage { get; init; }

    /// <summary>
    /// Media bitrate.
    /// </summary>
    public long? Bitrate { get; init; }

    /// <summary>
    /// Hardware transcoder engine (e.g., NVENC, QSV, VAAPI, AMF, or Software).
    /// Only present when explicitly reported by the server.
    /// </summary>
    public string? TranscodeEngine { get; init; }

    /// <summary>
    /// Raw transcode reason flags.
    /// </summary>
    public IReadOnlyList<string> TranscodeReasons { get; init; } = Array.Empty<string>();

    /// <summary>
    /// Mapped human-readable explanation of why transcoding is occurring, or "Reason not reported by server".
    /// </summary>
    public string TranscodeReasonsWhy { get; init; } = "Reason not reported by server";

    /// <summary>
    /// Builds the synthetic payload used by the Discord/Telegram "Test" button, so an admin can
    /// verify a webhook/bot token is wired up correctly without waiting for a real playback event.
    /// </summary>
    public static PlaybackNotificationPayload CreateSyntheticTest() => new()
    {
        EventType = NotificationEventType.Start,
        Timestamp = DateTimeOffset.UtcNow,
        MediaTitle = "Synthetic Test Stream (2026)",
        ItemType = "Movie",
        PlayMethod = "DirectPlay",
        Position = TimeSpan.FromMinutes(12),
        TotalDuration = TimeSpan.FromHours(2),
        PlaybackPercentage = 10,
        VideoStatus = "Video Direct",
        AudioStatus = "Audio Direct",
        IsVideoDirect = true,
        IsAudioDirect = true,
        VideoCodec = "HEVC",
        AudioCodec = "EAC3",
        Container = "MKV",
        Resolution = "3840x2160",
        DynamicRange = "HDR10",
        AudioChannels = "5.1",
        Bitrate = 18_500_000,
        TranscodeReasonsWhy = "Reason not reported by server"
    };
}
