param(
  [Parameter(Mandatory = $true)] [string] $HostExePath,
  [Parameter(Mandatory = $true)] [string] $ChromeExtensionId,
  [string] $EdgeExtensionId
)

$ErrorActionPreference = "Stop"

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
  Set-Content -Path $OutPath -Value $raw -Encoding UTF8
}

$chromeOut = Join-Path $outDir "com.velocitydl.native_host.chrome.json"
Write-ManifestFile `
  -TemplatePath (Join-Path $base "com.velocitydl.native_host.chrome.template.json") `
  -OutPath $chromeOut `
  -ExtensionIdPlaceholder "__CHROME_EXTENSION_ID__" `
  -ExtensionIdValue $ChromeExtensionId

New-Item -Path "HKCU:\Software\Google\Chrome\NativeMessagingHosts" -Force | Out-Null
$chromeHostKey = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.velocitydl.native_host"
New-Item -Path $chromeHostKey -Force | Out-Null
Set-Item -Path $chromeHostKey -Value $chromeOut

if ($EdgeExtensionId) {
  $edgeOut = Join-Path $outDir "com.velocitydl.native_host.edge.json"
  Write-ManifestFile `
    -TemplatePath (Join-Path $base "com.velocitydl.native_host.edge.template.json") `
    -OutPath $edgeOut `
    -ExtensionIdPlaceholder "__EDGE_EXTENSION_ID__" `
    -ExtensionIdValue $EdgeExtensionId

  New-Item -Path "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts" -Force | Out-Null
  $edgeHostKey = "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\com.velocitydl.native_host"
  New-Item -Path $edgeHostKey -Force | Out-Null
  Set-Item -Path $edgeHostKey -Value $edgeOut
}

Write-Output "Installed native host manifests:"
Write-Output "Chrome: $chromeOut"
if ($EdgeExtensionId) {
  Write-Output "Edge:   $edgeOut"
}
