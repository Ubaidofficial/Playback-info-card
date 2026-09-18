using System;
using System.Collections.Generic;
using System.Linq;
using System.Security.Claims;
using Jellyfin.Plugin.PlaybackCard.Notifications.Consumers;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Session;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Session;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;

namespace Jellyfin.Plugin.PlaybackCard.Controllers;

/// <summary>
/// Authenticated user-facing controller for the "My Playback" personal monitor.
/// Accessible by any authenticated Jellyfin user (non-admin and admin).
/// Determines the current user strictly from the server-side ClaimsPrincipal.
/// Completely filters sessions server-side before serialization, guaranteeing that
/// users can only access their own active playback streams and never other users' data.
/// Strictly omits IP addresses, RemoteEndPoint, file paths, tokens, and network labels.
/// </summary>
[ApiController]
[Route("PlaybackCard/Self")]
[Route("PlaybackInfoCard/Self")]
[Authorize]
public class PlaybackSelfSessionsController : ControllerBase
{
    private readonly ISessionManager _sessionManager;

    public PlaybackSelfSessionsController(ISessionManager sessionManager)
    {
        _sessionManager = sessionManager;
    }

    /// <summary>
    /// Retrieves active playback sessions belonging strictly to the currently authenticated user.
    /// Never accepts or honors client-supplied user identifiers.
    /// </summary>
    [HttpGet("Sessions")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status401Unauthorized)]
    public ActionResult<IReadOnlyList<UserPlaybackSessionDto>> GetSelfSessions()
    {
        var currentUserId = GetCurrentUserId();
        if (!currentUserId.HasValue)
        {
            return Unauthorized(new { error = "Unauthorized", message = "Could not resolve authenticated user ID from context." });
        }

        var userGuid = currentUserId.Value;
        var activeSessions = _sessionManager.Sessions
            .Where(s => s.UserId == userGuid && s.NowPlayingItem != null)
            .ToList();

        var result = new List<UserPlaybackSessionDto>(activeSessions.Count);
        foreach (var session in activeSessions)
        {
            result.Add(MapSessionToDto(session));
        }

        return Ok(result);
    }

    private Guid? GetCurrentUserId()
    {
        if (User?.Identity?.IsAuthenticated != true)
        {
            return null;
        }

        // Strictly use the official Jellyfin authenticated user claim only.
        // Do not trust generic UserId, sub, ClaimTypes.NameIdentifier, or arbitrary fallback claims in production.
        var claim = User.FindFirst("Jellyfin-UserId");
        if (claim != null && Guid.TryParse(claim.Value, out var guid) && guid != Guid.Empty)
        {
            return guid;
        }

        return null;
    }

    private static UserPlaybackSessionDto MapSessionToDto(SessionInfo session)
    {
        var item = session.NowPlayingItem;
        var playState = session.PlayState;
        var tInfo = session.TranscodingInfo;

        var title = item?.Name ?? "Unknown Media";
        var seriesName = item?.SeriesName;
        var seasonNumber = item?.ParentIndexNumber;
        var episodeNumber = item?.IndexNumber;
        var productionYear = item?.ProductionYear;

        var positionTicks = playState?.PositionTicks ?? 0;
        var runTimeTicks = item?.RunTimeTicks ?? 0;
        var percent = 0;
        if (runTimeTicks > 0)
        {
            percent = (int)Math.Clamp(Math.Round((double)positionTicks / runTimeTicks * 100.0), 0, 100);
        }

        string? videoCodec = null;
        string? audioCodec = null;
        string? container = item?.Container;
        string? resolution = null;
        string? transcodeEngine = null;
        var rawReasons = new List<string>();

        var rawMethod = playState?.PlayMethod;

        if (tInfo != null)
        {
            container = tInfo.Container ?? container;
            videoCodec = tInfo.VideoCodec;
            audioCodec = tInfo.AudioCodec;

            if (tInfo.Width.HasValue && tInfo.Height.HasValue)
            {
                resolution = $"{tInfo.Width.Value}x{tInfo.Height.Value}";
            }

            var hw = tInfo.HardwareAccelerationType.ToString();
            if (!string.IsNullOrWhiteSpace(hw) && !hw.Equals("none", StringComparison.OrdinalIgnoreCase))
            {
                transcodeEngine = hw;
            }

            var rStr = tInfo.TranscodeReasons.ToString();
            if (!string.IsNullOrWhiteSpace(rStr) && !rStr.Equals("0", StringComparison.OrdinalIgnoreCase) && !rStr.Equals("None", StringComparison.OrdinalIgnoreCase))
            {
                rawReasons.AddRange(rStr.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries));
            }
        }

        var classification = PlaybackEventMapper.ClassifyPlayback(tInfo, rawMethod);
        var isVideoDirect = classification.IsVideoDirect;
        var isAudioDirect = classification.IsAudioDirect;
        var isRemux = classification.IsContainerRemux;
        var playMethod = classification.PlayMethod;
        var videoStatus = classification.VideoStatus;
        var audioStatus = classification.AudioStatus;

        var reasonsWhy = PlaybackEventMapper.MapTranscodeReasons(rawReasons);

        return new UserPlaybackSessionDto
        {
            ItemId = item?.Id.ToString(),
            MediaTitle = title,
            SeriesName = seriesName,
            SeasonNumber = seasonNumber,
            EpisodeNumber = episodeNumber,
            ProductionYear = productionYear,
            PlayMethod = playMethod,
            IsPaused = playState?.IsPaused ?? false,
            PositionTicks = positionTicks,
            RunTimeTicks = runTimeTicks,
            PlaybackPercentage = percent,
            IsVideoDirect = isVideoDirect,
            IsAudioDirect = isAudioDirect,
            IsContainerRemux = isRemux,
            VideoStatus = videoStatus,
            AudioStatus = audioStatus,
            VideoCodec = videoCodec,
            AudioCodec = audioCodec,
            Container = container,
            Resolution = resolution,
            TranscodeEngine = transcodeEngine,
            TranscodeReasons = rawReasons,
            TranscodeReasonsWhy = reasonsWhy,
            PrimaryImageTag = (item?.ImageTags != null && item.ImageTags.TryGetValue(MediaBrowser.Model.Entities.ImageType.Primary, out var tag)) ? tag : null
        };
    }
}

/// <summary>
/// Sanitized playback session DTO returned to normal authenticated users.
/// Strictly excludes RemoteEndPoint, client IP, server IP, file paths, tokens, session IDs, and other users' data.
/// </summary>
public sealed class UserPlaybackSessionDto
{
    public string? ItemId { get; init; }
    public string MediaTitle { get; init; } = string.Empty;
    public string? SeriesName { get; init; }
    public int? SeasonNumber { get; init; }
    public int? EpisodeNumber { get; init; }
    public int? ProductionYear { get; init; }

    public string PlayMethod { get; init; } = string.Empty;
    public bool IsPaused { get; init; }
    public long PositionTicks { get; init; }
    public long RunTimeTicks { get; init; }
    public int PlaybackPercentage { get; init; }

    public bool? IsVideoDirect { get; init; }
    public bool? IsAudioDirect { get; init; }
    public bool IsContainerRemux { get; init; }
    public string VideoStatus { get; init; } = string.Empty;
    public string AudioStatus { get; init; } = string.Empty;

    public string? VideoCodec { get; init; }
    public string? AudioCodec { get; init; }
    public string? Container { get; init; }
    public string? Resolution { get; init; }
    public string? TranscodeEngine { get; init; }
    public IReadOnlyList<string> TranscodeReasons { get; init; } = Array.Empty<string>();
    public string TranscodeReasonsWhy { get; init; } = string.Empty;
    public string? PrimaryImageTag { get; init; }
}
