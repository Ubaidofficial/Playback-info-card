using System;
using System.Collections.Generic;
using System.Security.Claims;
using System.Text.Json.Serialization;
using System.Threading.Tasks;
using Jellyfin.Plugin.PlaybackCard.Notifications;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;

namespace Jellyfin.Plugin.PlaybackCard.Controllers;

/// <summary>
/// Shared authorization helper for administrator-only plugin controllers.
/// </summary>
internal static class ControllerAuthHelper
{
    public static bool IsAdministrator(ClaimsPrincipal? user)
    {
        if (user == null)
        {
            return false;
        }

        return user.IsInRole("Administrator") ||
               user.HasClaim("IsAdministrator", "true") ||
               user.HasClaim(c => c.Type.Equals("IsAdministrator", StringComparison.OrdinalIgnoreCase) &&
                                  c.Value.Equals("true", StringComparison.OrdinalIgnoreCase));
    }
}

/// <summary>
/// Administrator-only API controller for managing native notification settings,
/// running synthetic test deliveries, and inspecting delivery diagnostics.
/// Enforces write-only secrets, UI masking, and strict administrator elevation.
/// </summary>
[ApiController]
[Route("PlaybackCard/Notifications")]
[Route("PlaybackInfoCard/Notifications")]
[Authorize(Policy = "RequiresElevation")]
public class NotificationsConfigurationController : ControllerBase
{
    private readonly INotificationDeliveryService _deliveryService;
    private readonly INotificationSecretStore _secretStore;
    private readonly PluginConfiguration? _testConfig;
    private readonly ILogger _logger;

    // Serializes concurrent read-modify-write updates against the shared PluginConfiguration instance.
    private static readonly object ConfigLock = new();

    public NotificationsConfigurationController(
        INotificationDeliveryService deliveryService,
        INotificationSecretStore secretStore)
        : this(deliveryService, secretStore, null, null)
    {
    }

    public NotificationsConfigurationController(
        INotificationDeliveryService deliveryService,
        INotificationSecretStore secretStore,
        ILogger<NotificationsConfigurationController> logger)
        : this(deliveryService, secretStore, null, logger)
    {
    }

    internal NotificationsConfigurationController(
        INotificationDeliveryService deliveryService,
        INotificationSecretStore secretStore,
        PluginConfiguration? testConfig,
        ILogger? logger = null)
    {
        _deliveryService = deliveryService;
        _secretStore = secretStore;
        _testConfig = testConfig;
        _logger = logger ?? NullLogger.Instance;
    }

    private bool IsAdministrator() => ControllerAuthHelper.IsAdministrator(User);

    /// <summary>
    /// Obtains current notification settings with masked credentials and real-time diagnostics.
    /// Never returns full Discord webhook URLs or Telegram bot tokens.
    /// </summary>
    [HttpGet("Configuration")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status403Forbidden)]
    public ActionResult<NotificationConfigurationDto> GetConfiguration()
    {
        if (!IsAdministrator())
        {
            return Forbid();
        }

        var config = _testConfig ?? Plugin.Instance?.Configuration ?? new PluginConfiguration();
        return Ok(ToDto(config));
    }

    /// <summary>
    /// Updates notification settings with write-only credential handling and strict validation.
    /// Blank credential inputs preserve existing stored secrets.
    /// </summary>
    [HttpPost("Configuration")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    [ProducesResponseType(StatusCodes.Status403Forbidden)]
    public ActionResult<NotificationConfigurationDto> UpdateConfiguration([FromBody] UpdateNotificationConfigurationRequest request)
    {
        if (!IsAdministrator())
        {
            return Forbid();
        }

        if (request == null)
        {
            return BadRequest(new { error = "InvalidConfiguration", message = "Request body is missing." });
        }

        var config = _testConfig ?? Plugin.Instance?.Configuration;
        if (config == null)
        {
            return StatusCode(StatusCodes.Status500InternalServerError, new { error = "PluginNotLoaded" });
        }

        lock (ConfigLock)
        {
            return ApplyConfigurationUpdate(config, request);
        }
    }

    private ActionResult<NotificationConfigurationDto> ApplyConfigurationUpdate(PluginConfiguration config, UpdateNotificationConfigurationRequest request)
    {
        // 1. Update switches and event preferences first (only overwrite when explicitly supplied).
        var notifsEnabled = request.NotificationsEnabled ?? request.Enabled;
        if (notifsEnabled.HasValue)
        {
            config.NotificationsEnabled = notifsEnabled.Value;
        }

        if (request.DiscordEnabled.HasValue)
        {
            config.DiscordEnabled = request.DiscordEnabled.Value;
        }

        if (request.TelegramEnabled.HasValue)
        {
            config.TelegramEnabled = request.TelegramEnabled.Value;
        }

        if (request.NotifyOnStart.HasValue) config.NotifyOnStart = request.NotifyOnStart.Value;
        if (request.NotifyOnStop.HasValue) config.NotifyOnStop = request.NotifyOnStop.Value;
        if (request.NotifyOnPauseResume.HasValue) config.NotifyOnPauseResume = request.NotifyOnPauseResume.Value;
        if (request.NotifyOnProgress.HasValue) config.NotifyOnProgress = request.NotifyOnProgress.Value;
        if (request.ProgressIntervalMinutes.HasValue) config.ProgressIntervalMinutes = Math.Max(5, request.ProgressIntervalMinutes.Value);
        if (request.NotifyOnCompletion.HasValue) config.NotifyOnCompletion = request.NotifyOnCompletion.Value;

        // If notifications and a destination are active with no event types enabled, default Start and Stop to true.
        var hasAnyEventConfigured = config.NotifyOnStart || config.NotifyOnStop || config.NotifyOnCompletion ||
                                    config.NotifyOnPauseResume || config.NotifyOnProgress;
        if (!hasAnyEventConfigured && config.NotificationsEnabled && (config.TelegramEnabled || config.DiscordEnabled))
        {
            if (!request.NotifyOnStart.HasValue) config.NotifyOnStart = true;
            if (!request.NotifyOnStop.HasValue) config.NotifyOnStop = true;
        }

        if (request.UsernameDisclosure.HasValue) config.UsernameDisclosure = request.UsernameDisclosure.Value;
        if (request.ClientDeviceDisclosure.HasValue) config.ClientDeviceDisclosure = request.ClientDeviceDisclosure.Value;
        if (request.NetworkLocationDisclosure.HasValue) config.NetworkLocationDisclosure = request.NetworkLocationDisclosure.Value;
        if (request.IncludePosterImage.HasValue) config.IncludePosterImage = request.IncludePosterImage.Value;
        if (request.UploadBandwidthLimitMbps.HasValue) config.UploadBandwidthLimitMbps = Math.Max(0, request.UploadBandwidthLimitMbps.Value);
        if (request.UserFilterMode.HasValue) config.UserFilterMode = request.UserFilterMode.Value;

        if (request.SelectedUserIds != null)
        {
            config.SelectedUserIds = new List<string>(request.SelectedUserIds);
        }

        if (request.TelegramChatId != null)
        {
            var trimmedChatId = request.TelegramChatId.Trim();
            if (trimmedChatId.Length > 0 && !TelegramBotApiSender.ValidateChatIdFormat(trimmedChatId, out var chatIdErrCategory))
            {
                Plugin.Instance?.SaveConfiguration();
                return BadRequest(new { error = chatIdErrCategory, message = "Invalid Telegram Chat ID format. Use a numeric ID (e.g. -100123456789) or an @channel username." });
            }

            config.TelegramChatId = trimmedChatId;
        }

        // 2. Handle Discord Webhook Credential (Omitted, Masked, New, or Clear).
        if (request.ClearDiscordWebhook == true || string.Equals(request.DiscordWebhookUrl, "[CLEAR]", StringComparison.OrdinalIgnoreCase))
        {
            _secretStore.ClearDiscordWebhookUrl();
        }
        else if (!string.IsNullOrWhiteSpace(request.DiscordWebhookUrl))
        {
            var trimmed = request.DiscordWebhookUrl.Trim();
            if (!SecretRedactor.IsMasked(trimmed))
            {
                if (!DiscordWebhookSender.ValidateWebhookUrl(trimmed, out _, out var errCategory))
                {
                    Plugin.Instance?.SaveConfiguration();
                    return BadRequest(new { error = errCategory, message = "Invalid Discord webhook URL format, scheme, host, or path." });
                }
                _secretStore.SetDiscordWebhookUrl(trimmed);
            }
        }

        // 3. Handle Telegram Bot Token Credential (Omitted, Masked, New, or Clear).
        if (request.ClearTelegramBotToken == true || string.Equals(request.TelegramBotToken, "[CLEAR]", StringComparison.OrdinalIgnoreCase))
        {
            _secretStore.ClearTelegramBotToken();
        }
        else if (!string.IsNullOrWhiteSpace(request.TelegramBotToken))
        {
            var trimmedToken = TelegramBotApiSender.NormalizeToken(request.TelegramBotToken);
            if (!SecretRedactor.IsMasked(trimmedToken))
            {
                if (!TelegramBotApiSender.ValidateTokenFormat(trimmedToken, out var errCategory))
                {
                    Plugin.Instance?.SaveConfiguration();
                    return BadRequest(new { error = errCategory, message = "Invalid Telegram bot token format." });
                }
                _secretStore.SetTelegramBotToken(trimmedToken);
            }
        }

        Plugin.Instance?.SaveConfiguration();

        return Ok(ToDto(config));
    }

    /// <summary>
    /// Dispatches a synthetic test notification using dummy media data.
    /// </summary>
    [HttpPost("Test")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    [ProducesResponseType(StatusCodes.Status403Forbidden)]
    public async Task<ActionResult<DeliveryResult>> SendTestNotification([FromBody] SendTestNotificationRequest request)
    {
        if (!IsAdministrator())
        {
            return Forbid();
        }

        if (request == null || string.IsNullOrWhiteSpace(request.Destination))
        {
            return BadRequest(DeliveryResult.Failed("InvalidConfiguration", 400, permanent: true, description: "Missing destination. Specify 'Discord' or 'Telegram'."));
        }

        var result = await _deliveryService.SendTestNotificationAsync(request.Destination, HttpContext.RequestAborted).ConfigureAwait(false);
        _logger.LogInformation(
            "[NotificationsController] Test {Destination} result: Success={Success}, Category={Category}, StatusCode={StatusCode}, Description={Description}",
            request.Destination,
            result.Success,
            result.Category,
            result.StatusCode,
            result.Description ?? "(none)");
        return Ok(result);
    }

    /// <summary>
    /// Retrieves current delivery diagnostics snapshot.
    /// </summary>
    [HttpGet("Diagnostics")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status403Forbidden)]
    public ActionResult<NotificationDiagnosticsSnapshot> GetDiagnostics()
    {
        if (!IsAdministrator())
        {
            return Forbid();
        }

        return Ok(_deliveryService.GetDiagnostics());
    }

    private NotificationConfigurationDto ToDto(PluginConfiguration config)
    {
        var discordWebhook = _secretStore.GetDiscordWebhookUrl();
        var telegramToken = _secretStore.GetTelegramBotToken();

        return new NotificationConfigurationDto
        {
            NotificationsEnabled = config.NotificationsEnabled,
            DiscordEnabled = config.DiscordEnabled,
            HasDiscordWebhook = !string.IsNullOrWhiteSpace(discordWebhook),
            DiscordWebhookMasked = SecretRedactor.MaskDiscordWebhook(discordWebhook),
            TelegramEnabled = config.TelegramEnabled,
            HasTelegramBotToken = !string.IsNullOrWhiteSpace(telegramToken),
            TelegramBotTokenMasked = SecretRedactor.MaskTelegramToken(telegramToken),
            TelegramChatId = config.TelegramChatId,
            NotifyOnStart = config.NotifyOnStart,
            NotifyOnStop = config.NotifyOnStop,
            NotifyOnPauseResume = config.NotifyOnPauseResume,
            NotifyOnProgress = config.NotifyOnProgress,
            ProgressIntervalMinutes = config.ProgressIntervalMinutes,
            NotifyOnCompletion = config.NotifyOnCompletion,
            UsernameDisclosure = config.UsernameDisclosure,
            ClientDeviceDisclosure = config.ClientDeviceDisclosure,
            NetworkLocationDisclosure = config.NetworkLocationDisclosure,
            IncludePosterImage = config.IncludePosterImage,
            UploadBandwidthLimitMbps = config.UploadBandwidthLimitMbps,
            UserFilterMode = config.UserFilterMode,
            SelectedUserIds = config.SelectedUserIds,
            Diagnostics = _deliveryService.GetDiagnostics()
        };
    }
}

/// <summary>
/// Masked DTO returned to client for safe rendering.
/// Never contains plaintext Discord webhook URLs or Telegram bot tokens.
/// Uses explicit camelCase <see cref="JsonPropertyNameAttribute"/> attributes to ensure consistent
/// wire serialization regardless of host-level MVC JSON naming policy configuration.
/// </summary>
public sealed class NotificationConfigurationDto
{
    [JsonPropertyName("notificationsEnabled")]
    public bool NotificationsEnabled { get; init; }
    [JsonPropertyName("enabled")]
    public bool Enabled => NotificationsEnabled;

    [JsonPropertyName("discordEnabled")]
    public bool DiscordEnabled { get; init; }
    [JsonPropertyName("hasDiscordWebhook")]
    public bool HasDiscordWebhook { get; init; }
    [JsonPropertyName("discordWebhookMasked")]
    public string DiscordWebhookMasked { get; init; } = string.Empty;

    [JsonPropertyName("telegramEnabled")]
    public bool TelegramEnabled { get; init; }
    [JsonPropertyName("hasTelegramBotToken")]
    public bool HasTelegramBotToken { get; init; }
    [JsonPropertyName("telegramBotTokenMasked")]
    public string TelegramBotTokenMasked { get; init; } = string.Empty;
    [JsonPropertyName("telegramChatId")]
    public string TelegramChatId { get; init; } = string.Empty;

    [JsonPropertyName("notifyOnStart")]
    public bool NotifyOnStart { get; init; }
    [JsonPropertyName("notifyOnStop")]
    public bool NotifyOnStop { get; init; }
    [JsonPropertyName("notifyOnPauseResume")]
    public bool NotifyOnPauseResume { get; init; }
    [JsonPropertyName("notifyOnProgress")]
    public bool NotifyOnProgress { get; init; }
    [JsonPropertyName("progressIntervalMinutes")]
    public int ProgressIntervalMinutes { get; init; }
    [JsonPropertyName("notifyOnCompletion")]
    public bool NotifyOnCompletion { get; init; }

    [JsonPropertyName("usernameDisclosure")]
    public bool UsernameDisclosure { get; init; }
    [JsonPropertyName("clientDeviceDisclosure")]
    public bool ClientDeviceDisclosure { get; init; }
    [JsonPropertyName("networkLocationDisclosure")]
    public bool NetworkLocationDisclosure { get; init; }
    [JsonPropertyName("includePosterImage")]
    public bool IncludePosterImage { get; init; }
    [JsonPropertyName("uploadBandwidthLimitMbps")]
    public int UploadBandwidthLimitMbps { get; init; }
    [JsonPropertyName("userFilterMode")]
    public UserFilterMode UserFilterMode { get; init; }
    [JsonPropertyName("selectedUserIds")]
    public IReadOnlyList<string> SelectedUserIds { get; init; } = Array.Empty<string>();

    [JsonPropertyName("diagnostics")]
    public NotificationDiagnosticsSnapshot? Diagnostics { get; init; }
}

/// <summary>
/// Write-only request payload for updating notification settings.
/// Supports partial updates: omitted/null properties do not overwrite existing settings.
/// </summary>
public sealed class UpdateNotificationConfigurationRequest
{
    public bool? NotificationsEnabled { get; set; }
    public bool? Enabled { get; set; }

    public bool? DiscordEnabled { get; set; }
    public string? DiscordWebhookUrl { get; set; }
    public bool? ClearDiscordWebhook { get; set; }

    public bool? TelegramEnabled { get; set; }
    public string? TelegramBotToken { get; set; }
    public bool? ClearTelegramBotToken { get; set; }
    public string? TelegramChatId { get; set; }

    public bool? NotifyOnStart { get; set; }
    public bool? NotifyOnStop { get; set; }
    public bool? NotifyOnPauseResume { get; set; }
    public bool? NotifyOnProgress { get; set; }
    public int? ProgressIntervalMinutes { get; set; }
    public bool? NotifyOnCompletion { get; set; }

    public bool? UsernameDisclosure { get; set; }
    public bool? ClientDeviceDisclosure { get; set; }
    public bool? NetworkLocationDisclosure { get; set; }
    public bool? IncludePosterImage { get; set; }
    public int? UploadBandwidthLimitMbps { get; set; }
    public UserFilterMode? UserFilterMode { get; set; }
    public List<string>? SelectedUserIds { get; set; }
}

/// <summary>
/// Request payload for synthetic test notification dispatch.
/// </summary>
public sealed class SendTestNotificationRequest
{
    public string Destination { get; set; } = string.Empty;
}
