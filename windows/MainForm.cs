// photos.jpeg for Windows — main window: menus, the web view that hosts the editor, lifecycle.
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text.Json;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace PhotosJpeg;

public sealed class MainForm : Form
{
    public static readonly string Version = typeof(MainForm).Assembly.GetName().Version?.ToString(3) ?? "";
    static readonly Color Background = Color.FromArgb(0x11, 0x12, 0x14);

    readonly WebView2 web = new() { Dock = DockStyle.Fill, DefaultBackgroundColor = Background };
    readonly MenuStrip menu = new() { Dock = DockStyle.Top };
    readonly ToolStripMenuItem exportPresetMenu = new("Export with Preset") { Enabled = false };
    readonly ToolStripMenuItem updateItem = new("Check for Updates…");
    Bridge? bridge;
    bool rendererReady, flushed, closing;
    readonly List<string> pendingOpen = [];

    // full screen
    bool fullScreen;
    FormWindowState savedState;
    Rectangle savedBounds;

    public MainForm(IEnumerable<string> openPaths)
    {
        Text = "photos.jpeg";
        BackColor = Background;
        MinimumSize = new Size(980, 640);
        Icon = Icon.ExtractAssociatedIcon(Environment.ProcessPath!);
        StartPosition = FormStartPosition.Manual;
        RestoreWindowState();
        BuildMenu();
        Controls.Add(web);
        Controls.Add(menu);
        MainMenuStrip = menu;
        pendingOpen.AddRange(openPaths);
        web.KeyDown += OnAcceleratorKey;
    }

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        int on = 1;
        DwmSetWindowAttribute(Handle, 20 /* DWMWA_USE_IMMERSIVE_DARK_MODE */, ref on, sizeof(int));
    }

    protected override async void OnLoad(EventArgs e)
    {
        base.OnLoad(e);
        try { await StartWebView(); }
        catch (Exception ex)
        {
            MessageBox.Show(this,
                "photos.jpeg needs the Microsoft Edge WebView2 Runtime, which is part of Windows 11 and current Windows 10.\n\n" +
                "Install it from https://developer.microsoft.com/microsoft-edge/webview2/ and start photos.jpeg again.\n\n" + ex.Message,
                "photos.jpeg", MessageBoxButtons.OK, MessageBoxIcon.Error);
            flushed = true;
            Close();
        }
    }

    async Task StartWebView()
    {
        Storage.Prepare();
        var options = new CoreWebView2EnvironmentOptions
        {
            AdditionalBrowserArguments = string.Join(' ',
                // Graded clips play (with sound) without an extra click
                "--autoplay-policy=no-user-gesture-required",
                // PCs with two graphics adapters (laptops, desktops with an integrated GPU): render and
                // run the WebGL previews on the fast one
                "--force_high_performance_gpu",
                // HEVC export through the graphics card's encoder (NVENC, Quick Sync, AMF)
                "--enable-features=PlatformHEVCEncoderSupport")
        };
        var env = await CoreWebView2Environment.CreateAsync(null, Storage.WebViewDataDir, options);
        await web.EnsureCoreWebView2Async(env);
        Log.Info($"photos.jpeg {Updater.Current.ToString(3)} started — Windows {Environment.OSVersion.Version}, WebView2 {env.BrowserVersionString}, {Environment.ProcessorCount} logical processors, data in {Storage.Root}");
        // The page titles itself "<photo> — photos.jpeg": show that in the title bar, taskbar and Alt+Tab
        web.CoreWebView2.DocumentTitleChanged += (_, _) =>
        {
            var title = web.CoreWebView2.DocumentTitle;
            Text = string.IsNullOrWhiteSpace(title) || title.StartsWith("http", StringComparison.OrdinalIgnoreCase) ? "photos.jpeg" : title;
        };
        var core = web.CoreWebView2;

        var s = core.Settings;
        s.AreDefaultContextMenusEnabled = false;      // the editor has its own
        s.AreBrowserAcceleratorKeysEnabled = false;   // F5, Ctrl+R, Ctrl+P … belong to the editor
        s.IsStatusBarEnabled = false;
        s.IsZoomControlEnabled = false;
        s.IsPinchZoomEnabled = false;
        s.IsSwipeNavigationEnabled = false;
        s.IsGeneralAutofillEnabled = false;
        s.IsPasswordAutosaveEnabled = false;
        s.IsBuiltInErrorPageEnabled = false;

        await core.AddScriptToExecuteOnDocumentCreatedAsync(
            $"window.__pjInfo = {{ version: {JsonSerializer.Serialize(Version)}, platform: 'windows' }};");

        new ResourceServer(core, Version).Attach();
        bridge = new Bridge(this, core);

        // Keep navigation inside the app; open external links in the browser.
        core.NavigationStarting += (_, e) =>
        {
            if (e.Uri.StartsWith(ResourceServer.Origin + "/", StringComparison.OrdinalIgnoreCase)) return;
            e.Cancel = true;
            OpenExternal(e.Uri);
        };
        core.NewWindowRequested += (_, e) => { e.Handled = true; OpenExternal(e.Uri); };
        core.ProcessFailed += (_, e) =>
        {
            Log.Error($"web view process failed: {e.ProcessFailedKind}, reason {e.Reason}, exit code {e.ExitCode}, {e.ProcessDescription}");
            if (e.ProcessFailedKind == CoreWebView2ProcessFailedKind.RenderProcessExited && !closing) { rendererReady = false; core.Reload(); }
        };
        core.Navigate(ResourceServer.Origin + "/index.html");
    }

    static void OpenExternal(string url)
    {
        if (url.StartsWith("http://", StringComparison.OrdinalIgnoreCase) || url.StartsWith("https://", StringComparison.OrdinalIgnoreCase))
            try { Process.Start(new ProcessStartInfo(url) { UseShellExecute = true }); } catch { /* no browser */ }
    }

    // ---------------- bridge callbacks ----------------

    // ---------------- camera cards ----------------

    const int WM_DEVICECHANGE = 0x0219, DBT_DEVICEARRIVAL = 0x8000;
    readonly HashSet<string> cardsSeen = new(StringComparer.OrdinalIgnoreCase);
    readonly System.Windows.Forms.Timer cardTimer = new() { Interval = 1500 };

    protected override void WndProc(ref Message m)
    {
        // a drive appeared: give Windows a moment to mount it, then look for a camera card
        if (m.Msg == WM_DEVICECHANGE && m.WParam == DBT_DEVICEARRIVAL) { cardTimer.Stop(); cardTimer.Start(); }
        base.WndProc(ref m);
    }

    /// <summary>
    /// Removable drives with a DCIM folder — what a camera or its card looks like. Each is
    /// announced to the editor once per session (PJ_CARD_ROOTS lists extra folders to treat as cards, for testing).
    /// </summary>
    void LookForCards()
    {
        cardTimer.Stop();
        if (!rendererReady) return;
        var roots = new List<(string Path, string Label)>();
        try
        {
            foreach (var d in DriveInfo.GetDrives())
            {
                if (d.DriveType != DriveType.Removable || !d.IsReady) continue;
                if (Directory.Exists(Path.Combine(d.RootDirectory.FullName, "DCIM"))) roots.Add((d.RootDirectory.FullName, string.IsNullOrWhiteSpace(d.VolumeLabel) ? d.Name.TrimEnd('\\') : $"{d.VolumeLabel} ({d.Name.TrimEnd('\\')})"));
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { Log.Warn("looking for camera cards: " + ex.Message); }
        foreach (var extra in (Environment.GetEnvironmentVariable("PJ_CARD_ROOTS") ?? "").Split(';', StringSplitOptions.RemoveEmptyEntries))
            if (Directory.Exists(Path.Combine(extra, "DCIM"))) roots.Add((extra, Path.GetFileName(extra.TrimEnd('\\'))));
        foreach (var (path, label) in roots)
        {
            if (!cardsSeen.Add(path)) continue;
            Log.Info("camera card found: " + path);
            bridge?.SendEvent("card", new { path = Path.Combine(path, "DCIM"), label });
        }
    }

    public void RendererReady()
    {
        rendererReady = true;
        cardTimer.Tick -= OnCardTimer; cardTimer.Tick += OnCardTimer;
        cardTimer.Start();                       // a card that was already in when the app started
        if (Updater.DueForCheck()) CheckForUpdates(false);
        if (pendingOpen.Count > 0) { bridge?.SendEvent("openPaths", pendingOpen.ToArray()); pendingOpen.Clear(); }
    }

    void OnCardTimer(object? sender, EventArgs e) => LookForCards();

    /// <summary>"Open with", a second launch, or files dragged onto the exe.</summary>
    public void OpenPaths(IReadOnlyCollection<string> paths)
    {
        if (paths.Count > 0)
        {
            if (rendererReady) bridge?.SendEvent("openPaths", paths); else pendingOpen.AddRange(paths);
        }
        if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal;
        Activate();
    }

    public void Flushed()
    {
        if (!closing || flushed) return;
        flushed = true;
        BeginInvoke(Close);
    }

    // ---------------- closing: let the catalog flush first ----------------

    protected override void OnFormClosing(FormClosingEventArgs e)
    {
        if (!fullScreen) SaveWindowState();
        if (!flushed && rendererReady && bridge != null)
        {
            e.Cancel = true;
            if (closing) return;
            closing = true;
            bridge.SendEvent("flush");
            var timer = new System.Windows.Forms.Timer { Interval = 2500 };
            timer.Tick += (_, _) => { timer.Dispose(); if (!flushed) { flushed = true; Close(); } };
            timer.Start();
            return;
        }
        base.OnFormClosing(e);
    }

    // ---------------- window state ----------------

    void RestoreWindowState()
    {
        var area = Screen.PrimaryScreen!.WorkingArea;
        Size = new Size(Math.Min(1600, area.Width), Math.Min(1000, area.Height));
        Location = new Point(area.X + (area.Width - Width) / 2, area.Y + (area.Height - Height) / 2);
        try
        {
            using var doc = JsonDocument.Parse(File.ReadAllText(Storage.WindowStatePath));
            var r = doc.RootElement;
            var b = new Rectangle(r.GetProperty("x").GetInt32(), r.GetProperty("y").GetInt32(), r.GetProperty("width").GetInt32(), r.GetProperty("height").GetInt32());
            if (b.Width > 600 && b.Height > 400 && Screen.AllScreens.Any(sc => sc.WorkingArea.IntersectsWith(b))) Bounds = b;
            if (r.TryGetProperty("maximized", out var m) && m.ValueKind == JsonValueKind.True) WindowState = FormWindowState.Maximized;
        }
        catch { /* first run */ }
    }

    void SaveWindowState()
    {
        try
        {
            var b = WindowState == FormWindowState.Normal ? Bounds : RestoreBounds;
            Directory.CreateDirectory(Storage.Root);
            File.WriteAllText(Storage.WindowStatePath, JsonSerializer.Serialize(new { x = b.X, y = b.Y, width = b.Width, height = b.Height, maximized = WindowState == FormWindowState.Maximized }));
        }
        catch { /* best effort */ }
    }

    void ToggleFullScreen()
    {
        fullScreen = !fullScreen;
        if (fullScreen)
        {
            savedState = WindowState; savedBounds = Bounds;
            menu.Visible = false;
            WindowState = FormWindowState.Normal;
            FormBorderStyle = FormBorderStyle.None;
            Bounds = Screen.FromControl(this).Bounds;
        }
        else
        {
            FormBorderStyle = FormBorderStyle.Sizable;
            menu.Visible = true;
            Bounds = savedBounds;
            WindowState = savedState;
        }
    }

    // ---------------- menu ----------------

    void Send(string cmd) => bridge?.SendEvent("menu", cmd);

    /// <summary>
    /// Shortcuts are handled by the editor (so they respect text fields and tools); the menu only
    /// displays them. The few the editor doesn't handle itself are in OnAcceleratorKey.
    /// </summary>
    static ToolStripMenuItem Item(string label, Action action, string? shortcut = null)
    {
        var item = new ToolStripMenuItem(label) { ShortcutKeyDisplayString = shortcut };
        item.Click += (_, _) => action();
        return item;
    }
    ToolStripMenuItem Cmd(string label, string cmd, string? shortcut = null) => Item(label, () => Send(cmd), shortcut);
    static ToolStripMenuItem Sub(string label, params ToolStripItem[] items)
    {
        var m = new ToolStripMenuItem(label);
        m.DropDownItems.AddRange(items);
        return m;
    }
    static ToolStripSeparator Sep() => new();

    /// <summary>
    /// Help → Check for Updates. The quiet check (once a day at start-up) only says something when a
    /// newer version exists; the menu command always answers.
    /// </summary>
    public async void CheckForUpdates(bool interactive)
    {
        const string title = "photos.jpeg";
        var current = Updater.Current.ToString(3);
        if (!Updater.Configured)
        {
            if (interactive) MessageBox.Show(this, $"This is photos.jpeg {current}.\n\nThis build has no update address set, so it can't check for newer versions.", title, MessageBoxButtons.OK, MessageBoxIcon.Information);
            return;
        }
        UpdateInfo? info;
        try { info = await Updater.Check(); }
        catch (Exception ex)
        {
            if (interactive) MessageBox.Show(this, "Couldn't check for updates.\n\n" + ex.Message, title, MessageBoxButtons.OK, MessageBoxIcon.Warning);
            return;
        }
        if (IsDisposed) return;
        if (info == null)
        {
            if (interactive) MessageBox.Show(this, $"photos.jpeg {current} is the latest version.", title, MessageBoxButtons.OK, MessageBoxIcon.Information);
            return;
        }
        updateItem.Text = $"Install Update {info.Version}…";
        if (!interactive)
        {
            bridge?.SendEvent("notice", $"photos.jpeg {info.Version} is available — Help → Install Update");
            return;
        }
        var notes = string.IsNullOrWhiteSpace(info.Notes) ? "" : info.Notes.Trim() + "\n\n";
        if (MessageBox.Show(this, $"photos.jpeg {info.Version} is available (you have {current}).\n\n{notes}Download and install it now? photos.jpeg closes and reopens when it is done.",
                title, MessageBoxButtons.YesNo, MessageBoxIcon.Question) != DialogResult.Yes) return;
        var shown = Text;
        try
        {
            updateItem.Enabled = false;
            var file = await Updater.Download(info, p => { if (!IsDisposed) BeginInvoke(() => Text = $"Downloading update… {p:P0}"); });
            Updater.Install(file);
            Close(); // the catalog is flushed first; Setup waits for the app to be gone
        }
        catch (Exception ex)
        {
            Text = shown;
            updateItem.Enabled = true;
            MessageBox.Show(this, "The update could not be installed.\n\n" + ex.Message, title, MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
    }

    /// <summary>File → Export with Preset: the editor's built-in and saved export presets, one click each.</summary>
    public void SetExportPresets(List<(string Id, string Name)> presets)
    {
        exportPresetMenu.DropDownItems.Clear();
        foreach (var (id, name) in presets)
        {
            if (id.StartsWith('u') && exportPresetMenu.DropDownItems.Count > 0 && !presets.TakeWhile(p => p.Id != id).Any(p => p.Id.StartsWith('u')))
                exportPresetMenu.DropDownItems.Add(Sep());
            exportPresetMenu.DropDownItems.Add(Cmd(name.Replace("&", "&&"), "exportPreset:" + id));
        }
        exportPresetMenu.Enabled = presets.Count > 0;
    }

    void BuildMenu()
    {
        menu.Renderer = new DarkMenuRenderer();
        updateItem.Click += (_, _) => CheckForUpdates(true);
        menu.BackColor = DarkColors.Bar;
        menu.ForeColor = DarkColors.Text;
        menu.Items.AddRange([
            Sub("&File",
                Cmd("Import Photos…", "import", "Ctrl+Shift+I"),
                Cmd("Import Folder…", "importFolder", "Ctrl+Shift+O"),
                Cmd("Import and Organize…", "importOrganize"),
                Sep(),
                Cmd("Export…", "export", "Ctrl+Shift+E"),
                Cmd("Export with Previous", "exportPrevious", "Ctrl+Alt+Shift+E"),
                exportPresetMenu,
                Sep(),
                Cmd("Print…", "print", "Ctrl+P"),
                Sep(),
                Cmd("Show in Folder", "showInFolder"),
                Sep(),
                Cmd("Read Metadata from Files (XMP)", "xmpRead"),
                Cmd("Save Metadata to Files (XMP)", "xmpWrite", "Ctrl+S"),
                Cmd("Slideshow", "slideshow", "Ctrl+Enter"),
                Sep(),
                Cmd("Remove from Catalog", "remove", "Delete"),
                Sep(),
                Cmd("Preferences…", "preferences", "Ctrl+,"),
                Sep(),
                Item("Exit", Close, "Alt+F4")),
            Sub("&Edit",
                Cmd("Undo", "undo", "Ctrl+Z"),
                Cmd("Redo", "redo", "Ctrl+Shift+Z"),
                Sep(),
                Item("Cut", () => Exec("cut"), "Ctrl+X"),
                Item("Copy", () => Exec("copy"), "Ctrl+C"),
                Item("Paste", () => Exec("paste"), "Ctrl+V"),
                Sep(),
                Cmd("Select All", "selectAll", "Ctrl+A"),
                Cmd("Select None", "deselect", "Ctrl+D"),
                Sep(),
                Cmd("Copy Settings…", "copySettings", "Ctrl+Shift+C"),
                Cmd("Paste Settings", "pasteSettings", "Ctrl+Shift+V"),
                Cmd("Sync Settings…", "syncSettings", "Ctrl+Shift+S")),
            Sub("&Photo",
                Cmd("Create Virtual Copy", "virtualCopy", "Ctrl+'"),
                Sub("Stacking", Cmd("Group into Stack", "stack"), Cmd("Unstack", "unstack"), Cmd("Open / Close Stack", "toggleStack"), Sep(), Cmd("Auto-Stack Bursts and RAW + JPEG Pairs", "autoStack")),
                Sep(),
                Cmd("Rotate Left", "rotateLeft", "Ctrl+["),
                Cmd("Rotate Right", "rotateRight", "Ctrl+]"),
                Cmd("Flip Horizontal", "flipH"),
                Cmd("Flip Vertical", "flipV"),
                Sep(),
                Sub("Set Rating", [.. Enumerable.Range(0, 6).Select(n => Cmd(n == 0 ? "None" : new string('★', n), $"rating:{n}", n.ToString()))]),
                Sub("Set Flag", Cmd("Pick", "flag:1", "P"), Cmd("Unflagged", "flag:0", "U"), Cmd("Reject", "flag:-1", "X")),
                Sub("Color Label", Cmd("Red", "label:red", "6"), Cmd("Yellow", "label:yellow", "7"), Cmd("Green", "label:green", "8"),
                    Cmd("Blue", "label:blue", "9"), Cmd("Purple", "label:purple"), Cmd("None", "label:")),
                Sep(),
                Cmd("Auto Tone", "autoTone", "Ctrl+Shift+U"),
                Cmd("Apply Lens Profile", "lensProfile"),
                Cmd("Reset Develop Settings", "reset", "Ctrl+Shift+R"),
                Sep(),
                Cmd("New Snapshot…", "newSnapshot", "Ctrl+N"),
                Cmd("New Develop Preset…", "newPreset", "Ctrl+Shift+N")),
            Sub("&Tools",
                Cmd("Crop && Straighten", "crop", "R"),
                Cmd("Spot Removal", "spot", "Q"),
                Cmd("Masking", "mask", "M"),
                Sep(),
                Cmd("Find Duplicates…", "duplicates")),
            Sub("&View",
                Cmd("Library", "library", "G"),
                Cmd("Develop", "develop", "D"),
                Cmd("Map", "map"),
                Sep(),
                Cmd("Compare Selected Photos", "compare"),
                Cmd("Merge to HDR…", "mergeHdr"),
                Cmd("Merge to Panorama…", "mergePano"),
                Cmd("Before / After", "beforeAfter", "Y"),
                Cmd("Show Clipping", "clipping", "J"),
                Cmd("Zoom to Fit", "zoomFit", "Ctrl+0"),
                Cmd("Zoom 100%", "zoom100", "Ctrl+1"),
                Sep(),
                Cmd("Toggle Side Panels", "togglePanels", "Tab"),
                Cmd("Toggle All Panels", "toggleAllPanels", "Shift+Tab"),
                Item("Toggle Full Screen", ToggleFullScreen, "F11"),
                Sep(),
                Item("Developer Tools", () => web.CoreWebView2?.OpenDevToolsWindow(), "F12")),
            Sub("&Help",
                Cmd("Keyboard Shortcuts", "shortcuts", "Ctrl+/"),
                Cmd("About photos.jpeg", "about"),
                updateItem,
Cmd("Clean Up Catalog…", "cleanCatalog"),
                Item("Show Log", () => { Log.Info("log opened from the Help menu"); try { Process.Start(new ProcessStartInfo(Log.File_) { UseShellExecute = true }); } catch (Exception ex) { Log.Error("opening the log", ex); } }),
                Item("Open Catalog Folder", () => Process.Start(new ProcessStartInfo(Storage.Root) { UseShellExecute = true })))
        ]);
    }

    /// <summary>Clipboard commands act on whatever has focus in the page.</summary>
    void Exec(string command)
    {
        web.Focus();
        _ = web.CoreWebView2?.ExecuteScriptAsync($"document.execCommand('{command}')");
    }

    /// <summary>Key combinations the web view reports as accelerators and the editor doesn't handle itself.</summary>
    void OnAcceleratorKey(object? sender, KeyEventArgs e)
    {
        string? cmd = null;
        if (e.KeyCode == Keys.F11) { ToggleFullScreen(); e.Handled = true; return; }
        if (e.KeyCode == Keys.F12) { web.CoreWebView2?.OpenDevToolsWindow(); e.Handled = true; return; }
        if (e.KeyCode == Keys.Escape && fullScreen) { ToggleFullScreen(); return; }
        if (e.Control && e.Shift && !e.Alt && e.KeyCode == Keys.O) cmd = "importFolder";
        else if (e.Control && !e.Shift && !e.Alt && e.KeyCode is Keys.D0 or Keys.NumPad0) cmd = "zoomFit";
        else if (e.Control && !e.Shift && !e.Alt && e.KeyCode is Keys.D1 or Keys.NumPad1) cmd = "zoom100";
        if (cmd == null) return;
        e.Handled = true;
        Send(cmd);
    }

    [DllImport("dwmapi.dll")]
    static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);
}

static class DarkColors
{
    public static readonly Color Bar = Color.FromArgb(0x1b, 0x1c, 0x1f);
    public static readonly Color Menu = Color.FromArgb(0x24, 0x25, 0x29);
    public static readonly Color Hover = Color.FromArgb(0x3a, 0x3c, 0x42);
    public static readonly Color Border = Color.FromArgb(0x3f, 0x41, 0x47);
    public static readonly Color Text = Color.FromArgb(0xe6, 0xe6, 0xe8);
    public static readonly Color Dim = Color.FromArgb(0x9a, 0x9c, 0xa3);
}

/// <summary>Menus that match the editor's dark interface.</summary>
sealed class DarkMenuRenderer() : ToolStripProfessionalRenderer(new Table())
{
    sealed class Table : ProfessionalColorTable
    {
        public override Color MenuStripGradientBegin => DarkColors.Bar;
        public override Color MenuStripGradientEnd => DarkColors.Bar;
        public override Color ToolStripDropDownBackground => DarkColors.Menu;
        public override Color ImageMarginGradientBegin => DarkColors.Menu;
        public override Color ImageMarginGradientMiddle => DarkColors.Menu;
        public override Color ImageMarginGradientEnd => DarkColors.Menu;
        public override Color MenuBorder => DarkColors.Border;
        public override Color MenuItemBorder => DarkColors.Hover;
        public override Color MenuItemSelected => DarkColors.Hover;
        public override Color MenuItemSelectedGradientBegin => DarkColors.Hover;
        public override Color MenuItemSelectedGradientEnd => DarkColors.Hover;
        public override Color MenuItemPressedGradientBegin => DarkColors.Menu;
        public override Color MenuItemPressedGradientMiddle => DarkColors.Menu;
        public override Color MenuItemPressedGradientEnd => DarkColors.Menu;
        public override Color SeparatorDark => DarkColors.Border;
        public override Color SeparatorLight => DarkColors.Border;
    }

    protected override void OnRenderItemText(ToolStripItemTextRenderEventArgs e)
    {
        // the shortcut column is drawn a little dimmer than the label
        var isShortcut = e.Item is ToolStripMenuItem m && e.Text == m.ShortcutKeyDisplayString && e.Text != m.Text;
        e.TextColor = !e.Item.Enabled || isShortcut ? DarkColors.Dim : DarkColors.Text;
        base.OnRenderItemText(e);
    }

    protected override void OnRenderArrow(ToolStripArrowRenderEventArgs e)
    {
        e.ArrowColor = DarkColors.Text;
        base.OnRenderArrow(e);
    }
}
