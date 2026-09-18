using System;
using System.Text.Json.Serialization;

namespace Jellyfin.Plugin.PlaybackCard.Notifications;

/// <summary>
/// Thread-safe snapshot of notification system health and delivery telemetry.
/// Exposes strictly allow-listed diagnostic counters with zero PII, zero tokens, zero URLs, and zero media data.
/// Explicit <see cref="JsonPropertyNameAttribute"/> on every property: this DTO is served both
/// nested inside NotificationConfigurationDto and standalone from the Diagnostics endpoint, and
/// this controller's actual JSON output does not follow camelCase by default -- the frontend JS
/// was written assuming it did, so every diagnostic tile (queue depth, dedupe count, worker state,
/// etc.) silently showed stale/default values regardless of the real server state, the same class
/// of bug as the notification toggles themselves.
/// </summary>
public sealed class NotificationDiagnosticsSnapshot
{
    [JsonPropertyName("notificationsEnabled")]
    public bool NotificationsEnabled { get; init; }
    [JsonPropertyName("discordEnabled")]
    public bool DiscordEnabled { get; init; }
    [JsonPropertyName("telegramEnabled")]
    public bool TelegramEnabled { get; init; }

    [JsonPropertyName("lastAttemptTimestamp")]
    public DateTimeOffset? LastAttemptTimestamp { get; init; }
    [JsonPropertyName("lastSuccessTimestamp")]
    public DateTimeOffset? LastSuccessTimestamp { get; init; }
    [JsonPropertyName("lastSanitizedFailureCategory")]
    public string? LastSanitizedFailureCategory { get; init; }
    // Already redacted at the source (SecretRedactor) before it ever reaches here -- see
    // TelegramBotApiSender/DiscordWebhookSender's DescribeClientError/error-description
    // paths -- so this stays within the zero-PII/zero-secret guarantee above while giving
    // a non-technical user (via Copy Diagnostic Report) the actual reason, not just a
    // category code they'd have to look up.
    [JsonPropertyName("lastFailureDescription")]
    public string? LastFailureDescription { get; init; }
    [JsonPropertyName("lastHttpStatus")]
    public int LastHttpStatus { get; init; }

    [JsonPropertyName("queueCapacity")]
    public int QueueCapacity { get; init; } = 100;
    [JsonPropertyName("discordQueueDepth")]
    public int DiscordQueueDepth { get; init; }
    [JsonPropertyName("telegramQueueDepth")]
    public int TelegramQueueDepth { get; init; }
    [JsonPropertyName("droppedProgressCount")]
    public int DroppedProgressCount { get; init; }
    [JsonPropertyName("droppedCriticalCount")]
    public int DroppedCriticalCount { get; init; }
    [JsonPropertyName("coalescedProgressCount")]
    public int CoalescedProgressCount { get; init; }
    [JsonPropertyName("dedupeCount")]
    public int DedupeCount { get; init; }
    [JsonPropertyName("retryCount")]
    public int RetryCount { get; init; }
    [JsonPropertyName("rateLimitDropCount")]
    public int RateLimitDropCount { get; init; }
    [JsonPropertyName("validationFailureCount")]
    public int ValidationFailureCount { get; init; }

    [JsonPropertyName("workerState")]
    public string WorkerState { get; init; } = "Running";
    [JsonPropertyName("discordAvailabilityState")]
    public string DiscordAvailabilityState { get; init; } = "Available";
    [JsonPropertyName("telegramAvailabilityState")]
    public string TelegramAvailabilityState { get; init; } = "Available";

    // Aliases for seamless frontend state synchronization
    [JsonPropertyName("enabled")]
    public bool Enabled => NotificationsEnabled;
    [JsonPropertyName("discordAvailability")]
    public string DiscordAvailability => DiscordAvailabilityState;
    [JsonPropertyName("telegramAvailability")]
    public string TelegramAvailability => TelegramAvailabilityState;
    [JsonPropertyName("lastDeliveryAttemptUtc")]
    public DateTimeOffset? LastDeliveryAttemptUtc => LastAttemptTimestamp;
    [JsonPropertyName("lastSuccessfulDeliveryUtc")]
    public DateTimeOffset? LastSuccessfulDeliveryUtc => LastSuccessTimestamp;
    [JsonPropertyName("lastFailureCategory")]
    public string? LastFailureCategory => LastSanitizedFailureCategory;
}
