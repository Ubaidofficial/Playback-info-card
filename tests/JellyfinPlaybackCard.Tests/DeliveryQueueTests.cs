using System;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.PlaybackCard.Notifications;
using Xunit;

namespace JellyfinPlaybackCard.Tests;

public class DeliveryQueueTests
{
    private static PlaybackEventRecord CreateRecord(
        NotificationEventType type,
        string sessionId,
        long positionTicks = 0,
        string userId = "user1",
        string internalKey = "")
    {
        return new PlaybackEventRecord
        {
            EventType = type,
            Timestamp = DateTimeOffset.UtcNow,
            InternalSessionKey = string.IsNullOrEmpty(internalKey) ? sessionId : internalKey,
            UserId = userId,
            Username = "TestUser",
            MediaTitle = "Sample Media",
            Position = TimeSpan.FromTicks(positionTicks),
            TotalDuration = TimeSpan.FromHours(1),
            PlaybackPercentage = 10
        };
    }

    [Fact]
    public async Task DestinationQueue_PriorityOrdering_CriticalDequeuedBeforeNonCritical()
    {
        using var queue = new NotificationDeliveryService.DestinationQueue("Test", capacity: 10, reservedCritical: 2);

        var progressRecord = CreateRecord(NotificationEventType.Progress, "sess-1", positionTicks: 100);
        var startRecord = CreateRecord(NotificationEventType.Start, "sess-1", positionTicks: 0);

        // Enqueue progress first, then start
        queue.Enqueue(progressRecord);
        queue.Enqueue(startRecord);

        // Dequeue should yield Start first due to priority
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(2));
        var firstDequeued = await queue.DequeueAsync(cts.Token);
        var secondDequeued = await queue.DequeueAsync(cts.Token);

        Assert.NotNull(firstDequeued);
        Assert.Equal(NotificationEventType.Start, firstDequeued.EventType);

        Assert.NotNull(secondDequeued);
        Assert.Equal(NotificationEventType.Progress, secondDequeued.EventType);
    }

    [Fact]
    public async Task DestinationQueue_ProgressCoalescing_ReplacesPendingProgressForSameSession()
    {
        using var queue = new NotificationDeliveryService.DestinationQueue("Test", capacity: 10, reservedCritical: 2);

        var progress1 = CreateRecord(NotificationEventType.Progress, "sess-1", positionTicks: 1000);
        var progress2 = CreateRecord(NotificationEventType.Progress, "sess-1", positionTicks: 2000);

        queue.Enqueue(progress1);
        queue.Enqueue(progress2);

        // Queue depth should be 1 because progress was coalesced
        Assert.Equal(1, queue.QueueDepth);

        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(2));
        var dequeued = await queue.DequeueAsync(cts.Token);

        Assert.NotNull(dequeued);
        Assert.Equal(TimeSpan.FromTicks(2000), dequeued.Position);
    }

    [Fact]
    public void DestinationQueue_ProgressDropping_UnderQueuePressure()
    {
        // Capacity 10, reservedCritical 2 -> Non-critical limit is 8
        using var queue = new NotificationDeliveryService.DestinationQueue("Test", capacity: 10, reservedCritical: 2);

        for (var i = 0; i < 8; i++)
        {
            queue.Enqueue(CreateRecord(NotificationEventType.Progress, $"sess-{i}", positionTicks: i * 10));
        }

        Assert.Equal(8, queue.QueueDepth);
        Assert.Equal(0, queue.DroppedProgressCount);

        // 9th progress should be dropped due to pressure
        queue.Enqueue(CreateRecord(NotificationEventType.Progress, "sess-overflow", positionTicks: 999));

        Assert.Equal(8, queue.QueueDepth);
        Assert.Equal(1, queue.DroppedProgressCount);
    }

    [Fact]
    public async Task DestinationQueue_CapacityReservation_AllowsCriticalWhenNonCriticalFull()
    {
        // Capacity 10, reservedCritical 2 -> Non-critical limit is 8
        using var queue = new NotificationDeliveryService.DestinationQueue("Test", capacity: 10, reservedCritical: 2);

        // Fill up to non-critical limit
        for (var i = 0; i < 8; i++)
        {
            queue.Enqueue(CreateRecord(NotificationEventType.Progress, $"sess-{i}", positionTicks: i));
        }

        Assert.Equal(8, queue.QueueDepth);

        // Critical Start events should still be accepted into reserved slots
        queue.Enqueue(CreateRecord(NotificationEventType.Start, "sess-crit-1"));
        queue.Enqueue(CreateRecord(NotificationEventType.Stop, "sess-crit-2"));

        Assert.Equal(10, queue.QueueDepth);

        // Next critical event causes drop-oldest non-critical
        queue.Enqueue(CreateRecord(NotificationEventType.Start, "sess-crit-3"));
        Assert.Equal(10, queue.QueueDepth);
        Assert.Equal(1, queue.DroppedProgressCount);

        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(2));
        var first = await queue.DequeueAsync(cts.Token);
        Assert.NotNull(first);
        Assert.Equal(NotificationEventType.Start, first.EventType);
    }

    [Fact]
    public void PlaybackEventMapper_MissingSessionId_GeneratesConsistentFallbackKey()
    {
        var session = new MediaBrowser.Controller.Session.SessionInfo(null, null)
        {
            Id = null,
            UserId = Guid.Parse("11111111-1111-1111-1111-111111111111"),
            Client = "Jellyfin Web"
        };

        var item = new MediaBrowser.Controller.Entities.Movies.Movie
        {
            Id = Guid.Parse("22222222-2222-2222-2222-222222222222")
        };

        var record1 = Jellyfin.Plugin.PlaybackCard.Notifications.Consumers.PlaybackEventMapper.Map(NotificationEventType.Start, session, item);
        var record2 = Jellyfin.Plugin.PlaybackCard.Notifications.Consumers.PlaybackEventMapper.Map(NotificationEventType.Progress, session, item);

        Assert.NotEmpty(record1.InternalSessionKey);
        Assert.Equal(record1.InternalSessionKey, record2.InternalSessionKey);
        Assert.Equal("fallback:11111111-1111-1111-1111-111111111111:22222222-2222-2222-2222-222222222222:Jellyfin Web", record1.InternalSessionKey);
    }
}
