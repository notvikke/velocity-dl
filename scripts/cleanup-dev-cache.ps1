param(
  [switch]$RemoveReleaseArtifacts = $false,
  [switch]$RemoveVendorBinaries = $false
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$targetRoot = Join-Path $repoRoot "src-tauri\target"
$debugRoot = Join-Path $targetRoot "debug"
$releaseRoot = Join-Path $targetRoot "release"
$releaseBundleRoot = Join-Path $releaseRoot "bundle"
$nsisRoot = Join-Path $releaseBundleRoot "nsis"
$releasesRoot = Join-Path $repoRoot "releases"
$vendorRoot = Join-Path $repoRoot "vendor-binaries"

function Get-PathSizeBytes {
  param([string]$Path)

  if (-not (Test-Path -LiteralPath $Path)) {
    return 0
  }

  $item = Get-Item -LiteralPath $Path
  if (-not $item.PSIsContainer) {
    return $item.Length
  }

  $result = Get-ChildItem -LiteralPath $Path -Recurse -Force -ErrorAction SilentlyContinue |
    Measure-Object -Property Length -Sum
  $sum = $result.Sum
  if ($null -eq $sum) {
    $sum = 0
  }
  return [int64]$sum
}

function Format-Size {
  param([int64]$Bytes)

  if ($Bytes -ge 1GB) {
    return "{0:N2} GB" -f ($Bytes / 1GB)
  }
  if ($Bytes -ge 1MB) {
    return "{0:N1} MB" -f ($Bytes / 1MB)
  }
  if ($Bytes -ge 1KB) {
    return "{0:N1} KB" -f ($Bytes / 1KB)
  }

  return "$Bytes B"
}

function Remove-IfExists {
  param([string]$Path)

  if (Test-Path -LiteralPath $Path) {
    Remove-Item -LiteralPath $Path -Recurse -Force
  }
}

New-Item -ItemType Directory -Path $releasesRoot -Force | Out-Null

$preservedInstallers = @()
if (Test-Path -LiteralPath $nsisRoot) {
  $installers = Get-ChildItem -LiteralPath $nsisRoot -File -Filter "*.exe" -ErrorAction SilentlyContinue
  foreach ($installer in $installers) {
    $destination = Join-Path $releasesRoot $installer.Name
    Copy-Item -LiteralPath $installer.FullName -Destination $destination -Force
    $preservedInstallers += $destination
  }
}

$beforeDebugBytes = Get-PathSizeBytes -Path $debugRoot
$beforeReleaseBytes = Get-PathSizeBytes -Path $releaseRoot
$beforeVendorBytes = Get-PathSizeBytes -Path $vendorRoot

Remove-IfExists -Path $debugRoot

if ($RemoveReleaseArtifacts) {
  Remove-IfExists -Path $releaseBundleRoot
}

if ($RemoveVendorBinaries) {
  Remove-IfExists -Path $vendorRoot
}

$afterDebugBytes = Get-PathSizeBytes -Path $debugRoot
$afterReleaseBytes = Get-PathSizeBytes -Path $releaseRoot
$afterVendorBytes = Get-PathSizeBytes -Path $vendorRoot

$summary = [PSCustomObject]@{
  PreservedInstallers = if ($preservedInstallers.Count -gt 0) { $preservedInstallers -join "; " } else { "(none found)" }
  DebugBefore        = Format-Size -Bytes $beforeDebugBytes
  DebugAfter         = Format-Size -Bytes $afterDebugBytes
  ReleaseBefore      = Format-Size -Bytes $beforeReleaseBytes
  ReleaseAfter       = Format-Size -Bytes $afterReleaseBytes
  VendorBefore       = Format-Size -Bytes $beforeVendorBytes
  VendorAfter        = Format-Size -Bytes $afterVendorBytes
}

$summary | Format-List
