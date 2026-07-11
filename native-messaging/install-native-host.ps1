param(
  [Parameter(Mandatory = $true)] [string] $HostExePath,
  [string] $ChromeExtensionId = "alnagakehjhbfkdianlkmcncefldpmhm",
  [string] $EdgeExtensionId
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($EdgeExtensionId)) {
  $EdgeExtensionId = $ChromeExtensionId
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
    [string] $ExtensionIdPlaceholder,
    [string] $ExtensionIdValue
  )
  $raw = Get-Content -Path $TemplatePath -Raw
  $raw = $raw.Replace("__HOST_EXE_PATH__", ($HostExePath.Replace("\", "\\")))
  $raw = $raw.Replace($ExtensionIdPlaceholder, $ExtensionIdValue)
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($OutPath, $raw, $utf8NoBom)
}

$chromeOut = Join-Path $outDir "com.velocitydl.native_host.chrome.json"
Write-ManifestFile `
  -TemplatePath (Join-Path $base "com.velocitydl.native_host.chrome.template.json") `
  -OutPath $chromeOut `
  -ExtensionIdPlaceholder "__CHROME_EXTENSION_ID__" `
  -ExtensionIdValue $ChromeExtensionId

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

if ($EdgeExtensionId) {
  $edgeOut = Join-Path $outDir "com.velocitydl.native_host.edge.json"
  Write-ManifestFile `
    -TemplatePath (Join-Path $base "com.velocitydl.native_host.edge.template.json") `
    -OutPath $edgeOut `
    -ExtensionIdPlaceholder "__EDGE_EXTENSION_ID__" `
    -ExtensionIdValue $EdgeExtensionId

  New-Item -Path "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts" -Force | Out-Null
  $edgeHostKey = "HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.velocitydl.native_host"
  & reg.exe add $edgeHostKey /ve /t REG_SZ /d $edgeOut /f | Out-Null
}

Write-Output "Installed native host manifests:"
Write-Output "Chrome: $chromeOut"
Write-Output "Chromium: $chromeOut"
Write-Output "Helium: $chromeOut"
if ($EdgeExtensionId) {
  Write-Output "Edge:   $edgeOut"
}
