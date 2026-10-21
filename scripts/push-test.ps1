<#
.SYNOPSIS
  Sends one test push to every active device.
.DESCRIPTION
  Calls scan-control {"action":"push_test"} (x-cron-secret). SIDE EFFECTS: every active subscription gets the notification
  "Test notification / Push is working on this device."; gone devices are revoked. At most once per 5 minutes overall.
  Needs the push_operator migration and the scan-control redeploy.
  A good answer is "ok": true with "sent" equal to "devices" and "failed": 0.
  { "ok": false, "reason": "rate_limited", "retry_after_seconds": n } means wait; { "ok": false, "reason": "server_keys", "problem": ... }
  means the VAPID secrets are wrong (see health.ps1). "reasons" explains failures (rejected by push service status, network).
#>
. "$PSScriptRoot\_common.ps1"
Invoke-ScreenerFunction -Name 'scan-control' -Body @{ action = 'push_test' } -Auth cron | Out-Null
