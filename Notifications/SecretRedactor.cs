using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Text.RegularExpressions;

namespace Jellyfin.Plugin.PlaybackCard.Notifications;

/// <summary>
/// Centralized security helper providing structured secret redaction, masking, and exception sanitization.
/// Prevents Discord webhook URLs/tokens, Telegram bot tokens, chat IDs, passwords, and query credentials
/// from leaking into logs, exceptions, diagnostics, or UI.
/// Redacts both by explicit configured secret values and by structural regex patterns.
/// </summary>
public static class SecretRedactor
{
    private static readonly ConcurrentDictionary<string, byte> ConfiguredSecrets = new(StringComparer.OrdinalIgnoreCase);

    private static readonly Regex TelegramTokenRegex = new(
        @"bot[0-9]+:[a-zA-Z0-9_\-]+",
        RegexOptions.Compiled | RegexOptions.IgnoreCase);

    private static readonly Regex RawTelegramTokenRegex = new(
        @"\b[0-9]{8,11}:[a-zA-Z0-9_\-]{30,50}\b",
        RegexOptions.Compiled);

    private static readonly Regex DiscordWebhookRegex = new(
        @"(https://(?:discord\.com|discordapp\.com)/api/webhooks/\d+/)[a-zA-Z0-9_\-]+",
        RegexOptions.Compiled | RegexOptions.IgnoreCase);

    private static readonly Regex QuerySecretRegex = new(
        @"([?&](?:token|api_key|key|secret|password|auth|webhook)=)[^&\s""'>]+",
        RegexOptions.Compiled | RegexOptions.IgnoreCase);

    private static readonly Regex JsonCredentialRegex = new(
        @"(""(?:token|password|secret|api_key|webhookUrl|botToken|authorization)""\s*:\s*"")[^""]+("")",
        RegexOptions.Compiled | RegexOptions.IgnoreCase);

    private static readonly Regex AuthHeaderRegex = new(
        @"(Authorization:\s*(?:Bearer|MediaBrowser|Token)\s+)[^\r\n]+",
        RegexOptions.Compiled | RegexOptions.IgnoreCase);

    /// <summary>
    /// Registers a configured secret value to be stripped by value wherever text is sanitized.
    /// </summary>
    public static void RegisterConfiguredSecret(string? secret)
    {
        if (!string.IsNullOrWhiteSpace(secret))
        {
            var trimmed = secret.Trim();
            if (trimmed.Length >= 8)
            {
                ConfiguredSecrets[trimmed] = 1;
            }
        }
    }

    /// <summary>
    /// Clears all dynamically registered secrets.
    /// </summary>
    public static void ClearConfiguredSecrets()
    {
        ConfiguredSecrets.Clear();
    }

    /// <summary>
    /// Redacts all configured secrets and structural credentials from a string.
    /// </summary>
    public static string Redact(string? input)
    {
        if (string.IsNullOrEmpty(input))
        {
            return string.Empty;
        }

        var result = input;

        // 1. Redact configured secrets by exact value
        foreach (var secret in ConfiguredSecrets.Keys)
        {
            if (result.Contains(secret, StringComparison.OrdinalIgnoreCase))
            {
                result = result.Replace(secret, "[REDACTED_SECRET]", StringComparison.OrdinalIgnoreCase);
            }
        }

        // 2. Structural redaction for Discord webhooks
        result = DiscordWebhookRegex.Replace(result, "$1[REDACTED_TOKEN]");

        // 3. Structural redaction for Telegram bot tokens
        result = TelegramTokenRegex.Replace(result, "bot[REDACTED_TOKEN]");
        result = RawTelegramTokenRegex.Replace(result, "[REDACTED_TOKEN]");

        // 4. URL query string secrets
        result = QuerySecretRegex.Replace(result, "$1[REDACTED]");

        // 5. JSON credential properties
        result = JsonCredentialRegex.Replace(result, "$1[REDACTED]$2");

        // 6. Authorization headers
        result = AuthHeaderRegex.Replace(result, "$1[REDACTED]");

        return result;
    }

    /// <summary>
    /// Redacts known configured secrets from an arbitrary string.
    /// </summary>
    public static string RedactKnownSecrets(string? input, IEnumerable<string?> secrets)
    {
        var text = Redact(input);
        if (string.IsNullOrEmpty(text))
        {
            return string.Empty;
        }

        ArgumentNullException.ThrowIfNull(secrets);

        foreach (var secret in secrets)
        {
            if (!string.IsNullOrWhiteSpace(secret) && secret.Length > 4 &&
                text.Contains(secret, StringComparison.OrdinalIgnoreCase))
            {
                text = text.Replace(secret, "[REDACTED_SECRET]", StringComparison.OrdinalIgnoreCase);
            }
        }

        return text;
    }

    /// <summary>
    /// Masks a Discord webhook URL for safe UI display and non-privileged responses.
    /// </summary>
    public static string MaskDiscordWebhook(string? webhookUrl)
    {
        if (string.IsNullOrWhiteSpace(webhookUrl))
        {
            return string.Empty;
        }

        if (Uri.TryCreate(webhookUrl, UriKind.Absolute, out var uri) &&
            (uri.Host.Equals("discord.com", StringComparison.OrdinalIgnoreCase) ||
             uri.Host.Equals("discordapp.com", StringComparison.OrdinalIgnoreCase)))
        {
            return $"https://{uri.Host}/api/webhooks/••••••••";
        }

        return "https://discord.com/api/webhooks/••••••••";
    }

    /// <summary>
    /// Masks a Telegram bot token for safe UI display and non-privileged responses.
    /// </summary>
    public static string MaskTelegramToken(string? token)
    {
        if (string.IsNullOrWhiteSpace(token))
        {
            return string.Empty;
        }

        var colonIdx = token.IndexOf(':', StringComparison.Ordinal);
        if (colonIdx > 0 && colonIdx < token.Length - 1)
        {
            var botId = token.Substring(0, colonIdx);
            return $"{botId}:••••••••••••••••";
        }

        return "••••••••••••••••";
    }

    /// <summary>
    /// Sanitizes an exception message to guarantee no tokens or webhook URLs are leaked.
    /// Recursively scrubs inner exception messages.
    /// </summary>
    public static string SanitizeExceptionMessage(Exception? ex)
    {
        if (ex is null)
        {
            return "Unknown error";
        }

        var msg = ex.Message;
        var sanitized = Redact(msg);

        if (ex.InnerException != null)
        {
            sanitized += " --> " + SanitizeExceptionMessage(ex.InnerException);
        }

        return sanitized;
    }
}
