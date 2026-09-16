using System;
using System.Collections.Generic;
using System.Globalization;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Common.Plugins;
using MediaBrowser.Model.Plugins;
using MediaBrowser.Model.Serialization;

namespace Jellyfin.Plugin.PlaybackCard;

/// <summary>
/// Core entry point for the Playback Info Card plugin.
/// Implements <see cref="BasePlugin{TConfiguration}"/> and <see cref="IHasWebPages"/> to serve embedded client scripts.
/// </summary>
public class Plugin : BasePlugin<PluginConfiguration>, IHasWebPages
{
    /// <summary>
    /// Initializes a new instance of the <see cref="Plugin"/> class.
    /// </summary>
    /// <param name="applicationPaths">Instance of the <see cref="IApplicationPaths"/> interface.</param>
    /// <param name="xmlSerializer">Instance of the <see cref="IXmlSerializer"/> interface.</param>
    public Plugin(IApplicationPaths applicationPaths, IXmlSerializer xmlSerializer)
        : base(applicationPaths, xmlSerializer)
    {
        Instance = this;
        TryDiskInjection(applicationPaths);
    }

    private static void TryDiskInjection(IApplicationPaths applicationPaths)
    {
        try
        {
            var webPath = (applicationPaths as MediaBrowser.Controller.Configuration.IServerApplicationPaths)?.WebPath;
            var candidates = new List<string>();
            if (!string.IsNullOrEmpty(webPath))
            {
                candidates.Add(System.IO.Path.Combine(webPath, "index.html"));
            }

            candidates.Add(System.IO.Path.Combine(AppContext.BaseDirectory, "jellyfin-web", "index.html"));
            candidates.Add(System.IO.Path.Combine(AppContext.BaseDirectory, "web", "index.html"));
            candidates.Add("/usr/share/jellyfin/web/index.html");
            candidates.Add("/jellyfin/jellyfin-web/index.html");

            foreach (var candidate in candidates)
            {
                if (System.IO.File.Exists(candidate))
                {
                    var content = System.IO.File.ReadAllText(candidate);
                    if (!content.Contains("playbackcard.js", StringComparison.OrdinalIgnoreCase) &&
                        content.Contains("</body>", StringComparison.OrdinalIgnoreCase))
                    {
                        var updated = content.Replace("</body>", "<script plugin=\"PlaybackCard\" version=\"0.2.3.0\" src=\"/web/configurationpage?name=playbackcard.js\" defer></script>\n</body>", StringComparison.OrdinalIgnoreCase);
                        System.IO.File.WriteAllText(candidate, updated);
                    }
                    break;
                }
            }
        }
        catch
        {
            // Silently ignore disk write permission errors; in-memory middleware handles injection seamlessly
        }
    }

    /// <summary>
    /// Gets the current plugin instance.
    /// </summary>
    public static Plugin? Instance { get; private set; }

    /// <summary>
    /// Gets the plugin name.
    /// </summary>
    public override string Name => "Playback Info Card";

    /// <summary>
    /// Gets the unique plugin identifier.
    /// </summary>
    public override Guid Id => Guid.Parse("b7e6f831-2794-4d82-8419-7c48ef2e2a39");

    /// <summary>
    /// Gets the plugin description.
    /// </summary>
    public override string Description =>
        "Real-time, cinema-grade visual stream telemetry and playback monitoring grid injected directly into the Jellyfin Admin Dashboard.";

    /// <summary>
    /// Serves embedded web assets to the Jellyfin Web client interface.
    /// </summary>
    /// <returns>A collection of <see cref="PluginPageInfo"/> objects representing client resources.</returns>
    public IEnumerable<PluginPageInfo> GetPages()
    {
        return new[]
        {
            new PluginPageInfo
            {
                Name = "playbackcard.js",
                EmbeddedResourcePath = string.Format(
                    CultureInfo.InvariantCulture,
                    "{0}.Web.playbackcard.js",
                    GetType().Namespace)
            },
            new PluginPageInfo
            {
                Name = "playbackcard.css",
                EmbeddedResourcePath = string.Format(
                    CultureInfo.InvariantCulture,
                    "{0}.Web.playbackcard.css",
                    GetType().Namespace)
            },
            new PluginPageInfo
            {
                Name = "playbackcard",
                EmbeddedResourcePath = string.Format(
                    CultureInfo.InvariantCulture,
                    "{0}.Web.configPage.html",
                    GetType().Namespace)
            }
        };
    }
}
