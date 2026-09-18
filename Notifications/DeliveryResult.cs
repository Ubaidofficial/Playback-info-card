using System;
using System.Text.Json.Serialization;

namespace Jellyfin.Plugin.PlaybackCard.Notifications;

/// <summary>
/// Status result returned by notification dispatches.
/// Explicit <see cref="JsonPropertyNameAttribute"/> on every property: the frontend's Test
/// Discord/Test Telegram buttons read this DTO assuming camelCase JSON, which this controller's
/// actual serialized output does not use by default -- same underlying issue as
/// NotificationConfigurationDto.
/// </summary>
public sealed class DeliveryResult
{
    [JsonPropertyName("success")]
    public bool Success { get; init; }
    [JsonPropertyName("category")]
    public string Category { get; init; } = "OK";
    [JsonPropertyName("description")]
    public string? Description { get; init; }
    [JsonPropertyName("statusCode")]
    public int StatusCode { get; init; }
    [JsonPropertyName("retryAfter")]
    public TimeSpan? RetryAfter { get; init; }
    [JsonPropertyName("isPermanentFailure")]
    public bool IsPermanentFailure { get; init; }

    public static DeliveryResult Ok(int statusCode = 200, string? description = null) => new()
    {
        Success = true,
        Category = "OK",
        StatusCode = statusCode,
        Description = description
    };

    public static DeliveryResult Failed(string category, int statusCode = 0, bool permanent = false, TimeSpan? retryAfter = null, string? description = null) => new()
    {
        Success = false,
        Category = category,
        StatusCode = statusCode,
        IsPermanentFailure = permanent,
        RetryAfter = retryAfter,
        Description = description
    };
}
