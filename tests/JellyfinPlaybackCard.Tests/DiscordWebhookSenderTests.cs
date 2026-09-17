using System;
using System.Net;
using System.Net.Http;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.PlaybackCard.Notifications;
using Xunit;

namespace JellyfinPlaybackCard.Tests;

public class DiscordWebhookSenderTests
{
    private static PlaybackNotificationPayload CreateSamplePayload()
    {
        return new PlaybackNotificationPayload
        {
            EventType = NotificationEventType.Start,
            Timestamp = DateTimeOffset.UtcNow,
            MediaTitle = "Interstellar",
            ProductionYear = 2014,
            ItemType = "Movie",
            PlayMethod = "DirectPlay",
            Resolution = "4K",
            VideoCodec = "HEVC",
            AudioCodec = "TrueHD Atmos",
            Container = "mkv",
            IsPaused = false,
            Position = TimeSpan.Zero,
            TotalDuration = TimeSpan.FromHours(2),
            PlaybackPercentage = 0
        };
    }

    [Theory]
    [InlineData("https://discord.com/api/webhooks/123456789/validToken123", true)]
    [InlineData("https://discordapp.com/api/webhooks/987654321/validToken456", true)]
    [InlineData("http://discord.com/api/webhooks/123456789/validToken123", false)] // Insecure HTTP
    [InlineData("https://evil.discord.com/api/webhooks/123456789/validToken123", false)] // Invalid subdomain
    [InlineData("https://discord.com:8443/api/webhooks/123456789/validToken123", false)] // Non-443 port
    [InlineData("https://user:pass@discord.com/api/webhooks/123456789/validToken123", false)] // UserInfo forbidden
    [InlineData("https://192.168.1.1/api/webhooks/123456789/validToken123", false)] // IP literal
    [InlineData("https://discord.com/api/webhooks/123456789/../other", false)] // Path traversal
    [InlineData("", false)] // Blank
    [InlineData(null, false)] // Null
    public void ValidateWebhookUrl_StrictHostnameAndSchemeValidation(string? url, bool expectedValid)
    {
        var valid = DiscordWebhookSender.ValidateWebhookUrl(url, out var uri, out var category);
        Assert.Equal(expectedValid, valid);
        if (expectedValid)
        {
            Assert.NotNull(uri);
            Assert.Equal("OK", category);
        }
        else
        {
            Assert.Null(uri);
            Assert.NotEqual("OK", category);
        }
    }

    [Fact]
    public async Task SendAsync_IncludesMentionSuppressionAndSanitizesMentions()
    {
        var mockHandler = new TestHttpMessageHandler
        {
            HandlerFunc = (req, ct) => Task.FromResult(new HttpResponseMessage(HttpStatusCode.NoContent))
        };

        using var client = new HttpClient(mockHandler);
        using var sender = new DiscordWebhookSender(new TestLogger<DiscordWebhookSender>(), client);

        var payload = CreateSamplePayload();
        payload = new PlaybackNotificationPayload
        {
            EventType = payload.EventType,
            Timestamp = payload.Timestamp,
            MediaTitle = "Attack on @everyone and <@&123456> Movie",
            ProductionYear = payload.ProductionYear,
            ItemType = payload.ItemType,
            PlayMethod = payload.PlayMethod,
            Resolution = payload.Resolution,
            VideoCodec = payload.VideoCodec,
            AudioCodec = payload.AudioCodec,
            Container = payload.Container,
            IsPaused = payload.IsPaused,
            Position = payload.Position,
            TotalDuration = payload.TotalDuration,
            PlaybackPercentage = payload.PlaybackPercentage
        };

        var result = await sender.SendAsync(payload, "https://discord.com/api/webhooks/123456789/validToken123", CancellationToken.None);

        Assert.True(result.Success);
        Assert.Single(mockHandler.CapturedContents);

        var json = mockHandler.CapturedContents[0];
        Assert.Contains("\"allowed_mentions\":{\"parse\":[]}", json);
        Assert.DoesNotContain("@everyone", json);
        Assert.DoesNotContain("<@&123456>", json);
    }

    [Fact]
    public async Task SendAsync_HandlesRateLimit429_ExtractsRetryAfter()
    {
        var callCount = 0;
        var mockHandler = new TestHttpMessageHandler
        {
            HandlerFunc = (req, ct) =>
            {
                callCount++;
                if (callCount == 1)
                {
                    var rateLimitResp = new HttpResponseMessage((HttpStatusCode)429);
                    rateLimitResp.Headers.RetryAfter = new System.Net.Http.Headers.RetryConditionHeaderValue(TimeSpan.FromSeconds(2));
                    return Task.FromResult(rateLimitResp);
                }
                return Task.FromResult(new HttpResponseMessage(HttpStatusCode.NoContent));
            }
        };

        using var client = new HttpClient(mockHandler);
        using var sender = new DiscordWebhookSender(new TestLogger<DiscordWebhookSender>(), client);

        var payload = CreateSamplePayload();
        var result = await sender.SendAsync(payload, "https://discord.com/api/webhooks/123456789/validToken123", CancellationToken.None);

        // After retry, it succeeds
        Assert.True(result.Success);
        Assert.Equal(2, callCount);
    }

    [Fact]
    public async Task SendAsync_PermanentError_DoesNotRetry()
    {
        var callCount = 0;
        var mockHandler = new TestHttpMessageHandler
        {
            HandlerFunc = (req, ct) =>
            {
                callCount++;
                return Task.FromResult(new HttpResponseMessage(HttpStatusCode.NotFound)); // 404 Not Found
            }
        };

        using var client = new HttpClient(mockHandler);
        using var sender = new DiscordWebhookSender(new TestLogger<DiscordWebhookSender>(), client);

        var payload = CreateSamplePayload();
        var result = await sender.SendAsync(payload, "https://discord.com/api/webhooks/123456789/validToken123", CancellationToken.None);

        Assert.False(result.Success);
        Assert.True(result.IsPermanentFailure);
        Assert.Equal(404, result.StatusCode);
        Assert.Equal(1, callCount); // No retry for permanent errors
    }

    [Fact]
    public async Task SendAsync_TransientError500_RetriesUpTo3Times()
    {
        var callCount = 0;
        var mockHandler = new TestHttpMessageHandler
        {
            HandlerFunc = (req, ct) =>
            {
                callCount++;
                return Task.FromResult(new HttpResponseMessage(HttpStatusCode.InternalServerError)); // 500
            }
        };

        using var client = new HttpClient(mockHandler);
        using var sender = new DiscordWebhookSender(new TestLogger<DiscordWebhookSender>(), client);

        var payload = CreateSamplePayload();
        var result = await sender.SendAsync(payload, "https://discord.com/api/webhooks/123456789/validToken123", CancellationToken.None);

        Assert.False(result.Success);
        Assert.False(result.IsPermanentFailure);
        Assert.Equal(500, result.StatusCode);
        Assert.Equal(4, callCount); // 1 initial + 3 retries = 4 total attempts
    }

    [Fact]
    public async Task SendAsync_EnforcesEmbedFieldAndLengthLimits()
    {
        var mockHandler = new TestHttpMessageHandler
        {
            HandlerFunc = (req, ct) => Task.FromResult(new HttpResponseMessage(HttpStatusCode.NoContent))
        };

        using var client = new HttpClient(mockHandler);
        using var sender = new DiscordWebhookSender(new TestLogger<DiscordWebhookSender>(), client);

        var payload = CreateSamplePayload();
        // Exceptionally long item name (> 256 chars)
        payload = new PlaybackNotificationPayload
        {
            EventType = payload.EventType,
            Timestamp = payload.Timestamp,
            MediaTitle = new string('A', 500),
            ProductionYear = payload.ProductionYear,
            ItemType = payload.ItemType,
            PlayMethod = payload.PlayMethod,
            Resolution = payload.Resolution,
            VideoCodec = payload.VideoCodec,
            AudioCodec = payload.AudioCodec,
            Container = payload.Container,
            IsPaused = payload.IsPaused,
            Position = payload.Position,
            TotalDuration = payload.TotalDuration,
            PlaybackPercentage = payload.PlaybackPercentage
        };

        var result = await sender.SendAsync(payload, "https://discord.com/api/webhooks/123456789/validToken123", CancellationToken.None);

        Assert.True(result.Success);
        var json = mockHandler.CapturedContents[0];
        using var doc = JsonDocument.Parse(json);
        var embeds = doc.RootElement.GetProperty("embeds");
        var firstEmbed = embeds[0];
        var title = firstEmbed.GetProperty("title").GetString();

        Assert.NotNull(title);
        Assert.True(title.Length <= 256, $"Embed title length {title.Length} exceeded limit 256");
    }

    [Fact]
    public void BuildDiscordJsonPayload_EnforcesCombined6000CharLimit_AndPrioritizesCoreFields()
    {
        var payload = new PlaybackNotificationPayload
        {
            EventType = NotificationEventType.Start,
            Timestamp = DateTimeOffset.UtcNow,
            MediaTitle = new string('M', 300),
            SeriesName = new string('S', 300),
            ProductionYear = 2026,
            ItemType = "Episode",
            PlayMethod = "Transcode",
            VideoStatus = "Video Transcoded (4K HEVC -> 1080p H264)",
            AudioStatus = "Audio Direct (DTS-HD MA 7.1)",
            TranscodeEngine = "NVENC",
            TranscodeReasonsWhy = new string('R', 2000),
            Username = new string('U', 500),
            ClientName = new string('C', 500),
            DeviceName = new string('D', 500),
            Resolution = "3840x2160",
            VideoCodec = "HEVC",
            AudioCodec = "DTS-HD MA",
            Container = "mkv",
            SourceContainer = "mkv",
            TotalDuration = TimeSpan.FromHours(2),
            Position = TimeSpan.FromMinutes(30),
            PlaybackPercentage = 25
        };

        var json = DiscordWebhookSender.BuildDiscordJsonPayload(payload);
        using var doc = JsonDocument.Parse(json);

        var embeds = doc.RootElement.GetProperty("embeds");
        var firstEmbed = embeds[0];

        var title = firstEmbed.GetProperty("title").GetString() ?? "";
        var desc = firstEmbed.GetProperty("description").GetString() ?? "";
        var footer = firstEmbed.GetProperty("footer").GetProperty("text").GetString() ?? "";

        var totalChars = title.Length + desc.Length + footer.Length;
        var fields = firstEmbed.GetProperty("fields");
        Assert.True(fields.GetArrayLength() <= 25, "Embed field count must be <= 25");

        var fieldNames = new List<string>();
        foreach (var f in fields.EnumerateArray())
        {
            var name = f.GetProperty("name").GetString() ?? "";
            var val = f.GetProperty("value").GetString() ?? "";
            fieldNames.Add(name);

            Assert.True(name.Length <= 256, $"Field name length {name.Length} exceeded 256");
            Assert.True(val.Length <= 1024, $"Field value length {val.Length} exceeded 1024");
            totalChars += name.Length + val.Length;
        }

        Assert.True(totalChars <= 6000, $"Combined embed character count {totalChars} exceeded Discord limit of 6000");

        // Assert core fields are preserved even under severe budget pressure
        Assert.Contains("Stream", fieldNames);
        Assert.Contains("Video", fieldNames);
        Assert.Contains("Audio", fieldNames);
    }

    [Fact]
    public async Task SendAsync_Redirect302_RejectedImmediatelyAsPermanentFailure()
    {
        var mockHandler = new TestHttpMessageHandler
        {
            HandlerFunc = (req, ct) =>
            {
                var resp = new HttpResponseMessage(HttpStatusCode.Redirect);
                resp.Headers.Location = new Uri("https://evil.com/leak");
                return Task.FromResult(resp);
            }
        };

        using var client = new HttpClient(mockHandler);
        using var sender = new DiscordWebhookSender(new TestLogger<DiscordWebhookSender>(), client);

        var payload = CreateSamplePayload();
        var result = await sender.SendAsync(payload, "https://discord.com/api/webhooks/123456789/validToken123", CancellationToken.None);

        Assert.False(result.Success);
        Assert.True(result.IsPermanentFailure);
        Assert.Equal(302, result.StatusCode);
        Assert.Equal("InvalidResponse", result.Category);
    }
}
