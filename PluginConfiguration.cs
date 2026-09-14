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
}
