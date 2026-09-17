using System;
using System.Threading.Tasks;
using MediaBrowser.Controller.Events;
using MediaBrowser.Controller.Library;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.PlaybackCard.Notifications.Consumers;

/// <summary>
/// Server-side consumer for Jellyfin PlaybackStart events.
/// Fast-return execution: maps event to internal record and enqueues immediately without blocking.
/// </summary>
public sealed class PlaybackStartConsumer : IEventConsumer<PlaybackStartEventArgs>
{
    private readonly INotificationDeliveryService _deliveryService;
    private readonly ILogger<PlaybackStartConsumer> _logger;

    public PlaybackStartConsumer(
        INotificationDeliveryService deliveryService,
        ILogger<PlaybackStartConsumer> logger)
    {
        _deliveryService = deliveryService;
        _logger = logger;
    }

    /// <inheritdoc />
    public Task OnEvent(PlaybackStartEventArgs eventArgs)
    {
        if (eventArgs == null)
        {
            return Task.CompletedTask;
        }

        try
        {
            var record = PlaybackEventMapper.Map(
                NotificationEventType.Start,
                eventArgs.Session,
                eventArgs.Item,
                eventArgs.PlaybackPositionTicks);

            // Clear any paused state tracker for this session
            PlaybackProgressConsumer.ResetSessionState(record.InternalSessionKey);

            _deliveryService.Enqueue(record);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "[PlaybackStartConsumer] Failed to map and enqueue start event.");
        }

        return Task.CompletedTask;
    }
}
