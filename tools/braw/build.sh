#!/usr/bin/env bash
# Builds tools/braw/build/pj-braw against the Blackmagic RAW SDK.
#   BRAW_SDK=/path/to/"Blackmagic RAW SDK" ./build.sh
# Default SDK locations: macOS /Applications/Blackmagic RAW/Blackmagic RAW SDK, Linux /usr/lib/blackmagic/BlackmagicRAWSDK
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p build
case "$(uname -s)" in
  Darwin)
    SDK="${BRAW_SDK:-/Applications/Blackmagic RAW/Blackmagic RAW SDK}/Mac"
    clang++ -std=c++17 -O2 -I "$SDK/Include" pj-braw.cpp "$SDK/Include/BlackmagicRawAPIDispatch.cpp" \
      -framework CoreFoundation -o build/pj-braw
    # the SDK's runtime library must sit next to the helper (or set PJ_BRAW_LIB)
    cp -R "$SDK/Libraries/BlackmagicRawAPI.framework" build/ 2>/dev/null || true
    ;;
  Linux)
    SDK="${BRAW_SDK:-/usr/lib/blackmagic/BlackmagicRAWSDK}/Linux"
    g++ -std=c++17 -O2 -I "$SDK/Include" pj-braw.cpp "$SDK/Include/BlackmagicRawAPIDispatch.cpp" -ldl -lpthread -o build/pj-braw
    cp "$SDK/Libraries/"*.so build/ 2>/dev/null || true
    ;;
  *) echo "On Windows build pj-braw.cpp with MSVC against the SDK's Win/Include (see README.md)"; exit 1 ;;
esac
echo "✓ built tools/braw/build/pj-braw"
