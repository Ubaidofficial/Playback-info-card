using System.Threading;
using System.Threading.Tasks;
using Microsoft.Extensions.Hosting;

namespace Jellyfin.Plugin.PlaybackCard.Notifications;

/// <summary>
/// Core contract for the native notification delivery engine.
/// Manages independent bounded queues, deduplication, coalescing, and background dispatching.
/// </summary>
public interface INotificationDeliveryService : IHostedService
{
    /// <summary>
    /// Synchronously accepts and enqueues a playback event record without blocking the caller.
    /// Event filtering, deduplication, and coalescing occur in-memory immediately.
    /// </summary>
    /// <param name="record">The playback event record.</param>
    void Enqueue(PlaybackEventRecord record);

    /// <summary>
    /// Dispatches a synthetic test notification using dummy media data.
    /// </summary>
    /// <param name="destination">Target destination ("discord" or "telegram").</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>Sanitized delivery result.</returns>
    Task<DeliveryResult> SendTestNotificationAsync(string destination, CancellationToken cancellationToken);

    /// <summary>
    /// Obtains a thread-safe diagnostic telemetry snapshot.
    /// </summary>
    /// <returns>Allow-listed diagnostic snapshot.</returns>
    NotificationDiagnosticsSnapshot GetDiagnostics();
}
