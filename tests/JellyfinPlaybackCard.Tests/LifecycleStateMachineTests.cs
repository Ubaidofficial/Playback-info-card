using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.PlaybackCard.Notifications;
using Jellyfin.Plugin.PlaybackCard.Notifications.Consumers;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Session;
using MediaBrowser.Model.Entities;
using Xunit;

namespace JellyfinPlaybackCard.Tests;

public class TestDeliveryService : INotificationDeliveryService
{
    public List<PlaybackEventRecord> EnqueuedRecords { get; } = new();

    public void Enqueue(PlaybackEventRecord record)
    {
        EnqueuedRecords.Add(record);
    }

    public Task StartAsync(CancellationToken cancellationToken) => Task.CompletedTask;
    public Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;
    public NotificationDiagnosticsSnapshot GetDiagnostics() => new();
    public Task<DeliveryResult> SendTestNotificationAsync(string destination, CancellationToken cancellationToken) =>
        Task.FromResult(DeliveryResult.Ok(204));
}

public class LifecycleStateMachineTests
{
    [Fact]
    public async Task InitialProgressTick_WhilePaused_EmitsProgress_NotFalsePause()
    {
        var sessionKey = $"test-init-pause-{Guid.NewGuid():N}";
        PlaybackProgressConsumer.RemoveSessionState(sessionKey);

        var deliveryService = new TestDeliveryService();
        var consumer = new PlaybackProgressConsumer(deliveryService, new TestLogger<PlaybackProgressConsumer>());

        var session = new SessionInfo(null, null) { Id = sessionKey, UserId = Guid.NewGuid() };
        var item = new Movie { Id = Guid.NewGuid(), Name = "Paused Movie" };

        var eventArgs = new PlaybackProgressEventArgs
        {
            Session = session,
            Item = item,
            IsPaused = true,
            PlaybackPositionTicks = TimeSpan.FromMinutes(5).Ticks
        };

        await consumer.OnEvent(eventArgs);

        Assert.Single(deliveryService.EnqueuedRecords);
        var record = deliveryService.EnqueuedRecords[0];
        Assert.Equal(NotificationEventType.Progress, record.EventType);
        Assert.True(record.IsPaused);
    }

    [Fact]
    public async Task StateTransitions_EmitPauseAndResume_OnlyOnVerifiedChanges()
    {
        var sessionKey = $"test-transitions-{Guid.NewGuid():N}";
        PlaybackProgressConsumer.RemoveSessionState(sessionKey);

        var deliveryService = new TestDeliveryService();
        var consumer = new PlaybackProgressConsumer(deliveryService, new TestLogger<PlaybackProgressConsumer>());

        var session = new SessionInfo(null, null) { Id = sessionKey, UserId = Guid.NewGuid() };
        var item = new Movie { Id = Guid.NewGuid(), Name = "Movie" };

        // 1. Initial tick playing -> Progress
        await consumer.OnEvent(new PlaybackProgressEventArgs { Session = session, Item = item, IsPaused = false });
        Assert.Equal(NotificationEventType.Progress, deliveryService.EnqueuedRecords[^1].EventType);

        // 2. Second tick still playing -> Progress (no false Resume)
        await consumer.OnEvent(new PlaybackProgressEventArgs { Session = session, Item = item, IsPaused = false });
        Assert.Equal(NotificationEventType.Progress, deliveryService.EnqueuedRecords[^1].EventType);

        // 3. User pauses -> Verified Pause transition
        await consumer.OnEvent(new PlaybackProgressEventArgs { Session = session, Item = item, IsPaused = true });
        Assert.Equal(NotificationEventType.Pause, deliveryService.EnqueuedRecords[^1].EventType);

        // 4. Next tick still paused -> Progress (no duplicate Pause)
        await consumer.OnEvent(new PlaybackProgressEventArgs { Session = session, Item = item, IsPaused = true });
        Assert.Equal(NotificationEventType.Progress, deliveryService.EnqueuedRecords[^1].EventType);

        // 5. User resumes -> Verified Resume transition
        await consumer.OnEvent(new PlaybackProgressEventArgs { Session = session, Item = item, IsPaused = false });
        Assert.Equal(NotificationEventType.Resume, deliveryService.EnqueuedRecords[^1].EventType);

        // 6. Next tick still playing -> Progress
        await consumer.OnEvent(new PlaybackProgressEventArgs { Session = session, Item = item, IsPaused = false });
        Assert.Equal(NotificationEventType.Progress, deliveryService.EnqueuedRecords[^1].EventType);

        Assert.Equal(6, deliveryService.EnqueuedRecords.Count);
    }

    [Fact]
    public void ResetAndRemoveSessionState_CleanUpTrackingProperly()
    {
        var sessionKey = $"test-cleanup-{Guid.NewGuid():N}";

        // Should execute cleanly without throwing
        PlaybackProgressConsumer.ResetSessionState(sessionKey);
        PlaybackProgressConsumer.RemoveSessionState(sessionKey);
        PlaybackProgressConsumer.RemoveSessionState(string.Empty);
    }
}
