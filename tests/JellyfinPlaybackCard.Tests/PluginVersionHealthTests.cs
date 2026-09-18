using System;
using System.IO;
using Jellyfin.Plugin.PlaybackCard;
using Xunit;

namespace JellyfinPlaybackCard.Tests;

/// <summary>
/// Covers the version-folder detection/removal logic that guards against Jellyfin silently
/// loading a stale, superseded build when multiple "PlayInfo_&lt;version&gt;" folders end up
/// sitting side by side on disk (see jellyfin/jellyfin#12959). Every removal path is expected to
/// fail closed on any ambiguity rather than guess.
/// </summary>
public class PluginVersionHealthTests : IDisposable
{
    private const string PluginName = "PlayInfo";
    private readonly string _pluginsRoot;

    public PluginVersionHealthTests()
    {
        _pluginsRoot = Path.Combine(Path.GetTempPath(), $"playinfo_plugins_test_{Guid.NewGuid():N}");
        Directory.CreateDirectory(_pluginsRoot);
    }

    public void Dispose()
    {
        try
        {
            if (Directory.Exists(_pluginsRoot))
            {
                Directory.Delete(_pluginsRoot, recursive: true);
            }
        }
        catch
        {
            // Best-effort cleanup only.
        }
    }

    private string MakeFolder(string name)
    {
        var path = Path.Combine(_pluginsRoot, name);
        Directory.CreateDirectory(path);
        return path;
    }

    [Theory]
    [InlineData("PlayInfo_0.2.7.3", "PlayInfo", "0.2.7.3")]
    [InlineData("PlayInfo_1.0.0.0", "PlayInfo", "1.0.0.0")]
    public void ParseVersionFromFolderName_ValidShape_Parses(string folderName, string pluginName, string expected)
    {
        var version = Plugin.ParseVersionFromFolderName(folderName, pluginName);

        Assert.NotNull(version);
        Assert.Equal(Version.Parse(expected), version);
    }

    [Theory]
    [InlineData(null, "PlayInfo")]
    [InlineData("", "PlayInfo")]
    [InlineData("PlayInfo_0.2.7.3", "")]
    [InlineData("SomeOtherPlugin_0.2.7.3", "PlayInfo")]
    [InlineData("PlayInfo_not-a-version", "PlayInfo")]
    [InlineData("PlayInfo", "PlayInfo")]
    public void ParseVersionFromFolderName_InvalidShape_ReturnsNull(string? folderName, string pluginName)
    {
        Assert.Null(Plugin.ParseVersionFromFolderName(folderName, pluginName));
    }

    [Fact]
    public void DetectStaleVersionFolders_NoSiblings_ReturnsEmpty()
    {
        MakeFolder("PlayInfo_0.2.7.3");

        var result = Plugin.DetectStaleVersionFolders(_pluginsRoot, "PlayInfo_0.2.7.3", PluginName);

        Assert.Empty(result);
    }

    [Fact]
    public void DetectStaleVersionFolders_OlderSibling_FlaggedAsOlder()
    {
        MakeFolder("PlayInfo_0.2.7.3");
        MakeFolder("PlayInfo_0.2.7.1");

        var result = Plugin.DetectStaleVersionFolders(_pluginsRoot, "PlayInfo_0.2.7.3", PluginName);

        var older = Assert.Single(result);
        Assert.Equal("PlayInfo_0.2.7.1", older.FolderName);
        Assert.True(older.IsOlderThanRunning);
        Assert.Equal(Version.Parse("0.2.7.1"), older.ParsedVersion);
    }

    [Fact]
    public void DetectStaleVersionFolders_NewerSibling_NotFlaggedAsOlder()
    {
        MakeFolder("PlayInfo_0.2.7.1");
        MakeFolder("PlayInfo_0.2.7.3");

        // Simulate the case where Jellyfin loaded the OLDER build (the real bug this guards
        // against): from the older build's own point of view, the newer sibling must never be
        // flagged as something safe to remove.
        var result = Plugin.DetectStaleVersionFolders(_pluginsRoot, "PlayInfo_0.2.7.1", PluginName);

        var newer = Assert.Single(result);
        Assert.Equal("PlayInfo_0.2.7.3", newer.FolderName);
        Assert.False(newer.IsOlderThanRunning);
    }

    [Fact]
    public void DetectStaleVersionFolders_IgnoresUnrelatedAndCurrentFolders()
    {
        MakeFolder("PlayInfo_0.2.7.3");
        MakeFolder("SomeOtherPlugin_9.9.9.9");
        MakeFolder("Moonbase_2.2.0.0");

        var result = Plugin.DetectStaleVersionFolders(_pluginsRoot, "PlayInfo_0.2.7.3", PluginName);

        Assert.Empty(result);
    }

    [Fact]
    public void DetectStaleVersionFolders_UnparsableSiblingVersion_NeverFlaggedOlder()
    {
        MakeFolder("PlayInfo_0.2.7.3");
        MakeFolder("PlayInfo_garbage");

        var result = Plugin.DetectStaleVersionFolders(_pluginsRoot, "PlayInfo_0.2.7.3", PluginName);

        var entry = Assert.Single(result);
        Assert.Null(entry.ParsedVersion);
        Assert.False(entry.IsOlderThanRunning);
    }

    [Fact]
    public void TryRemoveStaleVersionFolderCore_OlderSibling_RemovesFromDisk()
    {
        MakeFolder("PlayInfo_0.2.7.3");
        var oldPath = MakeFolder("PlayInfo_0.2.7.1");

        var removed = Plugin.TryRemoveStaleVersionFolderCore(
            _pluginsRoot, "PlayInfo_0.2.7.3", PluginName, "PlayInfo_0.2.7.1", out var error);

        Assert.True(removed);
        Assert.Null(error);
        Assert.False(Directory.Exists(oldPath));
    }

    [Fact]
    public void TryRemoveStaleVersionFolderCore_RefusesToRemoveRunningVersion()
    {
        var currentPath = MakeFolder("PlayInfo_0.2.7.3");

        var removed = Plugin.TryRemoveStaleVersionFolderCore(
            _pluginsRoot, "PlayInfo_0.2.7.3", PluginName, "PlayInfo_0.2.7.3", out var error);

        Assert.False(removed);
        Assert.NotNull(error);
        Assert.True(Directory.Exists(currentPath));
    }

    [Fact]
    public void TryRemoveStaleVersionFolderCore_RefusesNewerVersion()
    {
        MakeFolder("PlayInfo_0.2.7.1");
        var newerPath = MakeFolder("PlayInfo_0.2.7.3");

        // From the (buggy) older build's perspective, it must never be able to remove a newer
        // sibling -- this is the exact scenario that must stay a human, confirmed decision.
        var removed = Plugin.TryRemoveStaleVersionFolderCore(
            _pluginsRoot, "PlayInfo_0.2.7.1", PluginName, "PlayInfo_0.2.7.3", out var error);

        Assert.False(removed);
        Assert.NotNull(error);
        Assert.True(Directory.Exists(newerPath));
    }

    [Fact]
    public void TryRemoveStaleVersionFolderCore_RefusesFolderNotBelongingToPlugin()
    {
        var otherPath = MakeFolder("SomeOtherPlugin_0.0.0.1");
        MakeFolder("PlayInfo_0.2.7.3");

        var removed = Plugin.TryRemoveStaleVersionFolderCore(
            _pluginsRoot, "PlayInfo_0.2.7.3", PluginName, "SomeOtherPlugin_0.0.0.1", out var error);

        Assert.False(removed);
        Assert.NotNull(error);
        Assert.True(Directory.Exists(otherPath));
    }

    [Fact]
    public void TryRemoveStaleVersionFolderCore_RefusesUnparsableTargetVersion()
    {
        var garbagePath = MakeFolder("PlayInfo_garbage");
        MakeFolder("PlayInfo_0.2.7.3");

        var removed = Plugin.TryRemoveStaleVersionFolderCore(
            _pluginsRoot, "PlayInfo_0.2.7.3", PluginName, "PlayInfo_garbage", out var error);

        Assert.False(removed);
        Assert.NotNull(error);
        Assert.True(Directory.Exists(garbagePath));
    }

    [Fact]
    public void TryRemoveStaleVersionFolderCore_RefusesPathTraversalAttempt()
    {
        MakeFolder("PlayInfo_0.2.7.3");

        var removed = Plugin.TryRemoveStaleVersionFolderCore(
            _pluginsRoot, "PlayInfo_0.2.7.3", PluginName, "../PlayInfo_0.2.7.1", out var error);

        Assert.False(removed);
        Assert.Equal("Invalid folder name.", error);
    }

    [Fact]
    public void TryRemoveStaleVersionFolderCore_RefusesNonExistentTarget()
    {
        MakeFolder("PlayInfo_0.2.7.3");

        var removed = Plugin.TryRemoveStaleVersionFolderCore(
            _pluginsRoot, "PlayInfo_0.2.7.3", PluginName, "PlayInfo_0.2.7.1", out var error);

        Assert.False(removed);
        Assert.NotNull(error);
    }
}
