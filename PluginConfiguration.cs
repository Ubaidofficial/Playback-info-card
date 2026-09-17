using System.Collections.Generic;
using MediaBrowser.Model.Plugins;

namespace Jellyfin.Plugin.PlaybackCard;

/// <summary>
/// Public configuration options for the Playback Info Card plugin.
/// Strictly excludes sensitive secrets (such as Discord webhook URLs and Telegram bot tokens),
/// ensuring that generic Jellyfin plugin configuration endpoints and XML serializers cannot leak credentials.
/// Sensitive credentials are stored in <see cref="Notifications.NotificationSecretStore"/>.
/// </summary>
public class PluginConfiguration : BasePluginConfiguration
{
    /// <summary>
    /// Initializes a new instance of the <see cref="PluginConfiguration"/> class with safe, opt-in defaults.
    /// </summary>
    public PluginConfiguration()
    {
        // Polling interval in seconds (default: 3s safe interval)
        PollingIntervalSeconds = 3;

        // Whether to display sessions that are idle/not currently playing media
        ShowIdleSessions = false;

        // Default accent color for progress and highlight metrics
        AccentColor = "#00a4dc";

        // Native Notification Engine Defaults (Safe, Disabled until configured and enabled)
        NotificationsEnabled = false;
        DiscordEnabled = false;
        TelegramEnabled = false;
        TelegramChatId = string.Empty;

        // All event types are disabled until explicitly selected
        NotifyOnStart = false;
        NotifyOnStop = false;
        NotifyOnPauseResume = false;
        NotifyOnProgress = false;
        ProgressIntervalMinutes = 15;
        NotifyOnCompletion = false;

        // Privacy defaults: strictly opt-in
        UsernameDisclosure = false;
        ClientDeviceDisclosure = false;

        // User filtering defaults
        UserFilterMode = Notifications.UserFilterMode.AllUsers;
        SelectedUserIds = new List<string>();
    }

    /// <summary>
    /// Gets or sets the client polling interval in seconds.
    /// </summary>
    public int PollingIntervalSeconds { get; set; }

    /// <summary>
    /// Gets or sets a value indicating whether idle sessions should be displayed in the card grid.
    /// </summary>
    public bool ShowIdleSessions { get; set; }

    /// <summary>
    /// Gets or sets the neon accent color hex string used for progress bars and badges.
    /// </summary>
    public string AccentColor { get; set; }

    // ==========================================
    // Native Notification Engine Properties
    // (Non-sensitive settings only)
    // ==========================================

    /// <summary>
    /// Master switch for all outbound playback notifications.
    /// </summary>
    public bool NotificationsEnabled { get; set; }

    /// <summary>
    /// Gets or sets whether Discord notifications are enabled.
    /// </summary>
    public bool DiscordEnabled { get; set; }

    /// <summary>
    /// Gets or sets whether Telegram notifications are enabled.
    /// </summary>
    public bool TelegramEnabled { get; set; }

    /// <summary>
    /// Target Telegram chat or channel ID.
    /// </summary>
    public string TelegramChatId { get; set; }

    /// <summary>
    /// Gets or sets whether to send a notification when playback starts.
    /// </summary>
    public bool NotifyOnStart { get; set; }

    /// <summary>
    /// Gets or sets whether to send a notification when playback stops.
    /// </summary>
    public bool NotifyOnStop { get; set; }

    /// <summary>
    /// Gets or sets whether to send notifications on pause/resume transitions.
    /// </summary>
    public bool NotifyOnPauseResume { get; set; }

    /// <summary>
    /// Gets or sets whether to send periodic progress notifications.
    /// </summary>
    public bool NotifyOnProgress { get; set; }

    /// <summary>
    /// Interval in minutes between periodic progress notifications (minimum 5).
    /// </summary>
    public int ProgressIntervalMinutes { get; set; }

    /// <summary>
    /// Gets or sets whether to send a notification when media is played to completion.
    /// </summary>
    public bool NotifyOnCompletion { get; set; }

    /// <summary>
    /// Gets or sets whether the Jellyfin user account name is disclosed in notifications.
    /// </summary>
    public bool UsernameDisclosure { get; set; }

    /// <summary>
    /// Gets or sets whether client app name, version, and device name are disclosed in notifications.
    /// </summary>
    public bool ClientDeviceDisclosure { get; set; }

    /// <summary>
    /// User filtering mode (AllUsers, Whitelist, Blacklist).
    /// </summary>
    public Notifications.UserFilterMode UserFilterMode { get; set; }

    /// <summary>
    /// List of user IDs or usernames subject to whitelist/blacklist filtering.
    /// </summary>
    public List<string> SelectedUserIds { get; set; }
}
