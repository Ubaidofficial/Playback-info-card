using System;
using System.Collections.Generic;
using System.Security.Claims;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.PlaybackCard;
using Jellyfin.Plugin.PlaybackCard.Controllers;
using Jellyfin.Plugin.PlaybackCard.Notifications;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace JellyfinPlaybackCard.Tests;

public class NotificationsConfigurationControllerTests
{
    private static ControllerContext AdminContext()
    {
        var claims = new List<Claim>
        {
            new(ClaimTypes.Role, "Administrator"),
            new("IsAdministrator", "true")
        };
        var identity = new ClaimsIdentity(claims, "TestAuth");
        var principal = new ClaimsPrincipal(identity);
        return new ControllerContext
        {
            HttpContext = new DefaultHttpContext { User = principal }
        };
    }

    private static NotificationsConfigurationController CreateController(PluginConfiguration config)
    {
        return new NotificationsConfigurationController(new MockDeliveryService(), new MockSecretStore(), config, NullLogger.Instance)
        {
            ControllerContext = AdminContext()
        };
    }

    /// <summary>
    /// Reproduces the real-world sequence a user actually triggers: flipping the Master Switch and
    /// a destination toggle (Discord/Telegram) within the same second, both of which auto-save
    /// independently as soon as v0.2.7.1. Each save is its own HTTP POST handled by its own
    /// controller instance (ASP.NET Core is per-request), racing to read-modify-write the SAME
    /// shared PluginConfiguration object. Without a lock around that sequence, one save's
    /// SaveConfiguration() call can persist a snapshot that doesn't yet include the other save's
    /// change, silently dropping it -- exactly the "settings aren't saved" symptom reported live.
    /// </summary>
    [Fact]
    public async Task UpdateConfiguration_ConcurrentMasterAndDestinationToggle_NeitherUpdateIsLost()
    {
        for (var iteration = 0; iteration < 200; iteration++)
        {
            var config = new PluginConfiguration { NotificationsEnabled = false, TelegramEnabled = false };

            var barrier = new Barrier(2);

            var masterTask = Task.Run(() =>
            {
                barrier.SignalAndWait();
                var controller = CreateController(config);
                controller.UpdateConfiguration(new UpdateNotificationConfigurationRequest { NotificationsEnabled = true });
            });

            var telegramTask = Task.Run(() =>
            {
                barrier.SignalAndWait();
                var controller = CreateController(config);
                controller.UpdateConfiguration(new UpdateNotificationConfigurationRequest { TelegramEnabled = true });
            });

            await Task.WhenAll(masterTask, telegramTask);

            Assert.True(config.NotificationsEnabled, $"Master Switch update was lost on iteration {iteration}.");
            Assert.True(config.TelegramEnabled, $"Telegram toggle update was lost on iteration {iteration}.");
        }
    }

    /// <summary>
    /// Literal reproduction of the live bug report: "even after clicking the master switch and
    /// enable telegram delivery, the settings aren't saved." Each click is its own sequential
    /// HTTP request (its own controller instance, exactly like production), no artificial race --
    /// just the two plain actions in the order the report describes, then a GET (what the page's
    /// own auto-reload after each save does) to check what actually persisted.
    /// </summary>
    [Fact]
    public void UpdateConfiguration_ClickMasterSwitchThenEnableTelegram_BothPersistOnNextLoad()
    {
        var config = new PluginConfiguration { NotificationsEnabled = false, TelegramEnabled = false };

        // Click 1: flip the Master Switch.
        var masterResult = CreateController(config)
            .UpdateConfiguration(new UpdateNotificationConfigurationRequest { NotificationsEnabled = true });
        var masterDto = Assert.IsType<NotificationConfigurationDto>(Assert.IsType<OkObjectResult>(masterResult.Result).Value);
        Assert.True(masterDto.NotificationsEnabled, "Master Switch save's own response should already reflect it as enabled.");

        // Click 2: flip "Enable Telegram Delivery".
        var telegramResult = CreateController(config)
            .UpdateConfiguration(new UpdateNotificationConfigurationRequest { TelegramEnabled = true });
        var telegramDto = Assert.IsType<NotificationConfigurationDto>(Assert.IsType<OkObjectResult>(telegramResult.Result).Value);
        Assert.True(telegramDto.NotificationsEnabled, "Telegram save's response must still show Master as enabled -- this is the exact check the frontend uses to decide whether to show \"Notifications remain disabled until the Master Switch is enabled.\"");
        Assert.True(telegramDto.TelegramEnabled);

        // What the page's own reload (GET) sees afterwards -- this is what the user actually looks at.
        var loaded = Assert.IsType<NotificationConfigurationDto>(Assert.IsType<OkObjectResult>(CreateController(config).GetConfiguration().Result).Value);
        Assert.True(loaded.NotificationsEnabled, "Master Switch should still read as enabled on reload.");
        Assert.True(loaded.TelegramEnabled, "Telegram should still read as enabled on reload.");
    }

    [Fact]
    public void UpdateConfiguration_AsAdmin_PersistsMasterSwitch()
    {
        var config = new PluginConfiguration { NotificationsEnabled = false };
        var controller = CreateController(config);

        var result = controller.UpdateConfiguration(new UpdateNotificationConfigurationRequest { NotificationsEnabled = true });

        Assert.IsType<OkObjectResult>(result.Result);
        Assert.True(config.NotificationsEnabled);
    }

    /// <summary>
    /// Reproduces the actual live bug, caught only by inspecting a real browser's Network tab:
    /// every existing test either called this controller's C# methods directly (inspecting the
    /// DTO object, never its serialized form) or mocked the frontend's fetch response by hand
    /// with lowercase keys -- neither would ever catch a real JSON-casing mismatch. This test
    /// runs the DTO through System.Text.Json with no naming policy configured (matching this
    /// plugin's actual default behavior, confirmed live: the wire response was
    /// "NotificationsEnabled": true, not "notificationsEnabled") and asserts the JSON the
    /// frontend actually receives has the lowercase-first keys it reads by name.
    /// </summary>
    [Fact]
    public void NotificationConfigurationDto_SerializesWithCamelCaseKeys_MatchingWhatFrontendJsReads()
    {
        var config = new PluginConfiguration { NotificationsEnabled = true, TelegramEnabled = true };
        var controller = CreateController(config);

        var dto = Assert.IsType<NotificationConfigurationDto>(Assert.IsType<OkObjectResult>(controller.GetConfiguration().Result).Value);

        var json = JsonSerializer.Serialize(dto);
        using var doc = JsonDocument.Parse(json);
        var root = doc.RootElement;

        Assert.True(root.TryGetProperty("notificationsEnabled", out var notificationsEnabled), $"Expected lowercase-first \"notificationsEnabled\" key in: {json}");
        Assert.True(notificationsEnabled.GetBoolean());
        Assert.True(root.TryGetProperty("telegramEnabled", out var telegramEnabled), $"Expected lowercase-first \"telegramEnabled\" key in: {json}");
        Assert.True(telegramEnabled.GetBoolean());
        Assert.True(root.TryGetProperty("discordEnabled", out _), $"Expected lowercase-first \"discordEnabled\" key in: {json}");
        Assert.False(root.TryGetProperty("NotificationsEnabled", out _), "Must not also serialize the PascalCase key -- that's what the frontend never reads.");
    }

    [Fact]
    public void NotificationDiagnosticsSnapshot_SerializesWithCamelCaseKeys()
    {
        var snapshot = new NotificationDiagnosticsSnapshot { NotificationsEnabled = true, WorkerState = "Running", DedupeCount = 3 };

        var json = JsonSerializer.Serialize(snapshot);
        using var doc = JsonDocument.Parse(json);
        var root = doc.RootElement;

        Assert.True(root.TryGetProperty("notificationsEnabled", out _), $"Expected lowercase-first \"notificationsEnabled\" key in: {json}");
        Assert.True(root.TryGetProperty("workerState", out _), $"Expected lowercase-first \"workerState\" key in: {json}");
        Assert.True(root.TryGetProperty("dedupeCount", out _), $"Expected lowercase-first \"dedupeCount\" key in: {json}");
    }

    [Fact]
    public void DeliveryResult_SerializesWithCamelCaseKeys()
    {
        var result = DeliveryResult.Ok(200, "all good");

        var json = JsonSerializer.Serialize(result);
        using var doc = JsonDocument.Parse(json);
        var root = doc.RootElement;

        Assert.True(root.TryGetProperty("success", out var success), $"Expected lowercase-first \"success\" key in: {json}");
        Assert.True(success.GetBoolean());
        Assert.True(root.TryGetProperty("category", out _), $"Expected lowercase-first \"category\" key in: {json}");
    }

    /// <summary>
    /// Deliberate opposite of the camelCase tests above. UserPlaybackSessionDto (a different
    /// controller entirely) must NOT get JsonPropertyName camelCase overrides -- both
    /// dashboard.js and playbackcard.html's session-rendering code is shared between this DTO's
    /// endpoint and Jellyfin's own native /Sessions API, and reads session.MediaTitle,
    /// session.PlayMethod, session.IsVideoDirect in PascalCase throughout. This guards against
    /// "fixing" this DTO the same way as the notification DTOs and silently breaking the
    /// personal/self session view instead.
    /// </summary>
    [Fact]
    public void UserPlaybackSessionDto_SerializesWithPascalCaseKeys_MatchingSharedSessionRenderer()
    {
        var dto = new Jellyfin.Plugin.PlaybackCard.Controllers.UserPlaybackSessionDto { MediaTitle = "Test Movie", PlayMethod = "DirectPlay" };

        var json = JsonSerializer.Serialize(dto);
        using var doc = JsonDocument.Parse(json);
        var root = doc.RootElement;

        Assert.True(root.TryGetProperty("MediaTitle", out var mediaTitle), $"Expected PascalCase \"MediaTitle\" key (matching dashboard.js/playbackcard.html) in: {json}");
        Assert.Equal("Test Movie", mediaTitle.GetString());
        Assert.True(root.TryGetProperty("PlayMethod", out _), $"Expected PascalCase \"PlayMethod\" key in: {json}");
        Assert.False(root.TryGetProperty("mediaTitle", out _), "Must not serialize as camelCase -- that would break dashboard.js/playbackcard.html's shared session renderer.");
    }

    [Fact]
    public void UpdateConfiguration_WhenNotAdministrator_ReturnsForbidden()
    {
        var config = new PluginConfiguration();
        var controller = new NotificationsConfigurationController(new MockDeliveryService(), new MockSecretStore(), config, NullLogger.Instance)
        {
            ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext { User = new ClaimsPrincipal(new ClaimsIdentity()) } }
        };

        var result = controller.UpdateConfiguration(new UpdateNotificationConfigurationRequest { NotificationsEnabled = true });

        Assert.IsType<ForbidResult>(result.Result);
    }

    /// <summary>
    /// Reproduces the real-world "Telegram only works when I click Test" report: an admin enables
    /// the Master Switch and Telegram (with a working token/chat ID) but, because every event
    /// checkbox defaults to off, never explicitly checks any of them. Enqueue() silently drops
    /// every real playback event at the event-enablement gate, while the Test button bypasses that
    /// gate entirely -- so Test "works" and nothing else ever does. This asserts the save-time
    /// auto-recovery: activating notifications + a destination with zero events configured
    /// activates Start/Stop as safe defaults, without needing a second, separate save.
    /// </summary>
    [Fact]
    public void UpdateConfiguration_EnablingDestinationWithNoEventsConfigured_AutoEnablesStartAndStop()
    {
        var config = new PluginConfiguration
        {
            NotificationsEnabled = false,
            TelegramEnabled = false,
            NotifyOnStart = false,
            NotifyOnStop = false
        };
        var controller = CreateController(config);

        controller.UpdateConfiguration(new UpdateNotificationConfigurationRequest
        {
            NotificationsEnabled = true,
            TelegramEnabled = true
        });

        Assert.True(config.NotifyOnStart, "Start must be auto-enabled so real playback isn't silently dropped.");
        Assert.True(config.NotifyOnStop, "Stop must be auto-enabled so real playback isn't silently dropped.");
    }

    /// <summary>
    /// The auto-recovery above must never override an admin's own explicit choice made in the same
    /// request -- e.g. someone who wants only Completion notifications and explicitly unchecks
    /// Start/Stop in that same save.
    /// </summary>
    [Fact]
    public void UpdateConfiguration_ExplicitEventChoiceInSameRequest_IsNeverOverriddenByAutoRecovery()
    {
        var config = new PluginConfiguration
        {
            NotificationsEnabled = false,
            TelegramEnabled = false,
            NotifyOnStart = false,
            NotifyOnStop = false,
            NotifyOnCompletion = false
        };
        var controller = CreateController(config);

        controller.UpdateConfiguration(new UpdateNotificationConfigurationRequest
        {
            NotificationsEnabled = true,
            TelegramEnabled = true,
            NotifyOnStart = false,
            NotifyOnStop = false,
            NotifyOnCompletion = true
        });

        Assert.False(config.NotifyOnStart, "An explicit false in the same request must not be overridden.");
        Assert.False(config.NotifyOnStop, "An explicit false in the same request must not be overridden.");
        Assert.True(config.NotifyOnCompletion);
    }

    /// <summary>
    /// Auto-recovery only fires once notifications are actually active with a destination enabled
    /// -- saving event preferences alone (e.g. from the Preferences section, before Telegram/Discord
    /// is even configured) must not silently flip switches the admin never touched.
    /// </summary>
    [Fact]
    public void UpdateConfiguration_NoDestinationEnabled_DoesNotAutoEnableEvents()
    {
        var config = new PluginConfiguration
        {
            NotificationsEnabled = false,
            TelegramEnabled = false,
            DiscordEnabled = false,
            NotifyOnStart = false,
            NotifyOnStop = false
        };
        var controller = CreateController(config);

        controller.UpdateConfiguration(new UpdateNotificationConfigurationRequest { ProgressIntervalMinutes = 20 });

        Assert.False(config.NotifyOnStart);
        Assert.False(config.NotifyOnStop);
    }
}
