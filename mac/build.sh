#!/usr/bin/env bash
# Builds photos.jpeg.app without opening Xcode (needs the Xcode command line tools).
#   ./build.sh              -> build/photos.jpeg.app for this Mac's architecture
#   UNIVERSAL=1 ./build.sh  -> Apple Silicon + Intel universal binary
#   DMG=1 ./build.sh        -> also creates build/photos.jpeg.dmg (drag-to-Applications disk image)
#   PKG=1 ./build.sh        -> also creates build/photos.jpeg.pkg (installer into /Applications)
#   INSTALLER_ID="Developer ID Installer: …" signs the .pkg (optional)
#   SIGN_ID="Developer ID Application: …" ./build.sh  -> sign for distribution (default: ad-hoc)
set -euo pipefail
cd "$(dirname "$0")"
APP="build/photos.jpeg.app"
MIN="12.0"
FRAMEWORKS=(-framework AppKit -framework WebKit -framework CoreImage -framework UniformTypeIdentifiers -framework ImageIO -framework AVFoundation -framework CoreMedia)

rm -rf "$APP" build/AppIcon.iconset
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources" build/obj

echo "› Compiling Swift"
if [[ "${UNIVERSAL:-0}" == "1" ]]; then
  for arch in arm64 x86_64; do
    swiftc -O -target "$arch-apple-macos$MIN" -o "build/obj/photosjpeg-$arch" Sources/*.swift "${FRAMEWORKS[@]}"
  done
  lipo -create build/obj/photosjpeg-arm64 build/obj/photosjpeg-x86_64 -output "$APP/Contents/MacOS/photosjpeg"
else
  swiftc -O -target "$(uname -m)-apple-macos$MIN" -o "$APP/Contents/MacOS/photosjpeg" Sources/*.swift "${FRAMEWORKS[@]}"
fi

echo "› Bundling resources"
cp Resources/Info.plist "$APP/Contents/Info.plist"
mkdir -p "$APP/Contents/Resources/web"
rsync -a --delete ../src/ "$APP/Contents/Resources/web/"
# LITE=1 ./build.sh: leave the neural-network models out; the app downloads each on first use
if [[ "${LITE:-}" == "1" ]]; then rm -f "$APP/Contents/Resources/web/vendor/ml/"*.onnx; fi
if [[ -x ../tools/braw/build/pj-braw ]]; then   # optional Blackmagic RAW helper (see tools/braw/README.md)
  mkdir -p "$APP/Contents/Resources/tools"
  cp -R ../tools/braw/build/pj-braw ../tools/braw/build/*.framework "$APP/Contents/Resources/tools/" 2>/dev/null || true
fi

echo "› App icon"
ICONSET=build/AppIcon.iconset
mkdir -p "$ICONSET"
for s in 16 32 128 256 512; do
  sips -z $s $s ../build/icon.png --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
  sips -z $((s*2)) $((s*2)) ../build/icon.png --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/AppIcon.icns"

echo "› Signing"
codesign --force --options runtime --entitlements photos.jpeg.entitlements --sign "${SIGN_ID:--}" "$APP"

VERSION="$(/usr/libexec/PlistBuddy -c 'Print CFBundleShortVersionString' "$APP/Contents/Info.plist" 2>/dev/null || echo 1.0)"

if [[ "${DMG:-0}" == "1" ]]; then
  echo "› Disk image"
  STAGE=build/dmg-stage
  rm -rf "$STAGE" build/photos.jpeg.dmg && mkdir -p "$STAGE"
  cp -R "$APP" "$STAGE/"
  ln -s /Applications "$STAGE/Applications"          # drag-to-install shortcut
  hdiutil create -volname "photos.jpeg" -srcfolder "$STAGE" -ov -format UDZO build/photos.jpeg.dmg >/dev/null
  rm -rf "$STAGE"
  [[ -n "${SIGN_ID:-}" ]] && codesign --force --sign "$SIGN_ID" build/photos.jpeg.dmg
  echo "  build/photos.jpeg.dmg"
fi

if [[ "${PKG:-0}" == "1" ]]; then
  echo "› Installer package"
  rm -f build/photos.jpeg.pkg build/component.pkg
  pkgbuild --component "$APP" --install-location /Applications \
    --identifier app.photosjpeg.mac --version "$VERSION" build/component.pkg >/dev/null
  if [[ -n "${INSTALLER_ID:-}" ]]; then
    productbuild --package build/component.pkg --sign "$INSTALLER_ID" build/photos.jpeg.pkg >/dev/null
  else
    productbuild --package build/component.pkg build/photos.jpeg.pkg >/dev/null
  fi
  rm -f build/component.pkg
  echo "  build/photos.jpeg.pkg"
fi
echo "✓ Built $APP"
