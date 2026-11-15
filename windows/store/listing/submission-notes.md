# Notes for certification

**What the app is**: a desktop photo and video editor (a .NET WinForms window hosting WebView2). It needs no sign-in; a tester can import any folder of photos with File → Import Folder.

**Restricted capability `runFullTrust`** — justification:
photos.jpeg is a classic Win32 desktop application packaged as MSIX. It must read photo and video files from folders the user chooses anywhere on their drives, write exported files and optional XMP sidecars next to them, and run its bundled command-line encoder (ffmpeg) for video export. These are full-trust desktop behaviours that an AppContainer app cannot perform.

**Dependencies**: the Microsoft Edge WebView2 Runtime (part of Windows 11; installed with Edge on Windows 10).

**Things a tester may notice**
- The first use of an automatic mask or of face grouping takes a second or two while a model loads; everything runs locally.
- The Store version keeps its own catalogue (Windows redirects a packaged app's writes under AppData); the app explains this once on first start.
