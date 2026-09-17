using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using System.Security.Claims;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.PlaybackCard;
using Jellyfin.Plugin.PlaybackCard.Controllers;
using Jellyfin.Plugin.PlaybackCard.Notifications;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Session;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.Session;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Xunit;

namespace JellyfinPlaybackCard.Tests;

public class MockDeliveryService : INotificationDeliveryService
{
    public Func<string, Task<DeliveryResult>>? OnSendTest { get; set; }
    public void Enqueue(PlaybackEventRecord record) { }
    public Task<DeliveryResult> SendTestNotificationAsync(string destination, CancellationToken cancellationToken)
    {
        if (OnSendTest != null) return OnSendTest(destination);
        return Task.FromResult(DeliveryResult.Ok());
    }
    public NotificationDiagnosticsSnapshot GetDiagnostics() => new();
    public Task StartAsync(CancellationToken cancellationToken) => Task.CompletedTask;
    public Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;
}

public class MockSecretStore : INotificationSecretStore
{
    public string DiscordWebhookUrl { get; set; } = "";
    public string TelegramBotToken { get; set; } = "";

    public string GetDiscordWebhookUrl() => DiscordWebhookUrl;
    public void SetDiscordWebhookUrl(string url) => DiscordWebhookUrl = url;
    public string GetTelegramBotToken() => TelegramBotToken;
    public void SetTelegramBotToken(string token) => TelegramBotToken = token;
    public void ClearDiscordWebhookUrl() => DiscordWebhookUrl = "";
    public void ClearTelegramBotToken() => TelegramBotToken = "";
    public void ClearAll() { DiscordWebhookUrl = ""; TelegramBotToken = ""; }
    public IReadOnlyList<string> GetConfiguredSecrets()
    {
        var list = new List<string>();
        if (!string.IsNullOrEmpty(DiscordWebhookUrl)) list.Add(DiscordWebhookUrl);
        if (!string.IsNullOrEmpty(TelegramBotToken)) list.Add(TelegramBotToken);
        return list;
    }
    public void Reload() { }
}

public class MockSessionManagerProxy : DispatchProxy
{
    public IEnumerable<SessionInfo> Sessions { get; set; } = Enumerable.Empty<SessionInfo>();

    protected override object? Invoke(MethodInfo? targetMethod, object?[]? args)
    {
        if (targetMethod?.Name == "get_Sessions")
        {
            return Sessions;
        }
        return null;
    }

    public static ISessionManager Create(IEnumerable<SessionInfo> sessions)
    {
        var proxy = Create<ISessionManager, MockSessionManagerProxy>();
        ((MockSessionManagerProxy)(object)proxy).Sessions = sessions;
        return proxy;
    }
}

public class PlaybackSelfSessionsControllerTests
{
    private static ControllerContext CreateContextForUser(Guid? userId, bool isAdministrator = false)
    {
        var claims = new List<Claim>();
        if (userId.HasValue)
        {
            claims.Add(new Claim("Jellyfin-UserId", userId.Value.ToString()));
            if (isAdministrator)
            {
                claims.Add(new Claim("IsAdministrator", "true"));
                claims.Add(new Claim(ClaimTypes.Role, "Administrator"));
            }
        }

        var identity = new ClaimsIdentity(claims, userId.HasValue ? "TestAuth" : null);
        var principal = new ClaimsPrincipal(identity);

        return new ControllerContext
        {
            HttpContext = new DefaultHttpContext
            {
                User = principal
            }
        };
    }

    [Fact]
    public void GetSelfSessions_WhenUnauthenticated_ReturnsUnauthorized401()
    {
        var sessionManager = MockSessionManagerProxy.Create(Enumerable.Empty<SessionInfo>());
        var controller = new PlaybackSelfSessionsController(sessionManager)
        {
            ControllerContext = CreateContextForUser(null)
        };

        var result = controller.GetSelfSessions();
        var unauthorized = Assert.IsType<UnauthorizedObjectResult>(result.Result);
        Assert.Equal(StatusCodes.Status401Unauthorized, unauthorized.StatusCode);
    }

    [Fact]
    public void GetSelfSessions_FiltersStrictlyByAuthenticatedUserIdAndActiveSession()
    {
        var userA = Guid.NewGuid();
        var userB = Guid.NewGuid();

        var activeItemA = new BaseItemDto { Id = Guid.NewGuid(), Name = "Movie User A", RunTimeTicks = TimeSpan.FromHours(2).Ticks };
        var activeItemB = new BaseItemDto { Id = Guid.NewGuid(), Name = "Movie User B", RunTimeTicks = TimeSpan.FromHours(2).Ticks };

        var sessions = new List<SessionInfo>
        {
            new(null, null)
            {
                Id = "sess-active-A",
                UserId = userA,
                UserName = "UserA",
                NowPlayingItem = activeItemA,
                PlayState = new PlayerStateInfo { PlayMethod = PlayMethod.DirectPlay, PositionTicks = TimeSpan.FromMinutes(10).Ticks }
            },
            new(null, null)
            {
                Id = "sess-idle-A",
                UserId = userA,
                UserName = "UserA",
                NowPlayingItem = null, // Inactive / idle
                PlayState = new PlayerStateInfo()
            },
            new(null, null)
            {
                Id = "sess-active-B",
                UserId = userB,
                UserName = "UserB",
                NowPlayingItem = activeItemB,
                PlayState = new PlayerStateInfo { PlayMethod = PlayMethod.DirectPlay }
            }
        };

        var sessionManager = MockSessionManagerProxy.Create(sessions);
        var controller = new PlaybackSelfSessionsController(sessionManager)
        {
            ControllerContext = CreateContextForUser(userA)
        };

        var response = controller.GetSelfSessions();
        var okResult = Assert.IsType<OkObjectResult>(response.Result);
        var returnedSessions = Assert.IsAssignableFrom<IReadOnlyList<UserPlaybackSessionDto>>(okResult.Value);

        Assert.Single(returnedSessions);
        var sessionDto = returnedSessions[0];
        Assert.Equal("Movie User A", sessionDto.MediaTitle);
        Assert.Equal("DirectPlay", sessionDto.PlayMethod);
        Assert.True(sessionDto.IsVideoDirect);
        Assert.True(sessionDto.IsAudioDirect);
        Assert.Equal("Video Direct", sessionDto.VideoStatus);
        Assert.Equal("Audio Direct", sessionDto.AudioStatus);
    }

    [Fact]
    public void GetSelfSessions_MapsTranscodeReasonsWhy_AndRemuxStatus()
    {
        var user = Guid.NewGuid();
        var item = new BaseItemDto { Id = Guid.NewGuid(), Name = "Transcoded Movie", Container = "avi" };

        var session = new SessionInfo(null, null)
        {
            Id = "sess-transcode",
            UserId = user,
            NowPlayingItem = item,
            PlayState = new PlayerStateInfo { PlayMethod = PlayMethod.Transcode, PositionTicks = 0 },
            TranscodingInfo = new TranscodingInfo
            {
                IsVideoDirect = false,
                IsAudioDirect = true,
                VideoCodec = "h264",
                AudioCodec = "aac",
                Container = "mp4",
                HardwareAccelerationType = HardwareEncodingType.NVENC,
                TranscodeReasons = TranscodeReason.ContainerNotSupported | TranscodeReason.VideoCodecNotSupported
            }
        };

        var sessionManager = MockSessionManagerProxy.Create(new[] { session });
        var controller = new PlaybackSelfSessionsController(sessionManager)
        {
            ControllerContext = CreateContextForUser(user)
        };

        var response = controller.GetSelfSessions();
        var okResult = Assert.IsType<OkObjectResult>(response.Result);
        var returnedSessions = Assert.IsAssignableFrom<IReadOnlyList<UserPlaybackSessionDto>>(okResult.Value);

        Assert.Single(returnedSessions);
        var dto = returnedSessions[0];
        Assert.Equal("Transcode", dto.PlayMethod);
        Assert.False(dto.IsVideoDirect);
        Assert.True(dto.IsAudioDirect);
        Assert.Equal("Video Transcoded", dto.VideoStatus);
        Assert.Equal("Audio Direct", dto.AudioStatus);
        Assert.Equal("NVENC", dto.TranscodeEngine);
        Assert.Contains("Container unsupported", dto.TranscodeReasonsWhy);
        Assert.Contains("Video codec unsupported", dto.TranscodeReasonsWhy);
    }

    [Fact]
    public void GetSelfSessions_ValidJellyfinUserId_ReturnsOk()
    {
        var targetUser = Guid.NewGuid();
        var item = new BaseItemDto { Id = Guid.NewGuid(), Name = "Movie For Claim Test" };
        var session = new SessionInfo(null, null)
        {
            Id = "sess-claim",
            UserId = targetUser,
            NowPlayingItem = item,
            PlayState = new PlayerStateInfo { PlayMethod = PlayMethod.DirectPlay }
        };

        var sessionManager = MockSessionManagerProxy.Create(new[] { session });
        var controller = new PlaybackSelfSessionsController(sessionManager)
        {
            ControllerContext = CreateContextForUser(targetUser)
        };

        var result = controller.GetSelfSessions();
        var okResult = Assert.IsType<OkObjectResult>(result.Result);
        var returnedSessions = Assert.IsAssignableFrom<IReadOnlyList<UserPlaybackSessionDto>>(okResult.Value);
        Assert.Single(returnedSessions);
        Assert.Equal("Movie For Claim Test", returnedSessions[0].MediaTitle);
    }

    [Fact]
    public void GetSelfSessions_MissingJellyfinUserId_ReturnsUnauthorized401()
    {
        var sessionManager = MockSessionManagerProxy.Create(Enumerable.Empty<SessionInfo>());
        // Authenticated identity but with generic NameIdentifier claim only, NO Jellyfin-UserId
        var claims = new List<Claim> { new(ClaimTypes.NameIdentifier, Guid.NewGuid().ToString()) };
        var identity = new ClaimsIdentity(claims, "TestAuth");
        var principal = new ClaimsPrincipal(identity);

        var controller = new PlaybackSelfSessionsController(sessionManager)
        {
            ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext { User = principal } }
        };

        var result = controller.GetSelfSessions();
        var unauthorized = Assert.IsType<UnauthorizedObjectResult>(result.Result);
        Assert.Equal(StatusCodes.Status401Unauthorized, unauthorized.StatusCode);
    }

    [Theory]
    [InlineData("not-a-guid")]
    [InlineData("00000000-0000-0000-0000-000000000000")]
    [InlineData("")]
    public void GetSelfSessions_InvalidJellyfinUserId_ReturnsUnauthorized401(string invalidValue)
    {
        var sessionManager = MockSessionManagerProxy.Create(Enumerable.Empty<SessionInfo>());
        var claims = new List<Claim> { new("Jellyfin-UserId", invalidValue) };
        var identity = new ClaimsIdentity(claims, "TestAuth");
        var principal = new ClaimsPrincipal(identity);

        var controller = new PlaybackSelfSessionsController(sessionManager)
        {
            ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext { User = principal } }
        };

        var result = controller.GetSelfSessions();
        var unauthorized = Assert.IsType<UnauthorizedObjectResult>(result.Result);
        Assert.Equal(StatusCodes.Status401Unauthorized, unauthorized.StatusCode);
    }

    [Fact]
    public void GetSelfSessions_ConflictingJellyfinUserIdAndSubClaims_UsesJellyfinUserIdExclusively()
    {
        var officialUser = Guid.NewGuid();
        var fakeSubUser = Guid.NewGuid();

        var itemOfficial = new BaseItemDto { Id = Guid.NewGuid(), Name = "Official User Movie" };
        var itemFake = new BaseItemDto { Id = Guid.NewGuid(), Name = "Fake Sub Movie" };

        var sessions = new List<SessionInfo>
        {
            new(null, null) { Id = "s1", UserId = officialUser, NowPlayingItem = itemOfficial },
            new(null, null) { Id = "s2", UserId = fakeSubUser, NowPlayingItem = itemFake }
        };

        var sessionManager = MockSessionManagerProxy.Create(sessions);
        var claims = new List<Claim>
        {
            new("Jellyfin-UserId", officialUser.ToString()),
            new("sub", fakeSubUser.ToString()),
            new(ClaimTypes.NameIdentifier, fakeSubUser.ToString()),
            new("UserId", fakeSubUser.ToString())
        };
        var identity = new ClaimsIdentity(claims, "TestAuth");
        var principal = new ClaimsPrincipal(identity);

        var controller = new PlaybackSelfSessionsController(sessionManager)
        {
            ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext { User = principal } }
        };

        var result = controller.GetSelfSessions();
        var okResult = Assert.IsType<OkObjectResult>(result.Result);
        var returnedSessions = Assert.IsAssignableFrom<IReadOnlyList<UserPlaybackSessionDto>>(okResult.Value);
        Assert.Single(returnedSessions);
        Assert.Equal("Official User Movie", returnedSessions[0].MediaTitle);
    }

    [Fact]
    public void GetSelfSessions_CrossUserIsolation_NeverReturnsOtherUserSessions()
    {
        var userAlice = Guid.NewGuid();
        var userBob = Guid.NewGuid();

        var sessions = new List<SessionInfo>
        {
            new(null, null) { Id = "s1", UserId = userBob, NowPlayingItem = new BaseItemDto { Name = "Bob Private Stream" } }
        };

        var sessionManager = MockSessionManagerProxy.Create(sessions);
        var controller = new PlaybackSelfSessionsController(sessionManager)
        {
            ControllerContext = CreateContextForUser(userAlice)
        };

        var result = controller.GetSelfSessions();
        var okResult = Assert.IsType<OkObjectResult>(result.Result);
        var returnedSessions = Assert.IsAssignableFrom<IReadOnlyList<UserPlaybackSessionDto>>(okResult.Value);
        Assert.Empty(returnedSessions); // Alice must see ZERO sessions belonging to Bob
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public void GetSelfSessions_AccessibleByBothAdminAndNonAdmin(bool isAdmin)
    {
        var user = Guid.NewGuid();
        var sessions = new List<SessionInfo>
        {
            new(null, null) { Id = "s1", UserId = user, NowPlayingItem = new BaseItemDto { Name = "User Movie" } }
        };

        var sessionManager = MockSessionManagerProxy.Create(sessions);
        var controller = new PlaybackSelfSessionsController(sessionManager)
        {
            ControllerContext = CreateContextForUser(user, isAdministrator: isAdmin)
        };

        var result = controller.GetSelfSessions();
        var okResult = Assert.IsType<OkObjectResult>(result.Result);
        var returnedSessions = Assert.IsAssignableFrom<IReadOnlyList<UserPlaybackSessionDto>>(okResult.Value);
        Assert.Single(returnedSessions);
    }

    [Fact]
    public void NotificationsConfigurationController_AdminOnly_RejectsNonAdminWith403()
    {
        var nonAdminUser = Guid.NewGuid();
        var controller = new NotificationsConfigurationController(new MockDeliveryService(), new MockSecretStore())
        {
            ControllerContext = CreateContextForUser(nonAdminUser, isAdministrator: false)
        };

        var configResult = controller.GetConfiguration();
        Assert.IsType<ForbidResult>(configResult.Result);

        var diagResult = controller.GetDiagnostics();
        Assert.IsType<ForbidResult>(diagResult.Result);
    }

    [Fact]
    public void NotificationsConfigurationController_AllowsAdministrator()
    {
        var adminUser = Guid.NewGuid();
        var controller = new NotificationsConfigurationController(new MockDeliveryService(), new MockSecretStore())
        {
            ControllerContext = CreateContextForUser(adminUser, isAdministrator: true)
        };

        var configResult = controller.GetConfiguration();
        Assert.IsType<OkObjectResult>(configResult.Result);

        var diagResult = controller.GetDiagnostics();
        Assert.IsType<OkObjectResult>(diagResult.Result);
    }

    [Fact]
    public void NotificationsConfigurationController_UpdateConfiguration_PreservesExistingSecrets_WhenBlank()
    {
        var adminUser = Guid.NewGuid();
        var secretStore = new MockSecretStore
        {
            DiscordWebhookUrl = "https://discord.com/api/webhooks/123/initialDiscordToken",
            TelegramBotToken = "12345:initialTelegramToken"
        };
        var config = new PluginConfiguration();
        var controller = new NotificationsConfigurationController(new MockDeliveryService(), secretStore, config)
        {
            ControllerContext = CreateContextForUser(adminUser, isAdministrator: true)
        };

        var request = new UpdateNotificationConfigurationRequest
        {
            NotificationsEnabled = true,
            DiscordEnabled = true,
            TelegramEnabled = true,
            DiscordWebhookUrl = "", // Blank
            TelegramBotToken = null, // Null
            TelegramChatId = "-100123456789"
        };

        var response = controller.UpdateConfiguration(request);
        var okResult = Assert.IsType<OkObjectResult>(response.Result);
        var dto = Assert.IsType<NotificationConfigurationDto>(okResult.Value);

        // Verify existing secrets were NOT overwritten or lost
        Assert.Equal("https://discord.com/api/webhooks/123/initialDiscordToken", secretStore.GetDiscordWebhookUrl());
        Assert.Equal("12345:initialTelegramToken", secretStore.GetTelegramBotToken());
        Assert.True(dto.HasDiscordWebhook);
        Assert.True(dto.HasTelegramBotToken);
    }

    [Fact]
    public void NotificationsConfigurationController_UpdateConfiguration_UpdatesSecrets_WhenValid()
    {
        var adminUser = Guid.NewGuid();
        var secretStore = new MockSecretStore();
        var config = new PluginConfiguration();
        var controller = new NotificationsConfigurationController(new MockDeliveryService(), secretStore, config)
        {
            ControllerContext = CreateContextForUser(adminUser, isAdministrator: true)
        };

        var request = new UpdateNotificationConfigurationRequest
        {
            NotificationsEnabled = true,
            DiscordEnabled = true,
            TelegramEnabled = true,
            DiscordWebhookUrl = "https://discord.com/api/webhooks/987654321/newSecretDiscordToken",
            TelegramBotToken = "98765:newSecretTelegramToken",
            TelegramChatId = "-100987654321"
        };

        var response = controller.UpdateConfiguration(request);
        var okResult = Assert.IsType<OkObjectResult>(response.Result);
        var dto = Assert.IsType<NotificationConfigurationDto>(okResult.Value);

        Assert.Equal("https://discord.com/api/webhooks/987654321/newSecretDiscordToken", secretStore.GetDiscordWebhookUrl());
        Assert.Equal("98765:newSecretTelegramToken", secretStore.GetTelegramBotToken());
        Assert.True(dto.HasDiscordWebhook);
        Assert.True(dto.HasTelegramBotToken);
        Assert.Equal("-100987654321", dto.TelegramChatId);
    }

    [Fact]
    public void NotificationsConfigurationController_UpdateConfiguration_ClearsSecrets_WhenClearFlag()
    {
        var adminUser = Guid.NewGuid();
        var secretStore = new MockSecretStore
        {
            DiscordWebhookUrl = "https://discord.com/api/webhooks/123/token",
            TelegramBotToken = "123:token"
        };
        var config = new PluginConfiguration();
        var controller = new NotificationsConfigurationController(new MockDeliveryService(), secretStore, config)
        {
            ControllerContext = CreateContextForUser(adminUser, isAdministrator: true)
        };

        var request = new UpdateNotificationConfigurationRequest
        {
            ClearDiscordWebhook = true,
            ClearTelegramBotToken = true
        };

        var response = controller.UpdateConfiguration(request);
        Assert.IsType<OkObjectResult>(response.Result);

        Assert.Empty(secretStore.GetDiscordWebhookUrl());
        Assert.Empty(secretStore.GetTelegramBotToken());
    }

    [Fact]
    public void NotificationsConfigurationController_UpdateConfiguration_RejectsInvalidDiscordWebhook_WithBadRequest()
    {
        var adminUser = Guid.NewGuid();
        var secretStore = new MockSecretStore();
        var config = new PluginConfiguration();
        var controller = new NotificationsConfigurationController(new MockDeliveryService(), secretStore, config)
        {
            ControllerContext = CreateContextForUser(adminUser, isAdministrator: true)
        };

        var request = new UpdateNotificationConfigurationRequest
        {
            DiscordWebhookUrl = "http://evil-insecure-site.com/hook"
        };

        var response = controller.UpdateConfiguration(request);
        var badRequest = Assert.IsType<BadRequestObjectResult>(response.Result);
        Assert.Equal(StatusCodes.Status400BadRequest, badRequest.StatusCode);
    }

    [Fact]
    public void NotificationsConfigurationController_UpdateConfiguration_RejectsInvalidTelegramToken_WithBadRequest()
    {
        var adminUser = Guid.NewGuid();
        var secretStore = new MockSecretStore();
        var config = new PluginConfiguration();
        var controller = new NotificationsConfigurationController(new MockDeliveryService(), secretStore, config)
        {
            ControllerContext = CreateContextForUser(adminUser, isAdministrator: true)
        };

        var request = new UpdateNotificationConfigurationRequest
        {
            TelegramBotToken = "invalid_token_no_colon"
        };

        var response = controller.UpdateConfiguration(request);
        var badRequest = Assert.IsType<BadRequestObjectResult>(response.Result);
        Assert.Equal(StatusCodes.Status400BadRequest, badRequest.StatusCode);
    }

    [Fact]
    public void NotificationsConfigurationController_UpdateConfiguration_PartialSave_PreservesOtherSections()
    {
        var adminUser = Guid.NewGuid();
        var secretStore = new MockSecretStore
        {
            DiscordWebhookUrl = "https://discord.com/api/webhooks/123/existingDiscordToken"
        };
        var config = new PluginConfiguration
        {
            NotificationsEnabled = true,
            DiscordEnabled = true,
            NotifyOnStart = true,
            NotifyOnStop = true,
            ProgressIntervalMinutes = 20
        };

        var controller = new NotificationsConfigurationController(new MockDeliveryService(), secretStore, config)
        {
            ControllerContext = CreateContextForUser(adminUser, isAdministrator: true)
        };

        // User saves ONLY Telegram section
        var request = new UpdateNotificationConfigurationRequest
        {
            TelegramEnabled = true,
            TelegramBotToken = "99999:validTelegramToken",
            TelegramChatId = "-100123456789"
        };

        var response = controller.UpdateConfiguration(request);
        var okResult = Assert.IsType<OkObjectResult>(response.Result);
        var dto = Assert.IsType<NotificationConfigurationDto>(okResult.Value);

        // Verify Telegram settings applied
        Assert.True(config.TelegramEnabled);
        Assert.True(dto.TelegramEnabled);
        Assert.Equal("-100123456789", config.TelegramChatId);

        // Verify other sections were NOT clobbered or reset to false/defaults
        Assert.True(config.NotificationsEnabled);
        Assert.True(dto.NotificationsEnabled);
        Assert.True(dto.Enabled);
        Assert.True(config.DiscordEnabled);
        Assert.True(dto.DiscordEnabled);
        Assert.True(config.NotifyOnStart);
        Assert.True(dto.NotifyOnStart);
        Assert.True(config.NotifyOnStop);
        Assert.True(dto.NotifyOnStop);
        Assert.Equal(20, config.ProgressIntervalMinutes);
        Assert.Equal(20, dto.ProgressIntervalMinutes);

        // Verify existing Discord secret in store is preserved
        Assert.Equal("https://discord.com/api/webhooks/123/existingDiscordToken", secretStore.GetDiscordWebhookUrl());
    }

    [Fact]
    public void NotificationsConfigurationController_Routes_MappedCorrectlyWithDualAliases()
    {
        var type = typeof(NotificationsConfigurationController);
        var routeAttributes = type.GetCustomAttributes(typeof(RouteAttribute), false)
            .Cast<RouteAttribute>()
            .Select(r => r.Template)
            .ToList();

        Assert.Contains("PlaybackCard/Notifications", routeAttributes);
        Assert.Contains("PlaybackInfoCard/Notifications", routeAttributes);
    }

    [Fact]
    public void PlaybackSelfSessionsController_Routes_MappedCorrectlyWithDualAliases()
    {
        var type = typeof(PlaybackSelfSessionsController);
        var routeAttributes = type.GetCustomAttributes(typeof(RouteAttribute), false)
            .Cast<RouteAttribute>()
            .Select(r => r.Template)
            .ToList();

        Assert.Contains("PlaybackCard/Self", routeAttributes);
        Assert.Contains("PlaybackInfoCard/Self", routeAttributes);
    }

    [Fact]
    public async Task NotificationsConfigurationController_SendTestNotification_ReturnsDescriptiveFailure_WhenMissingDestination()
    {
        var adminUser = Guid.NewGuid();
        var controller = new NotificationsConfigurationController(new MockDeliveryService(), new MockSecretStore())
        {
            ControllerContext = CreateContextForUser(adminUser, isAdministrator: true)
        };

        var response = await controller.SendTestNotification(new SendTestNotificationRequest { Destination = "" });
        var badRequest = Assert.IsType<BadRequestObjectResult>(response.Result);
        var delivery = Assert.IsType<DeliveryResult>(badRequest.Value);

        Assert.False(delivery.Success);
        Assert.Equal("InvalidConfiguration", delivery.Category);
        Assert.Equal(StatusCodes.Status400BadRequest, delivery.StatusCode);
        Assert.NotNull(delivery.Description);
        Assert.Contains("Missing destination", delivery.Description);
    }

    [Fact]
    public async Task NotificationsConfigurationController_SendTestNotification_ReturnsResultFromDeliveryService()
    {
        var adminUser = Guid.NewGuid();
        var mockService = new MockDeliveryService
        {
            OnSendTest = dest => Task.FromResult(DeliveryResult.Failed("Unauthorized", 401, permanent: true, description: "Invalid bot token"))
        };
        var controller = new NotificationsConfigurationController(mockService, new MockSecretStore())
        {
            ControllerContext = CreateContextForUser(adminUser, isAdministrator: true)
        };

        var response = await controller.SendTestNotification(new SendTestNotificationRequest { Destination = "Telegram" });
        var okResult = Assert.IsType<OkObjectResult>(response.Result);
        var delivery = Assert.IsType<DeliveryResult>(okResult.Value);

        Assert.False(delivery.Success);
        Assert.Equal("Unauthorized", delivery.Category);
        Assert.Equal(401, delivery.StatusCode);
        Assert.Equal("Invalid bot token", delivery.Description);
    }

    [Fact]
    public void UserPlaybackSessionDto_ReflectionAudit_ZeroForbiddenFields()
    {
        var forbiddenTerms = new[]
        {
            "Id",
            "SessionId",
            "PlaySessionId",
            "RemoteEndPoint",
            "RemoteEndpoint",
            "IpAddress",
            "IPAddress",
            "ip_address",
            "ClientIp",
            "Endpoint",
            "Lan",
            "Wan",
            "Cellular",
            "Wifi",
            "UserToken",
            "Password",
            "FilePath",
            "LocalPath",
            "Path"
        };

        var type = typeof(UserPlaybackSessionDto);
        foreach (var prop in type.GetProperties(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance))
        {
            foreach (var forbidden in forbiddenTerms)
            {
                Assert.False(
                    prop.Name.Equals(forbidden, StringComparison.OrdinalIgnoreCase),
                    $"Forbidden field '{prop.Name}' found on UserPlaybackSessionDto."
                );
            }
        }
    }
}
