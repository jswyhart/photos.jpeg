// photos.jpeg for Windows — the app's log.
//
// A plain text file, logs\photos.jpeg.log in the data folder (Help → Show Log): start-up
// details, errors from the app shell, crashes of the web view's processes, failed bridge
// calls, and errors the editor itself reports (uncaught exceptions, console.error). It is
// what to look at — or send along — when something went wrong. Nothing in it leaves the PC.
// The file is kept under 1 MB; the previous one is kept as photos.jpeg.log.1.
using System.Text;

namespace PhotosJpeg;

public static class Log
{
    static readonly object gate = new();
    const long MaxBytes = 1 << 20;

    public static string Dir => Path.Combine(Storage.Root, "logs");
    public static string File_ => Path.Combine(Dir, "photos.jpeg.log");

    public static void Info(string text) => Write("info", text);
    public static void Warn(string text) => Write("warn", text);
    public static void Error(string text) => Write("ERROR", text);
    public static void Error(string what, Exception ex) => Write("ERROR", $"{what}: {ex}");

    public static void Write(string level, string text)
    {
        try
        {
            lock (gate)
            {
                Directory.CreateDirectory(Dir);
                var file = File_;
                if (File.Exists(file) && new FileInfo(file).Length > MaxBytes) File.Move(file, file + ".1", true);
                if (text.Length > 8000) text = text[..8000] + " …";
                File.AppendAllText(file, $"{DateTime.Now:yyyy-MM-dd HH:mm:ss.fff} {level,-5} {text.Replace("\r", "")}{Environment.NewLine}", new UTF8Encoding(false));
            }
        }
        catch { /* logging must never be the thing that fails */ }
    }

    /// <summary>Errors anywhere in the app shell that nothing else caught.</summary>
    public static void HookProcess()
    {
        Application.SetUnhandledExceptionMode(UnhandledExceptionMode.CatchException);
        Application.ThreadException += (_, e) => Error("Unhandled error on the UI thread", e.Exception);
        AppDomain.CurrentDomain.UnhandledException += (_, e) => Error("Unhandled error" + (e.IsTerminating ? " (the app is closing)" : "") + ": " + e.ExceptionObject);
        TaskScheduler.UnobservedTaskException += (_, e) => { Error("Unobserved task error", e.Exception); e.SetObserved(); };
    }
}
