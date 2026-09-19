using System;
using System.IO;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.PlaybackCard.Notifications;

/// <summary>
/// Shared, best-effort loader for a poster image attachment on Discord/Telegram notifications.
/// A missing, unreadable, or oversized image must never fail the notification itself -- callers
/// treat a <c>null</c> return as "send the plain text message instead", not an error.
/// </summary>
internal static class WebhookImageLoader
{
    // Discord's default (non-boosted) attachment limit. Telegram's photo limit is higher (10MB),
    // but this is used as the single shared guard for both senders to keep behavior consistent
    // and comfortably under either limit.
    private const long MaxImageBytes = 8 * 1024 * 1024;

    public static byte[]? TryReadImageBytes(string? imagePath, ILogger logger, string senderTag)
    {
        if (string.IsNullOrWhiteSpace(imagePath))
        {
            return null;
        }

        try
        {
            var fileInfo = new FileInfo(imagePath);
            if (!fileInfo.Exists)
            {
                return null;
            }

            if (fileInfo.Length <= 0 || fileInfo.Length > MaxImageBytes)
            {
                logger.LogInformation("[{Tag}] Skipping poster image ({Size} bytes exceeds the {Max} byte limit or is empty)", senderTag, fileInfo.Length, MaxImageBytes);
                return null;
            }

            return File.ReadAllBytes(imagePath);
        }
        catch (Exception ex)
        {
            logger.LogInformation("[{Tag}] Could not read poster image, sending as text instead: {Error}", senderTag, SecretRedactor.SanitizeExceptionMessage(ex));
            return null;
        }
    }
}
