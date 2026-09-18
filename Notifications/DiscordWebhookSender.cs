using System;
using System.Collections.Generic;
using System.Globalization;
using System.Net;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.PlaybackCard.Notifications;

/// <summary>
/// Service interface for dispatching Discord notifications.
/// </summary>
public interface IDiscordWebhookSender
{
    Task<DeliveryResult> SendAsync(PlaybackNotificationPayload payload, string webhookUrl, CancellationToken cancellationToken);
    Task<DeliveryResult> SendTestAsync(string webhookUrl, CancellationToken cancellationToken);
}

/// <summary>
/// Hardened Discord incoming webhook dispatcher implementing canonical URL validation,
/// mention suppression, 6000-character embed limit enforcement, exponential backoff, and secret redaction.
/// </summary>
public sealed class DiscordWebhookSender : IDiscordWebhookSender, IDisposable
{
    private static readonly Regex MentionStripRegex = new(@"@(everyone|here)|<@&?\d+>|<#\d+>", RegexOptions.Compiled | RegexOptions.IgnoreCase);
    private static readonly Regex NumericIdRegex = new(@"^\d+$", RegexOptions.Compiled);
    private static readonly Regex TokenRegex = new(@"^[a-zA-Z0-9_\-]+$", RegexOptions.Compiled);

    private readonly HttpClient _httpClient;
    private readonly bool _ownsClient;
    private readonly ILogger<DiscordWebhookSender> _logger;

    /// <summary>
    /// Injectable delay abstraction for deterministic unit testing of rate limits and backoffs.
    /// </summary>
    public Func<TimeSpan, CancellationToken, Task>? DelayAsync { get; set; }

    public DiscordWebhookSender(ILogger<DiscordWebhookSender> logger, HttpClient? httpClient = null)
    {
        _logger = logger;
        if (httpClient != null)
        {
            _httpClient = httpClient;
            _ownsClient = false;
        }
        else
        {
            var handler = new HttpClientHandler
            {
                AllowAutoRedirect = false, // Critical SSRF protection: reject 3xx redirects
                AutomaticDecompression = DecompressionMethods.None,
                CheckCertificateRevocationList = true
            };
            _httpClient = new HttpClient(handler)
            {
                Timeout = TimeSpan.FromSeconds(5) // 5s strict request timeout
            };
            _ownsClient = true;
        }
    }

    public void Dispose()
    {
        if (_ownsClient)
        {
            _httpClient.Dispose();
        }
    }

    /// <summary>
    /// Validates Discord webhook URI structure.
    /// Rejects HTTP, non-443 ports, host spoofing, IP literals, userinfo, query strings,
    /// fragments, extra path segments, and non-canonical shapes.
    /// Canonical shape: https://(discord.com|discordapp.com)/api/webhooks/&lt;numeric-id&gt;/&lt;token&gt;
    /// </summary>
    public static bool ValidateWebhookUrl(string? url, out Uri? validatedUri, out string errorCategory)
    {
        validatedUri = null;
        if (string.IsNullOrWhiteSpace(url))
        {
            errorCategory = "InvalidConfiguration";
            return false;
        }

        var trimmed = url.Trim();
        if (trimmed.Any(char.IsControl) || trimmed.Any(char.IsWhiteSpace) ||
            trimmed.Contains('\\', StringComparison.Ordinal) ||
            trimmed.Contains("..", StringComparison.Ordinal) ||
            trimmed.Contains("%2f", StringComparison.OrdinalIgnoreCase) ||
            trimmed.Contains("%5c", StringComparison.OrdinalIgnoreCase) ||
            trimmed.Contains("%2e", StringComparison.OrdinalIgnoreCase))
        {
            errorCategory = "InvalidConfiguration";
            return false;
        }

        if (!Uri.TryCreate(trimmed, UriKind.Absolute, out var uri))
        {
            errorCategory = "InvalidConfiguration";
            return false;
        }

        // Scheme must be HTTPS only
        if (!string.Equals(uri.Scheme, Uri.UriSchemeHttps, StringComparison.OrdinalIgnoreCase))
        {
            errorCategory = "InvalidConfiguration";
            return false;
        }

        // Port must be 443
        if (uri.Port != 443)
        {
            errorCategory = "InvalidConfiguration";
            return false;
        }

        // Reject IP literals
        var host = uri.Host;
        if (IPAddress.TryParse(host, out _))
        {
            errorCategory = "InvalidConfiguration";
            return false;
        }

        // Host must be exactly discord.com or discordapp.com
        if (!host.Equals("discord.com", StringComparison.OrdinalIgnoreCase) &&
            !host.Equals("discordapp.com", StringComparison.OrdinalIgnoreCase))
        {
            errorCategory = "InvalidConfiguration";
            return false;
        }

        // Reject userinfo
        if (!string.IsNullOrEmpty(uri.UserInfo))
        {
            errorCategory = "InvalidConfiguration";
            return false;
        }

        // Reject query strings
        if (!string.IsNullOrEmpty(uri.Query) && uri.Query != "?")
        {
            errorCategory = "InvalidConfiguration";
            return false;
        }

        // Reject fragments
        if (!string.IsNullOrEmpty(uri.Fragment))
        {
            errorCategory = "InvalidConfiguration";
            return false;
        }

        // Must match canonical path: /api/webhooks/<numeric-webhook-id>/<token>
        var segments = uri.AbsolutePath.Trim('/').Split('/', StringSplitOptions.RemoveEmptyEntries);
        if (segments.Length != 4)
        {
            errorCategory = "InvalidConfiguration";
            return false;
        }

        if (!segments[0].Equals("api", StringComparison.OrdinalIgnoreCase) ||
            !segments[1].Equals("webhooks", StringComparison.OrdinalIgnoreCase))
        {
            errorCategory = "InvalidConfiguration";
            return false;
        }

        // Webhook ID must be numeric digits
        if (!NumericIdRegex.IsMatch(segments[2]))
        {
            errorCategory = "InvalidConfiguration";
            return false;
        }

        // Webhook token must match expected character set
        if (!TokenRegex.IsMatch(segments[3]))
        {
            errorCategory = "InvalidConfiguration";
            return false;
        }

        validatedUri = uri;
        errorCategory = "OK";
        return true;
    }

    /// <inheritdoc />
    public async Task<DeliveryResult> SendTestAsync(string webhookUrl, CancellationToken cancellationToken)
    {
        var testPayload = PlaybackNotificationPayload.CreateSyntheticTest();

        return await SendAsync(testPayload, webhookUrl, cancellationToken).ConfigureAwait(false);
    }

    /// <summary>
    /// Sender-specific configuration handed to <see cref="WebhookSenderRetryHelper"/>: how to
    /// recognize a successful 2xx response, how to parse a 429 Retry-After value, and how to
    /// describe a permanent 4xx client error. Discord never needs the response body except for
    /// the 429 case (its 2xx responses are typically 204 No Content, and its 4xx descriptions
    /// are fixed strings), which this profile preserves exactly.
    /// </summary>
    private static readonly WebhookSenderProfile DiscordProfile = new()
    {
        SenderTag = "DiscordSender",
        ApiDisplayName = "Discord Webhook",
        ReadSuccessBody = false,
        ParseSuccess = (logger, status, _) =>
        {
            // Previously silent on success, leaving no log trace to diagnose a report of
            // "message delivered but UI still says failed" -- see the identical fix on the
            // Telegram sender.
            logger.LogInformation("[DiscordSender] Delivery succeeded (HTTP {Status})", status);
            return DeliveryResult.Ok(status);
        },
        ParseRetryAfter = (response, body) => ParseRetryAfter(response, body),
        ReadClientErrorBody = false,
        DescribeClientError = (status, _) => status switch
        {
            400 => "Bad Request (malformed Discord payload or parameters)",
            401 => "Unauthorized (invalid or revoked Discord webhook token)",
            403 => "Forbidden (Discord webhook lacks permissions in channel)",
            404 => "Not Found (Discord webhook URL does not exist or channel was deleted)",
            _ => null
        }
    };

    /// <inheritdoc />
    public async Task<DeliveryResult> SendAsync(PlaybackNotificationPayload payload, string webhookUrl, CancellationToken cancellationToken)
    {
        if (!ValidateWebhookUrl(webhookUrl, out var uri, out var errorCat))
        {
            _logger.LogWarning("[DiscordSender] Webhook validation failed: {Category}", errorCat);
            return DeliveryResult.Failed(errorCat, 0, permanent: true);
        }

        var jsonBody = BuildDiscordJsonPayload(payload);
        return await WebhookSenderRetryHelper.ExecuteWithRetryAsync(
            _httpClient,
            _logger,
            DiscordProfile,
            uri!,
            jsonBody,
            DelayAsync,
            cancellationToken).ConfigureAwait(false);
    }

    public static TimeSpan? ParseRetryAfter(HttpResponseMessage response, string? responseBody = null)
    {
        ArgumentNullException.ThrowIfNull(response);

        // 1. Inspect JSON body retry_after if available
        if (!string.IsNullOrEmpty(responseBody))
        {
            try
            {
                using var doc = JsonDocument.Parse(responseBody);
                if (doc.RootElement.TryGetProperty("retry_after", out var raProp))
                {
                    if (raProp.TryGetDouble(out var raSecs) && raSecs > 0)
                    {
                        // Discord may send seconds as float/decimal
                        return TimeSpan.FromSeconds(raSecs);
                    }
                }
            }
            catch { }
        }

        // 2. Inspect Retry-After header
        if (response.Headers.TryGetValues("Retry-After", out var values))
        {
            foreach (var val in values)
            {
                if (double.TryParse(val, NumberStyles.Any, CultureInfo.InvariantCulture, out var secs) && secs > 0)
                {
                    return TimeSpan.FromSeconds(secs);
                }

                if (DateTimeOffset.TryParse(val, CultureInfo.InvariantCulture, DateTimeStyles.None, out var date))
                {
                    var diff = date - DateTimeOffset.UtcNow;
                    if (diff > TimeSpan.Zero)
                    {
                        return diff;
                    }
                }
            }
        }

        return TimeSpan.FromSeconds(2);
    }

    /// <summary>
    /// Builds strict, sanitized Discord JSON payload enforcing 6000-character embed limit,
    /// field priority preservation, and mention neutralization.
    /// </summary>
    public static string BuildDiscordJsonPayload(PlaybackNotificationPayload payload)
    {
        ArgumentNullException.ThrowIfNull(payload);

        var titleText = SafeTruncate(payload.EventType switch
        {
            NotificationEventType.Start => "🎬 Playback Started",
            NotificationEventType.Stop => "⏹️ Playback Stopped",
            NotificationEventType.Completion => "🎉 Playback Completed",
            NotificationEventType.Pause => "⏸️ Playback Paused",
            NotificationEventType.Resume => "▶️ Playback Resumed",
            NotificationEventType.Progress => "⏱️ Playback Progress",
            _ => "🎬 Playback Event"
        }, 256);

        var description = new StringBuilder();
        if (!string.IsNullOrEmpty(payload.SeriesName))
        {
            description.Append("**").Append(SafeTruncate(payload.SeriesName, 200)).Append("**\n");
            if (payload.SeasonNumber.HasValue && payload.EpisodeNumber.HasValue)
            {
                description.Append(CultureInfo.InvariantCulture, $"S{payload.SeasonNumber:D2}E{payload.EpisodeNumber:D2} — ");
            }
        }
        description.Append(SafeTruncate(payload.MediaTitle, 200));
        if (payload.ProductionYear.HasValue && payload.ProductionYear > 0)
        {
            description.Append(CultureInfo.InvariantCulture, $" ({payload.ProductionYear})");
        }

        var color = payload.EventType switch
        {
            NotificationEventType.Stop => 7371408,       // Slate Gray
            NotificationEventType.Pause => 16744448,     // Amber Gold
            NotificationEventType.Completion => 3066993, // Emerald Green
            _ => (payload.PlayMethod ?? "").ToUpperInvariant() switch
            {
                "TRANSCODE" => 15048717,   // Vivid Orange
                "DIRECTSTREAM" => 6111187, // Royal Purple
                "REMUX" => 6111187,        // Royal Purple
                _ => 421980                // Cyan (#00A4DC)
            }
        };

        // Construct candidate fields ordered by priority (Core fields first)
        var coreFields = new List<DiscordField>();
        var secondaryFields = new List<DiscordField>();

        // Core fields: Stream Method, Video Status, Audio Status, Transcode Reasons
        coreFields.Add(new DiscordField("Stream", payload.PlayMethod, true));
        coreFields.Add(new DiscordField("Video", payload.VideoStatus, true));
        coreFields.Add(new DiscordField("Audio", payload.AudioStatus, true));

        if (!string.IsNullOrEmpty(payload.TranscodeReasonsWhy) &&
            !payload.TranscodeReasonsWhy.Equals("Reason not reported by server", StringComparison.OrdinalIgnoreCase))
        {
            var engine = !string.IsNullOrEmpty(payload.TranscodeEngine) ? $" [{payload.TranscodeEngine}]" : "";
            coreFields.Add(new DiscordField("Transcode Reason", $"{payload.TranscodeReasonsWhy}{engine}", false));
        }

        // Secondary fields: User, Client, Progress, Codecs/Format
        if (!string.IsNullOrEmpty(payload.Username))
        {
            secondaryFields.Add(new DiscordField("User", payload.Username, true));
        }

        if (!string.IsNullOrEmpty(payload.ClientName))
        {
            var clientStr = string.IsNullOrEmpty(payload.DeviceName) ? payload.ClientName : $"{payload.ClientName} ({payload.DeviceName})";
            secondaryFields.Add(new DiscordField("Client", clientStr, true));
        }

        if (!string.IsNullOrEmpty(payload.Resolution) || !string.IsNullOrEmpty(payload.VideoCodec))
        {
            var vid = $"{payload.VideoCodec ?? ""} {payload.Resolution ?? ""}".Trim();
            if (!string.IsNullOrEmpty(payload.DynamicRange)) vid += $" • {payload.DynamicRange}";
            secondaryFields.Add(new DiscordField("Format", vid, true));
        }

        if (!string.IsNullOrEmpty(payload.Container))
        {
            var cStr = !string.IsNullOrEmpty(payload.SourceContainer) && !payload.SourceContainer.Equals(payload.Container, StringComparison.OrdinalIgnoreCase)
                ? $"{payload.SourceContainer.ToUpperInvariant()} → {payload.Container.ToUpperInvariant()}"
                : payload.Container.ToUpperInvariant();
            secondaryFields.Add(new DiscordField("Container", cStr, true));
        }

        if (payload.TotalDuration.HasValue && payload.TotalDuration.Value > TimeSpan.Zero)
        {
            var pos = payload.Position.ToString(@"hh\:mm\:ss", CultureInfo.InvariantCulture);
            var dur = payload.TotalDuration.Value.ToString(@"hh\:mm\:ss", CultureInfo.InvariantCulture);
            var pct = payload.PlaybackPercentage.HasValue ? $" ({payload.PlaybackPercentage}%)" : "";
            secondaryFields.Add(new DiscordField("Progress", $"{pos} / {dur}{pct}", true));
        }

        // Combine fields respecting 25 field limit and 6000 character total limit
        var footerText = "Playback Info Card • Local Telemetry";
        var descriptionText = SafeTruncate(description.ToString(), 4096);

        // Budget calculation for combined embed (Discord limit is 6000)
        var totalChars = titleText.Length + descriptionText.Length + footerText.Length;
        var finalFields = new List<DiscordField>();

        // Add core fields first
        foreach (var cf in coreFields)
        {
            if (finalFields.Count >= 25) break;
            var fChars = cf.Name.Length + cf.Value.Length;
            if (totalChars + fChars <= 5800)
            {
                finalFields.Add(cf);
                totalChars += fChars;
            }
        }

        // Add secondary fields if budget permits
        foreach (var sf in secondaryFields)
        {
            if (finalFields.Count >= 25) break;
            var fChars = sf.Name.Length + sf.Value.Length;
            if (totalChars + fChars <= 5800)
            {
                finalFields.Add(sf);
                totalChars += fChars;
            }
        }

        var embedFields = new List<object>();
        foreach (var f in finalFields)
        {
            embedFields.Add(new
            {
                name = SafeTruncate(f.Name, 256),
                value = SafeTruncate(f.Value, 1024),
                inline = f.Inline
            });
        }

        var embedObj = new Dictionary<string, object>
        {
            ["title"] = titleText,
            ["description"] = descriptionText,
            ["color"] = color,
            ["fields"] = embedFields,
            ["footer"] = new { text = footerText },
            ["timestamp"] = payload.Timestamp.ToString("yyyy-MM-ddTHH:mm:ss.fffZ", CultureInfo.InvariantCulture)
        };

        var rootPayload = new Dictionary<string, object>
        {
            ["content"] = "",
            ["allowed_mentions"] = new { parse = Array.Empty<string>() }, // Zero mention parsing
            ["embeds"] = new[] { embedObj }
        };

        return JsonSerializer.Serialize(rootPayload);
    }

    /// <summary>
    /// Safely truncates string without splitting UTF-16 surrogate pairs and sanitizes @mentions.
    /// </summary>
    public static string SafeTruncate(string input, int maxLength)
    {
        if (string.IsNullOrEmpty(input)) return string.Empty;

        var clean = MentionStripRegex.Replace(input, "@​$1");
        clean = clean.Replace("\r", "", StringComparison.Ordinal).Trim();

        if (clean.Length <= maxLength)
        {
            return clean;
        }

        var limit = maxLength - 1;
        // Never split surrogate pair
        if (char.IsHighSurrogate(clean[limit - 1]))
        {
            limit--;
        }

        return string.Concat(clean.AsSpan(0, limit), "…");
    }

    private sealed record DiscordField(string Name, string Value, bool Inline);
}

/// <summary>
/// Per-sender configuration describing the parts of outbound HTTP dispatch that legitimately
/// differ between webhook/bot-API senders (Discord, Telegram): log/description text, whether the
/// response body needs to be read to determine success or to describe a permanent failure, and
/// how to interpret that body. Everything else (retry counts, exponential backoff, and the
/// 429/408/425/5xx transient-failure branching) is identical between senders and lives in
/// <see cref="WebhookSenderRetryHelper"/>.
/// </summary>
internal sealed class WebhookSenderProfile
{
    public required string SenderTag { get; init; }

    public required string ApiDisplayName { get; init; }

    public bool ReadSuccessBody { get; init; }

    public required Func<ILogger, int, string?, DeliveryResult> ParseSuccess { get; init; }

    public required Func<HttpResponseMessage, string, TimeSpan?> ParseRetryAfter { get; init; }

    public bool ReadClientErrorBody { get; init; }

    public required Func<int, string?, string?> DescribeClientError { get; init; }
}

/// <summary>
/// Shared HTTP dispatch orchestration for outbound webhook/bot-API senders. Discord and Telegram
/// each dispatch over their own hardened <see cref="HttpClient"/>, but share byte-for-byte
/// identical exponential-backoff, retry-count, and 429/408/425/5xx transient-failure semantics;
/// this helper centralizes that orchestration so each sender only supplies the parts that
/// legitimately differ (see <see cref="WebhookSenderProfile"/>).
/// </summary>
internal static class WebhookSenderRetryHelper
{
    private const int MaxRetries = 3;
    private const double MaxAllowedDelaySeconds = 30.0;

    public static async Task<DeliveryResult> ExecuteWithRetryAsync(
        HttpClient httpClient,
        ILogger logger,
        WebhookSenderProfile profile,
        Uri uri,
        string jsonPayload,
        Func<TimeSpan, CancellationToken, Task>? delayOverride,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(httpClient);
        ArgumentNullException.ThrowIfNull(logger);
        ArgumentNullException.ThrowIfNull(profile);
        ArgumentNullException.ThrowIfNull(uri);

        for (var attempt = 0; attempt <= MaxRetries; attempt++)
        {
            using var request = new HttpRequestMessage(HttpMethod.Post, uri);
            request.Content = new StringContent(jsonPayload, Encoding.UTF8, "application/json");

            try
            {
                using var response = await httpClient.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellationToken).ConfigureAwait(false);
                var status = (int)response.StatusCode;

                // 3xx Redirect rejected (SSRF protection)
                if (status >= 300 && status <= 399)
                {
                    logger.LogWarning("[{Tag}] Unexpected redirect received ({Status}); aborting for security.", profile.SenderTag, status);
                    return DeliveryResult.Failed("InvalidResponse", status, permanent: true);
                }

                // 2xx Success
                if (status >= 200 && status <= 299)
                {
                    string? successBody = null;
                    if (profile.ReadSuccessBody)
                    {
                        successBody = await response.Content.ReadAsStringAsync(cancellationToken).ConfigureAwait(false);
                    }

                    return profile.ParseSuccess(logger, status, successBody);
                }

                // 429 Rate limited
                if (status == 429)
                {
                    var responseBody = await response.Content.ReadAsStringAsync(cancellationToken).ConfigureAwait(false);
                    var retryAfter = profile.ParseRetryAfter(response, responseBody);

                    // If server asks for delay greater than maximum allowed (30s), drop instead of premature retrying
                    if (retryAfter.HasValue && retryAfter.Value.TotalSeconds > MaxAllowedDelaySeconds)
                    {
                        logger.LogWarning("[{Tag}] Rate-limit delay of {Delay}s exceeds maximum threshold; dropping event.", profile.SenderTag, retryAfter.Value.TotalSeconds);
                        return DeliveryResult.Failed("RateLimited", 429, permanent: false, retryAfter: retryAfter);
                    }

                    if (attempt < MaxRetries && retryAfter.HasValue)
                    {
                        var delay = retryAfter.Value;
                        logger.LogInformation("[{Tag}] Rate limited (429); backing off for {Delay}s", profile.SenderTag, delay.TotalSeconds);
                        await DelayWaitAsync(delay, delayOverride, cancellationToken).ConfigureAwait(false);
                        continue;
                    }

                    return DeliveryResult.Failed("RateLimited", 429, permanent: false, retryAfter: retryAfter);
                }

                // Permanent client errors (400, 401, 403, 404)
                if (status == 400 || status == 401 || status == 403 || status == 404)
                {
                    string? errorBody = null;
                    if (profile.ReadClientErrorBody)
                    {
                        errorBody = await response.Content.ReadAsStringAsync(cancellationToken).ConfigureAwait(false);
                    }

                    var category = status switch
                    {
                        400 => "BadRequest",
                        401 => "Unauthorized",
                        403 => "Forbidden",
                        _ => "NotFound"
                    };

                    return DeliveryResult.Failed(category, status, permanent: true, description: profile.DescribeClientError(status, errorBody));
                }

                // Transient server errors (5xx, 408, 425)
                if (attempt < MaxRetries && (status >= 500 || status == 408 || status == 425))
                {
                    var backoff = ComputeBackoff(attempt);
                    logger.LogWarning("[{Tag}] Transient failure ({Status}); retrying in {Backoff}ms", profile.SenderTag, status, backoff);
                    await DelayWaitAsync(TimeSpan.FromMilliseconds(backoff), delayOverride, cancellationToken).ConfigureAwait(false);
                    continue;
                }

                return DeliveryResult.Failed("ServerError", status, permanent: false);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                return DeliveryResult.Failed("Cancelled", 0, permanent: true, description: "Delivery cancelled by request.");
            }
            catch (Exception ex) when (ex is TimeoutException || (ex is OperationCanceledException && !cancellationToken.IsCancellationRequested))
            {
                if (attempt < MaxRetries)
                {
                    var backoff = ComputeBackoff(attempt);
                    logger.LogWarning("[{Tag}] Timeout contacting {Api}; retrying in {Backoff}ms", profile.SenderTag, profile.ApiDisplayName, backoff);
                    await DelayWaitAsync(TimeSpan.FromMilliseconds(backoff), delayOverride, cancellationToken).ConfigureAwait(false);
                    continue;
                }

                logger.LogError("[{Tag}] Delivery timed out after {Max} attempts", profile.SenderTag, MaxRetries + 1);
                return DeliveryResult.Failed("Timeout", 408, permanent: false, description: $"Request timed out while connecting to {profile.ApiDisplayName}.");
            }
            catch (Exception ex)
            {
                var sanitized = SecretRedactor.SanitizeExceptionMessage(ex);
                if (attempt < MaxRetries)
                {
                    var backoff = ComputeBackoff(attempt);
                    logger.LogWarning("[{Tag}] Network error: {Error}; retrying in {Backoff}ms", profile.SenderTag, sanitized, backoff);
                    await DelayWaitAsync(TimeSpan.FromMilliseconds(backoff), delayOverride, cancellationToken).ConfigureAwait(false);
                    continue;
                }

                logger.LogError("[{Tag}] Delivery failed after retries: {Error}", profile.SenderTag, sanitized);
                return DeliveryResult.Failed("NetworkError", 0, permanent: false, description: $"Network error connecting to {profile.ApiDisplayName}: {sanitized}");
            }
        }

        return DeliveryResult.Failed("ServerError", 0, permanent: false);
    }

    private static Task DelayWaitAsync(TimeSpan delay, Func<TimeSpan, CancellationToken, Task>? delayOverride, CancellationToken cancellationToken)
    {
        if (delayOverride != null)
        {
            return delayOverride(delay, cancellationToken);
        }

        return Task.Delay(delay, cancellationToken);
    }

    private static int ComputeBackoff(int attempt)
    {
        var baseMs = (int)Math.Pow(2, attempt) * 1000;
        var jitter = System.Security.Cryptography.RandomNumberGenerator.GetInt32(100, 500);
        return Math.Min(30000, baseMs + jitter);
    }
}
