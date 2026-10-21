<#
.SYNOPSIS
  Acts like a visitor pressing "Scan with AI" on a listed company.
.DESCRIPTION
  Calls the public function research-request {"security_id":"<uuid>"} (no credentials). SIDE EFFECTS: an accepted request queues one
  research job (spends AI quota) and counts toward the per-IP and daily limits and the 72-hour cooldown; it asks for confirmation (skip with -Force).
  A good answer is HTTP 200 with "ok": true, "report_id" and "started_at". A refusal is "ok": false with a "reason"
  (not_listed, cooldown, in_flight, network_limit, no_quota, ...; operator guide 9.4a).
.PARAMETER SecurityId
  The security uuid of a company that is on today's list.
#>
param(
  [Parameter(Mandatory)][ValidatePattern('^[0-9a-fA-F]{8}-([0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$')][string]$SecurityId,
  [switch]$Force
)
. "$PSScriptRoot\_common.ps1"
if (-not (Confirm-Action -Message "This asks for an AI report on $SecurityId like a visitor would and spends AI quota." -Force:$Force)) { return }
Invoke-ScreenerFunction -Name 'research-request' -Body @{ security_id = $SecurityId } -Auth none | Out-Null
