<#
.SYNOPSIS
  Shows the status of the latest scan run, or of one run.
.DESCRIPTION
  Calls scan-control {"action":"status"} (x-cron-secret). Read-only.
  -Run takes a run uuid or a Sofia scan date (yyyy-MM-dd); without it the newest run is shown.
  A good answer is HTTP 200, "ok": true, a run with status "complete" and job counts per stage with no dead or failed jobs.
#>
param([string]$Run)
. "$PSScriptRoot\_common.ps1"
$body = @{ action = 'status' }
if ($Run) { $body['run'] = $Run }
Invoke-ScreenerFunction -Name 'scan-control' -Body $body -Auth cron | Out-Null
