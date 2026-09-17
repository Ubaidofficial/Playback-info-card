using System;
using System.Collections.Concurrent;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.PlaybackCard.Notifications;
using Jellyfin.Plugin.PlaybackCard.Notifications.Consumers;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Session;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.Session;
using Xunit;

namespace JellyfinPlaybackCard.Tests;

public class PlaybackEventConsumerTests
{
    /// <summary>
    /// Thread-safe stand-in for <see cref="INotificationDeliveryService"/> that records every
    /// enqueued record's event type. A plain <see cref="System.Collections.Generic.List{T}"/> (as
    /// used by the single-threaded <c>TestDeliveryService</c> elsewhere) is not safe to call
    /// concurrently, so this test uses its own <see cref="ConcurrentQueue{T}"/>-backed stub.
    /// </summary>
    private sealed class ConcurrentRecordingDeliveryService : INotificationDeliveryService
    {
        private readonly ConcurrentQueue<PlaybackEventRecord> _records = new();

        public PlaybackEventRecord[] Records => _records.ToArray();

        public void Enqueue(PlaybackEventRecord record) => _records.Enqueue(record);

        public Task StartAsync(CancellationToken cancellationToken) => Task.CompletedTask;

        public Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;

        public Task<DeliveryResult> SendTestNotificationAsync(string destination, CancellationToken cancellationToken) =>
            Task.FromResult(DeliveryResult.Ok());

        public NotificationDiagnosticsSnapshot GetDiagnostics() => new();
    }

    [Fact]
    public void PlaybackEventMapper_MovieMapping_MapsFieldsCorrectly()
    {
        var session = new SessionInfo(null, null)
        {
            Id = "sess-movie-1",
            UserId = Guid.NewGuid(),
            UserName = "Alice",
            Client = "Jellyfin Web",
            DeviceName = "Chrome",
            ApplicationVersion = "10.9.11",
            PlayState = new PlayerStateInfo
            {
                PlayMethod = PlayMethod.DirectPlay,
                PositionTicks = TimeSpan.FromMinutes(30).Ticks
            }
        };

        var movie = new Movie
        {
            Name = "Inception",
            ProductionYear = 2010,
            RunTimeTicks = TimeSpan.FromHours(2).Ticks,
            Container = "mkv"
        };

        var record = PlaybackEventMapper.Map(
            NotificationEventType.Start,
            session,
            movie,
            playbackPositionTicks: TimeSpan.FromMinutes(30).Ticks,
            isPaused: false,
            playedToCompletion: false
        );

        Assert.NotNull(record);
        Assert.Equal(NotificationEventType.Start, record.EventType);
        Assert.Equal("sess-movie-1", record.InternalSessionKey);
        Assert.Equal("Inception", record.MediaTitle);
        Assert.Equal(2010, record.ProductionYear);
        Assert.Equal(25, record.PlaybackPercentage); // 30 mins / 120 mins = 25%

        // Privacy check on outbound payload
        // Case 1: user and device disclosure false
        var outboundPrivate = record.ToOutboundPayload(includeUsername: false, includeClientDevice: false);
        Assert.Null(outboundPrivate.Username);
        Assert.Null(outboundPrivate.ClientName);
        Assert.Null(outboundPrivate.DeviceName);
        Assert.Equal("Inception", outboundPrivate.MediaTitle);

        // Case 2: user and device disclosure true
        var outboundDisclosed = record.ToOutboundPayload(includeUsername: true, includeClientDevice: true);
        Assert.Equal("Alice", outboundDisclosed.Username);
        Assert.Equal("Jellyfin Web", outboundDisclosed.ClientName);
        Assert.Equal("Chrome", outboundDisclosed.DeviceName);
    }

    [Fact]
    public void PlaybackEventMapper_EpisodeMapping_MapsSeriesAndEpisodeNumbers()
    {
        var session = new SessionInfo(null, null)
        {
            Id = "sess-ep-1",
            UserId = Guid.NewGuid(),
            UserName = "Bob",
            Client = "Android TV",
            DeviceName = "Sony Bravia",
            PlayState = new PlayerStateInfo
            {
                PlayMethod = PlayMethod.Transcode
            }
        };

        var episode = new Episode
        {
            Name = "Ozymandias",
            SeriesName = "Breaking Bad",
            ParentIndexNumber = 5,
            IndexNumber = 14,
            ProductionYear = 2013,
            RunTimeTicks = TimeSpan.FromMinutes(47).Ticks
        };

        var record = PlaybackEventMapper.Map(
            NotificationEventType.Completion,
            session,
            episode,
            playbackPositionTicks: TimeSpan.FromMinutes(47).Ticks,
            isPaused: false,
            playedToCompletion: true
        );

        Assert.Equal(NotificationEventType.Completion, record.EventType);
        Assert.Equal("Ozymandias", record.MediaTitle);
        Assert.Equal("Breaking Bad", record.SeriesName);
        Assert.Equal(5, record.SeasonNumber);
        Assert.Equal(14, record.EpisodeNumber);
        Assert.Equal(100, record.PlaybackPercentage);
    }

    [Fact]
    public void PlaybackEventMapper_NullSessionAndItem_HandlesGracefullyWithoutThrowing()
    {
        var record = PlaybackEventMapper.Map(
            NotificationEventType.Progress,
            session: null,
            item: null,
            playbackPositionTicks: 0,
            isPaused: false,
            playedToCompletion: false
        );

        Assert.NotNull(record);
        Assert.Equal(NotificationEventType.Progress, record.EventType);
        Assert.Equal("Unknown Title", record.MediaTitle);
        Assert.NotEmpty(record.InternalSessionKey);

        var payload = record.ToOutboundPayload(includeUsername: false, includeClientDevice: false);
        Assert.NotNull(payload);
    }

    [Fact]
    public void OnEvent_ConcurrentPauseTransitionsForSameSession_OnlyOneEmitsPauseNotification()
    {
        // Regression test for a TOCTOU race: OnEvent used to read the previous SessionStateEntry via
        // TryGetValue and then write the new one via a separate indexer assignment, so two
        // near-simultaneous progress ticks reporting the same Pause transition could both read the
        // stale "not paused" state and both conclude a transition occurred, double-firing a Pause
        // notification. With the fix (an atomic ConcurrentDictionary.AddOrUpdate), exactly one of
        // many concurrent callers may observe the transition; the rest must see the already-updated
        // state and fall back to a plain Progress tick.
        //
        // Real Thread objects (not Task.Run/the thread pool) are used deliberately: the thread pool's
        // gradual worker-injection throttling would otherwise stagger the calls across many seconds
        // and mask the race instead of maximizing contention on it. OnEvent's returned Task is
        // always already-completed synchronous work, so GetAwaiter().GetResult() never blocks.
        var sessionKey = $"race-session-{Guid.NewGuid():N}";
        PlaybackProgressConsumer.ResetSessionState(sessionKey); // Baseline: not paused.

        var deliveryService = new ConcurrentRecordingDeliveryService();
        var consumer = new PlaybackProgressConsumer(deliveryService, new TestLogger<PlaybackProgressConsumer>());

        var session = new SessionInfo(null, null) { Id = sessionKey, UserId = Guid.NewGuid(), Client = "Race Client" };
        var item = new Movie { Id = Guid.NewGuid(), Name = "Race Movie" };

        const int concurrency = 50;
        using var barrier = new Barrier(concurrency);
        var threads = new Thread[concurrency];

        for (var i = 0; i < concurrency; i++)
        {
            var eventArgs = new PlaybackProgressEventArgs
            {
                Session = session,
                Item = item,
                IsPaused = true,
                PlaybackPositionTicks = TimeSpan.FromMinutes(5).Ticks
            };

            threads[i] = new Thread(() =>
            {
                barrier.SignalAndWait();
                consumer.OnEvent(eventArgs).GetAwaiter().GetResult();
            });
        }

        foreach (var thread in threads) thread.Start();
        foreach (var thread in threads) thread.Join();

        var records = deliveryService.Records;
        Assert.Equal(concurrency, records.Length);
        Assert.Equal(1, records.Count(r => r.EventType == NotificationEventType.Pause));
        Assert.Equal(concurrency - 1, records.Count(r => r.EventType == NotificationEventType.Progress));
    }
}
