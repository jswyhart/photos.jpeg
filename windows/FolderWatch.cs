namespace PhotosJpeg;

/// <summary>
/// Watches one folder (and the folders inside it) for new photos and clips, so they can be added to the
/// catalog as a camera, a phone sync or a tethering program drops them there. A file is reported once it
/// has stopped changing and can be opened — not while it is still being written.
/// </summary>
sealed class FolderWatch : IDisposable
{
    readonly FileSystemWatcher watcher;
    readonly System.Threading.Timer timer;
    readonly Dictionary<string, DateTime> pending = new(StringComparer.OrdinalIgnoreCase);
    readonly Action<string[]> report;
    readonly object gate = new();

    public string Folder { get; }

    public FolderWatch(string folder, Action<string[]> report)
    {
        Folder = folder; this.report = report;
        timer = new System.Threading.Timer(_ => Settle(), null, Timeout.Infinite, Timeout.Infinite);
        watcher = new FileSystemWatcher(folder)
        {
            IncludeSubdirectories = true,
            NotifyFilter = NotifyFilters.FileName | NotifyFilters.LastWrite | NotifyFilters.Size,
            InternalBufferSize = 64 * 1024
        };
        watcher.Created += (_, e) => Seen(e.FullPath);
        watcher.Changed += (_, e) => Seen(e.FullPath);
        watcher.Renamed += (_, e) => Seen(e.FullPath);
        watcher.EnableRaisingEvents = true;
    }

    void Seen(string path)
    {
        if (!Storage.IsMedia(path)) return;
        lock (gate) { pending[path] = DateTime.UtcNow; }
        timer.Change(1500, Timeout.Infinite);
    }

    void Settle()
    {
        var ready = new List<string>(); var later = false;
        lock (gate)
        {
            foreach (var (path, at) in pending.ToArray())
            {
                if ((DateTime.UtcNow - at).TotalMilliseconds < 1200) { later = true; continue; }
                if (!File.Exists(path)) { pending.Remove(path); continue; }
                try { using var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.None); if (fs.Length == 0) { later = true; continue; } }
                catch (IOException) { later = true; continue; }                    // still being written
                catch (UnauthorizedAccessException) { pending.Remove(path); continue; }
                pending.Remove(path); ready.Add(path);
            }
        }
        if (ready.Count > 0) { try { report([.. ready]); } catch { /* the window is closing */ } }
        if (later) timer.Change(1500, Timeout.Infinite);
    }

    public void Dispose() { watcher.Dispose(); timer.Dispose(); }
}
