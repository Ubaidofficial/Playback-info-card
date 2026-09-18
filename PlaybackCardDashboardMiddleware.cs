using System;
using System.IO;
using System.IO.Compression;
using System.Text;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.PlaybackCard;

/// <summary>
/// ASP.NET Core middleware that serves dashboard client assets directly and
/// safely injects the Playback Info Card dashboard script into the Jellyfin Web
/// SPA index.html response in-memory.
/// Operates with 0% disk touching, ensuring full safety on read-only filesystems and containers.
/// </summary>
public class PlaybackCardDashboardMiddleware
{
    private readonly RequestDelegate _next;
    private readonly ILogger<PlaybackCardDashboardMiddleware> _logger;

    private const string DashboardScriptTag =
        "<link plugin=\"PlaybackCard\" rel=\"stylesheet\" href=\"/PlaybackCard/dashboard.css?v=0.2.7.3\" data-asset-revision=\"0.2.7.3\">\n" +
        "<script plugin=\"PlaybackCard\" version=\"0.2.7.3\" data-asset-revision=\"0.2.7.3\" src=\"/PlaybackCard/dashboard.js?v=0.2.7.3\" defer></script>\n";

    /// <summary>
    /// Initializes a new instance of the <see cref="PlaybackCardDashboardMiddleware"/> class.
    /// </summary>
    /// <param name="next">The next middleware in the pipeline.</param>
    /// <param name="logger">Logger instance.</param>
    public PlaybackCardDashboardMiddleware(RequestDelegate next, ILogger<PlaybackCardDashboardMiddleware> logger)
    {
        _next = next ?? throw new ArgumentNullException(nameof(next));
        _logger = logger ?? throw new ArgumentNullException(nameof(logger));
    }

    /// <summary>
    /// Executes the middleware pipeline operation.
    /// </summary>
    /// <param name="context">The HTTP context.</param>
    /// <returns>A task representing the asynchronous operation.</returns>
    public async Task InvokeAsync(HttpContext context)
    {
        ArgumentNullException.ThrowIfNull(context);

        var path = context.Request.Path.Value ?? string.Empty;

        // 1. Direct serving endpoint for dashboard.js
        if (path.EndsWith("/PlaybackCard/dashboard.js", StringComparison.OrdinalIgnoreCase) ||
            path.EndsWith("/PlaybackInfoCard/dashboard.js", StringComparison.OrdinalIgnoreCase) ||
            path.EndsWith("/web/playbackcard-dashboard.js", StringComparison.OrdinalIgnoreCase))
        {
            await ServeEmbeddedAssetAsync(context, "Jellyfin.Plugin.PlaybackCard.Web.dashboard.js", "application/javascript; charset=utf-8").ConfigureAwait(false);
            return;
        }

        // 2. Direct serving endpoint for dashboard.css
        if (path.EndsWith("/PlaybackCard/dashboard.css", StringComparison.OrdinalIgnoreCase) ||
            path.EndsWith("/PlaybackInfoCard/dashboard.css", StringComparison.OrdinalIgnoreCase) ||
            path.EndsWith("/web/playbackcard-dashboard.css", StringComparison.OrdinalIgnoreCase))
        {
            await ServeEmbeddedAssetAsync(context, "Jellyfin.Plugin.PlaybackCard.Web.dashboard.css", "text/css; charset=utf-8").ConfigureAwait(false);
            return;
        }

        // Fast path for non-HTML routes (API, images, videos, static js/css/fonts)
        var isHtmlTarget = path.EndsWith("index.html", StringComparison.OrdinalIgnoreCase) ||
                           path.Equals("/", StringComparison.OrdinalIgnoreCase) ||
                           path.Equals("/web", StringComparison.OrdinalIgnoreCase) ||
                           path.Equals("/web/", StringComparison.OrdinalIgnoreCase) ||
                           path.EndsWith("dashboard.html", StringComparison.OrdinalIgnoreCase);

        if (!isHtmlTarget)
        {
            await _next(context).ConfigureAwait(false);
            return;
        }

        // Strip conditional caching headers from request so downstream serves 200 OK full body
        context.Request.Headers.Remove("If-None-Match");
        context.Request.Headers.Remove("If-Modified-Since");
        context.Request.Headers.Remove("If-Range");

        var originalBodyStream = context.Response.Body;
        using var memoryStream = new MemoryStream();
        context.Response.Body = memoryStream;

        try
        {
            // Intentionally NOT wrapped in the try/catch below: this middleware's job is to
            // transform an already-successful HTML response, not to suppress genuine pipeline
            // failures. If the rest of the Jellyfin pipeline (auth, routing, MVC, etc.) throws,
            // that exception must propagate so ASP.NET Core's own error handling / status code
            // behavior applies, rather than being silently swallowed here.
            await _next(context).ConfigureAwait(false);
        }
        finally
        {
            // Always restore the real response stream, including when _next(context) throws,
            // so any outer exception handler writes to the actual client stream, not our buffer.
            context.Response.Body = originalBodyStream;
        }

        // From here on, _next(context) has completed successfully and the response is fully
        // buffered in memoryStream. This try/catch is narrowly scoped to the injection logic
        // itself (decode/inspect/rewrite/re-encode) so that a failure in OUR transformation
        // gracefully falls back to serving the original, unmodified response.
        try
        {
            memoryStream.Seek(0, SeekOrigin.Begin);

            var contentType = context.Response.ContentType ?? string.Empty;
            var isSuccessHtml = context.Response.StatusCode == StatusCodes.Status200OK &&
                                (contentType.Contains("text/html", StringComparison.OrdinalIgnoreCase) ||
                                 string.IsNullOrEmpty(contentType));

            if (isSuccessHtml && memoryStream.Length > 0)
            {
                var contentEncoding = context.Response.Headers.ContentEncoding.ToString();
                var isGzipped = contentEncoding.Contains("gzip", StringComparison.OrdinalIgnoreCase);
                var isBrotli = contentEncoding.Contains("br", StringComparison.OrdinalIgnoreCase);

                string html;
                if (isGzipped)
                {
                    using var decompressor = new GZipStream(memoryStream, CompressionMode.Decompress, leaveOpen: true);
                    using var reader = new StreamReader(decompressor, Encoding.UTF8);
                    html = await reader.ReadToEndAsync().ConfigureAwait(false);
                }
                else if (isBrotli)
                {
                    using var decompressor = new BrotliStream(memoryStream, CompressionMode.Decompress, leaveOpen: true);
                    using var reader = new StreamReader(decompressor, Encoding.UTF8);
                    html = await reader.ReadToEndAsync().ConfigureAwait(false);
                }
                else
                {
                    using var reader = new StreamReader(memoryStream, Encoding.UTF8, detectEncodingFromByteOrderMarks: true, leaveOpen: true);
                    html = await reader.ReadToEndAsync().ConfigureAwait(false);
                }

                if (html.Contains("</body>", StringComparison.OrdinalIgnoreCase) &&
                    !html.Contains("dashboard.js", StringComparison.OrdinalIgnoreCase))
                {
                    var modifiedHtml = html.Replace("</body>", DashboardScriptTag + "</body>", StringComparison.OrdinalIgnoreCase);
                    var modifiedBytes = Encoding.UTF8.GetBytes(modifiedHtml);

                    context.Response.Headers.Remove("Content-Encoding");
                    context.Response.Headers.Remove("Content-Length");
                    context.Response.Headers.Remove("ETag");
                    context.Response.Headers.Remove("Last-Modified");
                    context.Response.Headers.CacheControl = "no-cache, no-store, must-revalidate";
                    context.Response.Headers.Pragma = "no-cache";

                    if (isGzipped)
                    {
                        using var compressedStream = new MemoryStream();
                        using (var gzip = new GZipStream(compressedStream, CompressionLevel.Fastest, leaveOpen: true))
                        {
                            await gzip.WriteAsync(modifiedBytes).ConfigureAwait(false);
                        }

                        var compressedBytes = compressedStream.ToArray();
                        context.Response.Headers.ContentEncoding = "gzip";
                        context.Response.ContentLength = compressedBytes.Length;
                        await originalBodyStream.WriteAsync(compressedBytes).ConfigureAwait(false);
                        return;
                    }

                    if (isBrotli)
                    {
                        using var compressedStream = new MemoryStream();
                        using (var brotli = new BrotliStream(compressedStream, CompressionLevel.Fastest, leaveOpen: true))
                        {
                            await brotli.WriteAsync(modifiedBytes).ConfigureAwait(false);
                        }

                        var compressedBytes = compressedStream.ToArray();
                        context.Response.Headers.ContentEncoding = "br";
                        context.Response.ContentLength = compressedBytes.Length;
                        await originalBodyStream.WriteAsync(compressedBytes).ConfigureAwait(false);
                        return;
                    }

                    context.Response.ContentLength = modifiedBytes.Length;
                    await originalBodyStream.WriteAsync(modifiedBytes).ConfigureAwait(false);
                    return;
                }
            }

            // If not transformed, copy original stream verbatim
            memoryStream.Seek(0, SeekOrigin.Begin);
            await memoryStream.CopyToAsync(originalBodyStream).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "PlaybackCardDashboardMiddleware encountered an error during response inspection. Falling back to unmodified response.");
            if (memoryStream.CanSeek)
            {
                memoryStream.Seek(0, SeekOrigin.Begin);
                await memoryStream.CopyToAsync(originalBodyStream).ConfigureAwait(false);
            }
        }
    }

    private static async Task ServeEmbeddedAssetAsync(HttpContext context, string resourceName, string contentType)
    {
        var assembly = typeof(PlaybackCardDashboardMiddleware).Assembly;
        var stream = assembly.GetManifestResourceStream(resourceName);
        if (stream == null)
        {
            context.Response.StatusCode = StatusCodes.Status404NotFound;
            return;
        }

        using (stream)
        {
            context.Response.StatusCode = StatusCodes.Status200OK;
            context.Response.ContentType = contentType;
            context.Response.Headers.CacheControl = "no-cache, no-store, must-revalidate";
            context.Response.Headers.Pragma = "no-cache";
            await stream.CopyToAsync(context.Response.Body).ConfigureAwait(false);
        }
    }
}
