using MediaBrowser.Controller;
using MediaBrowser.Controller.Plugins;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.DependencyInjection;

namespace Jellyfin.Plugin.PlaybackCard;

/// <summary>
/// Registers the Playback Info Card services and middleware into the Jellyfin dependency injection container.
/// </summary>
public class PlaybackCardServiceRegistrator : IPluginServiceRegistrator
{
    /// <summary>
    /// Registers plugin services into the DI container.
    /// </summary>
    /// <param name="serviceCollection">The service collection.</param>
    /// <param name="applicationHost">The server application host.</param>
    public void RegisterServices(IServiceCollection serviceCollection, IServerApplicationHost applicationHost)
    {
        serviceCollection.AddTransient<IStartupFilter, PlaybackCardStartupFilter>();
    }
}
