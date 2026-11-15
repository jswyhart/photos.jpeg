// photos.jpeg for Windows — video tooling.
// Creates "optimized media" for formats the editor can't decode directly:
//   • ffmpeg (next to the app in tools\, set in video-settings.json, or on PATH): ProRes, DNxHR,
//     MXF, AVCHD/MTS, MKV/AVI with unusual codecs …
//   • Blackmagic RAW: the tools/braw helper built against the free Blackmagic RAW SDK
//   • RED R3D, ARRIRAW, Canon Cinema RAW Light, Nikon N-RAW: the vendor's command-line
//     converter, configured in video-settings.json
// Optimized media is a high-bitrate H.264 file the editor grades and exports from. It is encoded on
// the graphics card when ffmpeg can use one — NVIDIA NVENC (CUDA), Intel Quick Sync or AMD AMF —
// and decoded with hardware acceleration where the source codec allows; "encoder" in
// video-settings.json ("auto", "nvenc", "qsv", "amf" or "software") overrides the choice.
using System.Collections.Concurrent;
using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace PhotosJpeg;

public sealed partial class VideoTool(Action<string, double, string> progress)
{
    sealed record Converter(string Label, string[] Tools, string Args, string Output);

    /// <summary>Default converter commands. {in} {outdir} {name} are substituted; video-settings.json overrides them.</summary>
    static readonly Dictionary<string, Converter> Defaults = new()
    {
        ["r3d"] = new("RED R3D (REDline)", ["REDline", @"C:\Program Files\REDCINE-X PRO 64-bit\REDline.exe"], "--i \"{in}\" --o \"{outdir}/{name}\" --format 1", "tiffseq"),
        ["ari"] = new("ARRIRAW (ARRI Reference Tool)", ["art-cmd", "ARRIReferenceTool_CMD"], "--mode process --input \"{in}\" --output \"{outdir}/{name}.%07d.tif\"", "tiffseq"),
        ["arx"] = new("ARRIRAW HDE (ARRI Reference Tool)", ["art-cmd", "ARRIReferenceTool_CMD"], "--mode process --input \"{in}\" --output \"{outdir}/{name}.%07d.tif\"", "tiffseq"),
        ["crm"] = new("Canon Cinema RAW Light", [], "", "video"),
        ["nev"] = new("Nikon N-RAW", [], "", "video"),
    };

    /// <summary>An H.264 encoder and the ffmpeg arguments that give visually lossless optimized media with it.</summary>
    sealed record Encoder(string Name, string[] Args);

    static readonly Encoder Software = new("software",
        ["-c:v", "libx264", "-preset", "medium", "-crf", "12", "-pix_fmt", "yuv420p", "-profile:v", "high", "-movflags", "+faststart"]);

    /// <summary>Graphics-card encoders, in the order they are tried.</summary>
    static readonly Encoder[] Hardware =
    [
        new("nvenc", ["-c:v", "h264_nvenc", "-preset", "p5", "-tune", "hq", "-rc", "vbr", "-cq", "15", "-b:v", "0", "-pix_fmt", "yuv420p", "-profile:v", "high", "-movflags", "+faststart"]),
        new("qsv", ["-c:v", "h264_qsv", "-preset", "medium", "-global_quality", "15", "-pix_fmt", "nv12", "-profile:v", "high", "-movflags", "+faststart"]),
        new("amf", ["-c:v", "h264_amf", "-quality", "quality", "-rc", "cqp", "-qp_i", "15", "-qp_p", "15", "-qp_b", "17", "-pix_fmt", "yuv420p", "-profile:v", "high", "-movflags", "+faststart"]),
    ];

    readonly ConcurrentDictionary<string, Process> jobs = new();
    readonly ConcurrentDictionary<string, bool> cancelled = new();
    static readonly ConcurrentDictionary<string, Task<Encoder>> probes = new();

    // ---------------- hardware encoding ----------------

    /// <summary>
    /// The encoder to use with this ffmpeg: the first graphics-card encoder that really works here
    /// (ffmpeg lists encoders it was built with even when the PC has no such hardware, so each is
    /// tried on a fraction of a second of black video), otherwise libx264. Probed once per session.
    /// </summary>
    static Task<Encoder> PickEncoder(string ff)
    {
        var want = (Str(ReadSettings(), "encoder") ?? "auto").Trim().ToLowerInvariant();
        return probes.GetOrAdd(ff + "|" + want, _ => Task.Run(async () =>
        {
            if (want is "software" or "cpu" or "x264") return Software;
            foreach (var e in Hardware)
            {
                if (want != "auto" && want != e.Name) continue;
                if (await Works(ff, e)) return e;
            }
            return Software;
        }));
    }

    static async Task<bool> Works(string ff, Encoder e)
    {
        try
        {
            using var p = Start(ff, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=black:s=640x360:r=30:d=0.2",
                .. e.Args.Where(a => a != "-movflags" && a != "+faststart"), "-f", "null", "-"], false, false);
            var err = p.StandardError.ReadToEndAsync();
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(15));
            try { await p.WaitForExitAsync(timeout.Token); }
            catch (OperationCanceledException) { try { p.Kill(true); } catch { } return false; }
            await err;
            return p.ExitCode == 0;
        }
        catch { return false; }
    }

    /// <summary>
    /// Runs an ffmpeg encode with the chosen encoder. If a graphics-card encoder fails (a frame
    /// size or pixel format it can't take, a driver problem) the encode is repeated in software.
    /// build(encoder) returns the full argument list; the name of the encoder that produced the file is returned.
    /// </summary>
    async Task<string> Encode(string jobId, string ff, Func<Encoder, string[]> build, Func<Encoder, string[], Task> run)
    {
        var enc = await PickEncoder(ff);
        try { await run(enc, build(enc)); return enc.Name; }
        catch (IOException) when (enc != Software && !cancelled.ContainsKey(jobId))
        {
            await run(Software, build(Software));
            return Software.Name;
        }
    }

    // ---------------- settings ----------------

    public static JsonElement ReadSettings()
    {
        try { return JsonDocument.Parse(File.ReadAllText(Storage.VideoSettingsPath)).RootElement.Clone(); }
        catch { return JsonDocument.Parse("{}").RootElement.Clone(); }
    }

    static string? Str(JsonElement e, params string[] path)
    {
        foreach (var key in path)
        {
            if (e.ValueKind != JsonValueKind.Object || !e.TryGetProperty(key, out e)) return null;
        }
        return e.ValueKind == JsonValueKind.String ? e.GetString() : null;
    }

    // ---------------- locating tools ----------------

    /// <summary>First existing candidate: absolute paths as given, bare names next to the app or on PATH.</summary>
    static string Which(IEnumerable<string> names)
    {
        var dirs = new List<string> { Path.Combine(AppContext.BaseDirectory, "tools"), AppContext.BaseDirectory };
        dirs.AddRange((Environment.GetEnvironmentVariable("PATH") ?? "").Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries));
        foreach (var n in names)
        {
            if (string.IsNullOrWhiteSpace(n)) continue;
            if (Path.IsPathFullyQualified(n)) { if (File.Exists(n)) return n; continue; }
            foreach (var d in dirs)
            {
                foreach (var suffix in new[] { "", ".exe", ".cmd", ".bat" })
                {
                    try { var full = Path.Combine(d.Trim('"'), n + suffix); if (File.Exists(full)) return full; }
                    catch { /* malformed PATH entry */ }
                }
            }
        }
        return "";
    }

    static string Ffmpeg()
    {
        var configured = Str(ReadSettings(), "ffmpeg");
        return Which(configured != null ? [configured, "ffmpeg"] : ["ffmpeg"]);
    }

    static string BrawHelper() => Which(["pj-braw"]);

    static (string Label, string Tool, string Args, string Output) ConverterFor(string ext)
    {
        var settings = ReadSettings();
        Defaults.TryGetValue(ext, out var def);
        var userTool = Str(settings, "converters", ext, "tool");
        var tool = !string.IsNullOrEmpty(userTool) ? Which([userTool]) : Which(def?.Tools ?? []);
        return (def?.Label ?? ext.ToUpperInvariant(), tool,
            Str(settings, "converters", ext, "args") ?? def?.Args ?? "",
            Str(settings, "converters", ext, "output") ?? def?.Output ?? "video");
    }

    public object Capabilities()
    {
        var converters = new Dictionary<string, object>();
        foreach (var ext in Defaults.Keys)
        {
            var c = ConverterFor(ext);
            converters[ext] = new { label = c.Label, available = c.Tool != "" && c.Args != "" };
        }
        var ff = Ffmpeg();
        // the encoder is reported once it has been probed (it is probed in the background from here)
        string? encoder = null;
        if (ff != "")
        {
            var probe = PickEncoder(ff);
            if (probe.IsCompletedSuccessfully) encoder = probe.Result.Name;
        }
        return new { ffmpeg = ff != "", braw = BrawHelper() != "", converters, encoder };
    }

    // ---------------- optimized media ----------------

    static string ProxyPath(string src)
    {
        var f = new FileInfo(src);
        var key = $"{src}|{f.Length}|{f.LastWriteTimeUtc.Ticks}";
        var hash = Convert.ToHexString(SHA1.HashData(Encoding.UTF8.GetBytes(key)))[..16].ToLowerInvariant();
        return Path.Combine(Storage.OptimizedDir, $"{SafeName().Replace(f.Name, "_")}-{hash}.mp4");
    }

    /// <summary>Make (or reuse) optimized media for a clip. Returns the path of the H.264 copy.</summary>
    public async Task<object> Proxy(string src, string jobId)
    {
        if (!Storage.IsMedia(src) || !File.Exists(src)) throw new IOException("Not a media file");
        Directory.CreateDirectory(Storage.OptimizedDir);
        var output = ProxyPath(src);
        if (File.Exists(output)) return new { path = output, cached = true };
        var tmp = output + ".part.mp4";
        cancelled.TryRemove(jobId, out _);
        string used;
        var ext = Storage.Ext(src);
        var ff = Ffmpeg();
        if (ff == "") throw new IOException("ffmpeg is needed to convert this format. Install it (winget install ffmpeg) or put ffmpeg.exe in the app's tools folder.");

        if (ext == "braw")
        {
            var helper = BrawHelper();
            if (helper == "") throw new IOException("Blackmagic RAW needs the free Blackmagic RAW SDK. Install it, then build tools/braw (see README).");
            var info = JsonDocument.Parse(await Capture(helper, [src, "--info"])).RootElement;
            if (!info.TryGetProperty("width", out var w) || w.GetInt32() == 0) throw new IOException("Could not read this BRAW clip");
            var fps = info.TryGetProperty("fps", out var f) ? f.GetDouble() : 24;
            var frames = info.TryGetProperty("frames", out var n) ? n.GetInt32() : 0;
            string[] rawIn = ["-y", "-f", "rawvideo", "-pix_fmt", "rgba", "-s", $"{w.GetInt32()}x{info.GetProperty("height").GetInt32()}",
                "-r", fps.ToString(System.Globalization.CultureInfo.InvariantCulture), "-i", "pipe:0"];
            used = await Encode(jobId, ff, e => [.. rawIn, .. e.Args, tmp], (e, a) => Pipe(jobId, helper, [src, "--decode"], ff, a, frames));
        }
        else if (Defaults.ContainsKey(ext))
        {
            var c = ConverterFor(ext);
            if (c.Tool == "" || c.Args == "") throw new IOException($"{c.Label} needs the vendor's converter. Set it up in video-settings.json (see README).");
            var work = Directory.CreateTempSubdirectory("pj-conv-").FullName;
            try
            {
                var name = Path.GetFileNameWithoutExtension(src);
                await Run(jobId, c.Tool, SplitArgs(c.Args.Replace("{in}", src).Replace("{outdir}", work).Replace("{name}", name)), 0, "Converting…");
                var files = Directory.GetFiles(work).Select(Path.GetFileName).OfType<string>().Order(StringComparer.Ordinal).ToList();
                string[] input;
                if (c.Output == "tiffseq")
                {
                    var first = files.FirstOrDefault(x => FrameFile().IsMatch(x)) ?? throw new IOException("The converter produced no frames");
                    var m = Numbered().Match(first);
                    if (!m.Success) throw new IOException("The converter produced no numbered frames");
                    input = ["-framerate", "24", "-start_number", int.Parse(m.Groups[2].Value).ToString(),
                        "-i", Path.Combine(work, $"{m.Groups[1].Value}%0{m.Groups[2].Length}d{m.Groups[3].Value}")];
                }
                else
                {
                    var vid = files.FirstOrDefault(x => VideoFile().IsMatch(x)) ?? throw new IOException("The converter produced no video file");
                    input = ["-i", Path.Combine(work, vid)];
                }
                used = await Encode(jobId, ff, e => ["-y", .. input, "-map", "0:v:0", .. e.Args, tmp], (e, a) => Run(jobId, ff, a, 0, "Creating optimized media…"));
            }
            finally { try { Directory.Delete(work, true); } catch { /* temp files */ } }
        }
        else
        {
            // -hwaccel auto: H.264 / HEVC / AV1 / VP9 sources are decoded on the graphics card (CUDA, Quick Sync,
            // D3D11); codecs without a hardware decoder (ProRes, DNxHR) are decoded on the CPU as before
            used = await Encode(jobId, ff,
                e => ["-y", .. (e == Software ? Array.Empty<string>() : ["-hwaccel", "auto"]), "-i", src, "-map", "0:v:0", "-map", "0:a:0?", .. e.Args, "-c:a", "aac", "-b:a", "256k", tmp],
                (e, a) => Run(jobId, ff, a, 0, e == Software ? "Creating optimized media…" : $"Creating optimized media ({e.Name.ToUpperInvariant()})…"));
        }
        File.Move(tmp, output, true);
        return new { path = output, encoder = used };
    }

    public void Cancel(string jobId)
    {
        cancelled[jobId] = true;
        if (jobs.TryGetValue(jobId, out var p)) { try { p.Kill(true); } catch { /* already gone */ } }
    }

    // ---------------- processes ----------------

    static Process Start(string cmd, IEnumerable<string> args, bool stdin, bool stdout)
    {
        var psi = new ProcessStartInfo(cmd)
        {
            UseShellExecute = false, CreateNoWindow = true,
            RedirectStandardInput = stdin, RedirectStandardOutput = stdout, RedirectStandardError = true
        };
        foreach (var a in args) psi.ArgumentList.Add(a);
        return Process.Start(psi) ?? throw new IOException($"Could not start {Path.GetFileName(cmd)}");
    }

    static async Task<string> Capture(string cmd, string[] args)
    {
        using var p = Start(cmd, args, false, true);
        var err = p.StandardError.ReadToEndAsync();
        var text = await p.StandardOutput.ReadToEndAsync();
        await p.WaitForExitAsync(); await err;
        return string.IsNullOrWhiteSpace(text) ? "{}" : text;
    }

    /// <summary>Follows ffmpeg's stderr (progress lines end in \r) and reports progress.</summary>
    async Task<string> Follow(Process p, string jobId, int totalFrames, string label)
    {
        var tail = new StringBuilder();
        double duration = 0;
        var buf = new char[4096];
        int n;
        while ((n = await p.StandardError.ReadAsync(buf)) > 0)
        {
            var s = new string(buf, 0, n);
            tail.Append(s);
            if (tail.Length > 4000) tail.Remove(0, tail.Length - 4000);
            var dm = Duration().Match(s);
            if (dm.Success) duration = Seconds(dm);
            var tm = Time().Match(s);
            if (tm.Success && duration > 0) progress(jobId, Math.Min(1, Seconds(tm) / duration), label);
            var fm = Frame().Match(s);
            if (fm.Success && totalFrames > 0) progress(jobId, Math.Min(1, double.Parse(fm.Groups[1].Value) / totalFrames), label);
        }
        return tail.ToString();
    }

    static double Seconds(Match m) =>
        int.Parse(m.Groups[1].Value) * 3600 + int.Parse(m.Groups[2].Value) * 60 +
        double.Parse(m.Groups[3].Value, System.Globalization.CultureInfo.InvariantCulture);

    static string LastLines(string err) =>
        string.Join(' ', err.Split('\n', '\r').Where(l => l.Trim() != "").TakeLast(3));

    async Task Run(string jobId, string cmd, IEnumerable<string> args, int totalFrames, string label)
    {
        using var p = Start(cmd, args, false, false);
        jobs[jobId] = p;
        try
        {
            var err = await Follow(p, jobId, totalFrames, label);
            await p.WaitForExitAsync();
            if (p.ExitCode != 0) throw new IOException($"{Path.GetFileName(cmd)} failed ({p.ExitCode}): {LastLines(err)}");
        }
        finally { jobs.TryRemove(jobId, out _); }
    }

    /// <summary>Runs "a | b": the BRAW helper's raw frames into ffmpeg.</summary>
    async Task Pipe(string jobId, string cmdA, string[] argsA, string cmdB, string[] argsB, int totalFrames)
    {
        using var a = Start(cmdA, argsA, false, true);
        using var b = Start(cmdB, argsB, true, false);
        jobs[jobId] = b;
        try
        {
            var drainA = a.StandardError.ReadToEndAsync();
            var copy = Task.Run(async () =>
            {
                try { await a.StandardOutput.BaseStream.CopyToAsync(b.StandardInput.BaseStream); }
                catch { /* ffmpeg went away: its exit code reports the failure */ }
                finally { try { b.StandardInput.Close(); } catch { } }
            });
            var err = await Follow(b, jobId, totalFrames, "Decoding Blackmagic RAW…");
            await b.WaitForExitAsync();
            try { if (!a.HasExited) a.Kill(true); } catch { }
            await copy; await drainA;
            if (b.ExitCode != 0) throw new IOException("Conversion failed: " + LastLines(err));
        }
        finally { jobs.TryRemove(jobId, out _); }
    }

    static List<string> SplitArgs(string s)
    {
        var output = new List<string>();
        var cur = new StringBuilder();
        char quote = '\0';
        foreach (var ch in s)
        {
            if (quote != '\0') { if (ch == quote) quote = '\0'; else cur.Append(ch); }
            else if (ch is '"' or '\'') quote = ch;
            else if (char.IsWhiteSpace(ch)) { if (cur.Length > 0) { output.Add(cur.ToString()); cur.Clear(); } }
            else cur.Append(ch);
        }
        if (cur.Length > 0) output.Add(cur.ToString());
        return output;
    }

    [GeneratedRegex(@"[^\w.-]+")] private static partial Regex SafeName();
    [GeneratedRegex(@"Duration: (\d+):(\d+):([\d.]+)")] private static partial Regex Duration();
    [GeneratedRegex(@"time=(\d+):(\d+):([\d.]+)")] private static partial Regex Time();
    [GeneratedRegex(@"frame=\s*(\d+)")] private static partial Regex Frame();
    [GeneratedRegex(@"\.(tif|tiff|dpx|exr|png)$", RegexOptions.IgnoreCase)] private static partial Regex FrameFile();
    [GeneratedRegex(@"\.(mov|mp4|mxf)$", RegexOptions.IgnoreCase)] private static partial Regex VideoFile();
    [GeneratedRegex(@"^(.*?)(\d+)(\.\w+)$")] private static partial Regex Numbered();
}
