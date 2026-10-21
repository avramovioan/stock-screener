<#
.SYNOPSIS
  Queues one full AI report for a security (operator request).
.DESCRIPTION
  Calls scan-control {"action":"research_now","security_id":"<uuid>","force":<bool>} (x-cron-secret). SIDE EFFECTS: queues a research job in
  the latest scan run and spends AI quota; it asks for confirmation (skip with -Force). -ForceReport re-researches even when a report exists.
  A good answer is "ok": true with a "job_key" and "scan_run_id" (an "existing_report_id" means a report already exists).
  The report is written by the next worker ticks; check the card or scan-status.ps1.
.PARAMETER SecurityId
  The security uuid (see the company page URL or the securities table).
#>
param(
  [Parameter(Mandatory)][ValidatePattern('^[0-9a-fA-F]{8}-([0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$')][string]$SecurityId,
  [switch]$ForceReport,
  [switch]$Force
)
. "$PSScriptRoot\_common.ps1"
if (-not (Confirm-Action -Message "This queues a full AI report for $SecurityId and spends AI quota." -Force:$Force)) { return }
Invoke-ScreenerFunction -Name 'scan-control' -Body @{ action = 'research_now'; security_id = $SecurityId; force = [bool]$ForceReport } -Auth cron | Out-Null
