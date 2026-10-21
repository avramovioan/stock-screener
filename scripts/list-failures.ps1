<#
.SYNOPSIS
  Lists dead or failed jobs and warn/error events of a scan run.
.DESCRIPTION
  Calls scan-control {"action":"list_failures"} (x-cron-secret). Read-only. -Run is optional (run uuid or Sofia date
  yyyy-MM-dd); without it the newest run is used.
  A good answer is HTTP 200 with "dead_or_failed_jobs": [] and no error events that matter (warnings about single instruments are normal).
#>
param([string]$Run)
. "$PSScriptRoot\_common.ps1"
$body = @{ action = 'list_failures' }
if ($Run) { $body['run'] = $Run }
Invoke-ScreenerFunction -Name 'scan-control' -Body $body -Auth cron | Out-Null
