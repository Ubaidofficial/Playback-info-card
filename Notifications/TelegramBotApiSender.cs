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
/// Service interface for dispatching Telegram Bot API notifications.
/// </summary>
public interface ITelegramBotApiSender
{
    Task<DeliveryResult> SendAsync(PlaybackNotificationPayload payload, string botToken, string chatId, CancellationToken cancellationToken);
    Task<DeliveryResult> SendTestAsync(string botToken, string chatId, CancellationToken cancellationToken);
}

/// <summary>
/// Hardened Telegram Bot API dispatcher implementing strict host validation,
/// safe HTML entity escaping, 4096-char tag closure integrity, exponential backoff, and secret redaction.
/// </summary>
public sealed class TelegramBotApiSender : ITelegramBotApiSender, IDisposable
{
    private static readonly Regex TokenFormatRegex = new(@"^[0-9]+:[a-zA-Z0-9_\-]+$", RegexOptions.Compiled);
    private static readonly Regex NumericChatIdRegex = new(@"^-?[0-9]{1,20}$", RegexOptions.Compiled);
    private static readonly Regex ChannelUsernameRegex = new(@"^@[a-zA-Z0-9_]{5,32}$", RegexOptions.Compiled);

    private readonly HttpClient _httpClient;
    private readonly bool _ownsClient;
    private readonly ILogger<TelegramBotApiSender> _logger;

    /// <summary>
    /// Injectable delay abstraction for deterministic unit testing of rate limits and backoffs.
    /// </summary>
    public Func<TimeSpan, CancellationToken, Task>? DelayAsync { get; set; }

    public TelegramBotApiSender(ILogger<TelegramBotApiSender> logger, HttpClient? httpClient = null)
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
                AllowAutoRedirect = false, // Critical SSRF protection: reject redirects
                AutomaticDecompression = DecompressionMethods.None,
                CheckCertificateRevocationList = true
            };
            _httpClient = new HttpClient(handler)
            {
                Timeout = TimeSpan.FromSeconds(5) // 5s request timeout
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
    /// Normalizes a Telegram bot token by trimming whitespace and stripping any optional leading "bot" prefix.
    /// </summary>
    public static string NormalizeToken(string? botToken)
    {
        if (string.IsNullOrWhiteSpace(botToken))
        {
            return string.Empty;
        }

        var trimmed = botToken.Trim();
        if (trimmed.StartsWith("bot", StringComparison.OrdinalIgnoreCase) && trimmed.Length > 3 && char.IsDigit(trimmed[3]))
        {
            trimmed = trimmed.Substring(3);
        }

        return trimmed;
    }

    /// <summary>
    /// Validates Telegram Bot API parameters and builds strict endpoint URI.
    /// Rejects arbitrary hosts, non-HTTPS schemes, non-443 ports, userinfo, invalid tokens, and malformed chat IDs.
    /// </summary>
    public static bool ValidateEndpoint(string? botToken, string? chatId, out Uri? validatedUri, out string errorCategory)
    {
        validatedUri = null;
        if (string.IsNullOrWhiteSpace(botToken) || string.IsNullOrWhiteSpace(chatId))
        {
            errorCategory = "InvalidConfiguration";
            return false;
        }

        var trimmedToken = NormalizeToken(botToken);

        if (trimmedToken.Any(char.IsControl) || trimmedToken.Any(char.IsWhiteSpace) ||
            chatId.Any(char.IsControl) || chatId.Any(char.IsWhiteSpace) ||
            chatId.Contains('?') || chatId.Contains('#') || chatId.Contains('/') || chatId.Contains('\\'))
        {
            errorCategory = "InvalidConfiguration";
            return false;
        }

        if (!TokenFormatRegex.IsMatch(trimmedToken))
        {
            errorCategory = "InvalidConfiguration";
            return false;
        }

        // Validate Chat ID: numeric or @channel username
        var trimmedChatId = chatId.Trim();
        if (!NumericChatIdRegex.IsMatch(trimmedChatId) && !ChannelUsernameRegex.IsMatch(trimmedChatId))
        {
            errorCategory = "InvalidConfiguration";
            return false;
        }

        var uriString = $"https://api.telegram.org/bot{trimmedToken}/sendMessage";
        if (!Uri.TryCreate(uriString, UriKind.Absolute, out var uri))
        {
            errorCategory = "InvalidConfiguration";
            return false;
        }

        if (!string.Equals(uri.Scheme, Uri.UriSchemeHttps, StringComparison.OrdinalIgnoreCase) ||
            !uri.Host.Equals("api.telegram.org", StringComparison.OrdinalIgnoreCase) ||
            uri.Port != 443 ||
            !string.IsNullOrEmpty(uri.UserInfo) ||
            (!string.IsNullOrEmpty(uri.Query) && uri.Query != "?") ||
            !string.IsNullOrEmpty(uri.Fragment))
        {
            errorCategory = "InvalidConfiguration";
            return false;
        }

        validatedUri = uri;
        errorCategory = "OK";
        return true;
    }

    /// <inheritdoc />
    public async Task<DeliveryResult> SendTestAsync(string botToken, string chatId, CancellationToken cancellationToken)
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

        return await SendAsync(testPayload, botToken, chatId, cancellationToken).ConfigureAwait(false);
    }

    /// <summary>
    /// Sender-specific configuration handed to <see cref="WebhookSenderRetryHelper"/>: Telegram
    /// always needs the response body, both to confirm 2xx responses carry <c>ok:true</c> and to
    /// extract the human-readable <c>description</c> field on 4xx/429 errors.
    /// </summary>
    private static readonly WebhookSenderProfile TelegramProfile = new()
    {
        SenderTag = "TelegramSender",
        ApiDisplayName = "Telegram Bot API",
        ReadSuccessBody = true,
        ParseSuccess = (logger, status, body) => ParseTelegramSuccess(logger, status, body),
        ParseRetryAfter = (response, body) => ParseTelegramRetryAfter(response, body),
        ReadClientErrorBody = true,
        DescribeClientError = (status, body) =>
        {
            var errorDesc = ParseTelegramErrorDescription(body);
            return status switch
            {
                400 => errorDesc ?? "Bad Request (verify chat ID and bot permissions)",
                401 => errorDesc ?? "Unauthorized (invalid Telegram bot token)",
                403 => errorDesc ?? "Forbidden (bot was blocked or lacks chat access)",
                404 => errorDesc ?? "Not Found (invalid bot token or endpoint on Telegram)",
                _ => errorDesc
            };
        }
    };

    private static DeliveryResult ParseTelegramSuccess(ILogger logger, int status, string? responseBody)
    {
        try
        {
            using var doc = JsonDocument.Parse(responseBody ?? string.Empty);
            if (doc.RootElement.TryGetProperty("ok", out var okProp) && okProp.GetBoolean())
            {
                // Success was previously silent, leaving zero log trace to diagnose a report
                // of "message delivered but UI still says failed". Logging it here means the
                // next such report has real evidence instead of nothing.
                logger.LogInformation("[TelegramSender] Delivery succeeded (HTTP {Status})", status);
                return DeliveryResult.Ok(status);
            }

            logger.LogWarning("[TelegramSender] Telegram 2xx response lacked ok:true");
            return DeliveryResult.Failed("InvalidResponse", status, permanent: false);
        }
        catch (Exception ex)
        {
            // Broad catch preserved intentionally: covers JSON parse failures as well as
            // unexpected token types (e.g. "ok" present but not a JSON boolean) so a malformed
            // 2xx body is reported as a non-retried InvalidResponse rather than surfacing as an
            // unhandled exception to the shared retry helper's outer network-error handling.
            logger.LogWarning("[TelegramSender] Failed parsing 2xx JSON response: {Error}", SecretRedactor.SanitizeExceptionMessage(ex));
            return DeliveryResult.Failed("InvalidResponse", status, permanent: false);
        }
    }

    /// <inheritdoc />
    public async Task<DeliveryResult> SendAsync(PlaybackNotificationPayload payload, string botToken, string chatId, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(chatId);

        if (!ValidateEndpoint(botToken, chatId, out var uri, out var errorCat))
        {
            _logger.LogWarning("[TelegramSender] Endpoint validation failed: {Category}", errorCat);
            return DeliveryResult.Failed(errorCat, 0, permanent: true);
        }

        var messageHtml = BuildTelegramMessageHtml(payload);
        var jsonPayload = JsonSerializer.Serialize(new Dictionary<string, object>
        {
            ["chat_id"] = chatId.Trim(),
            ["text"] = messageHtml,
            ["parse_mode"] = "HTML",
            ["protect_content"] = true,
            ["disable_web_page_preview"] = true
        });

        return await WebhookSenderRetryHelper.ExecuteWithRetryAsync(
            _httpClient,
            _logger,
            TelegramProfile,
            uri!,
            jsonPayload,
            DelayAsync,
            cancellationToken).ConfigureAwait(false);
    }

    public static TimeSpan? ParseTelegramRetryAfter(HttpResponseMessage response, string? responseBody)
    {
        ArgumentNullException.ThrowIfNull(response);

        if (!string.IsNullOrEmpty(responseBody))
        {
            try
            {
                using var doc = JsonDocument.Parse(responseBody);
                if (doc.RootElement.TryGetProperty("parameters", out var paramsProp) &&
                    paramsProp.TryGetProperty("retry_after", out var raProp) &&
                    raProp.TryGetInt32(out var secs) && secs > 0)
                {
                    return TimeSpan.FromSeconds(secs);
                }
            }
            catch { }
        }

        if (response.Headers.TryGetValues("Retry-After", out var values))
        {
            foreach (var val in values)
            {
                if (double.TryParse(val, NumberStyles.Any, CultureInfo.InvariantCulture, out var secs) && secs > 0)
                {
                    return TimeSpan.FromSeconds(secs);
                }
            }
        }

        return TimeSpan.FromSeconds(2);
    }

    /// <summary>
    /// Builds and escapes Telegram HTML message, enforcing 4096 character limits and tag integrity.
    /// </summary>
    public static string BuildTelegramMessageHtml(PlaybackNotificationPayload payload)
    {
        ArgumentNullException.ThrowIfNull(payload);

        var header = payload.EventType switch
        {
            NotificationEventType.Start => "🎬 <b>Playback Started</b>",
            NotificationEventType.Stop => "⏹️ <b>Playback Stopped</b>",
            NotificationEventType.Completion => "🎉 <b>Playback Completed</b>",
            NotificationEventType.Pause => "⏸️ <b>Playback Paused</b>",
            NotificationEventType.Resume => "▶️ <b>Playback Resumed</b>",
            NotificationEventType.Progress => "⏱️ <b>Playback Progress</b>",
            _ => "🎬 <b>Playback Event</b>"
        };

        var sb = new StringBuilder();
        sb.Append(header).Append("\n\n");

        if (!string.IsNullOrEmpty(payload.SeriesName))
        {
            sb.Append("<b>Series:</b> ").Append(EscapeHtml(payload.SeriesName)).Append('\n');
            if (payload.SeasonNumber.HasValue && payload.EpisodeNumber.HasValue)
            {
                sb.Append("<b>Episode:</b> ").Append(CultureInfo.InvariantCulture, $"S{payload.SeasonNumber:D2}E{payload.EpisodeNumber:D2} — ").Append(EscapeHtml(payload.MediaTitle)).Append('\n');
            }
            else
            {
                sb.Append("<b>Title:</b> ").Append(EscapeHtml(payload.MediaTitle)).Append('\n');
            }
        }
        else
        {
            sb.Append("<b>Movie:</b> ").Append(EscapeHtml(payload.MediaTitle));
            if (payload.ProductionYear.HasValue && payload.ProductionYear > 0)
            {
                sb.Append(CultureInfo.InvariantCulture, $" ({payload.ProductionYear})");
            }
            sb.Append('\n');
        }

        if (!string.IsNullOrEmpty(payload.Username))
        {
            sb.Append("<b>User:</b> ").Append(EscapeHtml(payload.Username)).Append('\n');
        }

        if (!string.IsNullOrEmpty(payload.ClientName))
        {
            var clientStr = string.IsNullOrEmpty(payload.DeviceName) ? payload.ClientName : $"{payload.ClientName} ({payload.DeviceName})";
            sb.Append("<b>Client:</b> ").Append(EscapeHtml(clientStr)).Append('\n');
        }

        sb.Append("<b>Stream:</b> ").Append(EscapeHtml(payload.PlayMethod)).Append('\n');
        sb.Append("<b>Video:</b> ").Append(EscapeHtml(payload.VideoStatus)).Append('\n');
        sb.Append("<b>Audio:</b> ").Append(EscapeHtml(payload.AudioStatus)).Append('\n');

        if (!string.IsNullOrEmpty(payload.Resolution) || !string.IsNullOrEmpty(payload.VideoCodec))
        {
            var vid = $"{payload.VideoCodec ?? ""} {payload.Resolution ?? ""}".Trim();
            if (!string.IsNullOrEmpty(payload.DynamicRange)) vid += $" • {payload.DynamicRange}";
            sb.Append("<b>Format:</b> ").Append(EscapeHtml(vid)).Append('\n');
        }

        if (!string.IsNullOrEmpty(payload.AudioCodec))
        {
            var aud = $"{payload.AudioCodec}".Trim();
            if (!string.IsNullOrEmpty(payload.AudioChannels)) aud += $" • {payload.AudioChannels}";
            sb.Append("<b>Audio Format:</b> ").Append(EscapeHtml(aud)).Append('\n');
        }

        if (!string.IsNullOrEmpty(payload.Container))
        {
            var cStr = !string.IsNullOrEmpty(payload.SourceContainer) && !payload.SourceContainer.Equals(payload.Container, StringComparison.OrdinalIgnoreCase)
                ? $"{payload.SourceContainer.ToUpperInvariant()} → {payload.Container.ToUpperInvariant()}"
                : payload.Container.ToUpperInvariant();
            sb.Append("<b>Container:</b> ").Append(EscapeHtml(cStr)).Append('\n');
        }

        if (payload.TotalDuration.HasValue && payload.TotalDuration.Value > TimeSpan.Zero)
        {
            var pos = payload.Position.ToString(@"hh\:mm\:ss", CultureInfo.InvariantCulture);
            var dur = payload.TotalDuration.Value.ToString(@"hh\:mm\:ss", CultureInfo.InvariantCulture);
            var pct = payload.PlaybackPercentage.HasValue ? $" ({payload.PlaybackPercentage}%)" : "";
            sb.Append("<b>Progress:</b> ").Append(CultureInfo.InvariantCulture, $"{pos} / {dur}{pct}\n");
        }

        if (!string.IsNullOrEmpty(payload.TranscodeReasonsWhy) &&
            !payload.TranscodeReasonsWhy.Equals("Reason not reported by server", StringComparison.OrdinalIgnoreCase))
        {
            var engine = !string.IsNullOrEmpty(payload.TranscodeEngine) ? $" [{payload.TranscodeEngine}]" : "";
            sb.Append("<b>Transcode Reason:</b> ").Append(EscapeHtml(payload.TranscodeReasonsWhy + engine)).Append('\n');
        }

        return TruncateHtmlSafely(sb.ToString(), 4096);
    }

    public static string EscapeHtml(string? input)
    {
        if (string.IsNullOrEmpty(input)) return string.Empty;
        return WebUtility.HtmlEncode(input);
    }

    /// <summary>
    /// Truncates string to character limit while respecting Unicode code points and closing unclosed HTML tags.
    /// Guarantees that the final returned string (including all closing tags) does not exceed maxChars.
    /// </summary>
    public static string TruncateHtmlSafely(string html, int maxChars)
    {
        if (string.IsNullOrEmpty(html) || html.Length <= maxChars)
        {
            return html;
        }

        // Ellipsis is 3 chars. We search for a cut point such that sub + "..." + closingTags <= maxChars
        // and does not slice mid-tag (<...>) or mid-entity (&...;).
        var maxLimit = Math.Max(1, maxChars - 3);
        var cut = Math.Min(html.Length, maxLimit);

        while (cut > 0)
        {
            var sub = html.Substring(0, cut);

            // Never split a UTF-16 surrogate pair
            if (char.IsHighSurrogate(sub[sub.Length - 1]))
            {
                cut--;
                continue;
            }

            // Check if cut is inside an HTML tag <...>
            var lastLt = sub.LastIndexOf('<');
            if (lastLt != -1 && sub.IndexOf('>', lastLt) == -1)
            {
                cut = lastLt;
                continue;
            }

            // Check if cut is inside an HTML entity &...;
            var lastAmp = sub.LastIndexOf('&');
            if (lastAmp != -1 && sub.IndexOf(';', lastAmp) == -1 && cut - lastAmp < 12)
            {
                cut = lastAmp;
                continue;
            }

            var openTags = GetOpenTagsStack(sub);
            var closingLen = 0;
            foreach (var tag in openTags)
            {
                closingLen += tag.Length + 3; // "</" + tag + ">"
            }

            if (sub.Length + 3 + closingLen <= maxChars)
            {
                var sb = new StringBuilder(sub).Append("...");
                while (openTags.Count > 0)
                {
                    sb.Append("</").Append(openTags.Pop()).Append('>');
                }
                return sb.ToString();
            }

            var overflow = (sub.Length + 3 + closingLen) - maxChars;
            cut -= Math.Max(1, overflow);
        }

        return "...";
    }

    private static Stack<string> GetOpenTagsStack(string text)
    {
        var stack = new Stack<string>();
        var idx = 0;
        while ((idx = text.IndexOf('<', idx)) != -1)
        {
            var closeGt = text.IndexOf('>', idx);
            if (closeGt == -1) break;

            var tagContent = text.Substring(idx + 1, closeGt - idx - 1).Trim();
            idx = closeGt + 1;

#pragma warning disable CA1308 // HTML tags emitted to Telegram API must be lowercase
            if (tagContent.StartsWith('/'))
            {
                var tagName = tagContent.Substring(1).Trim().ToLowerInvariant();
                if (stack.Count > 0 && stack.Peek().Equals(tagName, StringComparison.OrdinalIgnoreCase))
                {
                    stack.Pop();
                }
            }
            else
            {
                var spaceIdx = tagContent.IndexOf(' ', StringComparison.Ordinal);
                var tagName = (spaceIdx > 0 ? tagContent.Substring(0, spaceIdx) : tagContent).Trim().ToLowerInvariant();
                if (!tagContent.EndsWith('/') && !string.IsNullOrEmpty(tagName))
                {
                    stack.Push(tagName);
                }
            }
#pragma warning restore CA1308
        }
        return stack;
    }

    private static string? ParseTelegramErrorDescription(string? responseBody)
    {
        if (string.IsNullOrWhiteSpace(responseBody)) return null;
        try
        {
            using var doc = JsonDocument.Parse(responseBody);
            if (doc.RootElement.TryGetProperty("description", out var descProp) && descProp.ValueKind == JsonValueKind.String)
            {
                var desc = descProp.GetString();
                if (!string.IsNullOrWhiteSpace(desc))
                {
                    return SecretRedactor.Redact(desc);
                }
            }
        }
        catch (JsonException)
        {
            // Ignore parse failures
        }
        return null;
    }
}
