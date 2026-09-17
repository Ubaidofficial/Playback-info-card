using System;
using System.Collections.Generic;
using System.Net;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;

namespace JellyfinPlaybackCard.Tests;

public class TestHttpMessageHandler : HttpMessageHandler
{
    public Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>>? HandlerFunc { get; set; }
    public List<HttpRequestMessage> CapturedRequests { get; } = new();
    public List<string> CapturedContents { get; } = new();

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        CapturedRequests.Add(request);
        if (request.Content != null)
        {
            var contentStr = await request.Content.ReadAsStringAsync(cancellationToken);
            CapturedContents.Add(contentStr);
        }
        else
        {
            CapturedContents.Add(string.Empty);
        }

        if (HandlerFunc != null)
        {
            return await HandlerFunc(request, cancellationToken);
        }

        return new HttpResponseMessage(HttpStatusCode.OK);
    }
}
