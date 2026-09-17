using System;
using System.Reflection;
using Jellyfin.Plugin.PlaybackCard.Notifications;
using Xunit;

namespace JellyfinPlaybackCard.Tests;

public class SecurityAndPrivacyTests
{
    [Fact]
    public void SecretRedactor_MaskDiscordWebhook_MasksUrlCorrectly()
    {
        var rawUrl = "https://discord.com/api/webhooks/123456789/abcdefghijk_secret_token_value";
        var masked = SecretRedactor.MaskDiscordWebhook(rawUrl);

        Assert.NotNull(masked);
        Assert.DoesNotContain("abcdefghijk_secret_token_value", masked);
        Assert.StartsWith("https://discord.com/api/webhooks/", masked);
        Assert.EndsWith("••••••••", masked);
    }

    [Fact]
    public void SecretRedactor_MaskTelegramToken_MasksTokenCorrectly()
    {
        var rawToken = "123456789:ABCdefGhIjKlMnOpQrStUvWxYz123456";
        var masked = SecretRedactor.MaskTelegramToken(rawToken);

        Assert.NotNull(masked);
        Assert.DoesNotContain("ABCdefGhIjKlMnOpQrStUvWxYz123456", masked);
        Assert.StartsWith("123456789:", masked);
        Assert.EndsWith("••••••••••••••••", masked);
    }

    [Fact]
    public void SecretRedactor_SanitizeExceptionMessage_RedactsWebhooksAndTokens()
    {
        var ex = new InvalidOperationException("Failed connecting to https://discord.com/api/webhooks/987654321/super_secret_discord_token with bot11223344:my_bot_secret_token_12345");
        var sanitized = SecretRedactor.SanitizeExceptionMessage(ex);

        Assert.DoesNotContain("super_secret_discord_token", sanitized);
        Assert.DoesNotContain("my_bot_secret_token_12345", sanitized);
        Assert.Contains("[REDACTED_TOKEN]", sanitized);
    }

    [Fact]
    public void SecretRedactor_ShortStringsUnder8Chars_NotRegisteredAsSecrets()
    {
        SecretRedactor.RegisterConfiguredSecret("short");
        SecretRedactor.RegisterConfiguredSecret("1234567");
        SecretRedactor.RegisterConfiguredSecret("");

        var text = "This is a short test message containing 1234567 and nothing else.";
        var sanitized = SecretRedactor.Redact(text);

        // Common short words must NOT be replaced with [REDACTED_SECRET]
        Assert.Equal(text, sanitized);
    }

    [Fact]
    public void OutboundDto_ReflectionAssertion_ZeroForbiddenFields()
    {
        var forbiddenTerms = new[]
        {
            "Id",
            "SessionId",
            "PlaySessionId",
            "RemoteEndPoint",
            "RemoteEndpoint",
            "IpAddress",
            "IPAddress",
            "ip_address",
            "ClientIp",
            "Endpoint",
            "Lan",
            "Wan",
            "Cellular",
            "Wifi",
            "UserToken",
            "Password",
            "FilePath",
            "LocalPath",
            "Path"
        };

        var typesToAudit = new[]
        {
            typeof(PlaybackNotificationPayload),
            typeof(NotificationDiagnosticsSnapshot),
            typeof(Jellyfin.Plugin.PlaybackCard.Controllers.UserPlaybackSessionDto)
        };

        foreach (var type in typesToAudit)
        {
            var properties = type.GetProperties(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance);
            foreach (var prop in properties)
            {
                foreach (var forbidden in forbiddenTerms)
                {
                    Assert.False(
                        prop.Name.Equals(forbidden, StringComparison.OrdinalIgnoreCase),
                        $"Forbidden field '{prop.Name}' found on outbound type '{type.Name}'."
                    );
                }
            }

            var fields = type.GetFields(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance);
            foreach (var field in fields)
            {
                foreach (var forbidden in forbiddenTerms)
                {
                    Assert.False(
                        field.Name.Equals(forbidden, StringComparison.OrdinalIgnoreCase),
                        $"Forbidden field '{field.Name}' found on outbound type '{type.Name}'."
                    );
                }
            }
        }

        // Public properties of PlaybackEventRecord must NOT include PlaySessionId or SessionId
        var recordProps = typeof(PlaybackEventRecord).GetProperties(BindingFlags.Public | BindingFlags.Instance);
        foreach (var prop in recordProps)
        {
            Assert.False(
                prop.Name.Equals("PlaySessionId", StringComparison.OrdinalIgnoreCase) ||
                prop.Name.Equals("SessionId", StringComparison.OrdinalIgnoreCase),
                $"Forbidden public property '{prop.Name}' found on PlaybackEventRecord."
            );
        }
    }

    [Fact]
    public void Assembly_PackagingAndMetadata_StrictVerification()
    {
        var asm = typeof(Jellyfin.Plugin.PlaybackCard.Plugin).Assembly;

        // Strict 0.2.3.5 version check
        Assert.Equal(new Version(0, 2, 3, 5), asm.GetName().Version);

        // Embedded resources
        var resources = asm.GetManifestResourceNames();
        Assert.Contains("Jellyfin.Plugin.PlaybackCard.Web.playbackcard.html", resources);
        Assert.Contains("Jellyfin.Plugin.PlaybackCard.Web.dashboard.js", resources);
        Assert.Contains("Jellyfin.Plugin.PlaybackCard.Web.dashboard.css", resources);

        // Embedded HTML resource content check
        using var stream = asm.GetManifestResourceStream("Jellyfin.Plugin.PlaybackCard.Web.playbackcard.html");
        Assert.NotNull(stream);
        using var reader = new System.IO.StreamReader(stream);
        var html = reader.ReadToEnd();
        Assert.NotEmpty(html);
        Assert.Contains("v0.2.3.5", html);
        Assert.Contains("playbackCardContainer", html);
    }
}
