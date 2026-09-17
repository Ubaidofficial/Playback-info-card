using System;
using System.Net;
using System.Net.Http;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.PlaybackCard.Notifications;
using Xunit;

namespace JellyfinPlaybackCard.Tests;

public class TelegramBotApiSenderTests
{
    private static PlaybackNotificationPayload CreateSamplePayload()
    {
        return new PlaybackNotificationPayload
        {
            EventType = NotificationEventType.Start,
            Timestamp = DateTimeOffset.UtcNow,
            MediaTitle = "The Matrix & Reloaded <Special Edition>",
            ProductionYear = 1999,
            ItemType = "Movie",
            PlayMethod = "Transcode",
            Resolution = "1080p",
            VideoCodec = "H264",
            AudioCodec = "AAC",
            Container = "mp4",
            IsPaused = false,
            Position = TimeSpan.Zero,
            TotalDuration = TimeSpan.FromHours(2),
            PlaybackPercentage = 0
        };
    }

    [Theory]
    [InlineData("123456789:ABCDefGhIjKlMnOpQrStUvWxYz", "-100123456789", true)]
    [InlineData("invalidTokenFormat", "-100123456789", false)]
    [InlineData("123456789:token with spaces", "-100123456789", false)]
    [InlineData("", "-100123456789", false)]
    [InlineData("123456789:ABCDefGhIjKlMnOpQrStUvWxYz", "", false)]
    [InlineData(null, "-100123456789", false)]
    public void ValidateEndpoint_StrictTokenAndChatIdValidation(string? token, string? chatId, bool expectedValid)
    {
        var valid = TelegramBotApiSender.ValidateEndpoint(token, chatId, out var uri, out var category);
        Assert.Equal(expectedValid, valid);
        if (expectedValid)
        {
            Assert.NotNull(uri);
            Assert.Equal("api.telegram.org", uri.Host);
            Assert.Equal("OK", category);
        }
        else
        {
            Assert.Null(uri);
            Assert.NotEqual("OK", category);
        }
    }

    [Fact]
    public async Task SendAsync_EscapesHtmlEntitiesSafely()
    {
        var mockHandler = new TestHttpMessageHandler
        {
            HandlerFunc = (req, ct) =>
            {
                var resp = new HttpResponseMessage(HttpStatusCode.OK);
                resp.Content = new StringContent("{\"ok\":true,\"result\":{}}", System.Text.Encoding.UTF8, "application/json");
                return Task.FromResult(resp);
            }
        };

        using var client = new HttpClient(mockHandler);
        using var sender = new TelegramBotApiSender(new TestLogger<TelegramBotApiSender>(), client);

        var payload = CreateSamplePayload();
        payload = new PlaybackNotificationPayload
        {
            EventType = payload.EventType,
            Timestamp = payload.Timestamp,
            MediaTitle = "Tom & Jerry <Wild> \"Dangerous\"",
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

        var result = await sender.SendAsync(payload, "123456789:ABCDefGhIjKlMnOpQrStUvWxYz", "-100123456789", CancellationToken.None);

        Assert.True(result.Success);
        Assert.Single(mockHandler.CapturedContents);

        var json = mockHandler.CapturedContents[0];
        using var doc = JsonDocument.Parse(json);
        var text = doc.RootElement.GetProperty("text").GetString();

        Assert.NotNull(text);
        Assert.Contains("Tom &amp; Jerry", text);
        Assert.Contains("&lt;Wild&gt;", text);
        Assert.Contains("&quot;Dangerous&quot;", text);
        Assert.DoesNotContain("<Wild>", text);
    }

    [Fact]
    public async Task SendAsync_HandlesRateLimit429_ExtractsParametersRetryAfter()
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
                    rateLimitResp.Content = new StringContent("{\"ok\":false,\"error_code\":429,\"description\":\"Too Many Requests: retry after 2\",\"parameters\":{\"retry_after\":2}}", System.Text.Encoding.UTF8, "application/json");
                    return Task.FromResult(rateLimitResp);
                }

                var successResp = new HttpResponseMessage(HttpStatusCode.OK);
                successResp.Content = new StringContent("{\"ok\":true,\"result\":{}}", System.Text.Encoding.UTF8, "application/json");
                return Task.FromResult(successResp);
            }
        };

        using var client = new HttpClient(mockHandler);
        using var sender = new TelegramBotApiSender(new TestLogger<TelegramBotApiSender>(), client);

        var payload = CreateSamplePayload();
        var result = await sender.SendAsync(payload, "123456789:ABCDefGhIjKlMnOpQrStUvWxYz", "-100123456789", CancellationToken.None);

        Assert.True(result.Success);
        Assert.Equal(2, callCount);
    }

    [Fact]
    public async Task SendAsync_PermanentError403_DoesNotRetry()
    {
        var callCount = 0;
        var mockHandler = new TestHttpMessageHandler
        {
            HandlerFunc = (req, ct) =>
            {
                callCount++;
                var forbiddenResp = new HttpResponseMessage(HttpStatusCode.Forbidden);
                forbiddenResp.Content = new StringContent("{\"ok\":false,\"error_code\":403,\"description\":\"Forbidden: bot was blocked by the user\"}", System.Text.Encoding.UTF8, "application/json");
                return Task.FromResult(forbiddenResp);
            }
        };

        using var client = new HttpClient(mockHandler);
        using var sender = new TelegramBotApiSender(new TestLogger<TelegramBotApiSender>(), client);

        var payload = CreateSamplePayload();
        var result = await sender.SendAsync(payload, "123456789:ABCDefGhIjKlMnOpQrStUvWxYz", "-100123456789", CancellationToken.None);

        Assert.False(result.Success);
        Assert.True(result.IsPermanentFailure);
        Assert.Equal(403, result.StatusCode);
        Assert.Equal(1, callCount);
    }

    [Fact]
    public async Task SendAsync_Enforces4096CharLimit()
    {
        var mockHandler = new TestHttpMessageHandler
        {
            HandlerFunc = (req, ct) =>
            {
                var resp = new HttpResponseMessage(HttpStatusCode.OK);
                resp.Content = new StringContent("{\"ok\":true,\"result\":{}}", System.Text.Encoding.UTF8, "application/json");
                return Task.FromResult(resp);
            }
        };

        using var client = new HttpClient(mockHandler);
        using var sender = new TelegramBotApiSender(new TestLogger<TelegramBotApiSender>(), client);

        var payload = CreateSamplePayload();
        payload = new PlaybackNotificationPayload
        {
            EventType = payload.EventType,
            Timestamp = payload.Timestamp,
            MediaTitle = new string('Z', 5000),
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

        var result = await sender.SendAsync(payload, "123456789:ABCDefGhIjKlMnOpQrStUvWxYz", "-100123456789", CancellationToken.None);

        Assert.True(result.Success);
        var json = mockHandler.CapturedContents[0];
        using var doc = JsonDocument.Parse(json);
        var text = doc.RootElement.GetProperty("text").GetString();

        Assert.NotNull(text);
        Assert.True(text.Length <= 4096, $"Telegram message length {text.Length} exceeded 4096 limit");
    }

    [Theory]
    [InlineData("<b>Bold text here that is quite long</b>", 25, true)]
    [InlineData("<b>Bold with <i>nested italics</i> and <code>code</code></b>", 35, true)]
    [InlineData("Plain text without any tags", 15, true)]
    [InlineData("<b>Unclosed bold text that needs closure", 25, true)]
    public void TruncateHtmlSafely_EnforcesLengthAndClosesTags(string input, int maxChars, bool expectEllipsis)
    {
        var truncated = TelegramBotApiSender.TruncateHtmlSafely(input, maxChars);

        Assert.True(truncated.Length <= maxChars, $"Output length {truncated.Length} exceeded max {maxChars}: '{truncated}'");
        if (expectEllipsis)
        {
            Assert.Contains("...", truncated);
        }

        // Verify balanced tags
        Assert.Equal(
            TelegramBotApiSenderTestsHelpers.CountOccurrences(truncated, "<b>"),
            TelegramBotApiSenderTestsHelpers.CountOccurrences(truncated, "</b>"));
        Assert.Equal(
            TelegramBotApiSenderTestsHelpers.CountOccurrences(truncated, "<i>"),
            TelegramBotApiSenderTestsHelpers.CountOccurrences(truncated, "</i>"));
        Assert.Equal(
            TelegramBotApiSenderTestsHelpers.CountOccurrences(truncated, "<code>"),
            TelegramBotApiSenderTestsHelpers.CountOccurrences(truncated, "</code>"));
        Assert.DoesNotContain("<b...", truncated); // No partial tags
        Assert.DoesNotContain("<i...", truncated);
        Assert.DoesNotContain("<c...", truncated);
    }

    [Fact]
    public void TruncateHtmlSafely_DoesNotSplitSurrogatePair()
    {
        // 🎬 is \uD83C\uDFAC (surrogate pair)
        var input = "<b>Watch movie 🎬 Now playing in high quality!</b>";
        var truncated = TelegramBotApiSender.TruncateHtmlSafely(input, 20);

        Assert.True(truncated.Length <= 20);
        Assert.DoesNotContain("\uD83C...", truncated); // High surrogate without low surrogate
        Assert.EndsWith("</b>", truncated);
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
        using var sender = new TelegramBotApiSender(new TestLogger<TelegramBotApiSender>(), client);

        var payload = CreateSamplePayload();
        var result = await sender.SendAsync(payload, "123456789:ABCDefGhIjKlMnOpQrStUvWxYz", "-100123456789", CancellationToken.None);

        Assert.False(result.Success);
        Assert.True(result.IsPermanentFailure);
        Assert.Equal(302, result.StatusCode);
        Assert.Equal("InvalidResponse", result.Category);
    }
}

internal static class TelegramBotApiSenderTestsHelpers
{
    public static int CountOccurrences(string source, string pattern)
    {
        var count = 0;
        var idx = 0;
        while ((idx = source.IndexOf(pattern, idx, StringComparison.OrdinalIgnoreCase)) != -1)
        {
            count++;
            idx += pattern.Length;
        }
        return count;
    }
}
