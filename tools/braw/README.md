# Blackmagic RAW helper

`pj-braw` lets photos.jpeg create optimized media from `.braw` clips. Blackmagic's
licence doesn't allow redistributing the SDK, so you build the helper yourself:

1. Download and install the free **Blackmagic RAW SDK**:
   https://www.blackmagicdesign.com/developer/product/camera
2. Install ffmpeg: `brew install ffmpeg` (Mac) / `winget install ffmpeg` (Windows).
3. Run `./build.sh` (set `BRAW_SDK=…` if the SDK isn't in its default location).

The result is `tools/braw/build/pj-braw`.
* Windows app: `windows\build.ps1` bundles `tools/braw/build/pj-braw.exe` automatically when it exists
  (or copy it into the app's `tools\` folder, or put it on your PATH).
* Mac app: copy `build/pj-braw` (and `BlackmagicRawAPI.framework`) into
  `photos.jpeg.app/Contents/Resources/tools/`, or put it on your PATH as `/usr/local/bin/pj-braw`.

Windows: build `pj-braw.cpp` + `Win/Include/BlackmagicRawAPIDispatch.cpp` with MSVC
(`cl /std:c++17 /EHsc pj-braw.cpp BlackmagicRawAPI_i.c …`) and place `pj-braw.exe` in `tools/braw/build/`.
