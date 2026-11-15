// photos.jpeg for Windows — update check.
//
// The app looks for a small JSON "manifest" at the address set in PhotosJpeg.csproj (<UpdateUrl>):
//
//   { "version": "2.1.0",
//     "url":     "https://example.com/downloads/photos.jpeg-Setup-2.1.0-x64.exe",
//     "sha256":  "<hex SHA-256 of that file>",
//     "notes":   "What's new, in a line or two" }
//
// When its version is higher than this build's, Help → Check for Updates offers to install it:
// the Setup program is downloaded to the temp folder, its SHA-256 is checked against the
// manifest, and it is started to update the app in place and reopen it. Nothing is sent
// except the request for the manifest. With no <UpdateUrl> the check is switched off.
using System.Diagnostics;
using System.Net.Http;
using System.Reflection;
using System.Security.Cryptography;
using System.Text.Json;

namespace PhotosJpeg;

public sealed record UpdateInfo(Version Version, string Url, string Sha256, string Notes);

public static class Updater
{
    /// <summary>Where the manifest lives: PJ_UPDATE_URL (testing) or the address built into the app. Empty = no update checks.</summary>
    public static string ManifestUrl =>
        Environment.GetEnvironmentVariable("PJ_UPDATE_URL") is { Length: > 0 } env ? env :
        Assembly.GetExecutingAssembly().GetCustomAttributes<AssemblyMetadataAttribute>()
            .FirstOrDefault(a => a.Key == "UpdateUrl")?.Value ?? "";

    public static bool Configured => Allowed(ManifestUrl);

    public static Version Current => Assembly.GetExecutingAssembly().GetName().Version ?? new Version(0, 0);

    /// <summary>Downloads only come over https — or from this PC itself, which is how the feature is tested.</summary>
    static bool Allowed(string url) =>
        Uri.TryCreate(url, UriKind.Absolute, out var u) &&
        (u.Scheme == Uri.UriSchemeHttps || (u.Scheme == Uri.UriSchemeHttp && u.IsLoopback));

    static readonly HttpClient http = new() { Timeout = TimeSpan.FromSeconds(20) };

    /// <summary>The newer version on offer, or null when this build is current. Throws when the manifest can't be read.</summary>
    public static async Task<UpdateInfo?> Check()
    {
        if (!Configured) return null;
        using var req = new HttpRequestMessage(HttpMethod.Get, ManifestUrl);
        req.Headers.UserAgent.ParseAdd("photos.jpeg-updater");
        using var res = await http.SendAsync(req);
        res.EnsureSuccessStatusCode();
        using var doc = JsonDocument.Parse(await res.Content.ReadAsStringAsync());
        var root = doc.RootElement;
        string Get(string name) => root.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() ?? "" : "";
        if (!Version.TryParse(Get("version"), out var version)) throw new IOException("The update information is not valid.");
        var normal = new Version(version.Major, version.Minor, Math.Max(0, version.Build));
        var mine = new Version(Current.Major, Current.Minor, Math.Max(0, Current.Build));
        if (normal <= mine) return null;
        string url = Get("url"), sha = Get("sha256").Trim().ToLowerInvariant();
        if (!Allowed(url) || sha.Length != 64) throw new IOException("The update information is not valid.");
        return new UpdateInfo(normal, url, sha, Get("notes"));
    }

    /// <summary>Downloads the Setup program and checks it against the manifest's SHA-256. Returns its path.</summary>
    public static async Task<string> Download(UpdateInfo info, Action<double> progress)
    {
        var dir = Path.Combine(Path.GetTempPath(), "photos.jpeg-update");
        Directory.CreateDirectory(dir);
        var file = Path.Combine(dir, $"photos.jpeg-Setup-{info.Version}.exe");
        using (var res = await http.GetAsync(info.Url, HttpCompletionOption.ResponseHeadersRead))
        {
            res.EnsureSuccessStatusCode();
            var total = res.Content.Headers.ContentLength ?? 0;
            await using var src = await res.Content.ReadAsStreamAsync();
            await using var dst = new FileStream(file, FileMode.Create, FileAccess.Write, FileShare.None);
            var buf = new byte[1 << 16];
            long done = 0;
            int n;
            while ((n = await src.ReadAsync(buf)) > 0)
            {
                await dst.WriteAsync(buf.AsMemory(0, n));
                done += n;
                if (total > 0) progress(Math.Min(1, (double)done / total));
            }
        }
        string actual;
        await using (var f = File.OpenRead(file)) actual = Convert.ToHexString(await SHA256.HashDataAsync(f)).ToLowerInvariant();
        if (actual != info.Sha256)
        {
            try { File.Delete(file); } catch { /* temp file */ }
            throw new IOException("The downloaded update doesn't match its published checksum, so it was not installed.");
        }
        return file;
    }

    /// <summary>Starts the downloaded Setup: it waits for this app to close, updates it in place and reopens it.</summary>
    public static void Install(string setup) =>
        Process.Start(new ProcessStartInfo(setup, "/S /WAIT /RUN") { UseShellExecute = false })?.Dispose();

    // ---------------- once-a-day background check ----------------

    static string StatePath => Path.Combine(Storage.Root, "update-check.json");

    /// <summary>True at most once a day (and never when no update address is configured).</summary>
    public static bool DueForCheck()
    {
        if (!Configured) return false;
        try
        {
            if (File.Exists(StatePath) && DateTime.UtcNow - File.GetLastWriteTimeUtc(StatePath) < TimeSpan.FromHours(20)) return false;
            File.WriteAllText(StatePath, "{}");
        }
        catch { return false; }
        return true;
    }
}
