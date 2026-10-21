<#
.SYNOPSIS
  Checks that the backend is up and that the push keys are set up correctly.
.DESCRIPTION
  Calls GET <project>/functions/v1/health (function "health", no credentials). Read-only.
  A good answer is HTTP 200 with "ok": true and "push": { "configured": true, "problem": null }.
  HTTP 503 means a dependency check failed (see the detail fields). "push.configured": false names the problem
  (for example key_mismatch or private_not_json): re-set the VAPID secrets (operator guide, section 4.1).
#>
. "$PSScriptRoot\_common.ps1"
$answer = Invoke-ScreenerFunction -Name 'health' -Method GET
if ($answer.push) {
  if ($answer.push.configured -eq $true) { Write-Host 'push.configured: true' -ForegroundColor Green }
  else { Write-Host "push.configured: false, problem: $($answer.push.problem)" -ForegroundColor Red }
}
