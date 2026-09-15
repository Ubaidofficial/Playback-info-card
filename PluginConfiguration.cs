using MediaBrowser.Model.Plugins;

namespace Jellyfin.Plugin.PlaybackCard;

/// <summary>
/// Configuration options for the Playback Info Card plugin.
/// </summary>
public class PluginConfiguration : BasePluginConfiguration
{
    /// <summary>
    /// Initializes a new instance of the <see cref="PluginConfiguration"/> class.
    /// </summary>
    public PluginConfiguration()
    {
        // Polling interval in seconds (default: 3s safe interval)
        PollingIntervalSeconds = 3;

        // Whether to display sessions that are idle/not currently playing media
        ShowIdleSessions = false;

        // Default accent color for progress and highlight metrics
        AccentColor = "#00a4dc";

        // Stream Guard Policies
        KillPausedEnabled = false;
        KillPausedMinutes = 15;
        Kill4kSwEnabled = false;
        MaxConcurrentStreams = 0;
        ExemptAdmins = true;

        // Servarr Remediation Integrations
        BazarrUrl = string.Empty;
        BazarrApiKey = string.Empty;
        RadarrUrl = string.Empty;
        RadarrApiKey = string.Empty;
        SonarrUrl = string.Empty;
        SonarrApiKey = string.Empty;
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

    /// <summary>
    /// Gets or sets a value indicating whether to auto-terminate playback sessions paused longer than the timeout.
    /// </summary>
    public bool KillPausedEnabled { get; set; }

    /// <summary>
    /// Gets or sets the paused timeout threshold in minutes.
    /// </summary>
    public int KillPausedMinutes { get; set; }

    /// <summary>
    /// Gets or sets a value indicating whether to block and auto-kill unaccelerated 4K software CPU transcodes.
    /// </summary>
    public bool Kill4kSwEnabled { get; set; }

    /// <summary>
    /// Gets or sets the maximum concurrent streams allowed per user account (0 = unlimited).
    /// </summary>
    public int MaxConcurrentStreams { get; set; }

    /// <summary>
    /// Gets or sets a value indicating whether administrator sessions are exempt from auto-kill policies.
    /// </summary>
    public bool ExemptAdmins { get; set; }

    /// <summary>
    /// Gets or sets the Bazarr remediation service URL.
    /// </summary>
    public string BazarrUrl { get; set; }

    /// <summary>
    /// Gets or sets the Bazarr API authentication key.
    /// </summary>
    public string BazarrApiKey { get; set; }

    /// <summary>
    /// Gets or sets the Radarr remediation service URL.
    /// </summary>
    public string RadarrUrl { get; set; }

    /// <summary>
    /// Gets or sets the Radarr API authentication key.
    /// </summary>
    public string RadarrApiKey { get; set; }

    /// <summary>
    /// Gets or sets the Sonarr remediation service URL.
    /// </summary>
    public string SonarrUrl { get; set; }

    /// <summary>
    /// Gets or sets the Sonarr API authentication key.
    /// </summary>
    public string SonarrApiKey { get; set; }
}
