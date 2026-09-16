using System;
using System.IO;
using System.IO.Compression;
using System.Text;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Http;

namespace Jellyfin.Plugin.PlaybackCard;

/// <summary>
/// Middleware that dynamically injects the Playback Info Card client script into the Jellyfin Web index.html response in-memory.
/// Works across Docker, Kubernetes, and bare metal without requiring disk write permissions.
/// </summary>
public class PlaybackCardMiddleware
{
    private readonly RequestDelegate _next;
    private const string ScriptTag = "<script plugin=\"PlaybackCard\" version=\"0.2.4.0\" src=\"configurationpage?name=playbackcard.js\" defer></script>";

    /// <summary>
    /// Initializes a new instance of the <see cref="PlaybackCardMiddleware"/> class.
    /// </summary>
    /// <param name="next">The next request delegate in the ASP.NET Core pipeline.</param>
    public PlaybackCardMiddleware(RequestDelegate next)
    {
        _next = next;
    }

    /// <summary>
    /// Invokes the middleware to inspect and transform HTML responses.
    /// </summary>
    /// <param name="context">The HTTP context.</param>
    /// <returns>A task representing the asynchronous operation.</returns>
    public async Task InvokeAsync(HttpContext context)
    {
        ArgumentNullException.ThrowIfNull(context);

        var path = context.Request.Path.Value ?? string.Empty;

        // 1. Direct serving endpoint for playbackcard.js
        if (path.EndsWith("/playbackcard.js", StringComparison.OrdinalIgnoreCase) ||
            (path.Contains("configurationpage", StringComparison.OrdinalIgnoreCase) &&
             context.Request.Query.TryGetValue("name", out var scriptName) &&
             string.Equals(scriptName, "playbackcard.js", StringComparison.OrdinalIgnoreCase)))
        {
            var assembly = typeof(PlaybackCardMiddleware).Assembly;
            var resourceStream = assembly.GetManifestResourceStream("Jellyfin.Plugin.PlaybackCard.Web.playbackcard.js");
            if (resourceStream != null)
            {
                using (resourceStream)
                {
                    context.Response.StatusCode = StatusCodes.Status200OK;
                    context.Response.ContentType = "application/javascript; charset=utf-8";
                    context.Response.Headers.CacheControl = "no-cache, no-store, must-revalidate";
                    context.Response.Headers.Pragma = "no-cache";
                    await resourceStream.CopyToAsync(context.Response.Body).ConfigureAwait(false);
                    return;
                }
            }
        }

        // 2. Direct serving endpoint for playbackcard.css
        if (path.EndsWith("/playbackcard.css", StringComparison.OrdinalIgnoreCase) ||
            (path.Contains("configurationpage", StringComparison.OrdinalIgnoreCase) &&
             context.Request.Query.TryGetValue("name", out var cssName) &&
             string.Equals(cssName, "playbackcard.css", StringComparison.OrdinalIgnoreCase)))
        {
            var assembly = typeof(PlaybackCardMiddleware).Assembly;
            var resourceStream = assembly.GetManifestResourceStream("Jellyfin.Plugin.PlaybackCard.Web.playbackcard.css");
            if (resourceStream != null)
            {
                using (resourceStream)
                {
                    context.Response.StatusCode = StatusCodes.Status200OK;
                    context.Response.ContentType = "text/css; charset=utf-8";
                    context.Response.Headers.CacheControl = "no-cache, no-store, must-revalidate";
                    context.Response.Headers.Pragma = "no-cache";
                    await resourceStream.CopyToAsync(context.Response.Body).ConfigureAwait(false);
                    return;
                }
            }
        }

        // Fast path for non-HTML routes
        var isHtmlTarget = path.EndsWith("index.html", StringComparison.OrdinalIgnoreCase) ||
                           path.Equals("/", StringComparison.OrdinalIgnoreCase) ||
                           path.Equals("/web", StringComparison.OrdinalIgnoreCase) ||
                           path.Equals("/web/", StringComparison.OrdinalIgnoreCase) ||
                           path.EndsWith(".html", StringComparison.OrdinalIgnoreCase);

        if (!isHtmlTarget)
        {
            await _next(context).ConfigureAwait(false);
            return;
        }

        // Strip conditional caching headers to guarantee 200 OK full body response instead of 304 Not Modified
        context.Request.Headers.Remove("If-None-Match");
        context.Request.Headers.Remove("If-Modified-Since");
        context.Request.Headers.Remove("If-Range");

        // Prefer uncompressed response from downstream
        context.Request.Headers.Remove("Accept-Encoding");

        var originalBodyStream = context.Response.Body;
        using var memoryStream = new MemoryStream();
        context.Response.Body = memoryStream;

        try
        {
            await _next(context).ConfigureAwait(false);

            memoryStream.Seek(0, SeekOrigin.Begin);

            var contentType = context.Response.ContentType ?? string.Empty;
            if (context.Response.StatusCode == StatusCodes.Status200OK &&
                (contentType.Contains("text/html", StringComparison.OrdinalIgnoreCase) ||
                 path.EndsWith(".html", StringComparison.OrdinalIgnoreCase) ||
                 path.EndsWith("/web", StringComparison.OrdinalIgnoreCase) ||
                 path.EndsWith("/web/", StringComparison.OrdinalIgnoreCase) ||
                 path.Equals("/", StringComparison.OrdinalIgnoreCase)))
            {
                var contentEncoding = context.Response.Headers.ContentEncoding.ToString();
                string html;
                bool wasGzipped = false;

                if (contentEncoding.Contains("gzip", StringComparison.OrdinalIgnoreCase))
                {
                    wasGzipped = true;
                    using var decompressor = new GZipStream(memoryStream, CompressionMode.Decompress, leaveOpen: true);
                    using var reader = new StreamReader(decompressor, Encoding.UTF8);
                    html = await reader.ReadToEndAsync().ConfigureAwait(false);
                }
                else
                {
                    using var reader = new StreamReader(memoryStream, Encoding.UTF8, detectEncodingFromByteOrderMarks: true, leaveOpen: true);
                    html = await reader.ReadToEndAsync().ConfigureAwait(false);
                }

                if (html.Contains("</body>", StringComparison.OrdinalIgnoreCase) &&
                    !html.Contains("playbackcard.js", StringComparison.OrdinalIgnoreCase))
                {
                    var modifiedHtml = html.Replace("</body>", ScriptTag + "\n</body>", StringComparison.OrdinalIgnoreCase);
                    var modifiedBytes = Encoding.UTF8.GetBytes(modifiedHtml);

                    context.Response.Headers.Remove("Content-Encoding");
                    context.Response.Headers.Remove("Content-Length");
                    context.Response.Headers.Remove("ETag");
                    context.Response.Headers.Remove("Last-Modified");
                    context.Response.Headers.CacheControl = "no-cache, no-store, must-revalidate";
                    context.Response.Headers.Pragma = "no-cache";
                    context.Response.Headers.Expires = "0";

                    if (wasGzipped)
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

                    context.Response.ContentLength = modifiedBytes.Length;
                    await originalBodyStream.WriteAsync(modifiedBytes).ConfigureAwait(false);
                    return;
                }
            }

            memoryStream.Seek(0, SeekOrigin.Begin);
            await memoryStream.CopyToAsync(originalBodyStream).ConfigureAwait(false);
        }
        finally
        {
            context.Response.Body = originalBodyStream;
        }
    }
}
