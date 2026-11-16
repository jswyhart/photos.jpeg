#!/usr/bin/env bash
# Run by the CI workflow inside a started emulator: installs the debug build, opens it, and checks
# that it is still there afterwards and that the editor's page has come up without errors
# (ci-probe.mjs looks inside the web view).
#   ci-smoke.sh <folder for the output>
set -u
out="${1:-out}"; mkdir -p "$out"
pkg=app.photosjpeg.android
apk=android/app/build/outputs/apk/debug/app-debug.apk

adb install -r "$apk" > "$out/install.txt" 2>&1 || { echo "install failed" > "$out/run.txt"; exit 1; }
adb shell dumpsys package com.google.android.webview | grep -m1 versionName > "$out/webview.txt" 2>&1
adb logcat -c
adb shell am start -W -n "$pkg/.MainActivity" > "$out/start.txt" 2>&1
sleep 20
pid="$(adb shell pidof "$pkg" | tr -d '\r')"
probe=1
if [ -n "$pid" ]; then
  adb forward tcp:9222 "localabstract:webview_devtools_remote_$pid" > /dev/null
  node android/ci-probe.mjs 9222 "$out/probe.json"; probe=$?
fi
adb exec-out screencap -p > "$out/screen.png" || true
adb logcat -d > "$out/logcat-all.txt" 2>&1
grep -E "AndroidRuntime|FATAL|CONSOLE|$pkg" "$out/logcat-all.txt" | grep -v AppsFilter | tail -200 > "$out/logcat.txt"
rm -f "$out/logcat-all.txt"
adb shell dumpsys activity activities | grep -E "ResumedActivity" > "$out/front.txt" 2>&1

pid="$(adb shell pidof "$pkg" | tr -d '\r')"
if [ -z "$pid" ]; then echo "NOT running at the end" > "$out/run.txt"; exit 1; fi
if grep -q "FATAL EXCEPTION" "$out/logcat.txt"; then echo "running, but an exception was logged" > "$out/run.txt"; exit 1; fi
if [ "$probe" != "0" ]; then echo "running (pid $pid), but the editor did not come up cleanly: see probe.json" > "$out/run.txt"; exit 1; fi
echo "running (pid $pid), editor up" > "$out/run.txt"
