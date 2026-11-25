# Changes

## Unreleased

**Faster**
- Exports render on the graphics card: about 20 times faster for the render itself (a fully edited 50-megapixel photo in 0.2 s instead of 4 s on a fast card). The file is the same picture to within a fraction of a level; 16-bit TIFFs and PCs without a suitable card render on the CPU as before

**Fixed**
- GPU preview: a few colours whose value landed just under mid-grey came out wrong (green or another channel far too dark) until the exact render replaced them — a rounding slip in how the colour table was packed for the graphics card

**Better**
- Develop at 100%: the sharp full-size view now follows every slider movement and pan at once (drawn on the graphics card), instead of appearing after a pause
- Noise reduction looks the same while dragging as after: the GPU preview uses the same method as the final render
- Thumbnails made in the background no longer make the open photo reload for its 1:1 view

## 2.2.1

**Fixed**
- Masking: the Subject, Sky, People, Background and Person buttons no longer stay greyed out after a mask has been found
- Masking: "Show overlay (O)" follows the O key
- A photo is marked missing only when its file is gone; an empty or damaged file says why it cannot be opened

**Better**
- macOS: shortcuts are shown with Mac keys, Option+Y works, and the settings window is called Settings
- A JPEG XL DNG opened from its embedded preview says where to turn on developing it
- The macOS disk image is published with each release (unsigned: see the release notes for how to open it)
- Content-aware fill: removing something that hung across the line between two materials (a sign in front of a roofline and the sky) now keeps wall and sky apart along one clean line, instead of letting the sky eat into the wall

## 2.2.0

**New**
- Merge to Focus Stack: photos focused at different distances become one that is sharp throughout
- Soft proof: version 4 and XYZ-based printer profiles are read, and "paper and ink" shows the paper's white and the ink's black
- The installed Windows app finds new versions on GitHub by itself (Help → Check for Updates); nothing is installed without asking
- macOS: catalog backups, rename or move, watched folder. Android: catalog backups

**Better**
- Galaxy JPEG XL DNGs open in about 9 seconds instead of 26 on a PC with 16 GB of memory (still opt-in)
- Android: the editor no longer sits under the status bar

**Platforms**
- The Mac app is now compiled and started on every change (GitHub Actions), and the Android app is started in an emulator; both came up cleanly
- The release workflow signs the Windows and Android builds when the repository holds the certificates

## 2.1.1

- The installers and Store package built by the release workflow include ffmpeg (6.1.1, GPL essentials build), as locally built ones already did; the 2.1.0 release files do not

## 2.1.0

**New**
- Rename or move files from the Library, with their sidecars; the catalog follows
- A watched folder: photos that appear there are added by themselves
- Catalog backups can be listed, made and restored from inside the app
- Soft proof against a printer profile (ICC v2), next to sRGB and Adobe RGB
- Print: paper size, orientation, margins, and fit or fill for single photos
- Merge to HDR as an editable DNG; fisheye correction; "same person as…" for people
- Display P3 photos from phones keep their colours

**Better**
- Galaxy JPEG XL DNGs: no more rings in smooth skies, correct exposure (still opt-in; the result matches the DNG's embedded preview, not the phone's separate JPEG)
- Content-aware fill is guided by what is around the hole
- GPU preview no longer shows wrong colours after switching between wide-colour and standard photos

**Platforms**
- Windows: lite installer and Store package; the Store package was run locally under its package identity
- Android: builds with the current SDK (full and lite); not yet run on a device
- macOS: code updated (model download, quit question, menus) but not compiled — no Mac was available
- Releases are built by a GitHub Actions workflow when a version tag is pushed

## 2.0.0

The first version of the native rework (no Electron): a .NET window with WebView2 on Windows, native shells for macOS and Android, one shared editor.

**Developing**
- RAW files are developed into Display P3; photos can be edited, shown and exported in wide colour, with a soft proof for sRGB and Adobe RGB
- Display P3 photos from phones (JPEG, HEIC) keep their colours
- A wavelet luminance denoiser; finer shadow encoding (no contour lines in smooth dark areas)
- Lens: a fisheye correction next to the lens profiles
- DNG files whose picture is stored as JPEG XL (Galaxy S23 and later) can be developed (experimental, off by default)

**Masks and retouching**
- Subject, Sky, People, Background and single-person masks, found on the computer; colour range, intersect and subtract; re-found per photo on paste and sync
- Content-aware fill in Spot Removal, guided by what surrounds the hole
- The Sky and People model is EfficientViT-Seg (Apache 2.0)

**Merging**
- HDR from bracketed exposures: hand-held frames aligned, moving things left out; as a finished 16-bit TIFF or as an editable linear DNG
- Panoramas, blended in two bands

**Library**
- Faces grouped by person, named by you, searchable; shown on the photo; looked for on import
- Smart collections, keyword suggestions, compare with zoom in step and sharpness scores, catalog clean-up

**Export**
- JPEG XL with EXIF; a background export queue that asks before the app closes on it

**Packaging**
- Installer, a "lite" installer that downloads the models on first use, and a Microsoft Store package

Not built or tested in this version: the macOS and Android apps with the features above (their code is updated; no Mac or Android toolchain was available).
