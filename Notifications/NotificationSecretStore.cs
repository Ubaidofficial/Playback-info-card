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
        catch
        {
            // Fallback to deterministic machine-local key if filesystem permission error occurs
            return SHA256.HashData(Encoding.UTF8.GetBytes(AppContext.BaseDirectory + "_playback_card_fallback"));
        }
    }

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

                        using var aes = new AesGcm(key, TagSize);
                        aes.Decrypt(nonce, cipherBytes, tag, plainBytes);

                        _data = JsonSerializer.Deserialize<SecretData>(plainBytes) ?? new SecretData();
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
        catch
        {
            // Fail safely without logging secrets or corrupting state
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

    private static void ApplyWindowsRestrictedAcl(string path)
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
            proc?.WaitForExit(2000);
        }
        catch
        {
            // Best effort fallback
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
