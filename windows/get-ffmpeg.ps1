# Fetches the ffmpeg that the app bundles (optimized media, AVIF export) into windows\tools, for
# builds made where it is not already there — the release workflow, or a fresh clone.
#
#   .\get-ffmpeg.ps1              → windows\tools\ffmpeg.exe (nothing is done when it is already there)
#   .\get-ffmpeg.ps1 -Into <dir>  → somewhere else (used to try this script out)
#
# One fixed version is fetched: the GPL "essentials" build 6.1.1 from gyan.dev, by way of its
# release on GitHub. Its licence texts are the ffmpeg-LICENSE.txt and ffmpeg-README.txt already in
# windows\tools, which belong to exactly this build. The program file must have the checksum below,
# or it is not kept; to move to another version, change the three values together and replace the
# two text files with the ones from the new archive.
param([string]$Into = (Join-Path $PSScriptRoot 'tools'))
$ErrorActionPreference = 'Stop'

$Version = '6.1.1'
$Url     = "https://github.com/GyanD/codexffmpeg/releases/download/$Version/ffmpeg-$Version-essentials_build.zip"
$Sha256  = '04E1307997530F9CF2FE35CBA2CA7E8875CA91DA02F89D6C7243DF819C94AD00'   # of ffmpeg.exe

$target = Join-Path $Into 'ffmpeg.exe'
if (Test-Path $target) {
    if ((Get-FileHash $target -Algorithm SHA256).Hash -eq $Sha256) { Write-Host "ffmpeg $Version is already in $Into"; exit 0 }
    Write-Host "An ffmpeg.exe of another version is already in $Into; it is left as it is."; exit 0
}

$work = Join-Path ([IO.Path]::GetTempPath()) ("pj-ffmpeg-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force $work | Out-Null
try {
    $zip = Join-Path $work 'ffmpeg.zip'
    Write-Host "Fetching ffmpeg $Version …"
    $ProgressPreference = 'SilentlyContinue'
    Invoke-WebRequest $Url -OutFile $zip
    Expand-Archive $zip -DestinationPath $work
    $exe = Get-ChildItem $work -Recurse -Filter ffmpeg.exe | Select-Object -First 1
    if (-not $exe) { throw 'The archive holds no ffmpeg.exe' }
    $hash = (Get-FileHash $exe.FullName -Algorithm SHA256).Hash
    if ($hash -ne $Sha256) { throw "ffmpeg.exe is not the expected file (checksum $hash); it was not kept" }
    New-Item -ItemType Directory -Force $Into | Out-Null
    Copy-Item $exe.FullName $target
    Write-Host "ffmpeg $Version → $target"
}
finally { Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue }
