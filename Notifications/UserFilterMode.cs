namespace Jellyfin.Plugin.PlaybackCard.Notifications;

/// <summary>
/// Defines filtering policy for user accounts in playback notifications.
/// </summary>
public enum UserFilterMode
{
    /// <summary>
    /// Deliver notifications for all user accounts.
    /// </summary>
    AllUsers = 0,

    /// <summary>
    /// Deliver notifications only for explicitly allowed user IDs.
    /// </summary>
    Whitelist = 1,

    /// <summary>
    /// Deliver notifications for all users except explicitly blocked user IDs.
    /// </summary>
    Blacklist = 2
}
