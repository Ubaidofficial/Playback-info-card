using System;
using Jellyfin.Plugin.PlaybackCard.Notifications;
using Xunit;

namespace JellyfinPlaybackCard.Tests;

public class RecentSessionsHistoryServiceTests
{
    private static PlaybackEventRecord CreateRecord(string title, DateTimeOffset timestamp)
    {
        return new PlaybackEventRecord
        {
            MediaTitle = title,
            Timestamp = timestamp,
            PlayMethod = "DirectPlay"
        };
    }

    [Fact]
    public void GetRecent_ReturnsEmpty_WhenNothingRecorded()
    {
        var service = new RecentSessionsHistoryService();
        Assert.Empty(service.GetRecent());
    }

    [Fact]
    public void Record_ThenGetRecent_ReturnsNewestFirst()
    {
        var service = new RecentSessionsHistoryService();
        service.Record(CreateRecord("First", DateTimeOffset.UtcNow.AddMinutes(-2)));
        service.Record(CreateRecord("Second", DateTimeOffset.UtcNow.AddMinutes(-1)));
        service.Record(CreateRecord("Third", DateTimeOffset.UtcNow));

        var recent = service.GetRecent();

        Assert.Equal(3, recent.Count);
        Assert.Equal("Third", recent[0].MediaTitle);
        Assert.Equal("Second", recent[1].MediaTitle);
        Assert.Equal("First", recent[2].MediaTitle);
    }

    [Fact]
    public void Record_EvictsOldestEntry_BeyondCapacity()
    {
        var service = new RecentSessionsHistoryService();
        for (var i = 0; i < 35; i++)
        {
            service.Record(CreateRecord("Item" + i, DateTimeOffset.UtcNow.AddSeconds(i)));
        }

        var recent = service.GetRecent(50);

        Assert.True(recent.Count <= 30, "History must stay bounded even when the caller asks for more than the cap.");
        Assert.Equal("Item34", recent[0].MediaTitle);
        Assert.DoesNotContain(recent, e => e.MediaTitle == "Item0");
    }

    [Fact]
    public void GetRecent_RespectsRequestedLimit()
    {
        var service = new RecentSessionsHistoryService();
        for (var i = 0; i < 10; i++)
        {
            service.Record(CreateRecord("Item" + i, DateTimeOffset.UtcNow.AddSeconds(i)));
        }

        var recent = service.GetRecent(3);

        Assert.Equal(3, recent.Count);
        Assert.Equal("Item9", recent[0].MediaTitle);
    }

    [Fact]
    public void Record_ThrowsOnNull()
    {
        var service = new RecentSessionsHistoryService();
        Assert.Throws<ArgumentNullException>(() => service.Record(null!));
    }
}
