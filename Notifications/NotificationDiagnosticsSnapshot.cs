using System;

namespace Jellyfin.Plugin.PlaybackCard.Notifications;

/// <summary>
/// Thread-safe snapshot of notification system health and delivery telemetry.
/// Exposes strictly allow-listed diagnostic counters with zero PII, zero tokens, zero URLs, and zero media data.
/// </summary>
public sealed class NotificationDiagnosticsSnapshot
{
    public bool NotificationsEnabled { get; init; }
    public bool DiscordEnabled { get; init; }
    public bool TelegramEnabled { get; init; }

    public DateTimeOffset? LastAttemptTimestamp { get; init; }
    public DateTimeOffset? LastSuccessTimestamp { get; init; }
    public string? LastSanitizedFailureCategory { get; init; }
    public int LastHttpStatus { get; init; }

    public int QueueCapacity { get; init; } = 100;
    public int DiscordQueueDepth { get; init; }
    public int TelegramQueueDepth { get; init; }
    public int DroppedProgressCount { get; init; }
    public int DroppedCriticalCount { get; init; }
    public int CoalescedProgressCount { get; init; }
    public int DedupeCount { get; init; }
    public int RetryCount { get; init; }
    public int RateLimitDropCount { get; init; }
    public int ValidationFailureCount { get; init; }

    public string WorkerState { get; init; } = "Running";
    public string DiscordAvailabilityState { get; init; } = "Available";
    public string TelegramAvailabilityState { get; init; } = "Available";

    // Aliases for seamless frontend state synchronization
    public bool Enabled => NotificationsEnabled;
    public string DiscordAvailability => DiscordAvailabilityState;
    public string TelegramAvailability => TelegramAvailabilityState;
    public DateTimeOffset? LastDeliveryAttemptUtc => LastAttemptTimestamp;
    public DateTimeOffset? LastSuccessfulDeliveryUtc => LastSuccessTimestamp;
    public string? LastFailureCategory => LastSanitizedFailureCategory;
}
