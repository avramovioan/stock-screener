<#
.SYNOPSIS
  Asks whether an e-mail address may sign in, without creating anything.
.DESCRIPTION
  Calls account-access {"action":"check","email":"<e-mail>"} (no credentials). Read-only; counts toward the per-IP limit
  (10 a minute). Prints only the status.
  A good answer is HTTP 200 and a "status": "not_possible" for an address that is not invited (or not an e-mail), "create_password" for an invited
  address with no password yet, "sign_in" for an invited address with an account. HTTP 429 means the rate limit was hit.
#>
param([Parameter(Mandatory)][string]$Email)
. "$PSScriptRoot\_common.ps1"
$answer = Invoke-ScreenerFunction -Name 'account-access' -Body @{ action = 'check'; email = $Email } -Auth none
Write-Host "status: $($answer.status)"
