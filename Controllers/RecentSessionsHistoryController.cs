using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json.Serialization;
using Jellyfin.Plugin.PlaybackCard.Notifications;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;

namespace Jellyfin.Plugin.PlaybackCard.Controllers;

/// <summary>
/// Admin-only endpoint for the "Recent Sessions" history shelf -- a bounded, in-memory
/// (never persisted) list of recently finished playback sessions, independent of the
/// notification pipeline. Same admin-elevation pattern as <c>NotificationsConfigurationController</c>.
/// </summary>
[ApiController]
[Route("PlaybackCard/History")]
[Route("PlaybackInfoCard/History")]
[Authorize(Policy = "RequiresElevation")]
public class RecentSessionsHistoryController : ControllerBase
{
    private readonly IRecentSessionsHistoryService _historyService;

    public RecentSessionsHistoryController(IRecentSessionsHistoryService historyService)
    {
        _historyService = historyService;
    }

    private bool IsAdministrator()
    {
        return User.IsInRole("Administrator") ||
               User.HasClaim("IsAdministrator", "true") ||
               User.HasClaim(c => c.Type.Equals("IsAdministrator", StringComparison.OrdinalIgnoreCase) && c.Value.Equals("true", StringComparison.OrdinalIgnoreCase));
    }

    /// <summary>
    /// Retrieves up to <paramref name="limit"/> recently finished sessions, newest first.
    /// </summary>
    [HttpGet("Recent")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status403Forbidden)]
    public ActionResult<IReadOnlyList<RecentSessionDto>> GetRecent([FromQuery] int limit = 25)
    {
        if (!IsAdministrator())
        {
            return Forbid();
        }

        var entries = _historyService.GetRecent(limit);
        return Ok(entries.Select(ToDto).ToList());
    }

    private static RecentSessionDto ToDto(RecentSessionEntry entry)
    {
        return new RecentSessionDto
        {
            MediaTitle = entry.MediaTitle,
            SeriesName = entry.SeriesName,
            SeasonNumber = entry.SeasonNumber,
            EpisodeNumber = entry.EpisodeNumber,
            ProductionYear = entry.ProductionYear,
            Username = entry.Username,
            PlayMethod = entry.PlayMethod,
            Resolution = entry.Resolution,
            PlaybackPercentage = entry.PlaybackPercentage,
            PlayedToCompletion = entry.PlayedToCompletion,
            TranscodeReasonsWhy = entry.TranscodeReasonsWhy,
            Timestamp = entry.Timestamp
        };
    }
}

/// <summary>
/// camelCase wire DTO for a single recent-session history entry -- see the note on
/// <c>NotificationConfigurationDto</c> for why explicit <see cref="JsonPropertyNameAttribute"/>
/// is required on every property in this codebase's controllers.
/// </summary>
public sealed class RecentSessionDto
{
    [JsonPropertyName("mediaTitle")]
    public string MediaTitle { get; init; } = string.Empty;
    [JsonPropertyName("seriesName")]
    public string? SeriesName { get; init; }
    [JsonPropertyName("seasonNumber")]
    public int? SeasonNumber { get; init; }
    [JsonPropertyName("episodeNumber")]
    public int? EpisodeNumber { get; init; }
    [JsonPropertyName("productionYear")]
    public int? ProductionYear { get; init; }
    [JsonPropertyName("username")]
    public string? Username { get; init; }
    [JsonPropertyName("playMethod")]
    public string PlayMethod { get; init; } = string.Empty;
    [JsonPropertyName("resolution")]
    public string? Resolution { get; init; }
    [JsonPropertyName("playbackPercentage")]
    public int? PlaybackPercentage { get; init; }
    [JsonPropertyName("playedToCompletion")]
    public bool PlayedToCompletion { get; init; }
    [JsonPropertyName("transcodeReasonsWhy")]
    public string TranscodeReasonsWhy { get; init; } = string.Empty;
    [JsonPropertyName("timestamp")]
    public DateTimeOffset Timestamp { get; init; }
}
