<#
.SYNOPSIS
  Sends the latest "new companies" digest as a push again.
.DESCRIPTION
  Calls scan-control {"action":"push_send_latest"} (x-cron-secret). SIDE EFFECTS: queues the latest ready public digest (younger than
  24 hours) for anonymous devices that have none yet and resets failed or skipped deliveries; already sent ones stay. The dispatcher
  is kicked and sends within about a minute (or run notify-dispatch.ps1). Needs the push_operator migration and the scan-control redeploy.
  A good answer is "ok": true with "queued" above 0 and the digest's "scan_date";
  { "ok": true, "queued": 0, "reason": "no_ready_digest" } means there is no ready digest from the last 24 hours.
#>
. "$PSScriptRoot\_common.ps1"
Invoke-ScreenerFunction -Name 'scan-control' -Body @{ action = 'push_send_latest' } -Auth cron | Out-Null
