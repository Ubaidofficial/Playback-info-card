using System;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;

namespace Jellyfin.Plugin.PlaybackCard;

/// <summary>
/// Startup filter that registers the PlaybackCardMiddleware into the ASP.NET Core application pipeline.
/// </summary>
public class PlaybackCardStartupFilter : IStartupFilter
{
    /// <summary>
    /// Extends the application pipeline configuration with the PlaybackCardMiddleware.
    /// </summary>
    /// <param name="next">The next configure action.</param>
    /// <returns>A modified configure action.</returns>
    public Action<IApplicationBuilder> Configure(Action<IApplicationBuilder> next)
    {
        ArgumentNullException.ThrowIfNull(next);

        return app =>
        {
            app.UseMiddleware<PlaybackCardMiddleware>();
            next(app);
        };
    }
}
