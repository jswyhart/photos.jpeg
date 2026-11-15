# photos.jpeg — Microsoft Store package (MSIX).
#
#   .\package-store.ps1            builds the app and packs build\photos.jpeg-<version>-x64.msix
#   .\package-store.ps1 -Lite      the same without the neural-network models (downloaded on first use)
#   .\package-store.ps1 -NoBuild   packs the app that is already in build\photos.jpeg
#
# The package carries the identity Partner Center reserved for the app (store\AppxManifest.xml).
# It is not signed here: upload it in Partner Center (Packages), and the Store signs it. Because it is
# unsigned, Windows will not install it by double-click — try the app with the ordinary build instead.
# Needs the Windows SDK (makeappx.exe), which comes with Visual Studio's "Windows application development" workload.
param(
    [switch]$Lite,
    [switch]$NoBuild,
    [ValidateSet('x64', 'arm64')][string]$Arch = 'x64'
)
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

$makeappx = Get-ChildItem 'C:\Program Files (x86)\Windows Kits\10\bin' -Recurse -Filter makeappx.exe -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -match '\\x64\\' } | Sort-Object FullName -Descending | Select-Object -First 1
if (-not $makeappx) { throw 'makeappx.exe was not found - install the Windows SDK' }

if (-not $NoBuild) {
    if ($Lite) { & (Join-Path $PSScriptRoot 'build.ps1') -Arch $Arch -Lite } else { & (Join-Path $PSScriptRoot 'build.ps1') -Arch $Arch }
    Set-Location $PSScriptRoot
}
$app = Join-Path $PSScriptRoot 'build\photos.jpeg'
if (-not (Test-Path (Join-Path $app 'photos.jpeg.exe'))) { throw 'Build the app first (build.ps1)' }

$version = ([xml](Get-Content PhotosJpeg.csproj)).Project.PropertyGroup.Version | Where-Object { $_ } | Select-Object -First 1
$four = (($version -split '\.') + '0', '0', '0')[0..3] -join '.'       # the Store wants four parts, the last one 0

# ---- the package's contents: the app, the manifest, the logos ----
$layout = Join-Path $PSScriptRoot 'build\store-layout'
if (Test-Path $layout) { Remove-Item $layout -Recurse -Force }
Copy-Item $app $layout -Recurse
# the app's own uninstaller and the updater's leftovers have no place in a Store package: the Store installs, updates and removes it
Get-ChildItem $layout -Filter 'Uninstall*.exe' | Remove-Item -Force
(Get-Content (Join-Path $PSScriptRoot 'store\AppxManifest.xml') -Raw).Replace('{VERSION}', $four).Replace('{ARCH}', $Arch) |
    Set-Content (Join-Path $layout 'AppxManifest.xml') -Encoding UTF8

Add-Type -AssemblyName System.Drawing
$assets = Join-Path $layout 'Assets'
New-Item -ItemType Directory $assets -Force | Out-Null
# the largest picture in icon.ico (its 256-pixel entry is a PNG, which Icon.ToBitmap cannot read on Windows PowerShell)
$ico = [System.IO.File]::ReadAllBytes((Join-Path $PSScriptRoot 'icon.ico'))
$bestAt = 0; $bestLen = 0; $bestW = 0
for ($i = 0; $i -lt [BitConverter]::ToUInt16($ico, 4); $i++) {
    $e = 6 + $i * 16; $w = $ico[$e]; if ($w -eq 0) { $w = 256 }
    if ($w -gt $bestW) { $bestW = $w; $bestLen = [BitConverter]::ToInt32($ico, $e + 8); $bestAt = [BitConverter]::ToInt32($ico, $e + 12) }
}
if ($ico[$bestAt] -eq 0x89) { $art = [System.Drawing.Bitmap]::new([System.IO.MemoryStream]::new($ico, $bestAt, $bestLen)) }
else { $icon = [System.Drawing.Icon]::new((Join-Path $PSScriptRoot 'icon.ico'), $bestW, $bestW); $art = $icon.ToBitmap(); $icon.Dispose() }
function Save-Logo([string]$name, [int]$w, [int]$h) {
    $bmp = [System.Drawing.Bitmap]::new($w, $h)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.Clear([System.Drawing.Color]::Transparent)
    $side = [int]([Math]::Min($w, $h) * 0.86)            # a little room around the picture, as tiles expect
    $g.DrawImage($art, [int](($w - $side) / 2), [int](($h - $side) / 2), $side, $side)
    $g.Dispose()
    $bmp.Save((Join-Path $assets $name), [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()
}
Save-Logo 'StoreLogo.png' 50 50
Save-Logo 'Square44x44Logo.png' 44 44
Save-Logo 'Square44x44Logo.targetsize-44_altform-unplated.png' 44 44
Save-Logo 'Square150x150Logo.png' 150 150
Save-Logo 'Wide310x150Logo.png' 310 150
$art.Dispose()

# ---- pack ----
$msix = Join-Path $PSScriptRoot ("build\photos.jpeg-$four-$Arch" + $(if ($Lite) { '-lite' } else { '' }) + '.msix')
if (Test-Path $msix) { Remove-Item $msix -Force }
& $makeappx.FullName pack /d $layout /p $msix /o | Select-Object -Last 4
if ($LASTEXITCODE -ne 0) { throw "makeappx failed ($LASTEXITCODE)" }
Remove-Item $layout -Recurse -Force
Write-Host ("Store package {0}  ({1:N0} MB) - unsigned; upload it in Partner Center" -f $msix, ((Get-Item $msix).Length / 1MB))
