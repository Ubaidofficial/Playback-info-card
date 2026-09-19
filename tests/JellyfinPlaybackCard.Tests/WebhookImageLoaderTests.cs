using System;
using System.IO;
using Jellyfin.Plugin.PlaybackCard.Notifications;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace JellyfinPlaybackCard.Tests;

public class WebhookImageLoaderTests
{
    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    public void TryReadImageBytes_ReturnsNull_WhenPathIsNullOrWhitespace(string? path)
    {
        Assert.Null(WebhookImageLoader.TryReadImageBytes(path, NullLogger.Instance, "Test"));
    }

    [Fact]
    public void TryReadImageBytes_ReturnsNull_WhenFileDoesNotExist()
    {
        var path = Path.Combine(Path.GetTempPath(), Guid.NewGuid() + ".jpg");
        Assert.Null(WebhookImageLoader.TryReadImageBytes(path, NullLogger.Instance, "Test"));
    }

    [Fact]
    public void TryReadImageBytes_ReturnsBytes_ForValidSmallFile()
    {
        var path = Path.Combine(Path.GetTempPath(), Guid.NewGuid() + ".jpg");
        var expected = new byte[] { 1, 2, 3, 4 };
        File.WriteAllBytes(path, expected);
        try
        {
            var result = WebhookImageLoader.TryReadImageBytes(path, NullLogger.Instance, "Test");
            Assert.Equal(expected, result);
        }
        finally
        {
            File.Delete(path);
        }
    }

    [Fact]
    public void TryReadImageBytes_ReturnsNull_WhenFileExceedsSizeLimit()
    {
        var path = Path.Combine(Path.GetTempPath(), Guid.NewGuid() + ".jpg");
        File.WriteAllBytes(path, new byte[9 * 1024 * 1024]);
        try
        {
            Assert.Null(WebhookImageLoader.TryReadImageBytes(path, NullLogger.Instance, "Test"));
        }
        finally
        {
            File.Delete(path);
        }
    }

    [Fact]
    public void TryReadImageBytes_ReturnsNull_ForEmptyFile()
    {
        var path = Path.Combine(Path.GetTempPath(), Guid.NewGuid() + ".jpg");
        File.WriteAllBytes(path, Array.Empty<byte>());
        try
        {
            Assert.Null(WebhookImageLoader.TryReadImageBytes(path, NullLogger.Instance, "Test"));
        }
        finally
        {
            File.Delete(path);
        }
    }
}
