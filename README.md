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

**Updates.** Set `<UpdateUrl>` in `windows/PhotosJpeg.csproj` to the address of a small JSON file you host — `{ "version": "2.1.0", "url": "https://…/photos.jpeg-Setup-2.1.0-x64.exe", "sha256": "<hex SHA-256 of that file>", "notes": "…" }`. The app then checks it once a day at start-up and on Help → Check for Updates; when the version there is higher, it offers to download the Setup program, verifies its SHA-256 against the manifest, and runs it to update in place and reopen. Only https addresses are accepted. With `<UpdateUrl>` empty (the default) the app never contacts anything.

While developing, `dotnet run` in `windows/` starts the app; set `PJ_WEB_ROOT` to the `src` folder to pick up editor changes without rebuilding, and `PJ_DATA_DIR` to use a separate catalog folder.

- **Open with:** `photos.jpeg.exe --register` adds photos.jpeg to Explorer's "Open with" list for your user account (no admin rights, and it doesn't change your default apps); `--unregister` removes it. Opening a file while the app is running hands it to the running window.
- **System decoders:** formats the editor can't open itself (HEIC without the HEVC extension, JPEG XL, extra camera RAW formats…) fall back to the Windows Imaging Component, which uses whatever codecs are installed (HEIF Image Extensions, Raw Image Extension, JPEG XL Image Extension).
- **ffmpeg** (for optimized media, see Video below) is bundled when `ffmpeg.exe` is in `windows\tools` at build time, together with its licence texts (`ffmpeg-LICENSE.txt`, `ffmpeg-README.txt`); the copy there now is the GPL "essentials" build from gyan.dev. Without it the app uses an ffmpeg on the PATH (`winget install ffmpeg`).
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

Builds are ad-hoc signed, so on other Macs Gatekeeper says the app "can't be checked". Right-click → Open once, or run `xattr -dr com.apple.quarantine "/Applications/photos.jpeg.app"`. To distribute without that warning, you need an Apple Developer account. Sign and notarize the build:
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
- Ratings (0–5), Pick/Reject flags, color labels, title, caption, keywords with suggestions
- Filter bar: text search (name, keyword, camera, lens, folder), flag, rating, label, RAW/non-RAW, edited, virtual copies; sort by capture time, added order, name, rating, edit time, pixel count
- Sources: All Photographs, Previous Import, Edited, Picks, Rejected, Missing, Folders, Collections (drag photos onto a collection)
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
- Masking (M): linear gradient, radial gradient, brush (size, feather, flow, erase); invert, amount, luminance-range refinement, red overlay (O); 12 local adjustments per mask
- Before/after: hold `\`, side-by-side (Y), top/bottom (Alt+Y), split slider (Shift+Y)
- Fit / Fill / 1:1 / 2:1 zoom with true full-resolution rendering of the visible area, Space-drag pan, navigator
- Live RGB histogram with clipping warnings (J) and pixel readout
- History (with hover preview), Snapshots, unlimited undo/redo
- Presets: 20 built-ins, user presets (choose which setting groups to include), import/export, hover-to-preview in the navigator
- Copy / Paste / Sync settings with per-group checkboxes, "Previous" settings

**Export (Ctrl+Shift+E)**
- JPEG, PNG, WebP or 8-bit TIFF; quality; batch export of the selection
- Destination folder or "same folder as original", optional subfolder
- Naming templates: `{name} {seq} {date} {title} {rating} {custom}`; overwrite / unique name / skip
- Resize by long edge, short edge, width × height, megapixels or percentage; don't enlarge
- Formats: JPEG, PNG, WebP, TIFF (8-bit, or 16-bit for full-size exports), and AVIF in the Windows app (encoded by the bundled ffmpeg). JPEG, PNG and TIFF carry a colour profile: sRGB, or Display P3 / Adobe RGB (1998) with the pixels converted. Everything the editor produces lies inside sRGB, so the wider spaces hold the same colours in a larger container — for labs and workflows that ask for them.
- Output sharpening for screen, text watermark, camera metadata in JPEG exports: the original EXIF block for JPEG sources, and EXIF written from the catalog (camera, lens, exposure, ISO, focal length, capture time, author, GPS) for RAW, TIFF and PNG sources
- **Lens profiles** (Develop → Lens Corrections → *Lens profile*, or Photo → Apply Lens Profile for a whole selection): the photo's camera and lens are looked up in the bundled [lensfun](https://lensfun.github.io) database (about 1,500 lenses) and the calibrated distortion, colour fringing (lateral chromatic aberration) and vignetting for the focal length and aperture used are corrected. The image is scaled just enough to leave no empty border. *Off* removes it. Preferences → *Apply lens profiles on import* does it for every new photo. Fisheye lenses are not handled; vignetting assumes a distant subject.
- **Auto upright** (Develop → Transform): finds the vertical lines in the photo and sets Vertical, Rotate and Scale so buildings stand straight. It needs several long, straight vertical edges spread across the frame and says so when there aren't enough.
- **Noise reduction for the ISO** (Develop → Detail → *Auto for ISO*, or Preferences → *Apply noise reduction by ISO on import*): sets luminance and colour noise reduction from the ISO the photo was taken at.
- **Subject, Sky and People masks** (Develop → Masking): a small neural network finds the subject, the sky or the people in the photo and makes a mask of them — an ordinary mask from then on: adjust it, invert it, limit it by luminance, or touch it up with the brush (paint to add, Alt-paint to erase). It runs on your computer in a fraction of a second; nothing is uploaded. The models are bundled in `src/vendor/ml` (about 35 MB with the runtime) — see the README there for their licences: the Sky and People model (SegFormer) is licensed by NVIDIA for non-commercial use only.
- **Healing strokes**: with the spot tool, drag instead of clicking to heal or clone along a line (wires, scratches); the stroke moves and deletes as one piece.
- **Compare** (View → Compare Selected Photos): two to six photos side by side; rate, pick and reject from the keyboard.
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
  Updater.cs         Update check against a hosted manifest (off unless <UpdateUrl> is set)
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
