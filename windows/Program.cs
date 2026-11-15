// photos.jpeg for Windows — entry point: single instance, "Open with" arguments, file-type registration.
using System.IO.Pipes;
using System.Security.Cryptography;
using System.Text;
using Microsoft.Win32;

namespace PhotosJpeg;

static class Program
{
    /// <summary>True when the app runs as a Microsoft Store (MSIX) package. Windows then keeps the app's own
    /// copy of anything it writes under AppData, so its catalog parts ways with an ordinary installation's.</summary>
    public static readonly bool IsPackaged = DetectPackage();

    [System.Runtime.InteropServices.DllImport("kernel32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode)]
    static extern int GetCurrentPackageFullName(ref int length, System.Text.StringBuilder? name);

    static bool DetectPackage()
    {
        try { int n = 0; return GetCurrentPackageFullName(ref n, null) != 15700; }      // 15700: this process has no package identity
        catch { return false; }
    }

    /// <summary>One running app per data folder; later launches hand their files to the first.</summary>
    static readonly string InstanceId = "photos.jpeg." +
        Convert.ToHexString(SHA1.HashData(Encoding.UTF8.GetBytes(Storage.Root.ToLowerInvariant())))[..12];

    [STAThread]
    static int Main(string[] args)
    {
        if (args.Contains("--register")) { Register(true); return 0; }
        if (args.Contains("--unregister")) { Register(false); return 0; }

        var paths = args.Where(a => !a.StartsWith('-') && Storage.IsMedia(a) && File.Exists(a)).Select(Path.GetFullPath).ToList();

        using var mutex = new Mutex(true, InstanceId, out var first);
        if (!first) { Forward(paths); return 0; }

        Log.HookProcess();
        ApplicationConfiguration.Initialize();
        Application.SetColorMode(SystemColorMode.Dark);
        var form = new MainForm(paths);
        var listener = new Thread(() => Listen(form)) { IsBackground = true, Name = "open-with" };
        listener.Start();
        Application.Run(form);
        return 0;
    }

    /// <summary>Second launch: send the paths (possibly none — that just raises the window) to the running app.</summary>
    static void Forward(List<string> paths)
    {
        try
        {
            using var pipe = new NamedPipeClientStream(".", InstanceId, PipeDirection.Out);
            pipe.Connect(3000);
            using var writer = new StreamWriter(pipe, new UTF8Encoding(false));
            foreach (var p in paths) writer.WriteLine(p);
        }
        catch { /* the first instance is shutting down */ }
    }

    static void Listen(MainForm form)
    {
        while (true)
        {
            try
            {
                using var pipe = new NamedPipeServerStream(InstanceId, PipeDirection.In, 1, PipeTransmissionMode.Byte, PipeOptions.CurrentUserOnly);
                pipe.WaitForConnection();
                using var reader = new StreamReader(pipe, Encoding.UTF8);
                var paths = new List<string>();
                while (reader.ReadLine() is { } line)
                {
                    if (Storage.IsMedia(line) && File.Exists(line)) paths.Add(line);
                }
                if (form.IsDisposed) return;
                form.BeginInvoke(() => form.OpenPaths(paths));
            }
            catch (ObjectDisposedException) { return; }
            catch (InvalidOperationException) { return; } // window is gone
            catch (IOException) { Thread.Sleep(200); }
        }
    }

    /// <summary>
    /// Adds photos.jpeg to Explorer's "Open with" list for the current user (no admin rights, no
    /// default-app changes): photos.jpeg.exe --register / --unregister.
    /// </summary>
    static void Register(bool add)
    {
        const string key = @"Software\Classes\Applications\photos.jpeg.exe";
        if (!add) { Registry.CurrentUser.DeleteSubKeyTree(key, false); return; }
        var exe = Environment.ProcessPath!;
        using var app = Registry.CurrentUser.CreateSubKey(key);
        app.SetValue("FriendlyAppName", "photos.jpeg");
        using (var cmd = app.CreateSubKey(@"shell\open\command")) cmd.SetValue("", $"\"{exe}\" \"%1\"");
        using (var icon = app.CreateSubKey("DefaultIcon")) icon.SetValue("", $"\"{exe}\",0");
        using var types = app.CreateSubKey("SupportedTypes");
        foreach (var ext in Storage.MediaExt) types.SetValue("." + ext, "");
    }
}
