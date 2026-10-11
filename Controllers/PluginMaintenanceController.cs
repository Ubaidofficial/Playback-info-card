using System;
using System.Collections.Generic;
using System.Linq;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;

namespace Jellyfin.Plugin.PlaybackCard.Controllers;

/// <summary>
/// Administrator-only API for detecting and safely cleaning up superseded plugin version
/// folders left behind in Jellyfin's plugins directory.
/// </summary>
[ApiController]
[Route("PlaybackCard/Maintenance")]
[Route("PlaybackInfoCard/Maintenance")]
[Authorize(Policy = "RequiresElevation")]
public class PluginMaintenanceController : ControllerBase
{
    private bool IsAdministrator() => ControllerAuthHelper.IsAdministrator(User);

    /// <summary>
    /// Reports whether any older, superseded version folders of this plugin are currently sitting
    /// on disk next to the build that's actually running.
    /// </summary>
    [HttpGet("VersionHealth")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status403Forbidden)]
    public ActionResult<PluginVersionHealthDto> GetVersionHealth()
    {
        if (!IsAdministrator())
        {
            return Forbid();
        }

        var plugin = Plugin.Instance;
        if (plugin == null)
        {
            return StatusCode(StatusCodes.Status500InternalServerError, new { error = "PluginNotLoaded" });
        }

        var siblings = plugin.DetectStaleVersionFolders();
        var older = siblings.Where(s => s.IsOlderThanRunning).Select(s => s.FolderName).ToList();

        return Ok(new PluginVersionHealthDto
        {
            HasOlderSiblingVersions = older.Count > 0,
            OlderVersionFolders = older
        });
    }

    /// <summary>
    /// Removes exactly one stale, older version folder. Every safety check lives in
    /// <see cref="Plugin.TryRemoveStaleVersionFolder"/> and fails closed on any ambiguity -- this
    /// endpoint only ever forwards the administrator's explicit, one-folder-at-a-time request.
    /// </summary>
    [HttpPost("RemoveStaleVersion")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    [ProducesResponseType(StatusCodes.Status403Forbidden)]
    public ActionResult RemoveStaleVersion([FromBody] RemoveStaleVersionRequest request)
    {
        if (!IsAdministrator())
        {
            return Forbid();
        }

        if (request == null || string.IsNullOrWhiteSpace(request.FolderName))
        {
            return BadRequest(new { error = "InvalidRequest", message = "folderName is required." });
        }

        var plugin = Plugin.Instance;
        if (plugin == null)
        {
            return StatusCode(StatusCodes.Status500InternalServerError, new { error = "PluginNotLoaded" });
        }

        if (!plugin.TryRemoveStaleVersionFolder(request.FolderName, out var errorMessage))
        {
            return BadRequest(new { error = "RemovalRefused", message = errorMessage ?? "Removal was refused." });
        }

        return Ok(new { removed = request.FolderName });
    }
}

/// <summary>
/// Reports whether any superseded version folders of this plugin were found on disk.
/// </summary>
public sealed class PluginVersionHealthDto
{
    public bool HasOlderSiblingVersions { get; init; }

    public IReadOnlyList<string> OlderVersionFolders { get; init; } = Array.Empty<string>();
}

/// <summary>
/// Request payload identifying exactly one stale version folder to remove.
/// </summary>
public sealed class RemoveStaleVersionRequest
{
    public string FolderName { get; set; } = string.Empty;
}
