using System;
using System.Collections.Generic;
using System.Globalization;
using System.Runtime.CompilerServices;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Common.Plugins;
using MediaBrowser.Model.Plugins;
using MediaBrowser.Model.Serialization;

[assembly: InternalsVisibleTo("JellyfinPlaybackCard.Tests")]

namespace Jellyfin.Plugin.PlaybackCard;

/// <summary>
/// Core entry point for the Playback Info Card plugin.
/// Implements <see cref="BasePlugin{TConfiguration}"/> and <see cref="IHasWebPages"/> to serve
/// a single Playback Monitor page: admins see every active session, and non-admin users
/// see only their own.
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
    }

    /// <summary>
    /// Gets the current plugin instance.
    /// </summary>
    public static Plugin? Instance { get; private set; }

    /// <summary>
    /// Gets the plugin name.
    /// </summary>
    public override string Name => "PlayInfo";

    /// <summary>
    /// Gets the unique plugin identifier.
    /// </summary>
    public override Guid Id => Guid.Parse("b7e6f831-2794-4d82-8419-7c48ef2e2a39");

    /// <summary>
    /// Gets the plugin description.
    /// </summary>
    public override string Description =>
        "Admin playback session monitor and user playback telemetry dashboard displaying active streams and transcode metrics.";

    /// <summary>
    /// Serves embedded, plugin-owned pages to the Jellyfin Web client interface.
    /// </summary>
    /// <returns>A collection of <see cref="PluginPageInfo"/> objects representing client resources.</returns>
    public IEnumerable<PluginPageInfo> GetPages()
    {
        return new[]
        {
            // Single sidebar entry for every user. The page itself decides what to show:
            // admins see every active session (the old "Playback Monitor" behavior), and
            // non-admins see only their own (the old "My Playback" behavior) -- so one menu
            // item now covers both roles instead of registering the same page twice.
            new PluginPageInfo
            {
                Name = "playbackcard",
                DisplayName = "PlayInfo",
                EmbeddedResourcePath = string.Format(
                    CultureInfo.InvariantCulture,
                    "{0}.Web.playbackcard.html",
                    GetType().Namespace),
                EnableInMainMenu = true,
                MenuSection = "playback",
                MenuIcon = "play_circle"
            }
        };
    }
}
