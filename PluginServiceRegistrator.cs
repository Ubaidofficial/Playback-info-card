using Jellyfin.Plugin.PlaybackCard.Notifications;
using Jellyfin.Plugin.PlaybackCard.Notifications.Consumers;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Events;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Plugins;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;

namespace Jellyfin.Plugin.PlaybackCard;

/// <summary>
/// Registers plugin services and server-side event consumers into the Jellyfin DI container.
/// Uses Scoped event consumer registrations per Jellyfin EventManager architecture.
/// </summary>
public class PluginServiceRegistrator : IPluginServiceRegistrator
{
    /// <inheritdoc />
    public void RegisterServices(IServiceCollection serviceCollection, IServerApplicationHost applicationHost)
    {
        // Register dedicated server-local secret store
        serviceCollection.AddSingleton<INotificationSecretStore, NotificationSecretStore>();

        // Register HTTP notification senders
        serviceCollection.AddSingleton<IDiscordWebhookSender, DiscordWebhookSender>();
        serviceCollection.AddSingleton<ITelegramBotApiSender, TelegramBotApiSender>();

        // Strictly opt-in (off by default): resolves a session's remote IP into a safe
        // Local Network/Remote(+city/country) label without ever exposing the raw address.
        serviceCollection.AddSingleton<INetworkLocationService, NetworkLocationService>();

        // Register background delivery worker (shared singleton for delivery interface and hosted service)
        serviceCollection.AddSingleton<NotificationDeliveryService>();
        serviceCollection.AddSingleton<INotificationDeliveryService>(sp => sp.GetRequiredService<NotificationDeliveryService>());
        serviceCollection.AddSingleton<IHostedService>(sp => sp.GetRequiredService<NotificationDeliveryService>());

        // Register Jellyfin server-side event consumers as Scoped (required by Jellyfin EventManager)
        serviceCollection.AddScoped<IEventConsumer<PlaybackStartEventArgs>, PlaybackStartConsumer>();
        serviceCollection.AddScoped<IEventConsumer<PlaybackStopEventArgs>, PlaybackStopConsumer>();
        serviceCollection.AddScoped<IEventConsumer<PlaybackProgressEventArgs>, PlaybackProgressConsumer>();

        // Register dashboard script injection startup filter
        serviceCollection.AddTransient<Microsoft.AspNetCore.Hosting.IStartupFilter, PlaybackCardStartupFilter>();
    }
}
