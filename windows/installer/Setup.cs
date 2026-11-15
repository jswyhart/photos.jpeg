// photos.jpeg Setup — installer and uninstaller in one small program.
//
// build.ps1 -Installer produces  photos.jpeg-Setup-<version>-<arch>.exe  =  this program
//   + the zipped app + a 16-byte footer ("PJSETUP1", length of this program).
// Run with the app attached it installs; the copy it leaves in the install folder
// (Uninstall.exe, without the app attached) uninstalls.
//
//   photos.jpeg-Setup.exe                    interactive install
//   photos.jpeg-Setup.exe /S                 silent install        (exit code 0 = ok)
//       /D=<folder>   install folder (default %LOCALAPPDATA%\Programs\photos.jpeg)
//       /DESKTOP      also create a desktop shortcut
//       /NOOPENWITH   don't add photos.jpeg to Explorer's "Open with" list
//       /RUN          start photos.jpeg afterwards
//       /WAIT         wait up to a minute for a running photos.jpeg to close first (used by the updater)
//   Uninstall.exe [/S]                       uninstall (the catalog in %APPDATA% is kept)
//
// Everything is per-user: no administrator rights, nothing outside the user's profile.
using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Reflection;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Win32;

namespace PhotosJpeg.Setup
{
    static class Program
    {
        public const string AppName = "photos.jpeg";
        public const string ExeName = "photos.jpeg.exe";
        public const string UninstallerName = "Uninstall.exe";
        const string UninstallKey = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\photos.jpeg";
        const string Magic = "PJSETUP1";

        public static readonly string Self = Assembly.GetExecutingAssembly().Location;
        public static readonly string Version = Assembly.GetExecutingAssembly().GetName().Version.ToString(3);
        public static string DefaultDir =>
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", AppName);
        static string StartMenuLink =>
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), AppName + ".lnk");
        static string DesktopLink =>
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), AppName + ".lnk");

        [STAThread]
        static int Main(string[] args)
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            bool silent = Has(args, "/S") || Has(args, "/SILENT") || Has(args, "/QUIET");
            try
            {
                // second stage of an uninstall, running from a temporary copy
                int i = Array.FindIndex(args, a => a.Equals("/remove", StringComparison.OrdinalIgnoreCase));
                if (i >= 0 && i + 1 < args.Length) return Remove(args[i + 1], silent);

                long stubLength, payloadLength;
                if (!FindPayload(out stubLength, out payloadLength)) return Uninstall(silent);

                var opts = new InstallOptions
                {
                    Dir = args.Where(a => a.StartsWith("/D=", StringComparison.OrdinalIgnoreCase)).Select(a => a.Substring(3).Trim('"')).FirstOrDefault() ?? PreviousDir() ?? DefaultDir,
                    Desktop = Has(args, "/DESKTOP"),
                    OpenWith = !Has(args, "/NOOPENWITH"),
                    Run = Has(args, "/RUN"),
                    StubLength = stubLength,
                    PayloadLength = payloadLength
                };
                if (silent)
                {
                    // /WAIT (used by the app's own updater): give the running app up to a minute to close
                    if (Has(args, "/WAIT")) for (int w = 0; w < 120 && AppRunning(ResolveDir(opts.Dir)); w++) Thread.Sleep(500);
                    if (AppRunning(opts.Dir)) throw new InvalidOperationException("photos.jpeg is running. Close it and run Setup again.");
                    Install(opts, null);
                    if (opts.Run) Launch(opts.Dir);
                    return 0;
                }
                Application.Run(new SetupForm(opts));
                return opts.Done ? 0 : 1;
            }
            catch (Exception ex)
            {
                Log(ex.ToString());
                if (!silent) MessageBox.Show(ex.Message, AppName + " Setup", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return 2;
            }
        }

        static bool Has(string[] args, string flag) => args.Any(a => a.Equals(flag, StringComparison.OrdinalIgnoreCase));

        public static void Log(string text)
        {
            try { File.AppendAllText(Path.Combine(Path.GetTempPath(), "photos.jpeg-setup.log"), DateTime.Now.ToString("s") + "  " + text + Environment.NewLine); }
            catch { /* logging is best effort */ }
        }

        // ---------------- the attached app ----------------

        /// <summary>Finds the zip appended to this exe. False when there is none (this is the uninstaller).</summary>
        static bool FindPayload(out long stubLength, out long payloadLength)
        {
            stubLength = payloadLength = 0;
            using (var f = new FileStream(Self, FileMode.Open, FileAccess.Read, FileShare.Read))
            {
                if (f.Length < 16) return false;
                // The footer is the last 16 bytes of an unsigned Setup. Code signing appends the
                // signature after it, so look for it in the last megabyte.
                int tail = (int)Math.Min(f.Length, 1 << 20);
                var buf = new byte[tail];
                f.Seek(-tail, SeekOrigin.End);
                for (int got = 0; got < tail;) { int n = f.Read(buf, got, tail - got); if (n <= 0) return false; got += n; }
                var magic = Encoding.ASCII.GetBytes(Magic);
                for (int i = tail - 16; i >= 0; i--)
                {
                    bool hit = true;
                    for (int k = 0; k < 8 && hit; k++) hit = buf[i + k] == magic[k];
                    if (!hit) continue;
                    long stub = BitConverter.ToInt64(buf, i + 8), footer = f.Length - tail + i;
                    if (stub <= 0 || stub >= footer) continue;
                    stubLength = stub;
                    payloadLength = footer - stub;
                    return true;
                }
                return false;
            }
        }

        /// <summary>A read-only window onto part of a file, so the zip can be read in place.</summary>
        sealed class SubStream : Stream
        {
            readonly Stream inner; readonly long start, length; long pos;
            public SubStream(Stream inner, long start, long length) { this.inner = inner; this.start = start; this.length = length; }
            public override bool CanRead => true;
            public override bool CanSeek => true;
            public override bool CanWrite => false;
            public override long Length => length;
            public override long Position { get { return pos; } set { pos = value; } }
            public override int Read(byte[] buffer, int offset, int count)
            {
                if (pos >= length) return 0;
                inner.Position = start + pos;
                int n = inner.Read(buffer, offset, (int)Math.Min(count, length - pos));
                pos += n;
                return n;
            }
            public override long Seek(long offset, SeekOrigin origin)
            {
                pos = origin == SeekOrigin.Begin ? offset : origin == SeekOrigin.Current ? pos + offset : length + offset;
                return pos;
            }
            public override void Flush() { }
            public override void SetLength(long value) { throw new NotSupportedException(); }
            public override void Write(byte[] buffer, int offset, int count) { throw new NotSupportedException(); }
        }

        // ---------------- install ----------------

        public sealed class InstallOptions
        {
            public string Dir;
            public bool Desktop, OpenWith, Run, Done;
            public long StubLength, PayloadLength;
        }

        /// <summary>Where an earlier Setup installed the app, so an update lands in the same place.</summary>
        static string PreviousDir()
        {
            using (var k = Registry.CurrentUser.OpenSubKey(UninstallKey))
            {
                var dir = k == null ? null : k.GetValue("InstallLocation") as string;
                return !string.IsNullOrEmpty(dir) && File.Exists(Path.Combine(dir, ExeName)) ? dir : null;
            }
        }

        /// <summary>
        /// The folder the app's files go in. A folder that already holds other things is never
        /// taken over: the app then gets its own subfolder.
        /// </summary>
        public static string ResolveDir(string dir)
        {
            dir = Path.GetFullPath(Environment.ExpandEnvironmentVariables(dir.Trim().Trim('"')));
            if (Directory.Exists(dir) && Directory.EnumerateFileSystemEntries(dir).Any() && !File.Exists(Path.Combine(dir, ExeName)))
                dir = Path.Combine(dir, AppName);
            if (Path.GetPathRoot(dir).TrimEnd('\\').Equals(dir.TrimEnd('\\'), StringComparison.OrdinalIgnoreCase))
                dir = Path.Combine(dir, AppName);
            return dir;
        }

        public static bool AppRunning(string dir)
        {
            var exe = Path.Combine(dir, ExeName);
            foreach (var p in Process.GetProcessesByName(Path.GetFileNameWithoutExtension(ExeName)))
            {
                try { if (string.Equals(p.MainModule.FileName, exe, StringComparison.OrdinalIgnoreCase)) return true; }
                catch { /* another user's process, or it just exited */ }
                finally { p.Dispose(); }
            }
            return false;
        }

        public static void Install(InstallOptions o, Action<int> progress)
        {
            var dir = o.Dir = ResolveDir(o.Dir);
            Directory.CreateDirectory(dir);

            // An update replaces the previous version's files (only ever inside an app folder)
            if (File.Exists(Path.Combine(dir, ExeName)))
            {
                foreach (var e in Directory.GetFileSystemEntries(dir))
                {
                    if (Directory.Exists(e)) DeleteDir(e); else DeleteFile(e);
                }
            }

            using (var f = new FileStream(Self, FileMode.Open, FileAccess.Read, FileShare.Read))
            {
                using (var zip = new ZipArchive(new SubStream(f, o.StubLength, o.PayloadLength), ZipArchiveMode.Read, true))
                {
                    long total = Math.Max(1, zip.Entries.Sum(e => e.Length)), done = 0;
                    var root = dir.TrimEnd('\\') + "\\";
                    var buffer = new byte[1 << 20];
                    foreach (var entry in zip.Entries)
                    {
                        var target = Path.GetFullPath(Path.Combine(dir, entry.FullName.Replace('/', '\\')));
                        if (!target.StartsWith(root, StringComparison.OrdinalIgnoreCase)) throw new IOException("Bad path in setup package: " + entry.FullName);
                        if (entry.FullName.EndsWith("/") || entry.FullName.EndsWith("\\")) { Directory.CreateDirectory(target); continue; }
                        Directory.CreateDirectory(Path.GetDirectoryName(target));
                        using (var src = entry.Open())
                        using (var dst = new FileStream(target, FileMode.Create, FileAccess.Write, FileShare.None))
                        {
                            int n;
                            while ((n = src.Read(buffer, 0, buffer.Length)) > 0)
                            {
                                dst.Write(buffer, 0, n);
                                done += n;
                                if (progress != null) progress((int)(done * 100 / total));
                            }
                        }
                        File.SetLastWriteTime(target, entry.LastWriteTime.DateTime);
                    }
                }

                // The uninstaller is this program without the attached app. A signed build ships a
                // separately signed copy inside the package; otherwise it is cut from this file.
                f.Position = 0;
                if (!File.Exists(Path.Combine(dir, UninstallerName)))
                using (var u = new FileStream(Path.Combine(dir, UninstallerName), FileMode.Create, FileAccess.Write, FileShare.None))
                {
                    var buffer = new byte[1 << 16];
                    long left = o.StubLength;
                    while (left > 0)
                    {
                        int n = f.Read(buffer, 0, (int)Math.Min(buffer.Length, left));
                        if (n <= 0) break;
                        u.Write(buffer, 0, n);
                        left -= n;
                    }
                }
            }

            var exe = Path.Combine(dir, ExeName);
            if (!File.Exists(exe)) throw new IOException("The setup package doesn't contain " + ExeName);

            Shortcut(StartMenuLink, exe, dir);
            if (o.Desktop) Shortcut(DesktopLink, exe, dir);
            if (o.OpenWith) RunAndWait(exe, "--register");

            var uninstaller = Path.Combine(dir, UninstallerName);
            using (var k = Registry.CurrentUser.CreateSubKey(UninstallKey))
            {
                k.SetValue("DisplayName", AppName);
                k.SetValue("DisplayVersion", Version);
                k.SetValue("Publisher", AppName);
                k.SetValue("DisplayIcon", "\"" + exe + "\",0");
                k.SetValue("InstallLocation", dir);
                k.SetValue("UninstallString", "\"" + uninstaller + "\"");
                k.SetValue("QuietUninstallString", "\"" + uninstaller + "\" /S");
                k.SetValue("NoModify", 1, RegistryValueKind.DWord);
                k.SetValue("NoRepair", 1, RegistryValueKind.DWord);
                k.SetValue("EstimatedSize", (int)Math.Min(int.MaxValue, DirSize(dir) / 1024), RegistryValueKind.DWord);
            }
            o.Done = true;
        }

        public static void Launch(string dir)
        {
            Process.Start(new ProcessStartInfo(Path.Combine(dir, ExeName)) { WorkingDirectory = dir, UseShellExecute = true });
        }

        /// <summary>True when the Edge WebView2 Runtime the app needs is present (it is on Windows 11).</summary>
        public static bool HasWebView2()
        {
            const string client = @"Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}";
            foreach (var path in new[] { @"SOFTWARE\WOW6432Node\" + client, @"SOFTWARE\" + client })
            {
                foreach (var hive in new[] { Registry.LocalMachine, Registry.CurrentUser })
                {
                    try
                    {
                        using (var k = hive.OpenSubKey(path))
                        {
                            var pv = k == null ? null : k.GetValue("pv") as string;
                            if (!string.IsNullOrEmpty(pv) && pv != "0.0.0.0") return true;
                        }
                    }
                    catch { /* no access: try the next place */ }
                }
            }
            return false;
        }

        static void Shortcut(string link, string exe, string dir)
        {
            dynamic shell = Activator.CreateInstance(Type.GetTypeFromProgID("WScript.Shell"));
            dynamic s = shell.CreateShortcut(link);
            s.TargetPath = exe;
            s.WorkingDirectory = dir;
            s.Description = "RAW photo & video editor";
            s.IconLocation = exe + ",0";
            s.Save();
        }

        static void RunAndWait(string exe, string arguments)
        {
            try
            {
                using (var p = Process.Start(new ProcessStartInfo(exe, arguments) { UseShellExecute = false, CreateNoWindow = true }))
                    p.WaitForExit(30000);
            }
            catch (Exception ex) { Log(exe + " " + arguments + ": " + ex.Message); }
        }

        static long DirSize(string dir)
        {
            try { return new DirectoryInfo(dir).EnumerateFiles("*", SearchOption.AllDirectories).Sum(f => f.Length); }
            catch { return 0; }
        }

        static void DeleteFile(string file)
        {
            for (int attempt = 0; ; attempt++)
            {
                try { File.SetAttributes(file, FileAttributes.Normal); File.Delete(file); return; }
                catch (Exception ex) when (ex is IOException || ex is UnauthorizedAccessException)
                {
                    if (attempt == 20) throw new IOException("Can't replace " + file + ". Close photos.jpeg and try again.");
                    Thread.Sleep(250);
                }
            }
        }

        static void DeleteDir(string dir)
        {
            for (int attempt = 0; ; attempt++)
            {
                try { if (Directory.Exists(dir)) Directory.Delete(dir, true); return; }
                catch (Exception ex) when (ex is IOException || ex is UnauthorizedAccessException)
                {
                    if (attempt == 20) throw new IOException("Can't remove " + dir + ". Close photos.jpeg and try again.");
                    Thread.Sleep(250);
                }
            }
        }

        // ---------------- uninstall ----------------

        /// <summary>
        /// First stage, running as Uninstall.exe inside the install folder: a program can't delete
        /// itself, so it hands over to a temporary copy.
        /// </summary>
        static int Uninstall(bool silent)
        {
            var dir = Path.GetDirectoryName(Self);
            if (!File.Exists(Path.Combine(dir, ExeName)))
                throw new InvalidOperationException("This is the photos.jpeg uninstaller, but photos.jpeg isn't installed in its folder.");
            if (!silent && MessageBox.Show("Remove photos.jpeg from this computer?\n\nYour catalog, edits and settings are kept.",
                    "Uninstall " + AppName, MessageBoxButtons.OKCancel, MessageBoxIcon.Question) != DialogResult.OK) return 1;
            var temp = Path.Combine(Path.GetTempPath(), "photos.jpeg-uninstall-" + Guid.NewGuid().ToString("N").Substring(0, 8) + ".exe");
            File.Copy(Self, temp, true);
            // The copy finishes the job after this program has exited (and released its own file)
            Process.Start(new ProcessStartInfo(temp, "/remove \"" + dir + "\"" + (silent ? " /S" : "")) { UseShellExecute = false, WorkingDirectory = Path.GetTempPath() }).Dispose();
            return 0;
        }

        static int Remove(string dir, bool silent)
        {
            dir = Path.GetFullPath(dir);
            // Only ever remove a folder this program installed
            if (!File.Exists(Path.Combine(dir, ExeName)) || !File.Exists(Path.Combine(dir, UninstallerName)))
                throw new InvalidOperationException("photos.jpeg isn't installed in " + dir);

            while (AppRunning(dir))
            {
                if (silent) throw new InvalidOperationException("photos.jpeg is running. Close it and uninstall again.");
                if (MessageBox.Show("photos.jpeg is running. Close it, then choose Retry.", "Uninstall " + AppName,
                        MessageBoxButtons.RetryCancel, MessageBoxIcon.Warning) != DialogResult.Retry) return 1;
            }

            RunAndWait(Path.Combine(dir, ExeName), "--unregister");
            foreach (var link in new[] { StartMenuLink, DesktopLink })
            {
                try { if (File.Exists(link)) File.Delete(link); } catch (Exception ex) { Log(ex.Message); }
            }
            Registry.CurrentUser.DeleteSubKeyTree(UninstallKey, false);
            DeleteDir(dir); // retries while the first stage (Uninstall.exe) is still exiting

            if (!silent) MessageBox.Show("photos.jpeg was removed.\n\nYour catalog is still in " +
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), AppName) + ".",
                "Uninstall " + AppName, MessageBoxButtons.OK, MessageBoxIcon.Information);

            // remove this temporary copy once it has exited
            try
            {
                Process.Start(new ProcessStartInfo("cmd.exe", "/c ping 127.0.0.1 -n 3 >nul & del /f /q \"" + Self + "\"")
                { UseShellExecute = false, CreateNoWindow = true, WorkingDirectory = Path.GetTempPath() });
            }
            catch { /* the temp folder gets cleaned eventually */ }
            return 0;
        }
    }

    /// <summary>The one-page install window.</summary>
    sealed class SetupForm : Form
    {
        readonly Program.InstallOptions opts;
        readonly TextBox dirBox = new TextBox();
        readonly Button browse = new Button { Text = "Browse…" };
        readonly CheckBox desktop = new CheckBox { Text = "Create a desktop shortcut", AutoSize = true };
        readonly CheckBox openWith = new CheckBox { Text = "Add photos.jpeg to Explorer's \"Open with\" menu for photos and video", AutoSize = true };
        readonly CheckBox run = new CheckBox { Text = "Start photos.jpeg when Setup finishes", AutoSize = true, Checked = true };
        readonly ProgressBar bar = new ProgressBar { Minimum = 0, Maximum = 100, Visible = false };
        readonly Label status = new Label { AutoSize = true };
        readonly Button install = new Button { Text = "Install" };
        readonly Button cancel = new Button { Text = "Cancel" };
        bool busy;

        public SetupForm(Program.InstallOptions o)
        {
            opts = o;
            Text = "photos.jpeg " + Program.Version + " Setup";
            Font = SystemFonts.MessageBoxFont;
            AutoScaleDimensions = new SizeF(96F, 96F);
            AutoScaleMode = AutoScaleMode.Dpi;
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            StartPosition = FormStartPosition.CenterScreen;
            ClientSize = new Size(560, 318);
            try { Icon = Icon.ExtractAssociatedIcon(Program.Self); } catch { /* default icon */ }

            var title = new Label { Text = "Install photos.jpeg", Font = new Font(Font.FontFamily, 15F), AutoSize = true, Location = new Point(20, 16) };
            var intro = new Label
            {
                Text = "RAW photo && video editor. Installs for your Windows account only — no administrator rights needed.",
                Location = new Point(22, 54), Size = new Size(516, 36)
            };
            var where = new Label { Text = "Install in:", AutoSize = true, Location = new Point(22, 98) };
            dirBox.Location = new Point(24, 118); dirBox.Size = new Size(420, 24); dirBox.Text = o.Dir;
            browse.Location = new Point(452, 116); browse.Size = new Size(86, 27);
            desktop.Location = new Point(24, 158); desktop.Checked = o.Desktop;
            openWith.Location = new Point(24, 184); openWith.Checked = o.OpenWith;
            run.Location = new Point(24, 210);
            bar.Location = new Point(24, 246); bar.Size = new Size(514, 14);
            status.Location = new Point(22, 246);
            install.Location = new Point(356, 276); install.Size = new Size(88, 30);
            cancel.Location = new Point(450, 276); cancel.Size = new Size(88, 30);
            Controls.AddRange(new Control[] { title, intro, where, dirBox, browse, desktop, openWith, run, bar, status, install, cancel });
            AcceptButton = install; CancelButton = cancel;

            if (!Program.HasWebView2())
                status.Text = "Note: photos.jpeg needs the Microsoft Edge WebView2 Runtime, which isn't installed here.";

            browse.Click += (s, e) =>
            {
                using (var d = new FolderBrowserDialog { Description = "Choose the folder to install photos.jpeg in", SelectedPath = dirBox.Text })
                    if (d.ShowDialog(this) == DialogResult.OK) dirBox.Text = Program.ResolveDir(d.SelectedPath);
            };
            cancel.Click += (s, e) => Close();
            install.Click += async (s, e) => await Go();
            FormClosing += (s, e) => { if (busy) e.Cancel = true; };
        }

        async Task Go()
        {
            if (opts.Done) { Close(); return; }
            try
            {
                opts.Dir = Program.ResolveDir(dirBox.Text);
                dirBox.Text = opts.Dir;
            }
            catch (Exception)
            {
                MessageBox.Show(this, "That folder name isn't valid.", Text, MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }
            while (Program.AppRunning(opts.Dir))
            {
                if (MessageBox.Show(this, "photos.jpeg is running. Close it, then choose Retry.", Text,
                        MessageBoxButtons.RetryCancel, MessageBoxIcon.Warning) != DialogResult.Retry) return;
            }
            opts.Desktop = desktop.Checked; opts.OpenWith = openWith.Checked; opts.Run = run.Checked;
            busy = true;
            foreach (Control c in new Control[] { dirBox, browse, desktop, openWith, run, install, cancel }) c.Enabled = false;
            status.Visible = false; bar.Visible = true;
            try
            {
                int last = -1;
                await Task.Run(() => Program.Install(opts, p =>
                {
                    if (p == last) return;
                    last = p;
                    try { BeginInvoke((Action)(() => bar.Value = Math.Max(0, Math.Min(100, p)))); } catch { /* window closed */ }
                }));
                busy = false;
                if (opts.Run) Program.Launch(opts.Dir);
                Close();
            }
            catch (Exception ex)
            {
                busy = false;
                Program.Log(ex.ToString());
                MessageBox.Show(this, "Setup couldn't finish.\n\n" + ex.Message, Text, MessageBoxButtons.OK, MessageBoxIcon.Error);
                foreach (Control c in new Control[] { dirBox, browse, desktop, openWith, run, install, cancel }) c.Enabled = true;
                bar.Visible = false; status.Visible = true;
            }
        }
    }
}
