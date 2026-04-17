param(
  [string] $TelemetryFile
)

if (-not $TelemetryFile) {
  $TelemetryFile = Join-Path $env:APPDATA "com.velocitydl.app\strategy_telemetry.jsonl"
}

if (-not (Test-Path $TelemetryFile)) {
  Write-Output "Telemetry file not found: $TelemetryFile"
  exit 0
}

$rows = Get-Content -Path $TelemetryFile | Where-Object { $_.Trim() -ne "" } | ForEach-Object {
  try { $_ | ConvertFrom-Json } catch { $null }
} | Where-Object { $_ -ne $null }

if (-not $rows -or $rows.Count -eq 0) {
  Write-Output "No telemetry records found."
  exit 0
}

Write-Output "Top strategy performance by host/profile:"
$rows |
  Group-Object host, profile, strategy |
  ForEach-Object {
    $total = $_.Count
    $ok = @($_.Group | Where-Object { $_.success -eq $true }).Count
    $rate = [math]::Round((100.0 * $ok / [math]::Max($total, 1)), 1)
    [PSCustomObject]@{
      Host = $_.Group[0].host
      Profile = $_.Group[0].profile
      Strategy = $_.Group[0].strategy
      Attempts = $total
      Successes = $ok
      SuccessRatePct = $rate
    }
  } |
  Sort-Object Host, Profile, @{Expression="SuccessRatePct";Descending=$true}, @{Expression="Attempts";Descending=$true} |
  Format-Table -AutoSize
