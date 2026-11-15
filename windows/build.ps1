# photos.jpeg for Windows — build script.
#
#   .\build.ps1              -> build\photos.jpeg\photos.jpeg.exe   (self-contained: runs on any Windows 10/11 PC)
#   .\build.ps1 -Small       -> same, but needs the .NET 10 Desktop Runtime installed (a few MB instead of ~160 MB)
#   .\build.ps1 -Installer   -> also writes build\photos.jpeg-Setup-<version>-<arch>.exe (per-user installer,
#                               Start Menu shortcut, uninstaller; see installer\Setup.cs for its switches)
#   .\build.ps1 -Zip         -> also writes build\photos.jpeg-<version>-win-<arch>.zip
#   .\build.ps1 -Arch arm64  -> Windows on ARM
#   .\build.ps1 -Installer -Sign <certificate thumbprint>   -> signs the app, uninstaller and Setup
#
# Requires the .NET 10 SDK (https://dotnet.microsoft.com/download). To bundle ffmpeg for
# optimized media, put ffmpeg.exe in windows\tools before building.
param(
    [switch]$Small,
    [switch]$Zip,
    [switch]$Installer,
    [switch]$Lite,                                           # leave the neural-network models out; the app downloads each when it is first needed
    [string]$Sign,                                           # thumbprint of a code-signing certificate in your certificate store
    [string]$TimestampUrl = 'http://timestamp.digicert.com',
    [ValidateSet('x64', 'arm64')][string]$Arch = 'x64'
)
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

$out = Join-Path $PSScriptRoot 'build\photos.jpeg'
if (Test-Path $out) { Remove-Item $out -Recurse -Force }

$selfContained = if ($Small) { 'false' } else { 'true' }
dotnet publish PhotosJpeg.csproj -c Release -r "win-$Arch" --self-contained $selfContained -o $out -nologo -p:DebugType=none
if ($LASTEXITCODE -ne 0) { throw "Build failed ($LASTEXITCODE)" }
Get-ChildItem $out -Filter *.xml | Remove-Item -Force   # API docs of the WebView2 package
if ($Lite) { Get-ChildItem (Join-Path $out 'web\vendor\ml') -Filter *.onnx | Remove-Item -Force }

# Code signing (-Sign <thumbprint>): the app, the uninstaller and the Setup program are signed with a
# certificate from the Windows certificate store, so SmartScreen and Controlled folder access can
# identify the publisher. Without -Sign everything is built unsigned.
function Sign-File([string]$path) {
    $cert = Get-ChildItem Cert:\CurrentUser\My, Cert:\LocalMachine\My -ErrorAction SilentlyContinue |
        Where-Object { $_.Thumbprint -eq ($Sign -replace '\s', '') } | Select-Object -First 1
    if (-not $cert) { throw "No certificate with thumbprint $Sign in the certificate store" }
    $r = Set-AuthenticodeSignature -FilePath $path -Certificate $cert -HashAlgorithm SHA256 -TimestampServer $TimestampUrl
    if ($r.Status -ne 'Valid') { throw "Signing $path failed: $($r.StatusMessage)" }
    Write-Host "  signed $(Split-Path $path -Leaf)"
}
if ($Sign) { Sign-File (Join-Path $out 'photos.jpeg.exe'); Sign-File (Join-Path $out 'photos.jpeg.dll') }

Write-Host ""
Write-Host "Built $out\photos.jpeg.exe"
Write-Host "  Add it to Explorer's 'Open with' list:  & '$out\photos.jpeg.exe' --register"

$version = ([xml](Get-Content PhotosJpeg.csproj)).Project.PropertyGroup.Version | Where-Object { $_ } | Select-Object -First 1

if ($Installer) {
    # Setup = the small setup program (installer\) + the zipped app + a footer saying where the zip starts
    $stubDir = Join-Path $PSScriptRoot 'installer\bin\stub'
    dotnet build installer\Setup.csproj -c Release -o $stubDir -nologo -v q "-p:Version=$version"
    if ($LASTEXITCODE -ne 0) { throw "Installer build failed ($LASTEXITCODE)" }
    $stub = Join-Path $stubDir 'photos.jpeg-setup.exe'

    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $payload = Join-Path $PSScriptRoot 'build\payload.zip'
    if (Test-Path $payload) { Remove-Item $payload -Force }
    # a signed build carries its uninstaller (a signed copy of the setup program) inside the package
    $uninstaller = Join-Path $out 'Uninstall.exe'
    if ($Sign) { Copy-Item $stub $uninstaller -Force; Sign-File $uninstaller }
    [System.IO.Compression.ZipFile]::CreateFromDirectory($out, $payload, [System.IO.Compression.CompressionLevel]::Optimal, $false)
    if (Test-Path $uninstaller) { Remove-Item $uninstaller -Force }

    $setup = Join-Path $PSScriptRoot ("build\photos.jpeg-Setup-$version-$Arch" + $(if ($Lite) { '-lite' } else { '' }) + '.exe')
    $dst = [System.IO.File]::Create($setup)
    try {
        foreach ($part in $stub, $payload) {
            $src = [System.IO.File]::OpenRead($part)
            try { $src.CopyTo($dst) } finally { $src.Dispose() }
        }
        $dst.Write([System.Text.Encoding]::ASCII.GetBytes('PJSETUP1'), 0, 8)
        $dst.Write([System.BitConverter]::GetBytes([long](Get-Item $stub).Length), 0, 8)
    } finally { $dst.Dispose() }
    Remove-Item $payload -Force
    if ($Sign) { Sign-File $setup }
    Write-Host ("Installer {0}  ({1:N0} MB)" -f $setup, ((Get-Item $setup).Length / 1MB))
}

if ($Zip) {
    $zipPath = Join-Path $PSScriptRoot "build\photos.jpeg-$version-win-$Arch.zip"
    if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
    Compress-Archive -Path $out -DestinationPath $zipPath
    Write-Host "Zipped $zipPath"
}
