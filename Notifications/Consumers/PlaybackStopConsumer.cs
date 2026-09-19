using System;
using System.Threading.Tasks;
using MediaBrowser.Controller.Events;
using MediaBrowser.Controller.Library;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.PlaybackCard.Notifications.Consumers;

/// <summary>
/// Server-side consumer for Jellyfin PlaybackStop events.
/// Derives completion state strictly from PlaybackStopEventArgs.PlayedToCompletion.
/// Fast-return execution: maps event to internal record and enqueues immediately without blocking.
/// </summary>
public sealed class PlaybackStopConsumer : IEventConsumer<PlaybackStopEventArgs>
{
    private readonly INotificationDeliveryService _deliveryService;
    private readonly IRecentSessionsHistoryService _historyService;
    private readonly ILogger<PlaybackStopConsumer> _logger;

    public PlaybackStopConsumer(
        INotificationDeliveryService deliveryService,
        IRecentSessionsHistoryService historyService,
        ILogger<PlaybackStopConsumer> logger)
    {
        _deliveryService = deliveryService;
        _historyService = historyService;
        _logger = logger;
    }

    /// <inheritdoc />
    public Task OnEvent(PlaybackStopEventArgs eventArgs)
    {
        if (eventArgs == null)
        {
            return Task.CompletedTask;
        }

        try
        {
            var eventType = eventArgs.PlayedToCompletion
                ? NotificationEventType.Completion
                : NotificationEventType.Stop;

            var record = PlaybackEventMapper.Map(
                eventType,
                eventArgs.Session,
                eventArgs.Item,
                eventArgs.PlaybackPositionTicks,
                isPaused: false,
                playedToCompletion: eventArgs.PlayedToCompletion);

            // Clean up pause tracking state for session
            PlaybackProgressConsumer.RemoveSessionState(record.InternalSessionKey);

            _deliveryService.Enqueue(record);
            _historyService.Record(record);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "[PlaybackStopConsumer] Failed to map and enqueue stop event.");
        }

        return Task.CompletedTask;
    }
}
