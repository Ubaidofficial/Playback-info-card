using System;
using Jellyfin.Plugin.PlaybackCard.Notifications;
using Jellyfin.Plugin.PlaybackCard.Notifications.Consumers;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Session;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.Session;
using Xunit;

namespace JellyfinPlaybackCard.Tests;

public class PlaybackEventConsumerTests
{
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
}
