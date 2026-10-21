<#
.SYNOPSIS
  Runs one tick of the notification dispatcher (pending pushes and the Telegram message).
.DESCRIPTION
  Calls notify-dispatch {"action":"tick"} (x-cron-secret). SIDE EFFECTS: sends every delivery that is due (push and Telegram).
  The minute cron does the same on its own when something is pending; use this to force it after push-send-latest.ps1 or telegram-send-latest.ps1.
  A good answer is HTTP 200 with "ok": true and counts of what was claimed and sent (all zeros when nothing was due).
#>
. "$PSScriptRoot\_common.ps1"
Invoke-ScreenerFunction -Name 'notify-dispatch' -Body @{ action = 'tick' } -Auth cron | Out-Null
