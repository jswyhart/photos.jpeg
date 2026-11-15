using System.Net.Http;
using System.Security.Cryptography;

namespace PhotosJpeg;

/// <summary>
/// The neural-network files behind the masks and face grouping. A full build carries them in
/// web\vendor\ml; a "lite" build (build.ps1 -Lite) leaves them out and each is fetched the first time
/// a feature needs it — from this app's own repository, checked against the size and SHA-256 written
/// here, into the data folder. Nothing else is ever downloaded through this.
/// </summary>
static class Models
{
    /// name → (size in bytes, SHA-256)
    static readonly Dictionary<string, (long Size, string Sha)> Known = new(StringComparer.OrdinalIgnoreCase)
    {
        ["u2netp.onnx"] = (4574861, "309c8469258dda742793dce0ebea8e6dd393174f89934733ecc8b14c76f4ddd8"),
        ["efficientvit-seg-b1-ade20k.onnx"] = (19312501, "d6013483203730a1b12c700013bd440231d6778064ffdb63b0582785e40e89a5"),
        ["face_detection_yunet_2023mar.onnx"] = (232589, "8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4"),
        ["face_recognition_sface_2021dec.onnx"] = (38696353, "0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79"),
    };

    const string DefaultBase = "https://raw.githubusercontent.com/jswyhart/photos.jpeg/main/src/vendor/ml/";

    /// Where models come from; PJ_MODEL_URL replaces it (https, or this PC itself — which is how it is tested).
    static string BaseUrl => Environment.GetEnvironmentVariable("PJ_MODEL_URL") is { Length: > 0 } u ? (u.EndsWith('/') ? u : u + "/") : DefaultBase;

    public static string Dir => Path.Combine(Storage.Root, "models");

    static readonly HttpClient http = new() { Timeout = TimeSpan.FromMinutes(10) };
    static readonly SemaphoreSlim gate = new(1, 1);

    /// The downloaded copy of a model, or null when there is none (or the name is not one of ours).
    public static string? Find(string name)
    {
        if (!Known.ContainsKey(name)) return null;
        var p = Path.Combine(Dir, name);
        return File.Exists(p) ? p : null;
    }

    /// Which models there are, how large, and whether this installation has each (in the build or downloaded).
    public static object Status() => Known.Select(k => new
    {
        name = k.Key, size = k.Value.Size,
        have = File.Exists(Path.Combine(ResourceServer.WebRoot, "vendor", "ml", k.Key)) || Find(k.Key) != null
    }).ToArray();

    /// Download one model, check it, and put it in the data folder. progress: 0…1.
    public static async Task<object> Fetch(string name, Action<double> progress)
    {
        if (!Known.TryGetValue(name, out var want)) throw new IOException("That is not a model of this app");
        await gate.WaitAsync();
        try
        {
            if (Find(name) != null) return new { name, ok = true, already = true };
            var url = BaseUrl + name;
            if (!Uri.TryCreate(url, UriKind.Absolute, out var u) || !(u.Scheme == Uri.UriSchemeHttps || (u.Scheme == Uri.UriSchemeHttp && u.IsLoopback)))
                throw new IOException("Models are only downloaded over https");
            Directory.CreateDirectory(Dir);
            var tmp = Path.Combine(Dir, name + ".part");
            try
            {
                using var req = new HttpRequestMessage(HttpMethod.Get, u);
                req.Headers.UserAgent.ParseAdd("photos.jpeg");
                using var res = await http.SendAsync(req, HttpCompletionOption.ResponseHeadersRead);
                if (!res.IsSuccessStatusCode) throw new IOException($"The download failed ({(int)res.StatusCode}) — is this PC online?");
                using (var src = await res.Content.ReadAsStreamAsync())
                using (var dst = File.Create(tmp))
                {
                    var buf = new byte[1 << 16]; long got = 0; int n; var last = 0.0;
                    while ((n = await src.ReadAsync(buf)) > 0)
                    {
                        got += n;
                        if (got > want.Size) throw new IOException("The downloaded file is larger than it should be");
                        await dst.WriteAsync(buf.AsMemory(0, n));
                        var f = (double)got / want.Size;
                        if (f - last >= 0.02) { last = f; progress(f); }
                    }
                }
                string sha;
                using (var fs = File.OpenRead(tmp)) sha = Convert.ToHexString(await SHA256.HashDataAsync(fs)).ToLowerInvariant();
                if (new FileInfo(tmp).Length != want.Size || sha != want.Sha)
                    throw new IOException("The downloaded file is not the one this app expects, so it was not kept");
                File.Move(tmp, Path.Combine(Dir, name), true);
                Log.Info($"model downloaded: {name}");
                return new { name, ok = true };
            }
            finally { try { if (File.Exists(tmp)) File.Delete(tmp); } catch { /* next time */ } }
        }
        finally { gate.Release(); }
    }
}
