using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.PlaybackCard.Notifications;
using MediaBrowser.Controller.Session;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;

namespace Jellyfin.Plugin.PlaybackCard.Controllers;

/// <summary>
/// Administrator-only endpoint that maps live session IDs to a safe Local Network/Remote
/// (optionally with approximate city/country) label. Never returns a raw IP address.
/// Returns an empty map whenever <see cref="PluginConfiguration.NetworkLocationDisclosure"/>
/// is off (the default) -- callers should not even poll this endpoint while the setting is
/// disabled, but this is the actual enforcement point regardless of what the client does.
/// </summary>
[ApiController]
[Route("PlaybackCard/NetworkLocation")]
[Route("PlaybackInfoCard/NetworkLocation")]
[Authorize(Policy = "RequiresElevation")]
public class NetworkLocationController : ControllerBase
{
    private readonly ISessionManager _sessionManager;
    private readonly INetworkLocationService _locationService;

    public NetworkLocationController(ISessionManager sessionManager, INetworkLocationService locationService)
    {
        _sessionManager = sessionManager;
        _locationService = locationService;
    }

    private bool IsAdministrator()
    {
        if (User.IsInRole("Administrator") ||
            User.HasClaim("IsAdministrator", "true") ||
            User.HasClaim(c => c.Type.Equals("IsAdministrator", StringComparison.OrdinalIgnoreCase) && c.Value.Equals("true", StringComparison.OrdinalIgnoreCase)))
        {
            return true;
        }

        return false;
    }

    [HttpGet]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status403Forbidden)]
    public async Task<ActionResult<Dictionary<string, string>>> GetNetworkLocations(CancellationToken cancellationToken)
    {
        if (!IsAdministrator())
        {
            return Forbid();
        }

        var config = Plugin.Instance?.Configuration;
        if (config == null || !config.NetworkLocationDisclosure)
        {
            return Ok(new Dictionary<string, string>());
        }

        var sessions = _sessionManager.Sessions
            .Where(s => s.NowPlayingItem != null && !string.IsNullOrEmpty(s.Id))
            .ToList();

        var result = new Dictionary<string, string>(sessions.Count);
        foreach (var session in sessions)
        {
            var label = await _locationService.ResolveLabelAsync(session.RemoteEndPoint, cancellationToken).ConfigureAwait(false);
            if (label != null)
            {
                result[session.Id] = label;
            }
        }

        return Ok(result);
    }
}
