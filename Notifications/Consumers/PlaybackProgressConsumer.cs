using System;
using System.Collections.Concurrent;
using System.Threading.Tasks;
using MediaBrowser.Controller.Events;
using MediaBrowser.Controller.Library;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.PlaybackCard.Notifications.Consumers;

/// <summary>
/// Server-side consumer for Jellyfin PlaybackProgress events.
/// Derives pause/resume state transitions strictly from verified state changes.
/// Prevents false initial pause/resume transitions and purges abandoned session states with a bounded TTL.
/// Fast-return execution: maps event to internal record and enqueues immediately without blocking.
/// </summary>
public sealed class PlaybackProgressConsumer : IEventConsumer<PlaybackProgressEventArgs>
{
    private sealed record SessionStateEntry(bool IsPaused, DateTimeOffset LastUpdated);

    private static readonly ConcurrentDictionary<string, SessionStateEntry> SessionStates = new();
    private static readonly TimeSpan AbandonedSessionTtl = TimeSpan.FromHours(2);
    private static DateTimeOffset _lastPruneTime = DateTimeOffset.UtcNow;

    private readonly INotificationDeliveryService _deliveryService;
    private readonly ILogger<PlaybackProgressConsumer> _logger;

    public PlaybackProgressConsumer(
        INotificationDeliveryService deliveryService,
        ILogger<PlaybackProgressConsumer> logger)
    {
        _deliveryService = deliveryService;
        _logger = logger;
    }

    /// <summary>
    /// Resets pause tracking for a newly started session.
    /// </summary>
    public static void ResetSessionState(string sessionKey)
    {
        if (!string.IsNullOrEmpty(sessionKey))
        {
            SessionStates[sessionKey] = new SessionStateEntry(false, DateTimeOffset.UtcNow);
        }
    }

    /// <summary>
    /// Removes pause tracking when a session stops.
    /// </summary>
    public static void RemoveSessionState(string sessionKey)
    {
        if (!string.IsNullOrEmpty(sessionKey))
        {
            SessionStates.TryRemove(sessionKey, out _);
        }
    }

    /// <summary>
    /// Cleans up state entries that have been abandoned without a clean stop event.
    /// </summary>
    private static void PruneAbandonedStates(DateTimeOffset now)
    {
        if (now - _lastPruneTime < TimeSpan.FromMinutes(15))
        {
            return;
        }

        _lastPruneTime = now;
        foreach (var kvp in SessionStates)
        {
            if (now - kvp.Value.LastUpdated > AbandonedSessionTtl)
            {
                SessionStates.TryRemove(kvp.Key, out _);
            }
        }
    }

    /// <inheritdoc />
    public Task OnEvent(PlaybackProgressEventArgs eventArgs)
    {
        if (eventArgs == null)
        {
            return Task.CompletedTask;
        }

        try
        {
            var isPaused = eventArgs.IsPaused;
            var sessionId = eventArgs.Session?.Id ??
                $"fallback:{eventArgs.Session?.UserId.ToString() ?? "anon"}:{eventArgs.Item?.Id.ToString() ?? "unknown"}:{eventArgs.Session?.Client ?? "unknown"}";

            var now = DateTimeOffset.UtcNow;
            PruneAbandonedStates(now);

            var eventType = NotificationEventType.Progress;

            // Check if there was a verified pause/resume transition
            if (SessionStates.TryGetValue(sessionId, out var previousEntry))
            {
                if (previousEntry.IsPaused != isPaused)
                {
                    // True transition observed
                    eventType = isPaused ? NotificationEventType.Pause : NotificationEventType.Resume;
                    SessionStates[sessionId] = new SessionStateEntry(isPaused, now);
                }
                else
                {
                    // Refresh timestamp
                    SessionStates[sessionId] = new SessionStateEntry(isPaused, now);
                }
            }
            else
            {
                // First progress tick: record current state without emitting false Pause or Resume
                SessionStates[sessionId] = new SessionStateEntry(isPaused, now);
                eventType = NotificationEventType.Progress;
            }

            var record = PlaybackEventMapper.Map(
                eventType,
                eventArgs.Session,
                eventArgs.Item,
                eventArgs.PlaybackPositionTicks,
                isPaused: isPaused);

            _deliveryService.Enqueue(record);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "[PlaybackProgressConsumer] Failed to map and enqueue progress event.");
        }

        return Task.CompletedTask;
    }
}
