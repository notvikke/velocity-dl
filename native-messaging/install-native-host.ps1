param(
  [Parameter(Mandatory = $true)] [string] $HostExePath,
  [string] $ChromeExtensionId,
  [string] $EdgeExtensionId
)

$ErrorActionPreference = "Stop"
$ProductionExtensionId = "alnagakehjhbfkdianlkmcncefldpmhm"

function Get-AllowedOriginsJson {
  param([string] $ConfiguredExtensionId)

  $ids = @($ProductionExtensionId)
  if (![string]::IsNullOrWhiteSpace($ConfiguredExtensionId)) {
    $normalized = $ConfiguredExtensionId.Trim().ToLowerInvariant()
    if ($normalized -notmatch '^[a-p]{32}$') {
      throw "Extension ID must be a 32-character Chromium extension ID"
    }
    if ($normalized -ne $ProductionExtensionId) {
      $ids += $normalized
    }
  }
  $origins = @($ids | ForEach-Object { "chrome-extension://$_/" })
  return ConvertTo-Json -InputObject $origins -Compress
}

if (!(Test-Path $HostExePath)) {
  throw "Host exe not found: $HostExePath"
}

$base = Split-Path -Parent $MyInvocation.MyCommand.Path
$outDir = Join-Path $env:APPDATA "com.velocitydl.desktop\native-messaging"
New-Item -ItemType Directory -Path $outDir -Force | Out-Null

function Write-ManifestFile {
  param(
    [string] $TemplatePath,
    [string] $OutPath,
    [string] $ConfiguredExtensionId
  )
  $raw = Get-Content -Path $TemplatePath -Raw
  $raw = $raw.Replace("__HOST_EXE_PATH__", ($HostExePath.Replace("\", "\\")))
  $raw = $raw.Replace("__ALLOWED_ORIGINS__", (Get-AllowedOriginsJson $ConfiguredExtensionId))
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($OutPath, $raw, $utf8NoBom)
}

$chromeOut = Join-Path $outDir "com.velocitydl.native_host.chrome.json"
Write-ManifestFile `
  -TemplatePath (Join-Path $base "com.velocitydl.native_host.chrome.template.json") `
  -OutPath $chromeOut `
  -ConfiguredExtensionId $ChromeExtensionId

New-Item -Path "HKCU:\Software\Google\Chrome\NativeMessagingHosts" -Force | Out-Null
$chromeHostKey = "HKCU\Software\Google\Chrome\NativeMessagingHosts\com.velocitydl.native_host"
& reg.exe add $chromeHostKey /ve /t REG_SZ /d $chromeOut /f | Out-Null

New-Item -Path "HKCU:\Software\Chromium\NativeMessagingHosts" -Force | Out-Null
$chromiumRootKey = "HKCU\Software\Chromium\NativeMessagingHosts"
$chromiumHostKey = "HKCU\Software\Chromium\NativeMessagingHosts\com.velocitydl.native_host"
& reg.exe add $chromiumRootKey /v com.velocitydl.native_host /t REG_SZ /d $chromeOut /f | Out-Null
& reg.exe add $chromiumHostKey /ve /t REG_SZ /d $chromeOut /f | Out-Null

New-Item -Path "HKCU:\Software\imput\Helium\NativeMessagingHosts" -Force | Out-Null
$heliumRootKey = "HKCU\Software\imput\Helium\NativeMessagingHosts"
$heliumHostKey = "HKCU\Software\imput\Helium\NativeMessagingHosts\com.velocitydl.native_host"
& reg.exe add $heliumRootKey /v com.velocitydl.native_host /t REG_SZ /d $chromeOut /f | Out-Null
& reg.exe add $heliumHostKey /ve /t REG_SZ /d $chromeOut /f | Out-Null

$edgeOut = Join-Path $outDir "com.velocitydl.native_host.edge.json"
Write-ManifestFile `
  -TemplatePath (Join-Path $base "com.velocitydl.native_host.edge.template.json") `
  -OutPath $edgeOut `
  -ConfiguredExtensionId $EdgeExtensionId

New-Item -Path "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts" -Force | Out-Null
$edgeHostKey = "HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.velocitydl.native_host"
& reg.exe add $edgeHostKey /ve /t REG_SZ /d $edgeOut /f | Out-Null

Write-Output "Installed native host manifests:"
Write-Output "Chrome: $chromeOut"
Write-Output "Chromium: $chromeOut"
Write-Output "Helium: $chromeOut"
Write-Output "Edge:   $edgeOut"
