# Operator guide

Runbook for the personal stock screener. It takes the owner from nothing to a running, monitored system, and it is the reference
for every later change. Commands are PowerShell from the repository root unless a block says otherwise. `<ref>` is the 20-letter
Supabase project id. Never paste a secret into a committed file, into a `VITE_*` variable or into chat; this guide names secrets and
never shows a value.

## Go-live checklist (about 4 to 5 hours of owner time, spread over two or three days)

Do the steps in this order; each one points to the section that explains it. Waiting steps (DNS, domain verification, the first
scan) can run while you do the next one.

| # | Step | Time | Detail |
|---|---|---|---|
| 1 | Create the Supabase project (Free plan, nearest region), store the database password, note the project ref, create an access token | 10 min | 2.1 |
| 2 | `bunx supabase login`, `link`, `db push --dry-run`, `db push` (add `--include-all` if the dry run reports migrations older than the latest remote one) | 10 min | 2.1, 2.2 |
| 2a | Expose the `app` schema to the hosted REST API (Dashboard, Project Settings, Data API, Exposed schemas, add `app`) and run the verification `curl` of 2.2a. Without it every pipeline stage, broker sync, manual refresh and the health check fail with `PGRST106` | 5 min | 2.2a |
| 3 | Set every function secret (names only here): `CRON_SHARED_SECRET`, `RATE_LIMIT_SALT`, `SITE_URL`, `SEC_USER_AGENT`, `FLEX_ENC_KEY_V1`, `FLEX_ENC_KEY_CURRENT`, `FLEX_USER_AGENT`; VAPID with `bun run gen:vapid`; the provider keys of step 7 | 20 min | 2.3 |
| 4 | Deploy the Edge Functions (Docker must be running) | 5 min | 2.2 |
| 4a | After the first scan has started, measure the CPU time of one `worker-tick` invocation on the hosted project (Dashboard, Edge Functions, `worker-tick`, Logs or Metrics) and check it against the Free plan limit | 10 min | 2.2b |
| 5 | Vault secrets `project_url` and `worker_tick_secret` (same value as `CRON_SHARED_SECRET`); check `cron.job` | 5 min | 2.4 |
| 6 | Turn off public sign-ups, set the Site URL, add your own e-mail to `invited_emails` with `reset_password` ticked | 10 min | 3 |
| 7 | Gemini API key from Google AI Studio (free, no billing account) and `GEMINI_MODEL`; Tavily key (free); optional Jina key; `SEC_USER_AGENT` | 20 min | 9.1, 9.2 |
| 8 | Cloudflare account, API token (Edit Cloudflare Workers), account id | 15 min | 6 |
| 9 | GitHub: repository secrets and variables for the four workflows, `production` environment with yourself as reviewer | 15 min | 11 |
| 10 | Run "Deploy Supabase" (approve the migrations job) and "Deploy web"; attach the custom domain; enable HSTS in Cloudflare | 30 min | 6, 15 |
| 11 | Create the keep-alive user in Supabase Auth, store its two secrets, set `KEEPALIVE_ENABLED=true`, run "Keep-alive" once | 10 min | 12 |
| 12 | First live scan with `scan-control start` on a weekday afternoon, and watch it (it takes tens of minutes) | 15 min plus the run | 7, 8 |
| 13 | First research run: automatic after the scan for the discount candidates, or `research_now` for one security | 10 min plus the run | 9.4, 9.5 |
| 14 | Sign in to the site (e-mail, then create your password), install it on the phone (iOS: Safari, Share, Add to Home Screen, then open the Home Screen icon), turn notifications on from the bell | 15 min | 4.3, 4.4 |
| 15 | Profile, Broker: create the IBKR Activity Flex Query, token and link (sections and fields are listed on the page and in 5.2) | 30 min | 5 |
| 16 | Run the drills of section 15, record the results in `docs/discovery/p7-results.md`, and set a yearly reminder for the rotations of 13.2 | 1 hour | 13, 15 |

Not done by the build session and left to you: the first live Yahoo scan (section 0.4 gives the exact local commands to verify it
before the hosted run), the real-account Flex checks (5.4), the iBot checks (section 14), the hosted drills (section 15).

## 0. Local development (filled)

### 0.1 Prerequisites and commands

- Bun 1.3.x, Node 22.13.1 (`.node-version`), Docker Desktop, Deno 2.x (`npm i -g deno`). The Supabase CLI is a dev dependency.
- `bun install`, `bun run dev` (http://localhost:5173), `bun run supabase:start`, `bun run test:db`, `bun run supabase:serve`
  (second terminal), `curl http://127.0.0.1:54321/functions/v1/health`, `bun run supabase:stop`.
- Before pushing: `bun run lint`, `bun run typecheck`, `bun run test`, `bun run build`. Integration and browser suites:
  `bun run test:integration` (fixture scan, research, notifications, broker, EUR hand-off; the stack and `supabase:serve` must run),
  `bun run test:e2e` (production build with its real headers), `bun run test:e2e:local` (browser against the local stack).
- Local keys and URLs come from the `supabase start` output. They are local-only and never go into a committed file.
  `supabase/functions/.env`, `supabase/.env` and `apps/web/.env.local` are git-ignored.
- The local stack runs the real pg_cron jobs (`scan-catchup` fires every 15 minutes from 07:00 to 11:59 UTC, plus the scan, digest and broker jobs), which would compete
  with a fixture scan. `bun run test:integration` and `tools/e2e-setup.ts` therefore pause every active local job with `cron.alter_job(id, active := false)` (through
  `docker exec supabase_db_stock-screener psql`, local stack only) and reactivate exactly those jobs in a `finally` block. If a run is killed hard, check with
  `select jobid, jobname, active from cron.job;` or run `bunx supabase db reset`.
- After every migration regenerate the database types: `bun run types:gen` (the stack must be running).

### 0.2 Local files

```powershell
Copy-Item supabase/.env.example supabase/.env                     # Google placeholders so the stack starts
Copy-Item supabase/functions/.env.example supabase/functions/.env # Edge Function secrets
Copy-Item apps/web/.env.example apps/web/.env.local               # VITE_* values (local URL and the local anon key)
```

`supabase/functions/.env` needs these names for the full local suite (all values are throw-away fixtures, never reused on the hosted project):

| Name | Local value |
|---|---|
| `CRON_SHARED_SECRET` | any string (the example file uses `local-dev-cron-secret`) |
| `SITE_URL` | `http://localhost:5173` |
| `ALLOW_FIXTURE_PROVIDERS` | `1` (fixture scans; refused unless the Supabase URL is local) |
| `RATE_LIMIT_SALT` | any random string of at least 32 characters (otherwise `quotes`, `push-subscribe`, `account-access`, `broker-sync` and `portfolio-refresh` answer 500) |
| `FLEX_ENC_KEY_V1`, `FLEX_ENC_KEY_CURRENT` | base64 of 32 random bytes, and `1` |
| `FLEX_USER_AGENT` | `PersonalStockScreener/1.0` |
| `FLEX_FIXTURE_MODE` | `1` only while running `bun run test:integration:broker` |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | from `bun run gen:vapid -- mailto:you@example.com --out supabase/functions/.env.vapid`, copied across |
| `PUSH_ENDPOINT_EXTRA_HOSTS` | test seam of the notification integration suite, local only |
| `JWT_ISSUER` | `http://127.0.0.1:54321/auth/v1` (see 0.3) |
| `GEMINI_*`, `TAVILY_API_KEY`, `JINA_API_KEY`, `SEC_USER_AGENT` | leave empty: the research integration scenario uses recorded fixtures |

### 0.3 Known local quirks

- Inside the Edge runtime `SUPABASE_URL` is `http://kong:8000`, and the CLI ignores a `SUPABASE_URL` override in `functions/.env`.
  The code accepts `kong` as a local stack, so fixture mode and fake push URLs work.
- The local Auth service issues tokens with the issuer `http://127.0.0.1:54321/auth/v1`, while the functions expect
  `${SUPABASE_URL}/auth/v1` (`http://kong:8000/auth/v1` locally). Without help, every user-JWT function answers 401 to a real local
  sign-in token. Set `JWT_ISSUER=http://127.0.0.1:54321/auth/v1` in `supabase/functions/.env` so the functions accept the local
  issuer. Never set `JWT_ISSUER` on the hosted project: hosted tokens already match. (The integration tests mint their tokens with that same
  issuer, so they need `JWT_ISSUER` set as well.)
- A stale local migration-history row can exist on a machine that ran an earlier version of the migrations. If `supabase start` or a
  local push complains about the history, run `bunx supabase db reset` once; it rebuilds the local database from the migrations.
- pgTAP suites assume an empty database: after `test:integration` run `bunx supabase db reset` before `bun run test:db`.
- The local runtime does not enforce the hosted 2 s CPU limit; hosted timing is measured in the first live scan (0.4).
- `worker-tick` may answer 502 occasionally under a long `wait:true` run; leases recover and the tools retry (13.4).

### 0.4 First live verification of the Yahoo scan (owner step, never run in the build session)

The build session ran everything against recorded data (automation of the live run was denied by the permission system and not
bypassed); the first run against real Yahoo is yours. Do it locally before the hosted one, at a quiet time (weekend or evening).
Stack running (`bun run supabase:start`) and `bun run supabase:serve` in a second terminal.

```powershell
bunx supabase db reset
# in Studio SQL editor (http://127.0.0.1:54323) or psql; only the minute cron needs them, scan:local drives the worker directly
select vault.create_secret('http://host.docker.internal:54321', 'project_url');
select vault.create_secret('<the CRON_SHARED_SECRET of supabase/functions/.env>', 'worker_tick_secret');
bun run scan:local -- start --mode live
bun run scan:local -- tick --max-minutes 60      # repeat until the run is terminal
bun run scan:local -- status
bun run scan:local -- failures
```

What to compare and record in `docs/discovery/p1-results.md`:

1. `status` ends `complete` (or `partial` with coverage of 95% or more); `failures` is short and each dead job has a readable `last_error`.
2. `{"action":"recompute","run":"<date>"}` through `scan-control` (section 8 shows the call) gives identical ranks and signals.
3. Wall time and CPU of the `fetch_bars` (12 per job) and `compute` (25 per job) stages: after the first hosted scan read the stage
   durations in `scan_events`, then freeze the batch sizes with `set_setting` key `pipeline` (open item P1-07).
4. Size projection (open item P1-08): extrapolate the `price_series` bytes per security to about 600 securities (target below 300 MB):

```sql
select relname, pg_size_pretty(pg_total_relation_size(oid)) from pg_class
 where relnamespace = 'public'::regnamespace and relkind = 'r' order by pg_total_relation_size(oid) desc;
```

5. Spot-check three securities against TradingView with the procedure in spec 17.6 (levels at full precision; a difference caused by
   dividend adjustment is a data difference, not a bug).

## 1. Configure and validate the data provider (filled)

Market data comes from Yahoo Finance through the unofficial `yahoo-finance2` library, behind a provider interface in
`supabase/functions/_shared/adapters`; FX rates come from Frankfurter with Yahoo as the fallback. Nothing needs an account or a key.

**Decision record (owner, 2026-10-15, spec 15.5).** Yahoo's terms prohibit automated collection and commercial reuse; the research
verdict was NO-GO; the owner accepted the risk and chose zero cost. Consequences: Yahoo can block or change its endpoints at any
time, a legal notice is possible, and the site states that market data comes from Yahoo Finance, delayed, for information only. If
Yahoo objects, stop publishing or switch the provider (only the Yahoo adapter changes). Open question Q-03 (is a private
public-facing site "commercial") stays with the owner.

**Etiquette built in.** At most 3.3 requests per second, a circuit breaker (consecutive 429 or 5xx answers open it for a while), a
request budget per function call, one daily sweep, a short quote cache, no per-visitor fan-out.

### 1.1 Validate the provider (after the first deployment and after any Yahoo incident)

```powershell
curl.exe -sS https://<ref>.supabase.co/functions/v1/health        # {"ok":true,"version":...,"time":...}; no secrets
```

```sql
-- FX rows of the latest days (source frankfurter or yahoo); a currency missing for 4 days is stale
select ccy, usd_per_unit, rate_date, source from fx_rates order by rate_date desc, ccy limit 30;
-- Yahoo behaviour of the last scan: breaker, budget, schema drift
select at, level, event, data from scan_events where event like 'yahoo_%' order by at desc limit 30;
```

Healthy: no `yahoo_breaker_open`, `yahoo_schema_drift` rare, FX rows dated within 4 days.

### 1.2 The kill switch

Freeze every Yahoo request (the worker reschedules jobs without spending attempts, `quotes` serves cached rows or answers an error,
and the site keeps showing the last published data with a stale banner):

```powershell
$h = @{ "x-cron-secret" = $env:CRON_SHARED_SECRET }
$body = '{"action":"set_setting","key":"providers","value":{"yahoo_enabled":false},"confirm":true,"reason":"Yahoo blocking requests"}'
Invoke-RestMethod -Method Post -Uri "https://<ref>.supabase.co/functions/v1/scan-control" -Headers $h -ContentType "application/json" -Body $body
```

Switch it back with `"yahoo_enabled":true` and a new reason. The value must be exactly `{"yahoo_enabled": <boolean>}`; every change is
written to `audit_events`. A malformed stored value never freezes the site: only an explicit `false` does.

### 1.3 Switching provider

Implement the provider interface for the new source (spec 5.1), keep the core untouched, add the host to
`tools/lib/fetch-callsites.ts` (`bun run check:fetch`), update the data-source statement on `/about`, and record the decision here
with its date.

## 2. Configure Supabase, Vault, cron and function secrets (filled)

All commands run from the repository root. Generate random values with a Bun one-liner (32 random bytes):

```powershell
bun -e "console.log(Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url'))"   # CRON_SHARED_SECRET, RATE_LIMIT_SALT
bun -e "console.log(Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64'))"      # FLEX_ENC_KEY_V1 (exactly 32 bytes, base64)
openssl rand -base64 32                                                                               # alternative for either (Git Bash, Linux)
```

### 2.1 Create the project and link the repository

1. Supabase dashboard, New project (Free plan, the region closest to you, a strong database password stored in your password
   manager). Note the **project ref** (the 20-letter id in the URL) and the password.
2. Dashboard, Account, Access Tokens: create a token for the CLI and for CI (`SUPABASE_ACCESS_TOKEN`).
3. `supabase/config.toml` is committed; every function has `verify_jwt = false` because functions authenticate in code
   (`bun run check:functions-config` enforces it).
4. Link and inspect:

```powershell
bunx supabase login
bunx supabase link --project-ref <ref> --password <database password>
bunx supabase db push --dry-run
```

### 2.2 Push the migrations, then deploy the functions (order matters: database first)

```powershell
bunx supabase db push
bunx supabase functions deploy --project-ref <ref>
```

`db push` applies the local migrations that are not in the remote history table, in file-name order. The migrations were created
across several phases and their file names are not in strict creation order, so on an existing project the dry run can report
migrations older than the latest remote one; in that case, and only after reading the dry-run list, use `bunx supabase db push --include-all`
("include all migrations not found on remote history table"). A new empty project needs no flag. The CLI needs Docker running to bundle
functions. Migrations are forward-only (13.4).

The invite-only release adds two migrations: `20261015009600_invited_emails.sql` (the invite list and the lookup used by `account-access`)
and `20261015009700_device_push.sql` (device notifications without an account). The release also adds the function `account-access` and
changes `push-subscribe`, `notify-dispatch` and `worker-tick`. Run `db push` and `functions deploy` back to back, in that order. The new
functions expect the new tables, and the old functions do not understand the new rows.

### 2.2a Expose the `app` schema to the hosted REST API (required, right after `db push`)

The functions call the service-only helpers in schema `app` through PostgREST (`sb.schema("app")`). The `schemas` list under `[api]` in
`supabase/config.toml` only configures the local stack, and `db push` does not apply it: a new hosted project exposes only `public` and
`graphql_public`, so every `app` call answers `PGRST106` (the `health` function then reports `"error": "app_schema_not_exposed"`).

1. Dashboard, Project Settings, Data API, **Exposed schemas**: add `app` next to `public` and `graphql_public`, then save.
   (Alternative: `bunx supabase config push --project-ref <ref>` pushes every property `config.toml` declares, including auth and API
   settings written for the local stack. Run `bunx supabase config diff` first and answer `n` to every change except the `[api]` one.
   The Dashboard route is the safe default.)
2. Verify with the service key (Dashboard, Project Settings, API keys; never paste it anywhere else). `database_size` is a harmless read-only function:

```powershell
curl.exe -s "https://<ref>.supabase.co/rest/v1/rpc/database_size" -H "apikey: <service key>" -H "Authorization: Bearer <service key>" -H "Accept-Profile: app"
```

Expected: a bare number such as `13287423` (the database size in bytes). If you get `{"code":"PGRST106", ...}` the schema is not exposed yet; wait
a few seconds after saving and retry. Then call the `health` function (section 12): it must answer `"ok": true`.

Exposing `app` is safe: usage on the schema is revoked from `anon` and `authenticated` (`revoke all on schema app from public, anon, authenticated`,
`20261015001200_pipeline_functions.sql` line 7; also `20261015000100_extensions.sql` lines 9 and 10), every function in it has execute revoked from
`public`, `anon` and `authenticated` (same file, line 573), and only `service_role` has usage. Browser and user tokens cannot reach it.

The deploy workflow (`.github/workflows/deploy-supabase.yml`) deliberately does not run `config push`: it pushes every declared `config.toml` property
(auth, site URL, rate limits), which would overwrite hosted settings the Dashboard owns, so it is a one-time owner step.

### 2.2b Measure one worker-tick invocation (owner gate)

After the first scan has started, open Dashboard, Edge Functions, `worker-tick`, Logs (or Metrics) and read the execution time of one invocation. The
Free plan allows about 2 s of CPU time per request (wall clock is longer), and the per-invocation work is bounded by
`app_settings.pipeline`: `claim_limit` (jobs claimed, at most 10) and `max_heavy_jobs_per_invocation` (default 2, at most 20; heavy jobs are the
CPU-bound stages such as indicator ranking). If the CPU time is near the limit or invocations are killed, lower `max_heavy_jobs_per_invocation`
(or `claim_limit`) with `scan-control set_setting` key `pipeline` (section 7) and measure again. This cannot be measured offline, so it stays an owner check.

`pipeline.max_heavy_jobs_per_invocation` is an integer from 1 to 20, default 2. The heavy stages are `fetch_bars`, `compute`, `rank_signals` and
`portfolio_scan`. Throughput: about 125 heavy jobs for about 1,000 securities finish in about 63 minutes, well before the 13:00 Sofia cutoff, so the default
leaves a wide margin and raising it is rarely needed.

**Timing bounds** (also under `pipeline`): `stop_claiming_ms <= 100000`; `stop_claiming_ms < hard_deadline_ms <= 130000`;
`lease_seconds >= hard_deadline_ms / 1000 + 30`. Out-of-bounds stored values fall back to the defaults (a warning is logged), and `scan-control set_setting`
answers 400 for them.

**Episode close reason `left_universe`**: an active discount episode is closed with `close_reason = 'left_universe'` when its security has had no result row in
the current scan and in the 2 previous complete or partial scans (it dropped out of the universe, for example a delisting). This is a lead assumption because the spec
is silent; it is recorded as assumption A-44 in the design spec. A later re-entry then opens a new episode and a "new entry" notification.

**The discount rule (assumption A-51, owner decision 2026-10-16)**: a company is a discount, and gets a card, a digest entry and research, when its latest
completed close is at or below its -3 line, whatever its rank. The unchanged gates still apply: the -3 line must be above zero, the channel must be rising, the
bars must be sufficient and the data fresh. The rank only decides the tag on the card: ranks 1 to 10 are "Strong buy"; rank 11 and below say "Reached its -4 line"
when the close is also at or below the -4 line, and "Wait for the -4 line" otherwise. New discount episodes record `threshold_line = '-3'`; a `-4` episode that was
already open before this change is closed once (`threshold_changed`) and continued silently on the -3 line by the next scan, so nobody is notified twice.
`universe_snapshots.applicable_line` is now `-3` for every rank (it used to be `-4` below rank 10). The feed (`v_todays_discounts`, `todays_discounts_feed`) carries
`line3_end`, `line4_end`, `reached_line4` and `is_top10`, and the digests and pushes show the same tag. To see which line a card crossed:
`select yahoo_symbol, rank, close, line3_end, line4_end, reached_line4, is_top10 from public.v_todays_discounts order by rank;`

### 2.3 Function secrets (set once and on rotation; CI never sets them)

Create `supabase/functions/.env.production` (git-ignored by `.env*`), fill it, set it, then delete it:

```text
CRON_SHARED_SECRET=<random>
RATE_LIMIT_SALT=<random>
SITE_URL=https://<your domain>
SEC_USER_AGENT=Your Name your.email@example.com
FLEX_ENC_KEY_V1=<base64 of 32 bytes>
FLEX_ENC_KEY_CURRENT=1
FLEX_USER_AGENT=PersonalStockScreener/1.0 (+you@example.com)
```

```powershell
bunx supabase secrets set --env-file supabase/functions/.env.production --project-ref <ref>
bunx supabase secrets list --project-ref <ref>
```

`secrets list` prints names and digests only: compare the names with the inventory in 13.2. The other secrets are set in the section
that explains them: `GEMINI_API_KEY`, `GEMINI_MODEL`, `TAVILY_API_KEY`, `JINA_API_KEY` (optional), `LLM_*` (section 9);
`VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` (section 4).
`SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` are injected by the platform.
**`ALLOW_FIXTURE_PROVIDERS`, `FLEX_FIXTURE_MODE`, `PUSH_ENDPOINT_EXTRA_HOSTS` and `JWT_ISSUER` are local-only and are never set on
the hosted project.**

### 2.4 Function secret reference (checked by `bun run check:secrets`)

Every name the Edge Functions read must appear in this guide and, when it holds a secret, in `tools/lib/secret-names.ts` (so the
bundle scan rejects it in the browser build).

| Name | Meaning |
|---|---|
| `SUPABASE_SERVICE_ROLE_KEY` | Injected by the platform; used by every function that writes with the service role. Never set it by hand, never put it in the web build. |
| `CRON_SHARED_SECRET` | Authenticates the minute tick, the daily cron calls and the owner's `scan-control` calls (`x-cron-secret` header). Same value as the Vault secret `worker_tick_secret`. |
| `RATE_LIMIT_SALT` | Random string of at least 32 characters; hashes client IPs for the per-IP rate limits (`quotes` 60 per minute, `push-subscribe` 20, `account-access` 10 per minute and 60 per hour,
`broker-sync` 20, `portfolio-refresh` 60). |
| `SITE_URL` | Public site URL, used as the allowed CORS origin. |
| `EXTRA_ALLOWED_ORIGINS` | Optional. Comma-separated extra browser origins allowed to call the functions, for example `http://localhost:5173` while you develop locally against the hosted project. |
| `SEC_USER_AGENT` | Contact string the SEC requires on every EDGAR request (section 9.1). |
| `FLEX_ENC_KEY_V1`, `FLEX_ENC_KEY_CURRENT` | AES key (base64, 32 bytes) for stored Flex tokens and the version number (a plain integer) used for new tokens (section 5). |
| `FLEX_USER_AGENT` | Mandatory User-Agent for IBKR Flex requests, for example `PersonalStockScreener/1.0`. |
| `JWT_ISSUER` | Local only: the issuer of local user tokens (section 0.3). |
| `TELEGRAM_BOT_TOKEN` | Optional. The bot token from @BotFather; with `TELEGRAM_CHAT_ID` it switches on the Telegram group message of each new public digest (sent by `notify-dispatch`). Either one unset = off. Never logged. |
| `TELEGRAM_CHAT_ID` | Optional. The id of the group the bot posts to (a negative number such as `-1001234567890`). |

### 2.5 Vault secrets and the cron jobs

The minute tick and the daily jobs read two Vault secrets. Run once in the SQL editor (Dashboard, SQL), using the same value as
`CRON_SHARED_SECRET` for the second one:

```sql
select vault.create_secret('https://<ref>.supabase.co', 'project_url');
select vault.create_secret('<the CRON_SHARED_SECRET value>', 'worker_tick_secret');
```

To change one later: `select vault.update_secret(id, '<new value>') from vault.secrets where name = 'worker_tick_secret';` and set
the function secret to the same value in the same minute (the tick fails with 401 for that minute otherwise, which is harmless).
`app.kick_workers()`, `app.kick_broker_sync()` and the digest functions do nothing until both exist. Verify the schedule:

```sql
select jobname, schedule, active from cron.job order by jobname;
select jobname, status, start_time from cron.job_run_details order by start_time desc limit 10;
```

Expected jobs (UTC): `scan-start-0700` and `scan-start-0800` (10:00 Sofia in summer and winter time; one wins by the Sofia-hour
guard), `scan-catchup` (every 15 minutes from 07:00 to 11:45), `tick-minute`, `purge-cron-history` (01:45), `digest-cutoff-1000`
and `digest-cutoff-1100` (13:00 Sofia), `broker-daily-0500` and `broker-daily-0600`, `broker-tick`, `retention-notifications` (01:40).
There is no cron job for the `retention-cleanup` function: see 13.3.

### 2.6 Local function secrets

See section 0.2. For the full local suite `bun run supabase:serve` reads `supabase/functions/.env`.

## 3. Configure authentication: invite-only access

Access is by invitation. You keep a list of e-mail addresses in the table `invited_emails`. Only people on the list can create an
account. The site sends no e-mails: there is no confirmation mail, no reset mail and no magic link. Google sign-in and public sign-up are
not used.

What the repository fixes: `supabase/config.toml` describes the LOCAL stack (Site URL `http://localhost:5173`, password policy,
a redirect allow-list). `bun run check:auth-config` guards it. Production values are set in the Supabase Dashboard, as below.

### 3.1 Invite-only access

How it works for a friend:

1. The friend opens the site and presses Sign in. The page asks for an e-mail only.
2. If the e-mail is on the list and has no account yet, the page asks for a password and a confirmation. The password needs 12 to 72
   characters. The account is created and the friend is signed in.
3. If the e-mail is on the list and the account exists, the page asks for the password.
4. If the e-mail is not on the list, the page says "Not possible yet" and nothing else.

What a signed-in friend sees: the same site as everyone, plus the Profile page (change password, link IBKR Flex), the Portfolio and
Analytics pages, and holdings alerts on the bell. Everyone, signed in or not, sees Trade on IBKR on the cards and can turn on device
notifications (section 4).

**Add a friend.** Supabase Dashboard, Table Editor, table `invited_emails`, Insert row. Fill `email`. Leave `reset_password` unticked.
`note` is free text for you. The e-mail is lower-cased and trimmed automatically. Tell your friend to open the site and sign in.

**Reset a forgotten password.** The site cannot send mail, so you do it. Open the friend's row in `invited_emails` and tick `reset_password`.
The friend's next sign-in asks for a new password and a confirmation. When it is saved, the flag clears itself. Until then, whoever types
the e-mail first sets the new password. Tick the box when your friend is ready to sign in.

**Remove someone.** Do both steps.

1. Delete the row in `invited_emails`.
2. Delete the user: Dashboard, Authentication, Users, open the user, Delete user.

Deleting the user also deletes their broker link, statements, positions and notification settings (those tables cascade from the user).
Deleting only the row leaves the account alive, and the person can still sign in with the old password. The row decides who can create or
reset an account. The user decides who can sign in.

**Your own first sign-in.** If your account was a Google account, it has no password. Add your e-mail to `invited_emails` with
`reset_password` ticked, then sign in on the site and create a password. If your account does not exist yet, add the row without the
tick. Either way you end up signed in with a password.

**Switch off public sign-up on the hosted project.** Dashboard, Authentication, Sign In / Providers, turn OFF "Allow new users to sign up".
The invite flow creates users through the admin API, so it keeps working. In the same place you can disable the Google provider, because
nothing uses it any more. Do both before you share the address.

What you accept, stated plainly:

- The first step shows whether an e-mail is on the list ("create password" or "sign in" against "Not possible yet"). This was your decision.
- An invite that nobody has used yet can be claimed by whoever types that e-mail first. Add a friend when they are ready to sign in.
- The app sends no e-mails. Confirmation mail is not needed because the account is created already confirmed.

Limits: `account-access` allows 10 calls per minute and 60 per hour per IP address. After that it answers 429 and the page asks the visitor
to wait.

### 3.2 Supabase dashboard (production project)

1. Authentication, URL Configuration: set **Site URL** to `https://<domain>`. The web app never sends a redirect address to Supabase,
   and the pages `/auth/callback`, `/auth/update-password` and the other old auth pages are gone. The Redirect URLs list is therefore
   not used. Remove the old entries (`/auth/callback`, `/auth/update-password`).
2. Authentication, Sign In / Providers, **Email**: keep the provider enabled, because it checks the passwords. Confirm email can stay
   as it is, because users are created already confirmed.
3. Turn off "Allow new users to sign up" as in 3.1.
4. Test once: open `https://<domain>/portfolio` while signed out, sign in, and confirm you land on `/portfolio`.

### 3.3 Mail limits

The app sends no mail, so the built-in mailer budget (2 messages per hour) no longer matters.

### 3.4 Local development

- `Copy-Item supabase/.env.example supabase/.env`, then `bun run supabase:start`.
- To sign in locally, insert your e-mail in `invited_emails` (Studio, `http://127.0.0.1:54323`, Table Editor), then sign in on the site.
- Local end-to-end test: `bun run test:e2e:local` (needs the stack running; stop other dev servers). Its setup adds the two test
  users to `invited_emails` by itself on a full run; a stack prepared before that change needs one run without `--ensure`.

## 4. Configure Web Push (VAPID) (filled in P3)

### 4.0 Device notifications: who gets what

Anyone can turn on notifications from the bell in the header. No account is needed. The bell registers the browser on that device. Each
device has two switches:

- **New companies on the list.** On by default. Every device gets one digest per scan run, built once for the whole site. An empty digest
  is never sent.
- **Holdings alerts.** Only for devices where a user is signed in. A signed-out device cannot turn this on, and the server forces it off.

A signed-in device gets its user's own digest, so it never gets both. Signed-in devices registered before this release kept their
holdings alerts. A device registered without an account stays anonymous until the user signs in on it and opens the site again. The site
then ties the device to the user.

An iPhone or iPad only receives notifications from the Home Screen app (4.4). In a Safari tab the bell shows the steps instead.


### 4.1 VAPID keys (Web Push)

Generate one key pair for the project (never reuse keys between environments). The private key must
exist only as a Supabase function secret; the public key is shipped to the browser.

```powershell
bun run gen:vapid -- mailto:you@example.com --out supabase/functions/.env.vapid
supabase secrets set --env-file supabase/functions/.env.vapid --project-ref <ref>
```

The file defines `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` (a JWK on one line), `VAPID_SUBJECT` and
`VITE_VAPID_PUBLIC_KEY`. `supabase secrets set` stores the first three as function secrets (the
`VITE_` line is stored too and is harmless). Then add the public key as the web build variable
`VITE_VAPID_PUBLIC_KEY` (section 11) and redeploy the web app. Delete `supabase/functions/.env.vapid`
afterwards (it is git-ignored, but it holds the private key). Rotating the key pair invalidates every
stored subscription: users must switch push off and on again.

### 4.2 Which companies a digest lists

A digest lists the companies **new on the list**: rows of the published run whose episode is new, or whose security was not on the previous published list of the same mode (a company that re-enters counts as new). Research state does not matter, so digests are built at publish time and no longer wait for research. Each entry says "Not researched yet" when no complete report exists. Companies that stay on or leave the list send nothing.

### 4.3 Verify Web Push on real devices (spike P3-01, manual)

The automated spike (`bun run spike:push`) proves the request shape and payload decryption against a local
fake push service. A real receive test is a manual step. For each row, open the bell,
turn notifications on, press **Send test notification** and tick the row. Repeat once against
`supabase functions serve` and once against the deployed function.

| Client | Local serve | Deployed | Notes |
|---|---|---|---|
| Chrome desktop | [ ] | [ ] | |
| Firefox desktop | [ ] | [ ] | |
| Android Chrome | [ ] | [ ] | |
| iPhone or iPad Home Screen app (iOS 16.4+) | [ ] | [ ] | permission prompt only after tapping the switch |

If any row fails because of the library (`jsr:@negrel/webpush`), record it in the spec open-question table and
switch the adapter to `web-push-neo` (spec 10.4).

### 4.4 What to tell iPhone and iPad users

"On iPhone and iPad, notifications work from iOS 16.4 and only for apps added to the Home Screen. Tap Share,
choose Add to Home Screen, open Stock Screener from the Home Screen icon, then open the bell and turn
notifications on." Safari tabs cannot receive push; the bell shows these
steps instead of the switches until the app runs from the Home Screen.

### 4.5 Checks after configuration

- Bell -> **Send test notification** arrives on every enabled device.
- Locally, `bun run test:integration:notifications` replays the whole path against a fake push server (digest once per user and kind, push headers, 410 revoke, 429 retry, 13:00 Sofia cut-off).

### 4.6 Troubleshooting

| Symptom | Cause and action |
|---|---|
| Deliveries `skipped` with `no_subscription` | the push service answered 404/410 (subscription revoked); the user must turn notifications off and on again from the bell |
| Deliveries `failed` with `expired` | the digest was older than 24 hours when a retry came due |

### 4.7 Removing e-mail from the hosted project

Notifications are Web Push only. The e-mail channel, Resend, `resend-webhook` and `notify-unsubscribe` are gone from the code. The hosted project may still hold the old functions and secrets. Remove them once, after the new code is deployed:

```powershell
bunx supabase functions delete resend-webhook --project-ref pkfptuwwgyvjxvumqika
bunx supabase functions delete notify-unsubscribe --project-ref pkfptuwwgyvjxvumqika
bunx supabase secrets unset RESEND_API_KEY RESEND_WEBHOOK_SECRET EMAIL_FROM UNSUBSCRIBE_SECRET RECIPIENT_HASH_SECRET FUNCTIONS_PUBLIC_URL RESEND_API_URL --project-ref pkfptuwwgyvjxvumqika
bunx supabase db push
```

`db push` applies the migration `20261015009500_remove_email.sql`. It turns every stored e-mail preference off and skips pending e-mail deliveries. Deploy `notify-dispatch` and `worker-tick` together with it. Also delete the Resend webhook endpoint in the Resend dashboard (Webhooks). The old e-mail tables and columns stay in the database unused.

## 5. Set up and verify IBKR Flex (filled in P5b)

Scope: read-only reporting through the IBKR Flex Web Service. The app never places orders, never asks for an IBKR username or password and never stores a token in the browser.

### 5.1 Function secrets

| Secret | Value | Notes |
|---|---|---|
| `FLEX_ENC_KEY_V1` | base64 of exactly 32 random bytes | AES-256-GCM key for the stored Flex tokens. Generate it in PowerShell: `[Convert]::ToBase64String([System.Security.Cryptography.RandomNumberGenerator]::GetBytes(32))` |
| `FLEX_ENC_KEY_CURRENT` | `1` | Version used for new ciphertext; the stored `key_version` selects the key when opening |
| `FLEX_USER_AGENT` | for example `PersonalStockScreener/1.0 (+you@example.com)` | IBKR requires a User-Agent on every Flex request |
| `CRON_SHARED_SECRET` | already set (section 2) | Authenticates the minute tick and the daily cron call of `broker-sync` |

Set them with `bunx supabase secrets set --env-file <file>` (the file is never committed) or in the dashboard. `FLEX_FIXTURE_MODE` must **never** be set on the hosted project: it is the local-only switch of the integration test (`bun run test:integration:broker`), and `broker-sync` refuses it unless `SUPABASE_URL` is a local stack.

### 5.2 Link your account (what the user does)

Follow the checklist on Profile, Broker (it lists every Flex section and field, Format XML, Period Last 365 Calendar Days, Date Format yyyyMMdd, no IP restriction). After pressing Link the page shows Verifying, then Linked, or the exact missing sections and fields. A first successful link queues one 365-day backfill. Daily syncs run at 08:00 Europe/Sofia (cron jobs `broker-daily-0500` and `broker-daily-0600`; exactly one of them passes the Sofia-hour guard), and `broker-tick` advances runs every minute.

### 5.3 Rotating the encryption key

1. Generate a new key and add it as `FLEX_ENC_KEY_V2` (keep `FLEX_ENC_KEY_V1`).
2. Set `FLEX_ENC_KEY_CURRENT=2` and redeploy the functions.
3. Run the admin action once: `Invoke-RestMethod -Method Post -Uri "<project>/functions/v1/broker-sync" -Headers @{ "x-cron-secret" = "<CRON_SHARED_SECRET>" } -ContentType "application/json" -Body '{"action":"rekey"}'`. The answer is `{ ok, rekeyed, failed }`; repeating the call is harmless (`rekeyed: 0`).
4. Only when `failed` is 0 and every connection reports `key_version = 2` (`select key_version, count(*) from broker_connections group by 1` as the postgres role), delete `FLEX_ENC_KEY_V1`.
5. If V1 was removed too early, affected connections show "The stored token cannot be decrypted with the current server key" and the owner must link again; no Flex call is made with an unreadable token.

### 5.4 Verification items that need the real account (P5-01 to P5-06)

Run these once with the owner's account and record the results in this section: capture one real statement and redact it into `fixtures/flex/` (then confirm or correct the element and attribute spellings in `flex-parse.ts`, the Cash Transactions `Type` vocabulary in `cash-types.ts` and the Corporate Actions types); measure XML size and parser CPU for 365 days (split into 90-day windows if the Edge limits are hit); check whether `fd`/`td` may span more than 365 days; verify the daily statement availability time; confirm that Flex reports LSE positions in GBP major units (the app divides Yahoo's `GBp` by 100 and rejects a x100 mismatch); reconcile unrealized, realized and dividends against the IBKR statement (section 10).

### 5.5 The local integration test

`bun run test:integration:broker` (stack up, `FLEX_FIXTURE_MODE=1` in `supabase/functions/.env`) posts the fixture statement `fixtures/flex/activity-sample.xml` to `broker-sync` in worker mode and checks the rows of all six tables, the ISIN matching, an idempotent re-run (no duplicate lots), row isolation between two users, that the token columns cannot be read, and the manual-refresh cooldown (one 200 and four 429 for five parallel requests). The test mints its user tokens with the local JWT secret and the issuer a real local sign-in carries (`http://127.0.0.1:54321/auth/v1`), so `supabase/functions/.env` must set `JWT_ISSUER=http://127.0.0.1:54321/auth/v1` (section 0.3), the same value the e2e browser sign-ins need.

## 6. Deploy the web app (filled)

The step-by-step path from the current hosted project to an always-on Cloudflare site is in [cloudflare-go-live.md](cloudflare-go-live.md).

One-time Cloudflare setup:

1. Create or log in to a Cloudflare account (Free plan; the app processes no card data).
2. Create an API token: My Profile -> API Tokens -> "Edit Cloudflare Workers" template, scoped to the
   account. Note the Account ID (Workers & Pages overview).
3. Add the GitHub secrets and variables listed in section 11.
4. Run workflow "Deploy web" manually (Actions -> Deploy web -> Run workflow). The first run creates
   the Worker `stock-screener` (name in `apps/web/wrangler.jsonc`) with static assets and the SPA fallback.
5. Attach a custom domain in the Cloudflare dashboard (Workers & Pages -> stock-screener -> Settings ->
   Domains) and set the repository variable `VITE_SITE_URL` to it.
6. The Content-Security-Policy in `apps/web/public/_headers` is enforced. `__SUPABASE_ORIGIN__` is replaced after every build with the
   origin of `VITE_SUPABASE_URL` (`bun run render:headers`, verified by `bun run check:headers`); the deploy workflow therefore
   needs no manual edit. Strict-Transport-Security is not in the file: in the Cloudflare dashboard open SSL/TLS, Edge Certificates and
   enable HSTS (max-age at least 6 months, include subdomains only when every subdomain is https). Check the result with
   `curl.exe -sI https://<your domain>` (look for `content-security-policy` and `strict-transport-security`).

The workflow refuses to build when a `VITE_*` variable is empty, local, plain-http or secret-looking,
and scans the built bundle for secrets before uploading.

## 7. Run a safe manual scan (filled)

A scan is idempotent per Europe/Sofia date: starting it again does not create a second run for the same date (spec 7.11), and a scan
never changes anything that a re-run would not recompute. The automatic scan starts at 10:00 Sofia time by `pg_cron`.

**Locally with recorded data (safe, no network):**

```powershell
bun run supabase:start
bun run supabase:serve                                   # second terminal
bun run scan:local -- start --mode fixture
bun run scan:local -- tick --max-minutes 20
bun run scan:local -- status
bun run scan:local -- failures
```

Fixture mode is refused unless the Supabase URL is local (spec 7.12). Live mode against real Yahoo, locally: section 0.4.

**On the hosted project (live Yahoo data):**

```powershell
$h = @{ "x-cron-secret" = $env:CRON_SHARED_SECRET }
Invoke-RestMethod -Method Post -Uri "https://<ref>.supabase.co/functions/v1/scan-control" -Headers $h -ContentType "application/json" -Body '{"action":"start","provider_mode":"live"}'
```

The minute tick (`pg_cron`) then works through the stages; nothing else is needed. A full worldwide scan takes tens of minutes. Do
the first one on a weekday afternoon when you can watch it (section 8).

`scan-control` actions (all need the `x-cron-secret` header and a JSON body):

| Action | Arguments | Effect |
|---|---|---|
| `start` | `provider_mode` `live` (default) or `fixture`; `now` and `fixture_set` only with fixture | starts or returns the run of today (Sofia date) |
| `status` | optional `run` (uuid or `YYYY-MM-DD`) | run row, coverage and job counts per stage |
| `list_failures` | optional `run` | failed and dead jobs with their errors |
| `requeue` | `run` | puts dead and failed jobs back in the queue |
| `recompute` | `run` | re-derives ranks and signals from stored series |
| `set_setting` | `key` one of `indicator`, `universe`, `pipeline`, `providers`; `value`; `reason` (3 characters or more); `confirm` `true` | audited settings change |
| `override` | `kind`, `yahoo_symbol`, `reason`, ... | identity override (`force_canonical`, `exclude`, `force_us`, `force_not_us`, `merge_into_company`, `predecessor_continuity`) |
| `research_now` | `security_id`, optional `force` | queues a manual research report (section 9.4) |

The research caps and the EUR catalogue switch are not `set_setting` keys: change them with SQL on `app_settings` (9.3, section 14).

## 8. Inspect coverage and failures (filled)

```powershell
$h = @{ "x-cron-secret" = $env:CRON_SHARED_SECRET }
Invoke-RestMethod -Method Post -Uri "https://<ref>.supabase.co/functions/v1/scan-control" -Headers $h -ContentType "application/json" -Body '{"action":"status"}'
Invoke-RestMethod -Method Post -Uri "https://<ref>.supabase.co/functions/v1/scan-control" -Headers $h -ContentType "application/json" -Body '{"action":"list_failures"}'
```

```sql
-- the last runs: status, coverage (processed/total candidates, whether the list was published) and universe sizes
select scan_date_local, status, started_at, finished_at, latest_session_date, coverage, universe_sizes
  from scan_runs order by scan_date_local desc limit 7;

-- jobs that failed or died in the latest run
select stage, key, status, attempts, last_error from scan_jobs
 where scan_run_id = (select id from scan_runs order by scan_date_local desc limit 1) and status in ('failed', 'dead')
 order by stage, key limit 50;

-- recent events (counts, durations, reason codes; never secrets)
select at, level, event, data from scan_events order by at desc limit 50;
```

How to read it: `complete` is the goal; `partial` means some candidates stayed unprocessed (the list is published only at 95% or more
of candidates, the site shows the coverage panel); `failed` means nothing was published and the site shows the last good data with a
banner. A `dead` job exhausted its attempts: read `last_error`, fix the cause, then `{"action":"requeue","run":"<date>"}` to try the
dead and failed jobs again, or `{"action":"recompute","run":"<date>"}` to re-derive results from stored series. The incident runbooks
are in section 13.4.

### 8.1 Which instruments and which listing of a company are screened (A-50)

Owner decision 2026-10-16: trust only the primary listing of a company, and only shares. Every scan applies these rules again, so a change
of rule or of Yahoo data takes effect at the next scan without any clean-up.

**Shares only.** The sweep, the quote checks and the identity step keep only Yahoo `quoteType = EQUITY`. Bonds, notes, ETFs, funds,
warrants, rights and structured products are dropped. A name safety net catches bonds that Yahoo labels EQUITY: a coupon followed by a bond
word (`1.3% SNR BDS`, `5% NOTES`) or a `dd/mm/yyyy` maturity date in the instrument name (the Crédit Agricole bonds on Paris). A dropped row
is counted as `skippedInstrument` in the `universe_sweep` job result.

**Which listing is the company's.**
1. London international order book lines (symbol `0` plus three letters or digits plus `.L`, for example `0J8P.L` for IDEXX) are never
   canonical. They quote a foreign company in London and usually have no price history.
2. The canonical listing is, in this order (a) on an exchange in the company's home country: `companies.country` (Yahoo `assetProfile`) against
   `exchanges.country`. An exact country match comes before an alias (a company in China may be listed on Hong Kong, A-50), and among
   several home exchanges the priority applies: NSE (`NSI`) before BSE (`BSE`). Among share classes on the same exchange the highest
   30-day USD volume wins (hysteresis 1.5x, A-06).
   (b) When the company has none, its ordinary shares on a main exchange, NYSE or Nasdaq (Accenture, Medtronic, Chubb, Eaton). ADRs are never used: a name marker (ADR, ADS, GDR, American Depositary, Sponsored) or a trading currency that differs from the reporting currency marks one (Novo Nordisk, Nokia, Santander stay out). Known misreads: an ADR that reports in USD without a marker (Equinor, Anheuser-Busch InBev, Arm, argenx, Sea) is kept, and ordinary shares that report in a foreign currency (Spotify) are excluded; fix either with an `exclude` or `force_canonical` override. BDRs (B3 tickers ending 32 to 35, 39), Xetra, Frankfurt and other foreign lines and OTC are never used.
   (c) Otherwise the company is excluded (`no_primary_listing`).
3. There is no fallback to another listing when the chosen one has no prices (owner decision: that scan failure is reported, never hidden
   by switching listings).
4. A company with an unknown country takes the exchange country shared by all its eligible listings that are not ADR-like or foreign
   cross-lines (Alphabet: GOOGL and GOOG on Nasdaq give the United States); the country is then used for the choice only and is not stored. The profile is retried on every scan while the country is unknown.

**Exclusion reasons.** A company with no eligible listing has no canonical security: it is not a candidate, is not counted in the coverage
denominator and is not a failure. Its reason is stored in `companies.exclusion_reason` and summarised by the identity `group` job
(`excluded` counts in the job result and one `companies_excluded` event with up to 50 examples):

| `exclusion_reason` | Meaning |
|---|---|
| `no_primary_listing` | no home listing and no ordinary-share line on NYSE or Nasdaq: the only lines are London IOB lines, ADRs, Xetra or Frankfurt cross-lines, Brazilian BDRs or OTC |
| `country_unknown` | no home country on record and not exactly one primary listing to infer it from |
| `not_a_share` | every listing is a bond, fund, warrant or other non-share instrument |

```sql
-- who is excluded and why
select exclusion_reason, count(*) from companies where exclusion_reason is not null group by 1;
select c.name, c.country, c.exclusion_reason, string_agg(s.yahoo_symbol, ', ' order by s.yahoo_symbol) as listings
  from companies c join securities s on s.company_id = c.id
 where c.exclusion_reason is not null group by c.id order by c.exclusion_reason, c.name;
```

To keep a company that the rule excludes (for example Spotify, whose NYSE shares report in EUR and are read as an ADR), insert
a `force_canonical` row for its listing in `security_identity_overrides` (kind `force_canonical`, `yahoo_symbol`, a reason; section 7 shows
the `override` action of `scan-control`). The override wins over the rule and clears the exclusion at the next scan.

**When a rule change takes effect.** At the next scan, never inside a finished run: a scan is idempotent per Sofia date, `requeue` only
retries dead and failed jobs and `recompute` only re-derives ranks and signals from stored series, and none of them runs the sweep or the
identity step again. After deploying, the next scheduled scan applies the rule to the whole universe. The identity step loads every active
canonical security, so the old London and bond canonicals are replaced (or cleared, when no home listing exists) in that same scan.

## 9. AI research (filled by P2; the report page and cards are shown by P4)

Research reports are generated by software that gathers public documents (SEC EDGAR, company pages, Tavily search, Jina Reader) and asks a free language model only to write text from a numbered list of those documents. The model never browses and never invents a link. The cost is zero: no billing is ever enabled on any account.

### 9.1 Get the keys (all free, no card)

1. **Gemini (required).** Open Google AI Studio (`aistudio.google.com`), sign in, choose "Get API key", create a key in a new or existing project that has **no billing account attached**. The free tier limits are shown only inside AI Studio; write down the daily request limit you see for the Flash-Lite model you choose. Set `GEMINI_MODEL` to that model's id exactly as AI Studio shows it (the project deliberately hard-codes no model id).
2. **Tavily (required for web search).** Sign up at `tavily.com`; the free plan gives 1,000 credits per month and needs no card. One search costs one credit.
3. **Jina Reader (optional).** Works without a key at 20 requests per minute. A free key from `jina.ai` raises the limit and is sent as a bearer token.
4. **SEC User-Agent (required for EDGAR).** The SEC refuses requests without a declared contact. Use the format `Your Name your.email@your-domain.com`, for example `Ioan Avramov ioan@example.com`. The project never sends a request to `sec.gov` without it and stays at or below 4 requests per second.

### 9.2 Set the function secrets

Run once per project (values are examples; never commit them):

```text
bunx supabase secrets set --project-ref <ref> GEMINI_API_KEY=... GEMINI_MODEL=<model id from AI Studio> TAVILY_API_KEY=... SEC_USER_AGENT="Your Name your.email@your-domain.com"
bunx supabase secrets set --project-ref <ref> JINA_API_KEY=...            # optional
```

Optional second provider (the backup) for new reports when Gemini is nearly out of quota or overloaded. It must speak the OpenAI chat-completions protocol with JSON-schema output; the supported, tested choice is Groq's free tier (below). Other OpenAI-compatible providers work through the same four secrets, but mind their limits (OpenRouter `:free` models allow 50 requests a day; Mistral's free API is no longer available, so Mistral is only an option as a paid plan).

`LLM_PRIMARY` is `gemini` (default) or `openai_compatible`. If a key is missing, research does not fail loudly: candidates stay "Research not configured" until you set it.

#### Groq as the backup model (free tier)

Gemini's free tier regularly answers 503 "This model is currently experiencing high demand". With a backup configured, an overloaded step is retried at once on the backup and the report carries on there (see 9.7). Groq's free plan works through the existing OpenAI-compatible adapter with the model `openai/gpt-oss-120b` (it supports `response_format: json_schema` with `strict: true`):

1. Create a free account at `console.groq.com` (no card is needed) and create an API key under "API Keys".
2. Set the four secrets, plus the two optional budget secrets (recommended values below):

```text
bunx supabase secrets set --project-ref <ref> LLM_ALT_PROVIDER=groq LLM_ALT_BASE_URL=https://api.groq.com/openai/v1 LLM_ALT_MODEL=openai/gpt-oss-120b LLM_ALT_API_KEY=<the key>
bunx supabase secrets set --project-ref <ref> LLM_ALT_MAX_INPUT_TOKENS=4500 LLM_ALT_MAX_OUTPUT_TOKENS=3000
```

   `LLM_ALT_PROVIDER` is the id stored on a report (`provider = groq`, `model = openai/gpt-oss-120b`, shown on the card as "GPT-OSS 120B"). `LLM_ALT_REASONING_EFFORT` (`low`, `medium` or `high`) is optional: for any model id that starts with `openai/gpt-oss` the adapter already sends `reasoning_effort: "low"` (Groq's documented field; its default is `medium`), because the model's reasoning tokens share the output budget and the per-minute limit.
3. **Free limits for `openai/gpt-oss-120b`** (Groq's rate-limit page): 30 requests per minute, 1,000 requests per day, **8,000 tokens per minute**, 200,000 tokens per day. Groq rejects a request that alone is larger than the per-minute limit ("Request too large", HTTP 413), which is why the budget below exists.
4. **The trade-off: thinner reports.** The 48,000-character evidence block Gemini reads (about 12,000 tokens) cannot fit in 8,000 tokens per minute. With the budget, the backup gets a trimmed evidence set, roughly a quarter to a third of it, so a report written by the backup is thinner than one written by Gemini. The owner accepted this (2026-10-16). What the budget does, for each LLM step that runs on the backup (stage 1 extraction, stage 2 synthesis, change classification):
   - `LLM_ALT_MAX_OUTPUT_TOKENS=3000` lowers the step's `max_tokens` (4,096 and 6,144 for the reports, 1,024 for change classification, which stays at 1,024) to at most 3,000.
   - `LLM_ALT_MAX_INPUT_TOKENS=4500` caps the whole request (system prompt, JSON schema and user message) at 4,500 tokens. Tokens are estimated at 3.5 characters each (conservative: English prose is about 4), so the request is cut to 15,750 characters. Input plus maximum output is then at most 4,500 + 3,000 = 7,500 tokens, 500 under the 8,000 limit as headroom for the estimate. If only one of the two is set, the input still gets at most 7,500 minus the output. Unset (the default) means no limit, which is right for any provider without a tight limit.
   - Stage 1 reads the start of a long document (about 14,000 of up to 48,000 characters); the report lists such documents under "missing" ("read only in part"). Stage 2 keeps the best-ranked evidence entries that fit (about 10,000 characters instead of 48,000) and lists what it left out ("Evidence items left out to fit the backup model's size limit"). The card then reads "..., the backup model, wrote this report from a shorter evidence set because ..." (`research_reports.evidence_trimmed`).
   - Every request uses about a whole minute of the token limit, so the backup runs about one request a minute: a full report takes roughly ten minutes (each 429 is retried after 90 seconds) and the 200,000 daily tokens allow roughly three to four full reports a day. That is what a free backup is for.
5. A request that is still too large (HTTP 413, or a per-minute error whose requested size exceeds the limit) is retried once with half the input; if that fails too, a document counts as not extracted, a change check ends and is retried at the next scan, and a report fails as `invalid_json` (see 9.7). It never uses a job attempt and never loops. A per-minute 429 that merely means "wait a few seconds" is `rate_limited`: the same step is retried after 90 seconds.
6. **Data note.** Groq's free plan may use submitted prompts to improve its services. Our prompts hold only public company data (names, tickers, public filings and web pages, see 9.6), so this is acceptable here. If you ever want that off, use a paid plan or another backup.
7. Local: put the same values in `supabase/functions/.env` and restart the stack. The local test suites use recorded fixtures and never call Groq.

`LLM_PRIMARY` is case-sensitive and must be exactly `gemini` or `openai_compatible` (lowercase); any other value makes every research tick fail loudly.

### 9.3 Daily caps (`app_settings.research`)

| Key | Default | Meaning |
|---|---|---|
| `max_full_reports_per_day` | `null` (no cap) | full reports per trigger class per UTC day. `null` or a missing key means unlimited; set a number to bring the cap back, and more are then deferred to the next day |
| `tavily_daily_cap` | 60 | Tavily credits per UTC day (6 per report, 1 per change check; visitor scans use the same budget). Was 32 |
| `tavily_reserved_for_reports` | 24 | the part of the daily credits only full reports may use |
| `tavily_monthly_budget` | 950 | credits per UTC month, safely under the free 1,000 |
| `llm_daily_request_cap` | 300 | model calls per UTC day; set it below the limit AI Studio shows you |
| `max_change_checks_per_day` | 40 | material-change checks per UTC day |
| `reuse_days` | 30 | a completed report is reused this long unless a material change is found |
| `min_recheck_hours` | 72 | per security: no AI work within this many hours of its last report or change check (1 to 720; out-of-range values are clamped, a non-number falls back to 72) |
| `ai_weekdays_only` | `true` | no AI work on Saturday and Sunday (Europe/Sofia); `false` allows weekends. A boolean only: anything else falls back to `true` |

There is deliberately no daily cap on full reports. The free-quota guards are the Tavily and `llm_daily_request_cap` rows above: when one is used up, work is deferred to the next UTC day, never billed. To cap reports again: `update app_settings set value = value || '{"max_full_reports_per_day": 4}'::jsonb where key = 'research';` (back to unlimited: set it to `null`).

`scan-control` `set_setting` does not accept the `research` key. Change a cap with SQL in the SQL editor (merge only the keys you change):

```sql
update app_settings set value = value || '{"llm_daily_request_cap": 200}'::jsonb where key = 'research';
```

#### Which companies get researched (universe)

The scan validates in this order: market cap of at least US$50B, at least 10 years on the market, the indicator marks; AI research runs last, on the discount candidates that remain (usually about ten). There is one worldwide ranking. "United States" is only a display filter on the Overview (`?country=us`), for everyone, set by the "Companies from" control and stored nowhere (there is no per-user universe setting and no Profile Preferences page); the ranks stay worldwide. The cards filter the feed in the browser and The Company List asks the database (`public.company_list(p_country)`, matching the same country as the column). Each card and Company List row shows the company's country: Yahoo assetProfile (headquarters country), with the exchange's country when Yahoo gives none (`public.v_todays_discounts.country`, `public.company_list().country`).

The daily scan no longer researches cards: it researches only monitored holdings (and resumes deferred reports), subject to the free-quota guards and the cadence rules below. Discount cards are researched on request through Scan with AI (section 9.4a). Digests carry the worldwide entries; a user narrows them with `notification_preferences.digest_country_filter` (null = all countries, `United States` = US companies only). The pipeline may keep computing `us` rows; nothing user-facing reads them.

Market cap is the last close times the Yahoo shares outstanding of the company's home listing; Yahoo's own market cap field is not used. A company with no share count on a given day is simply not a member that day (no carry-forward). The "Listed in" filter ("All exchanges" / "United States") matches the country of the **exchange** the listing trades on (`exchanges.country`), not the company's home country; flags and identity lines still show the home country.

#### Cadence: 72 hours, no weekends (owner decisions 2026-10-16)

- **One rule for all AI work** (visitor and owner requests, refreshes, first and changed monitoring reports, premium): no AI call for a security within `min_recheck_hours` (72) of its last AI activity, and none on Saturday or Sunday Sofia time. `research_now` is exempt (it is your action). A discount card is researched only when a visitor or you ask for it (Scan with AI, section 9.4a), subject to the 72 hour cooldown; the daily scan no longer seeds research for new discounts.
- **Only monitored holdings keep automatic checks.** A stock you own gets a cheap news check (EDGAR filings, company RSS, Yahoo headlines; a model call only when something new appeared) every 72 hours, never on a weekend. A material finding queues a full `monitor_change` report; otherwise the report is not rewritten. Discount cards get no automatic change checks. A completed report is still reused for `reuse_days`.
- **Work that is due on a weekend waits** until Monday 10:00 Sofia. It is queued as a side-channel job with `not_before` set to that time (payload `late = true`). Such a job does not keep its scan run open, is not killed by the 22:00 deadline sweep, and runs even though no scan runs that morning (the minute tick fires the worker for queued jobs whose `not_before` has passed). A Friday or Saturday scan also queues the checks that fall due over the weekend. The waiting report shows `wait_reason` = `weekend` or `cadence_72h` and `next_attempt_at` on its card; when it finishes, the card updates by itself and no second digest is sent.
- To switch it off: `update app_settings set value = value || '{"ai_weekdays_only": false}'::jsonb where key = 'research';` (weekends) and `'{"min_recheck_hours": 1}'` (the 72 hour rule).

#### Skipped scans (no new close)

The daily start (`app.start_daily_scan`, cron and catch-up) first asks whether any in-scope exchange has completed a trading session newer than the one the last published run processed (`scan_runs.session_dates`). If not, no run is created and no stage is seeded: a `scan_skipped` event (no run id) and the public row `app_settings.last_scan_skip` record it, and `scan_status()` reports it as `last_skipped`. Sunday and Monday morning (the US has not opened) and US market holidays are no-ops; Saturday still processes Friday's close. The Overview keeps showing the last real successful scan, and the health check (`tools/lib/alerts.ts`, used by keep-alive) treats a recent skip as healthy for up to 96 hours after the last success.

`app_settings.scan_cadence` (not public) tunes it: `{"skip_without_new_session": true, "session_scope": "all"}`. `session_scope` is `all` (default: every enabled exchange decides, so Asian Monday closes trigger a Monday scan and Sunday is the weekly no-op) or `us` (only the US exchanges decide). `skip_without_new_session: false` always scans. A manual start (`scan-control start`), a forced start and fixture runs are never skipped. The US full-day holidays are listed in `app.market_holidays` (2026 to 2030, add rows after 2030); another country's holiday only makes a scan run that finds nothing new.

```sql
select at, data from scan_events where event = 'scan_skipped' order by at desc limit 10;
select public.scan_status() -> 'last_skipped';
```

### 9.4 Run research on demand

`scan-control` action `research_now` queues a manual full report for one security in the latest scan:

```text
curl -X POST "https://<ref>.supabase.co/functions/v1/scan-control" -H "x-cron-secret: <CRON_SHARED_SECRET>" -H "content-type: application/json" -d "{\"action\":\"research_now\",\"security_id\":\"<security uuid>\"}"
```

A second request on the same Sofia day returns the existing report. Add `"force":true` to re-run a report that failed. The worker finishes the 13 steps in about 15 to 40 minutes.

### 9.4a Visitor research requests (Scan with AI)

Any visitor can press **Scan with AI** on a listed company. The public Edge Function `research-request` (`POST {"security_id": "<uuid>"}`, no JWT, CORS for the site) runs these checks in order. A refusal answers `{ "ok": false, "reason": <code> }` with the status shown:

| Reason | Status | Meaning |
|---|---|---|
| `invalid_input` | 400 | the security id is missing or not a uuid |
| `not_on_list` | 404 | no row in the latest published list |
| `in_flight` | 409 | a report for this company is queued, running or quota-deferred |
| `cooldown` | 429 | the newest complete report is less than 72 hours old (`next_allowed_at`) |
| `retry_later` | 429 | the newest failed report is less than `visitor_retry_minutes` old (`next_allowed_at`) |
| `network_limit` | 429 | this network (hashed IP) has used its accepted requests for the UTC hour (`next_allowed_at` = end of the hour) |
| `budget_paused` | 429 | no LLM provider configured, today's visitor cap is used, or the Tavily or LLM budget is nearly spent |
| `try_later` | 429 | a counter, settings or database read failed (fails closed) |

Only accepted requests count toward the per-IP and daily limits, whatever their outcome. An accepted request queues one research job for the latest published list, with trigger `visitor`, and answers `{ "ok": true, "report_id", "started_at" }`. It writes one `audit_events` row: action `research_request`, target `security`, details `{ "source": "visitor", "ip_hash", "report_id" }`. A failed report never starts the 72-hour cooldown.

Settings (`app_settings`, key `research`): `visitor_scans_per_hour_per_ip` 3, `visitor_scans_per_day` 8, `visitor_retry_minutes` 60, and `tavily_daily_cap` 60 (section 9.3). Change them in the SQL editor, merging only the keys you change, as in 9.3 (`set_setting` does not accept the `research` key):

```sql
update app_settings set value = value || '{"visitor_scans_per_day": 4}'::jsonb where key = 'research';
```

### 9.5 Read quota usage and report status

```sql
-- counters of today and this month (UTC)
select provider, resource, period_kind, period_start, used, limit_value
  from ai_quota_usage where period_start >= date_trunc('month', now() at time zone 'utc')::date
 order by period_start desc, provider, resource;

-- what is waiting, deferred or failed
select security_id, trigger, status, step, error, not_before, completed_at
  from research_reports where status <> 'complete' order by created_at desc limit 50;
```

Reading the `error` column of a `quota_deferred` report: `llm_quota` (model limit, retried next UTC day), `tavily_quota` (search credits), `provider_unavailable` (every model was overloaded through the four backoff retries, retried at the next scan), `daily_cap` (`max_full_reports_per_day`, only when you set a number), `provider_not_configured` (a key is missing: set it, then use `research_now` with `force`, or wait for the next day's automatic retry). A `failed` report with `citation_verification_failed` or `unknown_evidence_id` means the model produced an answer that could not be verified twice; the candidate is shown as Grey ("research failed"), never as cleared.

### 9.6 Privacy statement

Only public information leaves the system: the company name, ticker, exchange, reporting currency, the research date, public document URLs and the text of public documents. No user id, email, quantity, cost basis, portfolio composition or broker data is ever sent to Gemini, Tavily or Jina, and prompts are identical for a candidate and for a security someone holds. The **free Gemini service uses submitted content to improve Google products**; that is acceptable here only because the content is public. Whether a private individual's public site meets the free tier's "professional or business purposes" wording is an open question (Q-04); the research pages show an AI disclaimer and the model used, and a legal review of the "Meets / Does not meet" wording is recommended (Q-05).

### 9.7 Provider overload, the backup model and the card fields

How a model answer is classified (`classifyHttpFailure`) and what the pipeline does with it:

| Failure kind | Recognised by | What happens |
|---|---|---|
| `unavailable` | HTTP 500, 502, 503, 504, or a body matching `UNAVAILABLE`, `overloaded`, `high demand`, `DEADLINE_EXCEEDED` (never a 429) | the same step is retried at once on the other configured provider, and the report continues there. With no backup, or when the backup is unavailable too: the step is rescheduled with `not_before` after 3, 10, 30 and 60 minutes (four retries per report, `usage.unavailable_retries`, separate from the 429 retries) **without consuming a job attempt**; after that the report is deferred to the next scan day with `error = provider_unavailable` (not failed, not dead) |
| `rate_limited` | HTTP 429 (including Groq's per-minute token limit when the request itself fits) | the same step is retried after 90 seconds, up to three times (`usage.rate_limit_retries`); then the backup takes over (when the primary kept answering 429), else `quota_deferred` with `llm_quota` |
| `quota` | 429 with a daily-quota body (`PerDay`, "daily", billing) | the backup takes over immediately when the primary hit it, else `quota_deferred` with `llm_quota` |
| `invalid_json`, `schema` | the answer is not valid JSON for the schema | synthesis is repeated once with feedback, then the report fails (`invalid_json`); an extraction counts as failed for that document |
| `schema` with `tooLarge` | the request itself is too big for the provider: HTTP 413, "request too large", or a per-minute token error whose requested size is above the limit (Groq free: 8,000 tokens per minute) | the same step is resent once with half the input; if that is refused too, an extraction counts as failed for that document, a change check ends (retried at the next scan) and a report fails as `invalid_json` without a repeat. No job attempt is used and nothing loops |
| `http` (other 4xx), `network` | any other HTTP error, DNS or timeout | the job throws and the worker retries it with backoff (this does use a job attempt) |
| `not_configured` | key or model missing | `quota_deferred` with `provider_not_configured` |

Provenance on the card (all on `research_reports`, exposed by `v_todays_discounts` / `todays_discounts_feed` and `v_card_research`; display names are derived in the web app from the raw ids):

| Column (feed name) | Meaning |
|---|---|
| `provider`, `model` (`research_provider`, `research_model`) | the writer of the report text, for example `gemini` and the Gemini model id, or `groq` / `openai/gpt-oss-120b` after a hand-over. Existing reports keep what was stored |
| `completed_at` (`research_completed_at`) | when the report finished |
| `fallback_reason` | why the backup wrote it: `primary_unavailable` (the step was handed over after an overload), `primary_quota` (the primary was near its daily cap when the report started, or answered "daily quota"), `primary_rate_limited` (the 429 retries were spent). Null when the primary wrote it, and when the primary simply is not configured |
| `evidence_trimmed` | true when the backup model wrote the report from a shorter evidence set (its request budget cut documents or evidence, see the Groq section above); null otherwise. The card then says "... wrote this report from a shorter evidence set because ..." |
| `wait_reason` | while a report waits: `provider_unavailable`, `llm_quota`, `search_quota` (Tavily), `rate_limited`, `weekend`, `cadence_72h`. Null otherwise; cleared when the next step runs or the report completes |
| `last_attempt_at`, `next_attempt_at`, `next_provider` | while waiting: the last try (for `weekend` and `cadence_72h`: the last AI activity of the security), the next try (= the `not_before` of the job that runs it) and the model id it will use |

```sql
select s.yahoo_symbol, r.status, r.provider, r.model, r.fallback_reason, r.wait_reason, r.last_attempt_at, r.next_attempt_at, r.next_provider
  from research_reports r join securities s on s.id = r.security_id
 where r.status <> 'complete' or r.fallback_reason is not null order by r.created_at desc limit 30;
```

## 10. Inspect broker sync status and reconcile analytics (filled in P5b)

### 10.1 Sync runs

```sql
-- last runs of a user (run as postgres in the SQL editor; no token or statement content is stored)
select kind, state, poll_count, error_code, error_message, statement_from, statement_to, created_at, finished_at, rows_summary
  from broker_sync_runs where user_id = '<user id>' order by created_at desc limit 20;

-- connection health (the token columns are never selected)
select status, last_verified_at, last_sync_at, last_statement_date, last_error_code, last_error_message, next_flex_fetch_not_before, coverage_from
  from broker_connections where user_id = '<user id>';
```

States: `queued`, `requested`, `polling`, `parsing`, `done`, `failed`, `expired`. A run stuck in `polling` for more than 10 minutes ends as `failed` with code -4. Internal codes: 0 transport, -1 parse error, -2 key unavailable, -3 account changed, -4 poll limit, -5 send retry limit, -6 missing sections, -7 internal error. IBKR codes 1001 to 1021 are explained on Profile, Broker. `audit_events` records `broker.link`, `broker.test`, `broker.unlink`, `broker.sync_failed`, `broker.token_rekey` (ids and codes only).

### 10.2 Reconcile the Portfolio and Analytics numbers with IBKR (P5-06)

| Figure on the page | Compare with | Tolerance |
|---|---|---|
| Unrealized P&L, broker FIFO (tooltip) | IBKR Activity Statement, Open Positions, FIFO Unrealized P/L, same report date | exact to the cent per position (a mismatch shows "Does not reconcile" on the row) |
| Realized trading P&L | Statement section Realized and Unrealized Performance Summary, Total Realized P/L over the same period | within currency rounding; differences usually mean the history is shorter than the statement period (see the coverage line) |
| Dividends gross, withholding, net | Statement Dividends section | exact per row |
| Cost basis (Analytics) | Open Positions Cost Basis Money, converted with the statement rates | within 0.01 per position |
| NAV | Statement Net Asset Value in Base, same report date | exact |

Commissions are inside the Flex cost basis and realized P/L and are shown only as a memo; other costs are fees and interest from Cash Transactions.

## 11. GitHub secrets and variables (filled)

Settings -> Secrets and variables -> Actions. Four workflows exist: `ci.yml` (no secrets), `deploy-supabase.yml`, `deploy-web.yml`
and `keepalive.yml`.

| Name | Kind | Used by | Notes |
|---|---|---|---|
| `SUPABASE_ACCESS_TOKEN` | secret | deploy-supabase | personal access token |
| `SUPABASE_DB_PASSWORD` | secret | deploy-supabase | project database password |
| `SUPABASE_PROJECT_REF` | variable | deploy-supabase | 20-letter project id |
| `CLOUDFLARE_API_TOKEN` | secret | deploy-web | scoped to Workers edit |
| `CLOUDFLARE_ACCOUNT_ID` | secret | deploy-web | |
| `VITE_SUPABASE_URL` | variable | deploy-web | `https://<ref>.supabase.co`; also the only non-self origin in the CSP |
| `VITE_SUPABASE_ANON_KEY` | variable | deploy-web | publishable (anon) key, public by design |
| `VITE_SITE_URL` | variable | deploy-web | public site URL, https |
| `VITE_VAPID_PUBLIC_KEY` | variable | deploy-web | public Web Push key (section 4.1); see the note below |
| `KEEPALIVE_SUPABASE_URL` | variable | keepalive | same as `VITE_SUPABASE_URL` |
| `KEEPALIVE_ANON_KEY` | variable | keepalive | same as `VITE_SUPABASE_ANON_KEY` |
| `KEEPALIVE_EMAIL` | secret | keepalive | dedicated low-privilege confirmed user |
| `KEEPALIVE_PASSWORD` | secret | keepalive | |
| `KEEPALIVE_ENABLED` | variable | keepalive | `true` once the migrations are deployed |
| `KEEPALIVE_MAX_AGE_HOURS` | variable | keepalive | optional, default 36; `0` forces a failure for the drill |

`deploy-web.yml` passes `VITE_VAPID_PUBLIC_KEY` to the build next to the three other `VITE_*` values. The code reads it
(Profile, notifications and the service worker); set the variable before the first deployment, otherwise the site cannot subscribe to push.

Environment `production` (Settings -> Environments): add yourself as required reviewer. The "Migrations" job of deploy-supabase waits for
that approval before touching the database (the Vault secrets of `config.toml` are skipped with `--skip-vault`). Never put the
service-role key, `CRON_SHARED_SECRET` or any `*_API_KEY` into a `VITE_*` variable.

## 12. Keep-alive and pause handling (filled)

A Supabase Free project pauses after a week without enough user database activity (spec 16.4). `keepalive.yml` runs daily at 06:17 UTC
(only when `KEEPALIVE_ENABLED` is `true`) and executes `tools/keepalive.ts`: it signs in as the dedicated user, reads one row of
`app_settings` through REST, reads the public `scan_status` and the `health` function, and fails the job (GitHub emails you) when: the
sign-in or the read fails, the last successful scan or the latest published result is older than 36 hours, the latest published run
processed under 90% of its candidates, or `health` reports `ok: false`. Conditions that the job cannot see yet (`health` exposes no
database size, breaker state, research backlog or delivery counts) are manual checks: run the queries of sections 8, 9.5, 4.6 and 13.3
weekly. Run it by hand with the variables of the workflow: `bun run keepalive`.

Create the user: Dashboard -> Authentication -> Users -> Add user (email and password, auto-confirm). Store the credentials as the two
keep-alive secrets. After the migrations are deployed (a policy lets `authenticated` read `app_settings`), set `KEEPALIVE_ENABLED=true`
and run the workflow once manually.

Residual risks: it is unverified whether this counts as "user activity", so still open the site or the dashboard at least weekly and watch
for Supabase's warning email. GitHub may disable scheduled workflows in a repository without activity (not verified; check Actions ->
Keep-alive; any push re-enables). A paused project: Dashboard -> project -> Resume (restorable for one year).

### 12.1 Notification data retention (180 days)

`digests`, `digest_items` and `digest_deliveries` are kept for **180 days** (the unused `email_events` table is purged on the same schedule); revoked push
subscriptions for 30 days (spec 6.4). The cron job `retention-notifications` (01:40 UTC) calls
`app.purge_notifications()`, which deletes in batches of 5,000. A digest that still references an active
episode or an open risk finding (`resolved_at is null`) is kept past 180 days so that "already notified"
dedupe never breaks.

```sql
select j.jobname, d.status, d.start_time from cron.job_run_details d join cron.job j using (jobid)
 where j.jobname = 'retention-notifications' order by d.start_time desc limit 5;
select count(*) from digests where created_at < now() - interval '180 days';
```

The second query should stay small (only digests that still reference active episodes or findings).


## 13. Backups, rotations, retention and incident runbooks (filled)

### 13.1 Backups (the Free plan has none)

Reconstructable without a backup: `price_series`, the universe and the results (re-run the sweep), broker records (Flex backfill of
about four calendar years). Not reconstructable: signal episodes and digests (dedupe state), research report history, risk findings,
audit events, users, preferences, push subscriptions and encrypted Flex tokens (users re-register and re-link).

Once a month, from the repository root with Docker running:

```powershell
$env:SUPABASE_DB_PASSWORD = "<database password>"
New-Item -ItemType Directory -Force backups | Out-Null
bunx supabase db dump --linked --data-only --use-copy -f "backups/$(Get-Date -Format yyyy-MM-dd)-data.sql" -x "public.price_series,public.market_cap_snapshots,public.universe_snapshots,public.scan_security_results,public.quote_cache,public.scan_events,public.scan_jobs"
```

The dump contains personal data and encrypted tokens: keep it offline (an encrypted disk or a password manager attachment), never in
the repository (`backups/` is git-ignored) and never in a CI artifact. Restore into a fresh
project: `bunx supabase db push`, then `psql "<connection string>" -f backups/<file>.sql`; per-user rows need their `auth.users`
entries, so after a rebuild users sign up again and the non-per-user tables (episodes, reports, audit) are the value of the dump. A
paused project can be restored from the dashboard within one year. Test the restore into the local stack once (`bunx supabase db reset`,
then the `psql` command against `postgresql://postgres:postgres@127.0.0.1:54322/postgres`) before relying on it.

### 13.2 Secrets and variables inventory, and rotation

| Name | Where it lives | Rotate | If it leaks |
|---|---|---|---|
| `SUPABASE_SERVICE_ROLE_KEY` | platform (functions only) | regenerate in the dashboard, redeploy functions | full database access: rotate at once, read `audit_events` |
| `CRON_SHARED_SECRET` and Vault `worker_tick_secret` | function secret and Vault, same value | yearly or on suspicion; change both together | forged calls only run scheduled work and the `scan-control` admin actions |
| Vault `project_url` | Vault | when the project changes | none (a URL) |
| `RATE_LIMIT_SALT` | function secret | yearly; changing it resets all rate-limit buckets | counters become guessable (low impact) |
| `FLEX_ENC_KEY_V<n>`, `FLEX_ENC_KEY_CURRENT` | function secret | add a version, `rekey`, retire the old one (section 5.3) | with database access the stored tokens decrypt: rotate and have users re-issue tokens |
| `FLEX_USER_AGENT`, `SEC_USER_AGENT`, `SITE_URL` | function secret | when the contact or domain changes | none (identification only) |
| `VAPID_PRIVATE_KEY`, `VAPID_PUBLIC_KEY`, `VAPID_SUBJECT` | function secret (public key also `VITE_VAPID_PUBLIC_KEY`) | only on compromise: every subscription is invalidated | an attacker can push to existing subscriptions |
| `GEMINI_API_KEY`, `GEMINI_MODEL`, `TAVILY_API_KEY`, `JINA_API_KEY`, `LLM_ALT_API_KEY` | function secret | in the provider console | quota theft (free tiers, no billing) |
| `SUPABASE_ACCESS_TOKEN`, `SUPABASE_DB_PASSWORD`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` | GitHub secrets | yearly; Cloudflare token scoped to Workers edit | deployment takeover |
| `KEEPALIVE_EMAIL`, `KEEPALIVE_PASSWORD` | GitHub secrets | yearly | the account is a plain user without data |
| `VITE_*` and `KEEPALIVE_SUPABASE_URL`, `KEEPALIVE_ANON_KEY`, `KEEPALIVE_ENABLED`, `KEEPALIVE_MAX_AGE_HOURS`, `SUPABASE_PROJECT_REF` | GitHub variables | when the project changes | public by design |
| Database password | password manager, `SUPABASE_DB_PASSWORD` | yearly (dashboard, Database settings), update the GitHub secret | full database access |
| User Flex tokens | IBKR | the user, in Client Portal (6 hours to 1 year) | read access to account activity: disable the token at IBKR |

Put a yearly calendar reminder for the rotations. After any rotation run `bun run check:secrets` and
`bunx supabase secrets list --project-ref <ref>` and compare names.

### 13.3 Retention and size

Cron: `retention-notifications` (01:40 UTC) deletes expired notification data (180 days, section 12.1) in batches of 5,000 and
`purge-cron-history` (01:45 UTC) deletes `cron.job_run_details` older than 7 days. The `retention-cleanup` function (scan events and
terminal scan jobs after 30 days, expired `quote_cache` rows, membership events after 90 days; it writes a `cleanup_result` event with
per-table counts) runs automatically every day at 01:30 UTC from the cron job `retention-cleanup`. To run it by hand as well (for example when the
database is above 300 MB):

```powershell
$h = @{ "x-cron-secret" = $env:CRON_SHARED_SECRET }
Invoke-RestMethod -Method Post -Uri "https://<ref>.supabase.co/functions/v1/retention-cleanup" -Headers $h
```

Retention never deletes active episodes, open findings, referenced digest items, research reports, audit events or broker records.
Check the size monthly (and weekly while the first months of scans accumulate):

```sql
select pg_size_pretty(pg_database_size(current_database()));
select relname, pg_size_pretty(pg_total_relation_size(relid)) from pg_catalog.pg_statio_user_tables order by pg_total_relation_size(relid) desc limit 10;
```

The alert threshold is 400 MB of the 500 MB Free limit. The expected size is 250 to 370 MB (spec 6.11, an estimate that the first live scan
verifies, 0.4).

### 13.4 Incident runbooks

| Incident | First actions |
|---|---|
| The scan did not run | `select * from cron.job_run_details order by start_time desc limit 10;` Is the project paused (dashboard)? Resume it. Do the Vault secrets exist (section 2.5)? Then `scan-control start` (section 7) and read `scan_events` (section 8). |
| Yahoo blocks requests or the schema drifts | Look for `yahoo_breaker_open` and `yahoo_schema_drift` events; freeze with the kill switch (section 1.2); fix the Yahoo adapter or switch provider (section 1.3). |
| Research is stuck or deferred | Check quotas and `research_reports.status` (section 9.5); `requeue` dead jobs; raise caps only within the free limits. |
| Push failures spike | Count 404/410 answers in `digest_deliveries`; verify the VAPID keys were not rotated; the user switches push off and on again. |
| Flex errors | Map the code with section 5 and 10.1 and spec 12.4: 1012 token expired (user re-links), 1018 rate limit (wait). |
| Suspected secret leak | Rotate it with the table in 13.2, redeploy, read `audit_events` and `scan_events` for the window, rotate dependent secrets (a leaked service-role key means everything). |
| A migration broke something | Migrations are forward-only: write a corrective migration; for a destructive change dump first (13.1). Functions: `git revert` and redeploy. |
| The site is wrong after a deploy | Run the "Deploy web" workflow manually and choose the previous commit or tag in "Use workflow from"; Cloudflare keeps earlier deployments. |
| Database near the limit | Run `retention-cleanup` (13.3), then the size queries; check the largest tables; the fallback in spec 6.11 is per-year chunks of `price_series`. |
| Account deletion request | `select id, email from auth.users where email = '<address>';` then `delete from auth.users where id = '<id>';` (cascades profile, preferences, subscriptions, broker rows); there is no self-service export or deletion yet (Q-09). |

<!-- P7 T3: known transient behaviours -->
#### Known transient behaviours

- `worker-tick` may answer `502` when you call it by hand with `wait: true` and the work runs longer than the platform gateway allows (a very long synchronous run). The run itself continues and finishes; read the result from `jobs` and `scan_events` instead of retrying the call.
- Cron-driven calls never use `wait`: they hand the work over and return at once, so this timeout cannot affect the scheduled scan.
<!-- /P7 T3 -->

### 13.5 Rollback summary

Web: redeploy the previous commit. Functions: revert and redeploy; they tolerate the old and the new schema for one release (expand
and contract). Database: corrective migration. Scan data: `recompute`. Settings: set the previous value through `set_setting` (audited)
or the previous JSON through SQL (research and EUR settings). Secrets: section 13.2.

### 13.6 Public sign-up

Public sign-up must stay OFF on the hosted project (Authentication, Sign In / Providers, "Allow new users to sign up"). Accounts are
created only through the invite list (section 3.1). If it was ever switched on, check Authentication, Users for accounts you do not know.

## 14. IBKR hand-off and EUR equivalents (P6)

**What it is.** The `Trade on IBKR` dialog (Overview card for linked users, Portfolio rows) prepares text for IBKR's iBot and tells you what to check on the ticket. **The app never places, changes or cancels an order**; you paste the prompt into iBot (Client Portal, TWS or the mobile app) or build the order yourself, check the ticket, and submit it in IBKR.

**IBIS2 caveat.** `IBIS2` is your own practice for Xetra. It is **not in IBKR's public exchange catalogue** and no IBKR source defines it (third parties disagree), so the dialog labels it `Xetra (IBIS2 — owner practice, not in IBKR's public catalogue)`. If iBot rejects or ignores it, open Profile -> Broker, set **Default destination** to `IBIS` (Xetra, verified in IBKR's catalogue and fee page) and generate the prompt again. Whether iBot parses `set destination ...` inside the sentence is unverified (Q-08): the dialog also shows a documented-style variant (`Buy 10 shares of MSF at 400 limit` plus a note to set the destination on the ticket). Always check conid, EUR currency, destination, quantity and price on the ticket.

**Where the EUR line comes from.** Once a week the `eur_catalogue` stage imports IBKR's public IBIS and AEB product lists (`POST /webrest/search/products-by-exchangeId`, about 35 requests 300 ms apart) into `ibkr_catalogue`. Permission to call these undocumented endpoints programmatically is **unverified** (Q-10: IBKR's website terms were not found; `robots.txt` does not disallow them). The import is weekly, tiny, never runs for a user request, abandons itself for the day after three retries, and records one attempt per day. To stop it (the kill switch):

```sql
update app_settings set value = jsonb_set(value, '{enabled}', 'false'::jsonb) where key = 'eur_catalogue';
```
(`scan-control set_setting` does not accept this key). Existing rows stay; new securities then resolve to `none` and the dialog offers the manual local-symbol path. Check the last import:

```sql
select value from app_settings where key = 'eur_catalogue_state';   -- last_result complete | aborted | error, last_success_week, abort details
select exchange_id, count(*) from ibkr_catalogue group by 1;        -- research counts: 1,267 IBIS stocks; AEB lists 1,064 products of all types, fewer of them EUR stocks
select at, level, event, data from scan_events where event like 'eur_%' order by at desc limit 20;
```

**What `verified`, `unverified` and `none` mean.** `verified`: the catalogue ISIN was confirmed through Yahoo (its primary listing is the screening symbol), the Yahoo line `<local symbol>.DE` (IBIS) or `.AS` (AEB) is an EUR equity with the same company name, the same share count when both exist, and a price within 1% after FX. `unverified`: a candidate exists but a check could not run or the price is outside 1% (the dialog lists the failed checks and needs your acknowledgement). `none`: no candidate, or every candidate was a different instrument (look-alikes such as the `MSFT.AS` tracker). Read why:

```sql
select s.yahoo_symbol, e.ibkr_exchange_id, e.ibkr_local_symbol, e.status, e.verified_at, e.verification
  from eur_equivalents e join securities s on s.id = e.security_id order by e.updated_at desc limit 20;
```
Resolution is cached 30 days and redone earlier for a doubtful row when the catalogue was imported after it. A security is resolved when it is a card, a held company's canonical security, or on the watch list:

```sql
update app_settings set value = jsonb_set(value, '{extra_symbols}', '["MSFT","SAP.DE"]'::jsonb) where key = 'eur_catalogue';
```
`require_shares` (default `false`) makes a missing `sharesOutstanding` block verification when set to `true`.

**Overrides.** When the automatic result is wrong, record your own decision (audited in `audit_events`; the next scan applies it; a change also triggers a new resolution):

```sql
-- use this line as verified (you checked it on the IBKR ticket)
insert into eur_equivalent_overrides (security_id, ibkr_exchange_id, action, ibkr_conid, ibkr_local_symbol, eur_symbol_yahoo, isin, reason)
select id, 'IBIS', 'force', 12178239, 'MSF', 'MSF.DE', 'US5949181045', 'checked conid and EUR currency on the IBKR ticket 2026-10-15'
  from securities where yahoo_symbol = 'MSFT';
-- never offer an EUR line on this exchange for this security
insert into eur_equivalent_overrides (security_id, ibkr_exchange_id, action, reason)
select id, 'AEB', 'block', 'AEB line is a different instrument' from securities where yahoo_symbol = 'MSFT';
-- undo
update eur_equivalent_overrides set active = false where id = '<override id>';
```
A reason of at least 10 characters is required; only one active override per security and exchange exists.

**If a stock should have an EUR line and shows `No verified EUR equivalent`.** (1) Is the import current (`eur_catalogue_state`)? (2) Is the company in the catalogue (`select * from ibkr_catalogue where description ilike 'name%' or symbol = 'TICKER'`)? (3) Read the `verification` of the row (above): a failed `price_within_tolerance` often disappears when the US market is open; a failed `isin_confirmed` means Yahoo's primary listing is another symbol. (4) Use an override, or the dialog's manual local-symbol path (it is marked `Unverified symbol`).

**Local proof.** `bun run test:integration` replays the weekly import and the resolution with fixtures only (MSFT resolves to `MSF` on IBIS, `verified`, ISIN stored; the AEB look-alike with the same ticker is rejected; a second scan of the same ISO week makes no catalogue request). `bun run test:e2e:local` drives the dialog in a browser against the local stack: owner's prompt text, ticket checklist, copy button, decimal-comma refusal, and no write request.

**Owner tests (P6-01, P6-02), not automated.** P6-01: in real iBot, paste the generated prompt for at least five instruments (Xetra and Amsterdam, including Unilever `UNA`), including `set destination IBIS2`, and write down what the ticket shows; also test whether `https://portal.interactivebrokers.com/portal/?action=QUOTE&conid=<conid>` opens the instrument after login (Q-08; if yes, a feature-flagged link can be added). P6-02: ask IBKR support, or find the website terms, about programmatic use of `/webrest/*` (Q-10).

## 15. Production cut-over and drills (filled)

Run in order; tick each line when done (the Go-live checklist at the top gives times).

1. [ ] Section 2: project, `supabase link`, `db push`, function secrets, Vault secrets, `functions deploy`; `bunx supabase secrets list` shows every name of 13.2 that applies and none of the local-only names.
2. [ ] Sections 3 to 5: invite-only access (sign-ups off, your e-mail invited), VAPID, IBKR Flex link for the owner.
3. [ ] Section 11: GitHub secrets and variables; `production` environment with yourself as reviewer; run "Deploy Supabase" once (the migrations job waits for approval) and "Deploy web" once.
4. [ ] Section 6: custom domain, HSTS in Cloudflare, `curl.exe -sI https://<your domain>` shows the CSP and HSTS headers.
5. [ ] Section 7: first live scan; section 8: coverage 95% or more; the Overview shows cards or the honest empty state.
6. [ ] Set `KEEPALIVE_ENABLED=true`, run "Keep-alive" manually: green.

Drills (record the date and result of each in `docs/discovery/p7-results.md`, table "Hosted drills"; create the file at the first drill):

| Drill | Steps | Pass when |
|---|---|---|
| Keep-alive failure | set the repository variable `KEEPALIVE_MAX_AGE_HOURS` to `0`, run "Keep-alive" manually, then delete the variable | the run is red, GitHub emails you, the log names the scan age; the next run without the variable is green |
| Kill switch | section 1.2 with `yahoo_enabled` false, open the site, set it back | the site shows the last data with the stale banner; no `yahoo_*` request events during the freeze; scans resume after the switch is back |
| Backup restore | section 13.1 dump, restore into the local stack | row counts of `signal_episodes` and `research_reports` match |
| Secrets comparison | `bunx supabase secrets list --project-ref <ref>` against `bun run check:secrets` and 13.2 | no unexpected name, no missing name |
| Unattended day | leave the project alone for one full day including 10:00 Europe/Sofia | one `complete` scan for the date, digests delivered to the owner's enabled channels, keep-alive green |
| TradingView parity | the procedure of spec 17.6 for three symbols | levels within tolerance or explained as a data difference |

## 16. Costs and free-tier limits

Everything runs on free tiers; no card is attached to any account and no billing is ever enabled (spec D6). The limits that matter:

| Service | Free limit | What happens when exceeded |
|---|---|---|
| Supabase Free | 500 MB database, 5 GB egress per month, 500,000 Edge invocations per month, 150 s wall clock and 2 s CPU per invocation, 1 day of logs, 2 built-in auth e-mails per hour | database full: writes fail and the scan stops publishing (the site keeps showing the last data); free quotas exceeded: the project can be restricted until the period resets or you upgrade; inactivity of about a week pauses the project (keep-alive, section 12) |
| Cloudflare Workers Static Assets | static asset requests free and unlimited, 20,000 files per version, 25 MiB per file | not reachable at this site's size |
| Gemini (AI Studio free tier) | limits shown only inside AI Studio (Flash-Lite about 500 requests per day is unverified); content may be used by Google to improve products | the app caps itself (`llm_daily_request_cap`, default 300); reports end `quota_deferred` and retry next UTC day; an optional second provider takes over for new reports (9.2) |
| Tavily | 1,000 credits per month, one per basic search | the app budgets 950 per month and 32 per day; reports defer |
| Jina Reader | 20 requests per minute without a key, 500 with a free key | the fetcher is sequential and slows down; at most 8 documents per report |
| SEC EDGAR | 10 requests per second, contact User-Agent mandatory | the app stays at or below 4 per second |
| Yahoo Finance (unofficial) | no published limit; about 4 to 5 requests per second were sustained in the spike | the app throttles to 3.3 per second with a circuit breaker; if blocked use the kill switch (1.2) |
| Frankfurter | no key, abuse limit only | falls back to Yahoo FX |
| IBKR Flex Web Service | 1 request per second and 10 per minute per token, token validity 6 hours to 1 year | the app limits itself per token; an expired token shows an error and the user re-links |
| GitHub Actions | free minutes of the plan (private repositories: 2,000 per month) | the four workflows use a few minutes per day |

## 17. Decisions and limitations

- **Market data (Yahoo).** The unofficial library breaches Yahoo's terms for automated collection and commercial reuse. The owner
  accepted the risk and chose zero cost (spec 15.5, Q-03). Prices are delayed and for information only; the kill switch (1.2) and the provider interface
  are the exit.
- **IBKR is read-only.** The Flex Web Service reports positions and activity as of the last statement (T+1); the app has no trading
  permission, never places, changes or cancels an order, and never asks for an IBKR password. "Trade on IBKR" only prepares text for
  iBot and a checklist; you submit in IBKR (section 14).
- **IBIS2 is unverified.** It is the owner's own destination practice for Xetra, not in IBKR's public exchange catalogue. If iBot rejects
  it, set the default destination to `IBIS` in Profile, Broker (section 14, Q-08).
- **EUR catalogue import.** It calls undocumented IBKR web endpoints once a week; permission is unverified (Q-10); the switch is in section 14.
- **AI research is not financial advice.** Free-tier models write text from numbered retrieved documents; quotes are verified against the
  documents. "Meets the checks" is not a recommendation; Red and Grey are never shown as cleared. A legal review of the wording is open (Q-05).
- **Free Gemini tier data use.** Google may use submitted content to improve its products and its terms say "professional or business
  purposes"; only public data is submitted, never user or portfolio data (9.6, Q-04).
- **No backups on the Free plan.** Monthly dump by hand (13.1); `retention-cleanup` runs daily from cron (13.3).
- **No staging environment.** The local stack and the production-build tests are the substitute (Q-07).
- **Privacy.** Not end-to-end encrypted: functions with the service role and the database administrator can read stored data; row level
  security isolates users; Flex tokens are encrypted with a key that exists only as a function secret. Removing an account is manual, in the Dashboard (3.1).
- **Unverified items left to you.** The live Yahoo scan (0.4), hosted CPU timing of the heavy stages, the real-account Flex checks (5.4),
  the iBot behaviour (14), whether the keep-alive counts as user activity (12), and the hosted drills (15).
