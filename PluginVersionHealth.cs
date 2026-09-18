using System;

namespace Jellyfin.Plugin.PlaybackCard;

/// <summary>
/// Describes one sibling version-suffixed folder found next to the currently running plugin
/// build inside Jellyfin's plugins directory (e.g. "PlayInfo_0.2.7.1" sitting next to the
/// "PlayInfo_0.2.7.4" folder that is actually loaded).
/// </summary>
/// <param name="FolderName">The sibling folder's name, e.g. "PlayInfo_0.2.7.1".</param>
/// <param name="FolderPath">The sibling folder's full path on disk.</param>
/// <param name="ParsedVersion">The version parsed from the folder name suffix, if it parsed cleanly.</param>
/// <param name="IsOlderThanRunning">
/// True only when both the sibling's and the running build's versions parsed cleanly AND the
/// sibling's version is strictly lower. False (never assumed true) on any ambiguity.
/// </param>
public sealed record InstalledPluginVersionInfo(
    string FolderName,
    string FolderPath,
    Version? ParsedVersion,
    bool IsOlderThanRunning);
