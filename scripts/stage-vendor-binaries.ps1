param()

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$vendorDir = Join-Path $root "vendor-binaries"
New-Item -ItemType Directory -Force -Path $vendorDir | Out-Null

$ytDlpPath = Join-Path $vendorDir "yt-dlp.exe"
if (!(Test-Path $ytDlpPath)) {
  Invoke-WebRequest -Uri "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe" -OutFile $ytDlpPath
}

$ffmpegPath = Join-Path $vendorDir "ffmpeg.exe"
$ffprobePath = Join-Path $vendorDir "ffprobe.exe"
if (!(Test-Path $ffmpegPath) -or !(Test-Path $ffprobePath)) {
  $zipPath = Join-Path $env:TEMP "velocitydl_ffmpeg_vendor.zip"
  $extractDir = Join-Path $env:TEMP "velocitydl_ffmpeg_vendor_extract"
  Invoke-WebRequest -Uri "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip" -OutFile $zipPath
  if (Test-Path $extractDir) {
    Remove-Item -LiteralPath $extractDir -Recurse -Force
  }
  Expand-Archive -LiteralPath $zipPath -DestinationPath $extractDir -Force

  $ffmpegSource = Get-ChildItem -Path $extractDir -Recurse -Filter "ffmpeg.exe" | Select-Object -First 1 -ExpandProperty FullName
  $ffprobeSource = Get-ChildItem -Path $extractDir -Recurse -Filter "ffprobe.exe" | Select-Object -First 1 -ExpandProperty FullName

  if (-not $ffmpegSource) {
    throw "ffmpeg.exe not found in downloaded archive"
  }
  if (-not $ffprobeSource) {
    throw "ffprobe.exe not found in downloaded archive"
  }

  Copy-Item -LiteralPath $ffmpegSource -Destination $ffmpegPath -Force
  Copy-Item -LiteralPath $ffprobeSource -Destination $ffprobePath -Force
}

Get-ChildItem $vendorDir | Select-Object Name,Length,LastWriteTime
