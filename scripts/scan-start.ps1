<#
.SYNOPSIS
  Starts a live scan now.
.DESCRIPTION
  Calls scan-control {"action":"start","provider_mode":"live"} (x-cron-secret). SIDE EFFECTS: runs the real scan and spends provider
  quota; it asks for confirmation (skip with -Force). If a run already exists for today's Sofia date nothing new starts and the
  answer says "created": false (use scan-status.ps1, or requeue in the operator guide).
  A good answer is HTTP 200 with "created": true and a run id; follow it with scan-status.ps1.
#>
param([switch]$Force)
. "$PSScriptRoot\_common.ps1"
if (-not (Confirm-Action -Message 'This starts the REAL live scan and spends provider quota.' -Force:$Force)) { return }
Invoke-ScreenerFunction -Name 'scan-control' -Body @{ action = 'start'; provider_mode = 'live' } -Auth cron | Out-Null
