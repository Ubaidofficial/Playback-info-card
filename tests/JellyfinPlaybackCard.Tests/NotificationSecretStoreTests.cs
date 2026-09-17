using System;
using System.IO;
using Jellyfin.Plugin.PlaybackCard.Notifications;
using Xunit;

namespace JellyfinPlaybackCard.Tests;

public class NotificationSecretStoreTests : IDisposable
{
    private readonly string _tempFile;

    public NotificationSecretStoreTests()
    {
        _tempFile = Path.Combine(Path.GetTempPath(), $"secrets_test_{Guid.NewGuid():N}.json");
    }

    public void Dispose()
    {
        try
        {
            if (File.Exists(_tempFile))
            {
                File.Delete(_tempFile);
            }
            var keyFile = Path.ChangeExtension(_tempFile, ".key");
            if (File.Exists(keyFile))
            {
                File.Delete(keyFile);
            }
        }
        catch
        {
            // Ignore cleanup errors
        }
    }

    [Fact]
    public void Store_InitializesEmpty_WhenFileDoesNotExist()
    {
        var store = new NotificationSecretStore(customFilePath: _tempFile);

        Assert.Empty(store.GetDiscordWebhookUrl());
        Assert.Empty(store.GetTelegramBotToken());
        Assert.Empty(store.GetConfiguredSecrets());
    }

    [Fact]
    public void Store_PersistsSecretsToFile_AndReloadsCorrectly()
    {
        var store1 = new NotificationSecretStore(customFilePath: _tempFile);
        var webhook = "https://discord.com/api/webhooks/123456789/mySecretDiscordToken";
        var botToken = "123456789:mySecretTelegramToken";

        store1.SetDiscordWebhookUrl(webhook);
        store1.SetTelegramBotToken(botToken);

        Assert.Equal(webhook, store1.GetDiscordWebhookUrl());
        Assert.Equal(botToken, store1.GetTelegramBotToken());
        Assert.True(File.Exists(_tempFile));

        // Create a new store instance pointing to the same file to verify reload
        var store2 = new NotificationSecretStore(customFilePath: _tempFile);
        Assert.Equal(webhook, store2.GetDiscordWebhookUrl());
        Assert.Equal(botToken, store2.GetTelegramBotToken());

        var secrets = store2.GetConfiguredSecrets();
        Assert.Contains(webhook, secrets);
        Assert.Contains(botToken, secrets);
    }

    [Fact]
    public void Store_SynchronizesWithSecretRedactor()
    {
        var store = new NotificationSecretStore(customFilePath: _tempFile);
        var customSecretToken = "uniqueSecretToken998877";
        var webhook = $"https://discord.com/api/webhooks/123456789/{customSecretToken}";

        store.SetDiscordWebhookUrl(webhook);

        var logText = $"Error sending to endpoint: {webhook}";
        var redacted = SecretRedactor.RedactKnownSecrets(logText, store.GetConfiguredSecrets());

        Assert.DoesNotContain(customSecretToken, redacted);
    }

    [Fact]
    public void Store_ClearOperations_RemovesSecretsPermanently()
    {
        var store = new NotificationSecretStore(customFilePath: _tempFile);
        store.SetDiscordWebhookUrl("https://discord.com/api/webhooks/111/token111");
        store.SetTelegramBotToken("12345:token222");

        store.ClearDiscordWebhookUrl();
        Assert.Empty(store.GetDiscordWebhookUrl());
        Assert.Equal("12345:token222", store.GetTelegramBotToken());

        store.ClearAll();
        Assert.Empty(store.GetDiscordWebhookUrl());
        Assert.Empty(store.GetTelegramBotToken());
        Assert.Empty(store.GetConfiguredSecrets());
    }

    [Fact]
    public void Store_WritesEncryptedFile_WithMagicHeader_AndNoPlaintextSecrets()
    {
        var store = new NotificationSecretStore(customFilePath: _tempFile);
        var webhook = "https://discord.com/api/webhooks/999888777/VerySecretWebhookToken12345";
        var botToken = "999888777:VerySecretTelegramBotToken67890";

        store.SetDiscordWebhookUrl(webhook);
        store.SetTelegramBotToken(botToken);

        Assert.True(File.Exists(_tempFile));
        var keyFile = Path.ChangeExtension(_tempFile, ".key");
        Assert.True(File.Exists(keyFile));

        var rawBytes = File.ReadAllBytes(_tempFile);
        // Assert PCK1 header (0x50, 0x43, 0x4B, 0x31)
        Assert.True(rawBytes.Length >= 4 + 12 + 16);
        Assert.Equal(0x50, rawBytes[0]); // 'P'
        Assert.Equal(0x43, rawBytes[1]); // 'C'
        Assert.Equal(0x4B, rawBytes[2]); // 'K'
        Assert.Equal(0x31, rawBytes[3]); // '1'

        // Raw bytes converted to string must NEVER contain the plaintext secrets
        var rawText = System.Text.Encoding.UTF8.GetString(rawBytes);
        Assert.DoesNotContain("VerySecretWebhookToken12345", rawText);
        Assert.DoesNotContain("VerySecretTelegramBotToken67890", rawText);

        // Key file must be 32 bytes (256 bits)
        var keyBytes = File.ReadAllBytes(keyFile);
        Assert.Equal(32, keyBytes.Length);
    }

    [Fact]
    public void MigrateLegacyConfiguration_ScansAndStripsSecretsFromXml_AndIsIdempotent()
    {
        var tempDir = Path.Combine(Path.GetTempPath(), $"legacy_config_{Guid.NewGuid():N}");
        Directory.CreateDirectory(tempDir);
        var xmlPath = Path.Combine(tempDir, "PlaybackCard.xml");
        try
        {
            var initialXml = @"<?xml version=""1.0"" encoding=""utf-8""?>
<PluginConfiguration xmlns:xsi=""http://www.w3.org/2001/XMLSchema-instance"" xmlns:xsd=""http://www.w3.org/2001/XMLSchema"">
  <PlaybackCardEnabled>true</PlaybackCardEnabled>
  <PollIntervalSeconds>5</PollIntervalSeconds>
  <DiscordWebhookUrl>https://discord.com/api/webhooks/123/legacySecretDiscordToken</DiscordWebhookUrl>
  <TelegramBotToken>12345:legacySecretTelegramToken</TelegramBotToken>
  <BazarrApiKey>legacyBazarrKey12345</BazarrApiKey>
  <RadarrApiKey>legacyRadarrKey12345</RadarrApiKey>
  <SonarrApiKey>legacySonarrKey12345</SonarrApiKey>
</PluginConfiguration>";

            File.WriteAllText(xmlPath, initialXml);

            var store = new NotificationSecretStore(customFilePath: _tempFile);
            NotificationSecretStore.MigrateLegacyConfiguration(tempDir, store);

            // Verify secrets are migrated into the store
            Assert.Equal("https://discord.com/api/webhooks/123/legacySecretDiscordToken", store.GetDiscordWebhookUrl());
            Assert.Equal("12345:legacySecretTelegramToken", store.GetTelegramBotToken());

            // Verify secrets are scrubbed from disk XML
            var scrubbedXml = File.ReadAllText(xmlPath);
            Assert.DoesNotContain("legacySecretDiscordToken", scrubbedXml);
            Assert.DoesNotContain("legacySecretTelegramToken", scrubbedXml);
            Assert.DoesNotContain("legacyBazarrKey12345", scrubbedXml);
            Assert.DoesNotContain("legacyRadarrKey12345", scrubbedXml);
            Assert.DoesNotContain("legacySonarrKey12345", scrubbedXml);
            Assert.DoesNotContain("<DiscordWebhookUrl>", scrubbedXml);
            Assert.DoesNotContain("<TelegramBotToken>", scrubbedXml);
            Assert.DoesNotContain("<BazarrApiKey>", scrubbedXml);
            Assert.Contains("<PlaybackCardEnabled>true</PlaybackCardEnabled>", scrubbedXml);

            // Verify idempotency: run migration again
            NotificationSecretStore.MigrateLegacyConfiguration(tempDir, store);
            var recheckedXml = File.ReadAllText(xmlPath);
            Assert.Equal(scrubbedXml, recheckedXml);
            Assert.Equal("https://discord.com/api/webhooks/123/legacySecretDiscordToken", store.GetDiscordWebhookUrl());
        }
        finally
        {
            try
            {
                if (Directory.Exists(tempDir))
                {
                    Directory.Delete(tempDir, recursive: true);
                }
            }
            catch
            {
                // ignore
            }
        }
    }

    [Fact]
    public void Store_HandlesCorruptedOrTamperedFile_GracefullyWithoutCrashing()
    {
        // Write invalid corrupted bytes with PCK1 header
        var corrupted = new byte[] { 0x50, 0x43, 0x4B, 0x31, 0x01, 0x02, 0x03 };
        File.WriteAllBytes(_tempFile, corrupted);

        // Store initialization should handle corruption gracefully and default to empty
        var store = new NotificationSecretStore(customFilePath: _tempFile);
        Assert.Empty(store.GetDiscordWebhookUrl());
        Assert.Empty(store.GetTelegramBotToken());
        Assert.Empty(store.GetConfiguredSecrets());
    }

    [Fact]
    public void Store_SetSecrets_TrimsLeadingAndTrailingWhitespace()
    {
        var store = new NotificationSecretStore(customFilePath: _tempFile);
        store.SetDiscordWebhookUrl("   https://discord.com/api/webhooks/123/token   \n");
        store.SetTelegramBotToken("   12345:token   \r\n");

        Assert.Equal("https://discord.com/api/webhooks/123/token", store.GetDiscordWebhookUrl());
        Assert.Equal("12345:token", store.GetTelegramBotToken());
    }

    [Fact]
    public void WindowsDpapi_ProtectAndUnprotect_RoundTripOrFallback()
    {
        var testKey = new byte[32];
        System.Security.Cryptography.RandomNumberGenerator.Fill(testKey);

        var protectedBytes = NotificationSecretStore.WindowsDpapi.Protect(testKey);
        Assert.NotNull(protectedBytes);
        Assert.NotEmpty(protectedBytes);

        var decryptedBytes = NotificationSecretStore.WindowsDpapi.Unprotect(protectedBytes);
        Assert.NotNull(decryptedBytes);
        Assert.Equal(testKey, decryptedBytes);
    }

    [Fact]
    public void WindowsDpapi_HandlesNullAndEmptySafely()
    {
        Assert.Empty(NotificationSecretStore.WindowsDpapi.Protect(Array.Empty<byte>()));
        Assert.Empty(NotificationSecretStore.WindowsDpapi.Unprotect(Array.Empty<byte>()));
        Assert.Empty(NotificationSecretStore.WindowsDpapi.Protect(null!));
        Assert.Empty(NotificationSecretStore.WindowsDpapi.Unprotect(null!));
    }
}
