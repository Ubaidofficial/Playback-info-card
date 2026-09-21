using System;
using System.Collections.Generic;
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

    // ASP.NET Core creates a new controller instance per request, but Plugin.Instance.Configuration
    // is one shared mutable object. Two saves fired close together (e.g. flipping the Master Switch
    // and a destination toggle within the same second, which auto-save independently) run on
    // different threads and can otherwise interleave their read-modify-write of that object, so one
    // save's SaveConfiguration() call persists a snapshot that doesn't yet include the other's
    // change. This serializes the whole read-modify-write-persist sequence per process.
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

        lock (ConfigLock)
        {
            return ApplyConfigurationUpdate(config, request);
        }
    }

    private ActionResult<NotificationConfigurationDto> ApplyConfigurationUpdate(PluginConfiguration config, UpdateNotificationConfigurationRequest request)
    {
        // 1. Update switches and event preferences first (only overwrite when explicitly
        // supplied). These must not be lost just because a credential further down turns
        // out to be malformed -- a rejected bot token shouldn't silently revert the
        // enable switch the user just flipped in the same request.
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

        // If notifications are active and a destination is enabled, but no event types were ever enabled,
        // activate Start and Stop events as safe defaults so delivery is not silently broken.
        var hasAnyEventConfigured = config.NotifyOnStart || config.NotifyOnStop || config.NotifyOnCompletion ||
                                   config.NotifyOnPauseResume || config.NotifyOnProgress;
        if (!hasAnyEventConfigured && config.NotificationsEnabled && (config.TelegramEnabled || config.DiscordEnabled))
        {
            if (!onStart.HasValue) config.NotifyOnStart = true;
            if (!onStop.HasValue) config.NotifyOnStop = true;
        }

        var userDisc = request.UsernameDisclosure ?? request.IncludeUserAccountName;
        if (userDisc.HasValue) config.UsernameDisclosure = userDisc.Value;

        var devDisc = request.ClientDeviceDisclosure ?? request.IncludeClientAndDeviceName;
        if (devDisc.HasValue) config.ClientDeviceDisclosure = devDisc.Value;

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

        // 2. Handle Discord Webhook Credential (Omitted, Masked, New, or Clear). A
        // validation failure here saves everything above before returning the error, so
        // the switches/preferences the user just set are never lost by a bad credential.
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

        // 3. Handle Telegram Bot Token Credential (Omitted, Masked, New, or Clear)
        if (request.ClearTelegramBotToken == true || string.Equals(request.TelegramBotToken, "[CLEAR]", StringComparison.OrdinalIgnoreCase))
        {
            _secretStore.ClearTelegramBotToken();
        }
        else if (!string.IsNullOrWhiteSpace(request.TelegramBotToken))
        {
            var trimmedToken = TelegramBotApiSender.NormalizeToken(request.TelegramBotToken);
            if (!SecretRedactor.IsMasked(trimmedToken))
            {
                // Validated on its own syntax, independent of the Chat ID: a token pasted before
                // a Chat ID has ever been configured (or with the Chat ID field left blank in this
                // same request) must still be saved rather than rejected.
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
/// Explicit <see cref="JsonPropertyNameAttribute"/> on every property: this controller is
/// discovered by Jellyfin's own plugin assembly scanning rather than going through a locally
/// configured MVC pipeline, and its actual JSON output does not follow camelCase by default
/// (unlike what the hand-written frontend JS assumes) -- confirmed live: the browser's Network
/// tab showed "NotificationsEnabled": true on the wire while the JS read `data.notificationsEnabled`
/// (lowercase n), which is a different, always-undefined property in JS. That silently produced
/// `Boolean(undefined) === false` on every single load, regardless of the real saved value -- not
/// a save bug, a read bug, invisible to any test that mocks the fetch response or inspects the C#
/// DTO directly instead of the real serialized JSON.
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
    [JsonPropertyName("discordWebhookUrlMasked")]
    public string DiscordWebhookUrlMasked => DiscordWebhookMasked;

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
    [JsonPropertyName("notifyOnPlaybackStart")]
    public bool NotifyOnPlaybackStart => NotifyOnStart;
    [JsonPropertyName("notifyOnStop")]
    public bool NotifyOnStop { get; init; }
    [JsonPropertyName("notifyOnPlaybackStop")]
    public bool NotifyOnPlaybackStop => NotifyOnStop;
    [JsonPropertyName("notifyOnPauseResume")]
    public bool NotifyOnPauseResume { get; init; }
    [JsonPropertyName("notifyOnPlaybackPauseResume")]
    public bool NotifyOnPlaybackPauseResume => NotifyOnPauseResume;
    [JsonPropertyName("notifyOnProgress")]
    public bool NotifyOnProgress { get; init; }
    [JsonPropertyName("notifyOnPlaybackProgress")]
    public bool NotifyOnPlaybackProgress => NotifyOnProgress;
    [JsonPropertyName("progressIntervalMinutes")]
    public int ProgressIntervalMinutes { get; init; }
    [JsonPropertyName("playbackProgressIntervalMinutes")]
    public int PlaybackProgressIntervalMinutes => ProgressIntervalMinutes;
    [JsonPropertyName("notifyOnCompletion")]
    public bool NotifyOnCompletion { get; init; }
    [JsonPropertyName("notifyOnPlaybackCompletion")]
    public bool NotifyOnPlaybackCompletion => NotifyOnCompletion;

    [JsonPropertyName("usernameDisclosure")]
    public bool UsernameDisclosure { get; init; }
    [JsonPropertyName("includeUserAccountName")]
    public bool IncludeUserAccountName => UsernameDisclosure;
    [JsonPropertyName("clientDeviceDisclosure")]
    public bool ClientDeviceDisclosure { get; init; }
    [JsonPropertyName("includeClientAndDeviceName")]
    public bool IncludeClientAndDeviceName => ClientDeviceDisclosure;
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
