using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
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
        WarnIfOlderVersionFoldersPresent();
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

    /// <summary>
    /// Detects sibling version-suffixed folders (e.g. "PlayInfo_0.2.7.1") left behind next to the
    /// currently running build inside Jellyfin's plugins directory. Jellyfin's own plugin loader is
    /// supposed to keep only the newest version on disk, but this has historically not always
    /// happened reliably (see jellyfin/jellyfin#12959), and when it doesn't, Jellyfin can end up
    /// running an old build indefinitely with no visible error -- bug fixes in later releases
    /// silently never take effect. This is read-only: it never touches the filesystem.
    /// </summary>
    /// <returns>Every sibling folder found that matches this plugin's naming pattern, oldest-relevant flagged.</returns>
    public IReadOnlyList<InstalledPluginVersionInfo> DetectStaleVersionFolders()
    {
        try
        {
            if (!TryResolveRunningLocation(out var pluginsRoot, out var currentFolderName))
            {
                return Array.Empty<InstalledPluginVersionInfo>();
            }

            return DetectStaleVersionFolders(pluginsRoot!, currentFolderName!, Name);
        }
        catch (Exception ex)
        {
            // Diagnostics must never be able to take the plugin down.
            Trace.TraceWarning("[PlayInfo] Failed to check for duplicate plugin version folders: " + ex.Message);
            return Array.Empty<InstalledPluginVersionInfo>();
        }
    }

    /// <summary>
    /// Attempts to remove one sibling version folder. Fails closed on any ambiguity: it only ever
    /// deletes a folder whose name matches this plugin's exact naming pattern, whose parsed version
    /// is strictly lower than the currently running build's, and whose resolved path sits directly
    /// inside the plugins directory (never traverses via a crafted folder name). It will never
    /// remove the folder the running code is actually executing from.
    /// </summary>
    /// <param name="folderName">The exact sibling folder name to remove, e.g. "PlayInfo_0.2.7.1".</param>
    /// <param name="errorMessage">A human-readable reason when removal is refused or fails.</param>
    /// <returns>True if the folder was removed.</returns>
    public bool TryRemoveStaleVersionFolder(string folderName, out string? errorMessage)
    {
        if (!TryResolveRunningLocation(out var pluginsRoot, out var currentFolderName))
        {
            errorMessage = "Could not resolve the running plugin's location on disk.";
            return false;
        }

        return TryRemoveStaleVersionFolderCore(pluginsRoot!, currentFolderName!, Name, folderName, out errorMessage);
    }

    private void WarnIfOlderVersionFoldersPresent()
    {
        try
        {
            var stale = DetectStaleVersionFolders().Where(s => s.IsOlderThanRunning).ToList();
            if (stale.Count == 0)
            {
                return;
            }

            Trace.TraceWarning(
                "[PlayInfo] " + stale.Count + " older version folder(s) detected alongside the running build: " +
                string.Join(", ", stale.Select(s => s.FolderName)) +
                ". If Jellyfin ever loads one of these instead of the current version, fixes from later " +
                "releases will silently not apply. Remove the older folder(s) from the plugins directory " +
                "(or use the 'Remove stale version' action in this plugin's own dashboard) and restart.");
        }
        catch (Exception ex)
        {
            Trace.TraceWarning("[PlayInfo] Startup version-folder check failed: " + ex.Message);
        }
    }

    /// <summary>
    /// Resolves the plugins root directory and the currently-running build's folder name straight
    /// from the loaded assembly's own location on disk -- ground truth for "what is actually
    /// executing", independent of whatever plugin.json or the dashboard UI might report.
    /// </summary>
    private static bool TryResolveRunningLocation(out string? pluginsRoot, out string? currentFolderName)
    {
        pluginsRoot = null;
        currentFolderName = null;

        var currentAssemblyPath = typeof(Plugin).Assembly.Location;
        if (string.IsNullOrEmpty(currentAssemblyPath))
        {
            return false;
        }

        var currentFolder = Path.GetDirectoryName(currentAssemblyPath);
        if (string.IsNullOrEmpty(currentFolder))
        {
            return false;
        }

        var root = Path.GetDirectoryName(currentFolder);
        if (string.IsNullOrEmpty(root) || !Directory.Exists(root))
        {
            return false;
        }

        pluginsRoot = root;
        currentFolderName = Path.GetFileName(currentFolder);
        return !string.IsNullOrEmpty(currentFolderName);
    }

    /// <summary>
    /// Pure, directory-injectable core of <see cref="DetectStaleVersionFolders()"/> so it can be
    /// exercised against a real temp directory in tests without needing a live Jellyfin host.
    /// </summary>
    internal static IReadOnlyList<InstalledPluginVersionInfo> DetectStaleVersionFolders(
        string pluginsRoot,
        string currentFolderName,
        string pluginName)
    {
        var results = new List<InstalledPluginVersionInfo>();
        if (string.IsNullOrEmpty(pluginsRoot) || !Directory.Exists(pluginsRoot))
        {
            return results;
        }

        var currentVersion = ParseVersionFromFolderName(currentFolderName, pluginName);
        var prefix = pluginName + "_";

        foreach (var dir in Directory.EnumerateDirectories(pluginsRoot))
        {
            var name = Path.GetFileName(dir);
            if (string.IsNullOrEmpty(name) ||
                string.Equals(name, currentFolderName, StringComparison.OrdinalIgnoreCase) ||
                !name.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }

            var parsed = ParseVersionFromFolderName(name, pluginName);
            var isOlder = currentVersion != null && parsed != null && parsed < currentVersion;
            results.Add(new InstalledPluginVersionInfo(name, dir, parsed, isOlder));
        }

        return results;
    }

    /// <summary>
    /// Pure, directory-injectable core of <see cref="TryRemoveStaleVersionFolder"/>. Every check here
    /// fails closed: any parse failure or ambiguity refuses the removal rather than guessing.
    /// </summary>
    internal static bool TryRemoveStaleVersionFolderCore(
        string pluginsRoot,
        string currentFolderName,
        string pluginName,
        string? requestedFolderName,
        out string? errorMessage)
    {
        errorMessage = null;

        if (string.IsNullOrEmpty(pluginsRoot) || !Directory.Exists(pluginsRoot))
        {
            errorMessage = "Could not resolve the plugins directory.";
            return false;
        }

        // Strip any directory component the caller might have smuggled in (e.g. "..\..\x" or an
        // absolute path) -- only a bare folder name is ever accepted.
        var safeName = Path.GetFileName((requestedFolderName ?? string.Empty).Trim());
        if (string.IsNullOrEmpty(safeName) || !string.Equals(safeName, (requestedFolderName ?? string.Empty).Trim(), StringComparison.Ordinal))
        {
            errorMessage = "Invalid folder name.";
            return false;
        }

        if (string.Equals(safeName, currentFolderName, StringComparison.OrdinalIgnoreCase))
        {
            errorMessage = "Refusing to remove the currently running version.";
            return false;
        }

        var prefix = pluginName + "_";
        if (!safeName.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
        {
            errorMessage = "That folder does not belong to this plugin.";
            return false;
        }

        var currentVersion = ParseVersionFromFolderName(currentFolderName, pluginName);
        var targetVersion = ParseVersionFromFolderName(safeName, pluginName);
        if (currentVersion == null || targetVersion == null || targetVersion >= currentVersion)
        {
            // Fail closed: never remove unless we can positively confirm it's strictly older.
            errorMessage = "Refusing to remove: could not confirm this folder is an older version than the one currently running.";
            return false;
        }

        // CA3003 (path injection) flags targetPath as tainted by the caller-supplied folder name.
        // It is safe here: safeName was already forced through Path.GetFileName and rejected outright
        // if that stripped anything (blocking "..", separators, or an absolute path), it was confirmed
        // to start with this plugin's own "<Name>_" prefix, and the check immediately below re-verifies
        // the combined path's parent still resolves to exactly pluginsRoot before anything touches it.
#pragma warning disable CA3003
        var targetPath = Path.Combine(pluginsRoot, safeName);
        if (!string.Equals(Path.GetDirectoryName(targetPath), pluginsRoot.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar), StringComparison.OrdinalIgnoreCase)
            || !Directory.Exists(targetPath))
        {
            errorMessage = "Target folder not found.";
            return false;
        }

        try
        {
            Directory.Delete(targetPath, recursive: true);
            Trace.TraceInformation("[PlayInfo] Removed stale plugin version folder: " + safeName);
            return true;
        }
        catch (Exception ex)
        {
            errorMessage = "Failed to remove folder: " + ex.GetType().Name;
            Trace.TraceWarning("[PlayInfo] Failed to remove stale version folder '" + safeName + "': " + ex.Message);
            return false;
        }
#pragma warning restore CA3003
    }

    /// <summary>
    /// Parses the version suffix from a "&lt;PluginName&gt;_&lt;Version&gt;" folder name, e.g.
    /// "PlayInfo_0.2.7.1" with pluginName "PlayInfo" yields 0.2.7.1. Returns null (never throws) on
    /// anything that doesn't cleanly match that shape.
    /// </summary>
    internal static Version? ParseVersionFromFolderName(string? folderName, string pluginName)
    {
        if (string.IsNullOrEmpty(folderName) || string.IsNullOrEmpty(pluginName))
        {
            return null;
        }

        var prefix = pluginName + "_";
        if (!folderName.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
        {
            return null;
        }

        var versionPart = folderName.Substring(prefix.Length);
        return Version.TryParse(versionPart, out var v) ? v : null;
    }
}
