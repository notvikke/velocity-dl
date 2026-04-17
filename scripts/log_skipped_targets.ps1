param(
  [string] $TargetsFile = "test_targets.csv",
  [string] $LogFile = "examples_webpage.txt"
)

$rows = Import-Csv -Path $TargetsFile
foreach ($row in $rows) {
  if ($row.skip -eq "true") {
    $timestamp = (Get-Date).ToString("yyyy-MM-dd HH:mm:ss")
    $line = "[{0}] | [{1}] | [SKIPPED] | [N/A] | [{2}] | [{3}]" -f $row.site_name, $row.test_url, $timestamp, $row.skip_reason
    Add-Content -Path $LogFile -Value $line
    Write-Output $line
  }
}
