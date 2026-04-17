param(
  [Parameter(Mandatory = $true)] [string] $SiteName,
  [Parameter(Mandatory = $true)] [string] $PageUrl,
  [Parameter(Mandatory = $true)] [ValidateSet("SUCCESS","FAIL","SKIPPED")] [string] $Status,
  [Parameter(Mandatory = $true)] [string] $FileFormat,
  [Parameter(Mandatory = $true)] [string] $Reason,
  [string] $LogFile = "examples_webpage.txt"
)

$timestamp = (Get-Date).ToString("yyyy-MM-dd HH:mm:ss")
$line = "[{0}] | [{1}] | [{2}] | [{3}] | [{4}] | [{5}]" -f $SiteName, $PageUrl, $Status, $FileFormat, $timestamp, $Reason
Add-Content -Path $LogFile -Value $line
Write-Output $line
