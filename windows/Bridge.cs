// photos.jpeg for Windows — JS ⇄ native bridge (window.chrome.webview).
// The page posts { id, method, args }; the answer is posted back as { id, result } or { id, error }.
// Native events go the other way as { event, payload }.
using System.Diagnostics;
using System.Text;
using System.Text.Json;
using Microsoft.Web.WebView2.Core;

namespace PhotosJpeg;

public sealed class Bridge
{
    readonly MainForm form;
    readonly CoreWebView2 web;
    readonly VideoTool video;

    /// <summary>Open streaming writes (video export). Only touched on the UI thread; the bytes are written off it.</summary>
    sealed class Writer(FileStream stream, string path) { public readonly FileStream Stream = stream; public readonly string Path = path; public long Pos; }
    readonly Dictionary<int, Writer> writers = [];
    FolderWatch? watch;
    int writerSeq;

    public Bridge(MainForm form, CoreWebView2 web)
    {
        this.form = form;
        this.web = web;
        var last = DateTime.MinValue;
        video = new VideoTool((jobId, frac, text) =>
        {
            if ((DateTime.UtcNow - last).TotalMilliseconds < 250 && frac < 1) return;
            last = DateTime.UtcNow;
            form.BeginInvoke(() => SendEvent("videoProgress", new { jobId, frac, text }));
        });
        web.WebMessageReceived += OnMessage;
    }

    public void SendEvent(string type, object? payload = null)
    {
        try { web.PostWebMessageAsJson(JsonSerializer.Serialize(new { @event = type, payload })); }
        catch { /* the view is closing */ }
    }

    async void OnMessage(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        int id = 0;
        try
        {
            using var doc = JsonDocument.Parse(e.WebMessageAsJson);
            var root = doc.RootElement.Clone();
            id = root.GetProperty("id").GetInt32();
            var method = root.GetProperty("method").GetString() ?? "";
            var args = root.TryGetProperty("args", out var a) && a.ValueKind == JsonValueKind.Object ? a : default;
            // Files dropped on the page arrive as objects that carry their real paths
            var dropped = e.AdditionalObjects?.OfType<CoreWebView2File>().Select(f => f.Path).Where(p => !string.IsNullOrEmpty(p)).ToList() ?? [];
            // Leave the event handler before doing anything that may pump messages (dialogs)
            await Task.Yield();
            var result = await Handle(method, args, dropped);
            web.PostWebMessageAsJson(JsonSerializer.Serialize(new { id, result }));
        }
        catch (Exception ex)
        {
            // expected refusals (a cancelled dialog is not one: that returns null) are worth a line, not a stack trace
            Log.Warn($"bridge call {id} failed: {(ex is IOException ? ex.Message : ex.ToString())}");
            try { web.PostWebMessageAsJson(JsonSerializer.Serialize(new { id, error = ex.Message })); } catch { /* closing */ }
        }
    }

    static string S(JsonElement a, string name, string fallback = "") =>
        a.ValueKind == JsonValueKind.Object && a.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() ?? fallback : fallback;
    static long N(JsonElement a, string name) =>
        a.ValueKind == JsonValueKind.Object && a.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Number ? (long)v.GetDouble() : 0;
    static byte[] Bytes(JsonElement a, string name) =>
        a.ValueKind == JsonValueKind.Object && a.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetBytesFromBase64() : throw new IOException("Bad data");
    static List<string> Strings(JsonElement a, string name) =>
        a.ValueKind == JsonValueKind.Object && a.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Array
            ? v.EnumerateArray().Where(x => x.ValueKind == JsonValueKind.String).Select(x => x.GetString()!).ToList() : [];

    async Task<object?> Handle(string method, JsonElement a, List<string> dropped)
    {
        switch (method)
        {
            // ---------------- import ----------------
            case "openFiles":
            {
                using var dlg = new OpenFileDialog { Title = "Import Photos", Multiselect = true, Filter = Storage.ImportFilter };
                if (dlg.ShowDialog(form) != DialogResult.OK) return Array.Empty<FileDesc>();
                var names = dlg.FileNames;
                return await Task.Run(() => Storage.Scan(names));
            }
            case "openFolder":
            {
                using var dlg = new FolderBrowserDialog { Description = "Import Folder", UseDescriptionForTitle = true, ShowNewFolderButton = false };
                if (dlg.ShowDialog(form) != DialogResult.OK) return new { folder = "", files = Array.Empty<FileDesc>() };
                var folder = dlg.SelectedPath;
                return new { folder, files = await Task.Run(() => Storage.Scan([folder])) };
            }
            case "scanPaths":
            {
                var paths = Strings(a, "paths");
                return await Task.Run(() => Storage.Scan(paths));
            }
            case "dropFiles":
                return await Task.Run(() => Storage.Scan(dropped));
            case "stat":
            {
                var p = S(a, "path");
                return await Task.Run(() => Storage.Stat(p));
            }
            case "fileSize":
            {
                var p = S(a, "path");
                return await Task.Run(() => { try { return new FileInfo(p).Length; } catch { return 0L; } });
            }

            // ---------------- catalog & thumbnails ----------------
            case "loadCatalog":
                return await Task.Run(Storage.LoadCatalog);
            case "saveCatalog":
            {
                var json = S(a, "json");
                if (json == "") return false;
                await Task.Run(() => Storage.SaveCatalog(json));
                return true;
            }
            case "saveThumb":
            {
                string id = S(a, "id"); var data = Bytes(a, "data");
                await Task.Run(() => Storage.WriteAtomic(Storage.ThumbPath(id), data));
                return true;
            }
            case "listBackups": return await Task.Run(Storage.ListBackups);
            case "backupNow": return await Task.Run(() => Storage.BackupNow());
            case "restoreBackup": { var name = S(a, "name"); return await Task.Run(() => Storage.RestoreBackup(name)); }
            case "moveFile":
            {
                string source = S(a, "path"), dest = S(a, "dest"), name = S(a, "name");
                return await Task.Run(() => Storage.MoveFile(source, dest, name));
            }
            case "watchFolder":
            {
                var folder = S(a, "path");
                watch?.Dispose(); watch = null;
                if (folder.Length == 0) return new { watching = "" };
                if (!Directory.Exists(folder)) throw new IOException("That folder is not there");
                watch = new FolderWatch(folder, paths => form.BeginInvoke(() => SendEvent("watchFiles", new { paths })));
                return new { watching = folder };
            }
            case "modelStatus": return Models.Status();
            case "modelFetch":
            {
                var name = S(a, "name");
                return await Models.Fetch(name, f => form.BeginInvoke(() => SendEvent("modelProgress", new { name, frac = f })));
            }
            case "cleanStore":
            {
                var keep = Strings(a, "keep");
                bool remove = a.TryGetProperty("remove", out var r) && r.ValueKind == JsonValueKind.True;
                bool raw = a.TryGetProperty("raw", out var w) && w.ValueKind == JsonValueKind.True;
                return await Task.Run(() => Storage.CleanStore(keep, remove, raw));
            }
            case "deleteThumb":
            {
                var id = S(a, "id");
                await Task.Run(() => { try { File.Delete(Storage.ThumbPath(id)); } catch { /* not there */ } });
                return true;
            }

            // ---------------- export ----------------
            case "chooseDirectory":
            {
                var start = S(a, "path");
                using var dlg = new FolderBrowserDialog { Description = "Choose Export Folder", UseDescriptionForTitle = true, ShowNewFolderButton = true };
                dlg.InitialDirectory = Directory.Exists(start) ? start : Environment.GetFolderPath(Environment.SpecialFolder.MyPictures);
                return dlg.ShowDialog(form) == DialogResult.OK ? dlg.SelectedPath : null;
            }
            case "defaultExportDir":
                return Storage.DefaultExportDir;
            case "writeFile":
            {
                string path = S(a, "path"), mode = S(a, "mode", "unique"); var data = Bytes(a, "data");
                return await Task.Run(() => Storage.WriteFile(path, data, mode));
            }
            case "openWrite":
            {
                string path = S(a, "path"), mode = S(a, "mode", "unique");
                var target = await Task.Run(() => Storage.ResolveTarget(path, mode));
                if (target == null) return null;
                FileStream fs;
                try { fs = new FileStream(target, FileMode.Create, FileAccess.Write, FileShare.Read, 1 << 16, FileOptions.Asynchronous); }
                catch (Exception ex) when (Storage.Blocked(ex, target) is { } blocked) { throw blocked; }
                writers[++writerSeq] = new Writer(fs, target);
                return writerSeq;
            }
            case "writeChunk":
            case "writeAt":
            {
                if (!writers.TryGetValue((int)N(a, "handle"), out var w)) throw new IOException("File is not open");
                var data = Bytes(a, "data");
                long offset;
                // Offsets are assigned here, in arrival order, so the writes themselves may finish in any order
                if (method == "writeAt") offset = N(a, "offset"); else { offset = w.Pos; w.Pos += data.Length; }
                await RandomAccess.WriteAsync(w.Stream.SafeFileHandle, data, offset);
                return true;
            }
            case "closeWrite":
            {
                if (!writers.Remove((int)N(a, "handle"), out var w)) return null;
                await w.Stream.DisposeAsync();
                return w.Path;
            }
            case "abortWrite":
            {
                // an export that failed part-way: close the file and remove what was written
                if (!writers.Remove((int)N(a, "handle"), out var w)) return null;
                await w.Stream.DisposeAsync();
                try { File.Delete(w.Path); } catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { /* left behind */ }
                return true;
            }
            case "importFile":
            {
                string source = S(a, "path"), dest = S(a, "dest"), name = S(a, "name");
                var move = a.TryGetProperty("move", out var mv) && mv.ValueKind == JsonValueKind.True;
                return await Task.Run(() => Storage.ImportFile(source, dest, name, move));
            }
            case "showInFolder":
            {
                var p = S(a, "path");
                if (File.Exists(p)) Process.Start(new ProcessStartInfo("explorer.exe", $"/select,\"{p}\"") { UseShellExecute = false });
                else if (Directory.Exists(p)) Process.Start(new ProcessStartInfo(p) { UseShellExecute = true });
                return true;
            }

            // ---------------- sidecars, presets, LUTs ----------------
            case "sidecar":
            {
                string op = S(a, "op"), media = S(a, "path"), variant = S(a, "variant", "base"), text = S(a, "text");
                return await Task.Run(() => Storage.Sidecar(op, media, variant, text));
            }
            case "savePresetFile":
            {
                var json = S(a, "json");
                using var dlg = new SaveFileDialog { Title = "Export Preset", FileName = S(a, "name", "preset.json"), Filter = "photos.jpeg preset|*.json", DefaultExt = "json" };
                if (dlg.ShowDialog(form) != DialogResult.OK) return false;
                File.WriteAllText(dlg.FileName, json, new UTF8Encoding(false));
                return true;
            }
            case "openPresetFiles":
            {
                using var dlg = new OpenFileDialog { Title = "Import Presets", Multiselect = true, Filter = "Presets|*.json;*.pjpreset" };
                if (dlg.ShowDialog(form) != DialogResult.OK) return Array.Empty<string>();
                return dlg.FileNames.Select(f => File.ReadAllText(f, Encoding.UTF8)).ToList();
            }
            case "openTextFiles":
            {
                var exts = Strings(a, "exts").Where(Storage.TextExt.Contains).ToList();
                if (exts.Count == 0) return Array.Empty<object>();
                var pattern = string.Join(';', exts.Select(x => "*." + x));
                using var dlg = new OpenFileDialog { Title = S(a, "title", "Open"), Multiselect = true, Filter = $"{string.Join(", ", exts.Select(x => "." + x))}|{pattern}" };
                if (dlg.ShowDialog(form) != DialogResult.OK) return Array.Empty<object>();
                var output = new List<object>();
                foreach (var f in dlg.FileNames)
                {
                    if (!exts.Contains(Storage.Ext(f)) || new FileInfo(f).Length > 64 << 20) continue;
                    output.Add(new { name = Path.GetFileName(f), text = File.ReadAllText(f, Encoding.UTF8) });
                }
                return output;
            }
            case "saveTextFile":
            {
                string ext = S(a, "ext"), text = S(a, "text");
                if (!Storage.TextExt.Contains(ext)) throw new IOException("Refusing to write this file type");
                using var dlg = new SaveFileDialog { Title = "Save", FileName = S(a, "name", "untitled." + ext), Filter = $".{ext}|*.{ext}", DefaultExt = ext };
                if (dlg.ShowDialog(form) != DialogResult.OK) return null;
                var target = Storage.Ext(dlg.FileName) == ext ? dlg.FileName : dlg.FileName + "." + ext;
                File.WriteAllText(target, text, new UTF8Encoding(false));
                return target;
            }

            // ---------------- video ----------------
            case "videoTool":
            {
                switch (S(a, "op"))
                {
                    case "capabilities": return await Task.Run(video.Capabilities);
                    case "proxy":
                    {
                        string path = S(a, "path"), job = S(a, "jobId", Guid.NewGuid().ToString());
                        return await Task.Run(() => video.Proxy(path, job));
                    }
                    case "cancel": video.Cancel(S(a, "jobId")); return true;
                    case "getSettings": return VideoTool.ReadSettings();
                    case "setSettings":
                    {
                        var text = a.TryGetProperty("settings", out var s) && s.ValueKind == JsonValueKind.Object
                            ? JsonSerializer.Serialize(s, new JsonSerializerOptions { WriteIndented = true }) : "{}";
                        Storage.WriteAtomic(Storage.VideoSettingsPath, text);
                        return true;
                    }
                    default: throw new IOException("Unknown video op " + S(a, "op"));
                }
            }

            // ---------------- lifecycle ----------------
            case "ready": form.RendererReady(); return true;
            case "log":
            {
                // errors the editor reports about itself
                var level = S(a, "level", "error");
                Log.Write(level == "warn" ? "warn" : level == "info" ? "info" : "ERROR", "[editor] " + S(a, "text"));
                return true;
            }
            case "showLog":
            {
                Log.Info("log opened from the Help menu");
                Process.Start(new ProcessStartInfo(Log.File_) { UseShellExecute = true });
                return true;
            }
            case "checkForUpdates": form.BeginInvoke(() => form.CheckForUpdates(true)); return true;
            case "exportPresets":
            {
                var items = new List<(string Id, string Name)>();
                if (a.TryGetProperty("items", out var arr) && arr.ValueKind == JsonValueKind.Array)
                    foreach (var it in arr.EnumerateArray()) items.Add((S(it, "id"), S(it, "name")));
                form.SetExportPresets(items);
                return true;
            }
            case "flushed": form.Flushed(); return true;
            case "closeHold": form.HoldClose(); return true;
            case "closeNow": form.CloseNow(); return true;
            case "representedFile":
            case "backResult": return true;

            default: throw new IOException("Unknown method " + method);
        }
    }
}
