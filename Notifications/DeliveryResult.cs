using System;

namespace Jellyfin.Plugin.PlaybackCard.Notifications;

/// <summary>
/// Status result returned by notification dispatches.
/// </summary>
public sealed class DeliveryResult
{
    public bool Success { get; init; }
    public string Category { get; init; } = "OK";
    public string? Description { get; init; }
    public int StatusCode { get; init; }
    public TimeSpan? RetryAfter { get; init; }
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
