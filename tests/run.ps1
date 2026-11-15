# photos.jpeg — automated tests for the Windows app.
#
#   .\tests\run.ps1              run the whole suite against the editor in src\ (uses the app in windows\build)
#   .\tests\run.ps1 -Filter export   only the tests whose name contains "export"
#   .\tests\run.ps1 -Built       test the web files inside the build instead of src\
#   .\tests\run.ps1 -Keep        leave the app open afterwards (to look at what a test did)
#
# The app is started on a scratch catalog in tests\.work — never on your real one — with test
# photos and clips that are generated here. Put your own RAW files in tests\fixtures\raw to
# have the RAW tests run on them too (that folder is not part of the repository).
# Needs: a build of the app (windows\build.ps1), Node.js 22+, and ffmpeg in windows\tools for the video tests.
param([string]$Filter = '', [switch]$Built, [switch]$Keep, [int]$Port = 9344)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$work = Join-Path $PSScriptRoot '.work'
$exe = Join-Path $root 'windows\build\photos.jpeg\photos.jpeg.exe'
if (-not (Test-Path $exe)) { throw "Build the app first: windows\build.ps1" }

# ---- a clean scratch area ----
if (Test-Path $work) { Remove-Item $work -Recurse -Force }
$media = Join-Path $work 'media'; $data = Join-Path $work 'data'; $outDir = Join-Path $work 'out'
New-Item -ItemType Directory $media, $data, $outDir -Force | Out-Null

# ---- fixtures ----
Add-Type -AssemblyName System.Drawing
function New-Picture([string]$path, [int]$w, [int]$h, [scriptblock]$draw) {
    $bmp = [System.Drawing.Bitmap]::new($w, $h); $g = [System.Drawing.Graphics]::FromImage($bmp)
    & $draw $g $w $h
    $g.Dispose()
    $fmt = if ($path -match '\.png$') { [System.Drawing.Imaging.ImageFormat]::Png } else { [System.Drawing.Imaging.ImageFormat]::Jpeg }
    $bmp.Save($path, $fmt); $bmp.Dispose()
}
New-Picture (Join-Path $media 'gradient.jpg') 3000 2000 {
    param($g, $w, $h)
    $br = [System.Drawing.Drawing2D.LinearGradientBrush]::new([System.Drawing.Point]::new(0, 0), [System.Drawing.Point]::new($w, $h), [System.Drawing.Color]::DarkOrange, [System.Drawing.Color]::SteelBlue)
    $g.FillRectangle($br, 0, 0, $w, $h)
    $r = [Random]::new(1)
    foreach ($i in 1..900) { $pen = [System.Drawing.Pen]::new([System.Drawing.Color]::FromArgb($r.Next(256), $r.Next(256), $r.Next(256)), $r.Next(1, 5)); $g.DrawEllipse($pen, $r.Next($w), $r.Next($h), $r.Next(20, 300), $r.Next(20, 300)) }
}
New-Picture (Join-Path $media 'building.jpg') 2400 1600 {
    param($g, $w, $h)
    $g.Clear([System.Drawing.Color]::FromArgb(150, 170, 200)); $r = [Random]::new(3)
    $g.FillRectangle([System.Drawing.Brushes]::BurlyWood, 300, 200, 1800, 1400)
    foreach ($x in 0..12) { $g.FillRectangle([System.Drawing.Brushes]::SaddleBrown, 300 + $x * 150, 200, 14, 1400) }
    foreach ($y in 0..8) { $g.FillRectangle([System.Drawing.Brushes]::Sienna, 300, 200 + $y * 170, 1800, 10) }
    foreach ($x in 0..11) { foreach ($y in 0..7) { $b = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb($r.Next(40, 110), $r.Next(60, 130), $r.Next(90, 170))); $g.FillRectangle($b, 340 + $x * 150, 240 + $y * 170, 84, 110) } }
}
New-Picture (Join-Path $media 'flat.png') 800 600 { param($g, $w, $h) $g.Clear([System.Drawing.Color]::FromArgb(120, 140, 90)); $g.FillEllipse([System.Drawing.Brushes]::Firebrick, 250, 150, 300, 300) }
$ff = Join-Path $root 'windows\tools\ffmpeg.exe'
if (-not (Test-Path $ff)) { $ff = (Get-Command ffmpeg -ErrorAction SilentlyContinue).Source }
if ($ff) {
    & $ff -hide_banner -loglevel error -y -f lavfi -i 'testsrc2=s=1280x720:r=30:d=3' -f lavfi -i 'sine=f=440:d=3' -c:v libx264 -pix_fmt yuv420p -c:a aac (Join-Path $media 'clip.mp4')
    & $ff -hide_banner -loglevel error -y -f lavfi -i 'testsrc2=s=1280x720:r=24:d=2' -c:v prores_ks -profile:v 0 (Join-Path $media 'prores.mov')
    & $ff -hide_banner -loglevel error -y -f lavfi -i 'testsrc2=s=1280x720:r=30:d=2' -c:v libx264 -pix_fmt yuv420p (Join-Path $media 'clip.mkv')
} else { Write-Host 'ffmpeg not found: the video tests will be skipped' -ForegroundColor Yellow }
$raw = Join-Path $PSScriptRoot 'fixtures\raw'
if (Test-Path $raw) { New-Item -ItemType Directory (Join-Path $media 'raw') -Force | Out-Null; Get-ChildItem $raw -File | Select-Object -First 4 | Copy-Item -Destination (Join-Path $media 'raw') }

# ---- the app, on the scratch catalog only ----
function Start-App {
    $env:PJ_DATA_DIR = $data
    $env:PJ_WEB_ROOT = if ($Built) { $null } else { Join-Path $root 'src' }
    $env:PJ_UPDATE_URL = $null
    $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$Port"
    $p = Start-Process $exe -PassThru
    foreach ($i in 1..40) { Start-Sleep -Milliseconds 500; try { Invoke-WebRequest "http://127.0.0.1:$Port/json" -UseBasicParsing -TimeoutSec 2 | Out-Null; break } catch { } }
    Start-Sleep -Seconds 2
    return $p
}
function Stop-App($p) { if ($p -and -not $p.HasExited) { [void]$p.CloseMainWindow(); if (-not $p.WaitForExit(8000)) { $p.Kill() } } }

$app = Start-App
$code = 1
try {
    $env:PJ_TEST_MEDIA = $media; $env:PJ_TEST_OUT = $outDir; $env:PJ_TEST_PORT = $Port; $env:PJ_TEST_FILTER = $Filter
    node (Join-Path $PSScriptRoot 'suite.mjs') 'main'
    $code = $LASTEXITCODE
    if ($code -eq 0 -and -not $Filter) {
        # what the first session saved must still be there in a second one
        Stop-App $app; $app = Start-App
        node (Join-Path $PSScriptRoot 'suite.mjs') 'restart'
        $code = $LASTEXITCODE
    }
} finally { if (-not $Keep) { Stop-App $app } }
exit $code
