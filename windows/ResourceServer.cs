// photos.jpeg for Windows — serves the UI and binary data to the web view. Nothing listens on
// a network port: requests to the app's private origin are answered in-process.
//   https://app.photos-jpeg.example/<file>                         the editor (web\ next to the exe)
//   …/__pj/file?path=…[&start=&length=]   original media bytes (whole file or a byte range)
//   …/__pj/media?path=…                   video for <video>, with HTTP Range / 206 support
//   …/__pj/thumb/<id>.jpg                 cached thumbnails
//   …/__pj/image?path=…                   any format Windows can decode (WIC), as JPEG
//   …/__pj/rawcache?key=…                 developed RAW files at working size (GET reads, POST stores)
using Microsoft.Web.WebView2.Core;

namespace PhotosJpeg;

public sealed class ResourceServer(CoreWebView2 web, string version)
{
    public const string Origin = "https://app.photos-jpeg.example";
    const string Tiles = "https://tile.openstreetmap.org/";
    /// <summary>Largest body sent for an open-ended media range; the player asks for more as it needs it.</summary>
    const int MediaChunk = 8 << 20;

    /// <summary>The editor's files: web\ next to the exe, or PJ_WEB_ROOT while developing.</summary>
    public static readonly string WebRoot = Path.GetFullPath(
        Environment.GetEnvironmentVariable("PJ_WEB_ROOT") is { Length: > 0 } dev ? dev : Path.Combine(AppContext.BaseDirectory, "web"));

    sealed record Reply(int Status, byte[] Data, string Mime, Dictionary<string, string>? Headers = null);

    static Reply Fail(int status) => new(status, [], "text/plain");

    public void Attach()
    {
        // All source kinds: the render workers fetch their scripts through here too.
        web.AddWebResourceRequestedFilter(Origin + "/*", CoreWebView2WebResourceContext.All, CoreWebView2WebResourceRequestSourceKinds.All);
        web.AddWebResourceRequestedFilter(Tiles + "*", CoreWebView2WebResourceContext.All, CoreWebView2WebResourceRequestSourceKinds.All);
        web.WebResourceRequested += OnRequest;
    }

    async void OnRequest(object? sender, CoreWebView2WebResourceRequestedEventArgs e)
    {
        if (e.Request.Uri.StartsWith(Tiles, StringComparison.OrdinalIgnoreCase))
        {
            // OpenStreetMap's tile policy asks apps to identify themselves
            e.Request.Headers.SetHeader("User-Agent", $"photos.jpeg/{version} (desktop photo editor; map view)");
            return;
        }
        var deferral = e.GetDeferral();
        try
        {
            var uri = new Uri(e.Request.Uri);
            var range = e.Request.Headers.Contains("Range") ? e.Request.Headers.GetHeader("Range") : null;
            // a POST body (the developed-RAW cache) has to be read here, on the UI thread, before the request goes away
            byte[]? body = null;
            if (e.Request.Method == "POST" && e.Request.Content is { } content)
            {
                using var ms = new MemoryStream();
                content.CopyTo(ms);
                body = ms.ToArray();
            }
            var r = await Task.Run(() => Respond(uri, range, body));
            var isThumb = uri.AbsolutePath.StartsWith("/__pj/thumb/");
            var headers = new Dictionary<string, string>
            {
                ["Content-Type"] = r.Mime,
                ["Content-Length"] = r.Data.Length.ToString(),
                ["Access-Control-Allow-Origin"] = "*",
                // Thumbnails are versioned (?v=) so they can be cached; the app's own files never are.
                ["Cache-Control"] = isThumb ? "max-age=31536000" : "no-store",
                // Cross-origin isolation enables SharedArrayBuffer, so render workers share decoded pixels.
                ["Cross-Origin-Opener-Policy"] = "same-origin",
                ["Cross-Origin-Embedder-Policy"] = "require-corp",
                ["Cross-Origin-Resource-Policy"] = "cross-origin",
            };
            if (r.Headers != null) foreach (var (k, v) in r.Headers) headers[k] = v;
            e.Response = web.Environment.CreateWebResourceResponse(
                new MemoryStream(r.Data), r.Status, Reason(r.Status),
                string.Join("\r\n", headers.Select(h => $"{h.Key}: {h.Value}")));
        }
        catch
        {
            try { e.Response = web.Environment.CreateWebResourceResponse(null, 500, "Error", ""); } catch { /* view is closing */ }
        }
        finally { deferral.Complete(); }
    }

    static string Reason(int status) => status switch
    {
        200 => "OK", 204 => "No Content", 206 => "Partial Content", 500 => "Server Error", 403 => "Forbidden", 404 => "Not Found",
        415 => "Unsupported Media Type", 416 => "Range Not Satisfiable", _ => "Error"
    };

    static string? Query(Uri uri, string name)
    {
        foreach (var part in uri.Query.TrimStart('?').Split('&', StringSplitOptions.RemoveEmptyEntries))
        {
            var eq = part.IndexOf('=');
            if (eq > 0 && part[..eq] == name) return Uri.UnescapeDataString(part[(eq + 1)..].Replace('+', ' '));
        }
        return null;
    }

    static byte[] ReadRange(string path, long offset, int length)
    {
        using var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
        if (offset >= fs.Length || length <= 0) return [];
        var buf = new byte[(int)Math.Min(length, fs.Length - offset)];
        fs.Seek(offset, SeekOrigin.Begin);
        fs.ReadExactly(buf);
        return buf;
    }

    static Reply Respond(Uri uri, string? range, byte[]? body = null)
    {
        var path = uri.AbsolutePath;
        try
        {
            if (path == "/__pj/encode")
            {
                if (body == null || body.Length == 0) return Fail(404);
                int.TryParse(Query(uri, "quality"), out var quality);
                try { return new Reply(200, VideoTool.EncodeStill(body, Query(uri, "format") ?? "", quality == 0 ? 80 : quality), "application/octet-stream"); }
                catch (IOException ex) { Log.Warn(ex.Message); return new Reply(500, System.Text.Encoding.UTF8.GetBytes(ex.Message), "text/plain; charset=utf-8"); }
            }
            if (path == "/__pj/rawcache")
            {
                if (Query(uri, "key") is not { Length: > 0 } key) return Fail(404);
                if (body != null) { Storage.RawCachePut(key, body); return new Reply(200, [], "text/plain"); }
                return Storage.RawCacheGet(key) is { } data ? new Reply(200, data, "application/octet-stream") : new Reply(204, [], "application/octet-stream");
            }
            if (path == "/__pj/file")
            {
                if (Query(uri, "path") is not { } p || !Storage.IsReadable(p)) return Fail(403);
                if (long.TryParse(Query(uri, "start"), out var start) && int.TryParse(Query(uri, "length"), out var len))
                    return new Reply(200, ReadRange(p, start, len), "application/octet-stream");
                return new Reply(200, ReadRange(p, 0, int.MaxValue), Mime(p));
            }
            if (path == "/__pj/media")
            {
                if (Query(uri, "path") is not { } p || !Storage.IsReadable(p)) return Fail(403);
                var size = new FileInfo(p).Length;
                if (size <= 0) return Fail(404);
                long start = 0, end = size - 1;
                if (range != null && range.StartsWith("bytes="))
                {
                    var parts = range[6..].Split('-');
                    if (parts.Length == 2)
                    {
                        if (parts[0] == "" && long.TryParse(parts[1], out var suffix)) start = size - Math.Min(size, suffix); // bytes=-N
                        else
                        {
                            long.TryParse(parts[0], out start);
                            end = long.TryParse(parts[1], out var e) ? Math.Min(e, size - 1) : Math.Min(size - 1, start + MediaChunk - 1);
                        }
                    }
                    if (start >= size) return new Reply(416, [], "text/plain", new() { ["Content-Range"] = $"bytes */{size}" });
                }
                else if (size > MediaChunk) end = MediaChunk - 1; // no Range header: still partial, so the player learns it can seek
                var data = ReadRange(p, start, (int)Math.Min(end - start + 1, MediaChunk));
                return new Reply(206, data, Mime(p), new()
                {
                    ["Accept-Ranges"] = "bytes",
                    ["Content-Range"] = $"bytes {start}-{start + data.Length - 1}/{size}"
                });
            }
            if (path.StartsWith("/__pj/thumb/"))
            {
                var id = Path.GetFileNameWithoutExtension(Uri.UnescapeDataString(path["/__pj/thumb/".Length..]));
                var file = Storage.ThumbPath(id);
                return File.Exists(file) ? new Reply(200, File.ReadAllBytes(file), "image/jpeg") : Fail(404);
            }
            if (path == "/__pj/image")
            {
                if (Query(uri, "path") is not { } p || !Path.IsPathFullyQualified(p) || !Storage.IsImage(p)) return Fail(404);
                try { return new Reply(200, SystemImage.RenderJpeg(p), "image/jpeg"); }
                catch { return Fail(415); }
            }
            if (path.StartsWith("/__pj/")) return Fail(404);

            // The editor itself
            var rel = Uri.UnescapeDataString(path).TrimStart('/');
            if (rel == "") rel = "index.html";
            var full = Path.GetFullPath(Path.Combine(WebRoot, rel));
            if (!full.StartsWith(WebRoot + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) return Fail(403);
            // a model that this build does not carry but that has been downloaded (Models.cs)
            if (!File.Exists(full) && rel.StartsWith("vendor/ml/", StringComparison.OrdinalIgnoreCase) && Models.Find(Path.GetFileName(rel)) is { } got) full = got;
            return File.Exists(full) ? new Reply(200, File.ReadAllBytes(full), Mime(full)) : Fail(404);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return Fail(404);
        }
    }

    static string Mime(string path) => Storage.Ext(path) switch
    {
        "html" => "text/html; charset=utf-8",
        "js" or "mjs" => "text/javascript; charset=utf-8",
        "wasm" => "application/wasm",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json",
        "woff2" => "font/woff2",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" or "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "gif" => "image/gif",
        "mp4" or "m4v" or "lrv" => "video/mp4",
        "mov" => "video/quicktime",
        "webm" => "video/webm",
        "mkv" => "video/x-matroska",
        _ => "application/octet-stream"
    };
}
