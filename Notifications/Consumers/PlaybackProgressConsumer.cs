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

            // Atomically read the previous state and write the new one as a single ConcurrentDictionary
            // operation. A separate TryGetValue-then-indexer-write here would let two near-simultaneous
            // calls for the same session both observe the same stale previous state and both conclude
            // a transition occurred, double-firing a Pause/Resume notification.
            var eventType = NotificationEventType.Progress;
            SessionStates.AddOrUpdate(
                sessionId,
                addValueFactory: _ =>
                {
                    // First progress tick: record current state without emitting false Pause or Resume
                    eventType = NotificationEventType.Progress;
                    return new SessionStateEntry(isPaused, now);
                },
                updateValueFactory: (_, previousEntry) =>
                {
                    eventType = previousEntry.IsPaused != isPaused
                        ? (isPaused ? NotificationEventType.Pause : NotificationEventType.Resume) // True transition observed
                        : NotificationEventType.Progress; // Refresh timestamp only
                    return new SessionStateEntry(isPaused, now);
                });

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
