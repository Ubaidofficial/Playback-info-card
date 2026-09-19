using System;
using System.Collections.Generic;
using System.Linq;

namespace Jellyfin.Plugin.PlaybackCard.Notifications;

/// <summary>
/// Bounded, in-memory (never persisted to disk) history of recently finished playback
/// sessions, independent of the Discord/Telegram notification pipeline -- this exists purely
/// so the admin UI can answer "what did people watch earlier" without a database. Cleared on
/// every server restart.
/// </summary>
public interface IRecentSessionsHistoryService
{
    void Record(PlaybackEventRecord record);
    IReadOnlyList<RecentSessionEntry> GetRecent(int maxCount = 25);
}

/// <inheritdoc />
public sealed class RecentSessionsHistoryService : IRecentSessionsHistoryService
{
    private const int MaxCapacity = 30;
    private readonly object _lock = new();
    private readonly LinkedList<RecentSessionEntry> _entries = new();

    /// <inheritdoc />
    public void Record(PlaybackEventRecord record)
    {
        ArgumentNullException.ThrowIfNull(record);

        var entry = new RecentSessionEntry
        {
            MediaTitle = record.MediaTitle,
            SeriesName = record.SeriesName,
            SeasonNumber = record.SeasonNumber,
            EpisodeNumber = record.EpisodeNumber,
            ProductionYear = record.ProductionYear,
            Username = record.Username,
            PlayMethod = record.PlayMethod,
            Resolution = record.Resolution,
            PlaybackPercentage = record.PlaybackPercentage,
            PlayedToCompletion = record.PlayedToCompletion,
            TranscodeReasonsWhy = record.TranscodeReasonsWhy,
            Timestamp = record.Timestamp
        };

        lock (_lock)
        {
            _entries.AddFirst(entry);
            while (_entries.Count > MaxCapacity)
            {
                _entries.RemoveLast();
            }
        }
    }

    /// <inheritdoc />
    public IReadOnlyList<RecentSessionEntry> GetRecent(int maxCount = 25)
    {
        var bounded = Math.Max(1, Math.Min(maxCount, MaxCapacity));
        lock (_lock)
        {
            return _entries.Take(bounded).ToList();
        }
    }
}

/// <summary>
/// One completed/stopped session's history entry. Deliberately excludes client/device name,
/// IP, and session identifiers -- this is shown in the admin UI's history shelf, not a full
/// diagnostics dump.
/// </summary>
public sealed class RecentSessionEntry
{
    public string MediaTitle { get; init; } = string.Empty;
    public string? SeriesName { get; init; }
    public int? SeasonNumber { get; init; }
    public int? EpisodeNumber { get; init; }
    public int? ProductionYear { get; init; }
    public string? Username { get; init; }
    public string PlayMethod { get; init; } = string.Empty;
    public string? Resolution { get; init; }
    public int? PlaybackPercentage { get; init; }
    public bool PlayedToCompletion { get; init; }
    public string TranscodeReasonsWhy { get; init; } = string.Empty;
    public DateTimeOffset Timestamp { get; init; }
}
