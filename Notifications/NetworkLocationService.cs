using System;
using System.Collections.Concurrent;
using System.Net;
using System.Net.Http;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.PlaybackCard.Notifications;

/// <summary>
/// Resolves a session's <c>RemoteEndPoint</c> into a safe display label -- "Local Network",
/// or "Remote" / "Remote — City, Country" for anything outside the server's own private
/// network -- without ever exposing the raw IP address to a caller. Strictly opt-in
/// (see <see cref="PluginConfiguration.NetworkLocationDisclosure"/>): this is the one part of
/// the plugin that calls an external service other than the user's own configured
/// Discord/Telegram endpoints, so it only ever runs when an administrator has explicitly
/// enabled it, and only looks up the one IP a session is actually using.
/// </summary>
public interface INetworkLocationService
{
    /// <summary>
    /// Resolves a session's remote endpoint into a safe label. Returns null if the endpoint
    /// can't be parsed. Never returns the raw IP address itself.
    /// </summary>
    Task<string?> ResolveLabelAsync(string? remoteEndPoint, CancellationToken cancellationToken);
}

/// <summary>
/// Default implementation: classifies local vs. remote purely offline (RFC 1918 / loopback /
/// link-local / IPv6 ULA ranges), and only calls out to a third-party geolocation API
/// (ipapi.co) for addresses it has classified as remote -- never for local ones, and results
/// are cached per IP so a session polled every few seconds doesn't repeat the same lookup.
/// </summary>
public sealed class NetworkLocationService : INetworkLocationService, IDisposable
{
    private static readonly TimeSpan CacheTtl = TimeSpan.FromHours(12);
    private static readonly TimeSpan NegativeCacheTtl = TimeSpan.FromMinutes(10);

    private readonly HttpClient _httpClient;
    private readonly bool _ownsClient;
    private readonly ILogger<NetworkLocationService> _logger;
    private readonly ConcurrentDictionary<string, (string? Label, DateTimeOffset Expiry)> _cache = new();

    public NetworkLocationService(ILogger<NetworkLocationService> logger, HttpClient? httpClient = null)
    {
        _logger = logger;
        if (httpClient != null)
        {
            _httpClient = httpClient;
            _ownsClient = false;
        }
        else
        {
            _httpClient = new HttpClient
            {
                Timeout = TimeSpan.FromSeconds(4)
            };
            _ownsClient = true;
        }
    }

    public void Dispose()
    {
        if (_ownsClient)
        {
            _httpClient.Dispose();
        }
    }

    /// <inheritdoc />
    public async Task<string?> ResolveLabelAsync(string? remoteEndPoint, CancellationToken cancellationToken)
    {
        var ip = ExtractIp(remoteEndPoint);
        if (string.IsNullOrEmpty(ip))
        {
            return null;
        }

        if (IsLocal(ip))
        {
            return "Local Network";
        }

        var now = DateTimeOffset.UtcNow;
        if (_cache.TryGetValue(ip, out var cached) && cached.Expiry > now)
        {
            return cached.Label ?? "Remote";
        }

        var label = await LookupGeoAsync(ip, cancellationToken).ConfigureAwait(false);
        _cache[ip] = (label, now.Add(label != null ? CacheTtl : NegativeCacheTtl));
        return label ?? "Remote";
    }

    /// <summary>
    /// Extracts the bare IP address from Jellyfin's "IP:port" (or "[IPv6]:port") RemoteEndPoint
    /// string. Returns null (never throws) on anything that doesn't parse cleanly.
    /// </summary>
    internal static string? ExtractIp(string? remoteEndPoint)
    {
        if (string.IsNullOrWhiteSpace(remoteEndPoint))
        {
            return null;
        }

        var trimmed = remoteEndPoint.Trim();

        if (IPEndPoint.TryParse(trimmed, out var endpoint))
        {
            return endpoint.Address.ToString();
        }

        // Bare IP with no port (IPEndPoint.TryParse requires a port for IPv4).
        if (IPAddress.TryParse(trimmed, out var address))
        {
            return address.ToString();
        }

        return null;
    }

    /// <summary>
    /// True for loopback, RFC 1918 private ranges, link-local, and IPv6 unique-local/link-local
    /// addresses -- i.e. anything that isn't routed over the public internet.
    /// </summary>
    internal static bool IsLocal(string ip)
    {
        if (!IPAddress.TryParse(ip, out var address))
        {
            return true; // Fail closed: never call out for something we can't even parse.
        }

        if (IPAddress.IsLoopback(address))
        {
            return true;
        }

        if (address.IsIPv4MappedToIPv6)
        {
            address = address.MapToIPv4();
        }

        var bytes = address.GetAddressBytes();

        if (address.AddressFamily == System.Net.Sockets.AddressFamily.InterNetwork)
        {
            // 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16 (link-local)
            if (bytes[0] == 10) return true;
            if (bytes[0] == 172 && bytes[1] >= 16 && bytes[1] <= 31) return true;
            if (bytes[0] == 192 && bytes[1] == 168) return true;
            if (bytes[0] == 169 && bytes[1] == 254) return true;
            return false;
        }

        if (address.AddressFamily == System.Net.Sockets.AddressFamily.InterNetworkV6)
        {
            if (address.IsIPv6LinkLocal) return true;
            // fc00::/7 -- unique local addresses
            if ((bytes[0] & 0xFE) == 0xFC) return true;
            return false;
        }

        return true; // Unknown address family: fail closed rather than guess "remote".
    }

    private async Task<string?> LookupGeoAsync(string ip, CancellationToken cancellationToken)
    {
        try
        {
            var uri = new Uri("https://ipapi.co/" + Uri.EscapeDataString(ip) + "/json/");
            using var response = await _httpClient.GetAsync(uri, cancellationToken).ConfigureAwait(false);
            if (!response.IsSuccessStatusCode)
            {
                return null;
            }

            var json = await response.Content.ReadAsStringAsync(cancellationToken).ConfigureAwait(false);
            using var doc = JsonDocument.Parse(json);
            var root = doc.RootElement;

            if (root.TryGetProperty("error", out _))
            {
                // ipapi.co reports rate-limit/invalid-IP errors this way rather than a non-2xx status.
                return null;
            }

            string? city = root.TryGetProperty("city", out var cityProp) && cityProp.ValueKind == JsonValueKind.String
                ? cityProp.GetString()
                : null;
            string? country = root.TryGetProperty("country_name", out var countryProp) && countryProp.ValueKind == JsonValueKind.String
                ? countryProp.GetString()
                : null;

            if (string.IsNullOrWhiteSpace(country))
            {
                return null;
            }

            return string.IsNullOrWhiteSpace(city) ? ("Remote — " + country) : ("Remote — " + city + ", " + country);
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or JsonException)
        {
            _logger.LogWarning("[NetworkLocationService] Geolocation lookup failed: {Error}", SecretRedactor.SanitizeExceptionMessage(ex));
            return null;
        }
    }
}
