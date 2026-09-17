using System;
using System.Collections.Generic;
using System.IO;
using System.Security.Cryptography;
using System.Text;
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

    /// <summary>
    /// Subscribes to <see cref="NotificationSecretStore.DiagnosticWarningRaised"/> for the duration of
    /// <paramref name="action"/> and returns every warning message raised while it ran.
    /// </summary>
    private static List<string> CaptureDiagnosticWarnings(Action action)
    {
        var captured = new List<string>();
        void Handler(string msg) => captured.Add(msg);

        NotificationSecretStore.DiagnosticWarningRaised += Handler;
        try
        {
            action();
        }
        finally
        {
            NotificationSecretStore.DiagnosticWarningRaised -= Handler;
        }

        return captured;
    }

    // ---- Bug 1: weak, guessable fallback encryption key ----

    [Fact]
    public void GetOrCreateMasterKey_NormalPath_StillWorksAndIsNotUsingFallback()
    {
        var store = new NotificationSecretStore(customFilePath: _tempFile);

        Assert.False(store.IsUsingInMemoryFallbackMasterKey);

        var key1 = store.GetMasterKeyForTests();
        var key2 = store.GetMasterKeyForTests();
        Assert.Equal(32, key1.Length);
        Assert.Equal(key1, key2); // stable across repeated calls when nothing failed
    }

    [Fact]
    public void GetOrCreateMasterKey_FallsBackToRandomInMemoryKey_WhenKeyFileIoFails()
    {
        // Force the master key *file path* itself to be an existing directory rather than a file.
        // GetOrCreateMasterKey can still write its temp key file (it lands in the same writable
        // parent directory as the main secrets file), but the final File.Move onto the key path
        // fails because a directory occupies that exact path -- a reliable, cross-platform I/O
        // failure that does NOT interfere with the main secrets file's own directory, so we can
        // still verify a genuine encrypt-then-decrypt round trip through real disk I/O below.
        var keyPath = Path.ChangeExtension(_tempFile, ".key");
        Directory.CreateDirectory(keyPath);
        try
        {
            var store1 = new NotificationSecretStore(customFilePath: _tempFile);

            byte[] key1 = null!;
            var warnings1 = CaptureDiagnosticWarnings(() =>
            {
                key1 = store1.GetMasterKeyForTests();
            });

            Assert.True(store1.IsUsingInMemoryFallbackMasterKey);
            Assert.Equal(32, key1.Length);

            var derivableKey = SHA256.HashData(Encoding.UTF8.GetBytes(AppContext.BaseDirectory + "_playback_card_fallback"));
            Assert.NotEqual(derivableKey, key1);
            Assert.Contains(warnings1, w => w.Contains("in-memory-only", StringComparison.OrdinalIgnoreCase));

            // The fallback key must round-trip correctly for the lifetime of the process: setting
            // a secret encrypts and persists it to disk under the cached fallback key, and reloading
            // from that same disk file must decrypt correctly using the SAME cached key.
            store1.SetDiscordWebhookUrl("https://discord.com/api/webhooks/1/inMemoryFallbackToken");
            Assert.True(File.Exists(_tempFile));
            store1.Reload();
            Assert.Equal("https://discord.com/api/webhooks/1/inMemoryFallbackToken", store1.GetDiscordWebhookUrl());

            // A second, independently constructed instance hitting the same failure must mint its
            // OWN random key -- not a deterministic one derived from any shared/public input.
            var store2 = new NotificationSecretStore(customFilePath: _tempFile);
            var key2 = store2.GetMasterKeyForTests();
            Assert.True(store2.IsUsingInMemoryFallbackMasterKey);
            Assert.NotEqual(derivableKey, key2);
            Assert.NotEqual(key1, key2);
        }
        finally
        {
            try
            {
                Directory.Delete(keyPath, recursive: true);
            }
            catch
            {
                // best-effort cleanup
            }

            try
            {
                foreach (var stray in Directory.EnumerateFiles(Path.GetTempPath(), Path.GetFileName(keyPath) + ".tmp.*"))
                {
                    File.Delete(stray);
                }
            }
            catch
            {
                // best-effort cleanup
            }
        }
    }

    // ---- Bug 2: Windows ACL hardening silently no-ops on failure ----

    [Fact]
    public void ApplyWindowsRestrictedAcl_LogsWarning_WhenIcaclsCannotRun()
    {
        var path = Path.Combine(Path.GetTempPath(), $"acl_test_{Guid.NewGuid():N}.tmp");
        File.WriteAllText(path, "test");
        try
        {
            // On any host without a real icacls.exe on PATH/System32 (i.e. this test suite's CI and
            // local dev environments, which are not Windows), Process.Start throws or the tool is
            // simply absent -- deterministically exercising the failure path that used to be a bare
            // `catch { }` with zero logging.
            var warnings = CaptureDiagnosticWarnings(() =>
            {
                NotificationSecretStore.ApplyWindowsRestrictedAcl(path);
            });

            Assert.NotEmpty(warnings);
            Assert.Contains(warnings, w => w.Contains(path, StringComparison.Ordinal));
        }
        finally
        {
            File.Delete(path);
        }
    }

    // ---- Bug 3: master-key mismatch silently wipes stored secrets ----

    [Fact]
    public void Load_KeyMismatch_WipesInMemoryStateButPreservesEncryptedFileAndLogsWarning()
    {
        var store1 = new NotificationSecretStore(customFilePath: _tempFile);
        store1.SetDiscordWebhookUrl("https://discord.com/api/webhooks/1/keyMismatchTestToken");
        store1.SetTelegramBotToken("12345:keyMismatchTestToken");

        var keyFile = Path.ChangeExtension(_tempFile, ".key");
        Assert.True(File.Exists(keyFile));
        var originalEncryptedBytes = File.ReadAllBytes(_tempFile);

        // Simulate the on-disk master key changing since the file was encrypted (e.g. a prior
        // process fell back to a different key, or the key file was rotated/replaced). A raw
        // 32-byte key file is accepted as-is by WindowsDpapi.Unprotect on every platform, so this
        // is a reliable, cross-platform way to force a genuine key mismatch on the next Load().
        var differentKey = new byte[32];
        RandomNumberGenerator.Fill(differentKey);
        File.WriteAllBytes(keyFile, differentKey);

        NotificationSecretStore store2 = null!;
        var warnings = CaptureDiagnosticWarnings(() =>
        {
            store2 = new NotificationSecretStore(customFilePath: _tempFile);
        });

        // (a) in-memory state must be empty -- it genuinely cannot be decrypted without the right key
        Assert.Empty(store2.GetDiscordWebhookUrl());
        Assert.Empty(store2.GetTelegramBotToken());
        Assert.Empty(store2.GetConfiguredSecrets());

        // (b) a warning distinguishing a key mismatch from generic corruption must be observable
        Assert.Contains(warnings, w =>
            w.Contains("master key", StringComparison.OrdinalIgnoreCase) &&
            w.Contains("decrypt", StringComparison.OrdinalIgnoreCase));

        // (c) the original encrypted file on disk must NOT be overwritten/destroyed by the failed
        // load alone, so the data remains recoverable if the correct key is restored later.
        var afterBytes = File.ReadAllBytes(_tempFile);
        Assert.Equal(originalEncryptedBytes, afterBytes);
    }
}
