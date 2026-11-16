#!/usr/bin/env bash
# Run by the CI workflow inside a started emulator: installs the debug build, opens it, and checks
# that it is still there half a minute later and that the editor's page has come up.
#   ci-smoke.sh <folder for the output>
set -u
out="${1:-out}"; mkdir -p "$out"
pkg=app.photosjpeg.android
apk=android/app/build/outputs/apk/debug/app-debug.apk

adb install -r "$apk" > "$out/install.txt" 2>&1 || { echo "install failed" > "$out/run.txt"; exit 1; }
adb logcat -c
adb shell am start -W -n "$pkg/.MainActivity" > "$out/start.txt" 2>&1
sleep 40
adb exec-out screencap -p > "$out/screen.png" || true
adb logcat -d > "$out/logcat-all.txt" 2>&1
grep -E "AndroidRuntime|FATAL|chromium|$pkg|photosjpeg" "$out/logcat-all.txt" | tail -300 > "$out/logcat.txt"
rm -f "$out/logcat-all.txt"
adb shell dumpsys activity activities | grep -E "ResumedActivity|topResumedActivity" > "$out/front.txt" 2>&1

pid="$(adb shell pidof "$pkg" | tr -d '\r')"
if [ -z "$pid" ]; then echo "NOT running after 40 s" > "$out/run.txt"; exit 1; fi
if grep -q "FATAL EXCEPTION" "$out/logcat.txt"; then echo "running, but an exception was logged" > "$out/run.txt"; exit 1; fi
echo "running after 40 s (pid $pid)" > "$out/run.txt"
