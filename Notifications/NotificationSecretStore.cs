using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Xml.Linq;
using MediaBrowser.Common.Configuration;

namespace Jellyfin.Plugin.PlaybackCard.Notifications;

/// <summary>
/// Contract for managing sensitive notification credentials isolated from public PluginConfiguration.
/// </summary>
public interface INotificationSecretStore
{
    string GetDiscordWebhookUrl();
    void SetDiscordWebhookUrl(string url);
    string GetTelegramBotToken();
    void SetTelegramBotToken(string token);
    void ClearDiscordWebhookUrl();
    void ClearTelegramBotToken();
    void ClearAll();
    IReadOnlyList<string> GetConfiguredSecrets();
    void Reload();
}

/// <summary>
/// Thread-safe server-local secret store.
/// Stores credentials encrypted using AES-256-GCM with owner-only file permissions (0600 on Unix)
/// within Jellyfin's plugin configuration directory.
/// Completely separates secrets from PluginConfiguration, preventing generic Jellyfin
/// configuration endpoints or XML serializers from leaking or overwriting credentials.
/// </summary>
public sealed class NotificationSecretStore : INotificationSecretStore
{
    private static readonly byte[] MagicHeader = new byte[] { 0x50, 0x43, 0x4B, 0x31 }; // "PCK1"
    private const int NonceSize = 12;
    private const int TagSize = 16;

    private readonly string _filePath;
    private readonly string _keyPath;
    private readonly object _lock = new();
    private SecretData _data = new();

    /// <summary>
    /// A random, process-lifetime-only master key used when the real (persisted, DPAPI-protected)
    /// master key cannot be read, created, or persisted due to an I/O or permission failure.
    /// Never derived from any predictable/public value (see <see cref="GetOrCreateMasterKey"/>).
    /// Once set, it is reused for the remainder of this instance's lifetime so that secrets
    /// encrypted under it earlier in the process's run can still be decrypted later in the same run.
    /// </summary>
    private byte[]? _inMemoryFallbackKey;

    /// <summary>
    /// Raised whenever this store detects and works around a degraded security condition it cannot
    /// safely ignore: the persistent master key could not be read/created/persisted (forcing a
    /// random in-memory-only fallback key), Windows ACL hardening on a secret-bearing file failed,
    /// or a master-key mismatch prevented decrypting previously stored secrets. This class is
    /// constructed directly by the plugin's DI registration (in a file this change must not touch),
    /// so it has no injected <c>ILogger</c>; this event plus <see cref="Trace.TraceWarning(string)"/>
    /// and standard error are the supported ways to observe these conditions.
    /// </summary>
    internal static event Action<string>? DiagnosticWarningRaised;

    private static void RaiseWarning(string message)
    {
        var formatted = "[PlaybackCard.NotificationSecretStore] " + message;

        try
        {
            Trace.TraceWarning(formatted);
        }
        catch
        {
            // Diagnostics reporting must never crash secret handling
        }

        try
        {
            Console.Error.WriteLine("WARNING: " + formatted);
        }
        catch
        {
            // Ignore
        }

        try
        {
            DiagnosticWarningRaised?.Invoke(message);
        }
        catch
        {
            // A misbehaving subscriber must never affect secret handling
        }
    }

    public NotificationSecretStore(IApplicationPaths? applicationPaths = null, string? customFilePath = null)
    {
        string? configDir = null;

        if (!string.IsNullOrEmpty(customFilePath))
        {
            _filePath = customFilePath;
            configDir = Path.GetDirectoryName(_filePath);
        }
        else if (applicationPaths != null && !string.IsNullOrEmpty(applicationPaths.PluginConfigurationsPath))
        {
            configDir = applicationPaths.PluginConfigurationsPath;
            _filePath = Path.Combine(configDir, "Jellyfin.Plugin.PlaybackCard.Secrets.json");
        }
        else if (Plugin.Instance != null && !string.IsNullOrEmpty(Plugin.Instance.ConfigurationFilePath))
        {
            configDir = Path.GetDirectoryName(Plugin.Instance.ConfigurationFilePath) ?? AppContext.BaseDirectory;
            _filePath = Path.Combine(configDir, "Jellyfin.Plugin.PlaybackCard.Secrets.json");
        }
        else
        {
            configDir = AppContext.BaseDirectory;
            _filePath = Path.Combine(configDir, "Jellyfin.Plugin.PlaybackCard.Secrets.json");
        }

        _keyPath = Path.ChangeExtension(_filePath, ".key");

        Load();

        // Perform one-time migration for legacy installations if configuration directory exists
        if (!string.IsNullOrEmpty(configDir))
        {
            MigrateLegacyConfiguration(configDir, this);
        }
    }

    public void Reload()
    {
        Load();
    }

    private byte[] GetOrCreateMasterKey()
    {
        // Once we've fallen back to a random in-memory-only key for this process, keep using it
        // consistently instead of intermittently retrying disk I/O. Otherwise a transient recovery
        // mid-run (e.g. a network share becoming writable again) could return a *different* real key
        // than the one secrets were just encrypted under, making them undecryptable within the same run.
        if (_inMemoryFallbackKey != null)
        {
            return _inMemoryFallbackKey;
        }

        try
        {
            if (File.Exists(_keyPath))
            {
                var storedBytes = File.ReadAllBytes(_keyPath);
                var decryptedKey = WindowsDpapi.Unprotect(storedBytes);
                if (decryptedKey.Length == 32)
                {
                    return decryptedKey;
                }
            }

            var dir = Path.GetDirectoryName(_keyPath);
            if (!string.IsNullOrEmpty(dir) && !Directory.Exists(dir))
            {
                Directory.CreateDirectory(dir);
            }

            var newKey = RandomNumberGenerator.GetBytes(32);
            var bytesToStore = WindowsDpapi.Protect(newKey);
            var tmpKeyPath = _keyPath + ".tmp." + Guid.NewGuid().ToString("N");

            File.WriteAllBytes(tmpKeyPath, bytesToStore);
            SetRestrictedPermissions(tmpKeyPath);

            File.Move(tmpKeyPath, _keyPath, overwrite: true);
            SetRestrictedPermissions(_keyPath);

            return newKey;
        }
        catch (Exception ex)
        {
            // NEVER fall back to a key derivable from public/predictable information (e.g. the
            // plugin's own install path) -- that would make the "encryption" trivially reversible
            // by anyone who can read the install path. Instead, mint a genuinely random key that
            // lives only in memory for the remainder of this process. Secrets will not persist
            // across restarts until the underlying I/O issue is resolved, so warn loudly.
            var fallbackKey = RandomNumberGenerator.GetBytes(32);
            _inMemoryFallbackKey = fallbackKey;

            RaiseWarning(
                "Could not read, create, or persist the master key file at '" + _keyPath + "' (" +
                ex.GetType().Name + ": " + ex.Message + "). Falling back to a random, in-memory-only " +
                "master key for this process. Discord/Telegram secrets will NOT persist across restarts " +
                "until the underlying storage/permission issue is resolved.");

            return fallbackKey;
        }
    }

    /// <summary>
    /// True once this instance has fallen back to a random in-memory-only master key because the
    /// real, persisted master key could not be read, created, or persisted. Exposed internally so
    /// diagnostics/tests can observe the degraded state without leaking key material.
    /// </summary>
    internal bool IsUsingInMemoryFallbackMasterKey => _inMemoryFallbackKey != null;

    /// <summary>
    /// Test-only accessor for the master key currently in effect (real or in-memory fallback).
    /// Only reachable from the test assembly via <c>InternalsVisibleTo</c>; never exposed publicly.
    /// </summary>
    internal byte[] GetMasterKeyForTests() => GetOrCreateMasterKey();

    private void Load()
    {
        lock (_lock)
        {
            try
            {
                if (File.Exists(_filePath))
                {
                    var fileBytes = File.ReadAllBytes(_filePath);

                    // Check for PCK1 encrypted binary payload
                    if (fileBytes.Length >= MagicHeader.Length + NonceSize + TagSize &&
                        fileBytes[0] == MagicHeader[0] &&
                        fileBytes[1] == MagicHeader[1] &&
                        fileBytes[2] == MagicHeader[2] &&
                        fileBytes[3] == MagicHeader[3])
                    {
                        var key = GetOrCreateMasterKey();
                        var nonce = new byte[NonceSize];
                        var tag = new byte[TagSize];
                        var cipherLength = fileBytes.Length - (MagicHeader.Length + NonceSize + TagSize);
                        var cipherBytes = new byte[cipherLength];
                        var plainBytes = new byte[cipherLength];

                        Buffer.BlockCopy(fileBytes, MagicHeader.Length, nonce, 0, NonceSize);
                        Buffer.BlockCopy(fileBytes, MagicHeader.Length + NonceSize, tag, 0, TagSize);
                        Buffer.BlockCopy(fileBytes, MagicHeader.Length + NonceSize + TagSize, cipherBytes, 0, cipherLength);

                        try
                        {
                            using var aes = new AesGcm(key, TagSize);
                            aes.Decrypt(nonce, cipherBytes, tag, plainBytes);

                            _data = JsonSerializer.Deserialize<SecretData>(plainBytes) ?? new SecretData();
                        }
                        catch (CryptographicException ex)
                        {
                            // The stored ciphertext failed authentication under the current master key.
                            // This is almost always a master-key MISMATCH (e.g. a prior run fell back to
                            // a different in-memory key, or the on-disk key file was replaced/rotated) --
                            // not a corrupt/tampered file. Distinguish it clearly in the warning, and do
                            // NOT let this failure alone trigger a save: only explicit Set/Clear calls may
                            // overwrite the (still intact, potentially recoverable-with-the-right-key)
                            // encrypted file on disk from here on.
                            RaiseWarning(
                                "Failed to decrypt secrets file '" + _filePath + "': the master key does not " +
                                "match the key used to encrypt this file (" + ex.GetType().Name + "). This " +
                                "usually means the master key changed since the file was last saved, not that " +
                                "the file is corrupt. Configured Discord/Telegram secrets could not be loaded " +
                                "and will appear unset until the correct master key is restored. The encrypted " +
                                "file on disk has NOT been modified by this failed load.");
                            _data = new SecretData();
                        }
                    }
                    else
                    {
                        // Check for legacy unencrypted JSON
                        try
                        {
                            var json = Encoding.UTF8.GetString(fileBytes);
                            _data = JsonSerializer.Deserialize<SecretData>(json) ?? new SecretData();
                            // Re-save immediately to encrypt on disk
                            SaveInternal();
                        }
                        catch
                        {
                            _data = new SecretData();
                        }
                    }
                }
                else
                {
                    _data = new SecretData();
                }
            }
            catch
            {
                // Corrupt, unreadable, or tampered secret files fail safely
                _data = new SecretData();
            }

            SyncWithRedactor();
        }
    }

    private void SaveInternal()
    {
        try
        {
            var dir = Path.GetDirectoryName(_filePath);
            if (!string.IsNullOrEmpty(dir) && !Directory.Exists(dir))
            {
                Directory.CreateDirectory(dir);
            }

            var key = GetOrCreateMasterKey();
            var jsonBytes = JsonSerializer.SerializeToUtf8Bytes(_data);

            var nonce = RandomNumberGenerator.GetBytes(NonceSize);
            var tag = new byte[TagSize];
            var cipherBytes = new byte[jsonBytes.Length];

            using (var aes = new AesGcm(key, TagSize))
            {
                aes.Encrypt(nonce, jsonBytes, cipherBytes, tag);
            }

            var payload = new byte[MagicHeader.Length + NonceSize + TagSize + cipherBytes.Length];
            Buffer.BlockCopy(MagicHeader, 0, payload, 0, MagicHeader.Length);
            Buffer.BlockCopy(nonce, 0, payload, MagicHeader.Length, NonceSize);
            Buffer.BlockCopy(tag, 0, payload, MagicHeader.Length + NonceSize, TagSize);
            Buffer.BlockCopy(cipherBytes, 0, payload, MagicHeader.Length + NonceSize + TagSize, cipherBytes.Length);

            var tmpPath = _filePath + ".tmp." + Guid.NewGuid().ToString("N");
            File.WriteAllBytes(tmpPath, payload);
            SetRestrictedPermissions(tmpPath);

            File.Move(tmpPath, _filePath, overwrite: true);
            SetRestrictedPermissions(_filePath);
        }
        catch (Exception ex)
        {
            // Fail safely without logging secret VALUES, but still surface that the write
            // itself failed -- silently swallowing this (as before) meant a save could report
            // success to the UI while the encrypted file on disk was never actually updated
            // (e.g. a transient network-share/NFS/CIFS hiccup on the config volume), so the
            // credential would vanish on the next restart with zero diagnostic trail.
            RaiseWarning(
                "Failed to persist secrets file '" + _filePath + "' (" + ex.GetType().Name + ": " +
                ex.Message + "). Discord/Telegram credentials just set may NOT survive a restart " +
                "until the underlying storage issue is resolved.");
        }
    }

    private void Save()
    {
        lock (_lock)
        {
            SaveInternal();
            SyncWithRedactor();
        }
    }

    private static void SetRestrictedPermissions(string path)
    {
        try
        {
            if (!OperatingSystem.IsWindows())
            {
                File.SetUnixFileMode(path, UnixFileMode.UserRead | UnixFileMode.UserWrite);
            }
            else
            {
                ApplyWindowsRestrictedAcl(path);
            }
        }
        catch
        {
            // Best effort on platforms with restrictive security managers
        }
    }

    /// <remarks>
    /// Internal rather than private so tests (via <c>InternalsVisibleTo</c>) can exercise the
    /// failure/logging path directly without depending on a Windows host or icacls.exe availability.
    /// </remarks>
    internal static void ApplyWindowsRestrictedAcl(string path)
    {
        try
        {
            string? targetAccount = null;
            if (OperatingSystem.IsWindows())
            {
                try
                {
                    var sid = System.Security.Principal.WindowsIdentity.GetCurrent()?.User?.Value;
                    if (!string.IsNullOrEmpty(sid))
                    {
                        targetAccount = $"*{sid}";
                    }
                    else
                    {
                        targetAccount = System.Security.Principal.WindowsIdentity.GetCurrent()?.Name;
                    }
                }
                catch
                {
                    // Fallback to Environment if WindowsIdentity query fails
                }
            }

            if (string.IsNullOrEmpty(targetAccount))
            {
                targetAccount = Environment.UserName;
            }

            if (string.IsNullOrEmpty(targetAccount))
            {
                return;
            }

            var systemDir = Environment.SystemDirectory;
            var icaclsPath = !string.IsNullOrEmpty(systemDir) ? Path.Combine(systemDir, "icacls.exe") : "icacls.exe";

            var psi = new ProcessStartInfo
            {
                FileName = icaclsPath,
                Arguments = $"\"{path}\" /inheritance:r /grant:r \"{targetAccount}:(R,W)\"",
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true
            };
            using var proc = Process.Start(psi);
            if (proc == null)
            {
                RaiseWarning(
                    "Failed to harden Windows file permissions on '" + path + "': icacls.exe could not be " +
                    "started (Process.Start returned null). This file may remain readable/writable by more " +
                    "than the current user.");
                return;
            }

            var exited = proc.WaitForExit(2000);
            if (!exited)
            {
                RaiseWarning(
                    "Failed to harden Windows file permissions on '" + path + "': icacls.exe did not exit " +
                    "within 2000ms (timed out). This file may remain readable/writable by more than the " +
                    "current user.");
                return;
            }

            if (proc.ExitCode != 0)
            {
                RaiseWarning(
                    "Failed to harden Windows file permissions on '" + path + "': icacls.exe exited with " +
                    "code " + proc.ExitCode + ". This file may remain readable/writable by more than the " +
                    "current user.");
            }
        }
        catch (Exception ex)
        {
            RaiseWarning(
                "Failed to harden Windows file permissions on '" + path + "': " + ex.GetType().Name + ": " +
                ex.Message + ". This file may remain readable/writable by more than the current user.");
        }
    }

    private void SyncWithRedactor()
    {
        SecretRedactor.ClearConfiguredSecrets();
        if (!string.IsNullOrWhiteSpace(_data.DiscordWebhookUrl))
        {
            SecretRedactor.RegisterConfiguredSecret(_data.DiscordWebhookUrl);
            var segments = _data.DiscordWebhookUrl.Trim('/').Split('/');
            if (segments.Length >= 4)
            {
                SecretRedactor.RegisterConfiguredSecret(segments[^1]);
            }
        }

        if (!string.IsNullOrWhiteSpace(_data.TelegramBotToken))
        {
            SecretRedactor.RegisterConfiguredSecret(_data.TelegramBotToken);
            var colonIdx = _data.TelegramBotToken.IndexOf(':');
            if (colonIdx > 0 && colonIdx < _data.TelegramBotToken.Length - 1)
            {
                SecretRedactor.RegisterConfiguredSecret(_data.TelegramBotToken.Substring(colonIdx + 1));
            }
        }
    }

    public string GetDiscordWebhookUrl()
    {
        lock (_lock)
        {
            return _data.DiscordWebhookUrl ?? string.Empty;
        }
    }

    public void SetDiscordWebhookUrl(string url)
    {
        lock (_lock)
        {
            _data.DiscordWebhookUrl = url?.Trim() ?? string.Empty;
            Save();
        }
    }

    public string GetTelegramBotToken()
    {
        lock (_lock)
        {
            return _data.TelegramBotToken ?? string.Empty;
        }
    }

    public void SetTelegramBotToken(string token)
    {
        lock (_lock)
        {
            _data.TelegramBotToken = token?.Trim() ?? string.Empty;
            Save();
        }
    }

    public void ClearDiscordWebhookUrl()
    {
        lock (_lock)
        {
            _data.DiscordWebhookUrl = string.Empty;
            Save();
        }
    }

    public void ClearTelegramBotToken()
    {
        lock (_lock)
        {
            _data.TelegramBotToken = string.Empty;
            Save();
        }
    }

    public void ClearAll()
    {
        lock (_lock)
        {
            _data.DiscordWebhookUrl = string.Empty;
            _data.TelegramBotToken = string.Empty;
            Save();
        }
    }

    public IReadOnlyList<string> GetConfiguredSecrets()
    {
        lock (_lock)
        {
            var list = new List<string>();
            if (!string.IsNullOrWhiteSpace(_data.DiscordWebhookUrl)) list.Add(_data.DiscordWebhookUrl);
            if (!string.IsNullOrWhiteSpace(_data.TelegramBotToken)) list.Add(_data.TelegramBotToken);
            return list;
        }
    }

    /// <summary>
    /// Performs an idempotent one-time migration for installations that previously stored
    /// DiscordWebhookUrl or TelegramBotToken in PlaybackCard.xml or Jellyfin.Plugin.PlaybackCard.xml.
    /// Reads and validates legacy values, moves them into the encrypted secret store,
    /// scrubs old XML elements, and saves clean configuration to disk.
    /// </summary>
    public static void MigrateLegacyConfiguration(string? configDirectory, INotificationSecretStore secretStore)
    {
        if (secretStore == null || string.IsNullOrEmpty(configDirectory) || !Directory.Exists(configDirectory))
        {
            return;
        }

        var candidateNames = new[] { "Jellyfin.Plugin.PlaybackCard.xml", "PlaybackCard.xml" };

        foreach (var name in candidateNames)
        {
            var xmlPath = Path.Combine(configDirectory, name);
            if (!File.Exists(xmlPath))
            {
                continue;
            }

            try
            {
                var content = File.ReadAllText(xmlPath);
                if (!content.Contains("DiscordWebhookUrl", StringComparison.OrdinalIgnoreCase) &&
                    !content.Contains("TelegramBotToken", StringComparison.OrdinalIgnoreCase) &&
                    !content.Contains("BazarrApiKey", StringComparison.OrdinalIgnoreCase) &&
                    !content.Contains("RadarrApiKey", StringComparison.OrdinalIgnoreCase) &&
                    !content.Contains("SonarrApiKey", StringComparison.OrdinalIgnoreCase))
                {
                    // No legacy secrets to migrate; already clean
                    continue;
                }

                var doc = XDocument.Parse(content);
                var root = doc.Root;
                if (root == null)
                {
                    continue;
                }

                var modified = false;

                // 1. Migrate Discord Webhook URL
                var discordElem = root.Element("DiscordWebhookUrl");
                if (discordElem != null)
                {
                    var val = discordElem.Value?.Trim();
                    if (!string.IsNullOrWhiteSpace(val) &&
                        string.IsNullOrWhiteSpace(secretStore.GetDiscordWebhookUrl()) &&
                        DiscordWebhookSender.ValidateWebhookUrl(val, out _, out _))
                    {
                        secretStore.SetDiscordWebhookUrl(val);
                    }

                    discordElem.Remove();
                    modified = true;
                }

                // 2. Migrate Telegram Bot Token
                var telegramElem = root.Element("TelegramBotToken");
                if (telegramElem != null)
                {
                    var val = telegramElem.Value?.Trim();
                    if (!string.IsNullOrWhiteSpace(val) &&
                        string.IsNullOrWhiteSpace(secretStore.GetTelegramBotToken()) &&
                        TelegramBotApiSender.ValidateEndpoint(val, "0", out _, out _))
                    {
                        secretStore.SetTelegramBotToken(val);
                    }

                    telegramElem.Remove();
                    modified = true;
                }

                // 3. Scrub legacy mock API keys
                var bazarrElem = root.Element("BazarrApiKey");
                if (bazarrElem != null) { bazarrElem.Remove(); modified = true; }

                var radarrElem = root.Element("RadarrApiKey");
                if (radarrElem != null) { radarrElem.Remove(); modified = true; }

                var sonarrElem = root.Element("SonarrApiKey");
                if (sonarrElem != null) { sonarrElem.Remove(); modified = true; }

                if (modified)
                {
                    var tmpXml = xmlPath + ".tmp." + Guid.NewGuid().ToString("N");
                    doc.Save(tmpXml);
                    SetRestrictedPermissions(tmpXml);
                    File.Move(tmpXml, xmlPath, overwrite: true);
                    SetRestrictedPermissions(xmlPath);
                }
            }
            catch
            {
                // Never leak secrets or crash server on malformed XML
            }
        }
    }

    private sealed class SecretData
    {
        public string DiscordWebhookUrl { get; set; } = string.Empty;
        public string TelegramBotToken { get; set; } = string.Empty;
    }

    internal static class WindowsDpapi
    {
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct DATA_BLOB
        {
            public int cbData;
            public IntPtr pbData;
        }

        [DllImport("Crypt32.dll", SetLastError = true, CharSet = CharSet.Unicode, ExactSpelling = true)]
        [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
        private static extern bool CryptProtectData(
            ref DATA_BLOB pDataIn,
            [MarshalAs(UnmanagedType.LPWStr)] string? szDataDescr,
            ref DATA_BLOB pOptionalEntropy,
            IntPtr pvReserved,
            IntPtr pPromptStruct,
            int dwFlags,
            ref DATA_BLOB pDataOut);

        [DllImport("Crypt32.dll", SetLastError = true, CharSet = CharSet.Unicode, ExactSpelling = true)]
        [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
        private static extern bool CryptUnprotectData(
            ref DATA_BLOB pDataIn,
            IntPtr ppszDataDescr,
            ref DATA_BLOB pOptionalEntropy,
            IntPtr pvReserved,
            IntPtr pPromptStruct,
            int dwFlags,
            ref DATA_BLOB pDataOut);

        [DllImport("Kernel32.dll", SetLastError = true, ExactSpelling = true)]
        [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
        private static extern IntPtr LocalFree(IntPtr hMem);

        public static byte[] Protect(byte[] data)
        {
            if (!OperatingSystem.IsWindows() || data == null || data.Length == 0)
            {
                return data ?? Array.Empty<byte>();
            }

            var inHandle = Marshal.AllocHGlobal(data.Length);
            Marshal.Copy(data, 0, inHandle, data.Length);
            var inBlob = new DATA_BLOB { cbData = data.Length, pbData = inHandle };
            var emptyEntropy = new DATA_BLOB();
            var outBlob = new DATA_BLOB();

            try
            {
                if (CryptProtectData(ref inBlob, "PlaybackCardKey", ref emptyEntropy, IntPtr.Zero, IntPtr.Zero, 1, ref outBlob))
                {
                    var result = new byte[outBlob.cbData];
                    Marshal.Copy(outBlob.pbData, result, 0, outBlob.cbData);
                    return result;
                }
            }
            catch
            {
                // Fallback to raw bytes if native call is unavailable
            }
            finally
            {
                Marshal.FreeHGlobal(inHandle);
                if (outBlob.pbData != IntPtr.Zero)
                {
                    LocalFree(outBlob.pbData);
                }
            }

            return data;
        }

        public static byte[] Unprotect(byte[] data)
        {
            if (!OperatingSystem.IsWindows() || data == null || data.Length == 0)
            {
                return data ?? Array.Empty<byte>();
            }

            if (data.Length == 32)
            {
                return data;
            }

            var inHandle = Marshal.AllocHGlobal(data.Length);
            Marshal.Copy(data, 0, inHandle, data.Length);
            var inBlob = new DATA_BLOB { cbData = data.Length, pbData = inHandle };
            var emptyEntropy = new DATA_BLOB();
            var outBlob = new DATA_BLOB();

            try
            {
                if (CryptUnprotectData(ref inBlob, IntPtr.Zero, ref emptyEntropy, IntPtr.Zero, IntPtr.Zero, 1, ref outBlob))
                {
                    var result = new byte[outBlob.cbData];
                    Marshal.Copy(outBlob.pbData, result, 0, outBlob.cbData);
                    return result;
                }
            }
            catch
            {
                // Fallback to raw bytes
            }
            finally
            {
                Marshal.FreeHGlobal(inHandle);
                if (outBlob.pbData != IntPtr.Zero)
                {
                    LocalFree(outBlob.pbData);
                }
            }

            return data;
        }
    }
}
