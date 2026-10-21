# Telegram group notifications — plan (2026-10-21)

Owner: "I want to also notify in a telegram group. And we notify following the same rules. We don't have to spam when there's nothing
new on the screener."

## Rulings (lead)

- Source: the public "new companies on the list" digest (one per scan run, built by the digest stage since 35ee914). When that digest is
  created and non-empty, exactly one Telegram message goes to one configured group. Empty or skipped digests send nothing. Holdings
  (portfolio) digests never go to Telegram.
- Configuration: function secrets `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`. When either is missing the feature is off and nothing
  fails. Never log the token, never put it in a URL that gets logged.
- Delivery: its own small table (one row per public digest, unique on the digest) with status, attempts, next attempt, last error code,
  sent_at, Telegram message id; sent by `notify-dispatch` in the same run as push, with retries on network errors, 5xx and 429 (honour
  `parameters.retry_after`), a maximum of 5 attempts, and expiry after 24 hours like push digests. Retention cleanup covers the table.
- API: `POST https://api.telegram.org/bot<token>/sendMessage` with `{ chat_id, text, parse_mode: "HTML", disable_web_page_preview: true }`.
  Escape `<`, `>`, `&` in every company field.
- Message (HTML), Sofia date of the scan:
  `<b>New on the screener · 21 Oct</b>` then one line per company `• <b>MSFT</b> Microsoft Corporation · #4 · at its −3 line` (use the
  same per-item facts the push digest already has; no prices if the digest has none), at most 20 lines then `…and N more`, then a blank
  line and `<a href="SITE_URL">Open the screener</a>`. Keep under 4,096 characters.
- Test: `scan-control` gains an operator action `telegram_test` (cron secret, like the other operator actions) that sends
  "Test message from the stock screener." to the configured group and returns `{ ok, telegram_status, description }` (Telegram's own
  error description on failure, never the token).
- Allow-lists: `api.telegram.org` in the fetch call-site check; the two secret names in the secret inventory and the operator guide's
  secret table (one row each; Task 2 writes the rest of the docs).

## Global Constraints

TDD (RED then GREEN). Commits: conventional subject, body explains why, last line exactly
`Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; stage by name and commit with `git commit -m ... -- <paths>`; never
`docs/discovery/**`. Another agent is changing `supabase/functions/push-subscribe/**`, `_shared/adapters/push.ts`, `health/**`,
`apps/web/**` and `docs/cloudflare-go-live.md` right now: do not touch those. Judge `bun run lint` by its exit code.

### Task 1: backend

Files: migration `supabase/migrations/20261015009800_telegram.sql`, pgTAP `supabase/tests/1080_telegram.test.sql` (+ RLS matrix row),
new `supabase/functions/_shared/adapters/telegram.ts` (+ test), `supabase/functions/_shared/core/` formatter (+ test),
`supabase/functions/notify-dispatch/**`, `supabase/functions/worker-tick/handlers/digest*.ts`, `supabase/functions/scan-control/**`,
`supabase/functions/retention-cleanup/**` or the retention SQL, `tools/check-fetch-callsites.ts` (+ its config/test),
`tools/lib/secret-names.ts`, `supabase/functions/.env.example`, the secret table rows in `docs/operator-guide.md` section 2.4 only.
Checks: Deno tests (all), `bun run functions:check`, `bun run check:functions-config`, `bun run check:secrets`, `bun run test:core`,
`bun run test:tools`, `bunx supabase migration up` + `bun run test:db`, `bun run lint` (exit code).
Commit: `feat(notifications): post new companies to a Telegram group, only when something is new`.

### Task 2: docs (after Task 1 and the push fix)

`docs/operator-guide.md` (new section: create the bot with @BotFather, add it to the group, find the chat id, set the two secrets,
redeploy `notify-dispatch` and `worker-tick`, run `telegram_test`, troubleshooting by Telegram error description, how to turn it
off), `docs/cloudflare-go-live.md` (an optional part with the same steps in the runbook style), `README.md` one line.
