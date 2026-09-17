namespace Jellyfin.Plugin.PlaybackCard.Notifications;

/// <summary>
/// Defines the lifecycle playback events supported by the notification engine.
/// </summary>
public enum NotificationEventType
{
    /// <summary>
    /// Playback started for a media item.
    /// </summary>
    Start,

    /// <summary>
    /// Playback stopped or was terminated.
    /// </summary>
    Stop,

    /// <summary>
    /// Periodic playback progress update.
    /// </summary>
    Progress,

    /// <summary>
    /// Playback completed (derived from PlaybackStopEventArgs.PlayedToCompletion).
    /// </summary>
    Completion,

    /// <summary>
    /// Playback paused (derived from verified state transition).
    /// </summary>
    Pause,

    /// <summary>
    /// Playback resumed (derived from verified state transition).
    /// </summary>
    Resume
}
