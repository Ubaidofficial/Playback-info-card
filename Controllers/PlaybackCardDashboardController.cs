using System;
using System.IO;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;

namespace Jellyfin.Plugin.PlaybackCard.Controllers;

/// <summary>
/// Controller that serves dashboard assets for the Playback Info Card plugin.
/// </summary>
[ApiController]
[Route("PlaybackCard")]
[Route("PlaybackInfoCard")]
public class PlaybackCardDashboardController : ControllerBase
{
    /// <summary>
    /// Serves the client-side dashboard integration script.
    /// </summary>
    [HttpGet("dashboard.js")]
    [AllowAnonymous]
    [Produces("application/javascript")]
    public IActionResult GetDashboardScript()
    {
        var assembly = typeof(PlaybackCardDashboardController).Assembly;
        var stream = assembly.GetManifestResourceStream("Jellyfin.Plugin.PlaybackCard.Web.dashboard.js");
        if (stream == null)
        {
            return NotFound();
        }

        Response.Headers.CacheControl = "no-cache, no-store, must-revalidate";
        Response.Headers.Pragma = "no-cache";
        return File(stream, "application/javascript; charset=utf-8");
    }

    /// <summary>
    /// Serves the client-side dashboard styles.
    /// </summary>
    [HttpGet("dashboard.css")]
    [AllowAnonymous]
    [Produces("text/css")]
    public IActionResult GetDashboardStyles()
    {
        var assembly = typeof(PlaybackCardDashboardController).Assembly;
        var stream = assembly.GetManifestResourceStream("Jellyfin.Plugin.PlaybackCard.Web.dashboard.css");
        if (stream == null)
        {
            return NotFound();
        }

        Response.Headers.CacheControl = "no-cache, no-store, must-revalidate";
        Response.Headers.Pragma = "no-cache";
        return File(stream, "text/css; charset=utf-8");
    }
}
