using System;
using System.IO;
using System.IO.Compression;
using System.Text;
using System.Threading.Tasks;
using Jellyfin.Plugin.PlaybackCard;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace JellyfinPlaybackCard.Tests;

public class PlaybackCardDashboardMiddlewareTests
{
    [Fact]
    public async Task InvokeAsync_DirectScriptRoute_ServesDashboardJsWithCorrectContentType()
    {
        var middleware = new PlaybackCardDashboardMiddleware(
            _ => Task.CompletedTask,
            NullLogger<PlaybackCardDashboardMiddleware>.Instance
        );

        var context = new DefaultHttpContext();
        context.Request.Path = "/PlaybackCard/dashboard.js";
        using var bodyStream = new MemoryStream();
        context.Response.Body = bodyStream;

        await middleware.InvokeAsync(context);

        Assert.Equal(StatusCodes.Status200OK, context.Response.StatusCode);
        Assert.Contains("application/javascript", context.Response.ContentType);
        Assert.Contains("no-cache", context.Response.Headers.CacheControl.ToString());

        bodyStream.Seek(0, SeekOrigin.Begin);
        using var reader = new StreamReader(bodyStream, Encoding.UTF8);
        var content = await reader.ReadToEndAsync();
        Assert.NotEmpty(content);
        Assert.Contains("0.2.4.0", content);
        Assert.Contains("NOW PLAYING", content);
    }

    [Fact]
    public async Task InvokeAsync_DirectCssRoute_ServesDashboardCssWithCorrectContentType()
    {
        var middleware = new PlaybackCardDashboardMiddleware(
            _ => Task.CompletedTask,
            NullLogger<PlaybackCardDashboardMiddleware>.Instance
        );

        var context = new DefaultHttpContext();
        context.Request.Path = "/PlaybackCard/dashboard.css";
        using var bodyStream = new MemoryStream();
        context.Response.Body = bodyStream;

        await middleware.InvokeAsync(context);

        Assert.Equal(StatusCodes.Status200OK, context.Response.StatusCode);
        Assert.Contains("text/css", context.Response.ContentType);

        bodyStream.Seek(0, SeekOrigin.Begin);
        using var reader = new StreamReader(bodyStream, Encoding.UTF8);
        var content = await reader.ReadToEndAsync();
        Assert.NotEmpty(content);
        Assert.Contains("#playback-card-nowplaying-container", content);
    }

    [Fact]
    public async Task InvokeAsync_IndexHtml_InjectsScriptAndLinkBeforeBodyClosingTag()
    {
        var originalHtml = "<!DOCTYPE html><html><head><title>Jellyfin</title></head><body><div id=\"app\"></div></body></html>";

        var middleware = new PlaybackCardDashboardMiddleware(
            async ctx =>
            {
                ctx.Response.StatusCode = StatusCodes.Status200OK;
                ctx.Response.ContentType = "text/html; charset=utf-8";
                var bytes = Encoding.UTF8.GetBytes(originalHtml);
                await ctx.Response.Body.WriteAsync(bytes);
            },
            NullLogger<PlaybackCardDashboardMiddleware>.Instance
        );

        var context = new DefaultHttpContext();
        context.Request.Path = "/web/index.html";
        using var bodyStream = new MemoryStream();
        context.Response.Body = bodyStream;

        await middleware.InvokeAsync(context);

        bodyStream.Seek(0, SeekOrigin.Begin);
        using var reader = new StreamReader(bodyStream, Encoding.UTF8);
        var modifiedHtml = await reader.ReadToEndAsync();

        Assert.Contains("<script plugin=\"PlaybackCard\" version=\"0.2.4.0\" src=\"/PlaybackCard/dashboard.js\" defer></script>", modifiedHtml);
        Assert.Contains("<link plugin=\"PlaybackCard\" rel=\"stylesheet\" href=\"/PlaybackCard/dashboard.css\">", modifiedHtml);
        Assert.EndsWith("</body></html>", modifiedHtml.Trim());
    }

    [Fact]
    public async Task InvokeAsync_GzipCompressedHtml_DecompressesInjectsAndRecompresses()
    {
        var originalHtml = "<!DOCTYPE html><html><body><main>Dashboard</main></body></html>";

        var middleware = new PlaybackCardDashboardMiddleware(
            async ctx =>
            {
                ctx.Response.StatusCode = StatusCodes.Status200OK;
                ctx.Response.ContentType = "text/html; charset=utf-8";
                ctx.Response.Headers.ContentEncoding = "gzip";

                using var gzip = new GZipStream(ctx.Response.Body, CompressionLevel.Fastest, leaveOpen: true);
                var bytes = Encoding.UTF8.GetBytes(originalHtml);
                await gzip.WriteAsync(bytes);
            },
            NullLogger<PlaybackCardDashboardMiddleware>.Instance
        );

        var context = new DefaultHttpContext();
        context.Request.Path = "/web/index.html";
        using var bodyStream = new MemoryStream();
        context.Response.Body = bodyStream;

        await middleware.InvokeAsync(context);

        Assert.Equal("gzip", context.Response.Headers.ContentEncoding.ToString());

        bodyStream.Seek(0, SeekOrigin.Begin);
        using var decompressor = new GZipStream(bodyStream, CompressionMode.Decompress);
        using var reader = new StreamReader(decompressor, Encoding.UTF8);
        var decompressedHtml = await reader.ReadToEndAsync();

        Assert.Contains("dashboard.js", decompressedHtml);
        Assert.Contains("dashboard.css", decompressedHtml);
        Assert.Contains("version=\"0.2.4.0\"", decompressedHtml);
    }

    [Fact]
    public async Task InvokeAsync_NonHtmlRoute_BypassesWithoutModifyingBody()
    {
        var apiPayload = "{\"Sessions\":[]}";
        var middleware = new PlaybackCardDashboardMiddleware(
            async ctx =>
            {
                ctx.Response.StatusCode = StatusCodes.Status200OK;
                ctx.Response.ContentType = "application/json";
                var bytes = Encoding.UTF8.GetBytes(apiPayload);
                await ctx.Response.Body.WriteAsync(bytes);
            },
            NullLogger<PlaybackCardDashboardMiddleware>.Instance
        );

        var context = new DefaultHttpContext();
        context.Request.Path = "/Sessions";
        using var bodyStream = new MemoryStream();
        context.Response.Body = bodyStream;

        await middleware.InvokeAsync(context);

        bodyStream.Seek(0, SeekOrigin.Begin);
        using var reader = new StreamReader(bodyStream, Encoding.UTF8);
        var result = await reader.ReadToEndAsync();

        Assert.Equal(apiPayload, result);
        Assert.DoesNotContain("dashboard.js", result);
    }
}
