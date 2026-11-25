# photos.jpeg — RAW photo & video editor

A non-destructive, Lightroom-style photo editor with native apps for Windows (C# / .NET), macOS (Swift) and Android (Kotlin). Each app is a small native shell around the operating system's own web view, so all three share one editor and processing engine (`src/`) and none of them bundles a browser or uses Electron. Your originals are never modified: every edit is stored as settings in a local catalog and rendered on demand.

## Windows app (`windows/`)

A C# / .NET app that hosts the editor in WebView2 (the Edge web view that ships with Windows 11 and current Windows 10), with a native menu bar, Open/Save dialogs, Explorer drag & drop, "Open with" support, a dark title bar, and its catalog in `%APPDATA%\photos.jpeg`. It replaces the earlier Electron build and uses the same catalog folder, so an existing catalog and its thumbnails carry over (optimized media is re-created the first time each clip is opened).

Requires Windows 10 or 11 and the [.NET 10 SDK](https://dotnet.microsoft.com/download) to build.

```powershell
cd windows
.\build.ps1            # → build\photos.jpeg\photos.jpeg.exe (self-contained, runs on any PC)
.\build.ps1 -Small     # a few MB instead of ~160 MB, but the PC needs the .NET 10 Desktop Runtime
.\build.ps1 -Installer # also writes build\photos.jpeg-Setup-<version>-x64.exe
.\build.ps1 -Zip       # also writes build\photos.jpeg-<version>-win-x64.zip
.\build.ps1 -Arch arm64
```

### Installer (Setup.exe)

`.\build.ps1 -Installer` makes a single `photos.jpeg-Setup-<version>-x64.exe` (about 100 MB with ffmpeg bundled, 70 MB without). It installs for the current Windows account only, so it needs no administrator rights: the app goes in `%LOCALAPPDATA%\Programs\photos.jpeg` (or a folder you choose), with a Start Menu shortcut, an optional desktop shortcut, the Explorer "Open with" entry, and an entry in Settings → Apps for uninstalling. Running a newer Setup updates the existing install in place. Uninstalling keeps your catalog in `%APPDATA%\photos.jpeg`.

For scripted installs: `photos.jpeg-Setup-2.0.0-x64.exe /S` (silent), with optional `/D=<folder>`, `/DESKTOP`, `/NOOPENWITH`, `/RUN` and `/WAIT` (wait for a running photos.jpeg to close first); `Uninstall.exe /S` removes it silently. The setup program is in `windows/installer/` and needs nothing but the .NET SDK to build.

**Code signing.** Unsigned builds make Windows SmartScreen show a "Windows protected your PC" prompt on other PCs (More info → Run anyway), and Controlled folder access treats the app as unknown. With a code-signing certificate in your Windows certificate store, `.\build.ps1 -Installer -Sign <certificate thumbprint>` signs the app, the uninstaller and the Setup program (SHA-256, timestamped; `-TimestampUrl` picks the timestamp server). The certificate itself has to be bought from a certificate authority — the build can't create a trusted one.

**Updates.** The installed app asks GitHub once a day at start-up, and on Help → Check for Updates, whether a newer release exists: it fetches a small JSON file that the release workflow publishes with each release — `{ "version": "2.1.1", "url": "https://…/photos.jpeg-Setup-2.1.1-x64.exe", "sha256": "<hex SHA-256 of that file>", "notes": "…" }`. When the version there is higher, it says so; on your yes it downloads the Setup program, verifies its SHA-256 against the manifest, and runs it to update in place and reopen. Nothing is sent but the request for that file, and nothing is installed without being asked. An install from the lite Setup is offered the lite Setup; a Store install never checks (the Store updates it). The address is `<UpdateUrl>` in `windows/PhotosJpeg.csproj`: point it at a file you host instead, or empty it and the app never checks.

While developing, `dotnet run` in `windows/` starts the app; set `PJ_WEB_ROOT` to the `src` folder to pick up editor changes without rebuilding, and `PJ_DATA_DIR` to use a separate catalog folder.

- **Open with:** `photos.jpeg.exe --register` adds photos.jpeg to Explorer's "Open with" list for your user account (no admin rights, and it doesn't change your default apps); `--unregister` removes it. Opening a file while the app is running hands it to the running window.
- **System decoders:** formats the editor can't open itself (HEIC without the HEVC extension, JPEG XL, extra camera RAW formats…) fall back to the Windows Imaging Component, which uses whatever codecs are installed (HEIF Image Extensions, Raw Image Extension, JPEG XL Image Extension).
- **ffmpeg** (for optimized media, see Video below) is bundled when `ffmpeg.exe` is in `windows\tools` at build time, together with its licence texts (`ffmpeg-LICENSE.txt`, `ffmpeg-README.txt`); the copy there now is the GPL "essentials" build from gyan.dev. Without it the app uses an ffmpeg on the PATH (`winget install ffmpeg`). `windows\get-ffmpeg.ps1` fetches that same build (6.1.1, checked against its checksum) into `windows\tools`; the release workflow runs it, so the published installers and Store package include ffmpeg.
- **Camera cards:** when a card or camera with a DCIM folder is connected, the app offers to copy its photos in with Import and Organize (Preferences turns the prompt off).
- **Log:** Help → Show Log opens `logsphotos.jpeg.log` in the data folder: start-up details, errors from the app and the editor, crashes of the web view. Nothing in it is sent anywhere.
- **Controlled folder access:** if Windows' ransomware protection is on, it blocks apps it doesn't know from writing to Pictures, Documents, Videos and the Desktop. The default export folder is therefore `%USERPROFILE%\photos.jpeg Exports` on such PCs (and `Pictures\photos.jpeg Exports` otherwise). Exporting into a protected folder works once you allow photos.jpeg (Windows Security → Virus & threat protection → Ransomware protection → Allow an app through Controlled folder access); until then the app explains the block instead of failing silently.
- **Import and Organize** (File menu): copies or moves new photos into a folder you choose — in subfolders by capture date (`2026 / 2026-10-31` and similar) and renamed from a pattern (date + number, date + original name, or your own text + number) — then adds them to the catalog. XMP sidecars travel with their photos; existing files are never overwritten.
- **Export with Preset** (File menu): one-click exports with the built-in presets (JPEG full size, JPEG 2048 px for the web, JPEG 4K, TIFF, PNG) and the ones you save in the Export dialog, to the folder you used last.

### Hardware acceleration and threading (Windows)

| Work | Runs on |
|---|---|
| Interface, canvas drawing | GPU compositing, at the display's refresh rate |
| Live slider previews, video grading and playback | WebGL 2 on the GPU. Chromium translates it to Direct3D 11 on Windows — that is its hardware path there; there is no native OpenGL driver path to switch to. On PCs with two graphics adapters the app asks for the fast one. |
| RAW development | demosaic, colour conversion and colour-noise reduction run on the GPU (WebGL 2 in a worker, about 40 ms for 10 MP); CPU fallback in strips across the worker threads. Preferences key `raw.gpu` turns the GPU path off. |
| Final renders, exports | up to six worker threads sharing memory |
| Video export (H.264, HEVC) | the graphics card's encoder through Windows Media Foundation — NVIDIA NVENC, Intel Quick Sync or AMD AMF, whichever the PC has — with a software fallback |
| Video decode (playback, export) | the graphics card's decoder (D3D11) for H.264, HEVC, AV1 and VP9 |
| Optimized media (ffmpeg) | `h264_nvenc` (NVIDIA / CUDA), then `h264_qsv` (Quick Sync), then `h264_amf` (AMD); the first that works on the PC is used, with `-hwaccel auto` decoding. Falls back to `libx264` when there is none or the card refuses the clip (H.264 on NVENC stops at 4096 px, for example). |

Set `"encoder"` in `video-settings.json` to `"nvenc"`, `"qsv"`, `"amf"` or `"software"` to override the automatic choice for optimized media.

## Native macOS app (`mac/`)

A Swift/AppKit app that hosts the same editor in WKWebView, with native menus, Open/Save panels, Finder drag & drop, "Open With" support, and its catalog in `~/Library/Application Support/photos.jpeg`.

**True RAW decoding:** on the Mac, RAW files are demosaiced at full sensor resolution by Apple's Core Image RAW engine (with lens correction where the camera is supported), instead of using the camera's embedded preview.

Requires macOS 12+ and Xcode or the Xcode command line tools (`xcode-select --install`).

```bash
cd mac
./build.sh                 # → build/photos.jpeg.app (open it, or drag to /Applications)
UNIVERSAL=1 DMG=1 ./build.sh   # Apple Silicon + Intel, plus build/photos.jpeg.dmg
```

Prefer Xcode? `brew install xcodegen && xcodegen generate` in `mac/` creates `photos.jpeg.xcodeproj`. The build is ad-hoc signed; set `SIGN_ID="Developer ID Application: …"` to sign for distribution (then notarize with `xcrun notarytool`).


### Installers (.dmg / .pkg)

```bash
cd mac
DMG=1 ./build.sh            # build/photos.jpeg.dmg  — open it, drag the app to Applications
PKG=1 ./build.sh            # build/photos.jpeg.pkg  — double-click installer into /Applications
DMG=1 PKG=1 UNIVERSAL=1 ./build.sh   # both, for Apple Silicon + Intel
```

Builds are ad-hoc signed, so on other Macs Gatekeeper says the app "can't be checked". Open it once, then allow it under System Settings → Privacy & Security → Open Anyway (macOS 14 and earlier: right-click → Open once), or run `xattr -dr com.apple.quarantine "/Applications/photos.jpeg.app"`. To distribute without that warning, you need an Apple Developer account. Sign and notarize the build:
`SIGN_ID="Developer ID Application: Your Name (TEAMID)" INSTALLER_ID="Developer ID Installer: Your Name (TEAMID)" DMG=1 PKG=1 ./build.sh`,
then `xcrun notarytool submit build/photos.jpeg.dmg --apple-id you@example.com --team-id TEAMID --wait` and `xcrun stapler staple build/photos.jpeg.dmg`. Do the same for the .pkg.

## Android app (`android/`)

A Kotlin app that hosts the editor in Android's WebView with a touch-first layout: panels become slide-out drawers, controls are finger-sized, pinch to zoom, double-tap for 100%, and the Back button closes tools, drawers and dialogs.

- Import photos or whole folders through the system picker; access is remembered across restarts
- "Share to photos.jpeg" and "Open with photos.jpeg" from Gallery, Files or Google Photos
- Exports go to `Pictures/photos.jpeg` (visible in Gallery) or any folder you choose, with an option to open the share sheet afterwards
- DNG files are decoded by Android's RAW decoder; other RAW formats use the camera's embedded preview
- To stay within phone memory, photos above 24 MP are edited and exported at 24 MP

Requires Android 10+. Build with Android Studio (Ladybug or newer): **File → Open → `android/`**, then Run. The Gradle build copies the shared editor from `../src` automatically. From the command line, once Android Studio has created the Gradle wrapper (or with Gradle 8.10+ installed):

```bash
cd android
gradle assembleDebug        # → app/build/outputs/apk/debug/app-debug.apk
```

`assembleRelease` is signed with the debug key so it installs directly; add your own signing config before publishing to Google Play.

## What's in it

**Library module (G)**
- Catalog with import of files or whole folders (recursive), drag & drop of files/folders, duplicate detection
- Grid with adjustable thumbnail size, filmstrip, multi-select (Ctrl/Shift-click)
- Ratings (0–5), Pick/Reject flags, color labels, title, caption, keywords with suggestions — both the keywords you have used before and, with *Suggest from the photo*, what a scene model sees in the picture (sky, tree, road, building, water, people, car …). Suggestions are only offered; nothing is added until you click it
- Filter bar: text search (name, keyword, camera, lens, folder), flag, rating, label, RAW/non-RAW, edited, virtual copies; sort by capture time, added order, name, rating, edit time, pixel count
- Sources: All Photographs, Previous Import, Edited, Picks, Rejected, Missing, Folders, Collections (drag photos onto a collection)
- **Smart collections** (the wand button on the Collections panel): a saved search — text, keyword, camera or lens, rating, flag, label, kind, edited, captured in the last N days, ISO — that fills itself and stays up to date. A new one starts from what the filter bar shows; double-click one to change its rule
- Quick Develop: relative exposure/tone/WB/presence nudges, presets and Auto Tone for many photos at once
- Full EXIF panel (camera, lens, exposure, ISO, focal length, date, GPS, artist, copyright)
- Virtual copies, remove from catalog, slideshow (Ctrl+Enter)

**Develop module (D)**
- Basic: White balance (presets, Auto, eyedropper W), Temp, Tint, Exposure (±5 EV, processed in linear light), Contrast, Highlights, Shadows, Whites, Blacks (local-adaptive), Texture, Clarity, Dehaze, Vibrance (skin-protecting), Saturation, Auto Tone, Color / B&W treatment
- Tone Curve: parametric (Highlights / Lights / Darks / Shadows with movable splits) and point curves for RGB, Red, Green, Blue
- Color Mixer: HSL for 8 hue bands (Hue / Saturation / Luminance / All), B&W mix
- Color Grading: shadows / midtones / highlights / global wheels with luminance, blending and balance
- Detail: sharpening (amount, radius, detail, masking) and noise reduction (luminance, detail, color)
- Lens corrections (distortion, vignetting), Transform (vertical/horizontal perspective, rotate, aspect, scale, offsets), Effects (post-crop vignette with midpoint/roundness/feather/highlights, film grain with size/roughness), Calibration (shadow tint, RGB primaries)
- Crop & Straighten (R): aspect presets, lock, swap orientation, drag-outside-to-rotate with auto-shrinking crop, rule-of-thirds grid
- Spot removal (Q): heal or clone with automatic source selection, size/feather/opacity
- Masking (M): linear gradient, radial gradient, brush (size, feather, flow, erase); invert, amount, luminance-range refinement, **colour-range** refinement (limit a mask to one colour, picked from the photo with the eyedropper), **combine** (only inside, or not inside, another mask of the photo), red overlay (O); 12 local adjustments per mask
- Before/after: hold `\`, side-by-side (Y), top/bottom (Alt+Y), split slider (Shift+Y)
- Fit / Fill / 1:1 / 2:1 zoom with true full-resolution rendering of the visible area, Space-drag pan, navigator
- Live RGB histogram with clipping warnings (J) and pixel readout
- History (with hover preview), Snapshots, unlimited undo/redo
- Presets: 20 built-ins, user presets (choose which setting groups to include), import/export, hover-to-preview in the navigator
- Copy / Paste / Sync settings with per-group checkboxes, "Previous" settings

**Export (Ctrl+Shift+E)**
- JPEG, PNG, WebP, TIFF or JPEG XL; quality; batch export of the selection
- Exports run **in the background**: a small panel at the bottom right shows progress and has Cancel, further exports queue up behind the running one, and you can keep editing — each photo is exported with its settings as they were when you asked
- **JPEG XL** (.jxl): noticeably smaller than JPEG at the same quality; quality 100 is lossless. Encoded by libjxl (WebAssembly, in `src/vendor/jxl`). EXIF is written into the file (in the JPEG XL container); the file is always sRGB, which its own header says, so no colour profile is needed.
- Destination folder or "same folder as original", optional subfolder
- Naming templates: `{name} {seq} {date} {title} {rating} {custom}`; overwrite / unique name / skip
- Resize by long edge, short edge, width × height, megapixels or percentage; don't enlarge
- Formats: JPEG, PNG, WebP, TIFF (8-bit, or 16-bit for full-size exports), and AVIF in the Windows app (encoded by the bundled ffmpeg). JPEG, PNG and TIFF carry a colour profile: sRGB, or Display P3 / Adobe RGB (1998) with the pixels converted. Everything the editor produces lies inside sRGB, so the wider spaces hold the same colours in a larger container — for labs and workflows that ask for them.
- Output sharpening for screen, text watermark, camera metadata in JPEG exports: the original EXIF block for JPEG sources, and EXIF written from the catalog (camera, lens, exposure, ISO, focal length, capture time, author, GPS) for RAW, TIFF and PNG sources
- **Lens profiles** (Develop → Lens Corrections → *Lens profile*, or Photo → Apply Lens Profile for a whole selection): the photo's camera and lens are looked up in the bundled [lensfun](https://lensfun.github.io) database (about 1,500 lenses) and the calibrated distortion, colour fringing (lateral chromatic aberration) and vignetting for the focal length and aperture used are corrected. The image is scaled just enough to leave no empty border. *Off* removes it. Preferences → *Apply lens profiles on import* does it for every new photo. Fisheye lenses are not handled; vignetting assumes a distant subject.
- **Auto upright** (Develop → Transform): finds the vertical lines in the photo and sets Vertical, Rotate and Scale so buildings stand straight. It needs several long, straight vertical edges spread across the frame and says so when there aren't enough.
- **Luminance noise reduction** works by wavelet shrinkage: the brightness is split into fine-to-coarse layers and, in each, differences smaller than the noise are reduced while edges and texture are kept. It removes the coarse blotches of high-ISO noise as well as the fine grain. Measured on photos with known added noise it is 0.03–1.9 dB closer to the clean picture than the blur-based method it replaced.
- **Pasting or syncing Subject / Sky / People masks**: the mask is found again in each photo it is pasted to (the shape belongs to the photo it was made on); if a photo has no sky or people, that mask does nothing there and the message says so.
- **Noise reduction for the ISO** (Develop → Detail → *Auto for ISO*, or Preferences → *Apply noise reduction by ISO on import*): sets luminance and colour noise reduction from the ISO the photo was taken at.
- **Subject, Sky and People masks** (Develop → Masking): a small neural network finds the subject, the sky or the people in the photo and makes a mask of them — an ordinary mask from then on: adjust it, invert it, limit it by luminance, or touch it up with the brush (paint to add, Alt-paint to erase). It runs on your computer in a fraction of a second; nothing is uploaded. The models are bundled in `src/vendor/ml` (about 75 MB with the runtime and the face models) — see the README there for where each comes from. All of them are under MIT or Apache 2.0 licences.
- **Healing strokes**: with the spot tool, drag instead of clicking to heal or clone along a line (wires, scratches); the stroke moves and deletes as one piece.
- **Compare** (View → Compare Selected Photos): two to six photos side by side; rate, pick and reject from the keyboard. The mouse wheel zooms and dragging pans **all panes together**, so the same spot is compared (double-click: 1:1 at that point, or back to fit; zoomed in, the panes switch to full-size renders). Each pane shows a **sharpness** score relative to the sharpest of the photos compared — it measures the crispest tenth of the picture, so a soft background does not count against a sharp subject.
- **Stacks** (Photo → Stacking): group photos under one thumbnail, or let *Auto-Stack* group bursts (shots within two seconds) and RAW + JPEG pairs. The badge on the thumbnail opens and closes a stack.
- **Print** (File → Print, Ctrl+P): a contact sheet of the selection (2–8 across, with names and dates) or one photo per page, through the system print dialog — which also saves PDFs.
- **Match camera** (same panel), for lenses the database doesn't have: measures the distortion by comparing the developed RAW with the camera's own corrected preview inside the file, and remembers it for that lens and focal length. It can only learn what the camera itself corrects.
- Saved export presets and "Export with previous"

## Video

Clips are imported, rated and graded like photos, then exported as graded video or stills.

**Grade & play.** Open a clip in Develop. White balance, tone, curves, color mixer, color grading, detail, lens, transform, effects, calibration, crop/straighten and masks (linear, radial, brush, luminance range) all apply to video. While a clip is paused the frame goes through the same engine as photos, so the histogram, 1:1 view, before/after and WB picker work. During playback and scrubbing, frames are graded live on the GPU (WebGL2 port of the engine — it matches the CPU render to within 1/255 on average). Spot removal is photo-only.

**Transport bar.** Space play/pause · `,` `.` previous/next frame (Alt = 10) · Shift+I / Shift+O set in/out · loop · mute · **Capture Frame** (Ctrl/⌘+Shift+F) saves the current frame as a JPEG beside the clip and adds it to the catalog with the clip's settings.

**Keyframes.** Press **K** (or ◆ on the transport) to add a keyframe at the playhead. Once a clip has keyframes, any edit made while paused is stored at the playhead (a new keyframe, or the one already there), and every numeric setting animates between keyframes — exposure ramps, white-balance shifts, grading changes, moving radial/linear masks, push-ins with Crop. Shift+, / Shift+. jump between keyframes; right-click a keyframe for smooth or linear easing, or to remove it. Playback, scrubbing, the paused frame and export all follow the animation, and undo covers keyframe edits.

**Stabilization.** Develop → Video → **Analyse motion** tracks the camera (shift, rotation and zoom between frames, robust to moving subjects), then **Stabilize** sets how smooth the camera should be (light smoothing → near-tripod). The frame is zoomed just enough to hide the moving edges (shown under the slider). Stabilization applies to playback, the paused frame and export.

**Log footage.** Develop → Video → Profile converts Apple Log, Sony S-Log3/S-Gamut3.Cine, Panasonic V-Log, Canon Log 3, Fujifilm F-Log, Nikon N-Log and DJI D-Log to Rec.709 before grading. Highlight Rolloff softens clipping.

**Export.** Export → *Graded video (MP4)*: H.264 or HEVC through the system encoder (WebCodecs), 480p–4K or source size, three quality levels, in→out range only, with the original AAC/Opus audio copied (PCM audio from ProRes cameras is re-encoded to AAC). *Still of the current frame* exports a photo instead. Needs macOS 13.3+ on the Mac.

| Format | Windows app | Mac app | Android | Browser |
|---|---|---|---|---|
| GoPro, Google Pixel, Samsung, iPhone — H.264 / HEVC / AV1 / VP9 MP4/MOV (10-bit & HDR are tone-mapped to 8-bit) | ✓ | ✓ | ✓ | ✓ |
| CinemaDNG sequences (uncompressed + lossless-JPEG, debayered in JS; numbered DNGs with a frame-rate tag are grouped into one clip on import) | ✓ | ✓ | ✓ | ✓ |
| Apple ProRes | optimized media via ffmpeg | ✓ direct | — | — |
| Apple ProRes RAW | — | optimized media via AVFoundation (where macOS decodes it) | — | — |
| MXF, MKV, AVI, AVCHD | optimized media via ffmpeg (`winget install ffmpeg`) | optimized media via ffmpeg (`brew install ffmpeg`) | — | — |
| Blackmagic RAW (.braw) | needs `tools/braw` helper + ffmpeg | needs `tools/braw` helper + ffmpeg | — | — |
| RED R3D | needs REDline (free REDCINE-X PRO) | same | — | — |
| ARRIRAW | needs ARRI Reference Tool | same | — | — |
| Canon Cinema RAW Light, Nikon N-RAW | needs a converter you configure (`video-settings.json`) | export ProRes from the maker's app first | — | — |

*Optimized media* is a high-bitrate H.264 copy, made once and cached (`optimized-media/` in the app's data folder); grading and export run from it. Develop → Video → *Create optimized media* forces one.

Converters for the Windows app are configured in `video-settings.json` in the catalog folder (Help → Open Catalog Folder), e.g.
`{"converters": {"crm": {"tool": "C:/path/to/converter.exe", "args": "-i \"{in}\" -o \"{outdir}/{name}.mov\"", "output": "video"}}}`
(`output` is `video` or `tiffseq`). An `"ffmpeg": "C:/path/to/ffmpeg.exe"` entry points the app at a specific ffmpeg. Blackmagic RAW: see `tools/braw/README.md` (the SDK is free but can't be redistributed, so the small helper is built locally).

## Image formats

| Format | How it opens |
|---|---|
| JPEG, PNG, WebP, AVIF, GIF, BMP, ICO | system decoder |
| TIFF (8/16/32-bit int & float, RGB/gray/palette/CMYK, strips & tiles, LZW/Deflate/PackBits) | built-in decoder (JPEG-in-TIFF falls back to the system decoder) |
| Photoshop PSD / PSB | built-in decoder — flattened composite (needs "Maximize compatibility", Photoshop's default) |
| OpenEXR (NONE/RLE/ZIP/ZIPS), Radiance HDR, PFM | built-in decoder, auto-exposed and tone-mapped to 8-bit |
| PNM/PBM/PGM/PPM/PAM, Targa, QOI | built-in decoder |
| HEIC / HEIF (iPhone) | system decoder on Mac & Android; on Windows HEVC tiles via WebCodecs, or the Windows decoder (both need the HEVC/HEIF extensions from the Microsoft Store) |
| JPEG XL, JPEG 2000, PIZ/DWA EXR | system decoder where available (Mac app; Windows app for the codecs installed on the PC) |
| Camera RAW | see below |

Formats the editor can't open itself fall back to the operating system's decoder: ImageIO in the Mac app, ImageDecoder in the Android app, the Windows Imaging Component in the Windows app.

## Auto color grade

Develop → Color Grading → **Auto** (or Ctrl/⌘+Shift+G, or Library → Quick Develop → Auto Grade for a whole selection). It analyses the photo or video frame as currently toned — color casts in the shadows, midtones and highlights (measured on near-neutral areas), colorfulness, skin tones, warm/cool balance and dominant hue — and sets the grading wheels, blending/balance, vibrance and saturation. Pick a look (Auto, Balanced, Cinematic, Warm, Cool, Moody, Film, Soft pastel) and a strength (Subtle/Normal/Strong). Everything it sets stays editable and lands in History as one step.

## Wide colour (Display P3)

RAW files are developed into Display P3 primaries, which reach past sRGB in the reds and greens. A photo marked **Wide colour** (Develop → Calibration; on by default for RAW photos added from now on, see Preferences) is edited in that space from end to end: the viewer shows it on a P3 canvas, so a wide-gamut screen shows the extra colour, and an export as Display P3 or Adobe RGB carries it. An sRGB export, a thumbnail or an sRGB screen gets the picture narrowed to sRGB at the very end.

Photos saved in Display P3 — JPEG and HEIC files from most phones — are read in P3 as well instead of being narrowed on the way in, and take the same mark.

**Soft proof** (below the mark) changes only what you see. *sRGB* shows a wide-colour photo as an sRGB file or screen will, with the colours sRGB cannot hold in magenta; *Adobe RGB* leaves the picture as it is and marks what an Adobe RGB export cannot hold. **A printer profile** can be loaded there too (*Load a printer profile…*, an `.icc` or `.icm` file from the printer or paper maker): the colours that printer and paper cannot hold are marked, on any photo. Table-based profiles are read, version 2 and version 4, built on Lab or XYZ; a profile that only holds a matrix and tone curves (a screen's) is refused with a message. With a printer profile chosen, a second list sets what the proof shows: only the marks, or **paper and ink** as well — white becomes the paper's own white, black the densest ink, and colours out of reach are pulled in the way the printer would. That is a guide to how the print will differ from the screen, not a measured match: it depends on the screen being calibrated and on the light the print is viewed in. Version 4 profiles were checked against a profile built for the tests, not yet against one from a paper maker.

Photos that are not marked — every photo that was in a catalog before this existed — are brought to sRGB first and render as they always did. Turning the mark on or off is not an edit: presets, paste and reset leave it alone. Limits: the working space is P3, so an Adobe RGB export holds what P3 and Adobe RGB share; JPEG, PNG and other non-RAW sources are sRGB as before; `.cube` looks are applied in sRGB and brought back.

## Content-aware fill

Spot Removal has a third mode, **Fill**: paint over what should go (a sign, a wire, a person in the background) and the area is rebuilt from what surrounds it, continuing textures and edges instead of copying one place. It is PatchMatch run from coarse to fine in its own thread (`js/fillworker.js`); a typical fill takes one to two seconds. The filled piece is made once at the photo's full resolution (up to 1024 pixels across the area) and kept beside the thumbnails; the photo's settings only name it, so undo, snapshots and virtual copies stay small. Pasting or syncing a fill onto another photo makes it again from that photo's own surroundings. When the scene model is there, it looks at the area around the hole, the hole is divided among the kinds of thing found there (sky, trees, road, grass …) and each part is filled from material of its own kind. Where the painted thing hid the line between two kinds — a sign hanging across a roofline, a person in front of a horizon — that line is carried through the hole: straight on from where it runs on each side, meeting in a corner if the two directions cross behind the object, otherwise straight across, and each side is filled only with its own material. What was really behind the object cannot be known; the result is the simplest shape that fits what is visible around it, so a wall may come out with a different top edge than it has. Thin things that ran behind the object (wires, poles) are not drawn on through it: they stop at the edge of the fill, and are best painted out too. Where three or more kinds meet in the hole, each place takes the nearest kind as a hint and a patch of the wrong one can still appear — fill such an area in smaller strokes.

## People

Library → **People** → the magnifier looks through the photos shown for faces (YuNet), describes each (SFace) and puts the faces that have no name into rows, one per person as far as it can tell. Type a name on a row to file all its faces under that person; click a face first to leave it out; **Ignore** drops faces you do not want to keep track of. People appear in the panel with their photo count, a click shows their photos, and their names are found by the search box and by smart collections. Right-click a person to rename, look through or remove them, or to say they are the **same person as** another entry. When newly imported photos show faces that look like someone already named, the app says so and has the name filled in for you to confirm. Everything runs on this computer; the faces' descriptions are kept in the catalog and small face pictures beside the thumbnails. Faces seen at an odd angle usually end up in a row of their own.

View → **Show Faces** draws the faces on the photo in Develop, with their names. Click one to name it, rename it or say it is not a face; Alt-drag a box around a face the detector missed. Once you have used Find faces, photos are looked through as they are imported (Preferences turns that off).

Two more masks build on this (Develop → Masking): **Background** is everything but the subject, and **Person…** masks one person among several — choose whose face, by name when the face has one.

## Merge to HDR and to Panorama

Select the photos, then Photo → **Merge to HDR…**, **Merge to Panorama…** or **Merge to Focus Stack…**. Each photo goes in as it is developed now; the result is written as a 16-bit TIFF next to the first photo (`name-HDR.tif`, `name-Pano.tif`, `name-Stack.tif`) and added to the catalog, where it is edited like any other photo.

- **HDR** takes two or more exposures of one scene, lines them up — hand-held frames are matched on their corners, so small turns are corrected as well as shifts — leaves out anything that moved between the frames (people, leaves, cars) so it does not show as a ghost, and fuses them: every part of the picture comes mostly from the exposure that shows it best, blended across scales so no seams show. Bright areas stay brighter than dark ones, so the result looks like a photograph rather than a flattened one.
- **Merge to HDR (editable DNG)** keeps the scene's whole range instead of a finished picture: the frames are merged into linear light and written as a DNG (`name-HDR.dng`) that opens like any RAW file, looking like the middle exposure, with the highlights and shadows of the other frames there for Exposure, Highlights and Shadows to bring out.
- **Panorama** joins overlapping photos in the order they were taken. Corners are matched between neighbours, the photos are laid on a cylinder (using the focal length from the metadata, or a normal lens when there is none), evened out in brightness, blended in two bands (broad light and colour over a wide stretch, fine detail from the strongest photo, so small misalignments show once and sharp rather than doubled) and trimmed to a clean rectangle. It expects the camera to turn on the spot with a third or more overlap; fisheye photos (action cameras) and scenes with close foreground shot from different positions do not join well. Output is limited to 40 megapixels.
- **Focus stack** takes photos of one scene focused at different distances (close-ups, products, landscapes with a near foreground) and makes one that is sharp throughout. The photos are lined up first — focusing nearer or farther changes how large things are drawn — and then every detail, from fine texture to broad shapes, is taken from the photo that shows it sharpest. Use a tripod or a steady hand, the same exposure for every photo, and enough steps that neighbouring photos overlap in what is sharp; things that move between the photos leave traces.

## Fisheye

Develop → Lens → **Fisheye** turns the curved lines of a fisheye lens (action cameras) into straight ones. The slider says how wide the lens is; raise it until straight things look straight. The centre keeps its size and the edges are stretched outward, so the frame shows a little less than before — widen it again with Transform → Scale if you like. Photos corrected this way also join into panoramas.

## Renaming and moving files

Photo → **Rename or Move…** (also in the right-click menu) renames the selected files on disk by a pattern — `{name}`, `{date}`, `{time}`, `{seq}`, `{model}` — and can move them to another folder. Their `.xmp` sidecars go with them and the catalog follows, so edits, ratings and virtual copies stay attached. Nothing is ever overwritten: a file whose new name is taken is left as it is and listed. (Windows and Mac apps.)

## Watched folder

Preferences → **Watched folder**: photos and clips that appear in that folder, or in folders inside it, are added to the catalog by themselves once they have finished being written — for a card reader that copies into a folder, a phone sync, or a tethering program. They join the catalog quietly, without taking you away from what you are doing. (Windows and Mac apps; the Mac app looks through the folder every few seconds.)

## Catalog backups

The catalog is copied once a day (the newest 14 are kept). Help → **Catalog Backups…** lists the copies, makes one on the spot, and restores one: the catalog as it is at that moment is kept as a further backup first, so a restore can be undone. Photo files are not part of a backup and are never changed by a restore. (All three apps; on Android the list is under Preferences.)

## Printing

File → Print: a contact sheet (2 to 8 across) or one photo per page, with the paper size, orientation and margins set in the dialog, a heading, file names and dates. One photo per page either shows the whole photo or fills the page.

## Closing while exports run

If the window is closed while the export queue is still working, the app asks first; **Close anyway** stops the queue (files already written stay), Cancel keeps the app open.

## Models, the lite build and the Store package

The neural-network models behind the masks and face grouping are part of the normal build (`src/vendor/ml`, about 63 MB). `windows\build.ps1 -Lite` leaves them out: the app then asks before downloading each one the first time a feature needs it, from this repository on GitHub, checks it against a size and SHA-256 built into the app (`windows/Models.cs`), and keeps it in the data folder. Nothing else is downloaded that way, and no photo leaves the computer.

The Android app takes the same switch (`gradle assembleDebug -Plite`) and the Mac build `LITE=1 ./build.sh`.

Pushing a version tag (`v2.1.0`) runs `.github/workflows/release.yml`: it builds the Windows installers, the Store package, the macOS disk image (Apple Silicon + Intel) and the Android app and publishes them as a GitHub release, with that version's section of `CHANGELOG.md` as the notes, and the two small `update.json` files the installed Windows app asks for. When the repository has signing secrets (their names are at the top of the workflow file), the Windows programs and the Android app are signed; without them they are built unsigned, as now. The macOS disk image is always ad-hoc signed.

Every push to `main` that touches the apps runs `.github/workflows/ci.yml`: it compiles the Mac app on a Mac and starts it, and starts the Android app in an emulator and looks inside its web view for errors. The Mac app cannot be built on the Windows PC the app is developed on, so this is where it is compiled; each run leaves its build log and a screenshot on the branches `ci-logs-mac` and `ci-logs-android`.

`windows\package-store.ps1` packs the app as an MSIX for the Microsoft Store with the identity reserved in Partner Center (`windows/store/AppxManifest.xml`). The package is left unsigned — the Store signs what is uploaded — so it cannot be installed by double-click; test with the ordinary build. A Store install keeps its own copy of the data folder once it writes to it (Windows redirects a packaged app's writes under AppData).

DNG files whose picture is stored as JPEG XL (Galaxy S23 and later) can be developed from that data: Preferences → *Develop JPEG XL DNG files (experimental)*. A 50-megapixel picture is decoded in full, in several threads at once — as many as the PC's memory allows, since each needs about 1.7 GB while it works: about 9 seconds with four threads on a PC with 16 GB or more, 15 with two on 8 GB, 26 with one. The result looks like the preview stored inside the DNG, which is flatter than the JPEG the phone saves next to it (that one gets the phone's own extra processing); so it is off unless you turn it on, and such files otherwise open from their embedded preview.

## Catalog clean-up

Help → **Clean Up Catalog…** (Windows app) shows how much space is held by leftovers — previews and mask shapes that no photo, undo step, snapshot or preset refers to any more — and by the RAW cache, and removes them when you say so. Photos, edits and the catalog are not touched.

## Collections & refresh

Hover a collection for **Refresh** (re-check every file: missing/back online, changed on disk, metadata, previews) and **Clear** (empty the collection — photos stay in the catalog). Folders have Refresh too, Previous Import can be cleared, and Library → **Refresh** (F5) re-checks whatever is in view. All are also on the right-click menus.

## RAW support

**Windows app, Android and browser:** NEF/NRW (Nikon, lossless & lossy compressed), CR2 (Canon), ARW/SRF/SR2 (Sony, compressed & uncompressed) and DNG (lossless-JPEG, tiled or striped, linear DNGs) are developed from the sensor data in JavaScript on the worker pool: black/white levels, as-shot white balance from the maker notes, high-quality (Malvar-He-Cutler) demosaicing, the camera's colour matrix (714 cameras, from LibRaw's table; DNGs carry their own), highlight reconstruction toward neutral, gamut handling and ISO-scaled chroma noise reduction. The result is stored in a log encoding with highlight headroom above white, so Exposure and Highlights recover detail the embedded JPEG has clipped. A per-file base curve and colour fit is measured against the camera's own JPEG, so a RAW opens looking like the camera rendered it. Thumbnails use the embedded preview (fast); Develop and export use the sensor data.

**Mac app:** RAW files are developed by Core Image (every camera macOS supports).

Other RAW formats (CR3, RAF, ORF, RW2, PEF, SRW, GPR…) open through the full-size JPEG preview embedded in the file. Preferences (Ctrl/⌘+,) → *RAW files* switches the engine to embedded previews if you prefer speed.

## Lightroom / Camera Raw sidecars (XMP)

- On import, `.xmp` sidecars next to your photos (and XMP embedded in JPEG/TIFF/DNG) are read: Basic tone & presence, white balance, tone curves (parametric + point, RGB and per channel), HSL/Color Mixer, B&W mix, Color Grading (and older Split Toning), Detail, lens vignetting/distortion, Transform, Effects, Calibration, crop & straighten, orientation, plus rating, colour label, keywords, title and caption.
- **File → Save Metadata to Files (XMP)** (Ctrl/⌘+S) writes Lightroom-compatible sidecars; **Read Metadata from Files** re-reads them. Preferences → *Automatically write .xmp sidecars* keeps them current as you edit.
- Lightroom's naming is used: `IMG_1234.NEF` ↔ `IMG_1234.xmp`. When a RAW and a JPEG share a name, the JPEG's sidecar is `IMG_1234.jpg.xmp` so they never overwrite each other. Existing sidecars are updated in place and other apps' metadata in them is kept.
- Exact photos.jpeg settings (masks, spots, LUTs, video profiles) ride along in a private namespace; if another app edits the file afterwards, its values win.
- Not translated: Lightroom's AI/brush masks, lens profiles and camera profiles. White balance on RAW files is mapped through Kelvin around daylight, so it's close rather than exact.

## LUTs (.cube)

Develop → **LUT**: import 3D or 1D `.cube` files (Resolve, Premiere, camera makers, LUT packs — any size and input domain; stored at up to 33³). Apply as a **Look** (after your edits, sRGB in/out) or as a **Camera** LUT (applied to the camera's values first, e.g. a maker's log → Rec.709 LUT), with an Amount slider. LUTs work on photos and video, on the CPU and GPU, in presets and copy/paste. **Export this look as .cube…** saves your current grade (white balance, exposure, tone, curves, colour, grading, LUT) as a 33³ LUT for other apps — texture, clarity, dehaze, effects and masks depend on neighbouring pixels so they can't be part of a LUT.

## Map & duplicates

- **Map** (header, or M in the Library) shows geotagged photos on OpenStreetMap, clustered with thumbnails. Click a cluster to see its photos, select them, or narrow the Library to them (*Show in grid*). Drag/scroll/pinch to navigate. Tiles need an internet connection and can be turned off in Preferences; © OpenStreetMap contributors.
- **Duplicates** (Library bottom bar, or Tools → Find Duplicates…) groups identical pictures, near-duplicates (resized, recompressed, lightly edited) or similar shots (bursts) using a perceptual hash computed with each thumbnail. The best copy of each group (edited, rated, RAW, largest) is marked Keep; the rest can be selected, rejected, collected, or removed from the catalog. Files on disk are never deleted. RAW+JPEG pairs are left out unless you include them.

## Performance

- Renders are split across a pool of workers (one per core, minus one). Bands only overlap by what the edit needs: none for per-pixel adjustments, which therefore use every core, and enough context for clarity, dehaze, texture, sharpening and noise reduction to render without seams.
- The colour stage (curves, HSL, grading, vibrance…) runs through a cached 3D LUT on large renders: 65³ for full quality, 33³ for live drafts.
- Wide blurs (local tone, dehaze) run on a decimated plane.
- Preview levels are built on a worker. Thumbnails are generated several at a time.
- **RAW files open fast:** the camera's embedded preview is shown at once while the sensor data develops (about a quarter of a second on a desktop GPU). The developed image at working size is cached on disk (`raw-cache/` in the data folder, up to 3 GB, least recently used first out), so a photo opened before appears without developing again; full resolution is developed when you zoom to 1:1 or export. In Develop, the next and previous photos are prepared in the background, so stepping through a shoot is immediate.
- **GPU previews:** while you drag a slider, photos render on the graphics card (the same WebGL2 renderer as video, extended with the RAW input transform and LUTs) at full preview resolution in a few milliseconds; the exact CPU render settles a moment after you stop. Software-only GPUs (no hardware WebGL2) are detected and skipped. Preferences → *GPU previews* turns it off.
- **The 100% view on the GPU:** zoomed in past what the preview holds, the part of the photo in view is drawn from the full-size pixels on the graphics card — with every slider frame and as you pan, in a few milliseconds even on a 50-megapixel photo (the CPU needs 0.1 to 0.9 s for the same window). The CPU's exact tile still replaces it when you stop, as it does for the preview. It needs the photo's full-size pixels in memory, which the first 1:1 view of a photo loads, and it takes several hundred megabytes on the graphics card for a large photo, given back when another photo is opened. A card that is too slow or runs out of memory switches it off for the session and the CPU draws the 100% view as before; the catalog preference `gpu.full` set to false turns it off. Luminance noise reduction on the GPU is now the same wavelet method as on the CPU, at every size (largest difference between the two: 1 to 3 levels of 255, where it was 16).
- **Exports on the GPU:** the full-size render behind an export, an HDR or panorama merge and a full-size print is drawn on the graphics card and read back — a 50-megapixel photo with tone, detail and noise reduction in about 0.2 s where the worker threads take 4 s, a 10-megapixel RAW in 0.04 s against 1.5 s (measured on an RTX 3090 Ti; encoding the JPEG or TIFF afterwards is unchanged and is now most of the time an export takes). For a picture that is kept, the renderer runs in an *exact* mode that does what the CPU engine does where the live preview takes shortcuts: colour noise reduction before white balance, sharpening on the finished picture with the same blur, and the same 65-point colour table read the same way. The two agree to 0.01–0.3 levels of 255 on average; the largest difference found was 14 levels, on under 0.1 % of the pixels of a heavily edited photo. The CPU still renders 16-bit TIFFs, a wide-colour photo going into an sRGB file, anything larger than the card's texture limit, and everything on a PC whose card is too slow, runs out of memory or is a software renderer; the catalog preference `gpu.export` set to false keeps exports on the CPU. A large photo with both kinds of noise reduction takes up to about 1.7 GB on the card while it is drawn.
- **Large catalogs:** the Library grid and filmstrip only build the cells near the viewport, so 50,000-photo catalogs scroll at 60 fps and filter in tens of milliseconds; settings and history are stored sparsely (only what differs from the defaults), keeping the catalog file small.
- The Windows and Mac apps are cross-origin isolated (COOP/COEP), which lets all workers share one copy of a photo in `SharedArrayBuffer` instead of each holding its own.
- A worker that crashes (for example, out of memory on a huge file) is replaced, and its render reports an error instead of hanging.

## Where data lives

- Catalog: `catalog.json` (with a rolling `.bak`) in the app's user-data folder — Help → Open Catalog Folder. The Windows app also keeps dated backups, one per day for the last 14 days of use, in `backups/` there: to go back, close the app and copy one over `catalog.json`. A catalog saved by a newer version of the app is opened read-only and never overwritten.
- Thumbnails (and imported LUT tables): `thumbs/` in the same folder
- Sidecars: `.xmp` files next to your originals, only when you save them (or turn on automatic writing)
- Your photos stay where they are; exports are written only where you choose

## Keyboard shortcuts

Press `?` in the app for the full list. Video: Space play · , / . frame step · K keyframe · Shift+, / . previous/next keyframe · Shift+I/O in/out. Library: M map · Ctrl/⌘+S save XMP · Ctrl/⌘+, preferences. Highlights: G/D modules · ←/→ navigate · 0–5 rating · 6–9 labels · P/X/U flags · R/Q/M/W tools · Z zoom · J clipping · Y before/after · Tab hide panels · Ctrl+Z / Ctrl+Shift+Z undo/redo · Ctrl+Shift+C / V copy/paste settings.

## Project layout

```
mac/               Native macOS app (Swift: AppKit + WKWebView + Core Image RAW)
android/           Native Android app (Kotlin: WebView + Storage Access Framework + MediaStore)
windows/           Native Windows app (C#: WinForms + WebView2 + Windows Imaging Component)
  Program.cs         Entry point: single instance, "Open with" arguments, --register
  MainForm.cs        Window, menu bar, web view, close/flush lifecycle
  Bridge.cs          JS ⇄ native calls (dialogs, catalog, thumbnails, export writing)
  ResourceServer.cs  Serves the editor and media to the web view in-process (no network port)
  Storage.cs         Catalog, thumbnails, folder scanning, sidecars
  VideoTool.cs       Optimized media (ffmpeg, Blackmagic RAW helper, vendor converters)
  Log.cs             The app's log file (Help → Show Log)
  Updater.cs         Update check against a hosted manifest (<UpdateUrl>: the GitHub releases)
  installer/         The Setup / Uninstall program (.NET Framework 4.8, part of Windows)
  SystemImage.cs     Windows Imaging Component fallback decoder
tests/             Automated tests for the Windows app: testsun.ps1 (see its header; uses a scratch catalog)
src/index.html     UI shell
src/css/app.css    Styles
src/js/pipeline.js Image-processing engine (geometry, tone, color, detail, effects, masks, spots)
src/js/worker.js   Render worker (a pool renders bands in parallel)
src/js/engine.js   Source cache, worker pool, thumbnails, auto tone/WB
src/js/decode.js   Image decoding, embedded RAW previews, EXIF parser
src/js/rawdec.js   RAW decoders (NEF, CR2, ARW, DNG/LJ92), demosaic, camera colour (runs in workers)
src/js/rawgpu.js   The same development as WebGL 2 shaders (runs in a worker on an OffscreenCanvas)
src/js/aimask.js   Subject / Sky / People masks (ONNX Runtime Web + the models in src/vendor/ml)
src/js/upright.js  Auto upright (vertical line detection → Transform settings)
src/js/icc.js      Colour profiles for exports (sRGB, Display P3, Adobe RGB)
src/js/lens.js     Lens profiles: lensfun database lookup, and distortion measured against the camera's own preview
src/vendor/lensfun/  lensfun.json — lens calibration data (CC BY-SA 3.0, see LICENSE.txt there)
tools/lensfun/build-db.js  Rebuilds lensfun.json from a lensfun checkout
src/js/raw.js      RAW development: white balance, matrix, fit to the camera's rendering
src/js/rawmatrices.js  Camera colour matrices (from LibRaw)
src/js/xmp.js      Lightroom/Camera Raw XMP sidecars
src/js/luts.js     .cube LUT library
src/js/map.js      Map view (OpenStreetMap)
src/js/dupes.js    Duplicate finder
src/js/virtual.js  Virtualized grid and filmstrip
src/js/formats.js  TIFF, PSD, EXR, HDR, PNM, TGA, QOI and HEIC decoders
src/js/catalog.js  Catalog model, history, presets, persistence
src/js/viewer.js   Develop canvas: zoom, before/after, crop, spots, masks, WB picker
src/js/develop.js  Develop panels
src/js/library.js  Library module
src/js/exporter.js Export dialog and encoders
src/js/app.js      App shell, selection, filmstrip, shortcuts, menu commands
src/js/video/      Video: mp4.js (MP4/MOV demuxer + streaming muxer), gl.js (WebGL2 grading renderer),
                   cdng.js (CinemaDNG decoder), video.js (clips, frames, player), transport.js (player bar),
                   vexport.js (WebCodecs export), keyframes.js (animation), stabilize.js (motion analysis)
mac/Sources/VideoTool.swift  Mac optimized media (AVFoundation, ffmpeg, vendor converters)
tools/braw/        Blackmagic RAW helper source (build against the free SDK)
```

The UI also runs in a plain browser (open `src/index.html` through any local web server) with an in-memory fallback for files, which is handy for development.

## Licence

photos.jpeg's own code is under the MIT licence (see `LICENSE`).

Parts that come from elsewhere keep their own licences, each stated next to the files:

- `src/vendor/ml` — ONNX Runtime Web (MIT) and the models: U²-Net (Apache 2.0), EfficientViT-Seg (Apache 2.0), YuNet (MIT), SFace (Apache 2.0)
- `src/vendor/jxl` — the libjxl encoder from @jsquash/jxl (Apache 2.0; libjxl is BSD 3-Clause) and the jxl-oxide decoder (MIT or Apache 2.0)
- `src/vendor/lensfun` — lens calibration data from the lensfun project, under CC BY-SA 3.0: the data file stays under that licence, not MIT
- `src/vendor/fontawesome` — Font Awesome Free (icons CC BY 4.0, fonts SIL OFL 1.1, code MIT)
- ffmpeg, when placed in `windows/tools` for video export, is a separate program under its own licence (LGPL or GPL, depending on the build)
