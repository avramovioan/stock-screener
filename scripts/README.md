# Operator scripts

PowerShell 7 scripts that trigger one function each and print the HTTP status and the JSON answer, so you can check that a deploy works.
Every script has a help block: `Get-Help .\scripts\push-test.ps1 -Full`. Run them from the repository root.

## Set up a session

Defaults point at the hosted project and site. Override only when needed:

```powershell
$env:SCREENER_SUPABASE_URL = "https://pkfptuwwgyvjxvumqika.supabase.co"      # default
$env:SCREENER_SITE_URL     = "https://stock-screener.avramovioan.workers.dev" # default
```

The scripts that need the cron secret ask for it once per session with hidden input and keep it only in memory. To skip the prompt
set it for this window (do not put it in a file or a profile):

```powershell
$env:SCREENER_CRON_SECRET = [System.Net.NetworkCredential]::new("", (Read-Host "CRON_SHARED_SECRET" -AsSecureString)).Password
```

Secrets are never printed. Scripts with side effects ask `Continue? (y/N)`; `-Force` skips the question.

## Scripts

| Script | What it tests | Auth | Side effects | Example |
|---|---|---|---|---|
| `health.ps1` | `health`: backend up, scan freshness, push keys (`push.configured`) | none | none | `.\scripts\health.ps1` |
| `scan-status.ps1` | `scan-control` `status`: a run and its job counts | cron secret | none | `.\scripts\scan-status.ps1 -Run 2026-10-21` |
| `list-failures.ps1` | `scan-control` `list_failures`: dead jobs and warn/error events | cron secret | none | `.\scripts\list-failures.ps1` |
| `scan-start.ps1` | `scan-control` `start` (live) | cron secret | runs the real scan, spends provider quota (asks first) | `.\scripts\scan-start.ps1` |
| `notify-dispatch.ps1` | `notify-dispatch` tick: sends every due push and Telegram delivery | cron secret | sends due notifications | `.\scripts\notify-dispatch.ps1` |
| `push-test.ps1` | `scan-control` `push_test`: one test push to every active device | cron secret | a notification on every device; max once per 5 minutes | `.\scripts\push-test.ps1` |
| `push-send-latest.ps1` | `scan-control` `push_send_latest`: resend the latest digest as push | cron secret | queues pushes to devices that lack it, retries failed ones | `.\scripts\push-send-latest.ps1` |
| `telegram-test.ps1` | `scan-control` `telegram_test`: one message to the group | cron secret | one Telegram message | `.\scripts\telegram-test.ps1` |
| `telegram-send-latest.ps1` | `scan-control` `telegram_send_latest`: resend the latest digest to Telegram | cron secret | queues the Telegram message | `.\scripts\telegram-send-latest.ps1` |
| `research-now.ps1` | `scan-control` `research_now`: one full AI report | cron secret | queues a report, spends AI quota (asks first) | `.\scripts\research-now.ps1 -SecurityId <uuid> -ForceReport` |
| `scan-with-ai.ps1` | `research-request`: the visitor "Scan with AI" call | none | queues a report, spends AI quota, counts toward visitor limits (asks first) | `.\scripts\scan-with-ai.ps1 -SecurityId <uuid>` |
| `account-check.ps1` | `account-access` `check`: is an e-mail invited? Prints the status only | none | none (counts toward the per-IP limit) | `.\scripts\account-check.ps1 -Email nobody@example.com` |
| `site-headers.ps1` | the deployed site: CSP and other security headers | none | none | `.\scripts\site-headers.ps1` |
| `keepalive.ps1` | `bun run keepalive`: the keep-alive job from this computer | `ANON_KEY`, keep-alive user (asked, hidden) | none | `.\scripts\keepalive.ps1` |

`_common.ps1` is the shared helper (configuration, secret prompt, `Invoke-ScreenerFunction`, `Confirm-Action`); it is not run on its own.

Typical order after a deploy: `health.ps1`, then `push-test.ps1` (a notification arrives on each device), `push-send-latest.ps1` followed by
`notify-dispatch.ps1` (or wait a minute), `telegram-test.ps1`, `telegram-send-latest.ps1`.

## Which deploy each script needs

| Script | Needs deployed |
|---|---|
| `health.ps1`, `account-check.ps1`, `scan-with-ai.ps1`, `notify-dispatch.ps1`, `scan-status.ps1`, `list-failures.ps1`, `scan-start.ps1`, `research-now.ps1` | the matching function (`health`, `account-access`, `research-request`, `notify-dispatch`, `scan-control`) |
| `telegram-test.ps1`, `telegram-send-latest.ps1` | migration `20261015009900` and `scan-control`; the secrets `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` |
| `push-test.ps1`, `push-send-latest.ps1` | `bunx supabase db push` (migration `20261015010000_push_operator.sql`), then `bunx supabase functions deploy scan-control --project-ref <ref>`; the `VAPID_*` secrets (check with `health.ps1`) and `SITE_URL` |
| `site-headers.ps1` | the web app deploy |
| `keepalive.ps1` | the keep-alive user exists (operator guide section 12) |

Answers of the push and Telegram actions are always HTTP 200; read `ok`, `reason` and the counts. Endpoints and keys are never in an answer.
