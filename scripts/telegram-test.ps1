<#
.SYNOPSIS
  Sends one test message to the Telegram group.
.DESCRIPTION
  Calls scan-control {"action":"telegram_test"} (x-cron-secret). SIDE EFFECT: one message "Test message from the stock screener." in the group.
  A good answer is "ok": true, "telegram_status": 200, "description": "sent" and the message in the group.
  "not_configured" means TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is missing; Telegram's own description explains a refusal (operator guide 4.8).
#>
. "$PSScriptRoot\_common.ps1"
Invoke-ScreenerFunction -Name 'scan-control' -Body @{ action = 'telegram_test' } -Auth cron | Out-Null
