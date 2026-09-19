using System.Net;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.PlaybackCard.Notifications;
using Xunit;

namespace JellyfinPlaybackCard.Tests;

/// <summary>
/// Covers the strictly opt-in network-location resolver: local/remote classification must be
/// correct offline (no network call for anything local), and the geolocation lookup path must
/// never leak the raw IP, must cache results, and must fail closed (never throw, never guess)
/// on anything ambiguous.
/// </summary>
public class NetworkLocationServiceTests
{
    [Theory]
    [InlineData("192.168.1.50:54321", "192.168.1.50")]
    [InlineData("10.0.0.5:1900", "10.0.0.5")]
    [InlineData("203.0.113.7:443", "203.0.113.7")]
    [InlineData("[::1]:8096", "::1")]
    [InlineData("127.0.0.1:8096", "127.0.0.1")]
    [InlineData("198.51.100.9", "198.51.100.9")]
    public void ExtractIp_ParsesCleanly(string remoteEndPoint, string expectedIp)
    {
        Assert.Equal(expectedIp, NetworkLocationService.ExtractIp(remoteEndPoint));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("not-an-ip")]
    [InlineData("999.999.999.999:80")]
    public void ExtractIp_ReturnsNullOnAnythingUnparsable(string? remoteEndPoint)
    {
        Assert.Null(NetworkLocationService.ExtractIp(remoteEndPoint));
    }

    [Theory]
    [InlineData("127.0.0.1")]
    [InlineData("10.0.0.1")]
    [InlineData("10.255.255.255")]
    [InlineData("172.16.0.1")]
    [InlineData("172.31.255.255")]
    [InlineData("192.168.0.1")]
    [InlineData("169.254.1.1")]
    [InlineData("::1")]
    [InlineData("fc00::1")]
    [InlineData("fe80::1")]
    public void IsLocal_TrueForPrivateAndLoopbackRanges(string ip)
    {
        Assert.True(NetworkLocationService.IsLocal(ip));
    }

    [Theory]
    [InlineData("8.8.8.8")]
    [InlineData("203.0.113.7")]
    [InlineData("172.32.0.1")] // just outside the 172.16.0.0/12 range
    [InlineData("2001:4860:4860::8888")]
    public void IsLocal_FalseForPublicAddresses(string ip)
    {
        Assert.False(NetworkLocationService.IsLocal(ip));
    }

    [Fact]
    public void IsLocal_FailsClosedOnUnparsableInput()
    {
        // Never guess "remote" for something we can't even parse as an address.
        Assert.True(NetworkLocationService.IsLocal("not-an-ip"));
    }

    [Fact]
    public async Task ResolveLabelAsync_LocalAddress_NeverCallsOutAndReturnsLocalNetwork()
    {
        var handler = new TestHttpMessageHandler();
        var httpClient = new HttpClient(handler);
        var service = new NetworkLocationService(new TestLogger<NetworkLocationService>(), httpClient);

        var label = await service.ResolveLabelAsync("192.168.1.50:1900", CancellationToken.None);

        Assert.Equal("Local Network", label);
        Assert.Empty(handler.CapturedRequests);
    }

    [Fact]
    public async Task ResolveLabelAsync_RemoteAddress_ReturnsCityAndCountry_NeverTheRawIp()
    {
        var handler = new TestHttpMessageHandler
        {
            HandlerFunc = (_, _) => Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent("{\"city\":\"Lahore\",\"country_name\":\"Pakistan\"}")
            })
        };
        var httpClient = new HttpClient(handler);
        var service = new NetworkLocationService(new TestLogger<NetworkLocationService>(), httpClient);

        var label = await service.ResolveLabelAsync("203.0.113.7:443", CancellationToken.None);

        Assert.Equal("Remote — Lahore, Pakistan", label);
        Assert.Single(handler.CapturedRequests);
        Assert.DoesNotContain("203.0.113.7", label);
    }

    [Fact]
    public async Task ResolveLabelAsync_CachesRemoteLookups_DoesNotRepeatTheHttpCall()
    {
        var handler = new TestHttpMessageHandler
        {
            HandlerFunc = (_, _) => Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent("{\"city\":\"Berlin\",\"country_name\":\"Germany\"}")
            })
        };
        var httpClient = new HttpClient(handler);
        var service = new NetworkLocationService(new TestLogger<NetworkLocationService>(), httpClient);

        var first = await service.ResolveLabelAsync("198.51.100.9:443", CancellationToken.None);
        var second = await service.ResolveLabelAsync("198.51.100.9:443", CancellationToken.None);

        Assert.Equal(first, second);
        Assert.Single(handler.CapturedRequests); // second call served from cache
    }

    [Fact]
    public async Task ResolveLabelAsync_ApiErrorField_FailsClosedToGenericRemote()
    {
        var handler = new TestHttpMessageHandler
        {
            HandlerFunc = (_, _) => Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent("{\"error\":true,\"reason\":\"RateLimited\"}")
            })
        };
        var httpClient = new HttpClient(handler);
        var service = new NetworkLocationService(new TestLogger<NetworkLocationService>(), httpClient);

        var label = await service.ResolveLabelAsync("203.0.113.7:443", CancellationToken.None);

        Assert.Equal("Remote", label);
    }

    [Fact]
    public async Task ResolveLabelAsync_HttpFailure_NeverThrows_FailsClosedToGenericRemote()
    {
        var handler = new TestHttpMessageHandler
        {
            HandlerFunc = (_, _) => Task.FromResult(new HttpResponseMessage(HttpStatusCode.ServiceUnavailable))
        };
        var httpClient = new HttpClient(handler);
        var service = new NetworkLocationService(new TestLogger<NetworkLocationService>(), httpClient);

        var label = await service.ResolveLabelAsync("203.0.113.7:443", CancellationToken.None);

        Assert.Equal("Remote", label);
    }

    [Fact]
    public async Task ResolveLabelAsync_UnparsableEndpoint_ReturnsNull()
    {
        var handler = new TestHttpMessageHandler();
        var httpClient = new HttpClient(handler);
        var service = new NetworkLocationService(new TestLogger<NetworkLocationService>(), httpClient);

        var label = await service.ResolveLabelAsync("garbage", CancellationToken.None);

        Assert.Null(label);
        Assert.Empty(handler.CapturedRequests);
    }
}
