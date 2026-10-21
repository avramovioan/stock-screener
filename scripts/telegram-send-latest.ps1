<#
.SYNOPSIS
  Sends the latest "new companies" digest to the Telegram group again.
.DESCRIPTION
  Calls scan-control {"action":"telegram_send_latest"} (x-cron-secret). SIDE EFFECT: queues the Telegram message of the latest ready
  public digest (younger than 24 hours); a failed or skipped one is reset, a sent one is left alone. Sends within about a minute
  (or run notify-dispatch.ps1).
  A good answer is "queued": true with the digest's "scan_date". "already_sent", "no_ready_digest" and "not_configured" are reasons, not errors.
#>
. "$PSScriptRoot\_common.ps1"
Invoke-ScreenerFunction -Name 'scan-control' -Body @{ action = 'telegram_send_latest' } -Auth cron | Out-Null
