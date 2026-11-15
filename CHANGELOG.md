# Changes

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
