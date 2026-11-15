// photos.jpeg for Windows — catalog, thumbnails, file scanning and export writing.
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;

namespace PhotosJpeg;

/// <summary>One media file, as the editor's catalog describes it.</summary>
public sealed record FileDesc(string path, string name, long size, double mtime, string folder);

public static class Storage
{
    static readonly string[] Raw = ["nef", "nrw", "gpr", "crw", "cr2", "cr3", "arw", "srf", "sr2", "dng", "orf", "rw2", "raf", "pef", "srw", "raw", "rwl", "erf", "3fr", "kdc", "dcr", "mrw", "mef", "mos", "iiq", "x3f"];
    static readonly string[] Std = ["jpg", "jpeg", "jpe", "jfif", "png", "webp", "avif", "gif", "bmp", "tif", "tiff", "heic", "heif", "hif", "jxl", "jp2", "j2k", "jpf", "jpx", "ico", "cur", "dib", "apng", "psd", "psb", "exr", "hdr", "pic", "pfm", "pbm", "pgm", "ppm", "pnm", "pam", "tga", "icb", "vda", "qoi"];
    static readonly string[] Video = ["mp4", "mov", "m4v", "mkv", "webm", "mts", "m2ts", "mxf", "avi", "lrv", "360", "insv", "mpg", "mpeg", "m2v", "vob", "wmv", "flv", "3gp", "3g2", "mod", "tod", "dv", "ogv", "braw", "r3d", "ari", "arx", "crm", "nev"];

    public static readonly HashSet<string> RawExt = [.. Raw];
    public static readonly HashSet<string> ImageExt = [.. Raw, .. Std];
    /// <summary>Everything the catalog can hold (photos + video).</summary>
    public static readonly HashSet<string> MediaExt = [.. Raw, .. Std, .. Video];
    public static readonly HashSet<string> WriteExt = ["jpg", "jpeg", "png", "webp", "tif", "tiff", "avif", "jxl", "json", "mp4", "mov"];
    public static readonly HashSet<string> TextExt = ["cube", "xmp", "json", "pjpreset", "txt"];

    /// <summary>The import dialog's file filter.</summary>
    public static string ImportFilter =>
        "Photos, RAW & Video|" + string.Join(';', Std.Concat(Raw).Concat(Video).Select(e => "*." + e)) + "|All Files|*.*";

    /// <summary>
    /// User data folder. The same place the earlier desktop version used (%APPDATA%\photos.jpeg),
    /// so an existing catalog and its thumbnails carry over. PJ_DATA_DIR overrides it (testing, portable use).
    /// </summary>
    public static readonly string Root = ResolveRoot();
    public static readonly bool CustomRoot = !string.IsNullOrEmpty(Environment.GetEnvironmentVariable("PJ_DATA_DIR"));
    public static string CatalogPath => Path.Combine(Root, "catalog.json");
    public static string ThumbsDir => Path.Combine(Root, "thumbs");
    public static string OptimizedDir => Path.Combine(Root, "optimized-media");
    public static string VideoSettingsPath => Path.Combine(Root, "video-settings.json");
    public static string WindowStatePath => Path.Combine(Root, "window.json");
    /// <summary>WebView2's own profile (cache, local storage). Kept out of the roaming catalog folder.</summary>
    public static string WebViewDataDir => CustomRoot
        ? Path.Combine(Root, "WebView2")
        : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "photos.jpeg", "WebView2");
    public static string BackupsDir => Path.Combine(Root, "backups");
    public static string RawCacheDir => Path.Combine(Root, "raw-cache");

    /// <summary>
    /// Where exports go until the user picks a folder: Pictures\photos.jpeg Exports — unless
    /// Windows' Controlled folder access is on, which stops apps it doesn't know from writing to
    /// Pictures. Then the default is a folder in the user profile, which is never protected.
    /// </summary>
    public static string DefaultExportDir => Path.Combine(
        ControlledFolderAccess()
            ? Environment.GetFolderPath(Environment.SpecialFolder.UserProfile)
            : Environment.GetFolderPath(Environment.SpecialFolder.MyPictures),
        "photos.jpeg Exports");

    /// <summary>True when Controlled folder access (ransomware protection) is switched on.</summary>
    public static bool ControlledFolderAccess()
    {
        try
        {
            using var k = Microsoft.Win32.Registry.LocalMachine.OpenSubKey(
                @"SOFTWARE\Microsoft\Windows Defender\Windows Defender Exploit Guard\Controlled Folder Access");
            return k?.GetValue("EnableControlledFolderAccess") is int v && v == 1;
        }
        catch { return false; }
    }

    static string ResolveRoot()
    {
        var custom = Environment.GetEnvironmentVariable("PJ_DATA_DIR");
        return !string.IsNullOrEmpty(custom)
            ? Path.GetFullPath(custom)
            : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "photos.jpeg");
    }

    public static void Prepare() => Directory.CreateDirectory(ThumbsDir);

    public static string Ext(string p) => Path.GetExtension(p).TrimStart('.').ToLowerInvariant();
    public static bool IsMedia(string p) => MediaExt.Contains(Ext(p));
    public static bool IsImage(string p) => ImageExt.Contains(Ext(p));

    /// <summary>Paths the page may read: catalog media, and optimized media made by this app.</summary>
    public static bool IsReadable(string p)
    {
        if (string.IsNullOrEmpty(p) || !Path.IsPathFullyQualified(p)) return false;
        return IsMedia(p) || Path.GetFullPath(p).StartsWith(OptimizedDir + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase);
    }

    // ---------------- scanning ----------------

    [DllImport("shlwapi.dll", CharSet = CharSet.Unicode)]
    static extern int StrCmpLogicalW(string a, string b);

    static double MtimeMs(FileInfo f) => (f.LastWriteTimeUtc - DateTime.UnixEpoch).Ticks / 10000.0;

    static FileDesc? Describe(string p)
    {
        try
        {
            var f = new FileInfo(p);
            return f.Exists ? new FileDesc(f.FullName, f.Name, f.Length, MtimeMs(f), f.DirectoryName ?? "") : null;
        }
        catch { return null; }
    }

    static void ScanDir(string dir, List<FileDesc> output, int depth)
    {
        if (depth > 12 || output.Count > 50000) return;
        FileSystemInfo[] entries;
        try { entries = new DirectoryInfo(dir).GetFileSystemInfos(); } catch { return; }
        Array.Sort(entries, (a, b) => StrCmpLogicalW(a.Name, b.Name));
        foreach (var e in entries)
        {
            if (e.Name.StartsWith('.') || (e.Attributes & (FileAttributes.Hidden | FileAttributes.System)) == (FileAttributes.Hidden | FileAttributes.System)) continue;
            if ((e.Attributes & FileAttributes.Directory) != 0)
            {
                if ((e.Attributes & FileAttributes.ReparsePoint) == 0) ScanDir(e.FullName, output, depth + 1);
            }
            else if (IsMedia(e.Name) && Describe(e.FullName) is { } d) output.Add(d);
        }
    }

    public static List<FileDesc> Scan(IEnumerable<string> paths)
    {
        var output = new List<FileDesc>();
        foreach (var p in paths)
        {
            if (string.IsNullOrWhiteSpace(p)) continue;
            try
            {
                if (Directory.Exists(p)) ScanDir(p, output, 0);
                else if (IsMedia(p) && Describe(p) is { } d) output.Add(d);
            }
            catch { /* unreadable: skip */ }
        }
        return output;
    }

    public static object? Stat(string p)
    {
        try
        {
            var f = new FileInfo(p);
            return f.Exists ? new { size = f.Length, mtime = MtimeMs(f) } : null;
        }
        catch { return null; }
    }

    // ---------------- writing ----------------

    public static void WriteAtomic(string file, byte[] data)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(file)!);
        // A unique temp name: the same thumbnail can be saved twice at once
        var tmp = $"{file}.{Guid.NewGuid():N}.tmp";
        File.WriteAllBytes(tmp, data);
        for (var attempt = 0; ; attempt++)
        {
            try { File.Move(tmp, file, true); return; }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                // the target is briefly open (being read, or replaced by a concurrent save)
                if (attempt == 5) { try { File.Delete(tmp); } catch { } throw; }
                Thread.Sleep(40 * (attempt + 1));
            }
        }
    }
    public static void WriteAtomic(string file, string text) => WriteAtomic(file, new UTF8Encoding(false).GetBytes(text));

    /// <summary>
    /// Where an export should be written, honouring the overwrite mode:
    /// "overwrite" replaces, "skip" returns null when the file exists, anything else picks name-2, name-3 …
    /// </summary>
    public static string? ResolveTarget(string target, string mode)
    {
        if (string.IsNullOrEmpty(target) || !Path.IsPathFullyQualified(target)) throw new IOException("Invalid export path");
        if (!WriteExt.Contains(Ext(target))) throw new IOException("Refusing to write this file type");
        var dir = Path.GetDirectoryName(target)!;
        try { Directory.CreateDirectory(dir); }
        catch (Exception ex) when (Blocked(ex, dir) is { } blocked) { throw blocked; }
        if (!File.Exists(target) || mode == "overwrite") return target;
        if (mode == "skip") return null;
        string ext = Path.GetExtension(target), stem = Path.GetFileNameWithoutExtension(target), candidate;
        var i = 2;
        do { candidate = Path.Combine(dir, $"{stem}-{i++}{ext}"); } while (File.Exists(candidate));
        return candidate;
    }

    public static string? WriteFile(string target, byte[] data, string mode)
    {
        var final = ResolveTarget(target, mode);
        if (final == null) return null;
        try { File.WriteAllBytes(final, data); }
        catch (Exception ex) when (Blocked(ex, final) is { } blocked) { throw blocked; }
        return final;
    }

    /// <summary>
    /// Import and Organize: copies (or moves) one media file into destDir under a new name, keeping
    /// its extension and taking its XMP sidecar along. An existing file is never replaced: the
    /// new one gets -2, -3 … Returns the path of the file in its new place.
    /// </summary>
    public static string ImportFile(string source, string destDir, string name, bool move)
    {
        if (!Path.IsPathFullyQualified(source) || !IsMedia(source) || !File.Exists(source)) throw new IOException("Not a media file");
        if (!Path.IsPathFullyQualified(destDir)) throw new IOException("Invalid destination folder");
        var ext = Path.GetExtension(source);
        var stem = string.Concat((name ?? "").Split(Path.GetInvalidFileNameChars())).Trim().TrimEnd('.');
        if (stem == "") stem = Path.GetFileNameWithoutExtension(source);
        if (stem.Length > 180) stem = stem[..180];
        try
        {
            Directory.CreateDirectory(destDir);
            var target = Path.Combine(destDir, stem + ext);
            // importing a file that is already where it should be, under the right name
            if (string.Equals(Path.GetFullPath(target), Path.GetFullPath(source), StringComparison.OrdinalIgnoreCase)) return source;
            for (var i = 2; File.Exists(target); i++) target = Path.Combine(destDir, $"{stem}-{i}{ext}");
            if (move) File.Move(source, target); else File.Copy(source, target, false);
            // the sidecar follows its photo: name.xmp or name.ext.xmp
            foreach (var side in new[] { Path.ChangeExtension(source, ".xmp"), source + ".xmp" })
            {
                if (!File.Exists(side)) continue;
                var sideTarget = side.EndsWith(ext + ".xmp", StringComparison.OrdinalIgnoreCase) ? target + ".xmp" : Path.ChangeExtension(target, ".xmp");
                try { if (!File.Exists(sideTarget)) { if (move) File.Move(side, sideTarget); else File.Copy(side, sideTarget, false); } }
                catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { /* the photo itself made it */ }
            }
            return target;
        }
        catch (Exception ex) when (Blocked(ex, destDir) is { } blocked) { throw blocked; }
    }

    /// <summary>
    /// Windows' Controlled folder access (ransomware protection) stops apps it doesn't know from
    /// writing to Documents, Pictures, Videos, Music and the Desktop, and reports it as "file not
    /// found" or "access denied". Returns an error that says what happened and what to do, or
    /// null when the failure is something else.
    /// </summary>
    public static IOException? Blocked(Exception ex, string path)
    {
        if (ex is not (FileNotFoundException or UnauthorizedAccessException)) return null;
        Environment.SpecialFolder[] guarded =
        [
            Environment.SpecialFolder.MyDocuments, Environment.SpecialFolder.MyPictures, Environment.SpecialFolder.MyVideos,
            Environment.SpecialFolder.MyMusic, Environment.SpecialFolder.DesktopDirectory, Environment.SpecialFolder.Favorites
        ];
        string full;
        try { full = Path.GetFullPath(path); } catch { return null; }
        foreach (var f in guarded)
        {
            var root = Environment.GetFolderPath(f);
            if (root == "" || !(full + Path.DirectorySeparatorChar).StartsWith(root.TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) continue;
            return new IOException(
                $"Windows blocked photos.jpeg from saving in {root}. Controlled folder access is protecting that folder: " +
                "open Windows Security → Virus & threat protection → Ransomware protection → Allow an app through " +
                "Controlled folder access and add photos.jpeg, or export to a different folder.");
        }
        return null;
    }

    // ---------------- catalog & thumbnails ----------------

    public static string? LoadCatalog()
    {
        foreach (var f in new[] { CatalogPath, CatalogPath + ".bak" })
        {
            try
            {
                var text = File.ReadAllText(f, Encoding.UTF8);
                using var _ = JsonDocument.Parse(text); // a truncated catalog falls through to the backup
                return text;
            }
            catch { /* try the backup */ }
        }
        return null;
    }

    static DateTime lastBackup = DateTime.MinValue;
    static readonly object catalogLock = new();

    /// <summary>The "version" number near the start of a catalog file, or 0.</summary>
    static int CatalogVersion(string head)
    {
        var m = System.Text.RegularExpressions.Regex.Match(head.Length > 400 ? head[..400] : head, "\"version\"\\s*:\\s*(\\d+)");
        return m.Success && int.TryParse(m.Groups[1].Value, out var v) ? v : 0;
    }

    static string Head(string file)
    {
        using var r = new StreamReader(file, Encoding.UTF8);
        var buf = new char[400];
        return new string(buf, 0, r.ReadBlock(buf, 0, buf.Length));
    }

    static bool dailyBackupDone;
    const int KeepBackups = 14;

    /// <summary>
    /// Before the first save of a session, the catalog as it was is copied to
    /// backups\catalog-YYYY-MM-DD.json (one per day, the newest 14 kept), so a session that goes
    /// wrong can always be undone by copying a dated backup over catalog.json.
    /// </summary>
    static void DailyBackup()
    {
        if (dailyBackupDone) return;
        dailyBackupDone = true;
        try
        {
            if (!File.Exists(CatalogPath)) return;
            var target = Path.Combine(BackupsDir, $"catalog-{DateTime.Now:yyyy-MM-dd}.json");
            if (File.Exists(target)) return;
            using (var _ = JsonDocument.Parse(File.ReadAllText(CatalogPath, Encoding.UTF8))) { } // never keep a damaged file as a backup
            Directory.CreateDirectory(BackupsDir);
            File.Copy(CatalogPath, target, false);
            foreach (var old in Directory.GetFiles(BackupsDir, "catalog-????-??-??.json").OrderDescending(StringComparer.Ordinal).Skip(KeepBackups))
            {
                try { File.Delete(old); } catch { /* next time */ }
            }
        }
        catch { /* backups are best effort; saving must go on */ }
    }

    public static void SaveCatalog(string json)
    {
        lock (catalogLock)
        {
            // A catalog written by a newer version of the app holds things this version would drop:
            // never replace it with an older format.
            try
            {
                if (File.Exists(CatalogPath) && CatalogVersion(Head(CatalogPath)) > CatalogVersion(json) && CatalogVersion(json) > 0)
                    throw new IOException("This catalog was saved by a newer version of photos.jpeg. Update the app to keep working on it; nothing was changed.");
            }
            catch (Exception ex) when (ex is UnauthorizedAccessException or FileNotFoundException) { /* unreadable: the save below reports it */ }
            DailyBackup();
            if (DateTime.UtcNow - lastBackup > TimeSpan.FromMinutes(10) && File.Exists(CatalogPath))
            {
                lastBackup = DateTime.UtcNow;
                try { File.Copy(CatalogPath, CatalogPath + ".bak", true); } catch { /* best effort */ }
            }
            WriteAtomic(CatalogPath, json);
        }
    }

    /// Catalog clean-up. Counts (and, when asked, removes) the files in the thumbnail store that no
    /// photo, mask or LUT of the catalog refers to any more, and the RAW cache. Files written in the
    /// last ten minutes are left alone: something may be about to refer to them.
    public static object CleanStore(IEnumerable<string> keepIds, bool remove, bool clearRaw)
    {
        var keep = new HashSet<string>(keepIds.Select(id => Path.GetFileName(ThumbPath(id))), StringComparer.OrdinalIgnoreCase);
        int orphans = 0, removed = 0, rawFiles = 0, rawRemoved = 0; long orphanBytes = 0, rawBytes = 0, thumbBytes = 0; int thumbs = 0;
        var cutoff = DateTime.UtcNow - TimeSpan.FromMinutes(10);
        if (Directory.Exists(ThumbsDir))
            foreach (var f in new DirectoryInfo(ThumbsDir).GetFiles())
            {
                thumbs++; thumbBytes += f.Length;
                if (keep.Contains(f.Name) || f.LastWriteTimeUtc > cutoff) continue;
                orphans++; orphanBytes += f.Length;
                if (remove) try { f.Delete(); removed++; } catch { /* in use: next time */ }
            }
        if (Directory.Exists(RawCacheDir))
            foreach (var f in new DirectoryInfo(RawCacheDir).GetFiles())
            {
                rawFiles++; rawBytes += f.Length;
                if (clearRaw) try { f.Delete(); rawRemoved++; } catch { /* in use */ }
            }
        return new { thumbs, thumbBytes, orphans, orphanBytes, removed, rawFiles, rawBytes, rawRemoved };
    }

    public static string ThumbPath(string id)
    {
        var safe = new StringBuilder(id.Length);
        foreach (var ch in id) safe.Append(char.IsAsciiLetterOrDigit(ch) || ch == '_' || ch == '-' ? ch : '_');
        if (safe.Length > 80) safe.Length = 80;
        return Path.Combine(ThumbsDir, safe + ".jpg");
    }

    // ---------------- developed-RAW cache ----------------

    /// <summary>Most disk space the cache may take; the least recently used files go first.</summary>
    const long RawCacheLimit = 3L << 30;
    static int rawCachePuts;

    static string RawCacheFile(string key) => Path.Combine(RawCacheDir,
        Convert.ToHexString(System.Security.Cryptography.SHA1.HashData(Encoding.UTF8.GetBytes(key)))[..24].ToLowerInvariant() + ".bin");

    /// <summary>A cached developed RAW (stored deflated), or null. Reading it marks it as recently used.</summary>
    public static byte[]? RawCacheGet(string key)
    {
        var file = RawCacheFile(key);
        try
        {
            if (!File.Exists(file)) return null;
            using var ms = new MemoryStream();
            using (var fs = File.OpenRead(file))
            using (var z = new System.IO.Compression.DeflateStream(fs, System.IO.Compression.CompressionMode.Decompress)) z.CopyTo(ms);
            try { File.SetLastWriteTimeUtc(file, DateTime.UtcNow); } catch { /* read-only volume */ }
            return ms.ToArray();
        }
        catch (Exception ex) when (ex is IOException or InvalidDataException or UnauthorizedAccessException)
        {
            try { File.Delete(file); } catch { /* a damaged entry is simply rebuilt */ }
            return null;
        }
    }

    public static void RawCachePut(string key, byte[] data)
    {
        try
        {
            Directory.CreateDirectory(RawCacheDir);
            var file = RawCacheFile(key);
            var tmp = $"{file}.{Guid.NewGuid():N}.tmp";
            using (var fs = File.Create(tmp))
            using (var z = new System.IO.Compression.DeflateStream(fs, System.IO.Compression.CompressionLevel.Fastest)) z.Write(data);
            File.Move(tmp, file, true);
            if (Interlocked.Increment(ref rawCachePuts) % 25 == 1) TrimRawCache();
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { /* the cache is optional */ }
    }

    static void TrimRawCache()
    {
        try
        {
            var files = new DirectoryInfo(RawCacheDir).GetFiles("*.bin").OrderByDescending(f => f.LastWriteTimeUtc).ToList();
            foreach (var stale in new DirectoryInfo(RawCacheDir).GetFiles("*.tmp").Where(f => DateTime.UtcNow - f.LastWriteTimeUtc > TimeSpan.FromHours(1)))
                try { stale.Delete(); } catch { }
            long total = 0;
            foreach (var f in files)
            {
                total += f.Length;
                if (total > RawCacheLimit) try { f.Delete(); } catch { /* in use */ }
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { }
    }

    // ---------------- XMP sidecars ----------------

    /// <summary>Only &lt;name&gt;.xmp / &lt;file&gt;.xmp next to a catalog media file.</summary>
    public static string? Sidecar(string op, string media, string variant, string text)
    {
        if (!Path.IsPathFullyQualified(media) || !IsMedia(media)) throw new IOException("Not a media file");
        var dir = Path.GetDirectoryName(media)!;
        var stem = variant == "full" ? Path.GetFileName(media) : Path.GetFileNameWithoutExtension(media);
        var file = Path.Combine(dir, stem + ".xmp"); // NTFS is case-insensitive: .XMP / .Xmp resolve to the same file
        if (op == "read") return File.Exists(file) ? File.ReadAllText(file, Encoding.UTF8) : null;
        if (op != "write" || text.Length > 8 << 20) throw new IOException("Bad sidecar request");
        // keep the existing file's spelling
        var existing = Directory.EnumerateFiles(dir, stem + ".xmp").FirstOrDefault();
        var target = existing ?? file;
        WriteAtomic(target, text);
        return target;
    }
}
