using System;

namespace Jellyfin.Plugin.PlaybackCard.Notifications;

/// <summary>
/// Status result returned by notification dispatches.
/// </summary>
public sealed class DeliveryResult
{
    public bool Success { get; init; }
    public string Category { get; init; } = "OK";
    public int StatusCode { get; init; }
    public TimeSpan? RetryAfter { get; init; }
    public bool IsPermanentFailure { get; init; }

    public static DeliveryResult Ok(int statusCode = 200) => new()
    {
        Success = true,
        Category = "OK",
        StatusCode = statusCode
    };

    public static DeliveryResult Failed(string category, int statusCode = 0, bool permanent = false, TimeSpan? retryAfter = null) => new()
    {
        Success = false,
        Category = category,
        StatusCode = statusCode,
        IsPermanentFailure = permanent,
        RetryAfter = retryAfter
    };
}
