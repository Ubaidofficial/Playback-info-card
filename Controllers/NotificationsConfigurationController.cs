using System;
using System.Collections.Generic;
using System.Threading.Tasks;
using Jellyfin.Plugin.PlaybackCard.Notifications;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;

namespace Jellyfin.Plugin.PlaybackCard.Controllers;

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

    public NotificationsConfigurationController(
        INotificationDeliveryService deliveryService,
        INotificationSecretStore secretStore)
        : this(deliveryService, secretStore, null)
    {
    }

    internal NotificationsConfigurationController(
        INotificationDeliveryService deliveryService,
        INotificationSecretStore secretStore,
        PluginConfiguration? testConfig)
    {
        _deliveryService = deliveryService;
        _secretStore = secretStore;
        _testConfig = testConfig;
    }

    private bool IsAdministrator()
    {
        if (User.IsInRole("Administrator") ||
            User.HasClaim("IsAdministrator", "true") ||
            User.HasClaim(c => c.Type.Equals("IsAdministrator", StringComparison.OrdinalIgnoreCase) && c.Value.Equals("true", StringComparison.OrdinalIgnoreCase)))
        {
            return true;
        }

        return false;
    }

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

        // 1. Handle Discord Webhook Credential (Omitted, Masked, New, or Clear)
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
                    return BadRequest(new { error = errCategory, message = "Invalid Discord webhook URL format, scheme, host, or path." });
                }
                _secretStore.SetDiscordWebhookUrl(trimmed);
            }
        }

        // 2. Handle Telegram Bot Token Credential (Omitted, Masked, New, or Clear)
        if (request.ClearTelegramBotToken == true || string.Equals(request.TelegramBotToken, "[CLEAR]", StringComparison.OrdinalIgnoreCase))
        {
            _secretStore.ClearTelegramBotToken();
        }
        else if (!string.IsNullOrWhiteSpace(request.TelegramBotToken))
        {
            var trimmedToken = TelegramBotApiSender.NormalizeToken(request.TelegramBotToken);
            if (!SecretRedactor.IsMasked(trimmedToken))
            {
                var targetChatId = request.TelegramChatId ?? config.TelegramChatId;
                if (!TelegramBotApiSender.ValidateEndpoint(trimmedToken, targetChatId, out _, out var errCategory))
                {
                    return BadRequest(new { error = errCategory, message = "Invalid Telegram bot token format or endpoint." });
                }
                _secretStore.SetTelegramBotToken(trimmedToken);
            }
        }

        if (request.TelegramChatId != null)
        {
            config.TelegramChatId = request.TelegramChatId.Trim();
        }

        // 3. Update switches and event preferences (only overwrite when explicitly supplied)
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

        var onStart = request.NotifyOnStart ?? request.NotifyOnPlaybackStart;
        if (onStart.HasValue) config.NotifyOnStart = onStart.Value;

        var onStop = request.NotifyOnStop ?? request.NotifyOnPlaybackStop;
        if (onStop.HasValue) config.NotifyOnStop = onStop.Value;

        var onPauseResume = request.NotifyOnPauseResume ?? request.NotifyOnPlaybackPauseResume;
        if (onPauseResume.HasValue) config.NotifyOnPauseResume = onPauseResume.Value;

        var onProgress = request.NotifyOnProgress ?? request.NotifyOnPlaybackProgress;
        if (onProgress.HasValue) config.NotifyOnProgress = onProgress.Value;

        var progInterval = request.ProgressIntervalMinutes ?? request.PlaybackProgressIntervalMinutes;
        if (progInterval.HasValue) config.ProgressIntervalMinutes = Math.Max(5, progInterval.Value);

        var onCompletion = request.NotifyOnCompletion ?? request.NotifyOnPlaybackCompletion;
        if (onCompletion.HasValue) config.NotifyOnCompletion = onCompletion.Value;

        var userDisc = request.UsernameDisclosure ?? request.IncludeUserAccountName;
        if (userDisc.HasValue) config.UsernameDisclosure = userDisc.Value;

        var devDisc = request.ClientDeviceDisclosure ?? request.IncludeClientAndDeviceName;
        if (devDisc.HasValue) config.ClientDeviceDisclosure = devDisc.Value;

        if (request.UserFilterMode.HasValue) config.UserFilterMode = request.UserFilterMode.Value;

        if (request.SelectedUserIds != null)
        {
            config.SelectedUserIds = new List<string>(request.SelectedUserIds);
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
            UserFilterMode = config.UserFilterMode,
            SelectedUserIds = config.SelectedUserIds,
            Diagnostics = _deliveryService.GetDiagnostics()
        };
    }
}

/// <summary>
/// Masked DTO returned to client for safe rendering.
/// Never contains plaintext Discord webhook URLs or Telegram bot tokens.
/// </summary>
public sealed class NotificationConfigurationDto
{
    public bool NotificationsEnabled { get; init; }
    public bool Enabled => NotificationsEnabled;

    public bool DiscordEnabled { get; init; }
    public bool HasDiscordWebhook { get; init; }
    public string DiscordWebhookMasked { get; init; } = string.Empty;
    public string DiscordWebhookUrlMasked => DiscordWebhookMasked;

    public bool TelegramEnabled { get; init; }
    public bool HasTelegramBotToken { get; init; }
    public string TelegramBotTokenMasked { get; init; } = string.Empty;
    public string TelegramChatId { get; init; } = string.Empty;

    public bool NotifyOnStart { get; init; }
    public bool NotifyOnPlaybackStart => NotifyOnStart;
    public bool NotifyOnStop { get; init; }
    public bool NotifyOnPlaybackStop => NotifyOnStop;
    public bool NotifyOnPauseResume { get; init; }
    public bool NotifyOnPlaybackPauseResume => NotifyOnPauseResume;
    public bool NotifyOnProgress { get; init; }
    public bool NotifyOnPlaybackProgress => NotifyOnProgress;
    public int ProgressIntervalMinutes { get; init; }
    public int PlaybackProgressIntervalMinutes => ProgressIntervalMinutes;
    public bool NotifyOnCompletion { get; init; }
    public bool NotifyOnPlaybackCompletion => NotifyOnCompletion;

    public bool UsernameDisclosure { get; init; }
    public bool IncludeUserAccountName => UsernameDisclosure;
    public bool ClientDeviceDisclosure { get; init; }
    public bool IncludeClientAndDeviceName => ClientDeviceDisclosure;
    public UserFilterMode UserFilterMode { get; init; }
    public IReadOnlyList<string> SelectedUserIds { get; init; } = Array.Empty<string>();

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
    public bool? NotifyOnPlaybackStart { get; set; }
    public bool? NotifyOnStop { get; set; }
    public bool? NotifyOnPlaybackStop { get; set; }
    public bool? NotifyOnPauseResume { get; set; }
    public bool? NotifyOnPlaybackPauseResume { get; set; }
    public bool? NotifyOnProgress { get; set; }
    public bool? NotifyOnPlaybackProgress { get; set; }
    public int? ProgressIntervalMinutes { get; set; }
    public int? PlaybackProgressIntervalMinutes { get; set; }
    public bool? NotifyOnCompletion { get; set; }
    public bool? NotifyOnPlaybackCompletion { get; set; }

    public bool? UsernameDisclosure { get; set; }
    public bool? IncludeUserAccountName { get; set; }
    public bool? ClientDeviceDisclosure { get; set; }
    public bool? IncludeClientAndDeviceName { get; set; }
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
