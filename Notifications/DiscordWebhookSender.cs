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
        var testPayload = new PlaybackNotificationPayload
        {
            EventType = NotificationEventType.Start,
            Timestamp = DateTimeOffset.UtcNow,
            MediaTitle = "Synthetic Test Stream (2026)",
            ItemType = "Movie",
            PlayMethod = "DirectPlay",
            Position = TimeSpan.FromMinutes(12),
            TotalDuration = TimeSpan.FromHours(2),
            PlaybackPercentage = 10,
            VideoStatus = "Video Direct",
            AudioStatus = "Audio Direct",
            IsVideoDirect = true,
            IsAudioDirect = true,
            VideoCodec = "HEVC",
            AudioCodec = "EAC3",
            Container = "MKV",
            Resolution = "3840x2160",
            DynamicRange = "HDR10",
            AudioChannels = "5.1",
            Bitrate = 18_500_000,
            TranscodeReasonsWhy = "Reason not reported by server"
        };

        return await SendAsync(testPayload, webhookUrl, cancellationToken).ConfigureAwait(false);
    }

    /// <inheritdoc />
    public async Task<DeliveryResult> SendAsync(PlaybackNotificationPayload payload, string webhookUrl, CancellationToken cancellationToken)
    {
        if (!ValidateWebhookUrl(webhookUrl, out var uri, out var errorCat))
        {
            _logger.LogWarning("[DiscordSender] Webhook validation failed: {Category}", errorCat);
            return DeliveryResult.Failed(errorCat, 0, permanent: true);
        }

        var jsonBody = BuildDiscordJsonPayload(payload);
        return await ExecuteWithRetryAsync(uri!, jsonBody, cancellationToken).ConfigureAwait(false);
    }

    private async Task<DeliveryResult> ExecuteWithRetryAsync(Uri uri, string jsonPayload, CancellationToken cancellationToken)
    {
        const int maxRetries = 3;
        const double maxAllowedDelaySecs = 30.0;

        for (var attempt = 0; attempt <= maxRetries; attempt++)
        {
            using var request = new HttpRequestMessage(HttpMethod.Post, uri);
            request.Content = new StringContent(jsonPayload, Encoding.UTF8, "application/json");

            try
            {
                using var response = await _httpClient.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellationToken).ConfigureAwait(false);
                var status = (int)response.StatusCode;

                // 2xx Success (including 204 No Content common for Discord webhooks)
                if (status >= 200 && status <= 299)
                {
                    return DeliveryResult.Ok(status);
                }

                // 3xx Redirect rejected (SSRF protection)
                if (status >= 300 && status <= 399)
                {
                    _logger.LogWarning("[DiscordSender] Unexpected redirect received ({Status}); aborting for security.", status);
                    return DeliveryResult.Failed("InvalidResponse", status, permanent: true);
                }

                // 429 Rate limited
                if (status == 429)
                {
                    var responseBody = await response.Content.ReadAsStringAsync(cancellationToken).ConfigureAwait(false);
                    var retryAfter = ParseRetryAfter(response, responseBody);

                    // If server asks for delay greater than maximum allowed (30s), drop instead of premature retrying
                    if (retryAfter.HasValue && retryAfter.Value.TotalSeconds > maxAllowedDelaySecs)
                    {
                        _logger.LogWarning("[DiscordSender] Rate-limit delay of {Delay}s exceeds maximum threshold; dropping event.", retryAfter.Value.TotalSeconds);
                        return DeliveryResult.Failed("RateLimited", 429, permanent: false, retryAfter: retryAfter);
                    }

                    if (attempt < maxRetries && retryAfter.HasValue)
                    {
                        var delay = retryAfter.Value;
                        _logger.LogInformation("[DiscordSender] Rate limited (429); backing off for {Delay}s", delay.TotalSeconds);
                        await DelayWaitAsync(delay, cancellationToken).ConfigureAwait(false);
                        continue;
                    }

                    return DeliveryResult.Failed("RateLimited", 429, permanent: false, retryAfter: retryAfter);
                }

                // Permanent client errors (400, 401, 403, 404)
                if (status == 400) return DeliveryResult.Failed("BadRequest", 400, permanent: true, description: "Bad Request (malformed Discord payload or parameters)");
                if (status == 401) return DeliveryResult.Failed("Unauthorized", 401, permanent: true, description: "Unauthorized (invalid or revoked Discord webhook token)");
                if (status == 403) return DeliveryResult.Failed("Forbidden", 403, permanent: true, description: "Forbidden (Discord webhook lacks permissions in channel)");
                if (status == 404) return DeliveryResult.Failed("NotFound", 404, permanent: true, description: "Not Found (Discord webhook URL does not exist or channel was deleted)");

                // Transient server errors (5xx, 408, 425)
                if (attempt < maxRetries && (status >= 500 || status == 408 || status == 425))
                {
                    var backoff = ComputeBackoff(attempt);
                    _logger.LogWarning("[DiscordSender] Transient failure ({Status}); retrying in {Backoff}ms", status, backoff);
                    await DelayWaitAsync(TimeSpan.FromMilliseconds(backoff), cancellationToken).ConfigureAwait(false);
                    continue;
                }

                return DeliveryResult.Failed("ServerError", status, permanent: false);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                return DeliveryResult.Failed("Cancelled", 0, permanent: true);
            }
            catch (Exception ex)
            {
                var sanitized = SecretRedactor.SanitizeExceptionMessage(ex);
                if (attempt < maxRetries)
                {
                    var backoff = ComputeBackoff(attempt);
                    _logger.LogWarning("[DiscordSender] Network error: {Error}; retrying in {Backoff}ms", sanitized, backoff);
                    await DelayWaitAsync(TimeSpan.FromMilliseconds(backoff), cancellationToken).ConfigureAwait(false);
                    continue;
                }

                _logger.LogError("[DiscordSender] Delivery failed after retries: {Error}", sanitized);
                return DeliveryResult.Failed("NetworkError", 0, permanent: false);
            }
        }

        return DeliveryResult.Failed("ServerError", 0, permanent: false);
    }

    private Task DelayWaitAsync(TimeSpan delay, CancellationToken cancellationToken)
    {
        if (DelayAsync != null)
        {
            return DelayAsync(delay, cancellationToken);
        }

        return Task.Delay(delay, cancellationToken);
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

    private static int ComputeBackoff(int attempt)
    {
        var baseMs = (int)Math.Pow(2, attempt) * 1000;
        var jitter = System.Security.Cryptography.RandomNumberGenerator.GetInt32(100, 500);
        return Math.Min(30000, baseMs + jitter);
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
