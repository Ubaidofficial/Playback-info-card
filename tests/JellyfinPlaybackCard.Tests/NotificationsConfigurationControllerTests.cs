using System;
using System.Collections.Generic;
using System.Security.Claims;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.PlaybackCard;
using Jellyfin.Plugin.PlaybackCard.Controllers;
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
}
