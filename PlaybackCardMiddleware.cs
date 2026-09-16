using System;
using System.IO;
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
    private const string ScriptTag = "<script plugin=\"PlaybackCard\" version=\"0.2.3.0\" src=\"/web/configurationpage?name=playbackcard.js\" defer></script>";

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

        // Fast path for non-HTML routes (images, streams, API calls, CSS, JS, fonts)
        if (!path.EndsWith("index.html", StringComparison.OrdinalIgnoreCase) &&
            !path.Equals("/", StringComparison.OrdinalIgnoreCase) &&
            !path.Equals("/web", StringComparison.OrdinalIgnoreCase) &&
            !path.Equals("/web/", StringComparison.OrdinalIgnoreCase))
        {
            await _next(context).ConfigureAwait(false);
            return;
        }

        var originalBodyStream = context.Response.Body;
        using var memoryStream = new MemoryStream();
        context.Response.Body = memoryStream;

        try
        {
            await _next(context).ConfigureAwait(false);

            memoryStream.Seek(0, SeekOrigin.Begin);

            var contentType = context.Response.ContentType;
            if (contentType != null &&
                contentType.Contains("text/html", StringComparison.OrdinalIgnoreCase) &&
                context.Response.StatusCode == StatusCodes.Status200OK)
            {
                using var reader = new StreamReader(memoryStream, Encoding.UTF8, detectEncodingFromByteOrderMarks: true, leaveOpen: true);
                var html = await reader.ReadToEndAsync().ConfigureAwait(false);

                if (html.Contains("</body>", StringComparison.OrdinalIgnoreCase) &&
                    !html.Contains("playbackcard.js", StringComparison.OrdinalIgnoreCase))
                {
                    var modifiedHtml = html.Replace("</body>", ScriptTag + "\n</body>", StringComparison.OrdinalIgnoreCase);
                    var modifiedBytes = Encoding.UTF8.GetBytes(modifiedHtml);

                    context.Response.Headers.Remove("Content-Length");
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
