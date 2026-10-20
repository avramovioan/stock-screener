# P5b Broker (IBKR Flex), Portfolio, Analytics, Portfolio Refresh and Risk Hookup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking. Tasks 6, 7 and 8 additionally require the `frontend-design` and `ui-ux-pro-max:ui-ux-pro-max` skills (load them before writing any component markup or CSS); Task 8's chart also follows the `dataviz` skill.

**Goal:** Deliver spec section 12 end to end: a read-only IBKR Flex Web Service integration (link, test, sync, unlink; encrypted token; asynchronous `SendRequest`/`GetStatement` state machine; tolerant XML parser pinned by a fixture), the broker tables with owner-only RLS and hidden secret columns, daily Flex syncs at 08:00 Europe/Sofia, matching of Flex positions to Yahoo securities, the `portfolio_scan` pipeline stage (holding tags and premium episodes), the `risk_monitor_state` hookup for P2, the `portfolio-refresh` Edge Function with a server-enforced 60 s manual cooldown, the Profile -> Broker page, the Portfolio page, the Analytics page, `core/accounting.ts` (spec 4.9), integration tests and the operator guide sections for Flex. Order placement is out of scope by owner decision: trade history shows Flex executions only.

**Architecture:** Pure arithmetic lives in `_shared/core` (`accounting.ts`, `flex-errors.ts`, `statement-day.ts`, `portfolio-view.ts`) and is shared by the Edge Functions and the SPA through the `@core` alias. Adapters (`crypto.ts`, `flex.ts`, `flex-parse.ts`, `user-auth.ts`) take injected `fetchImpl`/env so Deno tests never touch the network. `broker-sync` is one function with two modes selected by header: user mode (JWT verified in code with `getClaims()`; actions `link`, `test`, `sync`, `unlink`) and worker mode (`x-cron-secret`; actions `tick`, `rekey`, `ingest_fixture`). A run advances through `advanceRun(deps, run)` one transition at a time, so the same code serves the inline bounded wait of a user action and the minute tick. All statement rows are written by one SQL function (`app.broker_ingest_statement`) in a single transaction, so a failed parse or write leaves the previous data intact. `portfolio-refresh` re-values the latest statement snapshot with delayed Yahoo quotes from the P4 quote cache and never calls Flex; the SPA polls it every 5 minutes while visible and enforces the same 60 s cooldown the database enforces atomically (`app.claim_manual_refresh`).

**Tech Stack:** Bun 1.3.14 and Node 22.13.1 (Windows 11), Deno 2.9.6 (`deno test`), TypeScript 6.0.3, Biome 2.5.15, `npm:fast-xml-parser@5.11.2` (A-37; pinned by a direct specifier because the per-function import maps must stay identical, `tools/check-functions-config.ts`), `@supabase/supabase-js` 2.117.3, React 19.3.1, TanStack Router 1.170.44 and Query 5.104.2, `lightweight-charts` 5.2.1 (from P4), zod 4.6.7, shadcn/ui and Tailwind 4.3.3 (P0), Vitest 5.0.4 (projects `core` and `web`, happy-dom), Supabase CLI 2.121.0 (local stack, pgTAP).

**Spec:** `docs/superpowers/specs/2026-10-15-stock-screener-design.md` sections 12 (all), 4.9, 6.3 (broker tables), 6.7, 6.8, 6.9, 7.1, 7.4 stage 8, 7.11, 8.5, 8.6, 9.7, 14.1-14.3, 14.9, 15.6, 17, 18 P5, 19 (A-14, A-33, A-36, A-37). Brief `prompt.txt` lines 1057-1099 (Broker), 1100-1198 (Portfolio; orders out of scope), 1314-1380 (Analytics), 1476-1518 (pages). Research `docs/discovery/research/ibkr-flex-links-ibot.md` sections 1, 2, 7 and `ibkr-feasibility.md` section 4.

---

## What this plan builds on (earlier phases, read from the repository and the sibling plans)

- **P0 (committed):** `apps/web` shell (`AppShell`, `AppProviders`, shadcn `badge button card dialog input label skeleton sonner switch table tabs tooltip`), `supabase/functions/deno.json` (import map `@core/`, `@adapters/`, `@supabase/supabase-js`, `@std/assert`), `_shared/adapters/{env,http}.ts` (`requireEnv`, `json`, `corsHeaders`, `requireCronSecret`, `readJson`), `tools/new-function.ts`, `tools/check-functions-config.ts` (every function needs a `[functions.<name>] verify_jwt = false` block and the canonical per-function `deno.json`), Vitest projects `core` (`supabase/functions/_shared/core/**/*.test.ts`), `tools`, `web`, `docs/operator-guide.md` (section 5 "Set up and verify IBKR Flex (pending P5)" and section 10 "Inspect broker sync status and reconcile analytics (pending P5)" are empty headings).
- **P1 (plan `2026-10-15-p1-engine-pipeline.md`):** core `units.ts` (`resolveCurrency`, `toMajor`), `calendar.ts` (`localParts`, `isoDate`, `dayNumber(y, m, d)`, `localDayNumber`, `freshnessOf`), `indicator.ts` (`computeChannel`, `Channel`), `thresholds.ts` (`classifyHolding`, `HoldingTag`), `episodes.ts` (`stepPremium`, `Observation`, `EpisodeAction`); tables `securities`, `companies`, `exchanges`, `price_series`, `scan_security_results`, `signal_episodes`, `scan_jobs`, `quote_cache (key, payload, provider, fetched_at, expires_at, hit_count)`; `app.kick_workers`, `app.next_stage_to_seed`, `public.is_admin()`; adapters `db.ts` (`Db` with `sb`, `createServiceClient()`), `log.ts` (`redact`, key pattern `/token|secret|key|email|authorization/i`, so event fields must not be named `key`), `providers.ts` (`MarketDataProvider.search/quote`), `yahoo.ts` (`createYahooProvider`); `worker-tick` types (`HandlerContext`, `Seeder`, `SeedPlan`, `DeferError`), `stages.ts` (`PIPELINE_ORDER`, `HANDLERS`, `SEEDERS`), `handlers/fetch_bars.ts` (`handleFetchBars`, payload `{ securityIds }`), `lib/data.ts` (`fetchByIds`, `upsertChunks`, `dayOfDate`, `loadExchanges`). P1 states "`portfolio_scan` is not part of the P1 pipeline"; this plan adds it.
- **P2 (plan `2026-10-15-p2-ai-research.md`):** migration `20261015002000_research_schema.sql` creating `risk_monitor_state (user_id, security_id, reasons, first_monitored_at, last_check_at, last_report_id, last_category, last_seen_items, next_due_at, status 'active'|'paused', PK (user_id, security_id))` and `app.holder(uuid)` ("P5 replaces the body with a `broker_positions` lookup"). P2 only maintains `risk_monitor_state` rows from the `portfolio_scan:risk_set` job: this plan implements that job.
- **P4 (plan `2026-10-15-p4-public-ui.md`):** `apps/web/src/lib/format.ts` (`formatMoney`, `formatSofia`, `formatSessionDate`, `formatPct`), `components/status/valuation-tag.tsx` (`ValuationTag({ kind })`, kinds `discounted | premium | extra_premium | unavailable`), `components/status/freshness-tag.tsx`, `components/data-state/data-state.tsx` (`Loading`, `ErrorState`, `EmptyState`), `components/popover.tsx` (`Popover`), `lib/supabase.ts`, the `quotes` function and its `quote_cache` rows `quote:<symbol>` (TTL 5 minutes, payload fields `symbol, currency, regularMarketPrice, regularMarketTime, regularMarketChangePercent, marketState, fetchedAt`), `lightweight-charts` 5.2.1.
- **P5a (plan `2026-10-15-p5a-auth-profile.md`):** `useAuth`, `AuthGate`, `requireAuth` guards on `/portfolio`, `/analytics`, `/profile/*`; `ProfileLayout`; `features/profile/panels/broker-panel.tsx` placeholder ("P5b replaces the body of this file only"); `features/profile/broker-page.tsx`; `public.record_audit` (accepts `auth.*` events only, so broker audit events are written by `broker-sync` with the service role); migration `20261015003000_auth_profiles.sql`.

If a name above differs in the repository when a step runs, the step says which single line to adapt. Do not restructure earlier phases.

## Conventions used in every task

- **Core tests (Vitest):** `bun run test:core <filter>` (root script `vitest run --project core`). **Web tests:** `bun run test:web <filter>`. **Deno tests:** `deno test -A --config supabase/functions/deno.json <path>`; whole suite `bun run functions:test`; type check `bun run functions:check`. **pgTAP:** `bun run test:db` (`supabase test db`; needs `bun run supabase:start`). **Types and lint:** `bun run typecheck`, `bun run lint`, `bun run lint:fix`.
- Every relative import inside `supabase/functions/**` keeps its `.ts` extension; function code imports through the import map (`@adapters/...`, `@core/...`). `core` files import only other core files and use no I/O, `Date.now()`, `Math.random()`, `Deno` or DOM globals.
- Biome: 2 spaces, width 100, double quotes, semicolons, `useImportType`, no `any`; TypeScript strict with `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess`. File names are kebab-case (Deno handler files follow P1 and use underscores: `portfolio_scan.ts`).
- Commit after every task with a Conventional Commit message. Never skip hooks, never commit `.env`, `supabase/functions/.env` or tokens.
- Windows: all commands run in PowerShell or Git Bash; no bash-only syntax in `package.json` scripts.
- **Never log or return the Flex token.** It is hashed (SHA-256) for limiter keys, decrypted only inside `broker-sync` for the duration of one Flex call, and Flex request URLs (which carry `t={token}`) are never logged.

## Global Constraints (exact values; every task must respect them)

- **Flex only, read-only, no order placement.** No IBKR username or password is ever requested or stored. Endpoints: `GET https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService/SendRequest?t={token}&q={queryId}&v=3[&p={days<=365} | &fd={yyyyMMdd}&td={yyyyMMdd}]` and `.../GetStatement?t={token}&q={referenceCode}&v=3`. `v` is always `3`. `p` and `fd`/`td` are never combined. The `<url>` in a `SendRequest` response is **ignored**.
- **`User-Agent` header is mandatory** on every Flex request: `User-Agent: ${FLEX_USER_AGENT}` (function secret; local default in `.env.example`: `PersonalStockScreener/1.0`).
- **Rate limits per token:** 1 request per second and 10 per minute (error 1018). The app enforces 1.1 s spacing and 10 calls per rolling 60 s through `app.flex_rl_take(key)` over `quote_cache` rows keyed `flexrl:<first 32 hex of SHA-256(token)>`; the token itself is never a key.
- **Token encryption:** AES-GCM-256 via Web Crypto, 12-byte random IV, additional authenticated data `userId:connectionId:keyVersion`, key `FLEX_ENC_KEY_V<n>` (base64 of exactly 32 bytes) in function secrets, `key_version` stored next to the ciphertext, `FLEX_ENC_KEY_CURRENT` selects the key for new ciphertext (default `1`). The token is never returned to a client; `flex_token_ciphertext`, `flex_token_iv` and `key_version` are not selectable by `anon` or `authenticated` (not even by the owner). A ciphertext that cannot be opened (key retired, wrong version, wrong row) sets the connection to `error` and makes **no** Flex call.
- **Flex error codes 1001-1021** are mapped exactly as in spec 12.4: retryable = 1001, 1004-1009, 1018, 1019, 1021; fatal = 1003, 1010-1017, 1020; 1012 sets status `expired`; 1018 never counts as a poll; unknown codes are retried twice and then fatal. Poll budget: 10 polls with delays `[15, 20, 30, 45, 60, 60, 90, 90, 100, 90]` seconds (sum 600 s = 10 minutes). Internal codes: `0` transport, `-1` parse error, `-2` key unavailable, `-3` account changed, `-4` poll limit, `-5` send retry limit, `-6` missing sections, `-7` internal error.
- **T+1 disclosure (exact text, wherever broker data appears):** `Positions, trades and cost basis come from your IBKR Activity Flex statement as of {report date} (end of day). Trades made today appear after IBKR builds tomorrow's statement. Prices shown are delayed Yahoo quotes.` The UI never presents Flex numbers as live and never calls a statement "today's positions".
- **Refresh rules:** the visible Portfolio/Analytics pages refresh every 5 minutes while `document.visibilityState = "visible"` (paused when hidden, immediate fetch on becoming visible if the last fetch is older than 5 minutes). An auto refresh re-values positions with **Yahoo delayed prices only**. Flex is re-fetched at most when a new statement day is available: expected statement date = the previous weekday in Europe/Sofia (after 08:00 Sofia); `last_statement_date < expected` and `next_flex_fetch_not_before <= now` creates a `daily` run; a fetch that returns the same `last_statement_date` sets `next_flex_fetch_not_before = now + 6 h`.
- **Manual refresh cooldown 60 s**, enforced in the frontend (disabled button with countdown) and in the backend: one atomic `UPDATE broker_connections SET last_manual_refresh_at = now() WHERE user_id = $1 AND (last_manual_refresh_at IS NULL OR last_manual_refresh_at <= now() - interval '60 seconds')` inside `app.claim_manual_refresh`; no row updated -> HTTP 429 with header `Retry-After` and body `{ error: "cooldown", retryAfterSeconds }`. The response carries `serverTime`, `nextAutoRefreshAt`, `manualAvailableAt`; countdowns derive from server times. Manual **sync** (Flex) cooldown: one manual sync per 10 minutes (`app.enqueue_manual_sync`).
- **Failure rule:** a failed refresh keeps the last successful data on screen, shows the last successful refresh time and an error banner; totals are never reset to zero. `unavailable` money renders as a dash with a visually hidden reason, never `0`.
- **Portfolio table:** default sort unrealized P&L ascending (most negative first), every column sortable, `unavailable` values sort last in both directions. Valuation tag labels (exact): `Discounted`, `Premium`, `Extra premium`, `Unavailable`; never by colour alone (P4 `ValuationTag` carries icon and text; `none` renders an em dash with the visually hidden text "within channel").
- **Money and currency:** base currency = Flex Account Information `currency`. Mixed currencies are never summed without conversion: totals are in base with explicit FX, or per currency. Position currency comes from Flex; Flex reports LSE positions in `GBP` major units, Yahoo quotes them in `GBp` (pence): a Yahoo price is converted with `toMajor` before use and a x100 mismatch against the Flex mark price makes the price `unavailable` (never silently valued). Broker-reported and independently calculated figures carry the labels `Broker-reported` and `Calculated by this app`. Commissions are already netted inside Flex cost basis and realized P/L and are **never subtracted twice**. Dividends are shown gross, withholding and net, separately from trading P/L, with an "Include dividends" toggle feeding the combined figure.
- **Holdings outside the universe use the `-4` line; premium episodes carry `mode = 'worldwide'`** (A-14); holding tags and premium episodes need no rising channel, market cap or rank (A-36); the tag uses the latest completed close and says so ("based on close of {date}").
- **Privacy:** raw statements are never stored or logged; logs and events carry run ids, counts and error codes only (no symbols, amounts, account ids or tokens); Flex data never goes to AI providers; broker tables are owner-only under RLS; no client writes.

## Decisions and deviations the lead must record

| # | Decision | Reason |
|---|---|---|
| P5b-D1 | Enums follow spec 6.2: `broker_status` = `unlinked, linking, linked, error, expired`; `sync_state` = `queued, requested, polling, parsing, done, failed, expired`. The task brief's shorter lists (`pending`; `generating, fetching, upserting`) are mapped: `pending` = `linking`, `generating` = `requested`, `fetching` = `polling`, `upserting` = the transient part of `parsing` (one transaction). Enums are created inside guarded `DO` blocks in case another migration already created them. | The spec is the authority; `expired` and `linking` are needed by 1012 and the link flow. |
| P5b-D2 | Column names follow spec 6.3.6 (`query_id`, `account_id_masked`, `statement_from/to`, `match_status`, `last_error_code`). Additive columns: `broker_connections.last_error_message`; `broker_positions.signal_security_id`, `valuation_tag`, `valuation_session_date`, `valuation_reason`; `broker_trades.description`. `broker_connections.last_flex_call_at` stays (spec) but the limiter lives in `quote_cache`. No `raw jsonb` column anywhere (spec 12.10: raw data is never stored); unknown attributes are preserved only in the parser result. | Spec 6.3.6, 12.10 and the brief's limiter requirement. |
| P5b-D3 | `broker_positions` uniqueness uses `UNIQUE NULLS NOT DISTINCT (user_id, report_date, conid, level_of_detail, open_date_time)` (spec text has the same columns, but a plain unique index never matches rows whose `open_date_time` is null, which is every SUMMARY row). `broker_trades` is unique on `(user_id, ib_exec_id)` (spec); when Flex omits `ibExecID` the parser sets `ib_exec_id = 'trade:' || tradeID`. | Idempotent re-ingest; partial fills have distinct execution ids. |
| P5b-D4 | No RPC lets the owner update `broker_connections.status`. Spec 6.8 says inserts, updates and deletes are performed only by Edge Functions; the brief's "owner-update via RPC" is dropped. | Spec 6.8 wins; validation, encryption and audit must always run. |
| P5b-D5 | One active run per user: partial unique index `broker_sync_runs_one_active (user_id) WHERE state IN ('queued','requested','polling','parsing')`; inserts use `ON CONFLICT DO NOTHING`. Daily key: `<user>:daily:<Sofia date>` (spec 7.11 says `<statement_to>`; the Sofia run date is the brief's choice and equally unique per day). | Prevents two parallel syncs from hammering the 10/min token limit. |
| P5b-D6 | The broker tick is its own cron job `broker-tick` (`* * * * *`, `select app.kick_broker_sync();`) instead of a third block inside `app.kick_workers()`. `app.start_daily_broker_syncs()` also calls it. | P1 and P3 both `CREATE OR REPLACE` `kick_workers`; a separate function cannot be overwritten by a sibling migration. Folding the call into `kick_workers` later is one line. |
| P5b-D7 | `app.holder(uuid)` is replaced with a body over `broker_positions` (`security_id` or `signal_security_id`), and a `public.holds_security(uuid)` twin (SECURITY DEFINER, pinned search path) backs the new `signal_episodes` premium policy, because `authenticated` has no USAGE on schema `app` (P0 smoke test). `app.next_stage_to_seed` is patched in place to append `portfolio_scan` after `publish`. | P2 hands the holder body to P5; P1 leaves premium visibility and stage 8 to P5. |
| P5b-D8 | `positions.security_id` is the matched **held line** (valuation symbol, e.g. `SAP.DE` for an IBIS holding in EUR); `signal_security_id` is the company's canonical listing used for tags, premium episodes and risk monitoring (spec 12.7). | Spec 12.7. |
| P5b-D9 | The setup guide tells the user to choose Period "Last 365 Calendar Days" (brief) instead of spec's "Last 30 Calendar Days"; the app always overrides with explicit `fd`/`td` (daily) or `p=365` (backfill), and the first verification uses the saved period. One 365-day `backfill` run follows the first successful link; longer history (multi-window backfill) is deferred (the 365-day cap per request is documented, `coverage_from` shows what is loaded). | Brief for the page text; one extra request is cheap, multi-window is not needed for the first release. |
| P5b-D10 | The cash-type mapping ("editable mapping table", spec 12.2) is a constant rule list in `adapters/cash-types.ts`, not a database table (the spec's canonical table list has none and A-19 forbids more tables). | Keeps the table list fixed; one file to edit once a real statement shows the vocabulary. |
| P5b-D11 | `user-auth.ts`, `flex-errors.ts` (core, so the SPA can render the same hints), `statement-day.ts` and `portfolio-view.ts` (core) are additions to the brief's file list. Task 5 therefore depends on Tasks 1, 2 and 3, not only on Task 1. | `getClaims()` verification and error hints are shared by two functions and the SPA. |
| P5b-D12 | The Portfolio summary converts cost basis and market value with the **same current rate** (Yahoo pair, else the Flex rate, always labelled) so that total value minus total cost equals total unrealized P&L. The Analytics page shows cost basis with Flex rates labelled `Broker-reported`. | One consistent identity on the page; the FX effect is disclosed per position (`fxSource`, `fxDate`). |
| P5b-D13 | Fixture ingestion (integration tests) is the worker-mode action `ingest_fixture { userId, xml }`, refused unless `FLEX_FIXTURE_MODE=1` and `SUPABASE_URL` is local. | Spec 7.12 forbids silent mocks; no network and no static-file mount are needed. |
| P5b-D14 | Holding bars are fetched by P1's `handleFetchBars` (payload `{ securityIds }`) but the channel is computed by a holding-specific writer with `scope = 'holding_only'`: P1's `handleCompute` hard-codes `scope = 'universe'`, which is publicly readable and would leak holdings. | RLS `scan_security_results using (scope = 'universe')`. |
| P5b-D15 | Holdings not known to `securities` are created minimally (company with a normalised name, security from one Yahoo `quote()`), only when the exchange exists in `exchanges`; otherwise the position stays `unmatched` with the reason `unknown_exchange`. The identity stage may later regroup them (`identity_note = 'created_by_broker_match'`). | Spec 12.7 step 2 requires creation; P1's identity grouping owns canonical choice. |
| P5b-D16 | Daily P&L is estimated from the delayed quote and `regularMarketChangePercent` (previous close = price / (1 + pct/100)); labelled "estimated". | The `quotes` cache payload carries no previous close. |

## Review Focus (five failure modes, each pinned by tests in the owning task)

1. **A stale Flex statement presented as today's positions** (Tasks 1, 5, 7): `broker_ingest_statement` replaces only the snapshot of its `report_date` and the view reads only the latest `report_date` (pgTAP, `portfolio-view.test.ts`); `expectedStatementDate` + `statementFreshness` (`statement-day.test.ts`) mark a statement `behind`; the Portfolio header always renders "Broker data as of {date} (end of day, T+1)" and the `behind` banner (component test); a `GET` never calls Flex but enqueues the daily run when due (handler test).
2. **A partial-sale lot double counted** (Tasks 1, 2, 3, 9): executions and closed lots are different Flex levels of detail (parser test); `dedupe_hash` includes `openDateTime`, `quantity` and `costBasis` so two lots of one sale stay distinct while a re-ingest does not duplicate (pgTAP: 2 lots, sum 4.60, unchanged after the second ingest); `realizedSummary` sums lots only, ignores repeated keys and equals the execution P/L (`accounting.test.ts`); the integration test re-runs the fixture.
3. **GBp positions valued as GBP** (Task 5): `buildPortfolioView` converts Yahoo `GBp` with `toMajor`, rejects a x100 mismatch against the Flex mark price and never mixes currencies (`portfolio-view.test.ts` with 2735 GBp -> 27.35 GBP and a 2735 GBP rejection).
4. **Cooldown bypass via parallel requests** (Tasks 1, 5, 9): the cooldown is one SQL `UPDATE ... WHERE` (pgTAP), the handler is tested with five parallel requests against an atomic fake and the integration test fires five parallel requests at the local stack (exactly one 200, four 429 with `Retry-After`); the client disables the button and ignores clicks during the countdown (fake-timer test).
5. **Decrypting with a rotated key** (Tasks 2 and 4): `decryptSecret` rejects a version mismatch before using the key, `open` throws `key_missing` when `FLEX_ENC_KEY_V<n>` is retired, a wrong key and a tampered ciphertext fail authentication, AAD binds the ciphertext to its row; `broker-sync` then sets `error` with code `-2` and performs **no** Flex call (state machine test); `rekey` re-encrypts under the current key and a second `rekey` is a no-op.

## Task Dependencies and Concurrency

| Task | Depends on | Files owned (disjoint across concurrent tasks) | Can run concurrently with |
|---|---|---|---|
| 1 Migration and pgTAP | P1, P2, P5a migrations | `supabase/migrations/20261015005000_broker_schema.sql`, `supabase/tests/0500_broker_schema.test.sql` | 2, 3 |
| 2 Adapters, parser, fixture, function scaffolds | P0, P1 | `_shared/adapters/{crypto,flex,flex-parse,cash-types,user-auth}.ts` + tests, `_shared/adapters/fixtures/flex/*`, `_shared/core/flex-errors.ts` + test, `supabase/functions/{broker-sync,portfolio-refresh}/{deno.json,index.ts}` (scaffold), `supabase/config.toml`, `supabase/functions/.env.example` | 1, 3 |
| 3 `core/accounting.ts` | P1 (core style) | `_shared/core/accounting.ts` + test | 1, 2 |
| 4 `broker-sync` and `portfolio_scan` | 1, 2, 3 | `supabase/functions/broker-sync/*`, `worker-tick/handlers/portfolio_scan.ts` + test, `worker-tick/stages.ts` (one block) | 5 (files are disjoint) |
| 5 `portfolio-refresh` and refresh hooks | 1, 2, 3 | `_shared/core/{statement-day,portfolio-view}.ts` + tests, `supabase/functions/portfolio-refresh/*`, `apps/web/src/features/portfolio/{api,hooks,refresh}/*` shared pieces | 4 |
| 6 Profile -> Broker page | 4 (contract) | `apps/web/src/features/broker/*`, `features/profile/panels/broker-panel.tsx` | 7, 8 |
| 7 Portfolio page | 5 | `apps/web/src/features/portfolio/page/*`; wiring edit of `features/pages.tsx` and `router.tsx` | 6, 8 (wiring edits strictly in order 7 then 8) |
| 8 Analytics page | 5 | `apps/web/src/features/analytics/*`; wiring edit of `features/pages.tsx` and `router.tsx` | 6, 7 (wiring after 7) |
| 9 Integration and operator guide | 1-8 | `tools/test-broker-integration.ts`, root `package.json` script, `docs/operator-guide.md` | none |
| 10 Exit checklist | all | none | none |

The brief allowed Task 5 after Task 1 only; it also needs Task 2 (`user-auth.ts`) and Task 3 (`accounting.ts` is imported by `portfolio-view.ts`). Tasks 4 and 5 may run in parallel because they touch different files; the only shared file is `worker-tick/stages.ts` (Task 4 only). Tasks 7 and 8 both edit `features/pages.tsx` and `router.tsx`: each does that in its final wiring step, 7 before 8.

---

## Task 1: Migration `20261015005000_broker_schema.sql` and pgTAP

**Concurrency:** may run at the same time as Tasks 2 and 3 (disjoint files).

**Files:**
- Create: `supabase/migrations/20261015005000_broker_schema.sql`
- Create: `supabase/tests/0500_broker_schema.test.sql` (if P0 moved pgTAP files to a `database/` subfolder, put it next to `0001_smoke.test.sql`)

**Interfaces:**
- Consumes: P1 (`securities`, `quote_cache`, `signal_episodes`, `scan_jobs`, `app.touch_updated_at`, `app.next_stage_to_seed`, schema `app`, extensions `pg_cron`, `pg_net`, Vault secrets `project_url` and `worker_tick_secret`), P2 (`app.holder`, `risk_monitor_state`).
- Produces: enums `broker_status`, `sync_state`; tables `broker_connections`, `broker_sync_runs`, `broker_positions`, `broker_trades`, `broker_closed_lots`, `broker_cash_transactions`, `broker_corporate_actions`, `broker_fx_rates`, `broker_nav`; functions `app.broker_ingest_statement(uuid, jsonb)`, `app.claim_broker_runs(int, int)`, `app.claim_manual_refresh(uuid)`, `app.enqueue_manual_sync(uuid)`, `app.flex_rl_take(text)`, `app.apply_holding_tag(uuid, text, date, text)`, `app.held_signal_securities()`, `app.start_daily_broker_syncs(timestamptz, boolean)`, `app.kick_broker_sync()`, `public.holds_security(uuid)`, `public.monitored_holdings_for(uuid)`; replaced `app.holder(uuid)`; policy `signal_episodes_premium_holder`; cron jobs `broker-daily-0500`, `broker-daily-0600`, `broker-tick`.

- [ ] **Step 1: Check the migration order and the starting point**

Run (PowerShell): `Get-ChildItem supabase/migrations | Select-Object -ExpandProperty Name`
Expected: P0 and P1 files (`20261015000100_extensions.sql`, `20261015001000_core_schema.sql`, `20261015001100_scan_schema.sql`, `20261015001200_pipeline_functions.sql`, `20261015001300_cron_jobs.sql`), P2's `20261015002000_research_schema.sql` and P5a's `20261015003000_auth_profiles.sql`, all sorting before `20261015005000_broker_schema.sql`. If a P3 migration (notifications) sorts after `20261015005000`, nothing needs to change: this migration never replaces `app.kick_workers`. If `app.holder`, `risk_monitor_state` or `app.next_stage_to_seed` are missing, stop: P2 or P1 is not merged yet.

Run: `bun run supabase:start` (expected `Started supabase local development setup.` or the stack is already running).

- [ ] **Step 2: Write the pgTAP test first**

`supabase/tests/0500_broker_schema.test.sql`:

```sql
begin;
select plan(92);

create function pg_temp.set_claims(p_uid text) returns void
language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', p_uid, true);
end $$;

-- three users: A and B are linked, C is not
insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at) values
  ('a0000000-0000-4000-8000-00000000000a', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'a@example.test', now(), now()),
  ('b0000000-0000-4000-8000-00000000000b', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'b@example.test', now(), now()),
  ('c0000000-0000-4000-8000-00000000000c', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'c@example.test', now(), now());

insert into public.broker_connections
  (id, user_id, status, flex_token_ciphertext, flex_token_iv, key_version, query_id, base_currency, last_statement_date) values
  ('c1000000-0000-4000-8000-00000000000a', 'a0000000-0000-4000-8000-00000000000a', 'linked', '\x0102'::bytea, '\x0a0b'::bytea, 1, '111', 'EUR', '2026-10-09'),
  ('c2000000-0000-4000-8000-00000000000b', 'b0000000-0000-4000-8000-00000000000b', 'linked', '\x0304'::bytea, '\x0c0d'::bytea, 1, '222', 'USD', null),
  ('c3000000-0000-4000-8000-00000000000c', 'c0000000-0000-4000-8000-00000000000c', 'unlinked', null, null, null, null, null, null);

-- ---------------------------------------------------------------- schema, enums, RLS flags, privileges (as the table owner)
select is((select count(*)::int from pg_tables where schemaname = 'public' and tablename like 'broker\_%'), 9,
  'nine broker tables exist');
select enum_has_labels('public', 'broker_status', array['unlinked', 'linking', 'linked', 'error', 'expired'], 'broker_status labels');
select enum_has_labels('public', 'sync_state', array['queued', 'requested', 'polling', 'parsing', 'done', 'failed', 'expired'], 'sync_state labels');
select is((select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'public' and c.relkind = 'r' and c.relname like 'broker\_%' and c.relrowsecurity), 9,
  'row level security is enabled on every broker table');
select is(has_column_privilege('authenticated', 'public.broker_connections', 'flex_token_ciphertext', 'select'), false,
  'authenticated cannot select the token ciphertext');
select is(has_column_privilege('authenticated', 'public.broker_connections', 'flex_token_iv', 'select'), false,
  'authenticated cannot select the token IV');
select is(has_column_privilege('authenticated', 'public.broker_connections', 'key_version', 'select'), false,
  'authenticated cannot select the key version');
select is(has_column_privilege('authenticated', 'public.broker_connections', 'status', 'select'), true,
  'authenticated can select the status');
select is(has_column_privilege('anon', 'public.broker_connections', 'status', 'select'), false,
  'anon cannot select anything from broker_connections');
select ok(exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'broker_sync_runs_one_active'),
  'one active run per user is enforced by a partial unique index');
select ok(pg_get_functiondef('app.next_stage_to_seed(uuid)'::regprocedure) like '%portfolio_scan%',
  'the stage order includes portfolio_scan');
select ok(exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'signal_episodes' and policyname = 'signal_episodes_premium_holder'),
  'premium episodes have a holders-only policy');

-- ---------------------------------------------------------------- app.broker_ingest_statement: one transaction, idempotent, snapshot replace
create temp table _p as select $j$
{
  "meta": {"report_date": "2026-10-14", "statement_from": "2026-09-15", "statement_to": "2026-10-14",
           "account_id_masked": "U***4567", "base_currency": "EUR", "account_type": "Individual"},
  "positions": [
    {"conid": 100001, "isin": "US0378331005", "symbol": "AAPL", "description": "APPLE INC", "asset_class": "STK", "sub_category": "COMMON",
     "listing_exchange": "NASDAQ", "currency": "USD", "fx_rate_to_base": 0.92, "quantity": 10, "multiplier": 1, "mark_price": 230,
     "position_value": 2300, "open_price": 200.17, "cost_basis_price": 200.17, "cost_basis_money": 2001.7, "fifo_pnl_unrealized": 298.3,
     "percent_of_nav": 12.5, "level_of_detail": "SUMMARY", "open_date_time": null},
    {"conid": 100002, "isin": "GB00BP6MXD84", "symbol": "SHEL", "description": "SHELL PLC", "asset_class": "STK", "sub_category": "COMMON",
     "listing_exchange": "LSE", "currency": "GBP", "fx_rate_to_base": 1.15, "quantity": 100, "multiplier": 1, "mark_price": 27.35,
     "position_value": 2735, "open_price": 25, "cost_basis_price": 25, "cost_basis_money": 2500, "fifo_pnl_unrealized": 235,
     "percent_of_nav": 17.1, "level_of_detail": "SUMMARY", "open_date_time": null}
  ],
  "trades": [
    {"trade_id": "1001001", "ib_exec_id": "E-0001", "ib_order_id": "5001", "conid": 100001, "isin": null, "symbol": "AAPL", "description": "APPLE INC",
     "listing_exchange": "NASDAQ", "exchange": "NASDAQ", "currency": "USD", "fx_rate_to_base": 0.92, "trade_date": "2026-10-09", "trade_time": "09:30:01",
     "settle_date": null, "buy_sell": "BUY", "quantity": 6, "trade_price": 199.5, "trade_money": 1197, "proceeds": -1197, "taxes": 0,
     "ib_commission": -1, "ib_commission_currency": "USD", "net_cash": -1198, "cost_basis": 1198, "fifo_pnl_realized": 0, "open_close": "O",
     "order_type": "LMT", "report_date": "2026-10-14"},
    {"trade_id": "1001002", "ib_exec_id": "E-0002", "ib_order_id": "5001", "conid": 100001, "isin": null, "symbol": "AAPL", "description": "APPLE INC",
     "listing_exchange": "NASDAQ", "exchange": "NASDAQ", "currency": "USD", "fx_rate_to_base": 0.92, "trade_date": "2026-10-09", "trade_time": "09:30:07",
     "settle_date": null, "buy_sell": "BUY", "quantity": 4, "trade_price": 200.75, "trade_money": 803, "proceeds": -803, "taxes": 0,
     "ib_commission": -0.7, "ib_commission_currency": "USD", "net_cash": -803.7, "cost_basis": 803.7, "fifo_pnl_realized": 0, "open_close": "O",
     "order_type": "LMT", "report_date": "2026-10-14"}
  ],
  "closed_lots": [
    {"conid": 100002, "symbol": "SHEL", "currency": "GBP", "fx_rate_to_base": 1.15, "open_date_time": "2026-01-15T09:30:00Z", "close_date": "2026-10-08",
     "closing_trade_id": "2002001", "quantity": 3, "cost_basis": 75, "proceeds": 79.5, "fifo_pnl_realized": 4.2, "dedupe_hash": "lot-hash-a"},
    {"conid": 100002, "symbol": "SHEL", "currency": "GBP", "fx_rate_to_base": 1.15, "open_date_time": "2026-02-20T10:15:00Z", "close_date": "2026-10-08",
     "closing_trade_id": "2002001", "quantity": 1, "cost_basis": 26, "proceeds": 26.5, "fifo_pnl_realized": 0.4, "dedupe_hash": "lot-hash-b"}
  ],
  "cash": [
    {"occurred_at": "2026-10-10T00:00:00Z", "report_date": "2026-10-14", "currency": "USD", "fx_rate_to_base": 0.92, "amount": 2.6, "type_raw": "Dividends",
     "category": "dividend", "conid": 100001, "isin": "US0378331005", "symbol": "AAPL", "description": "AAPL cash dividend", "trade_id": null, "code": null,
     "dedupe_hash": "cash-hash-a"},
    {"occurred_at": "2026-10-10T00:00:00Z", "report_date": "2026-10-14", "currency": "USD", "fx_rate_to_base": 0.92, "amount": -0.39, "type_raw": "Withholding Tax",
     "category": "withholding_tax", "conid": 100001, "isin": "US0378331005", "symbol": "AAPL", "description": "AAPL withholding", "trade_id": null, "code": null,
     "dedupe_hash": "cash-hash-b"}
  ],
  "fx": [
    {"rate_date": "2026-10-14", "from_ccy": "USD", "to_ccy": "EUR", "rate": 0.92},
    {"rate_date": "2026-10-14", "from_ccy": "GBP", "to_ccy": "EUR", "rate": 1.15}
  ],
  "nav": [
    {"report_date": "2026-10-13", "currency": "EUR", "cash": 1000, "stock": 8800.55, "other": null, "total": 9800.55},
    {"report_date": "2026-10-14", "currency": "EUR", "cash": 1000, "stock": 8950.2, "other": null, "total": 9950.2}
  ],
  "corporate_actions": []
}
$j$::jsonb as payload;

insert into public.broker_sync_runs (id, user_id, connection_id, kind, state, idempotency_key) values
  ('f0000000-0000-4000-8000-00000000000a', 'a0000000-0000-4000-8000-00000000000a', 'c1000000-0000-4000-8000-00000000000a', 'verify', 'parsing', 'test:ingest-a');

select lives_ok($$select app.broker_ingest_statement('f0000000-0000-4000-8000-00000000000a', (select payload from _p))$$, 'the first ingest succeeds');
select is((select count(*)::int from public.broker_positions where user_id = 'a0000000-0000-4000-8000-00000000000a'), 2, 'two positions');
select is((select count(*)::int from public.broker_trades where user_id = 'a0000000-0000-4000-8000-00000000000a'), 2, 'two executions of one order (partial fills)');
select is((select count(*)::int from public.broker_closed_lots where user_id = 'a0000000-0000-4000-8000-00000000000a'), 2, 'two closed lots of one partial sale');
select is((select count(*)::int from public.broker_cash_transactions where user_id = 'a0000000-0000-4000-8000-00000000000a'), 2, 'dividend and withholding rows');
select is((select count(*)::int from public.broker_fx_rates where user_id = 'a0000000-0000-4000-8000-00000000000a'), 2, 'two conversion rates');
select is((select count(*)::int from public.broker_nav where user_id = 'a0000000-0000-4000-8000-00000000000a'), 2, 'two NAV rows');
select is((select sum(fifo_pnl_realized) from public.broker_closed_lots where user_id = 'a0000000-0000-4000-8000-00000000000a'), 4.6::numeric,
  'the partial-sale lots add up to the execution P/L (4.60), nothing is counted twice');
select is((select last_statement_date from public.broker_connections where user_id = 'a0000000-0000-4000-8000-00000000000a'), '2026-10-14'::date,
  'last_statement_date advances to the statement end');
select is((select coverage_from from public.broker_connections where user_id = 'a0000000-0000-4000-8000-00000000000a'), '2026-09-15'::date,
  'coverage_from is the statement start');
select is((select next_flex_fetch_not_before from public.broker_connections where user_id = 'a0000000-0000-4000-8000-00000000000a'), null,
  'a statement with a new day does not delay the next fetch');

select lives_ok($$select app.broker_ingest_statement('f0000000-0000-4000-8000-00000000000a', (select payload from _p))$$, 'the same statement can be ingested again');
select is((select (select count(*) from public.broker_positions where user_id = 'a0000000-0000-4000-8000-00000000000a')
               + (select count(*) from public.broker_trades where user_id = 'a0000000-0000-4000-8000-00000000000a')
               + (select count(*) from public.broker_closed_lots where user_id = 'a0000000-0000-4000-8000-00000000000a')
               + (select count(*) from public.broker_cash_transactions where user_id = 'a0000000-0000-4000-8000-00000000000a')
               + (select count(*) from public.broker_fx_rates where user_id = 'a0000000-0000-4000-8000-00000000000a')
               + (select count(*) from public.broker_nav where user_id = 'a0000000-0000-4000-8000-00000000000a'))::int, 12,
  're-ingest creates no duplicate rows');
select ok((select next_flex_fetch_not_before from public.broker_connections where user_id = 'a0000000-0000-4000-8000-00000000000a') > now(),
  'a statement that brings no new day pushes the next Flex fetch 6 hours out');

update public.broker_positions set match_status = 'matched_isin', valuation_tag = 'discounted', valuation_session_date = '2026-10-13'
 where user_id = 'a0000000-0000-4000-8000-00000000000a' and conid = 100001;
select lives_ok($$select app.broker_ingest_statement('f0000000-0000-4000-8000-00000000000a', (select payload #- '{positions,1}' from _p))$$,
  'a statement with fewer positions replaces the snapshot of its report date');
select is((select count(*)::int from public.broker_positions where user_id = 'a0000000-0000-4000-8000-00000000000a'), 1, 'the snapshot was replaced, not merged');
select is((select valuation_tag from public.broker_positions where user_id = 'a0000000-0000-4000-8000-00000000000a' and conid = 100001), 'discounted',
  'matching state and valuation tag of the same conid are carried over');
select is((select count(*)::int from public.broker_positions where user_id = 'b0000000-0000-4000-8000-00000000000b'), 0, 'the other user has no rows');
select throws_ok($$select app.broker_ingest_statement('00000000-0000-4000-8000-000000000999', '{}'::jsonb)$$, '22023', null,
  'an unknown run is rejected');
update public.broker_sync_runs set state = 'done';

-- ---------------------------------------------------------------- app.flex_rl_take: 1.1 s spacing and 10 calls per rolling 60 s
select is(app.flex_rl_take('flexrl:test'), 0, 'the first Flex call is granted');
select cmp_ok(app.flex_rl_take('flexrl:test'), '>', 0, 'a second call within 1.1 s must wait');
select cmp_ok(app.flex_rl_take('flexrl:test'), '<=', 1100, 'the wait never exceeds the 1.1 s spacing');
update public.quote_cache
   set payload = jsonb_build_object('calls', (select jsonb_agg((extract(epoch from clock_timestamp()) * 1000)::bigint - 59000 + i * 1500 order by i)
                                                from generate_series(0, 9) i))
 where key = 'flexrl:test';
select cmp_ok(app.flex_rl_take('flexrl:test'), '>', 0, 'the 11th call inside 60 s must wait');
select cmp_ok(app.flex_rl_take('flexrl:test'), '<=', 61000, 'the 60 s window bounds the wait');
update public.quote_cache
   set payload = jsonb_build_object('calls', jsonb_build_array((extract(epoch from clock_timestamp()) * 1000)::bigint - 90000))
 where key = 'flexrl:test';
select is(app.flex_rl_take('flexrl:test'), 0, 'calls older than 60 s no longer count');
select is(has_function_privilege('authenticated', 'app.flex_rl_take(text)', 'execute'), false, 'authenticated cannot call the limiter');
select is(has_function_privilege('anon', 'app.flex_rl_take(text)', 'execute'), false, 'anon cannot call the limiter');

-- ---------------------------------------------------------------- app.claim_manual_refresh: one atomic UPDATE ... WHERE (60 s cooldown)
select is((select claimed from app.claim_manual_refresh('a0000000-0000-4000-8000-00000000000a')), true, 'the first manual refresh is claimed');
select is((select claimed from app.claim_manual_refresh('a0000000-0000-4000-8000-00000000000a')), false, 'a second claim inside 60 s is refused');
select ok((select available_at from app.claim_manual_refresh('a0000000-0000-4000-8000-00000000000a')) > now(), 'the refusal reports when the next claim is possible');
select is((select claimed from app.claim_manual_refresh('b0000000-0000-4000-8000-00000000000b')), true, 'another user is not affected');
update public.broker_connections set last_manual_refresh_at = now() - interval '61 seconds' where user_id = 'a0000000-0000-4000-8000-00000000000a';
select is((select claimed from app.claim_manual_refresh('a0000000-0000-4000-8000-00000000000a')), true, 'after 61 s the claim succeeds again');
select is((select claimed from app.claim_manual_refresh('c0000000-0000-4000-8000-00000000000c')), false, 'an unlinked connection cannot claim a refresh');

-- ---------------------------------------------------------------- app.enqueue_manual_sync: 10 minute cooldown, one active run
select is((select outcome from app.enqueue_manual_sync('a0000000-0000-4000-8000-00000000000a')), 'created', 'the first manual sync is queued');
select is((select outcome from app.enqueue_manual_sync('a0000000-0000-4000-8000-00000000000a')), 'busy', 'a sync is refused while a run is active');
update public.broker_sync_runs set state = 'done';
select is((select outcome from app.enqueue_manual_sync('a0000000-0000-4000-8000-00000000000a')), 'cooldown', 'a second manual sync inside 10 minutes is refused');
select ok((select retry_after_seconds from app.enqueue_manual_sync('a0000000-0000-4000-8000-00000000000a')) between 1 and 600, 'the cooldown reports the remaining seconds');
select is((select outcome from app.enqueue_manual_sync('c0000000-0000-4000-8000-00000000000c')), 'not_linked', 'an unlinked user cannot sync');
update public.broker_sync_runs set state = 'done';

-- ---------------------------------------------------------------- cron entries and app.start_daily_broker_syncs (Sofia hour guard = 8)
select is((select schedule from cron.job where jobname = 'broker-daily-0500'), '0 5 * * *', 'broker-daily-0500 runs at 05:00 UTC');
select is((select schedule from cron.job where jobname = 'broker-daily-0600'), '0 6 * * *', 'broker-daily-0600 runs at 06:00 UTC');
select is((select count(*)::int from cron.job where jobname like 'broker-daily-%' and command = 'select app.start_daily_broker_syncs();'), 2,
  'both daily entries call app.start_daily_broker_syncs()');
select is((select schedule from cron.job where jobname = 'broker-tick'), '* * * * *', 'broker-tick runs every minute');

update public.broker_connections set next_flex_fetch_not_before = null;
select is(app.start_daily_broker_syncs('2026-10-15 05:00:00+00'), 2, 'summer 05:00 UTC is 08:00 Sofia: both linked users are seeded');
select is(app.start_daily_broker_syncs('2026-10-15 05:00:00+00'), 0, 'a second call on the same Sofia date seeds nothing');
select is((select count(*)::int from public.broker_sync_runs where idempotency_key = 'a0000000-0000-4000-8000-00000000000a:daily:2026-10-15'), 1,
  'the idempotency key is <user>:daily:<Sofia date>');
select is((select statement_to from public.broker_sync_runs where idempotency_key = 'a0000000-0000-4000-8000-00000000000a:daily:2026-10-15'), '2026-10-14'::date,
  'the window ends the day before');
select is((select statement_from from public.broker_sync_runs where idempotency_key = 'a0000000-0000-4000-8000-00000000000a:daily:2026-10-15'), '2026-10-09'::date,
  'the window starts 5 days before last_statement_date');
select is((select statement_from from public.broker_sync_runs where idempotency_key = 'b0000000-0000-4000-8000-00000000000b:daily:2026-10-15'), null,
  'without a statement the run uses the query default period');
select is((select count(*)::int from public.broker_sync_runs where user_id = 'c0000000-0000-4000-8000-00000000000c'), 0, 'an unlinked user is never seeded');
select throws_ok($$insert into public.broker_sync_runs (user_id, connection_id, kind, state, idempotency_key)
                   values ('a0000000-0000-4000-8000-00000000000a', 'c1000000-0000-4000-8000-00000000000a', 'manual', 'queued', 'second-active')$$,
  '23505', null, 'a second active run for the same user is rejected');
update public.broker_sync_runs set state = 'done';
select is(app.start_daily_broker_syncs('2026-10-15 06:00:00+00'), 0, 'summer 06:00 UTC is 09:00 Sofia: the hour guard blocks it');
select is(app.start_daily_broker_syncs('2026-12-15 05:00:00+00'), 0, 'winter 05:00 UTC is 07:00 Sofia: the hour guard blocks it');
update public.broker_connections set next_flex_fetch_not_before = '2026-12-16 00:00:00+00' where user_id = 'b0000000-0000-4000-8000-00000000000b';
select is(app.start_daily_broker_syncs('2026-12-15 06:00:00+00'), 1, 'winter 06:00 UTC is 08:00 Sofia: only the user whose next fetch is due is seeded');
update public.broker_sync_runs set state = 'done';
update public.broker_connections set next_flex_fetch_not_before = null;
select is(app.start_daily_broker_syncs('2026-10-25 05:00:00+00'), 0, '2026-10-25 05:00 UTC is 07:00 Sofia (clocks changed): blocked');
select is(app.start_daily_broker_syncs('2026-10-25 06:00:00+00'), 2, '2026-10-25 06:00 UTC is 08:00 Sofia: seeded');
update public.broker_sync_runs set state = 'done';

-- ---------------------------------------------------------------- holders: app.holder, public.holds_security, public.monitored_holdings_for
insert into public.exchanges (code, name, country, timezone, currencies) values ('NMS', 'Nasdaq', 'United States', 'America/New_York', array['USD'])
  on conflict (code) do nothing;
insert into public.companies (id, name, name_normalized) values
  ('d0000000-0000-4000-8000-000000000001', 'Test Corp', 'test corp'), ('d0000000-0000-4000-8000-000000000002', 'Other Corp', 'other corp');
insert into public.securities (id, company_id, yahoo_symbol, exchange_code, currency, currency_major, quote_type) values
  ('e0000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000001', 'TESTA', 'NMS', 'USD', 'USD', 'EQUITY'),
  ('e0000000-0000-4000-8000-000000000002', 'd0000000-0000-4000-8000-000000000002', 'TESTB', 'NMS', 'USD', 'USD', 'EQUITY');
update public.broker_positions set security_id = 'e0000000-0000-4000-8000-000000000001', signal_security_id = 'e0000000-0000-4000-8000-000000000001',
       match_status = 'matched_isin'
 where user_id = 'a0000000-0000-4000-8000-00000000000a' and conid = 100001;
insert into public.broker_positions (user_id, report_date, conid, symbol, currency, quantity, multiplier, security_id, signal_security_id, match_status) values
  ('b0000000-0000-4000-8000-00000000000b', '2026-10-14', 777, 'ZZZ', 'USD', 5, 1, 'e0000000-0000-4000-8000-000000000002', 'e0000000-0000-4000-8000-000000000002', 'matched_isin');

select pg_temp.set_claims('a0000000-0000-4000-8000-00000000000a');
select is(public.holds_security('e0000000-0000-4000-8000-000000000001'), true, 'A holds the first security');
select is(public.holds_security('e0000000-0000-4000-8000-000000000002'), false, 'A does not hold the second security');
select is(app.holder('e0000000-0000-4000-8000-000000000001'), true, 'app.holder is based on broker_positions');
select pg_temp.set_claims('b0000000-0000-4000-8000-00000000000b');
select is(public.holds_security('e0000000-0000-4000-8000-000000000001'), false, 'B does not hold the first security');
select is((select count(*)::int from public.monitored_holdings_for('a0000000-0000-4000-8000-00000000000a')), 1, 'monitored_holdings_for lists the matched holding (service view)');
select is((select count(*)::int from app.held_signal_securities()), 2, 'held_signal_securities lists the signal security of every latest snapshot once');

-- ---------------------------------------------------------------- RLS as user A (authenticated)
select pg_temp.set_claims('a0000000-0000-4000-8000-00000000000a');
set local role authenticated;

select is((select count(*)::int from public.broker_connections), 1, 'A sees exactly one connection');
select is((select count(*)::int from public.broker_connections where user_id = 'b0000000-0000-4000-8000-00000000000b'), 0, 'A cannot see the connection of B');
select throws_ok($$select flex_token_ciphertext from public.broker_connections$$, '42501', null, 'the owner cannot select the ciphertext');
select throws_ok($$select flex_token_iv from public.broker_connections$$, '42501', null, 'the owner cannot select the IV');
select throws_ok($$select * from public.broker_connections$$, '42501', null, 'select * is refused because it includes secret columns');
select throws_ok($$select reference_code from public.broker_sync_runs$$, '42501', null, 'the Flex reference code is not selectable');
select is((select count(*)::int from public.broker_positions), 1, 'A sees only the own positions');
select is((select (select count(*) from public.broker_trades) + (select count(*) from public.broker_closed_lots)
               + (select count(*) from public.broker_cash_transactions) + (select count(*) from public.broker_fx_rates)
               + (select count(*) from public.broker_nav))::int, 10, 'A sees the own statement rows');
select is((select count(*)::int from public.broker_sync_runs where user_id = 'b0000000-0000-4000-8000-00000000000b'), 0, 'A cannot see the runs of B');
select throws_ok($$update public.broker_connections set status = 'unlinked'$$, '42501', null, 'clients cannot update the connection');
select throws_ok($$insert into public.broker_positions (user_id, report_date, conid, symbol, currency, quantity) values ('a0000000-0000-4000-8000-00000000000a', '2026-10-14', 1, 'X', 'USD', 1)$$,
  '42501', null, 'clients cannot insert positions');
select throws_ok($$delete from public.broker_trades$$, '42501', null, 'clients cannot delete trades');
select throws_ok($$update public.broker_sync_runs set state = 'done'$$, '42501', null, 'clients cannot update runs');
select throws_ok($$select * from app.claim_manual_refresh('a0000000-0000-4000-8000-00000000000a')$$, '42501', null, 'clients cannot call the service functions');
select is((select count(*)::int from public.monitored_holdings_for('a0000000-0000-4000-8000-00000000000a')), 1, 'A can list the own monitored holdings');
select is((select count(*)::int from public.monitored_holdings_for('b0000000-0000-4000-8000-00000000000b')), 0, 'A cannot list the holdings of B');

reset role;
select pg_temp.set_claims('b0000000-0000-4000-8000-00000000000b');
set local role authenticated;
select is((select count(*)::int from public.broker_connections where user_id = 'a0000000-0000-4000-8000-00000000000a'), 0, 'B cannot see the connection of A');
select is((select count(*)::int from public.broker_trades), 0, 'B sees no trades (none were ingested for B)');
select is((select count(*)::int from public.broker_positions), 1, 'B sees only the own position');
reset role;

select * from finish();
rollback;
```

- [ ] **Step 3: Run the test and confirm it fails**

First compute the plan number: in PowerShell run

```powershell
(Select-String -Path supabase/tests/0500_broker_schema.test.sql -Pattern '^select (is|ok|cmp_ok|throws_ok|lives_ok|enum_has_labels)\(').Count
```

and check that it equals the number in `select plan(92);` (update both if you add or remove assertions; the file ends with `select * from finish();`, which fails loudly if the count drifts). Then run `bun run test:db`. Expected: FAIL (the relations and functions do not exist yet).

- [ ] **Step 4: Write the migration**

`supabase/migrations/20261015005000_broker_schema.sql`:

```sql
-- P5b: broker tables, privileges, RLS, ingest / claim / cooldown / limiter functions, daily and minute cron entries.
-- Requires P1 (securities, quote_cache, signal_episodes, app.next_stage_to_seed), P2 (app.holder, risk_monitor_state).
-- Spec 6.3.6, 6.7, 6.8, 6.9, 7.1, 12.4, 12.8.

-- ------------------------------------------------------------------ enums (spec 6.2; guarded in case another migration created them)
do $$
begin
  if not exists (select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace where n.nspname = 'public' and t.typname = 'broker_status') then
    create type public.broker_status as enum ('unlinked', 'linking', 'linked', 'error', 'expired');
  end if;
  if not exists (select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace where n.nspname = 'public' and t.typname = 'sync_state') then
    create type public.sync_state as enum ('queued', 'requested', 'polling', 'parsing', 'done', 'failed', 'expired');
  end if;
end $$;

-- ------------------------------------------------------------------ tables (spec 6.3.6 plus the additive columns of P5b-D2)
create table if not exists public.broker_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users on delete cascade,        -- one connection per user in v1
  status public.broker_status not null default 'unlinked',
  flex_token_ciphertext bytea, flex_token_iv bytea, key_version int,           -- secret columns: no client SELECT (6.8)
  token_expires_on date,
  query_id text, account_id_masked text, base_currency char(3), account_type text,
  linked_at timestamptz, last_verified_at timestamptz, last_sync_at timestamptz, last_statement_date date,
  last_error_code int, last_error_message text, last_error_at timestamptz,
  last_manual_refresh_at timestamptz, next_flex_fetch_not_before timestamptz, last_flex_call_at timestamptz,
  coverage_from date,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

create table if not exists public.broker_sync_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users on delete cascade,
  connection_id uuid not null references public.broker_connections on delete cascade,
  kind text not null check (kind in ('verify', 'daily', 'manual', 'backfill')),
  state public.sync_state not null default 'queued',
  reference_code text, requested_at timestamptz, last_poll_at timestamptz, poll_count int not null default 0, next_poll_at timestamptz,
  statement_from date, statement_to date, error_code int, error_message text,
  rows_summary jsonb not null default '{}', lease_until timestamptz,
  idempotency_key text not null unique,
  created_at timestamptz not null default now(), finished_at timestamptz
);
create unique index if not exists broker_sync_runs_one_active on public.broker_sync_runs (user_id)
  where state in ('queued', 'requested', 'polling', 'parsing');
create index if not exists broker_sync_runs_runnable on public.broker_sync_runs (next_poll_at)
  where state in ('queued', 'requested', 'polling', 'parsing');
create index if not exists broker_sync_runs_user_created on public.broker_sync_runs (user_id, created_at desc);

create table if not exists public.broker_positions (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users on delete cascade, report_date date not null,
  conid bigint not null, isin text, symbol text not null, description text, asset_class text, sub_category text, listing_exchange text,
  currency text not null, fx_rate_to_base numeric, quantity numeric not null, multiplier numeric not null default 1,
  mark_price numeric, position_value numeric, open_price numeric, cost_basis_price numeric, cost_basis_money numeric,
  fifo_pnl_unrealized numeric, percent_of_nav numeric, level_of_detail text not null default 'SUMMARY',
  open_date_time timestamptz,
  security_id uuid references public.securities,                                 -- the matched held line (valuation symbol)
  signal_security_id uuid references public.securities,                          -- the company's canonical listing (tags, premium, risk)
  match_status text not null default 'unmatched'
    check (match_status in ('matched_isin', 'matched_symbol_exchange', 'unmatched', 'not_equity')),
  valuation_tag text check (valuation_tag in ('discounted', 'premium', 'extra_premium', 'unavailable', 'none')),
  valuation_session_date date, valuation_reason text,
  constraint broker_positions_snapshot_key unique nulls not distinct (user_id, report_date, conid, level_of_detail, open_date_time)
);
create index if not exists broker_positions_user_report on public.broker_positions (user_id, report_date desc);
create index if not exists broker_positions_user_security on public.broker_positions (user_id, security_id);
create index if not exists broker_positions_signal_security on public.broker_positions (signal_security_id);

create table if not exists public.broker_trades (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users on delete cascade,
  trade_id text, ib_exec_id text not null, ib_order_id text, conid bigint not null, isin text, symbol text not null, description text,
  listing_exchange text, exchange text, currency text not null, fx_rate_to_base numeric,
  trade_date date not null, trade_time time, settle_date date,
  buy_sell text not null check (buy_sell in ('BUY', 'SELL')), quantity numeric not null, trade_price numeric not null,
  trade_money numeric, proceeds numeric, taxes numeric, ib_commission numeric, ib_commission_currency text, net_cash numeric,
  cost_basis numeric, fifo_pnl_realized numeric, open_close text, order_type text, report_date date,
  unique (user_id, ib_exec_id)
);
create index if not exists broker_trades_user_date on public.broker_trades (user_id, trade_date desc);

create table if not exists public.broker_closed_lots (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users on delete cascade,
  conid bigint not null, symbol text not null, currency text not null, fx_rate_to_base numeric,
  open_date_time timestamptz, close_date date not null, closing_trade_id text, quantity numeric not null,
  cost_basis numeric not null, proceeds numeric, fifo_pnl_realized numeric not null,
  dedupe_hash text not null, unique (user_id, dedupe_hash)
);
create index if not exists broker_closed_lots_user_close on public.broker_closed_lots (user_id, close_date desc);

create table if not exists public.broker_cash_transactions (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users on delete cascade,
  occurred_at timestamptz not null, report_date date, currency text not null, fx_rate_to_base numeric, amount numeric not null,
  type_raw text not null,
  category text not null check (category in ('dividend', 'withholding_tax', 'interest', 'fee', 'deposit_withdrawal', 'other')),
  conid bigint, isin text, symbol text, description text, trade_id text, code text,
  dedupe_hash text not null, unique (user_id, dedupe_hash)
);
create index if not exists broker_cash_user_occurred on public.broker_cash_transactions (user_id, occurred_at desc);

create table if not exists public.broker_corporate_actions (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users on delete cascade,
  kind text not null check (kind in ('corporate_action', 'transfer')), occurred_at timestamptz, conid bigint, symbol text, type_raw text,
  quantity numeric, amount numeric, currency text, code text, dedupe_hash text not null, unique (user_id, dedupe_hash)
);

create table if not exists public.broker_fx_rates (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users on delete cascade,
  rate_date date not null, from_ccy char(3) not null, to_ccy char(3) not null, rate numeric not null,
  unique (user_id, rate_date, from_ccy, to_ccy)
);

create table if not exists public.broker_nav (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users on delete cascade, report_date date not null, currency char(3) not null,
  cash numeric, stock numeric, other numeric, total numeric not null, unique (user_id, report_date)
);

drop trigger if exists broker_connections_touch on public.broker_connections;
create trigger broker_connections_touch before update on public.broker_connections
  for each row execute function app.touch_updated_at();

-- ------------------------------------------------------------------ privileges and RLS (spec 6.8, 6.9): owner SELECT only, no client writes
alter table public.broker_connections          enable row level security;
alter table public.broker_sync_runs            enable row level security;
alter table public.broker_positions            enable row level security;
alter table public.broker_trades               enable row level security;
alter table public.broker_closed_lots          enable row level security;
alter table public.broker_cash_transactions    enable row level security;
alter table public.broker_corporate_actions    enable row level security;
alter table public.broker_fx_rates             enable row level security;
alter table public.broker_nav                  enable row level security;

revoke all on public.broker_connections, public.broker_sync_runs, public.broker_positions, public.broker_trades,
              public.broker_closed_lots, public.broker_cash_transactions, public.broker_corporate_actions,
              public.broker_fx_rates, public.broker_nav from anon, authenticated;
-- belt and braces: even if a default privilege grants table-level SELECT later, the secret columns stay revoked
revoke select (flex_token_ciphertext, flex_token_iv, key_version) on public.broker_connections from anon, authenticated;

grant select (id, user_id, status, token_expires_on, query_id, account_id_masked, base_currency, account_type, linked_at, last_verified_at,
              last_sync_at, last_statement_date, last_error_code, last_error_message, last_error_at, next_flex_fetch_not_before,
              coverage_from, last_manual_refresh_at, updated_at)
  on public.broker_connections to authenticated;
grant select (id, user_id, connection_id, kind, state, statement_from, statement_to, poll_count, error_code, error_message, rows_summary, created_at, finished_at)
  on public.broker_sync_runs to authenticated;                                   -- no reference_code, lease_until or idempotency_key
grant select on public.broker_positions, public.broker_trades, public.broker_closed_lots, public.broker_cash_transactions,
                public.broker_corporate_actions, public.broker_fx_rates, public.broker_nav to authenticated;

do $$
declare t text;
begin
  foreach t in array array['broker_connections', 'broker_sync_runs', 'broker_positions', 'broker_trades', 'broker_closed_lots',
                           'broker_cash_transactions', 'broker_corporate_actions', 'broker_fx_rates', 'broker_nav'] loop
    execute format('drop policy if exists %I on public.%I', t || '_select_own', t);
    execute format('create policy %I on public.%I for select to authenticated using (user_id = (select auth.uid()))', t || '_select_own', t);
  end loop;
end $$;

-- ------------------------------------------------------------------ holder helpers (P2 hands app.holder to P5; the public twin backs RLS because authenticated has no USAGE on app)
create or replace function app.holder(p_security_id uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from public.broker_positions p
     where p.user_id = auth.uid() and (p.security_id = p_security_id or p.signal_security_id = p_security_id))
$$;

create or replace function public.holds_security(p_security_id uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from public.broker_positions p
     where p.user_id = auth.uid() and (p.security_id = p_security_id or p.signal_security_id = p_security_id))
$$;
revoke execute on function public.holds_security(uuid) from public, anon;
grant execute on function public.holds_security(uuid) to authenticated, service_role;

-- premium episodes exist only for held securities; hiding them from everybody else prevents leaking holdings (spec 6.9)
drop policy if exists signal_episodes_premium_holder on public.signal_episodes;
create policy signal_episodes_premium_holder on public.signal_episodes
  for select to authenticated
  using (kind in ('premium1', 'premium2') and public.holds_security(security_id));

-- Holdings that P2's risk monitor may watch: the latest snapshot of the user, matched, non-zero. SECURITY INVOKER: a client only ever sees its own rows,
-- the service role (which bypasses RLS) can ask for any user.
create or replace function public.monitored_holdings_for(p_user uuid)
returns table (security_id uuid, signal_security_id uuid, symbol text, isin text, conid bigint, report_date date, quantity numeric)
language sql stable security invoker set search_path = public as $$
  select p.security_id, coalesce(p.signal_security_id, p.security_id), p.symbol, p.isin, p.conid, p.report_date, p.quantity
    from public.broker_positions p
   where p.user_id = p_user
     and p.report_date = (select max(m.report_date) from public.broker_positions m where m.user_id = p_user)
     and p.quantity <> 0 and p.security_id is not null
     and p.match_status in ('matched_isin', 'matched_symbol_exchange')
$$;
revoke execute on function public.monitored_holdings_for(uuid) from public, anon;
grant execute on function public.monitored_holdings_for(uuid) to authenticated, service_role;

-- ------------------------------------------------------------------ stage order: append portfolio_scan after publish (P1 owns the array, later phases extend it)
do $$
declare v_def text; v_new text;
begin
  select pg_get_functiondef('app.next_stage_to_seed(uuid)'::regprocedure) into v_def;
  if v_def like '%portfolio_scan%' then return; end if;
  v_new := regexp_replace(v_def, '''publish''(\s*[,\]])', '''publish'',''portfolio_scan''\1');
  if v_new = v_def then
    raise exception 'next_stage_to_seed: the publish stage was not found in the stage order, patch it by hand';
  end if;
  execute v_new;
end $$;

-- ------------------------------------------------------------------ ingest: one transaction per statement (spec 12.5)
create or replace function app.broker_ingest_statement(p_run_id uuid, p_payload jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_user uuid; v_conn uuid; v_report date; v_from date; v_to date; v_prev_stmt date; v_prev jsonb;
  n_pos int := 0; n_trd int := 0; n_lot int := 0; n_cash int := 0; n_fx int := 0; n_nav int := 0; n_corp int := 0;
begin
  select user_id, connection_id into v_user, v_conn from public.broker_sync_runs where id = p_run_id for update;
  if v_user is null then
    raise exception 'unknown sync run %', p_run_id using errcode = '22023';
  end if;
  v_report := (p_payload #>> '{meta,report_date}')::date;
  v_from := (p_payload #>> '{meta,statement_from}')::date;
  v_to := (p_payload #>> '{meta,statement_to}')::date;
  select last_statement_date into v_prev_stmt from public.broker_connections where id = v_conn;

  -- positions: the snapshot of the report date is replaced; matching and valuation state of the same conid is carried over
  select coalesce(jsonb_agg(to_jsonb(q)), '[]'::jsonb) into v_prev from (
    select distinct on (conid) conid, security_id, signal_security_id, match_status, valuation_tag, valuation_session_date, valuation_reason
      from public.broker_positions where user_id = v_user order by conid, report_date desc) q;
  delete from public.broker_positions where user_id = v_user and report_date = v_report;
  insert into public.broker_positions
    (user_id, report_date, conid, isin, symbol, description, asset_class, sub_category, listing_exchange, currency, fx_rate_to_base, quantity, multiplier,
     mark_price, position_value, open_price, cost_basis_price, cost_basis_money, fifo_pnl_unrealized, percent_of_nav, level_of_detail, open_date_time,
     security_id, signal_security_id, match_status, valuation_tag, valuation_session_date, valuation_reason)
  select v_user, v_report, x.conid, x.isin, x.symbol, x.description, x.asset_class, x.sub_category, x.listing_exchange, x.currency, x.fx_rate_to_base,
         x.quantity, coalesce(x.multiplier, 1), x.mark_price, x.position_value, x.open_price, x.cost_basis_price, x.cost_basis_money,
         x.fifo_pnl_unrealized, x.percent_of_nav, coalesce(x.level_of_detail, 'SUMMARY'), x.open_date_time,
         pm.security_id, pm.signal_security_id, coalesce(pm.match_status, 'unmatched'), pm.valuation_tag, pm.valuation_session_date, pm.valuation_reason
    from jsonb_to_recordset(p_payload -> 'positions') as x(
           conid bigint, isin text, symbol text, description text, asset_class text, sub_category text, listing_exchange text, currency text,
           fx_rate_to_base numeric, quantity numeric, multiplier numeric, mark_price numeric, position_value numeric, open_price numeric,
           cost_basis_price numeric, cost_basis_money numeric, fifo_pnl_unrealized numeric, percent_of_nav numeric, level_of_detail text,
           open_date_time timestamptz)
    left join jsonb_to_recordset(v_prev) as pm(
           conid bigint, security_id uuid, signal_security_id uuid, match_status text, valuation_tag text, valuation_session_date date, valuation_reason text)
      on pm.conid = x.conid
  on conflict do nothing;
  get diagnostics n_pos = row_count;

  -- executions: later statements may refine the P/L fields (Flex errors 1006-1008: P/L can lag), identity fields never change
  insert into public.broker_trades as t
    (user_id, trade_id, ib_exec_id, ib_order_id, conid, isin, symbol, description, listing_exchange, exchange, currency, fx_rate_to_base, trade_date, trade_time,
     settle_date, buy_sell, quantity, trade_price, trade_money, proceeds, taxes, ib_commission, ib_commission_currency, net_cash, cost_basis, fifo_pnl_realized,
     open_close, order_type, report_date)
  select v_user, x.trade_id, x.ib_exec_id, x.ib_order_id, x.conid, x.isin, x.symbol, x.description, x.listing_exchange, x.exchange, x.currency,
         x.fx_rate_to_base, x.trade_date, x.trade_time, x.settle_date, x.buy_sell, x.quantity, x.trade_price, x.trade_money, x.proceeds, x.taxes,
         x.ib_commission, x.ib_commission_currency, x.net_cash, x.cost_basis, x.fifo_pnl_realized, x.open_close, x.order_type, x.report_date
    from jsonb_to_recordset(p_payload -> 'trades') as x(
           trade_id text, ib_exec_id text, ib_order_id text, conid bigint, isin text, symbol text, description text, listing_exchange text, exchange text,
           currency text, fx_rate_to_base numeric, trade_date date, trade_time time, settle_date date, buy_sell text, quantity numeric, trade_price numeric,
           trade_money numeric, proceeds numeric, taxes numeric, ib_commission numeric, ib_commission_currency text, net_cash numeric, cost_basis numeric,
           fifo_pnl_realized numeric, open_close text, order_type text, report_date date)
  on conflict (user_id, ib_exec_id) do update set
    fx_rate_to_base = excluded.fx_rate_to_base, ib_commission = excluded.ib_commission, net_cash = excluded.net_cash, cost_basis = excluded.cost_basis,
    fifo_pnl_realized = excluded.fifo_pnl_realized, report_date = excluded.report_date,
    listing_exchange = coalesce(excluded.listing_exchange, t.listing_exchange);
  get diagnostics n_trd = row_count;

  insert into public.broker_closed_lots
    (user_id, conid, symbol, currency, fx_rate_to_base, open_date_time, close_date, closing_trade_id, quantity, cost_basis, proceeds, fifo_pnl_realized, dedupe_hash)
  select v_user, x.conid, x.symbol, x.currency, x.fx_rate_to_base, x.open_date_time, x.close_date, x.closing_trade_id, x.quantity, x.cost_basis, x.proceeds,
         x.fifo_pnl_realized, x.dedupe_hash
    from jsonb_to_recordset(p_payload -> 'closed_lots') as x(
           conid bigint, symbol text, currency text, fx_rate_to_base numeric, open_date_time timestamptz, close_date date, closing_trade_id text,
           quantity numeric, cost_basis numeric, proceeds numeric, fifo_pnl_realized numeric, dedupe_hash text)
  on conflict (user_id, dedupe_hash) do update set
    fx_rate_to_base = excluded.fx_rate_to_base, proceeds = excluded.proceeds, fifo_pnl_realized = excluded.fifo_pnl_realized;
  get diagnostics n_lot = row_count;

  insert into public.broker_cash_transactions
    (user_id, occurred_at, report_date, currency, fx_rate_to_base, amount, type_raw, category, conid, isin, symbol, description, trade_id, code, dedupe_hash)
  select v_user, x.occurred_at, x.report_date, x.currency, x.fx_rate_to_base, x.amount, x.type_raw, x.category, x.conid, x.isin, x.symbol, x.description,
         x.trade_id, x.code, x.dedupe_hash
    from jsonb_to_recordset(p_payload -> 'cash') as x(
           occurred_at timestamptz, report_date date, currency text, fx_rate_to_base numeric, amount numeric, type_raw text, category text, conid bigint,
           isin text, symbol text, description text, trade_id text, code text, dedupe_hash text)
  on conflict (user_id, dedupe_hash) do nothing;
  get diagnostics n_cash = row_count;

  insert into public.broker_fx_rates (user_id, rate_date, from_ccy, to_ccy, rate)
  select v_user, x.rate_date, x.from_ccy, x.to_ccy, x.rate
    from jsonb_to_recordset(p_payload -> 'fx') as x(rate_date date, from_ccy text, to_ccy text, rate numeric)
  on conflict (user_id, rate_date, from_ccy, to_ccy) do update set rate = excluded.rate;
  get diagnostics n_fx = row_count;

  insert into public.broker_nav (user_id, report_date, currency, cash, stock, other, total)
  select v_user, x.report_date, x.currency, x.cash, x.stock, x.other, x.total
    from jsonb_to_recordset(p_payload -> 'nav') as x(report_date date, currency text, cash numeric, stock numeric, other numeric, total numeric)
  on conflict (user_id, report_date) do update set currency = excluded.currency, cash = excluded.cash, stock = excluded.stock, other = excluded.other, total = excluded.total;
  get diagnostics n_nav = row_count;

  insert into public.broker_corporate_actions (user_id, kind, occurred_at, conid, symbol, type_raw, quantity, amount, currency, code, dedupe_hash)
  select v_user, x.kind, x.occurred_at, x.conid, x.symbol, x.type_raw, x.quantity, x.amount, x.currency, x.code, x.dedupe_hash
    from jsonb_to_recordset(p_payload -> 'corporate_actions') as x(
           kind text, occurred_at timestamptz, conid bigint, symbol text, type_raw text, quantity numeric, amount numeric, currency text, code text, dedupe_hash text)
  on conflict (user_id, dedupe_hash) do nothing;
  get diagnostics n_corp = row_count;

  update public.broker_connections set
    last_sync_at = now(),
    last_statement_date = greatest(coalesce(last_statement_date, v_to), v_to),
    coverage_from = least(coalesce(coverage_from, v_from), v_from),
    base_currency = coalesce(nullif(p_payload #>> '{meta,base_currency}', ''), base_currency),
    account_id_masked = coalesce(nullif(p_payload #>> '{meta,account_id_masked}', ''), account_id_masked),
    account_type = coalesce(nullif(p_payload #>> '{meta,account_type}', ''), account_type),
    next_flex_fetch_not_before = case when v_prev_stmt is not null and v_to <= v_prev_stmt then now() + interval '6 hours' else null end,
    last_error_code = null, last_error_message = null, last_error_at = null
   where id = v_conn;

  update public.broker_sync_runs set
    rows_summary = coalesce(rows_summary, '{}'::jsonb) || jsonb_build_object(
      'positions', n_pos, 'trades', n_trd, 'closed_lots', n_lot, 'cash', n_cash, 'fx', n_fx, 'nav', n_nav, 'corporate_actions', n_corp)
   where id = p_run_id;

  return jsonb_build_object('report_date', v_report, 'positions', n_pos, 'trades', n_trd, 'closed_lots', n_lot, 'cash', n_cash,
                            'fx', n_fx, 'nav', n_nav, 'corporate_actions', n_corp);
end $$;

-- ------------------------------------------------------------------ claim runs for the minute tick (leases, SKIP LOCKED)
create or replace function app.claim_broker_runs(p_limit int default 3, p_lease_seconds int default 150)
returns setof public.broker_sync_runs
language sql security definer set search_path = public, pg_temp as $$
  with c as (
    select r.id from public.broker_sync_runs r
     where r.state in ('queued', 'requested', 'polling', 'parsing')
       and coalesce(r.next_poll_at, now()) <= now()
       and (r.lease_until is null or r.lease_until < now())
     order by coalesce(r.next_poll_at, r.created_at)
     limit greatest(p_limit, 1)
     for update skip locked)
  update public.broker_sync_runs r set lease_until = now() + make_interval(secs => p_lease_seconds)
    from c where r.id = c.id
  returning r.*
$$;

-- atomic lease for an inline (user-triggered) advance
create or replace function app.lease_broker_run(p_run uuid, p_lease_seconds int default 150)
returns setof public.broker_sync_runs
language sql security definer set search_path = public, pg_temp as $$
  update public.broker_sync_runs r set lease_until = now() + make_interval(secs => p_lease_seconds)
   where r.id = p_run and r.state in ('queued', 'requested', 'polling', 'parsing') and (r.lease_until is null or r.lease_until < now())
  returning r.*
$$;

-- ------------------------------------------------------------------ manual refresh cooldown (60 s): ONE atomic UPDATE ... WHERE (spec 12.8)
create or replace function app.claim_manual_refresh(p_user uuid) returns table (claimed boolean, available_at timestamptz)
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_at timestamptz;
begin
  update public.broker_connections set last_manual_refresh_at = now()
   where user_id = p_user and status not in ('unlinked', 'linking')
     and (last_manual_refresh_at is null or last_manual_refresh_at <= now() - interval '60 seconds')
  returning last_manual_refresh_at into v_at;
  if found then
    return query select true, v_at + interval '60 seconds';
    return;
  end if;
  select c.last_manual_refresh_at + interval '60 seconds' into v_at from public.broker_connections c where c.user_id = p_user;
  return query select false, v_at;
end $$;

-- ------------------------------------------------------------------ manual Flex sync: one per 10 minutes, one active run
create or replace function app.enqueue_manual_sync(p_user uuid) returns table (run_id uuid, outcome text, retry_after_seconds int)
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_conn public.broker_connections; v_run uuid; v_last timestamptz; v_wait int;
begin
  perform pg_advisory_xact_lock(hashtextextended('broker_manual_sync:' || p_user::text, 0));
  select * into v_conn from public.broker_connections where user_id = p_user;
  if not found or v_conn.status <> 'linked' then
    return query select null::uuid, 'not_linked'::text, 0;
    return;
  end if;
  select r.id into v_run from public.broker_sync_runs r
   where r.user_id = p_user and r.state in ('queued', 'requested', 'polling', 'parsing') limit 1;
  if v_run is not null then
    return query select v_run, 'busy'::text, 0;
    return;
  end if;
  select max(r.created_at) into v_last from public.broker_sync_runs r where r.user_id = p_user and r.kind = 'manual';
  if v_last is not null and v_last > now() - interval '10 minutes' then
    v_wait := greatest(1, ceil(extract(epoch from (v_last + interval '10 minutes' - now())))::int);
    return query select null::uuid, 'cooldown'::text, v_wait;
    return;
  end if;
  insert into public.broker_sync_runs (user_id, connection_id, kind, state, statement_from, statement_to, idempotency_key)
  values (p_user, v_conn.id, 'manual', 'queued',
          case when v_conn.last_statement_date is null then null else v_conn.last_statement_date - 5 end,
          (now() at time zone 'Europe/Sofia')::date - 1,
          p_user::text || ':manual:' || gen_random_uuid()::text)
  returning id into v_run;
  return query select v_run, 'created'::text, 0;
end $$;

-- ------------------------------------------------------------------ Flex limiter: 1.1 s spacing and 10 calls per rolling 60 s per token hash
create or replace function app.flex_rl_take(p_key text) returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_now bigint := (extract(epoch from clock_timestamp()) * 1000)::bigint;
  v_row jsonb; v_recent bigint[]; v_wait int := 0;
begin
  if p_key is null or p_key !~ '^flexrl:[0-9a-zA-Z_-]{1,64}$' then
    raise exception 'invalid limiter key' using errcode = '22023';
  end if;
  insert into public.quote_cache (key, payload, provider, expires_at)
  values (p_key, '{"calls":[]}'::jsonb, 'flex', now() + interval '1 hour')
  on conflict (key) do nothing;
  select payload into v_row from public.quote_cache where key = p_key for update;
  select coalesce(array_agg(t.ms order by t.ms), '{}'::bigint[]) into v_recent
    from (select x::bigint as ms from jsonb_array_elements_text(coalesce(v_row -> 'calls', '[]'::jsonb)) x) t
   where t.ms > v_now - 60000;
  if cardinality(v_recent) > 0 and v_now - v_recent[cardinality(v_recent)] < 1100 then
    v_wait := (v_recent[cardinality(v_recent)] + 1100 - v_now)::int;
  elsif cardinality(v_recent) >= 10 then
    v_wait := (v_recent[1] + 60000 - v_now)::int + 50;
  end if;
  if v_wait > 0 then
    update public.quote_cache set payload = jsonb_build_object('calls', to_jsonb(v_recent)), expires_at = now() + interval '1 hour' where key = p_key;
    return v_wait;
  end if;
  v_recent := v_recent || v_now;
  update public.quote_cache set payload = jsonb_build_object('calls', to_jsonb(v_recent)), expires_at = now() + interval '1 hour' where key = p_key;
  return 0;
end $$;

-- ------------------------------------------------------------------ holding tags (portfolio_scan writes them for every holder of the security)
create or replace function app.apply_holding_tag(p_security uuid, p_tag text, p_session date, p_reason text) returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare n int;
begin
  if p_tag not in ('discounted', 'premium', 'extra_premium', 'unavailable', 'none') then
    raise exception 'invalid valuation tag %', p_tag using errcode = '22023';
  end if;
  update public.broker_positions p
     set valuation_tag = p_tag, valuation_session_date = p_session, valuation_reason = p_reason
   where p.signal_security_id = p_security
     and p.report_date = (select max(m.report_date) from public.broker_positions m where m.user_id = p.user_id);
  get diagnostics n = row_count;
  return n;
end $$;

-- distinct signal securities of the latest snapshot of every user (portfolio_scan seeds its jobs from this)
create or replace function app.held_signal_securities() returns table (security_id uuid)
language sql stable security definer set search_path = public, pg_temp as $$
  select distinct p.signal_security_id
    from public.broker_positions p
   where p.signal_security_id is not null and p.quantity <> 0
     and p.report_date = (select max(m.report_date) from public.broker_positions m where m.user_id = p.user_id)
$$;

-- ------------------------------------------------------------------ daily seeding (08:00 Europe/Sofia, A-33) and the broker tick
create or replace function app.kick_broker_sync() returns void
language plpgsql security definer set search_path = public, app, vault, net as $$
declare v_url text; v_secret text; v_hdr jsonb;
begin
  if not exists (select 1 from public.broker_sync_runs r
                  where r.state in ('queued', 'requested', 'polling', 'parsing') and coalesce(r.next_poll_at, now()) <= now()
                    and (r.lease_until is null or r.lease_until < now())) then
    return;
  end if;
  select decrypted_secret into v_url    from vault.decrypted_secrets where name = 'project_url';
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'worker_tick_secret';
  if v_url is null or v_secret is null then return; end if;
  v_hdr := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', v_secret);
  perform net.http_post(url := v_url || '/functions/v1/broker-sync', headers := v_hdr, body := '{"action":"tick"}'::jsonb, timeout_milliseconds := 145000);
end $$;

create or replace function app.start_daily_broker_syncs(p_now timestamptz default now(), p_force boolean default false) returns int
language plpgsql security definer set search_path = public, app as $$
declare v_date date := (p_now at time zone 'Europe/Sofia')::date; v_n int;
begin
  -- DST-safe guard (same idea as 7.2): of the 05:00 and 06:00 UTC firings exactly one is 08:00 in Sofia
  if not p_force and extract(hour from (p_now at time zone 'Europe/Sofia')) <> 8 then
    return 0;
  end if;
  with ins as (
    insert into public.broker_sync_runs (user_id, connection_id, kind, state, statement_from, statement_to, idempotency_key)
    select c.user_id, c.id, 'daily', 'queued',
           case when c.last_statement_date is null then null else c.last_statement_date - 5 end,
           v_date - 1,
           c.user_id::text || ':daily:' || v_date::text
      from public.broker_connections c
     where c.status = 'linked' and (c.next_flex_fetch_not_before is null or c.next_flex_fetch_not_before <= p_now)
    on conflict do nothing
    returning 1)
  select count(*)::int into v_n from ins;
  if v_n > 0 then perform app.kick_broker_sync(); end if;
  return v_n;
end $$;

-- ------------------------------------------------------------------ grants on app functions: service role only
revoke all on function app.broker_ingest_statement(uuid, jsonb), app.claim_broker_runs(int, int), app.lease_broker_run(uuid, int),
  app.claim_manual_refresh(uuid), app.enqueue_manual_sync(uuid), app.flex_rl_take(text), app.apply_holding_tag(uuid, text, date, text),
  app.kick_broker_sync(), app.start_daily_broker_syncs(timestamptz, boolean), app.held_signal_securities() from public, anon, authenticated;
grant execute on function app.broker_ingest_statement(uuid, jsonb), app.claim_broker_runs(int, int), app.lease_broker_run(uuid, int),
  app.claim_manual_refresh(uuid), app.enqueue_manual_sync(uuid), app.flex_rl_take(text), app.apply_holding_tag(uuid, text, date, text),
  app.kick_broker_sync(), app.start_daily_broker_syncs(timestamptz, boolean), app.held_signal_securities() to service_role;

-- ------------------------------------------------------------------ cron entries (idempotent: unschedule by name first)
do $$
declare j bigint;
begin
  for j in select jobid from cron.job where jobname in ('broker-daily-0500', 'broker-daily-0600', 'broker-tick') loop
    perform cron.unschedule(j);
  end loop;
end $$;
select cron.schedule('broker-daily-0500', '0 5 * * *', 'select app.start_daily_broker_syncs();');
select cron.schedule('broker-daily-0600', '0 6 * * *', 'select app.start_daily_broker_syncs();');
select cron.schedule('broker-tick', '* * * * *', 'select app.kick_broker_sync();');
```

- [ ] **Step 5: Apply the migration and run the tests**

Run: `bun run supabase:reset` then `bun run test:db`
Expected: `0500_broker_schema.test.sql` and every earlier file report `ok`; the summary line ends with `Result: PASS`. Typical failures and the fix: `permission denied for schema app` in a `lives_ok` means the test ran under the wrong role (the `set local role` lines must come after the service-level assertions); a `plan` mismatch means the plan number was computed before the last edit (recompute with the PowerShell line of Step 3); `type "broker_status" already exists` cannot happen (guarded) but `relation "broker_connections" already exists` means another migration created the table: reconcile columns against section 6.3.6 and keep one definition.

- [ ] **Step 6: Commit**

```text
git add supabase/migrations/20261015005000_broker_schema.sql supabase/tests/0500_broker_schema.test.sql
git commit -m "feat(db): add broker tables, hidden token columns, ingest, cooldown and limiter functions, daily broker cron"
```

---

## Task 2: Adapters (`crypto`, `flex`, `flex-parse`, `user-auth`), Flex error table, fixture and function scaffolds

**Concurrency:** may run at the same time as Tasks 1 and 3 (disjoint files). `config.toml` and `.env.example` are edited only here.

**Files:**
- Create: `supabase/functions/_shared/core/flex-errors.ts`, `supabase/functions/_shared/core/flex-errors.test.ts`
- Create: `supabase/functions/_shared/adapters/crypto.ts`, `crypto.test.ts`, `user-auth.ts`, `user-auth.test.ts`, `cash-types.ts`, `cash-types.test.ts`, `flex.ts`, `flex.test.ts`, `flex-parse.ts`, `flex-parse.test.ts`
- Create: `supabase/functions/_shared/adapters/fixtures/flex/activity-sample.xml`
- Create (scaffolds, via `tools/new-function.ts`): `supabase/functions/broker-sync/{deno.json,index.ts}`, `supabase/functions/portfolio-refresh/{deno.json,index.ts}`
- Modify: `supabase/config.toml`, `supabase/functions/.env.example`

**Interfaces:**
- Consumes: P0 `adapters/http.ts` (`json`), `@std/assert`.
- Produces: `FLEX_ERRORS`, `flexErrorInfo(code)`, `classifyFlexCode(code, unknownAttempts)`, `POLL_DELAYS_S`, `MAX_POLLS`, `SEND_RETRY_LIMIT` (core); `Sealed`, `CryptoError`, `encryptSecret`, `decryptSecret`, `loadKey`, `seal`, `open`, `currentKeyVersion`, `toBytea`, `fromBytea` (crypto); `UserVerifier`, `authenticate`, `createClaimsVerifier` (user-auth); `createFlexClient`, `createRpcLimiter`, `tokenKey`, `FlexLimiterError`, `SendResult`, `StatementResult`, `FlexPeriod` (flex); `parseFlexStatement`, `requiredSectionReport`, `parseDecimal`, `parseFlexDate`, `FlexStatement` and row types (flex-parse); `categorizeCashType` (cash-types).

- [ ] **Step 1: Scaffold the two functions, register them, document the secrets**

Run:

```powershell
bun run tools/new-function.ts broker-sync
bun run tools/new-function.ts portfolio-refresh
```

Expected: `function broker-sync: ready` and `function portfolio-refresh: ready` (each creates the canonical `deno.json` and a 501 placeholder `index.ts`; Tasks 4 and 5 replace the placeholders).

Append to `supabase/config.toml` below the existing `[functions.retention-cleanup]` block (both functions authenticate in code: the user JWT through `getClaims()`, the worker through `x-cron-secret`):

```toml
[functions.broker-sync]
verify_jwt = false

[functions.portfolio-refresh]
verify_jwt = false
```

Append to `supabase/functions/.env.example` (names only; `FLEX_ENC_KEY_V1` must be a base64 string of exactly 32 random bytes, `FLEX_FIXTURE_MODE` stays empty everywhere except the local integration run):

```text
# P5b Flex
FLEX_ENC_KEY_V1=
FLEX_ENC_KEY_CURRENT=1
FLEX_USER_AGENT=PersonalStockScreener/1.0
FLEX_FIXTURE_MODE=
```

Run: `bun run check:functions-config`
Expected: exit 0 (both functions have the canonical `deno.json`, an `index.ts` and a `verify_jwt = false` block).

Generate a local key into `supabase/functions/.env` (git-ignored) with PowerShell:

```powershell
$key = [Convert]::ToBase64String([System.Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
Add-Content supabase/functions/.env "FLEX_ENC_KEY_V1=$key"
Add-Content supabase/functions/.env "FLEX_ENC_KEY_CURRENT=1"
Add-Content supabase/functions/.env "FLEX_USER_AGENT=PersonalStockScreener/1.0"
```

- [ ] **Step 2: Write the failing Flex error table test (core, Vitest)**

`supabase/functions/_shared/core/flex-errors.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  FLEX_ERRORS,
  MAX_POLLS,
  POLL_DELAYS_S,
  SEND_RETRY_LIMIT,
  UNKNOWN_CODE_RETRIES,
  classifyFlexCode,
  flexErrorInfo,
} from "./flex-errors.ts";

describe("Flex error table (spec 12.4)", () => {
  it("covers 1001 and 1003 to 1021 and nothing else", () => {
    const codes = Object.keys(FLEX_ERRORS).map(Number).sort((a, b) => a - b);
    expect(codes).toEqual([1001, ...Array.from({ length: 19 }, (_, i) => 1003 + i)]);
  });

  it("retryable codes are exactly 1001, 1004-1009, 1018, 1019, 1021", () => {
    const retry = Object.values(FLEX_ERRORS).filter((e) => e.cls === "retry").map((e) => e.code);
    expect(retry.sort((a, b) => a - b)).toEqual([1001, 1004, 1005, 1006, 1007, 1008, 1009, 1018, 1019, 1021]);
  });

  it("fatal codes are exactly 1003, 1010-1011, 1013-1017, 1020 and 1012 is the expired class", () => {
    const fatal = Object.values(FLEX_ERRORS).filter((e) => e.cls === "fatal").map((e) => e.code);
    expect(fatal.sort((a, b) => a - b)).toEqual([1003, 1010, 1011, 1013, 1014, 1015, 1016, 1017, 1020]);
    expect(FLEX_ERRORS[1012]?.cls).toBe("expired");
    expect(FLEX_ERRORS[1012]?.connection).toBe("expired");
  });

  it("1018 never counts as a poll and waits 60 s; 1009 waits 60 s", () => {
    expect(FLEX_ERRORS[1018]).toMatchObject({ countsAsPoll: false, retryAfterSeconds: 60 });
    expect(FLEX_ERRORS[1009]?.retryAfterSeconds).toBe(60);
    expect(FLEX_ERRORS[1019]).toMatchObject({ countsAsPoll: true });
  });

  it("credential and query problems put the connection in error, 1017 and 1003 do not", () => {
    for (const code of [1010, 1011, 1013, 1014, 1015, 1016]) expect(FLEX_ERRORS[code]?.connection).toBe("error");
    expect(FLEX_ERRORS[1017]?.connection).toBeNull();
    expect(FLEX_ERRORS[1003]?.connection).toBeNull();
  });

  it("every entry has a message and a troubleshooting hint without the token placeholder", () => {
    for (const info of Object.values(FLEX_ERRORS)) {
      expect(info.message.length).toBeGreaterThan(10);
      expect(info.hint.length).toBeGreaterThan(10);
      expect(`${info.message} ${info.hint}`).not.toMatch(/\{token\}/i);
    }
  });

  it("unknown codes are retried twice and then fatal", () => {
    expect(UNKNOWN_CODE_RETRIES).toBe(2);
    expect(classifyFlexCode(1999, 0)).toBe("retry");
    expect(classifyFlexCode(1999, 1)).toBe("retry");
    expect(classifyFlexCode(1999, 2)).toBe("fatal");
    expect(classifyFlexCode(1019, 50)).toBe("retry");
    expect(classifyFlexCode(1012, 0)).toBe("expired");
  });

  it("internal codes: transport is retryable, the others are fatal", () => {
    expect(flexErrorInfo(0).cls).toBe("retry");
    for (const code of [-1, -2, -3, -4, -5, -6, -7]) expect(flexErrorInfo(code).cls).toBe("fatal");
    expect(flexErrorInfo(-2).message).toMatch(/cannot be decrypted/i);
    expect(flexErrorInfo(-3).message).toMatch(/different account/i);
  });

  it("the poll budget is ten polls and ten minutes", () => {
    expect(MAX_POLLS).toBe(10);
    expect(POLL_DELAYS_S).toHaveLength(10);
    expect(POLL_DELAYS_S.reduce((a, b) => a + b, 0)).toBe(600);
    expect(Math.min(...POLL_DELAYS_S)).toBeGreaterThanOrEqual(15);
    expect(SEND_RETRY_LIMIT).toBe(5);
  });
});
```

Run: `bun run test:core flex-errors`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `core/flex-errors.ts`**

`supabase/functions/_shared/core/flex-errors.ts`:

```ts
// Flex Web Service error codes (spec 12.4, research flex 2.3) with their handling class and user-facing text.
// Pure data: shared by broker-sync (state machine) and the SPA (troubleshooting hints).

export type FlexErrorClass = "retry" | "fatal" | "expired";
export type ConnectionImpact = "error" | "expired" | null;

export interface FlexErrorInfo {
  code: number;
  ibkrText: string;
  cls: FlexErrorClass;
  /** Seconds to wait before the next attempt (retry class only). */
  retryAfterSeconds: number | null;
  /** A retry of this code consumes one poll of the budget (1018 does not). */
  countsAsPoll: boolean;
  connection: ConnectionImpact;
  message: string;
  hint: string;
}

const AUTO = "Nothing to do: the app retries automatically for up to 10 minutes.";

function entry(
  code: number,
  ibkrText: string,
  cls: FlexErrorClass,
  message: string,
  hint: string,
  o: { retryAfterSeconds?: number; countsAsPoll?: boolean; connection?: ConnectionImpact } = {},
): FlexErrorInfo {
  return {
    code,
    ibkrText,
    cls,
    retryAfterSeconds: cls === "retry" ? (o.retryAfterSeconds ?? 20) : null,
    countsAsPoll: cls === "retry" ? (o.countsAsPoll ?? true) : false,
    connection: o.connection ?? null,
    message,
    hint,
  };
}

const LIST: FlexErrorInfo[] = [
  entry(1001, "Statement could not be generated at this time. Please try again shortly.", "retry", "IBKR could not generate the statement yet.", AUTO),
  entry(1003, "Statement is not available.", "fatal", "IBKR has no statement for the requested dates.", "Press Sync now again tomorrow. If it persists, check the period of your Flex query and that the account is included."),
  entry(1004, "Statement is incomplete at this time. Please try again shortly.", "retry", "The statement is still being completed by IBKR.", AUTO),
  entry(1005, "Settlement data is not ready at this time. Please try again shortly.", "retry", "IBKR settlement data is not ready yet.", AUTO),
  entry(1006, "FIFO P/L data is not ready at this time. Please try again shortly.", "retry", "IBKR FIFO profit and loss data is not ready yet.", AUTO, { retryAfterSeconds: 30 }),
  entry(1007, "MTM P/L data is not ready at this time. Please try again shortly.", "retry", "IBKR mark-to-market profit and loss data is not ready yet.", AUTO, { retryAfterSeconds: 30 }),
  entry(1008, "MTM and FIFO P/L data is not ready at this time. Please try again shortly.", "retry", "IBKR profit and loss data is not ready yet.", AUTO, { retryAfterSeconds: 30 }),
  entry(1009, "The server is under heavy load. Statement could not be generated at this time. Please try again shortly.", "retry", "The IBKR service is under heavy load.", AUTO, { retryAfterSeconds: 60 }),
  entry(1010, "Legacy Flex Queries are no longer supported. Please convert over to Activity Flex.", "fatal", "The query is a legacy Flex Query.", "Create an Activity Flex Query (Client Portal, Reporting, Flex Queries, Activity Flex Query) and use its Query ID.", { connection: "error" }),
  entry(1011, "Service account is inactive.", "fatal", "IBKR reports the Flex service account as inactive.", "Open Flex Web Service Configuration in the Client Portal and check that Flex Web Service Status is ticked; contact IBKR if it stays inactive.", { connection: "error" }),
  entry(1012, "Token has expired.", "expired", "The Flex token has expired.", "Generate a new token in Client Portal, Flex Web Service Configuration, then link again with the new token.", { connection: "expired" }),
  entry(1013, "IP restriction.", "fatal", "IBKR rejected the request because of the token's IP restriction.", "Remove the IP restriction from the token (this app calls Flex from changing Supabase addresses) or generate a new token without one.", { connection: "error" }),
  entry(1014, "Query is invalid.", "fatal", "IBKR does not recognise the Query ID.", "Check the Query ID (the number shown at the top of the query's information panel) and that it is an Activity Flex Query.", { connection: "error" }),
  entry(1015, "Token is invalid.", "fatal", "IBKR does not recognise the token.", "Copy the Current Token again from Flex Web Service Configuration and link again; a regenerated token invalidates the old one.", { connection: "error" }),
  entry(1016, "Account in invalid.", "fatal", "IBKR reports a problem with the account.", "Check that the account in the Flex query is active and selected in the query's delivery configuration.", { connection: "error" }),
  entry(1017, "Reference code is invalid.", "fatal", "IBKR no longer knows this statement request.", "The app starts one new request automatically; if it fails again press Sync now."),
  entry(1018, "Too many requests have been made from this token. Please try again shortly. Limited to one request per second, 10 requests per minute (per token).", "retry", "IBKR limits one token to 1 request per second and 10 per minute.", "The app waits a minute and tries again. Avoid using the same token in other tools at the same time.", { retryAfterSeconds: 60, countsAsPoll: false }),
  entry(1019, "Statement generation in progress. Please try again shortly.", "retry", "IBKR is still generating the statement.", AUTO),
  entry(1020, "Invalid request or unable to validate request.", "fatal", "IBKR rejected the request.", "Check the Query ID and the token for typing errors; if both are right, report this error code to the operator."),
  entry(1021, "Statement could not be retrieved at this time. Please try again shortly.", "retry", "IBKR could not deliver the statement yet.", AUTO),
];

export const FLEX_ERRORS: Readonly<Record<number, FlexErrorInfo>> = Object.fromEntries(LIST.map((e) => [e.code, e]));

/** Codes below 1000 are produced by this app, never by IBKR. */
const INTERNAL: Readonly<Record<number, FlexErrorInfo>> = Object.fromEntries(
  [
    entry(0, "(transport)", "retry", "The IBKR Flex service could not be reached.", AUTO, { retryAfterSeconds: 30 }),
    entry(-1, "(parse)", "fatal", "The statement could not be read.", "Open the Flex query and check that the format is XML, the date format is yyyyMMdd and every required section and field of the setup list is selected."),
    entry(-2, "(key)", "fatal", "The stored token cannot be decrypted with the current server key.", "Link again: enter the token once more so it is stored under the current key.", { connection: "error" }),
    entry(-3, "(account)", "fatal", "The statement belongs to a different account than the one linked.", "Unlink and link again if you switched accounts on purpose; otherwise check the Query ID.", { connection: "error" }),
    entry(-4, "(poll limit)", "fatal", "IBKR did not deliver the statement within 10 minutes.", "Press Sync now later; large queries can take longer on busy days."),
    entry(-5, "(send limit)", "fatal", "IBKR kept refusing the statement request.", "Press Sync now later."),
    entry(-6, "(sections)", "fatal", "The statement is missing required sections or fields.", "Open the Flex query and select every section and field of the setup list, then press Test connection.", { connection: "error" }),
    entry(-7, "(internal)", "fatal", "An internal error stopped the sync.", "Press Sync now again; if it repeats, report the time to the operator."),
  ].map((e) => [e.code, e]),
);

export const UNKNOWN_CODE_RETRIES = 2;

/** Poll budget: 10 polls, 15 s minimum spacing, 10 minutes in total (spec 12.4). */
export const POLL_DELAYS_S: readonly number[] = [15, 20, 30, 45, 60, 60, 90, 90, 100, 90];
export const MAX_POLLS = 10;
export const SEND_RETRY_LIMIT = 5;

export function flexErrorInfo(code: number): FlexErrorInfo {
  const known = FLEX_ERRORS[code] ?? INTERNAL[code];
  if (known !== undefined) return known;
  return entry(
    code,
    "(unknown)",
    "retry",
    `IBKR returned an unknown error code (${code}).`,
    "The app retries twice and then stops; report the code to the operator if it repeats.",
  );
}

/** Unknown codes are retryable twice, then fatal (`unknownAttempts` = how many unknown codes this run has seen before this one). */
export function classifyFlexCode(code: number, unknownAttempts: number): FlexErrorClass {
  const known = FLEX_ERRORS[code] ?? INTERNAL[code];
  if (known !== undefined) return known.cls;
  return unknownAttempts < UNKNOWN_CODE_RETRIES ? "retry" : "fatal";
}
```

Run: `bun run test:core flex-errors`
Expected: PASS (9 tests).

- [ ] **Step 4: Write the failing crypto tests (Deno)**

`supabase/functions/_shared/adapters/crypto.test.ts`:

```ts
import { assert, assertEquals, assertNotEquals, assertRejects } from "@std/assert";
import {
  CryptoError,
  aadFor,
  currentKeyVersion,
  decryptSecret,
  encryptSecret,
  fromBytea,
  importKey,
  loadKey,
  open,
  seal,
  toBytea,
} from "./crypto.ts";

const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const randomKey = () => b64(crypto.getRandomValues(new Uint8Array(32)));
const env = (vars: Record<string, string>) => ({ get: (name: string) => vars[name] });
const ctx = { userId: "user-1", connectionId: "conn-1" };

Deno.test("roundtrip: decrypt returns the plain token, the IV is 12 random bytes, the ciphertext hides the token", async () => {
  const key = await importKey(randomKey());
  const a = await encryptSecret("1234567890123456789", key, 1);
  const b = await encryptSecret("1234567890123456789", key, 1);
  assertEquals(a.iv.length, 12);
  assertNotEquals(Array.from(a.iv), Array.from(b.iv));
  assertNotEquals(Array.from(a.ciphertext), Array.from(b.ciphertext));
  assert(!new TextDecoder().decode(a.ciphertext).includes("1234567890"));
  assertEquals(await decryptSecret(a, key, 1), "1234567890123456789");
});

Deno.test("a wrong key fails authentication", async () => {
  const sealed = await encryptSecret("secret", await importKey(randomKey()), 1);
  const other = await importKey(randomKey());
  const err = await assertRejects(() => decryptSecret(sealed, other, 1), CryptoError);
  assertEquals((err as CryptoError).code, "decrypt_failed");
});

Deno.test("a tampered ciphertext, a truncated ciphertext and a tampered IV are detected", async () => {
  const key = await importKey(randomKey());
  const sealed = await encryptSecret("secret", key, 1);
  const flipped = { ...sealed, ciphertext: sealed.ciphertext.map((x, i) => (i === 0 ? x ^ 1 : x)) };
  const short = { ...sealed, ciphertext: sealed.ciphertext.slice(0, sealed.ciphertext.length - 1) };
  const iv = { ...sealed, iv: sealed.iv.map((x, i) => (i === 0 ? x ^ 1 : x)) };
  for (const bad of [flipped, short, iv]) {
    const err = await assertRejects(() => decryptSecret(bad, key, 1), CryptoError);
    assertEquals((err as CryptoError).code, "decrypt_failed");
  }
});

Deno.test("a version mismatch is rejected before the key is used (rotated key)", async () => {
  const key2 = await importKey(randomKey());
  const sealed = await encryptSecret("secret", await importKey(randomKey()), 1);
  const err = await assertRejects(() => decryptSecret(sealed, key2, 2), CryptoError);
  assertEquals((err as CryptoError).code, "version_mismatch");
});

Deno.test("additional authenticated data binds the ciphertext to its row", async () => {
  const key = await importKey(randomKey());
  const sealed = await encryptSecret("secret", key, 1, aadFor(ctx, 1));
  assertEquals(await decryptSecret(sealed, key, 1, aadFor(ctx, 1)), "secret");
  const err = await assertRejects(() => decryptSecret(sealed, key, 1, aadFor({ ...ctx, connectionId: "conn-2" }, 1)), CryptoError);
  assertEquals((err as CryptoError).code, "decrypt_failed");
});

Deno.test("keys must be base64 of exactly 32 bytes", async () => {
  for (const bad of ["", "not base64!!", b64(new Uint8Array(16)), b64(new Uint8Array(33))]) {
    const err = await assertRejects(() => importKey(bad), CryptoError);
    assertEquals((err as CryptoError).code, "bad_key");
  }
});

Deno.test("loadKey reads FLEX_ENC_KEY_V<n> and reports a retired key as key_missing", async () => {
  const e = env({ FLEX_ENC_KEY_V2: randomKey() });
  await loadKey(2, e);
  const err = await assertRejects(() => loadKey(1, e), CryptoError);
  assertEquals((err as CryptoError).code, "key_missing");
  assertEquals((err as CryptoError).message.includes("FLEX_ENC_KEY_V1"), true);
});

Deno.test("currentKeyVersion defaults to 1 and rejects nonsense", () => {
  assertEquals(currentKeyVersion(env({})), 1);
  assertEquals(currentKeyVersion(env({ FLEX_ENC_KEY_CURRENT: "2" })), 2);
  for (const bad of ["0", "-1", "x", "1.5"]) {
    let threw = false;
    try {
      currentKeyVersion(env({ FLEX_ENC_KEY_CURRENT: bad }));
    } catch (e) {
      threw = e instanceof CryptoError;
    }
    assert(threw, bad);
  }
});

Deno.test("seal and open use the current key, the stored version and the row context; rotation re-encrypts", async () => {
  const k1 = randomKey();
  const k2 = randomKey();
  const sealedV1 = await seal("tok", ctx, env({ FLEX_ENC_KEY_V1: k1, FLEX_ENC_KEY_CURRENT: "1" }));
  assertEquals(sealedV1.version, 1);
  // both keys present: the stored version selects the key
  const both = env({ FLEX_ENC_KEY_V1: k1, FLEX_ENC_KEY_V2: k2, FLEX_ENC_KEY_CURRENT: "2" });
  assertEquals(await open(sealedV1, ctx, both), "tok");
  const sealedV2 = await seal(await open(sealedV1, ctx, both), ctx, both);
  assertEquals(sealedV2.version, 2);
  assertEquals(await open(sealedV2, ctx, both), "tok");
  // V1 retired: the old ciphertext can no longer be opened, the new one can
  const retired = env({ FLEX_ENC_KEY_V2: k2, FLEX_ENC_KEY_CURRENT: "2" });
  const err = await assertRejects(() => open(sealedV1, ctx, retired), CryptoError);
  assertEquals((err as CryptoError).code, "key_missing");
  assertEquals(await open(sealedV2, ctx, retired), "tok");
  // the ciphertext cannot be moved to another row
  await assertRejects(() => open(sealedV2, { ...ctx, userId: "user-2" }, retired), CryptoError);
});

Deno.test("bytea helpers roundtrip the PostgREST hex form", () => {
  const bytes = new Uint8Array([0, 1, 254, 255]);
  assertEquals(toBytea(bytes), "\\x0001feff");
  assertEquals(Array.from(fromBytea("\\x0001feff")), [0, 1, 254, 255]);
  assertEquals(Array.from(fromBytea("0001feff")), [0, 1, 254, 255]);
});
```

Run: `deno test -A --config supabase/functions/deno.json supabase/functions/_shared/adapters/crypto.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 5: Implement `crypto.ts`**

`supabase/functions/_shared/adapters/crypto.ts`:

```ts
// AES-GCM-256 for the Flex token (spec 6.7). WebCrypto only; the key lives in function secrets, never in the database.

export type CryptoErrorCode = "key_missing" | "bad_key" | "version_mismatch" | "decrypt_failed" | "bad_input";

export class CryptoError extends Error {
  constructor(readonly code: CryptoErrorCode, message: string) {
    super(message);
    this.name = "CryptoError";
  }
}

export interface Sealed {
  ciphertext: Uint8Array;
  iv: Uint8Array;
  version: number;
}

export interface EnvReader {
  get(name: string): string | undefined;
}

const IV_BYTES = 12;
const KEY_BYTES = 32;
const enc = new TextEncoder();
const dec = new TextDecoder();

export function keyEnvName(version: number): string {
  if (!Number.isInteger(version) || version < 1) throw new CryptoError("bad_input", "key version must be a positive integer");
  return `FLEX_ENC_KEY_V${version}`;
}

export function currentKeyVersion(env: EnvReader): number {
  const raw = env.get("FLEX_ENC_KEY_CURRENT");
  if (raw === undefined || raw.trim() === "") return 1;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new CryptoError("bad_input", "FLEX_ENC_KEY_CURRENT must be a positive integer");
  return n;
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64.trim());
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function importKey(base64Key: string): Promise<CryptoKey> {
  let raw: Uint8Array;
  try {
    raw = base64ToBytes(base64Key);
  } catch {
    throw new CryptoError("bad_key", "the encryption key is not valid base64");
  }
  if (raw.length !== KEY_BYTES) throw new CryptoError("bad_key", `the encryption key must be ${KEY_BYTES} bytes`);
  return await crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function loadKey(version: number, env: EnvReader): Promise<CryptoKey> {
  const name = keyEnvName(version);
  const value = env.get(name);
  if (value === undefined || value.trim() === "") throw new CryptoError("key_missing", `${name} is not set`);
  return await importKey(value);
}

/** AAD = `userId:connectionId:keyVersion`: a ciphertext copied to another row (or re-labelled with another version) fails to open. */
export function aadFor(ctx: { userId: string; connectionId: string }, version: number): string {
  return `${ctx.userId}:${ctx.connectionId}:${version}`;
}

export async function encryptSecret(plain: string, key: CryptoKey, version: number, aad = ""): Promise<Sealed> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode(aad) }, key, enc.encode(plain));
  return { ciphertext: new Uint8Array(ct), iv, version };
}

export async function decryptSecret(sealed: Sealed, key: CryptoKey, keyVersion: number, aad = ""): Promise<string> {
  if (sealed.version !== keyVersion) {
    throw new CryptoError("version_mismatch", `ciphertext was sealed with key version ${sealed.version}, not ${keyVersion}`);
  }
  if (sealed.iv.length !== IV_BYTES) throw new CryptoError("decrypt_failed", "ciphertext could not be authenticated");
  try {
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: sealed.iv, additionalData: enc.encode(aad) }, key, sealed.ciphertext);
    return dec.decode(pt);
  } catch {
    throw new CryptoError("decrypt_failed", "ciphertext could not be authenticated");
  }
}

/** Seal with the CURRENT key version (`FLEX_ENC_KEY_CURRENT`, default 1). */
export async function seal(plain: string, ctx: { userId: string; connectionId: string }, env: EnvReader): Promise<Sealed> {
  const version = currentKeyVersion(env);
  return await encryptSecret(plain, await loadKey(version, env), version, aadFor(ctx, version));
}

/** Open with the key of the STORED version; a retired key is `key_missing`, never a silent fallback. */
export async function open(sealed: Sealed, ctx: { userId: string; connectionId: string }, env: EnvReader): Promise<string> {
  const key = await loadKey(sealed.version, env);
  return await decryptSecret(sealed, key, sealed.version, aadFor(ctx, sealed.version));
}

/** PostgREST represents bytea as the hex string `\x0102`. */
export function toBytea(bytes: Uint8Array): string {
  return `\\x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export function fromBytea(value: string): Uint8Array {
  const hex = value.startsWith("\\x") ? value.slice(2) : value;
  if (hex.length % 2 !== 0 || /[^0-9a-fA-F]/.test(hex)) throw new CryptoError("bad_input", "invalid bytea value");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
```

Run: `deno test -A --config supabase/functions/deno.json supabase/functions/_shared/adapters/crypto.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 6: `user-auth.ts` (test first, then implementation)**

`supabase/functions/_shared/adapters/user-auth.test.ts`:

```ts
import { assertEquals } from "@std/assert";
import { authenticate, bearerToken, createClaimsVerifier } from "./user-auth.ts";

const req = (authorization?: string) =>
  new Request("https://x.test/fn", { headers: authorization === undefined ? {} : { authorization } });

Deno.test("bearerToken accepts a JWT-shaped bearer value only", () => {
  assertEquals(bearerToken(req("Bearer aaa.bbb.ccc")), "aaa.bbb.ccc");
  assertEquals(bearerToken(req("bearer aaa.bbb.ccc")), "aaa.bbb.ccc");
  assertEquals(bearerToken(req()), null);
  assertEquals(bearerToken(req("Basic abc")), null);
  assertEquals(bearerToken(req("Bearer a b")), null);
  assertEquals(bearerToken(req("Bearer ")), null);
});

Deno.test("authenticate returns 401 without a token or when the verifier rejects or throws", async () => {
  const reject = { verify: () => Promise.resolve(null) };
  const boom = { verify: () => Promise.reject(new Error("network")) };
  for (const [r, v] of [[req(), reject], [req("Bearer a.b.c"), reject], [req("Bearer a.b.c"), boom]] as const) {
    const out = await authenticate(r, v);
    assertEquals(out.ok, false);
    if (!out.ok) {
      assertEquals(out.response.status, 401);
      assertEquals(await out.response.json(), { error: "unauthorized" });
    }
  }
});

Deno.test("authenticate returns the verified user id", async () => {
  const out = await authenticate(req("Bearer a.b.c"), { verify: () => Promise.resolve({ userId: "u1" }) });
  assertEquals(out, { ok: true, userId: "u1" });
});

Deno.test("the claims verifier uses getClaims and requires an authenticated subject", async () => {
  const calls: string[] = [];
  const make = (claims: unknown, error: unknown = null) =>
    createClaimsVerifier({
      url: "http://localhost",
      anonKey: "anon",
      createClient: () => ({
        auth: {
          getClaims: (jwt: string) => {
            calls.push(jwt);
            return Promise.resolve({ data: claims === null ? null : { claims }, error });
          },
        },
      }) as never,
    });
  assertEquals(await make({ sub: "u1", role: "authenticated" }).verify("jwt-1"), { userId: "u1" });
  assertEquals(calls, ["jwt-1"]);
  assertEquals(await make({ sub: "u1", role: "anon" }).verify("jwt"), null);
  assertEquals(await make({ role: "authenticated" }).verify("jwt"), null);
  assertEquals(await make(null, { message: "bad" }).verify("jwt"), null);
});
```

`supabase/functions/_shared/adapters/user-auth.ts`:

```ts
import { json } from "./http.ts";

export interface VerifiedUser {
  userId: string;
}

export interface UserVerifier {
  verify(jwt: string): Promise<VerifiedUser | null>;
}

export type AuthResult = { ok: true; userId: string } | { ok: false; response: Response };

/** `Authorization: Bearer <jwt>`; anything that is not a JWT-shaped token is treated as absent. */
export function bearerToken(req: Request): string | null {
  const header = req.headers.get("authorization");
  if (header === null) return null;
  const match = /^Bearer\s+([A-Za-z0-9._~+/=-]+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

export async function authenticate(req: Request, verifier: UserVerifier, headers?: HeadersInit): Promise<AuthResult> {
  const unauthorized = (): AuthResult => ({
    ok: false,
    response: json({ error: "unauthorized" }, { status: 401, ...(headers === undefined ? {} : { headers }) }),
  });
  const token = bearerToken(req);
  if (token === null) return unauthorized();
  const user = await verifier.verify(token).catch(() => null);
  return user === null ? unauthorized() : { ok: true, userId: user.userId };
}

interface ClaimsClient {
  auth: { getClaims(jwt: string): Promise<{ data: { claims: unknown } | null; error: unknown }> };
}

/** Verifies the user JWT with `auth.getClaims()` (the platform JWT check is off for these functions, spec 7.3). */
export function createClaimsVerifier(deps: {
  url: string;
  anonKey: string;
  createClient: (url: string, key: string, options: { auth: { persistSession: false; autoRefreshToken: false } }) => ClaimsClient;
}): UserVerifier {
  return {
    async verify(jwt) {
      const client = deps.createClient(deps.url, deps.anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
      const { data, error } = await client.auth.getClaims(jwt);
      if (error || data === null) return null;
      const claims = data.claims as { sub?: unknown; role?: unknown };
      if (typeof claims.sub !== "string" || claims.sub === "" || claims.role !== "authenticated") return null;
      return { userId: claims.sub };
    },
  };
}
```

Run: `deno test -A --config supabase/functions/deno.json supabase/functions/_shared/adapters/user-auth.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 7: `cash-types.ts` (the "editable mapping", P5b-D10)**

`supabase/functions/_shared/adapters/cash-types.test.ts`:

```ts
import { assertEquals } from "@std/assert";
import { categorizeCashType } from "./cash-types.ts";

Deno.test("Flex Cash Transactions types map to the six categories (vocabulary is UNVERIFIED, unknown values become other)", () => {
  const table: Array<[string, string]> = [
    ["Dividends", "dividend"],
    ["Payment In Lieu Of Dividends", "dividend"],
    ["Withholding Tax", "withholding_tax"],
    ["withholding tax", "withholding_tax"],
    ["Broker Interest Paid", "interest"],
    ["Broker Interest Received", "interest"],
    ["Bond Interest Received", "interest"],
    ["Deposits/Withdrawals", "deposit_withdrawal"],
    ["Other Fees", "fee"],
    ["Commission Adjustments", "fee"],
    ["Something New", "other"],
    ["", "other"],
  ];
  for (const [raw, category] of table) assertEquals(categorizeCashType(raw), category, raw);
});
```

`supabase/functions/_shared/adapters/cash-types.ts`:

```ts
export type CashCategory = "dividend" | "withholding_tax" | "interest" | "fee" | "deposit_withdrawal" | "other";

export interface CashTypeRule {
  match: RegExp;
  category: CashCategory;
}

/**
 * Flex does not enumerate the Cash Transactions `Type` values (research flex 2.2, UNVERIFIED), so the raw text is always stored in
 * `type_raw` and mapped here. First matching rule wins; withholding comes before dividend. Edit this list once the owner's real
 * statement (P5-01) shows the exact vocabulary.
 */
export const CASH_TYPE_RULES: readonly CashTypeRule[] = [
  { match: /withholding/i, category: "withholding_tax" },
  { match: /dividend/i, category: "dividend" },
  { match: /interest/i, category: "interest" },
  { match: /deposit|withdrawal/i, category: "deposit_withdrawal" },
  { match: /fee|commission/i, category: "fee" },
];

export function categorizeCashType(typeRaw: string): CashCategory {
  for (const rule of CASH_TYPE_RULES) if (rule.match.test(typeRaw)) return rule.category;
  return "other";
}
```

Run: `deno test -A --config supabase/functions/deno.json supabase/functions/_shared/adapters/cash-types.test.ts`
Expected: PASS (1 test).

- [ ] **Step 8: Write the failing `flex.ts` tests**

`supabase/functions/_shared/adapters/flex.test.ts`:

```ts
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { FlexLimiterError, createFlexClient, createRpcLimiter, tokenKey } from "./flex.ts";

const TOKEN = "987654321012345678901234";

const SEND_OK = `<FlexStatementResponse timestamp='15 October, 2026 03:05 AM EDT'><Status>Success</Status><ReferenceCode>1234567890</ReferenceCode><Url>https://example.invalid/never-fetched</Url></FlexStatementResponse>`;
const fail = (code: number, message: string, status = "Fail") =>
  `<FlexStatementResponse timestamp='15 October, 2026 03:05 AM EDT'><Status>${status}</Status><ErrorCode>${code}</ErrorCode><ErrorMessage>${message}</ErrorMessage></FlexStatementResponse>`;
const STATEMENT = `<FlexQueryResponse queryName="Screener" type="AF"><FlexStatements count="1"><FlexStatement accountId="U1" fromDate="20261001" toDate="20261014" /></FlexStatements></FlexQueryResponse>`;

interface Call {
  url: URL;
  headers: Headers;
}

function stub(...bodies: Array<string | Error | { status: number; body?: string }>) {
  const calls: Call[] = [];
  let i = 0;
  const fetchImpl = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({ url: new URL(input instanceof Request ? input.url : String(input)), headers: new Headers(init?.headers) });
    const next = bodies[Math.min(i++, bodies.length - 1)];
    if (next instanceof Error) return Promise.reject(next);
    if (typeof next === "object") return Promise.resolve(new Response(next.body ?? "", { status: next.status }));
    return Promise.resolve(new Response(next ?? "", { status: 200, headers: { "content-type": "text/plain;charset=UTF-8" } }));
  };
  return { fetchImpl: fetchImpl as typeof fetch, calls };
}

Deno.test("sendRequest builds the v=3 URL, sends the User-Agent and returns the reference code", async () => {
  const s = stub(SEND_OK);
  const flex = createFlexClient({ userAgent: "TestAgent/1.0", fetchImpl: s.fetchImpl });
  const res = await flex.sendRequest(TOKEN, "123456");
  assertEquals(res, { ok: true, referenceCode: "1234567890", url: "https://example.invalid/never-fetched" });
  const call = s.calls[0];
  assert(call !== undefined);
  assertEquals(call.url.origin + call.url.pathname, "https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService/SendRequest");
  assertEquals(call.url.searchParams.get("t"), TOKEN);
  assertEquals(call.url.searchParams.get("q"), "123456");
  assertEquals(call.url.searchParams.get("v"), "3");
  assertEquals(call.url.searchParams.has("p") || call.url.searchParams.has("fd"), false);
  assertEquals(call.headers.get("user-agent"), "TestAgent/1.0");
});

Deno.test("period options: p for days, fd and td for a range, never both, validated", async () => {
  const s = stub(SEND_OK);
  const flex = createFlexClient({ userAgent: "UA", fetchImpl: s.fetchImpl });
  await flex.sendRequest(TOKEN, "1", { days: 365 });
  await flex.sendRequest(TOKEN, "1", { from: "2026-10-01", to: "2026-10-14" });
  assertEquals(s.calls[0]?.url.searchParams.get("p"), "365");
  assertEquals(s.calls[0]?.url.searchParams.has("fd"), false);
  assertEquals(s.calls[1]?.url.searchParams.get("fd"), "20261001");
  assertEquals(s.calls[1]?.url.searchParams.get("td"), "20261014");
  assertEquals(s.calls[1]?.url.searchParams.has("p"), false);
  for (const bad of [{ days: 0 }, { days: 366 }, { days: 1.5 }, { from: "2026-10-14", to: "2026-10-01" }, { from: "20261001", to: "bad" }]) {
    const res = await flex.sendRequest(TOKEN, "1", bad as never);
    assertEquals(res.ok, false);
    if (!res.ok) assertEquals(res.code, 1020);
  }
  assertEquals(s.calls.length, 2);
});

Deno.test("sendRequest maps IBKR failures: token invalid, token expired, IP restriction, bad query", async () => {
  for (const [code, text] of [[1015, "Token is invalid."], [1012, "Token has expired."], [1013, "IP restriction."], [1014, "Query is invalid."]] as const) {
    const flex = createFlexClient({ userAgent: "UA", fetchImpl: stub(fail(code, text)).fetchImpl });
    assertEquals(await flex.sendRequest(TOKEN, "1"), { ok: false, code, message: text });
  }
});

Deno.test("getStatement returns the XML, builds the URL from the reference code and ignores the response url", async () => {
  const s = stub(STATEMENT);
  const flex = createFlexClient({ userAgent: "UA", fetchImpl: s.fetchImpl });
  const res = await flex.getStatement(TOKEN, "1234567890");
  assertEquals(res.ok, true);
  if (res.ok) assertStringIncludes(res.xml, "<FlexQueryResponse");
  const call = s.calls[0];
  assertEquals(call?.url.pathname.endsWith("/GetStatement"), true);
  assertEquals(call?.url.searchParams.get("q"), "1234567890");
  assertEquals(call?.url.searchParams.get("v"), "3");
  assertEquals(call?.headers.get("user-agent"), "UA");
});

Deno.test("getStatement: 1019 in progress (Warn), 1018 too many requests, 1021 retrieval failure are reported with their codes", async () => {
  for (const [body, code] of [
    [fail(1019, "Statement generation in progress. Please try again shortly.", "Warn"), 1019],
    [fail(1018, "Too many requests have been made from this token.", "Fail"), 1018],
    [fail(1021, "Statement could not be retrieved at this time.", "Fail"), 1021],
    [fail(1012, "Token has expired.", "Fail"), 1012],
    [fail(1013, "IP restriction.", "Fail"), 1013],
  ] as const) {
    const flex = createFlexClient({ userAgent: "UA", fetchImpl: stub(body).fetchImpl });
    const res = await flex.getStatement(TOKEN, "1");
    assertEquals(res.ok, false);
    if (!res.ok) assertEquals(res.code, code);
  }
});

Deno.test("an error code that only appears inside the message is still recovered; garbage is a transport-class failure", async () => {
  const noCode = `<FlexStatementResponse><Status>Fail</Status><ErrorMessage>Error 1019: Statement generation in progress.</ErrorMessage></FlexStatementResponse>`;
  const a = await createFlexClient({ userAgent: "UA", fetchImpl: stub(noCode).fetchImpl }).getStatement(TOKEN, "1");
  assertEquals(a.ok === false && a.code, 1019);
  const b = await createFlexClient({ userAgent: "UA", fetchImpl: stub("<html>maintenance</html>").fetchImpl }).getStatement(TOKEN, "1");
  assertEquals(b.ok === false && b.code, 0);
});

Deno.test("HTTP 429 is 1018, HTTP 5xx and network errors are transport failures, and the token never appears in a message", async () => {
  const limited = await createFlexClient({ userAgent: "UA", fetchImpl: stub({ status: 429 }).fetchImpl }).getStatement(TOKEN, "1");
  assertEquals(limited.ok === false && limited.code, 1018);
  const server = await createFlexClient({ userAgent: "UA", fetchImpl: stub({ status: 503 }).fetchImpl }).sendRequest(TOKEN, "1");
  assertEquals(server.ok === false && server.code, 0);
  const leaky = new Error(`fetch failed: https://ndcdyn.interactivebrokers.com/x?t=${TOKEN}&q=1`);
  const net = await createFlexClient({ userAgent: "UA", fetchImpl: stub(leaky).fetchImpl }).sendRequest(TOKEN, "1");
  assertEquals(net.ok, false);
  assert(!JSON.stringify(net).includes(TOKEN));
  assert(!JSON.stringify(server).includes(TOKEN));
});

Deno.test("the limiter runs before every request; a local limit is reported as 1018 without calling IBKR", async () => {
  const s = stub(SEND_OK);
  const seen: string[] = [];
  const ok = createFlexClient({ userAgent: "UA", fetchImpl: s.fetchImpl, limiter: { acquire: (t) => (seen.push(t), Promise.resolve()) } });
  await ok.sendRequest(TOKEN, "1");
  assertEquals(seen, [TOKEN]);
  const blocked = createFlexClient({
    userAgent: "UA",
    fetchImpl: s.fetchImpl,
    limiter: { acquire: () => Promise.reject(new FlexLimiterError(45_000)) },
  });
  const res = await blocked.getStatement(TOKEN, "1");
  assertEquals(res.ok === false && res.code, 1018);
  assertEquals(s.calls.length, 1);
});

Deno.test("tokenKey is a stable hash that never contains the token", async () => {
  const a = await tokenKey(TOKEN);
  assertEquals(a, await tokenKey(TOKEN));
  assert(/^flexrl:[0-9a-f]{32}$/.test(a));
  assert(!a.includes(TOKEN));
  assert(a !== (await tokenKey(`${TOKEN}0`)));
});

Deno.test("the RPC limiter waits for the reported time, retries and gives up above the maximum wait", async () => {
  const sleeps: number[] = [];
  const waits = [1100, 0];
  const keys: string[] = [];
  const limiter = createRpcLimiter({
    take: (key) => (keys.push(key), Promise.resolve(waits.shift() ?? 0)),
    sleep: (ms) => (sleeps.push(ms), Promise.resolve()),
  });
  await limiter.acquire(TOKEN);
  assertEquals(sleeps, [1100]);
  assertEquals(keys.length, 2);
  assert(keys.every((k) => k.startsWith("flexrl:") && !k.includes(TOKEN)));

  const stuck = createRpcLimiter({ take: () => Promise.resolve(40_000), sleep: () => Promise.resolve(), maxWaitMs: 15_000 });
  let error: unknown;
  try {
    await stuck.acquire(TOKEN);
  } catch (e) {
    error = e;
  }
  assert(error instanceof FlexLimiterError);
  assertEquals((error as FlexLimiterError).waitMs, 40_000);
});
```

Run: `deno test -A --config supabase/functions/deno.json supabase/functions/_shared/adapters/flex.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 9: Implement `flex.ts`**

`supabase/functions/_shared/adapters/flex.ts`:

```ts
// IBKR Flex Web Service client (spec 12.4, research flex 2.3). No network access except through the injected fetch.
// The token travels in the URL query (that is the Flex protocol): URLs are never logged and error messages never include them.
import { XMLParser } from "npm:fast-xml-parser@5.11.2";

export const FLEX_BASE_URL = "https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService";

export type FlexPeriod = { days: number } | { from: string; to: string };

export type SendResult =
  | { ok: true; referenceCode: string; /** returned by IBKR and deliberately never fetched */ url: string | null }
  | { ok: false; code: number; message: string };

export type StatementResult = { ok: true; xml: string } | { ok: false; code: number; message: string };

export interface FlexLimiter {
  acquire(token: string): Promise<void>;
}

export class FlexLimiterError extends Error {
  constructor(readonly waitMs: number) {
    super("local Flex rate limit");
    this.name = "FlexLimiterError";
  }
}

export interface FlexClientOptions {
  userAgent: string;
  fetchImpl?: typeof fetch;
  limiter?: FlexLimiter;
  baseUrl?: string;
  timeoutMs?: number;
}

export interface FlexClient {
  sendRequest(token: string, queryId: string, period?: FlexPeriod): Promise<SendResult>;
  getStatement(token: string, referenceCode: string): Promise<StatementResult>;
}

interface Envelope {
  status: string;
  errorCode: number | null;
  errorMessage: string | null;
  referenceCode: string | null;
  url: string | null;
}

const envelopeParser = new XMLParser({ ignoreAttributes: true, parseTagValue: false, trimValues: true });

function field(node: Record<string, unknown>, name: string): string | null {
  const key = Object.keys(node).find((k) => k.toLowerCase() === name);
  const value = key === undefined ? undefined : node[key];
  return typeof value === "string" || typeof value === "number" ? String(value).trim() : null;
}

function parseEnvelope(text: string): Envelope | null {
  let doc: unknown;
  try {
    doc = envelopeParser.parse(text);
  } catch {
    return null;
  }
  if (typeof doc !== "object" || doc === null) return null;
  const rootKey = Object.keys(doc).find((k) => k.toLowerCase() === "flexstatementresponse");
  const root = rootKey === undefined ? undefined : (doc as Record<string, unknown>)[rootKey];
  if (typeof root !== "object" || root === null) return null;
  const node = root as Record<string, unknown>;
  const rawCode = field(node, "errorcode");
  const message = field(node, "errormessage");
  const recovered = rawCode ?? (message === null ? null : (/\b(10\d{2})\b/.exec(message)?.[1] ?? null));
  return {
    status: field(node, "status") ?? "",
    errorCode: recovered === null || Number.isNaN(Number(recovered)) ? null : Number(recovered),
    errorMessage: message,
    referenceCode: field(node, "referencecode"),
    url: field(node, "url"),
  };
}

function ymd(value: string): string | null {
  const m = /^(\d{4})-?(\d{2})-?(\d{2})$/.exec(value);
  return m === null ? null : `${m[1]}${m[2]}${m[3]}`;
}

function periodParams(period: FlexPeriod | undefined): Record<string, string> | null {
  if (period === undefined) return {};
  if ("days" in period) {
    return Number.isInteger(period.days) && period.days >= 1 && period.days <= 365 ? { p: String(period.days) } : null;
  }
  const fd = ymd(period.from);
  const td = ymd(period.to);
  return fd !== null && td !== null && fd <= td ? { fd, td } : null;
}

export function createFlexClient(o: FlexClientOptions): FlexClient {
  const fetchImpl = o.fetchImpl ?? fetch;
  const base = o.baseUrl ?? FLEX_BASE_URL;
  const timeoutMs = o.timeoutMs ?? 30_000;

  async function get(token: string, path: "SendRequest" | "GetStatement", params: Record<string, string>): Promise<{ ok: true; text: string } | { ok: false; code: number; message: string }> {
    if (o.limiter !== undefined) {
      try {
        await o.limiter.acquire(token);
      } catch (e) {
        if (e instanceof FlexLimiterError) return { ok: false, code: 1018, message: "Local rate limit reached; trying again later." };
        throw e;
      }
    }
    const url = new URL(`${base}/${path}`);
    url.searchParams.set("t", token);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    url.searchParams.set("v", "3");
    let res: Response;
    try {
      res = await fetchImpl(url.toString(), {
        method: "GET",
        headers: { "User-Agent": o.userAgent, Accept: "text/xml, application/xml, text/plain, */*" },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      return { ok: false, code: 0, message: "Could not reach the IBKR Flex service." };
    }
    if (res.status === 429) return { ok: false, code: 1018, message: "Too many requests (HTTP 429)." };
    if (res.status >= 500) return { ok: false, code: 0, message: `IBKR Flex service error (HTTP ${res.status}).` };
    return { ok: true, text: await res.text().catch(() => "") };
  }

  function failure(env: Envelope | null): { ok: false; code: number; message: string } {
    if (env === null) return { ok: false, code: 0, message: "Unrecognised response from the IBKR Flex service." };
    return {
      ok: false,
      code: env.errorCode ?? 0,
      message: env.errorMessage ?? "The IBKR Flex service reported an error.",
    };
  }

  return {
    async sendRequest(token, queryId, period) {
      const extra = periodParams(period);
      if (extra === null) return { ok: false, code: 1020, message: "Invalid period." };
      const res = await get(token, "SendRequest", { q: queryId, ...extra });
      if (!res.ok) return res;
      const env = parseEnvelope(res.text);
      if (env !== null && env.status.toLowerCase() === "success" && env.referenceCode !== null && env.referenceCode !== "") {
        return { ok: true, referenceCode: env.referenceCode, url: env.url };
      }
      return failure(env);
    },

    async getStatement(token, referenceCode) {
      const res = await get(token, "GetStatement", { q: referenceCode });
      if (!res.ok) return res;
      if (/<FlexQueryResponse[\s>]/.test(res.text)) return { ok: true, xml: res.text };
      return failure(parseEnvelope(res.text));
    },
  };
}

/** `flexrl:` + the first 32 hex characters of SHA-256(token): the limiter key never contains the token. */
export async function tokenKey(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  return `flexrl:${hex.slice(0, 32)}`;
}

/** Waits for `app.flex_rl_take(key)` (0 = granted, otherwise milliseconds to wait) and fails when the wait is longer than `maxWaitMs`. */
export function createRpcLimiter(o: {
  take(key: string): Promise<number>;
  sleep(ms: number): Promise<void>;
  maxWaitMs?: number;
  maxLoops?: number;
}): FlexLimiter {
  const maxWait = o.maxWaitMs ?? 15_000;
  const loops = o.maxLoops ?? 5;
  return {
    async acquire(token) {
      const key = await tokenKey(token);
      let last = 0;
      for (let i = 0; i < loops; i++) {
        last = await o.take(key);
        if (last <= 0) return;
        if (last > maxWait) throw new FlexLimiterError(last);
        await o.sleep(last);
      }
      throw new FlexLimiterError(last);
    },
  };
}
```

Run: `deno test -A --config supabase/functions/deno.json supabase/functions/_shared/adapters/flex.test.ts`
Expected: PASS (10 tests). If `npm:fast-xml-parser@5.11.2` is not yet cached, Deno downloads it on the first run (network access to the npm registry is expected here, not for the tests themselves).

- [ ] **Step 10: Write the fixture `activity-sample.xml`**

`supabase/functions/_shared/adapters/fixtures/flex/activity-sample.xml`. Account id, conids, amounts and the statement are **invented**; element and attribute spellings are the expected ones (spec 12.5, research flex 2.2) and are replaced by a redacted real statement in P5-01. Dates use `yyyyMMdd`, times `HHmmss`, date/time `yyyyMMdd;HHmmss`.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<FlexQueryResponse queryName="Screener" type="AF">
  <FlexStatements count="1">
    <FlexStatement accountId="U1234567" fromDate="20260915" toDate="20261014" period="Last365CalendarDays" whenGenerated="20261015;030512">
      <AccountInformation accountId="U1234567" acctAlias="Fixture" currency="EUR" name="Fixture Owner" accountType="Individual" />
      <OpenPositions>
        <OpenPosition accountId="U1234567" currency="USD" fxRateToBase="0.92" assetCategory="STK" symbol="AAPL" description="APPLE INC" conid="100001" isin="US0378331005" reportDate="20261014" position="10" multiplier="1" markPrice="230.00" positionValue="2300.00" openPrice="200.17" costBasisPrice="200.17" costBasisMoney="2001.70" percentOfNAV="12.50" fifoPnlUnrealized="298.30" side="Long" levelOfDetail="SUMMARY" futureField="kept-in-raw" />
        <OpenPosition accountId="U1234567" currency="GBP" fxRateToBase="1.15" assetCategory="STK" symbol="SHEL" description="SHELL PLC" conid="100002" isin="GB00BP6MXD84" reportDate="20261014" position="100" multiplier="1" markPrice="27.35" positionValue="2735.00" openPrice="25.00" costBasisPrice="25.00" costBasisMoney="2500.00" percentOfNAV="17.10" fifoPnlUnrealized="235.00" side="Long" levelOfDetail="SUMMARY" />
        <OpenPosition accountId="U1234567" currency="USD" fxRateToBase="0.92" assetCategory="STK" symbol="AAPL" description="APPLE INC" conid="100001" isin="US0378331005" reportDate="20261014" position="6" multiplier="1" markPrice="230.00" positionValue="1380.00" openPrice="199.50" costBasisPrice="199.67" costBasisMoney="1198.00" fifoPnlUnrealized="182.00" side="Long" levelOfDetail="LOT" openDateTime="20261009;093001" />
      </OpenPositions>
      <Trades>
        <Trade accountId="U1234567" currency="USD" fxRateToBase="0.92" assetCategory="STK" symbol="AAPL" description="APPLE INC" conid="100001" isin="US0378331005" listingExchange="NASDAQ" tradeID="1001001" reportDate="20261014" tradeDate="20261009" tradeTime="093001" dateTime="20261009;093001" settleDateTarget="20261012" transactionType="ExchTrade" exchange="NASDAQ" quantity="6" tradePrice="199.50" multiplier="1" tradeMoney="1197.00" proceeds="-1197.00" taxes="0" ibCommission="-1.00" ibCommissionCurrency="USD" openCloseIndicator="O" notes="P" costBasis="1198.00" fifoPnlRealized="0" buySell="BUY" ibOrderID="5001" ibExecID="0000f001.6710a001.01.01" netCash="-1198.00" orderType="LMT" levelOfDetail="EXECUTION" />
        <Trade accountId="U1234567" currency="USD" fxRateToBase="0.92" assetCategory="STK" symbol="AAPL" description="APPLE INC" conid="100001" isin="US0378331005" listingExchange="NASDAQ" tradeID="1001002" reportDate="20261014" tradeDate="20261009" tradeTime="093007" dateTime="20261009;093007" settleDateTarget="20261012" transactionType="ExchTrade" exchange="NASDAQ" quantity="4" tradePrice="200.75" multiplier="1" tradeMoney="803.00" proceeds="-803.00" taxes="0" ibCommission="-0.70" ibCommissionCurrency="USD" openCloseIndicator="O" notes="P" costBasis="803.70" fifoPnlRealized="0" buySell="BUY" ibOrderID="5001" ibExecID="0000f001.6710a002.01.01" netCash="-803.70" orderType="LMT" levelOfDetail="EXECUTION" />
        <Trade accountId="U1234567" currency="GBP" fxRateToBase="1.15" assetCategory="STK" symbol="SHEL" description="SHELL PLC" conid="100002" isin="GB00BP6MXD84" listingExchange="LSE" tradeID="2002001" reportDate="20261014" tradeDate="20261008" tradeTime="110500" dateTime="20261008;110500" settleDateTarget="20261012" transactionType="ExchTrade" exchange="LSE" quantity="-4" tradePrice="26.50" multiplier="1" tradeMoney="-106.00" proceeds="106.00" taxes="0" ibCommission="-0.40" ibCommissionCurrency="GBP" openCloseIndicator="C" notes="P" costBasis="-101.00" fifoPnlRealized="4.60" buySell="SELL" ibOrderID="5002" ibExecID="0000f002.6709b001.01.01" netCash="105.60" orderType="LMT" levelOfDetail="EXECUTION" />
        <Lot accountId="U1234567" currency="GBP" fxRateToBase="1.15" assetCategory="STK" symbol="SHEL" description="SHELL PLC" conid="100002" isin="GB00BP6MXD84" tradeID="2002001" reportDate="20261014" tradeDate="20261008" dateTime="20261008;110500" openDateTime="20260115;093000" quantity="3" tradePrice="26.50" costBasis="75.00" proceeds="79.50" fifoPnlRealized="4.20" buySell="SELL" levelOfDetail="CLOSED_LOT" />
        <Lot accountId="U1234567" currency="GBP" fxRateToBase="1.15" assetCategory="STK" symbol="SHEL" description="SHELL PLC" conid="100002" isin="GB00BP6MXD84" tradeID="2002001" reportDate="20261014" tradeDate="20261008" dateTime="20261008;110500" openDateTime="20260220;101500" quantity="-1" tradePrice="26.50" costBasis="26.00" proceeds="26.50" fifoPnlRealized="0.40" buySell="SELL" levelOfDetail="CLOSED_LOT" />
      </Trades>
      <CashTransactions>
        <CashTransaction accountId="U1234567" currency="USD" fxRateToBase="0.92" assetCategory="STK" symbol="AAPL" description="AAPL(US0378331005) CASH DIVIDEND USD 0.26 PER SHARE (Ordinary Dividend)" conid="100001" isin="US0378331005" dateTime="20261010;202500" amount="2.60" type="Dividends" tradeID="" code="" reportDate="20261014" />
        <CashTransaction accountId="U1234567" currency="USD" fxRateToBase="0.92" assetCategory="STK" symbol="AAPL" description="AAPL(US0378331005) CASH DIVIDEND USD 0.26 PER SHARE - US TAX" conid="100001" isin="US0378331005" dateTime="20261010;202500" amount="-0.39" type="Withholding Tax" tradeID="" code="" reportDate="20261014" />
        <CashTransaction accountId="U1234567" currency="EUR" fxRateToBase="1" assetCategory="" symbol="" description="Electronic Fund Transfer" conid="" isin="" dateTime="20260916;120000" amount="5000.00" type="Deposits/Withdrawals" tradeID="" code="" reportDate="20260916" />
        <CashTransaction accountId="U1234567" currency="EUR" fxRateToBase="1" assetCategory="" symbol="" description="Market data fee" conid="" isin="" dateTime="20261001;000000" amount="-2.00" type="Other Fees" tradeID="" code="" reportDate="20261001" />
      </CashTransactions>
      <ConversionRates>
        <ConversionRate reportDate="20261014" fromCurrency="USD" toCurrency="EUR" rate="0.92" />
        <ConversionRate reportDate="20261014" fromCurrency="GBP" toCurrency="EUR" rate="1.15" />
      </ConversionRates>
      <EquitySummaryInBase>
        <EquitySummaryByReportDateInBase accountId="U1234567" currency="EUR" reportDate="20261013" cash="1000.00" stock="8800.55" options="0" bonds="0" interestAccruals="0.00" dividendAccruals="0.00" total="9800.55" />
        <EquitySummaryByReportDateInBase accountId="U1234567" currency="EUR" reportDate="20261014" cash="1000.00" stock="8950.20" options="0" bonds="0" interestAccruals="0.00" dividendAccruals="0.00" total="9950.20" />
      </EquitySummaryInBase>
      <FinancialInstrumentInformation>
        <FinancialInstrument assetCategory="STK" symbol="AAPL" description="APPLE INC" conid="100001" isin="US0378331005" subCategory="COMMON" listingExchange="NASDAQ" />
        <FinancialInstrument assetCategory="STK" symbol="SHEL" description="SHELL PLC" conid="100002" isin="GB00BP6MXD84" subCategory="COMMON" listingExchange="LSE" />
      </FinancialInstrumentInformation>
      <CorporateActions>
        <CorporateAction accountId="U1234567" currency="USD" assetCategory="STK" symbol="XYZ" conid="100003" reportDate="20260930" dateTime="20260930;202500" actionDescription="XYZ(US0000000001) SPLIT 2 FOR 1" amount="0" proceeds="0" value="0" quantity="10" fifoPnlRealized="0" code="" type="FS" actionID="900001" transactionID="800001" />
      </CorporateActions>
      <Transfers />
      <ChangeInDividendAccruals>
        <ChangeInDividendAccrual accountId="U1234567" currency="USD" symbol="AAPL" conid="100001" date="20261008" exDate="20261008" payDate="20261010" quantity="10" tax="-0.39" fee="0" grossRate="0.26" grossAmount="2.60" netAmount="2.21" code="Po" reportDate="20261014" />
      </ChangeInDividendAccruals>
    </FlexStatement>
  </FlexStatements>
</FlexQueryResponse>
```

Note for the implementer (and for the operator guide): Flex reports `GBP` positions in GBP major units (mark 27.35); Yahoo quotes the same line as `GBp` 2735. The fixture keeps the Flex convention; the pence conversion happens only for Yahoo prices (Task 5).

- [ ] **Step 11: Write the failing parser tests**

`supabase/functions/_shared/adapters/flex-parse.test.ts`:

```ts
import { assert, assertEquals } from "@std/assert";
import { type FlexStatement, parseDecimal, parseFlexDate, parseFlexDateTime, parseFlexStatement, requiredSectionReport } from "./flex-parse.ts";

const XML = await Deno.readTextFile(new URL("./fixtures/flex/activity-sample.xml", import.meta.url));

function statement(xml = XML, opts?: { attributeNamePrefix?: string }): FlexStatement {
  const res = parseFlexStatement(xml, opts);
  if (!res.ok) throw new Error(`parse failed: ${res.code} ${res.message}`);
  return res.statement;
}

const omitRaw = <T extends { raw: Record<string, string> }>(row: T): Omit<T, "raw"> => {
  const { raw: _raw, ...rest } = row;
  return rest;
};

Deno.test("parseDecimal handles dot and comma decimals, thousands separators, parentheses and rejects garbage", () => {
  const table: Array<[string | null, number | null]> = [
    ["12.50", 12.5], ["-0.39", -0.39], ["1,234.56", 1234.56], ["1.234,56", 1234.56], ["12,5", 12.5], ["1,234", 1234],
    ["1,234,567", 1234567], ["1.234.567", 1234567], ["(5.25)", -5.25], ["+3", 3], ["0", 0], [" 7 ", 7],
    ["", null], ["-", null], [null, null], ["abc", null], ["1,2,3", null], ["1e5", null],
  ];
  for (const [input, expected] of table) assertEquals(parseDecimal(input), expected, String(input));
});

Deno.test("parseFlexDate and parseFlexDateTime accept yyyyMMdd and yyyy-MM-dd and fail closed on ambiguous formats", () => {
  assertEquals(parseFlexDate("20261014"), "2026-10-14");
  assertEquals(parseFlexDate("2026-10-14"), "2026-10-14");
  assertEquals(parseFlexDate("20261014;093015"), "2026-10-14");
  assertEquals(parseFlexDate("20260230"), null);
  assertEquals(parseFlexDate("14/10/2026"), null);
  assertEquals(parseFlexDate("10/14/2026"), null);
  assertEquals(parseFlexDate(""), null);
  assertEquals(parseFlexDateTime("20261008;110500"), { date: "2026-10-08", time: "11:05:00" });
  assertEquals(parseFlexDateTime("2026-10-08 11:05:00"), { date: "2026-10-08", time: "11:05:00" });
  assertEquals(parseFlexDateTime("20261008"), { date: "2026-10-08", time: null });
  assertEquals(parseFlexDateTime("garbage"), null);
});

Deno.test("statement header and account information", () => {
  const s = statement();
  assertEquals(
    { accountId: s.accountId, baseCurrency: s.baseCurrency, accountType: s.accountType, fromDate: s.fromDate, toDate: s.toDate, whenGenerated: s.whenGenerated },
    { accountId: "U1234567", baseCurrency: "EUR", accountType: "Individual", fromDate: "2026-09-15", toDate: "2026-10-14", whenGenerated: "2026-10-15T03:05:12Z" },
  );
});

Deno.test("open positions: SUMMARY rows only, USD and GBP, enriched from Financial Instrument Information, LOT rows counted as ignored", () => {
  const s = statement();
  assertEquals(s.positions.length, 2);
  const [aapl, shel] = s.positions.map(omitRaw);
  assertEquals(aapl, {
    conid: 100001, symbol: "AAPL", isin: "US0378331005", description: "APPLE INC", assetClass: "STK", subCategory: "COMMON", listingExchange: "NASDAQ",
    currency: "USD", fxRateToBase: 0.92, quantity: 10, multiplier: 1, markPrice: 230, positionValue: 2300, openPrice: 200.17, costBasisPrice: 200.17,
    costBasisMoney: 2001.7, fifoPnlUnrealized: 298.3, percentOfNav: 12.5, levelOfDetail: "SUMMARY", reportDate: "2026-10-14", openDateTime: null,
  });
  assertEquals(shel, {
    conid: 100002, symbol: "SHEL", isin: "GB00BP6MXD84", description: "SHELL PLC", assetClass: "STK", subCategory: "COMMON", listingExchange: "LSE",
    currency: "GBP", fxRateToBase: 1.15, quantity: 100, multiplier: 1, markPrice: 27.35, positionValue: 2735, openPrice: 25, costBasisPrice: 25,
    costBasisMoney: 2500, fifoPnlUnrealized: 235, percentOfNav: 17.1, levelOfDetail: "SUMMARY", reportDate: "2026-10-14", openDateTime: null,
  });
  assertEquals(s.ignored["positions:LOT"], 1);
});

Deno.test("unknown attributes are preserved in raw", () => {
  assertEquals(statement().positions[0]?.raw["futureField"], "kept-in-raw");
});

Deno.test("trades: executions and closed lots are different levels of detail; a partial fill is two executions of one order", () => {
  const s = statement();
  assertEquals(s.trades.length, 3);
  assertEquals(s.closedLots.length, 2);
  const [fill1, fill2, sell] = s.trades.map(omitRaw);
  assertEquals(fill1, {
    tradeId: "1001001", execId: "0000f001.6710a001.01.01", orderId: "5001", conid: 100001, isin: "US0378331005", symbol: "AAPL", description: "APPLE INC",
    listingExchange: "NASDAQ", exchange: "NASDAQ", currency: "USD", fxRateToBase: 0.92, tradeDate: "2026-10-09", tradeTime: "09:30:01", settleDate: "2026-10-12",
    buySell: "BUY", quantity: 6, tradePrice: 199.5, tradeMoney: 1197, proceeds: -1197, taxes: 0, ibCommission: -1, ibCommissionCurrency: "USD", netCash: -1198,
    costBasis: 1198, fifoPnlRealized: 0, openClose: "O", orderType: "LMT", reportDate: "2026-10-14",
  });
  assertEquals(fill2?.tradeId, "1001002");
  assertEquals(fill2?.orderId, "5001");
  assertEquals(fill2?.execId, "0000f001.6710a002.01.01");
  assertEquals([fill2?.quantity, fill2?.tradePrice, fill2?.ibCommission, fill2?.netCash, fill2?.tradeTime], [4, 200.75, -0.7, -803.7, "09:30:07"]);
  assertEquals(sell, {
    tradeId: "2002001", execId: "0000f002.6709b001.01.01", orderId: "5002", conid: 100002, isin: "GB00BP6MXD84", symbol: "SHEL", description: "SHELL PLC",
    listingExchange: "LSE", exchange: "LSE", currency: "GBP", fxRateToBase: 1.15, tradeDate: "2026-10-08", tradeTime: "11:05:00", settleDate: "2026-10-12",
    buySell: "SELL", quantity: -4, tradePrice: 26.5, tradeMoney: -106, proceeds: 106, taxes: 0, ibCommission: -0.4, ibCommissionCurrency: "GBP", netCash: 105.6,
    costBasis: -101, fifoPnlRealized: 4.6, openClose: "C", orderType: "LMT", reportDate: "2026-10-14",
  });
});

Deno.test("closed lots of one partial sale are two lots whose P/L adds up to the execution P/L (no double counting)", () => {
  const s = statement();
  const [a, b] = s.closedLots.map(omitRaw);
  assertEquals(a, {
    conid: 100002, symbol: "SHEL", currency: "GBP", fxRateToBase: 1.15, openDateTime: "2026-01-15T09:30:00Z", closeDate: "2026-10-08", closingTradeId: "2002001",
    quantity: 3, costBasis: 75, proceeds: 79.5, fifoPnlRealized: 4.2,
  });
  assertEquals(b, {
    conid: 100002, symbol: "SHEL", currency: "GBP", fxRateToBase: 1.15, openDateTime: "2026-02-20T10:15:00Z", closeDate: "2026-10-08", closingTradeId: "2002001",
    quantity: 1, costBasis: 26, proceeds: 26.5, fifoPnlRealized: 0.4,
  });
  const lots = Math.round(s.closedLots.reduce((n, l) => n + l.fifoPnlRealized, 0) * 100) / 100;
  assertEquals(lots, s.trades[2]?.fifoPnlRealized);
});

Deno.test("cash transactions: dividend, its withholding tax, a deposit and a fee with categories and verbatim types", () => {
  const s = statement();
  assertEquals(s.cashTransactions.map(omitRaw), [
    { occurredAt: "2026-10-10T20:25:00Z", reportDate: "2026-10-14", currency: "USD", fxRateToBase: 0.92, amount: 2.6, typeRaw: "Dividends", category: "dividend", conid: 100001, isin: "US0378331005", symbol: "AAPL", description: "AAPL(US0378331005) CASH DIVIDEND USD 0.26 PER SHARE (Ordinary Dividend)", tradeId: null, code: null },
    { occurredAt: "2026-10-10T20:25:00Z", reportDate: "2026-10-14", currency: "USD", fxRateToBase: 0.92, amount: -0.39, typeRaw: "Withholding Tax", category: "withholding_tax", conid: 100001, isin: "US0378331005", symbol: "AAPL", description: "AAPL(US0378331005) CASH DIVIDEND USD 0.26 PER SHARE - US TAX", tradeId: null, code: null },
    { occurredAt: "2026-09-16T12:00:00Z", reportDate: "2026-09-16", currency: "EUR", fxRateToBase: 1, amount: 5000, typeRaw: "Deposits/Withdrawals", category: "deposit_withdrawal", conid: null, isin: null, symbol: null, description: "Electronic Fund Transfer", tradeId: null, code: null },
    { occurredAt: "2026-10-01T00:00:00Z", reportDate: "2026-10-01", currency: "EUR", fxRateToBase: 1, amount: -2, typeRaw: "Other Fees", category: "fee", conid: null, isin: null, symbol: null, description: "Market data fee", tradeId: null, code: null },
  ]);
});

Deno.test("conversion rates, NAV rows, corporate actions, transfers, dividend accruals and instruments", () => {
  const s = statement();
  assertEquals(s.fxRates, [
    { rateDate: "2026-10-14", fromCcy: "USD", toCcy: "EUR", rate: 0.92 },
    { rateDate: "2026-10-14", fromCcy: "GBP", toCcy: "EUR", rate: 1.15 },
  ]);
  assertEquals(s.nav, [
    { reportDate: "2026-10-13", currency: "EUR", cash: 1000, stock: 8800.55, other: 0, total: 9800.55 },
    { reportDate: "2026-10-14", currency: "EUR", cash: 1000, stock: 8950.2, other: 0, total: 9950.2 },
  ]);
  assertEquals(s.corporateActions.map(omitRaw), [
    { kind: "corporate_action", occurredAt: "2026-09-30T20:25:00Z", conid: 100003, symbol: "XYZ", typeRaw: "FS", quantity: 10, amount: 0, currency: "USD", code: null },
  ]);
  assertEquals(s.transfers, []);
  assertEquals(s.dividendAccruals.map(omitRaw), [
    { exDate: "2026-10-08", payDate: "2026-10-10", conid: 100001, symbol: "AAPL", currency: "USD", quantity: 10, grossRate: 0.26, grossAmount: 2.6, tax: -0.39, netAmount: 2.21 },
  ]);
  assertEquals(s.instruments.map(omitRaw), [
    { conid: 100001, symbol: "AAPL", isin: "US0378331005", subCategory: "COMMON", listingExchange: "NASDAQ", description: "APPLE INC" },
    { conid: 100002, symbol: "SHEL", isin: "GB00BP6MXD84", subCategory: "COMMON", listingExchange: "LSE", description: "SHELL PLC" },
  ]);
  assertEquals(s.sections.transfers, true);
});

Deno.test("both attribute-name-prefix variants and any attribute case give the same result", () => {
  const base = statement();
  assertEquals(statement(XML, { attributeNamePrefix: "" }).positions.map(omitRaw), base.positions.map(omitRaw));
  assertEquals(statement(XML, { attributeNamePrefix: "@" }).trades.map(omitRaw), base.trades.map(omitRaw));
  // upper-case every attribute name except those of the XML declaration on the first line
  const [declaration, ...body] = XML.split("\n");
  const shouting = [declaration, ...body.map((line) => line.replaceAll(/ (\w+)="/g, (_m, name: string) => ` ${name.toUpperCase()}="`))].join("\n");
  assertEquals(statement(shouting).closedLots.map(omitRaw), base.closedLots.map(omitRaw));
  assertEquals(statement(shouting).positions.map(omitRaw), base.positions.map(omitRaw));
});

Deno.test("an execution without ibExecID uses trade:<tradeID> as its key; neither id is a parse error", () => {
  const noExec = XML.replace(' ibExecID="0000f001.6710a001.01.01"', "");
  assertEquals(statement(noExec).trades[0]?.execId, "trade:1001001");
  const neither = noExec.replace(' tradeID="1001001"', "");
  const res = parseFlexStatement(neither);
  assertEquals(res.ok, false);
  if (!res.ok) assertEquals(res.issues.some((i) => i.section === "trades" && i.field === "ibExecID|tradeID"), true);
});

Deno.test("fail closed: a missing required attribute is a parse error and nothing is returned", () => {
  const res = parseFlexStatement(XML.replace(' conid="100002" isin="GB00BP6MXD84" reportDate="20261014" position="100"', ' isin="GB00BP6MXD84" reportDate="20261014" position="100"'));
  assertEquals(res.ok, false);
  if (!res.ok) {
    assertEquals(res.code, "parse_error");
    assertEquals(res.issues[0], { section: "openPositions", row: 2, field: "conid" });
  }
});

Deno.test("fail closed: bad XML, no statement, two statements, ambiguous dates", () => {
  assertEquals(parseFlexStatement("<FlexQueryResponse><FlexStatements>").ok, false);
  const none = parseFlexStatement("<FlexQueryResponse><FlexStatements count=\"0\"></FlexStatements></FlexQueryResponse>");
  assertEquals(none.ok === false && none.code, "no_statement");
  const two = XML.replace("</FlexStatements>", '<FlexStatement accountId="U7" fromDate="20260101" toDate="20260102"></FlexStatement></FlexStatements>');
  const res = parseFlexStatement(two);
  assertEquals(res.ok === false && res.code, "multiple_statements");
  const ambiguous = parseFlexStatement(XML.replaceAll('reportDate="20261014"', 'reportDate="14/10/2026"'));
  assertEquals(ambiguous.ok, false);
});

Deno.test("required sections: the fixture is complete; removing a section or a field is reported with the exact label", () => {
  const ok = requiredSectionReport(statement());
  assertEquals(ok.every((r) => r.present && r.missingFields.length === 0), true);
  assertEquals(ok.map((r) => r.section), ["Account Information", "Open Positions", "Trades", "Cash Transactions", "Currency Conversion Rate", "Financial Instrument Information"]);

  const noCash = XML.replace(/<CashTransactions>[\s\S]*<\/CashTransactions>/, "");
  const report = requiredSectionReport(statement(noCash));
  assertEquals(report.find((r) => r.section === "Cash Transactions")?.present, false);

  const noCostBasis = XML.replaceAll(/ costBasisMoney="[^"]*"/g, "");
  const fields = requiredSectionReport(statement(noCostBasis)).find((r) => r.section === "Open Positions");
  assertEquals(fields?.missingFields, ["Cost Basis Money"]);
});

Deno.test("a statement with sells but without Closed Lots warns that realized P/L cannot be summed from lots", () => {
  const noLots = XML.replaceAll(/<Lot [^>]*\/>/g, "");
  assertEquals(statement(noLots).warnings.includes("closed_lots_not_included"), true);
  assertEquals(statement().warnings, []);
});
```

Run: `deno test -A --config supabase/functions/deno.json supabase/functions/_shared/adapters/flex-parse.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 12: Implement `flex-parse.ts`**

`supabase/functions/_shared/adapters/flex-parse.ts`:

```ts
// Tolerant, fail-closed parser for an Activity Flex Query statement (spec 12.5, A-37). The XML element and attribute spellings are
// UNVERIFIED (the guide documents labels only): attribute lookup is case-insensitive with an alias table, both attributeNamePrefix
// variants work, and unknown attributes are kept in `raw` (never stored: spec 12.10). P5-01 pins the spellings against a real statement.
import { XMLParser, XMLValidator } from "npm:fast-xml-parser@5.11.2";
import { type CashCategory, categorizeCashType } from "./cash-types.ts";

export type Attrs = Record<string, string>;

export interface ParseIssue {
  section: string;
  row: number;
  field: string;
}

export interface FlexPosition {
  conid: number; symbol: string; isin: string | null; description: string | null; assetClass: string | null; subCategory: string | null;
  listingExchange: string | null; currency: string; fxRateToBase: number | null; quantity: number; multiplier: number;
  markPrice: number | null; positionValue: number | null; openPrice: number | null; costBasisPrice: number | null; costBasisMoney: number | null;
  fifoPnlUnrealized: number | null; percentOfNav: number | null; levelOfDetail: string; reportDate: string; openDateTime: string | null;
  raw: Record<string, string>;
}

export interface FlexTrade {
  tradeId: string | null; execId: string; orderId: string | null; conid: number; isin: string | null; symbol: string; description: string | null;
  listingExchange: string | null; exchange: string | null; currency: string; fxRateToBase: number | null; tradeDate: string; tradeTime: string | null;
  settleDate: string | null; buySell: "BUY" | "SELL"; quantity: number; tradePrice: number; tradeMoney: number | null; proceeds: number | null;
  taxes: number | null; ibCommission: number | null; ibCommissionCurrency: string | null; netCash: number | null; costBasis: number | null;
  fifoPnlRealized: number | null; openClose: string | null; orderType: string | null; reportDate: string | null;
  raw: Record<string, string>;
}

export interface FlexClosedLot {
  conid: number; symbol: string; currency: string; fxRateToBase: number | null; openDateTime: string | null; closeDate: string;
  closingTradeId: string | null; quantity: number; costBasis: number; proceeds: number | null; fifoPnlRealized: number;
  raw: Record<string, string>;
}

export interface FlexCashTransaction {
  occurredAt: string; reportDate: string | null; currency: string; fxRateToBase: number | null; amount: number; typeRaw: string; category: CashCategory;
  conid: number | null; isin: string | null; symbol: string | null; description: string | null; tradeId: string | null; code: string | null;
  raw: Record<string, string>;
}

export interface FlexFxRate { rateDate: string; fromCcy: string; toCcy: string; rate: number }
export interface FlexNav { reportDate: string; currency: string; cash: number | null; stock: number | null; other: number | null; total: number }

export interface FlexCorporateAction {
  kind: "corporate_action" | "transfer"; occurredAt: string | null; conid: number | null; symbol: string | null; typeRaw: string | null;
  quantity: number | null; amount: number | null; currency: string | null; code: string | null; raw: Record<string, string>;
}

export interface FlexDividendAccrual {
  exDate: string | null; payDate: string | null; conid: number | null; symbol: string | null; currency: string | null; quantity: number | null;
  grossRate: number | null; grossAmount: number | null; tax: number | null; netAmount: number | null; raw: Record<string, string>;
}

export interface FlexInstrument {
  conid: number; symbol: string; isin: string | null; subCategory: string | null; listingExchange: string | null; description: string | null;
  raw: Record<string, string>;
}

export type SectionKey =
  | "accountInformation" | "openPositions" | "trades" | "cashTransactions" | "conversionRates" | "nav"
  | "corporateActions" | "transfers" | "dividendAccruals" | "financialInstruments";

export interface FlexStatement {
  accountId: string;
  baseCurrency: string;
  accountType: string | null;
  fromDate: string;
  toDate: string;
  whenGenerated: string | null;
  positions: FlexPosition[];
  trades: FlexTrade[];
  closedLots: FlexClosedLot[];
  cashTransactions: FlexCashTransaction[];
  fxRates: FlexFxRate[];
  nav: FlexNav[];
  corporateActions: FlexCorporateAction[];
  transfers: FlexCorporateAction[];
  dividendAccruals: FlexDividendAccrual[];
  instruments: FlexInstrument[];
  /** which section containers exist in the file (an empty container is present) */
  sections: Record<SectionKey, boolean>;
  /** lower-cased attribute names seen per section, for the field checklist */
  attributesSeen: Record<SectionKey, string[]>;
  /** rows skipped because of their level of detail, e.g. "positions:LOT" */
  ignored: Record<string, number>;
  warnings: string[];
}

export type ParseResult =
  | { ok: true; statement: FlexStatement }
  | { ok: false; code: "invalid_xml" | "no_statement" | "multiple_statements" | "parse_error"; message: string; issues: ParseIssue[] };

export interface ParseOptions {
  attributeNamePrefix?: string;
}

// ------------------------------------------------------------------------------------------------ scalar parsing

export function parseDecimal(input: string | null): number | null {
  if (input === null) return null;
  let s = input.trim().replace(/\s/g, "");
  if (s === "" || s === "-") return null;
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  s = s.replace(/^\+/, "");
  if (!/^-?[\d.,]+$/.test(s)) return null;
  const lastDot = s.lastIndexOf(".");
  const lastComma = s.lastIndexOf(",");
  if (lastDot >= 0 && lastComma >= 0) {
    if (lastDot > lastComma) s = s.replace(/,/g, "");
    else s = s.replace(/\./g, "").replace(",", ".");
  } else if (lastComma >= 0) {
    if (/^-?\d{1,3}(,\d{3})+$/.test(s)) s = s.replace(/,/g, "");
    else if ((s.match(/,/g) ?? []).length === 1) s = s.replace(",", ".");
    else return null;
  } else if ((s.match(/\./g) ?? []).length > 1) {
    if (/^-?\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, "");
    else return null;
  }
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return negative ? -n : n;
}

function validIso(y: string, m: string, d: string): string | null {
  const year = Number(y);
  const month = Number(m);
  const day = Number(d);
  if (month < 1 || month > 12 || day < 1) return null;
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day > last ? null : `${y}-${m}-${d}`;
}

/** Accepts `yyyyMMdd` and `yyyy-MM-dd` (also as the date part of a date/time). `dd/MM/yyyy` and `MM/dd/yyyy` are ambiguous and rejected. */
export function parseFlexDate(input: string | null): string | null {
  if (input === null) return null;
  const head = input.trim().split(/[;,T ]/)[0] ?? "";
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(head) ?? /^(\d{4})-(\d{2})-(\d{2})$/.exec(head);
  return m === null ? null : validIso(m[1] as string, m[2] as string, m[3] as string);
}

export function parseFlexDateTime(input: string | null): { date: string; time: string | null } | null {
  if (input === null) return null;
  const s = input.trim();
  const date = parseFlexDate(s);
  if (date === null) return null;
  const parts = s.split(/[;,T ]+/);
  const rawTime = parts[1];
  if (rawTime === undefined || rawTime === "") return { date, time: null };
  const m = /^(\d{2}):?(\d{2}):?(\d{2})$/.exec(rawTime);
  if (m === null || Number(m[1]) > 23 || Number(m[2]) > 59 || Number(m[3]) > 59) return { date, time: null };
  return { date, time: `${m[1]}:${m[2]}:${m[3]}` };
}

const stamp = (dt: { date: string; time: string | null }): string => `${dt.date}T${dt.time ?? "00:00:00"}Z`;

// ------------------------------------------------------------------------------------------------ XML access

function isPrimitive(v: unknown): v is string | number | boolean {
  return typeof v === "string" || typeof v === "number" || typeof v === "boolean";
}

const stripPrefix = (k: string): string => (k.startsWith("@_") ? k.slice(2) : k.startsWith("@") ? k.slice(1) : k);

function toAttrs(node: unknown): { attrs: Attrs; raw: Record<string, string> } {
  const attrs: Attrs = {};
  const raw: Record<string, string> = {};
  if (typeof node !== "object" || node === null) return { attrs, raw };
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (!isPrimitive(v) || k === "#text") continue;
    const name = stripPrefix(k);
    raw[name] = String(v);
    attrs[name.toLowerCase()] = String(v);
  }
  return { attrs, raw };
}

function pick(a: Attrs, ...names: string[]): string | null {
  for (const name of names) {
    const v = a[name.toLowerCase()];
    if (v === undefined) continue;
    const t = v.trim();
    if (t !== "" && t !== "-" && t.toUpperCase() !== "N/A") return t;
  }
  return null;
}

function findKey(node: unknown, names: readonly string[]): string | undefined {
  if (typeof node !== "object" || node === null) return undefined;
  return Object.keys(node).find((k) => names.includes(k.toLowerCase()));
}

function child(node: unknown, names: readonly string[]): unknown {
  const key = findKey(node, names);
  return key === undefined ? undefined : (node as Record<string, unknown>)[key];
}

interface Row {
  element: string;
  attrs: Attrs;
  raw: Record<string, string>;
}

function rowsOf(container: unknown): Row[] {
  if (typeof container !== "object" || container === null) return [];
  const out: Row[] = [];
  for (const [element, value] of Object.entries(container as Record<string, unknown>)) {
    if (isPrimitive(value)) continue;
    for (const item of Array.isArray(value) ? value : [value]) {
      if (typeof item === "object" && item !== null) out.push({ element, ...toAttrs(item) });
    }
  }
  return out;
}

const CONTAINERS: Record<SectionKey, readonly string[]> = {
  accountInformation: ["accountinformation"],
  openPositions: ["openpositions"],
  trades: ["trades"],
  cashTransactions: ["cashtransactions"],
  conversionRates: ["conversionrates"],
  nav: ["equitysummaryinbase", "netassetvalueinbase", "navsummaryinbase"],
  corporateActions: ["corporateactions"],
  transfers: ["transfers"],
  dividendAccruals: ["changeindividendaccruals"],
  financialInstruments: ["financialinstrumentinformation"],
};

const SECTION_KEYS = Object.keys(CONTAINERS) as SectionKey[];

// ------------------------------------------------------------------------------------------------ parse

class Ctx {
  readonly issues: ParseIssue[] = [];
  section = "";
  row = 0;
  issue(field: string): void {
    this.issues.push({ section: this.section, row: this.row, field });
  }
  str(a: Attrs, field: string, ...names: string[]): string {
    const v = pick(a, ...names);
    if (v === null) this.issue(field);
    return v ?? "";
  }
  num(a: Attrs, field: string, ...names: string[]): number {
    const n = parseDecimal(pick(a, ...names));
    if (n === null) this.issue(field);
    return n ?? Number.NaN;
  }
  int(a: Attrs, field: string, ...names: string[]): number {
    const n = parseDecimal(pick(a, ...names));
    if (n === null || !Number.isInteger(n)) this.issue(field);
    return n ?? Number.NaN;
  }
  date(a: Attrs, field: string, ...names: string[]): string {
    const v = pick(a, ...names);
    const d = parseFlexDate(v);
    if (d === null) this.issue(field);
    return d ?? "";
  }
  dateTime(a: Attrs, field: string, ...names: string[]): { date: string; time: string | null } {
    const dt = parseFlexDateTime(pick(a, ...names));
    if (dt === null) this.issue(field);
    return dt ?? { date: "", time: null };
  }
}

const optNum = (a: Attrs, ...names: string[]): number | null => parseDecimal(pick(a, ...names));
const optDate = (a: Attrs, ...names: string[]): string | null => parseFlexDate(pick(a, ...names));
const optInt = (a: Attrs, ...names: string[]): number | null => {
  const n = parseDecimal(pick(a, ...names));
  return n !== null && Number.isInteger(n) ? n : null;
};
const optStamp = (a: Attrs, ...names: string[]): string | null => {
  const dt = parseFlexDateTime(pick(a, ...names));
  return dt === null ? null : stamp(dt);
};

function fail(code: "invalid_xml" | "no_statement" | "multiple_statements" | "parse_error", message: string, issues: ParseIssue[] = []): ParseResult {
  return { ok: false, code, message, issues };
}

export function parseFlexStatement(xml: string, opts: ParseOptions = {}): ParseResult {
  if (XMLValidator.validate(xml) !== true) return fail("invalid_xml", "The statement is not well-formed XML.");
  let doc: unknown;
  try {
    doc = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: opts.attributeNamePrefix ?? "@_",
      parseAttributeValue: false,
      parseTagValue: false,
      trimValues: true,
      allowBooleanAttributes: true,
      isArray: (name) => name.toLowerCase() === "flexstatement",
    }).parse(xml);
  } catch {
    return fail("invalid_xml", "The statement could not be read as XML.");
  }
  const root = child(doc, ["flexqueryresponse"]);
  const holder = child(root, ["flexstatements"]);
  const list = child(holder, ["flexstatement"]);
  const statements = Array.isArray(list) ? list : list === undefined ? [] : [list];
  if (statements.length === 0) return fail("no_statement", "The response contains no FlexStatement.");
  if (statements.length > 1) return fail("multiple_statements", "The response contains more than one statement; link a query for a single account.");
  const node = statements[0] as Record<string, unknown>;
  const head = toAttrs(node).attrs;

  const c = new Ctx();
  c.section = "statement";
  c.row = 0;
  const accountFromHead = pick(head, "accountId");
  const fromDate = c.date(head, "fromDate", "fromDate");
  const toDate = c.date(head, "toDate", "toDate");
  const whenGenerated = parseFlexDateTime(pick(head, "whenGenerated"));

  const sections = Object.fromEntries(SECTION_KEYS.map((k) => [k, findKey(node, CONTAINERS[k]) !== undefined])) as Record<SectionKey, boolean>;
  const seen: Record<SectionKey, Set<string>> = Object.fromEntries(SECTION_KEYS.map((k) => [k, new Set<string>()])) as Record<SectionKey, Set<string>>;
  const sectionRows = (key: SectionKey): Row[] => {
    const rows = rowsOf(child(node, CONTAINERS[key]));
    for (const r of rows) for (const name of Object.keys(r.attrs)) seen[key].add(name);
    return rows;
  };

  // account information
  const accountNode = child(node, CONTAINERS.accountInformation);
  const account = toAttrs(accountNode).attrs;
  for (const name of Object.keys(account)) seen.accountInformation.add(name);
  c.section = "accountInformation";
  const accountId = pick(account, "accountId") ?? accountFromHead ?? "";
  if (accountId === "") c.issue("accountId");
  const baseCurrency = pick(account, "currency") ?? "";
  if (baseCurrency === "") c.issue("currency");
  const accountType = pick(account, "accountType");

  const ignored: Record<string, number> = {};
  const bump = (key: string) => {
    ignored[key] = (ignored[key] ?? 0) + 1;
  };

  // open positions (SUMMARY level only; LOT rows are counted and skipped)
  const positions: FlexPosition[] = [];
  c.section = "openPositions";
  sectionRows("openPositions").forEach((r, i) => {
    c.row = i + 1;
    const level = (pick(r.attrs, "levelOfDetail") ?? "SUMMARY").toUpperCase();
    if (level !== "SUMMARY") {
      bump(`positions:${level}`);
      return;
    }
    positions.push({
      conid: c.int(r.attrs, "conid", "conid"),
      symbol: c.str(r.attrs, "symbol", "symbol"),
      isin: pick(r.attrs, "isin"),
      description: pick(r.attrs, "description"),
      assetClass: pick(r.attrs, "assetCategory", "assetClass"),
      subCategory: pick(r.attrs, "subCategory"),
      listingExchange: pick(r.attrs, "listingExchange"),
      currency: c.str(r.attrs, "currency", "currency"),
      fxRateToBase: optNum(r.attrs, "fxRateToBase"),
      quantity: c.num(r.attrs, "position", "position", "quantity", "qty"),
      multiplier: optNum(r.attrs, "multiplier") ?? 1,
      markPrice: optNum(r.attrs, "markPrice"),
      positionValue: optNum(r.attrs, "positionValue"),
      openPrice: optNum(r.attrs, "openPrice"),
      costBasisPrice: optNum(r.attrs, "costBasisPrice"),
      costBasisMoney: optNum(r.attrs, "costBasisMoney"),
      fifoPnlUnrealized: optNum(r.attrs, "fifoPnlUnrealized"),
      percentOfNav: optNum(r.attrs, "percentOfNAV", "percentOfNav"),
      levelOfDetail: level,
      reportDate: pick(r.attrs, "reportDate") === null ? toDate : c.date(r.attrs, "reportDate", "reportDate"),
      openDateTime: optStamp(r.attrs, "openDateTime"),
      raw: r.raw,
    });
  });

  // trades: executions and closed lots are different levels of detail of the same section
  const trades: FlexTrade[] = [];
  const closedLots: FlexClosedLot[] = [];
  c.section = "trades";
  sectionRows("trades").forEach((r, i) => {
    c.row = i + 1;
    const level = (pick(r.attrs, "levelOfDetail") ?? (r.element.toLowerCase() === "lot" ? "CLOSED_LOT" : "EXECUTION")).toUpperCase();
    if (level === "EXECUTION") {
      const tradeId = pick(r.attrs, "tradeID");
      const exec = pick(r.attrs, "ibExecID");
      if (exec === null && tradeId === null) c.issue("ibExecID|tradeID");
      const side = (pick(r.attrs, "buySell") ?? "").toUpperCase();
      if (side !== "BUY" && side !== "SELL") c.issue("buySell");
      const dt = pick(r.attrs, "tradeDate") !== null ? undefined : c.dateTime(r.attrs, "tradeDate", "dateTime");
      const tradeDate = dt === undefined ? c.date(r.attrs, "tradeDate", "tradeDate") : dt.date;
      const time = pick(r.attrs, "tradeTime");
      const tm = time === null ? (dt?.time ?? parseFlexDateTime(pick(r.attrs, "dateTime"))?.time ?? null) : (/^(\d{2}):?(\d{2}):?(\d{2})$/.exec(time)?.slice(1, 4).join(":") ?? null);
      trades.push({
        tradeId,
        execId: exec ?? `trade:${tradeId ?? ""}`,
        orderId: pick(r.attrs, "ibOrderID"),
        conid: c.int(r.attrs, "conid", "conid"),
        isin: pick(r.attrs, "isin"),
        symbol: c.str(r.attrs, "symbol", "symbol"),
        description: pick(r.attrs, "description"),
        listingExchange: pick(r.attrs, "listingExchange"),
        exchange: pick(r.attrs, "exchange"),
        currency: c.str(r.attrs, "currency", "currency"),
        fxRateToBase: optNum(r.attrs, "fxRateToBase"),
        tradeDate,
        tradeTime: tm,
        settleDate: optDate(r.attrs, "settleDateTarget", "settleDate"),
        buySell: side === "SELL" ? "SELL" : "BUY",
        quantity: c.num(r.attrs, "quantity", "quantity"),
        tradePrice: c.num(r.attrs, "tradePrice", "tradePrice"),
        tradeMoney: optNum(r.attrs, "tradeMoney"),
        proceeds: optNum(r.attrs, "proceeds"),
        taxes: optNum(r.attrs, "taxes"),
        ibCommission: optNum(r.attrs, "ibCommission"),
        ibCommissionCurrency: pick(r.attrs, "ibCommissionCurrency"),
        netCash: optNum(r.attrs, "netCash"),
        costBasis: optNum(r.attrs, "costBasis", "cost"),
        fifoPnlRealized: optNum(r.attrs, "fifoPnlRealized"),
        openClose: pick(r.attrs, "openCloseIndicator"),
        orderType: pick(r.attrs, "orderType"),
        reportDate: optDate(r.attrs, "reportDate"),
        raw: r.raw,
      });
    } else if (level === "CLOSED_LOT") {
      const closeDate = parseFlexDate(pick(r.attrs, "tradeDate", "dateTime", "reportDate"));
      if (closeDate === null) c.issue("tradeDate");
      closedLots.push({
        conid: c.int(r.attrs, "conid", "conid"),
        symbol: c.str(r.attrs, "symbol", "symbol"),
        currency: c.str(r.attrs, "currency", "currency"),
        fxRateToBase: optNum(r.attrs, "fxRateToBase"),
        openDateTime: optStamp(r.attrs, "openDateTime"),
        closeDate: closeDate ?? "",
        closingTradeId: pick(r.attrs, "tradeID"),
        quantity: Math.abs(c.num(r.attrs, "quantity", "quantity")),
        costBasis: c.num(r.attrs, "costBasis", "costBasis", "cost"),
        proceeds: optNum(r.attrs, "proceeds"),
        fifoPnlRealized: c.num(r.attrs, "fifoPnlRealized", "fifoPnlRealized"),
        raw: r.raw,
      });
    } else {
      bump(`trades:${level}`);
    }
  });

  // cash transactions
  const cash: FlexCashTransaction[] = [];
  c.section = "cashTransactions";
  sectionRows("cashTransactions").forEach((r, i) => {
    c.row = i + 1;
    const when = c.dateTime(r.attrs, "dateTime", "dateTime", "date", "reportDate");
    const typeRaw = c.str(r.attrs, "type", "type");
    cash.push({
      occurredAt: stamp(when),
      reportDate: optDate(r.attrs, "reportDate"),
      currency: c.str(r.attrs, "currency", "currency"),
      fxRateToBase: optNum(r.attrs, "fxRateToBase"),
      amount: c.num(r.attrs, "amount", "amount"),
      typeRaw,
      category: categorizeCashType(typeRaw),
      conid: optInt(r.attrs, "conid"),
      isin: pick(r.attrs, "isin"),
      symbol: pick(r.attrs, "symbol"),
      description: pick(r.attrs, "description"),
      tradeId: pick(r.attrs, "tradeID"),
      code: pick(r.attrs, "code"),
      raw: r.raw,
    });
  });

  // currency conversion rates
  const fxRates: FlexFxRate[] = [];
  c.section = "conversionRates";
  sectionRows("conversionRates").forEach((r, i) => {
    c.row = i + 1;
    fxRates.push({
      rateDate: c.dateTime(r.attrs, "reportDate", "reportDate", "date", "dateTime").date,
      fromCcy: c.str(r.attrs, "fromCurrency", "fromCurrency"),
      toCcy: c.str(r.attrs, "toCurrency", "toCurrency"),
      rate: c.num(r.attrs, "rate", "rate"),
    });
  });

  // NAV summary in base
  const nav: FlexNav[] = [];
  c.section = "nav";
  sectionRows("nav").forEach((r, i) => {
    c.row = i + 1;
    const parts = ["options", "bonds", "interestAccruals", "dividendAccruals"].map((n) => optNum(r.attrs, n));
    const present = parts.filter((p): p is number => p !== null);
    nav.push({
      reportDate: c.date(r.attrs, "reportDate", "reportDate"),
      currency: pick(r.attrs, "currency") ?? baseCurrency,
      cash: optNum(r.attrs, "cash"),
      stock: optNum(r.attrs, "stock"),
      other: present.length === 0 ? null : Math.round(present.reduce((a, b) => a + b, 0) * 1e8) / 1e8,
      total: c.num(r.attrs, "total", "total"),
    });
  });

  // corporate actions and transfers (coverage disclosure only)
  const mapAction = (kind: "corporate_action" | "transfer") => (r: Row): FlexCorporateAction => ({
    kind,
    occurredAt: optStamp(r.attrs, "dateTime", "date", "reportDate"),
    conid: optInt(r.attrs, "conid"),
    symbol: pick(r.attrs, "symbol"),
    typeRaw: pick(r.attrs, "type"),
    quantity: optNum(r.attrs, "quantity"),
    amount: optNum(r.attrs, "amount", "positionAmount"),
    currency: pick(r.attrs, "currency"),
    code: pick(r.attrs, "code"),
    raw: r.raw,
  });
  const corporateActions = sectionRows("corporateActions").map(mapAction("corporate_action"));
  const transfers = sectionRows("transfers").map(mapAction("transfer"));

  const dividendAccruals: FlexDividendAccrual[] = sectionRows("dividendAccruals").map((r) => ({
    exDate: optDate(r.attrs, "exDate"),
    payDate: optDate(r.attrs, "payDate"),
    conid: optInt(r.attrs, "conid"),
    symbol: pick(r.attrs, "symbol"),
    currency: pick(r.attrs, "currency"),
    quantity: optNum(r.attrs, "quantity"),
    grossRate: optNum(r.attrs, "grossRate"),
    grossAmount: optNum(r.attrs, "grossAmount"),
    tax: optNum(r.attrs, "tax"),
    netAmount: optNum(r.attrs, "netAmount"),
    raw: r.raw,
  }));

  const instruments: FlexInstrument[] = [];
  sectionRows("financialInstruments").forEach((r) => {
    const conid = optInt(r.attrs, "conid");
    const symbol = pick(r.attrs, "symbol");
    if (conid === null || symbol === null) {
      bump("instruments:incomplete");
      return;
    }
    instruments.push({
      conid, symbol, isin: pick(r.attrs, "isin"), subCategory: pick(r.attrs, "subCategory"), listingExchange: pick(r.attrs, "listingExchange"),
      description: pick(r.attrs, "description"), raw: r.raw,
    });
  });

  if (c.issues.length > 0) {
    const first = c.issues[0] as ParseIssue;
    return fail("parse_error", `${c.issues.length} required value(s) missing or unreadable, first: ${first.section} row ${first.row} ${first.field}.`, c.issues.slice(0, 50));
  }

  // Open Positions carries no listing exchange or sub-category: Financial Instrument Information supplies them (research flex 2.2)
  const byConid = new Map(instruments.map((i) => [i.conid, i]));
  for (const p of positions) {
    const info = byConid.get(p.conid);
    if (info === undefined) continue;
    p.subCategory ??= info.subCategory;
    p.listingExchange ??= info.listingExchange;
    p.isin ??= info.isin;
    p.description ??= info.description;
  }
  for (const t of trades) {
    const info = byConid.get(t.conid);
    if (info === undefined) continue;
    t.listingExchange ??= info.listingExchange;
    t.isin ??= info.isin;
  }

  const warnings: string[] = [];
  if (closedLots.length === 0 && trades.some((t) => t.fifoPnlRealized !== null && t.fifoPnlRealized !== 0)) warnings.push("closed_lots_not_included");

  return {
    ok: true,
    statement: {
      accountId, baseCurrency, accountType, fromDate, toDate, whenGenerated: whenGenerated === null ? null : stamp(whenGenerated),
      positions, trades, closedLots, cashTransactions: cash, fxRates, nav, corporateActions, transfers, dividendAccruals, instruments,
      sections,
      attributesSeen: Object.fromEntries(SECTION_KEYS.map((k) => [k, [...seen[k]].sort()])) as Record<SectionKey, string[]>,
      ignored,
      warnings,
    },
  };
}

// ------------------------------------------------------------------------------------------------ link verification (spec 12.3)

export interface SectionReport {
  section: string;
  present: boolean;
  missingFields: string[];
}

const REQUIRED: Array<{ key: SectionKey; label: string; fields: Array<[string, string[]]> }> = [
  { key: "accountInformation", label: "Account Information", fields: [["Account ID", ["accountid"]], ["Currency", ["currency"]]] },
  {
    key: "openPositions",
    label: "Open Positions",
    fields: [
      ["Currency", ["currency"]], ["Asset Class", ["assetcategory", "assetclass"]], ["FX Rate to Base", ["fxratetobase"]], ["Symbol", ["symbol"]],
      ["Conid", ["conid"]], ["ISIN", ["isin"]], ["Report Date", ["reportdate"]], ["Quantity", ["position", "quantity"]], ["Mark Price", ["markprice"]],
      ["Position Value", ["positionvalue"]], ["Cost Basis Price", ["costbasisprice"]], ["Cost Basis Money", ["costbasismoney"]],
      ["FIFO Unrealized PNL", ["fifopnlunrealized"]], ["Level of Detail", ["levelofdetail"]],
    ],
  },
  {
    key: "trades",
    label: "Trades",
    fields: [
      ["Currency", ["currency"]], ["FX Rate to Base", ["fxratetobase"]], ["Symbol", ["symbol"]], ["Conid", ["conid"]], ["Trade ID", ["tradeid"]],
      ["Trade Date", ["tradedate"]], ["Quantity", ["quantity"]], ["Trade Price", ["tradeprice"]], ["IB Commission", ["ibcommission"]],
      ["IB Commission Currency", ["ibcommissioncurrency"]], ["Buy/Sell", ["buysell"]], ["IB Order ID", ["iborderid"]], ["IB Execution ID", ["ibexecid"]],
      ["Net Cash", ["netcash"]], ["Realized PNL", ["fifopnlrealized"]], ["Level of Detail", ["levelofdetail"]],
    ],
  },
  {
    key: "cashTransactions",
    label: "Cash Transactions",
    fields: [["Currency", ["currency"]], ["FX Rate to Base", ["fxratetobase"]], ["Date/Time", ["datetime"]], ["Amount", ["amount"]], ["Type", ["type"]]],
  },
  {
    key: "conversionRates",
    label: "Currency Conversion Rate",
    fields: [["Date/Time", ["reportdate", "date", "datetime"]], ["From Currency", ["fromcurrency"]], ["To Currency", ["tocurrency"]], ["Rate", ["rate"]]],
  },
  {
    key: "financialInstruments",
    label: "Financial Instrument Information",
    fields: [["Symbol", ["symbol"]], ["Conid", ["conid"]], ["Subcategory", ["subcategory"]], ["Listing Exchange", ["listingexchange"]], ["ISIN", ["isin"]]],
  },
];

/** Which required sections and fields are present; a field is missing when no row of its section carries any alias of it. */
export function requiredSectionReport(s: FlexStatement): SectionReport[] {
  return REQUIRED.map((req) => {
    const present = s.sections[req.key];
    const seen = new Set(s.attributesSeen[req.key]);
    const hasRows = seen.size > 0;
    const missingFields = present && hasRows ? req.fields.filter(([, aliases]) => !aliases.some((a) => seen.has(a))).map(([label]) => label) : [];
    return { section: req.label, present, missingFields };
  });
}
```

Run: `deno test -A --config supabase/functions/deno.json supabase/functions/_shared/adapters/flex-parse.test.ts`
Expected: PASS (15 tests). If a fixture assertion fails because of an attribute spelling, fix the **parser alias table** first (never loosen the test): the table is the one place where the P5-01 real statement will change spellings.

- [ ] **Step 13: Type-check, lint, run all Deno tests and commit**

Run:

```powershell
bun run functions:check
bun run functions:test
bun run test:core flex-errors
bun run lint:fix
bun run lint
```

Expected: all exit 0.

```text
git add supabase/functions/_shared supabase/functions/broker-sync supabase/functions/portfolio-refresh supabase/config.toml supabase/functions/.env.example
git commit -m "feat(broker): add Flex client, tolerant statement parser with fixture, AES-GCM token crypto, error table and function scaffolds"
```

---

## Task 3: `core/accounting.ts` (spec 4.9)

**Concurrency:** may run at the same time as Tasks 1 and 2 (disjoint files).

**Files:**
- Create: `supabase/functions/_shared/core/accounting.ts`
- Create: `supabase/functions/_shared/core/accounting.test.ts`

**Interfaces:**
- Consumes: `core/calendar.ts` (`dayNumber(y, m, d)`, P1; used only to measure the age of an FX rate in whole days).
- Produces: the exact spec 4.9 exports (`Money`, `FxRate`, `Position`, `ClosedLot`, `CashTx`, `averageCostPerUnit`, `marketValue`, `unrealizedPnl`, `reconcileUnrealized`, `convertMoney`, `sumInBase`, `realizedSummary`, `dividendSummary`, `commissionSummary`, `dailyPnlEstimate`, `combinedPerformance`) plus additive helpers used by Tasks 5 and 8: `ok`, `unavailable`, `sumInBasePartial`, `otherCostsSummary`, `afterOtherCosts`, `flexRateFor`, `performanceSeries`, `canReconcile`.
- Sign conventions fixed here: unrealized P&L = value minus cost (positive when value exceeds cost, short positions included); Flex commissions are negative numbers and `commissionSummary` returns the total cost as a positive number; withholding tax amounts are negative and `dividendSummary.withholdingBase` keeps that sign so that `net = gross + withholding`.

- [ ] **Step 1: Write the failing tests**

`supabase/functions/_shared/core/accounting.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  type CashTx,
  type ClosedLot,
  type FxRate,
  type Money,
  type Position,
  afterOtherCosts,
  averageCostPerUnit,
  canReconcile,
  combinedPerformance,
  commissionSummary,
  convertMoney,
  dailyPnlEstimate,
  dividendSummary,
  flexRateFor,
  marketValue,
  ok,
  otherCostsSummary,
  performanceSeries,
  realizedSummary,
  reconcileUnrealized,
  sumInBase,
  sumInBasePartial,
  unavailable,
  unrealizedPnl,
} from "./accounting.ts";

const pos = (o: Partial<Position> = {}): Position => ({
  conid: 100001,
  ccy: "USD",
  qty: 10,
  multiplier: 1,
  costBasisMoney: 2001.7,
  markPrice: 230,
  fifoUnrealized: 298.3,
  fxToBase: 0.92,
  ...o,
});

const flex = (rate: number, rateDate = "2026-10-14"): FxRate => ({ rate, rateDate, source: "flex" });

function value(m: Money): number {
  if (m.kind !== "ok") throw new Error(`expected ok, got unavailable: ${m.reason}`);
  return m.value;
}

describe("average cost, market value, unrealized P&L", () => {
  it("average cost per unit is cost basis money over quantity times multiplier", () => {
    expect(averageCostPerUnit(pos())).toBeCloseTo(200.17, 10);
    expect(averageCostPerUnit(pos({ qty: 0 }))).toBeNull();
    expect(averageCostPerUnit(pos({ qty: 2, multiplier: 100, costBasisMoney: 4000 }))).toBe(20);
    expect(averageCostPerUnit(pos({ qty: -10, costBasisMoney: -2000 }))).toBe(200);
  });

  it("market value is qty * multiplier * price", () => {
    expect(marketValue(pos(), 230)).toBe(2300);
    expect(marketValue(pos({ qty: 2, multiplier: 100 }), 5.5)).toBe(1100);
  });

  it("unrealized P&L is value minus cost: positive when value exceeds cost, never cost minus value", () => {
    expect(unrealizedPnl(pos(), 230)).toBeCloseTo(298.3, 10);
    expect(unrealizedPnl(pos(), 150)).toBeCloseTo(-501.7, 10);
    expect(unrealizedPnl(pos({ qty: -10, costBasisMoney: -2000 }), 190)).toBeCloseTo(100, 10); // short: price fell, gain
    expect(unrealizedPnl(pos({ qty: -10, costBasisMoney: -2000 }), 210)).toBeCloseTo(-100, 10);
  });
});

describe("reconciliation against the Flex FIFO unrealized value", () => {
  it("agrees within 0.01 + 1e-6 * |cost|", () => {
    expect(reconcileUnrealized(pos()).withinTolerance).toBe(true);
    expect(reconcileUnrealized(pos({ fifoUnrealized: 298.305 })).withinTolerance).toBe(true);
    expect(reconcileUnrealized(pos({ fifoUnrealized: 298.32 })).withinTolerance).toBe(false);
    const big = pos({ qty: 1000, costBasisMoney: 1_000_000, markPrice: 1000.5, fifoUnrealized: 500 });
    expect(reconcileUnrealized(big).diff).toBe(0);
    expect(reconcileUnrealized({ ...big, fifoUnrealized: 500.9 }).withinTolerance).toBe(true); // 0.9 <= 0.01 + 1
    expect(reconcileUnrealized({ ...big, fifoUnrealized: 502 }).withinTolerance).toBe(false);
  });

  it("reports the signed difference and flags missing inputs as not comparable", () => {
    expect(reconcileUnrealized(pos({ fifoUnrealized: 290 })).diff).toBeCloseTo(8.3, 10);
    const missing = reconcileUnrealized(pos({ markPrice: null }));
    expect(Number.isNaN(missing.diff)).toBe(true);
    expect(missing.withinTolerance).toBe(false);
    expect(canReconcile(pos())).toBe(true);
    expect(canReconcile(pos({ fifoUnrealized: null }))).toBe(false);
  });
});

describe("convertMoney and sumInBase", () => {
  it("same currency needs no rate; a rate converts; a missing or invalid rate is unavailable with a reason", () => {
    expect(convertMoney(10, "EUR", "EUR", null)).toEqual(ok(10, "EUR"));
    expect(convertMoney(10, "USD", "EUR", flex(0.92))).toEqual(ok(9.2, "EUR"));
    const missing = convertMoney(10, "USD", "EUR", null);
    expect(missing.kind).toBe("unavailable");
    if (missing.kind === "unavailable") expect(missing.reason).toContain("USD->EUR");
    expect(convertMoney(10, "USD", "EUR", flex(0)).kind).toBe("unavailable");
    expect(convertMoney(10, "USD", "EUR", flex(Number.NaN)).kind).toBe("unavailable");
  });

  it("an unavailable item makes the sum unavailable unless the caller asks for a partial sum", () => {
    const items = [ok(1, "EUR"), unavailable("no fx"), ok(2, "EUR")];
    expect(sumInBase(items)).toEqual(unavailable("no fx"));
    expect(sumInBase(items, { partial: true })).toEqual(ok(3, "EUR"));
    expect(sumInBase([ok(1, "EUR"), ok(2.5, "EUR")])).toEqual(ok(3.5, "EUR"));
  });

  it("never sums mixed currencies and handles the empty list explicitly", () => {
    expect(sumInBase([ok(1, "EUR"), ok(1, "USD")]).kind).toBe("unavailable");
    expect(sumInBase([], { ccy: "EUR" })).toEqual(ok(0, "EUR"));
    expect(sumInBase([]).kind).toBe("unavailable");
    expect(sumInBase([unavailable("x")], { partial: true }).kind).toBe("unavailable");
  });

  it("sumInBasePartial reports what was left out", () => {
    const r = sumInBasePartial([ok(1, "EUR"), unavailable("a"), ok(2, "EUR"), unavailable("b")]);
    expect(r.total).toEqual(ok(3, "EUR"));
    expect(r.excluded).toBe(2);
    expect(r.reasons).toEqual(["a", "b"]);
    expect(sumInBasePartial([unavailable("a")]).total.kind).toBe("unavailable");
  });
});

describe("realized P&L over closed lots (partial sales, no double counting)", () => {
  const lotA: ClosedLot = { conid: 100002, ccy: "GBP", qty: 3, costBasis: 75, proceeds: 79.5, realizedPnl: 4.2, closeDate: "2026-10-08", fxToBase: 1.15, key: "a" };
  const lotB: ClosedLot = { conid: 100002, ccy: "GBP", qty: 1, costBasis: 26, proceeds: 26.5, realizedPnl: 0.4, closeDate: "2026-10-08", fxToBase: 1.15, key: "b" };

  it("the lots of one partial sale add up to the execution P/L (4.60) and convert with each row's rate", () => {
    const r = realizedSummary([lotA, lotB], "EUR");
    expect(r.lotCount).toBe(2);
    expect(r.byCcy["GBP"]).toBeCloseTo(4.6, 10);
    expect(value(r.realizedBase)).toBeCloseTo(4.6 * 1.15, 10);
  });

  it("a lot that arrives twice (overlapping statements) is counted once", () => {
    const r = realizedSummary([lotA, lotB, { ...lotA }], "EUR");
    expect(r.lotCount).toBe(2);
    expect(r.byCcy["GBP"]).toBeCloseTo(4.6, 10);
  });

  it("losses and gains are both included; the sign is the broker's", () => {
    const loss: ClosedLot = { ...lotA, key: "c", realizedPnl: -10 };
    expect(realizedSummary([lotA, loss], "GBP").byCcy["GBP"]).toBeCloseTo(-5.8, 10);
  });

  it("a lot in the base currency needs no rate; a missing rate makes the base figure unavailable but keeps the native sums", () => {
    const eur: ClosedLot = { ...lotA, ccy: "EUR", fxToBase: null, key: "e" };
    expect(value(realizedSummary([eur], "EUR").realizedBase)).toBeCloseTo(4.2, 10);
    const noRate = realizedSummary([{ ...lotA, fxToBase: null }, lotB], "EUR");
    expect(noRate.realizedBase.kind).toBe("unavailable");
    expect(noRate.byCcy["GBP"]).toBeCloseTo(4.6, 10);
  });

  it("no lots is a real zero in the base currency", () => {
    expect(realizedSummary([], "EUR")).toEqual({ realizedBase: ok(0, "EUR"), byCcy: {}, lotCount: 0 });
  });
});

describe("dividends gross, withholding, net", () => {
  const tx = (o: Partial<CashTx>): CashTx => ({ date: "2026-10-10", ccy: "USD", amount: 0, category: "dividend", conid: 100001, fxToBase: 0.92, ...o });

  it("gross and withholding are separate and net is their sum; other categories are excluded", () => {
    const r = dividendSummary(
      [tx({ amount: 2.6 }), tx({ amount: -0.39, category: "withholding_tax" }), tx({ amount: 5000, category: "deposit_withdrawal", ccy: "EUR", fxToBase: 1 }), tx({ amount: -2, category: "fee", ccy: "EUR", fxToBase: 1 })],
      "EUR",
    );
    expect(value(r.grossBase)).toBeCloseTo(2.392, 10);
    expect(value(r.withholdingBase)).toBeCloseTo(-0.3588, 10);
    expect(value(r.netBase)).toBeCloseTo(2.0332, 10);
  });

  it("a missing rate makes gross and net unavailable (never zero)", () => {
    const r = dividendSummary([tx({ amount: 2.6, fxToBase: null })], "EUR");
    expect(r.grossBase.kind).toBe("unavailable");
    expect(r.netBase.kind).toBe("unavailable");
    expect(value(r.withholdingBase)).toBe(0);
  });

  it("no dividend rows is a real zero", () => {
    expect(dividendSummary([], "EUR").netBase).toEqual(ok(0, "EUR"));
  });
});

describe("commissions and other costs", () => {
  it("commissionSummary returns the total cost as a positive number, converted per row", () => {
    const m = commissionSummary(
      [{ commission: -1, ccy: "USD", fxToBase: 0.92 }, { commission: -0.7, ccy: "USD", fxToBase: 0.92 }, { commission: -0.4, ccy: "GBP", fxToBase: 1.15 }],
      "EUR",
    );
    expect(value(m)).toBeCloseTo(1.7 * 0.92 + 0.4 * 1.15, 10);
  });

  it("a commission in a currency without a rate is unavailable; none is zero", () => {
    expect(commissionSummary([{ commission: -1, ccy: "USD", fxToBase: null }], "EUR").kind).toBe("unavailable");
    expect(commissionSummary([], "EUR")).toEqual(ok(0, "EUR"));
  });

  it("other costs are fees and interest (net outflow positive), outside realized P&L", () => {
    const tx = (o: Partial<CashTx>): CashTx => ({ date: "2026-10-01", ccy: "EUR", amount: 0, category: "fee", conid: null, fxToBase: 1, ...o });
    const m = otherCostsSummary([tx({ amount: -2 }), tx({ amount: -1.5, category: "interest" }), tx({ amount: 0.5, category: "interest" }), tx({ amount: 9, category: "dividend" })], "EUR");
    expect(value(m)).toBeCloseTo(3, 10);
  });
});

describe("daily P&L estimate", () => {
  it("is qty * multiplier * (last - previous close) in the position currency", () => {
    expect(dailyPnlEstimate(pos(), 230, 228)).toEqual(ok(20, "USD"));
    expect(dailyPnlEstimate(pos({ qty: 2, multiplier: 100 }), 5, 5.5)).toEqual(ok(-100, "USD"));
  });

  it("is unavailable without a previous close", () => {
    expect(dailyPnlEstimate(pos(), 230, null).kind).toBe("unavailable");
    expect(dailyPnlEstimate(pos(), 230, Number.NaN).kind).toBe("unavailable");
  });
});

describe("combined performance and the dividends toggle", () => {
  const realized = ok(100, "EUR");
  const unrealized = ok(50, "EUR");
  const dividends = ok(10, "EUR");

  it("excluding dividends is realized + unrealized; including adds net dividends", () => {
    expect(combinedPerformance({ realized, unrealized, dividendsNet: dividends, includeDividends: false })).toEqual(ok(150, "EUR"));
    expect(combinedPerformance({ realized, unrealized, dividendsNet: dividends, includeDividends: true })).toEqual(ok(160, "EUR"));
  });

  it("unavailable dividends only matter when they are included", () => {
    const missing = unavailable("no fx");
    expect(combinedPerformance({ realized, unrealized, dividendsNet: missing, includeDividends: false })).toEqual(ok(150, "EUR"));
    expect(combinedPerformance({ realized, unrealized, dividendsNet: missing, includeDividends: true }).kind).toBe("unavailable");
  });

  it("an unavailable realized or unrealized figure makes the combined figure unavailable", () => {
    expect(combinedPerformance({ realized: unavailable("x"), unrealized, dividendsNet: dividends, includeDividends: false }).kind).toBe("unavailable");
    expect(combinedPerformance({ realized, unrealized: unavailable("y"), dividendsNet: dividends, includeDividends: true }).kind).toBe("unavailable");
  });

  it("after other costs subtracts the cost memo once", () => {
    expect(afterOtherCosts(ok(150, "EUR"), ok(3, "EUR"))).toEqual(ok(147, "EUR"));
    expect(afterOtherCosts(ok(150, "EUR"), unavailable("z")).kind).toBe("unavailable");
    expect(afterOtherCosts(ok(150, "EUR"), ok(3, "USD")).kind).toBe("unavailable");
  });
});

describe("Flex conversion rates by date", () => {
  const rates = [
    { rateDate: "2026-10-14", fromCcy: "USD", toCcy: "EUR", rate: 0.92 },
    { rateDate: "2026-10-09", fromCcy: "GBP", toCcy: "EUR", rate: 1.14 },
  ];

  it("uses the exact date, else the latest earlier rate within five days, else nothing", () => {
    expect(flexRateFor(rates, "USD", "EUR", "2026-10-14")).toEqual({ rate: 0.92, rateDate: "2026-10-14", source: "flex" });
    expect(flexRateFor(rates, "GBP", "EUR", "2026-10-13")).toEqual({ rate: 1.14, rateDate: "2026-10-09", source: "flex" });
    expect(flexRateFor(rates, "GBP", "EUR", "2026-10-20")).toBeNull();
    expect(flexRateFor(rates, "CHF", "EUR", "2026-10-14")).toBeNull();
    expect(flexRateFor(rates, "EUR", "EUR", "2026-10-14")).toEqual({ rate: 1, rateDate: "2026-10-14", source: "flex" });
  });

  it("uses the inverse of the opposite pair when only that one exists", () => {
    const r = flexRateFor(rates, "EUR", "USD", "2026-10-14");
    expect(r?.rate).toBeCloseTo(1 / 0.92, 10);
  });

  it("a rate dated after the requested day is never used", () => {
    expect(flexRateFor(rates, "USD", "EUR", "2026-10-13")).toBeNull();
  });
});

describe("performance series (NAV minus net deposits)", () => {
  const nav = [
    { date: "2026-10-01", total: 1000, ccy: "EUR" },
    { date: "2026-10-05", total: 1500, ccy: "EUR" },
    { date: "2026-10-10", total: 1520, ccy: "EUR" },
  ];
  const dep = (date: string, amount: number): CashTx => ({ date, ccy: "EUR", amount, category: "deposit_withdrawal", conid: null, fxToBase: 1 });

  it("subtracts cumulative net flows after the first NAV date", () => {
    const r = performanceSeries(nav, [dep("2026-10-01", 999), dep("2026-10-03", 400), dep("2026-10-08", -100)], "EUR", { flowsComplete: true });
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") {
      expect(r.points.map((p) => p.performance)).toEqual([0, 100, 220]);
      expect(r.points.map((p) => p.netFlows)).toEqual([0, 400, 300]);
    }
  });

  it("is unavailable when flows are incomplete, NAV is too short, or a flow has no rate", () => {
    expect(performanceSeries(nav, [], "EUR", { flowsComplete: false }).kind).toBe("unavailable");
    expect(performanceSeries(nav.slice(0, 1), [], "EUR", { flowsComplete: true }).kind).toBe("unavailable");
    expect(performanceSeries(nav, [{ ...dep("2026-10-03", 5), ccy: "USD", fxToBase: null }], "EUR", { flowsComplete: true }).kind).toBe("unavailable");
  });
});
```

Run: `bun run test:core accounting`
Expected: FAIL (module not found).

- [ ] **Step 2: Implement `accounting.ts`**

`supabase/functions/_shared/core/accounting.ts`:

```ts
// Portfolio and analytics arithmetic (spec 4.9). Pure: no I/O, no clock. Inputs are rows already parsed from Flex (spec 12).
import { dayNumber } from "./calendar.ts";

export type Money = { kind: "ok"; value: number; ccy: string } | { kind: "unavailable"; reason: string };
/** Value of 1 unit of `from` in `to`. */
export interface FxRate {
  rate: number;
  rateDate: string;
  source: "flex" | "yahoo" | "frankfurter";
}
export interface Position {
  conid: number;
  ccy: string;
  qty: number;
  multiplier: number;
  costBasisMoney: number;
  markPrice: number | null;
  fifoUnrealized: number | null;
  fxToBase: number | null;
}
export interface ClosedLot {
  conid: number;
  ccy: string;
  qty: number;
  costBasis: number;
  proceeds: number;
  realizedPnl: number;
  closeDate: string;
  fxToBase: number | null;
  /** Optional identity (the database dedupe hash): a repeated key is counted once. */
  key?: string;
}
export interface CashTx {
  date: string;
  ccy: string;
  amount: number;
  category: "dividend" | "withholding_tax" | "interest" | "fee" | "deposit_withdrawal" | "other";
  conid: number | null;
  fxToBase: number | null;
}

export const ok = (value: number, ccy: string): Money => ({ kind: "ok", value, ccy });
export const unavailable = (reason: string): Money => ({ kind: "unavailable", reason });

export const RECONCILE_ABS = 0.01;
export const RECONCILE_REL = 1e-6;

/** costBasisMoney / (qty * multiplier); null when the quantity is zero. Equals the Flex `costBasisPrice`. */
export function averageCostPerUnit(p: Position): number | null {
  const units = p.qty * p.multiplier;
  return units === 0 ? null : p.costBasisMoney / units;
}

export function marketValue(p: Position, price: number): number {
  return p.qty * p.multiplier * price;
}

/** value minus cost: positive when the value exceeds the cost (never cost minus value). */
export function unrealizedPnl(p: Position, price: number): number {
  return marketValue(p, price) - p.costBasisMoney;
}

export function canReconcile(p: Position): boolean {
  return p.markPrice !== null && p.fifoUnrealized !== null && Number.isFinite(p.markPrice) && Number.isFinite(p.fifoUnrealized);
}

/** Compares qty * mult * markPrice - cost with the Flex FIFO value. `diff` is signed (calculated minus broker); NaN when an input is missing. */
export function reconcileUnrealized(p: Position): { diff: number; withinTolerance: boolean } {
  if (!canReconcile(p)) return { diff: Number.NaN, withinTolerance: false };
  const calculated = (p.markPrice as number) * p.qty * p.multiplier - p.costBasisMoney;
  const diff = calculated - (p.fifoUnrealized as number);
  return { diff, withinTolerance: Math.abs(diff) <= RECONCILE_ABS + RECONCILE_REL * Math.abs(p.costBasisMoney) };
}

export function convertMoney(amount: number, from: string, to: string, fx: FxRate | null): Money {
  if (!Number.isFinite(amount)) return unavailable("Amount is not a number");
  if (from === to) return ok(amount, to);
  if (fx === null) return unavailable(`Missing FX rate ${from}->${to}`);
  if (!Number.isFinite(fx.rate) || fx.rate <= 0) return unavailable(`Invalid FX rate ${from}->${to}`);
  return ok(amount * fx.rate, to);
}

/**
 * Sum of amounts that are already in one currency. Any unavailable item makes the sum unavailable unless `partial` is set (the caller
 * then reports what was left out, see sumInBasePartial). Mixed currencies are never added. `ccy` names the currency of an empty sum.
 */
export function sumInBase(items: readonly Money[], opts: { partial?: boolean; ccy?: string } = {}): Money {
  const oks: Array<Extract<Money, { kind: "ok" }>> = [];
  let firstBad: string | null = null;
  for (const item of items) {
    if (item.kind === "ok") oks.push(item);
    else firstBad ??= item.reason;
  }
  if (firstBad !== null && opts.partial !== true) return unavailable(firstBad);
  if (oks.length === 0) {
    if (items.length === 0 && opts.ccy !== undefined) return ok(0, opts.ccy);
    return unavailable(firstBad ?? "Nothing to sum");
  }
  const ccy = (oks[0] as Extract<Money, { kind: "ok" }>).ccy;
  if (oks.some((m) => m.ccy !== ccy)) return unavailable("Mixed currencies in sum");
  let total = 0;
  for (const m of oks) total += m.value;
  return ok(total, ccy);
}

export function sumInBasePartial(items: readonly Money[], ccy?: string): { total: Money; excluded: number; reasons: string[] } {
  const reasons = items.filter((m): m is Extract<Money, { kind: "unavailable" }> => m.kind === "unavailable").map((m) => m.reason);
  return { total: sumInBase(items, ccy === undefined ? { partial: true } : { partial: true, ccy }), excluded: reasons.length, reasons };
}

const rowRate = (fx: number | null, date: string): FxRate | null => (fx === null ? null : { rate: fx, rateDate: date, source: "flex" });

/** Sums `realizedPnl` of closed lots (partial sales appear as separate lots). Commissions are already netted by IBKR and are NOT subtracted again. */
export function realizedSummary(lots: readonly ClosedLot[], base: string): { realizedBase: Money; byCcy: Record<string, number>; lotCount: number } {
  const seen = new Set<string>();
  const byCcy: Record<string, number> = {};
  const items: Money[] = [];
  let lotCount = 0;
  for (const lot of lots) {
    if (lot.key !== undefined) {
      if (seen.has(lot.key)) continue;
      seen.add(lot.key);
    }
    lotCount += 1;
    byCcy[lot.ccy] = (byCcy[lot.ccy] ?? 0) + lot.realizedPnl;
    items.push(convertMoney(lot.realizedPnl, lot.ccy, base, rowRate(lot.fxToBase, lot.closeDate)));
  }
  return { realizedBase: sumInBase(items, { ccy: base }), byCcy, lotCount };
}

/** Gross = dividend rows, withholding = withholding-tax rows (negative amounts), net = gross + withholding. */
export function dividendSummary(tx: readonly CashTx[], base: string): { grossBase: Money; withholdingBase: Money; netBase: Money } {
  const convert = (rows: readonly CashTx[]): Money =>
    sumInBase(rows.map((r) => convertMoney(r.amount, r.ccy, base, rowRate(r.fxToBase, r.date))), { ccy: base });
  const grossBase = convert(tx.filter((t) => t.category === "dividend"));
  const withholdingBase = convert(tx.filter((t) => t.category === "withholding_tax"));
  return { grossBase, withholdingBase, netBase: sumInBase([grossBase, withholdingBase], { ccy: base }) };
}

/** Flex reports commissions as negative numbers; the result is the total cost (positive). `fxToBase` is the rate of the COMMISSION currency. */
export function commissionSummary(trades: readonly { commission: number; ccy: string; fxToBase: number | null }[], base: string): Money {
  return sumInBase(trades.map((t) => convertMoney(-t.commission, t.ccy, base, rowRate(t.fxToBase, ""))), { ccy: base });
}

/** Fees and interest from Cash Transactions as a net cost (positive = money out). They are NOT inside the Flex realized P/L. */
export function otherCostsSummary(tx: readonly CashTx[], base: string): Money {
  return sumInBase(
    tx.filter((t) => t.category === "fee" || t.category === "interest").map((t) => convertMoney(-t.amount, t.ccy, base, rowRate(t.fxToBase, t.date))),
    { ccy: base },
  );
}

/** qty * multiplier * (last - previous close), in the position currency; both prices must already be in that currency. Labelled "estimated". */
export function dailyPnlEstimate(p: Position, last: number, prevClose: number | null): Money {
  if (prevClose === null || !Number.isFinite(prevClose) || !Number.isFinite(last)) return unavailable("Previous close unavailable");
  return ok(p.qty * p.multiplier * (last - prevClose), p.ccy);
}

export function combinedPerformance(a: { realized: Money; unrealized: Money; dividendsNet: Money; includeDividends: boolean }): Money {
  return sumInBase(a.includeDividends ? [a.realized, a.unrealized, a.dividendsNet] : [a.realized, a.unrealized]);
}

/** Combined performance minus the other-costs memo (fees and interest), shown as a separate "after other costs" line. */
export function afterOtherCosts(combined: Money, otherCosts: Money): Money {
  if (combined.kind === "unavailable") return combined;
  if (otherCosts.kind === "unavailable") return otherCosts;
  if (combined.ccy !== otherCosts.ccy) return unavailable("Mixed currencies in sum");
  return ok(combined.value - otherCosts.value, combined.ccy);
}

export interface FlexRateRow {
  rateDate: string;
  fromCcy: string;
  toCcy: string;
  rate: number;
}

const dayOf = (iso: string): number => {
  const [y, m, d] = iso.split("-").map(Number);
  return dayNumber(y as number, m as number, d as number);
};

/**
 * Flex Currency Conversion Rate for `from` -> `to`: the exact date, else the latest rate dated BEFORE it within `maxAgeDays`;
 * the inverse of the opposite pair is used when only that exists. Never a rate from the future.
 */
export function flexRateFor(rates: readonly FlexRateRow[], from: string, to: string, date: string, maxAgeDays = 5): FxRate | null {
  if (from === to) return { rate: 1, rateDate: date, source: "flex" };
  const target = dayOf(date);
  const best = (a: string, b: string): FlexRateRow | null => {
    let found: FlexRateRow | null = null;
    for (const r of rates) {
      if (r.fromCcy !== a || r.toCcy !== b) continue;
      const age = target - dayOf(r.rateDate);
      if (age < 0 || age > maxAgeDays) continue;
      if (found === null || r.rateDate > found.rateDate) found = r;
    }
    return found;
  };
  const direct = best(from, to);
  if (direct !== null) return { rate: direct.rate, rateDate: direct.rateDate, source: "flex" };
  const inverse = best(to, from);
  if (inverse !== null && inverse.rate > 0) return { rate: 1 / inverse.rate, rateDate: inverse.rateDate, source: "flex" };
  return null;
}

export interface NavPoint {
  date: string;
  total: number;
  ccy: string;
}
export interface PerformancePoint {
  date: string;
  nav: number;
  netFlows: number;
  performance: number;
}

/** NAV minus cumulative net deposits/withdrawals after the first NAV date (spec 12.9). Unavailable when flows are missing or unvalued. */
export function performanceSeries(
  nav: readonly NavPoint[],
  flows: readonly CashTx[],
  base: string,
  o: { flowsComplete: boolean },
): { kind: "ok"; points: PerformancePoint[] } | { kind: "unavailable"; reason: string } {
  if (!o.flowsComplete) return { kind: "unavailable", reason: "Transfers or other flows are not valued" };
  const sorted = [...nav].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  if (sorted.length < 2) return { kind: "unavailable", reason: "Fewer than two NAV rows" };
  if (sorted.some((n) => n.ccy !== base)) return { kind: "unavailable", reason: "NAV is not in the base currency" };
  const first = sorted[0] as NavPoint;
  const deposits = flows.filter((f) => f.category === "deposit_withdrawal" && f.date > first.date);
  const converted = deposits.map((f) => ({ date: f.date, m: convertMoney(f.amount, f.ccy, base, rowRate(f.fxToBase, f.date)) }));
  const bad = converted.find((c) => c.m.kind === "unavailable");
  if (bad !== undefined && bad.m.kind === "unavailable") return { kind: "unavailable", reason: bad.m.reason };
  const points = sorted.map((n) => {
    let netFlows = 0;
    for (const c of converted) if (c.date <= n.date && c.m.kind === "ok") netFlows += c.m.value;
    return { date: n.date, nav: n.total, netFlows, performance: n.total - first.total - netFlows };
  });
  return { kind: "ok", points };
}
```

Run: `bun run test:core accounting`
Expected: PASS. If the `calendar.ts` export name differs (the repository version exports `dayNumber(y, m, d)`; a rename is a one-line change in `dayOf`), adapt only that helper.

- [ ] **Step 3: Check core purity, types, lint and commit**

Run:

```powershell
bun run typecheck
bun run test:core
bun run lint:fix
bun run lint
```

Expected: all exit 0 (`tools/check-core-purity.ts` passes: the module imports only `./calendar.ts` and uses no clock or randomness).

```text
git add supabase/functions/_shared/core/accounting.ts supabase/functions/_shared/core/accounting.test.ts
git commit -m "feat(core): add accounting arithmetic for positions, realized P&L, dividends, costs and performance"
```

---

## Task 4: `broker-sync` Edge Function and the `portfolio_scan` stage

**Concurrency:** starts after Tasks 1, 2 and 3 are merged. May run at the same time as Task 5 (disjoint files; Task 4 alone edits `worker-tick/stages.ts` and `adapters/settings.ts`).

**Files:**
- Replace the scaffold: `supabase/functions/broker-sync/index.ts`
- Create: `supabase/functions/broker-sync/{types,persist,matching,machine,service,handler,store,testing}.ts` and tests `persist.test.ts`, `matching.test.ts`, `machine.test.ts`, `service.test.ts`, `handler.test.ts`
- Create: `supabase/functions/_shared/adapters/risk-set.ts`, `supabase/functions/_shared/adapters/risk-set.test.ts` (shared by `broker-sync` and the `portfolio_scan` stage)
- Create: `supabase/functions/worker-tick/handlers/portfolio_scan.ts`, `supabase/functions/worker-tick/handlers/portfolio_scan.test.ts`
- Modify (one block each): `supabase/functions/worker-tick/stages.ts`, `supabase/functions/_shared/adapters/settings.ts` (+ its test expectation)

**Interfaces:**
- Consumes: Task 1 SQL (`app.broker_ingest_statement`, `app.claim_broker_runs`, `app.lease_broker_run`, `app.claim_manual_refresh` is Task 5's, `app.enqueue_manual_sync`, `app.flex_rl_take`, `app.apply_holding_tag`, `app.held_signal_securities`, `public.monitored_holdings_for`), Task 2 adapters, `@core/flex-errors.ts`, P1 (`createServiceClient`, `createQuoteCacheKv`, `systemClock`, `createYahooProvider`, `normalizeName`, `resolveCurrency`, `classifyHolding`, `stepPremium`, `computeChannel`, `freshnessOf`, `HandlerContext`, `Seeder`, `DeferError`, `handleFetchBars`, `fetchByIds`, `upsertChunks`, `dayOfDate`), P2 (`risk_monitor_state`).
- Produces: user actions `link`, `test`, `sync`, `unlink`; worker actions `tick`, `rekey`, `ingest_fixture`; `advanceRun`, `runUntilSettled`, `workerTick`, `processStatement`; `matchPosition`, `matchUserPositions`; `monitoredReasons`, `refreshRiskSet`; `toIngestPayload`; `handlePortfolioScan`, `seedPortfolioScan`.

### Behaviour reference (what the tests below pin)

| Run state | Step | Transition |
|---|---|---|
| `queued` | decrypt the token (a failure ends the run with code `-2`, no Flex call), `SendRequest` | success: `requested`, reference code stored, `next_poll_at = now + 5 s`; retryable error: stays `queued`, `next_poll_at = now + retryAfter`, after 5 sends code `-5`; fatal: `failed`; 1012: `expired` |
| `requested` / `polling` / `parsing` | `GetStatement` | statement: `parsing` then `done` (ingest, matching, risk set); retryable: `polling`, `poll_count + 1` (not for 1018), delay `POLL_DELAYS_S[poll_count - 1]`, the 10th failed poll ends the run with `-4`; 1017: one restart as `queued`, then `failed`; fatal: `failed`; 1012: `expired` |
| parse failure | nothing written | `failed`, code `-1`; missing required section or field: code `-6` with the checklist in `rows_summary.sections` |
| account changed | nothing written | `failed`, code `-3` (a `verify` run may switch accounts: the old broker data is deleted first) |

A successful `verify` run sets the connection `linked`, `last_verified_at`, and (first link only) queues one 365-day `backfill` run. Matching and risk-set failures never fail a sync: they are recorded in `rows_summary` and retried by the next sync and the `portfolio_scan` stage.

- [ ] **Step 1: Types and ports**

`supabase/functions/broker-sync/types.ts`:

```ts
import type { Sealed } from "@adapters/crypto.ts";
import type { FlexClient } from "@adapters/flex.ts";
import type { ParseResult } from "@adapters/flex-parse.ts";
import type { IngestPayload } from "./persist.ts";

export type BrokerStatus = "unlinked" | "linking" | "linked" | "error" | "expired";
export type SyncState = "queued" | "requested" | "polling" | "parsing" | "done" | "failed" | "expired";
export type RunKind = "verify" | "daily" | "manual" | "backfill";

export const ACTIVE_STATES: readonly SyncState[] = ["queued", "requested", "polling", "parsing"];
export const isTerminal = (state: SyncState): boolean => !ACTIVE_STATES.includes(state);

export interface ConnectionRow {
  id: string;
  user_id: string;
  status: BrokerStatus;
  /** PostgREST bytea hex (`\x...`); never leaves this function */
  flex_token_ciphertext: string | null;
  flex_token_iv: string | null;
  key_version: number | null;
  token_expires_on: string | null;
  query_id: string | null;
  account_id_masked: string | null;
  base_currency: string | null;
  account_type: string | null;
  linked_at: string | null;
  last_verified_at: string | null;
  last_sync_at: string | null;
  last_statement_date: string | null;
  last_error_code: number | null;
  last_error_message: string | null;
  last_error_at: string | null;
  next_flex_fetch_not_before: string | null;
  coverage_from: string | null;
}

export interface RunRow {
  id: string;
  user_id: string;
  connection_id: string;
  kind: RunKind;
  state: SyncState;
  reference_code: string | null;
  poll_count: number;
  next_poll_at: string | null;
  statement_from: string | null;
  statement_to: string | null;
  error_code: number | null;
  error_message: string | null;
  rows_summary: Record<string, unknown>;
  idempotency_key: string;
}

export interface RunPatch {
  state?: SyncState;
  reference_code?: string | null;
  requested_at?: string | null;
  last_poll_at?: string | null;
  poll_count?: number;
  next_poll_at?: string | null;
  error_code?: number | null;
  error_message?: string | null;
  rows_summary?: Record<string, unknown>;
  lease_until?: string | null;
  finished_at?: string | null;
}

export interface ConnectionPatch {
  status?: BrokerStatus;
  last_error_code?: number | null;
  last_error_message?: string | null;
  last_error_at?: string | null;
  last_verified_at?: string | null;
  linked_at?: string | null;
}

export interface AuditEvent {
  actorUserId: string | null;
  actor: "user" | "service" | "admin";
  eventType: string;
  data: Record<string, unknown>;
}

export interface SyncStore {
  getConnection(userId: string): Promise<ConnectionRow | null>;
  getConnectionById(id: string): Promise<ConnectionRow | null>;
  upsertLinking(input: { id: string; userId: string; sealed: Sealed; queryId: string; tokenExpiresOn: string }): Promise<ConnectionRow>;
  patchConnection(id: string, patch: ConnectionPatch): Promise<void>;
  zeroToken(connectionId: string): Promise<void>;
  deleteBrokerData(userId: string, o?: { includeRuns?: boolean }): Promise<void>;
  cancelActiveRuns(userId: string, reason: string): Promise<void>;
  /** null when the user already has an active run or the idempotency key exists */
  createRun(input: { userId: string; connectionId: string; kind: RunKind; statementFrom: string | null; statementTo: string | null; idempotencyKey: string }): Promise<RunRow | null>;
  getRun(id: string): Promise<RunRow | null>;
  latestActiveRun(userId: string): Promise<RunRow | null>;
  leaseRun(id: string, seconds: number): Promise<RunRow | null>;
  claimRuns(limit: number, leaseSeconds: number): Promise<RunRow[]>;
  patchRun(id: string, patch: RunPatch): Promise<RunRow>;
  enqueueManualSync(userId: string): Promise<{ runId: string | null; outcome: "created" | "busy" | "cooldown" | "not_linked"; retryAfterSeconds: number }>;
  ingest(runId: string, payload: IngestPayload): Promise<Record<string, number>>;
  listConnectionsForRekey(currentVersion: number): Promise<ConnectionRow[]>;
  rekeyConnection(id: string, sealed: Sealed): Promise<void>;
  isAdmin(userId: string): Promise<boolean>;
  audit(event: AuditEvent): Promise<void>;
}

export interface MatchSummary {
  matched: number;
  unmatched: number;
  notEquity: number;
}

export interface BrokerDeps {
  store: SyncStore;
  flex: FlexClient;
  keys: {
    seal(plain: string, ctx: { userId: string; connectionId: string }): Promise<Sealed>;
    open(sealed: Sealed, ctx: { userId: string; connectionId: string }): Promise<string>;
    currentVersion(): number;
  };
  parse(xml: string): ParseResult;
  matcher: { matchUserPositions(userId: string): Promise<MatchSummary> };
  riskSet: {
    refresh(userId: string): Promise<{ monitored: number }>;
    pause(userId: string): Promise<void>;
    remove(userId: string): Promise<void>;
  };
  now(): number;
  sleep(ms: number): Promise<void>;
  /** Run ids, counts and error codes only: never tokens, symbols, amounts or account ids. */
  log(event: string, data?: Record<string, unknown>): void;
}

export interface PublicConnection {
  id: string;
  status: BrokerStatus;
  token_expires_on: string | null;
  query_id: string | null;
  account_id_masked: string | null;
  base_currency: string | null;
  account_type: string | null;
  linked_at: string | null;
  last_verified_at: string | null;
  last_sync_at: string | null;
  last_statement_date: string | null;
  last_error_code: number | null;
  last_error_message: string | null;
  last_error_at: string | null;
  coverage_from: string | null;
}

/** Allow-list: the ciphertext, IV and key version can never be copied into a response by accident. */
export function publicConnection(c: ConnectionRow): PublicConnection {
  return {
    id: c.id,
    status: c.status,
    token_expires_on: c.token_expires_on,
    query_id: c.query_id,
    account_id_masked: c.account_id_masked,
    base_currency: c.base_currency,
    account_type: c.account_type,
    linked_at: c.linked_at,
    last_verified_at: c.last_verified_at,
    last_sync_at: c.last_sync_at,
    last_statement_date: c.last_statement_date,
    last_error_code: c.last_error_code,
    last_error_message: c.last_error_message,
    last_error_at: c.last_error_at,
    coverage_from: c.coverage_from,
  };
}

const SUMMARY_KEYS = ["positions", "trades", "closed_lots", "cash", "fx", "nav", "corporate_actions", "sections", "warnings", "match", "match_error", "restarted"];

export interface PublicRun {
  id: string;
  kind: RunKind;
  state: SyncState;
  poll_count: number;
  statement_from: string | null;
  statement_to: string | null;
  error_code: number | null;
  error_message: string | null;
  rows_summary: Record<string, unknown>;
}

export function publicRun(r: RunRow): PublicRun {
  const rows_summary: Record<string, unknown> = {};
  for (const key of SUMMARY_KEYS) if (key in r.rows_summary) rows_summary[key] = r.rows_summary[key];
  return {
    id: r.id,
    kind: r.kind,
    state: r.state,
    poll_count: r.poll_count,
    statement_from: r.statement_from,
    statement_to: r.statement_to,
    error_code: r.error_code,
    error_message: r.error_message,
    rows_summary,
  };
}
```

- [ ] **Step 2: `persist.ts` (statement -> ingest payload), test first**

`supabase/functions/broker-sync/persist.test.ts`:

```ts
import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { type FlexStatement, parseFlexStatement } from "@adapters/flex-parse.ts";
import { latestSnapshot, maskAccountId, sha256Hex, toIngestPayload } from "./persist.ts";

const XML = await Deno.readTextFile(new URL("../_shared/adapters/fixtures/flex/activity-sample.xml", import.meta.url));
const parsed = parseFlexStatement(XML);
if (!parsed.ok) throw new Error("fixture must parse");
const statement: FlexStatement = parsed.statement;
const USER = "a0000000-0000-4000-8000-00000000000a";

Deno.test("account ids are masked to the first character and the last four", () => {
  assertEquals(maskAccountId("U1234567"), "U***4567");
  assertEquals(maskAccountId("U12"), "***");
});

Deno.test("sha256Hex is stable and hex", async () => {
  assertEquals(await sha256Hex("a"), "ca978112ca1bbdbafac231b39a23dc4da786eff8147c4e72b9807785afee48bb");
});

Deno.test("meta, positions of the latest report date and snake_case columns", async () => {
  const p = await toIngestPayload(USER, statement);
  assertEquals(p.meta, { report_date: "2026-10-14", statement_from: "2026-09-15", statement_to: "2026-10-14", account_id_masked: "U***4567", base_currency: "EUR", account_type: "Individual" });
  assertEquals(p.positions.length, 2);
  assertEquals(p.positions[0]?.symbol, "AAPL");
  assertEquals(p.positions[0]?.cost_basis_money, 2001.7);
  assertEquals(p.positions[0]?.listing_exchange, "NASDAQ");
  assertEquals(p.positions[1]?.currency, "GBP");
  assertEquals(p.positions[1]?.mark_price, 27.35);
});

Deno.test("only the newest snapshot of a multi-day statement is used", () => {
  const older = { ...statement, positions: statement.positions.map((p, i) => (i === 0 ? { ...p, reportDate: "2026-10-13" } : p)) };
  const snap = latestSnapshot(older);
  assertEquals(snap.reportDate, "2026-10-14");
  assertEquals(snap.positions.map((p) => p.symbol), ["SHEL"]);
  assertEquals(latestSnapshot({ ...statement, positions: [] }).reportDate, "2026-10-14");
});

Deno.test("trades keep the broker sign, partial fills stay separate, executions are de-duplicated by key", async () => {
  const p = await toIngestPayload(USER, { ...statement, trades: [...statement.trades, ...statement.trades] });
  assertEquals(p.trades.length, 3);
  assertEquals(p.trades.map((t) => t.ib_exec_id), ["0000f001.6710a001.01.01", "0000f001.6710a002.01.01", "0000f002.6709b001.01.01"]);
  assertEquals(p.trades.filter((t) => t.ib_order_id === "5001").length, 2);
  assertEquals(p.trades[2]?.quantity, -4);
  assertEquals(p.trades[2]?.fifo_pnl_realized, 4.6);
  assertEquals(p.trades[0]?.trade_time, "09:30:01");
});

Deno.test("closed lots of one sale have distinct hashes, stable across calls, and different for another user", async () => {
  const a = await toIngestPayload(USER, statement);
  const b = await toIngestPayload(USER, statement);
  const other = await toIngestPayload("b0000000-0000-4000-8000-00000000000b", statement);
  assertEquals(a.closed_lots.length, 2);
  assertNotEquals(a.closed_lots[0]?.dedupe_hash, a.closed_lots[1]?.dedupe_hash);
  assertEquals(a.closed_lots.map((l) => l.dedupe_hash), b.closed_lots.map((l) => l.dedupe_hash));
  assertNotEquals(a.closed_lots[0]?.dedupe_hash, other.closed_lots[0]?.dedupe_hash);
  assertEquals(a.closed_lots.map((l) => l.quantity), [3, 1]);
  assertEquals(a.closed_lots.reduce((n, l) => n + l.fifo_pnl_realized, 0).toFixed(2), "4.60");
});

Deno.test("two identical cash rows in one statement keep two hashes, and the same statement hashes the same way again", async () => {
  const row = statement.cashTransactions[0];
  assert(row !== undefined);
  const p = await toIngestPayload(USER, { ...statement, cashTransactions: [row, { ...row }] });
  assertEquals(p.cash.length, 2);
  assertNotEquals(p.cash[0]?.dedupe_hash, p.cash[1]?.dedupe_hash);
  const again = await toIngestPayload(USER, { ...statement, cashTransactions: [row, { ...row }] });
  assertEquals(again.cash.map((c) => c.dedupe_hash), p.cash.map((c) => c.dedupe_hash));
});

Deno.test("cash, fx, nav and corporate actions are mapped; unknown attributes and raw rows never reach the payload", async () => {
  const p = await toIngestPayload(USER, statement);
  assertEquals(p.cash.map((c) => c.category), ["dividend", "withholding_tax", "deposit_withdrawal", "fee"]);
  assertEquals(p.cash[0]?.occurred_at, "2026-10-10T20:25:00Z");
  assertEquals(p.fx.length, 2);
  assertEquals(p.nav.map((n) => n.total), [9800.55, 9950.2]);
  assertEquals(p.corporate_actions.length, 1);
  assertEquals(p.corporate_actions[0]?.kind, "corporate_action");
  const text = JSON.stringify(p);
  assert(!text.includes("kept-in-raw"));
  assert(!text.includes("\"raw\""));
  assert(!text.includes("U1234567"));
});
```

`supabase/functions/broker-sync/persist.ts`:

```ts
// Maps a parsed Flex statement to the JSON payload of app.broker_ingest_statement. Raw rows and unknown attributes are dropped here
// (raw statements are never stored, spec 12.10); the full account id never leaves the parser (only the masked form is stored).
import type { FlexPosition, FlexStatement } from "@adapters/flex-parse.ts";

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function maskAccountId(id: string): string {
  return id.length <= 4 ? "***" : `${id.slice(0, 1)}***${id.slice(-4)}`;
}

/** Positions come from the latest report date in the file (multi-day windows: UNVERIFIED semantics, research flex 2.4). */
export function latestSnapshot(s: FlexStatement): { reportDate: string; positions: FlexPosition[] } {
  const dates = s.positions.map((p) => p.reportDate).sort();
  const reportDate = dates.length === 0 ? s.toDate : (dates[dates.length - 1] as string);
  return { reportDate, positions: s.positions.filter((p) => p.reportDate === reportDate) };
}

const lastWins = <T>(items: readonly T[], key: (item: T) => string): T[] => [...new Map(items.map((i) => [key(i), i])).values()];

export async function toIngestPayload(userId: string, s: FlexStatement) {
  const snap = latestSnapshot(s);

  const positions = snap.positions.map((p) => ({
    conid: p.conid, isin: p.isin, symbol: p.symbol, description: p.description, asset_class: p.assetClass, sub_category: p.subCategory,
    listing_exchange: p.listingExchange, currency: p.currency, fx_rate_to_base: p.fxRateToBase, quantity: p.quantity, multiplier: p.multiplier,
    mark_price: p.markPrice, position_value: p.positionValue, open_price: p.openPrice, cost_basis_price: p.costBasisPrice,
    cost_basis_money: p.costBasisMoney, fifo_pnl_unrealized: p.fifoPnlUnrealized, percent_of_nav: p.percentOfNav,
    level_of_detail: p.levelOfDetail, open_date_time: p.openDateTime,
  }));

  const trades = lastWins(s.trades, (t) => t.execId).map((t) => ({
    trade_id: t.tradeId, ib_exec_id: t.execId, ib_order_id: t.orderId, conid: t.conid, isin: t.isin, symbol: t.symbol, description: t.description,
    listing_exchange: t.listingExchange, exchange: t.exchange, currency: t.currency, fx_rate_to_base: t.fxRateToBase, trade_date: t.tradeDate,
    trade_time: t.tradeTime, settle_date: t.settleDate, buy_sell: t.buySell, quantity: t.quantity, trade_price: t.tradePrice,
    trade_money: t.tradeMoney, proceeds: t.proceeds, taxes: t.taxes, ib_commission: t.ibCommission, ib_commission_currency: t.ibCommissionCurrency,
    net_cash: t.netCash, cost_basis: t.costBasis, fifo_pnl_realized: t.fifoPnlRealized, open_close: t.openClose, order_type: t.orderType,
    report_date: t.reportDate,
  }));

  // spec 12.5: dedupe_hash = sha256(user, tradeID, openDateTime, quantity, costBasis): two lots of one sale differ by openDateTime
  const closedLots = [];
  for (const l of s.closedLots) {
    closedLots.push({
      conid: l.conid, symbol: l.symbol, currency: l.currency, fx_rate_to_base: l.fxRateToBase, open_date_time: l.openDateTime, close_date: l.closeDate,
      closing_trade_id: l.closingTradeId, quantity: l.quantity, cost_basis: l.costBasis, proceeds: l.proceeds, fifo_pnl_realized: l.fifoPnlRealized,
      dedupe_hash: await sha256Hex([userId, l.closingTradeId ?? "", l.openDateTime ?? "", l.quantity, l.costBasis].join("|")),
    });
  }

  // identical rows inside one statement get an occurrence suffix so legitimate duplicates are not collapsed, and re-ingest stays idempotent
  const occurrences = new Map<string, number>();
  const nth = (base: string): number => {
    const n = (occurrences.get(base) ?? 0) + 1;
    occurrences.set(base, n);
    return n;
  };
  const cash = [];
  for (const t of s.cashTransactions) {
    const base = [userId, t.typeRaw, t.occurredAt, t.amount, t.currency, t.conid ?? "", t.tradeId ?? "", t.code ?? "", t.description ?? ""].join("|");
    cash.push({
      occurred_at: t.occurredAt, report_date: t.reportDate, currency: t.currency, fx_rate_to_base: t.fxRateToBase, amount: t.amount, type_raw: t.typeRaw,
      category: t.category, conid: t.conid, isin: t.isin, symbol: t.symbol, description: t.description, trade_id: t.tradeId, code: t.code,
      dedupe_hash: await sha256Hex(`${base}|#${nth(`cash|${base}`)}`),
    });
  }

  const corporateActions = [];
  for (const a of [...s.corporateActions, ...s.transfers]) {
    const base = [userId, a.kind, a.occurredAt ?? "", a.conid ?? "", a.typeRaw ?? "", a.quantity ?? "", a.amount ?? "", a.code ?? ""].join("|");
    corporateActions.push({
      kind: a.kind, occurred_at: a.occurredAt, conid: a.conid, symbol: a.symbol, type_raw: a.typeRaw, quantity: a.quantity, amount: a.amount,
      currency: a.currency, code: a.code, dedupe_hash: await sha256Hex(`${base}|#${nth(`corp|${base}`)}`),
    });
  }

  const fx = lastWins(s.fxRates, (r) => `${r.rateDate}|${r.fromCcy}|${r.toCcy}`).map((r) => ({ rate_date: r.rateDate, from_ccy: r.fromCcy, to_ccy: r.toCcy, rate: r.rate }));
  const nav = lastWins(s.nav, (n) => n.reportDate).map((n) => ({ report_date: n.reportDate, currency: n.currency, cash: n.cash, stock: n.stock, other: n.other, total: n.total }));

  return {
    meta: {
      report_date: snap.reportDate,
      statement_from: s.fromDate,
      statement_to: s.toDate,
      account_id_masked: maskAccountId(s.accountId),
      base_currency: s.baseCurrency,
      account_type: s.accountType,
    },
    positions,
    trades,
    closed_lots: closedLots,
    cash,
    fx,
    nav,
    corporate_actions: corporateActions,
  };
}

export type IngestPayload = Awaited<ReturnType<typeof toIngestPayload>>;
```

Run: `deno test -A --config supabase/functions/deno.json supabase/functions/broker-sync/persist.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 3: Matching (spec 12.7), test first**

`supabase/functions/broker-sync/matching.test.ts`:

```ts
import { assertEquals } from "@std/assert";
import { type MatchPorts, type PositionRef, type SecurityLite, matchPosition, matchUserPositions, pickLine, yahooSymbolFor } from "./matching.ts";

const sec = (o: Partial<SecurityLite> & { id: string; yahoo_symbol: string }): SecurityLite => ({
  exchange_code: "NMS", currency_major: "USD", quote_type: "EQUITY", company_id: `c-${o.id}`, isin: null, is_canonical: true, ...o,
});

const pos = (o: Partial<PositionRef> = {}): PositionRef => ({
  id: 1, conid: 100001, isin: "US0378331005", symbol: "AAPL", listingExchange: "NASDAQ", currency: "USD", assetClass: "STK", subCategory: "COMMON", ...o,
});

interface FakeOpts {
  byIsin?: Record<string, SecurityLite[]>;
  bySymbol?: Record<string, SecurityLite>;
  exchanges?: Record<string, { code: string; yahooSuffix: string | null }>;
  canonical?: Record<string, SecurityLite>;
  search?: Record<string, Array<{ symbol: string; quoteType: string }>>;
  ensure?: Record<string, SecurityLite | { error: string }>;
}

function ports(o: FakeOpts = {}) {
  const calls = { isinSet: [] as Array<[string, string]>, searched: [] as string[], ensured: [] as string[] };
  const p: MatchPorts = {
    securitiesByIsin: (isin) => Promise.resolve(o.byIsin?.[isin] ?? []),
    securityBySymbol: (s) => Promise.resolve(o.bySymbol?.[s] ?? null),
    exchangeByIbkrId: (id) => Promise.resolve(o.exchanges?.[id] ?? null),
    canonicalOf: (companyId) => Promise.resolve(o.canonical?.[companyId] ?? null),
    setSecurityIsin: (id, isin) => (calls.isinSet.push([id, isin]), Promise.resolve()),
    searchIsin: (isin) => (calls.searched.push(isin), Promise.resolve(o.search?.[isin] ?? [])),
    ensureSecurity: (s) => (calls.ensured.push(s), Promise.resolve(o.ensure?.[s] ?? { error: "no_quote" })),
  };
  return { p, calls };
}

const NASDAQ = { code: "NMS", yahooSuffix: null };
const IBIS = { code: "GER", yahooSuffix: ".DE" };

Deno.test("yahooSymbolFor applies the exchange suffix and turns IBKR share-class spaces into dashes", () => {
  assertEquals(yahooSymbolFor("AAPL", null), "AAPL");
  assertEquals(yahooSymbolFor("SAP", ".DE"), "SAP.DE");
  assertEquals(yahooSymbolFor("BRK B", null), "BRK-B");
  assertEquals(yahooSymbolFor("sap", ".DE"), "SAP.DE");
});

Deno.test("pickLine prefers the listing exchange, then the position currency, then the canonical line, then the symbol", () => {
  const nms = sec({ id: "1", yahoo_symbol: "MSFT", exchange_code: "NMS", currency_major: "USD" });
  const ger = sec({ id: "2", yahoo_symbol: "MSF.DE", exchange_code: "GER", currency_major: "EUR", is_canonical: false });
  const ams = sec({ id: "3", yahoo_symbol: "MSFT.AS", exchange_code: "AMS", currency_major: "EUR", is_canonical: false });
  assertEquals(pickLine([nms, ger, ams], pos({ currency: "EUR", listingExchange: "IBIS" }), "GER")?.yahoo_symbol, "MSF.DE");
  assertEquals(pickLine([nms, ams, ger], pos({ currency: "EUR", listingExchange: null }), null)?.yahoo_symbol, "MSF.DE");
  assertEquals(pickLine([nms, ger], pos({ currency: "USD" }), null)?.yahoo_symbol, "MSFT");
  assertEquals(pickLine([], pos(), null), null);
});

Deno.test("step 1: ISIN match picks the held line (IBIS in EUR) and signals through the canonical listing", async () => {
  const nms = sec({ id: "1", yahoo_symbol: "MSFT", company_id: "co", isin: "US5949181045" });
  const ger = sec({ id: "2", yahoo_symbol: "MSF.DE", exchange_code: "GER", currency_major: "EUR", is_canonical: false, company_id: "co", isin: "US5949181045" });
  const { p } = ports({ byIsin: { US5949181045: [nms, ger] }, exchanges: { IBIS: IBIS }, canonical: { co: nms } });
  const out = await matchPosition(pos({ isin: "US5949181045", symbol: "MSF", listingExchange: "IBIS", currency: "EUR" }), p);
  assertEquals(out, { positionId: 1, securityId: "2", signalSecurityId: "1", matchStatus: "matched_isin", reason: null });
});

Deno.test("step 2: unknown ISIN searches Yahoo, stores the ISIN on the security and matches", async () => {
  const aapl = sec({ id: "9", yahoo_symbol: "AAPL", company_id: "co9" });
  const { p, calls } = ports({ search: { US0378331005: [{ symbol: "AAPL", quoteType: "EQUITY" }] }, bySymbol: { AAPL: aapl } });
  const out = await matchPosition(pos(), p);
  assertEquals(out.matchStatus, "matched_isin");
  assertEquals(out.securityId, "9");
  assertEquals(out.signalSecurityId, "9");
  assertEquals(calls.isinSet, [["9", "US0378331005"]]);
});

Deno.test("step 2: a symbol unknown to the database is created when the exchange exists, otherwise the reason is reported", async () => {
  const created = sec({ id: "n1", yahoo_symbol: "NEWCO" });
  const hit = { US1111111111: [{ symbol: "NEWCO", quoteType: "EQUITY" }] };
  const a = ports({ search: hit, ensure: { NEWCO: created } });
  assertEquals((await matchPosition(pos({ isin: "US1111111111", symbol: "NEWCO" }), a.p)).securityId, "n1");
  assertEquals(a.calls.ensured, ["NEWCO"]);
  const b = ports({ search: hit, ensure: { NEWCO: { error: "unknown_exchange" } }, exchanges: {} });
  const out = await matchPosition(pos({ isin: "US1111111111", symbol: "NEWCO", listingExchange: null }), b.p);
  assertEquals(out, { positionId: 1, securityId: null, signalSecurityId: null, matchStatus: "unmatched", reason: "unknown_exchange" });
});

Deno.test("step 3: without an ISIN, symbol plus listing exchange (NASDAQ no suffix, IBIS .DE)", async () => {
  const aapl = sec({ id: "9", yahoo_symbol: "AAPL" });
  const sap = sec({ id: "8", yahoo_symbol: "SAP.DE", exchange_code: "GER", currency_major: "EUR" });
  const { p } = ports({ bySymbol: { AAPL: aapl, "SAP.DE": sap }, exchanges: { NASDAQ: NASDAQ, IBIS: IBIS } });
  assertEquals((await matchPosition(pos({ isin: null }), p)).matchStatus, "matched_symbol_exchange");
  const out = await matchPosition(pos({ isin: null, symbol: "SAP", listingExchange: "IBIS", currency: "EUR" }), p);
  assertEquals([out.securityId, out.matchStatus], ["8", "matched_symbol_exchange"]);
});

Deno.test("never guesses: no ISIN and an unknown listing exchange, or no ISIN and no listing exchange, stay unmatched", async () => {
  const aapl = sec({ id: "9", yahoo_symbol: "AAPL" });
  const { p } = ports({ bySymbol: { AAPL: aapl }, exchanges: { NASDAQ: NASDAQ } });
  for (const listingExchange of ["MYSTERY", null]) {
    const out = await matchPosition(pos({ isin: null, listingExchange }), p);
    assertEquals([out.securityId, out.matchStatus, out.reason], [null, "unmatched", "no_match"]);
  }
});

Deno.test("ETFs and funds are matched for valuation but are not equities; other asset classes are not matched at all", async () => {
  const etf = sec({ id: "e", yahoo_symbol: "VWCE.DE", quote_type: "ETF", exchange_code: "GER", currency_major: "EUR" });
  const { p } = ports({ byIsin: { IE00BK5BQT80: [etf] }, exchanges: { IBIS: IBIS } });
  const out = await matchPosition(pos({ isin: "IE00BK5BQT80", symbol: "VWCE", listingExchange: "IBIS", currency: "EUR", subCategory: "ETF" }), p);
  assertEquals([out.securityId, out.signalSecurityId, out.matchStatus, out.reason], ["e", null, "not_equity", "not_an_equity"]);
  const option = await matchPosition(pos({ assetClass: "OPT" }), p);
  assertEquals([option.securityId, option.matchStatus], [null, "not_equity"]);
});

Deno.test("matchUserPositions applies every outcome and counts them (bounded per call)", async () => {
  const aapl = sec({ id: "9", yahoo_symbol: "AAPL" });
  const { p } = ports({ byIsin: { US0378331005: [aapl] } });
  const applied: Array<{ positionId: number; matchStatus: string }> = [];
  const store = {
    positionsToMatch: () => Promise.resolve([pos({ id: 1 }), pos({ id: 2, isin: null, listingExchange: null, symbol: "ZZZ" }), pos({ id: 3, assetClass: "BOND" })]),
    applyOutcome: (_user: string, o: { positionId: number; matchStatus: string }) => (applied.push(o), Promise.resolve()),
  };
  assertEquals(await matchUserPositions("u", store, p), { matched: 1, unmatched: 1, notEquity: 1 });
  assertEquals(applied.map((a) => [a.positionId, a.matchStatus]), [[1, "matched_isin"], [2, "unmatched"], [3, "not_equity"]]);
  assertEquals((await matchUserPositions("u", { ...store, positionsToMatch: () => Promise.resolve(Array.from({ length: 50 }, (_, i) => pos({ id: i + 1 }))) }, p, 30)).matched, 30);
});
```

`supabase/functions/broker-sync/matching.ts`:

```ts
// Matching Flex positions to Yahoo securities (spec 12.7). Pure over injected ports; never guesses.
import type { MatchSummary } from "./types.ts";

export interface PositionRef {
  id: number;
  conid: number;
  isin: string | null;
  symbol: string;
  listingExchange: string | null;
  currency: string;
  assetClass: string | null;
  subCategory: string | null;
}

export interface SecurityLite {
  id: string;
  yahoo_symbol: string;
  exchange_code: string;
  currency_major: string;
  quote_type: string;
  company_id: string;
  isin: string | null;
  is_canonical: boolean;
}

export interface MatchPorts {
  securitiesByIsin(isin: string): Promise<SecurityLite[]>;
  securityBySymbol(yahooSymbol: string): Promise<SecurityLite | null>;
  /** `exchanges.ibkr_exchange_id` -> exchange code and Yahoo suffix ('' or null for NASDAQ/NYSE) */
  exchangeByIbkrId(ibkrExchangeId: string): Promise<{ code: string; yahooSuffix: string | null } | null>;
  canonicalOf(companyId: string): Promise<SecurityLite | null>;
  setSecurityIsin(securityId: string, isin: string): Promise<void>;
  searchIsin(isin: string): Promise<Array<{ symbol: string; quoteType: string }>>;
  ensureSecurity(yahooSymbol: string): Promise<SecurityLite | { error: string }>;
}

export interface MatchStore {
  /** positions of the latest snapshot whose match_status is still 'unmatched' */
  positionsToMatch(userId: string): Promise<PositionRef[]>;
  applyOutcome(userId: string, outcome: MatchOutcome): Promise<void>;
}

export interface MatchOutcome {
  positionId: number;
  securityId: string | null;
  signalSecurityId: string | null;
  matchStatus: "matched_isin" | "matched_symbol_exchange" | "unmatched" | "not_equity";
  reason: string | null;
}

const FUND_LIKE = /^(ETF|ETN|FUND|MUTUAL|ETC)/i;

/** IBKR writes share classes with a space ("BRK B"); Yahoo uses a dash. The exchange suffix comes from `exchanges.yahoo_suffix`. */
export function yahooSymbolFor(flexSymbol: string, suffix: string | null): string {
  return `${flexSymbol.trim().toUpperCase().replace(/\s+/g, "-")}${suffix ?? ""}`;
}

/** Exchange 4 points, position currency 2, canonical 1; ties by symbol (UTF-16 order). */
export function pickLine(cands: readonly SecurityLite[], p: PositionRef, exchangeCode: string | null): SecurityLite | null {
  const score = (s: SecurityLite): number =>
    (exchangeCode !== null && s.exchange_code === exchangeCode ? 4 : 0) + (s.currency_major === p.currency.toUpperCase() ? 2 : 0) + (s.is_canonical ? 1 : 0);
  const sorted = [...cands].sort((a, b) => score(b) - score(a) || (a.yahoo_symbol < b.yahoo_symbol ? -1 : a.yahoo_symbol > b.yahoo_symbol ? 1 : 0));
  return sorted[0] ?? null;
}

export async function matchPosition(p: PositionRef, ports: MatchPorts): Promise<MatchOutcome> {
  const none = (matchStatus: MatchOutcome["matchStatus"], reason: string): MatchOutcome => ({
    positionId: p.id, securityId: null, signalSecurityId: null, matchStatus, reason,
  });
  if (p.assetClass !== null && p.assetClass.toUpperCase() !== "STK") return none("not_equity", "asset_class_not_stk");

  const exchange = p.listingExchange === null ? null : await ports.exchangeByIbkrId(p.listingExchange);
  let line: SecurityLite | null = null;
  let status: "matched_isin" | "matched_symbol_exchange" = "matched_isin";
  let reason: string | null = null;

  if (p.isin !== null) {
    line = pickLine(await ports.securitiesByIsin(p.isin), p, exchange?.code ?? null);
    if (line === null) {
      const top = (await ports.searchIsin(p.isin))[0];
      if (top !== undefined) {
        let found = await ports.securityBySymbol(top.symbol);
        if (found === null) {
          const created = await ports.ensureSecurity(top.symbol);
          if ("error" in created) reason = created.error;
          else found = created;
        }
        if (found !== null) {
          if (found.isin === null) await ports.setSecurityIsin(found.id, p.isin);
          line = found;
        }
      }
    }
  }
  if (line === null && exchange !== null) {
    status = "matched_symbol_exchange";
    line = await ports.securityBySymbol(yahooSymbolFor(p.symbol, exchange.yahooSuffix));
  }
  if (line === null) return none("unmatched", reason ?? "no_match");

  const canonical = await ports.canonicalOf(line.company_id);
  const equity = line.quote_type === "EQUITY" && !(p.subCategory !== null && FUND_LIKE.test(p.subCategory));
  return {
    positionId: p.id,
    securityId: line.id,
    signalSecurityId: equity ? (canonical ?? line).id : null,
    matchStatus: equity ? status : "not_equity",
    reason: equity ? null : "not_an_equity",
  };
}

/** Matches the still-unmatched positions of one user (bounded: Yahoo is throttled). */
export async function matchUserPositions(userId: string, store: MatchStore, ports: MatchPorts, limit = 30): Promise<MatchSummary> {
  const summary: MatchSummary = { matched: 0, unmatched: 0, notEquity: 0 };
  for (const p of (await store.positionsToMatch(userId)).slice(0, limit)) {
    const outcome = await matchPosition(p, ports);
    await store.applyOutcome(userId, outcome);
    if (outcome.matchStatus === "not_equity") summary.notEquity += 1;
    else if (outcome.matchStatus === "unmatched") summary.unmatched += 1;
    else summary.matched += 1;
  }
  return summary;
}
```

Run: `deno test -A --config supabase/functions/deno.json supabase/functions/broker-sync/matching.test.ts`
Expected: PASS (9 tests).
- [ ] **Step 4: Risk set for P2 (spec 9.7), test first**

`supabase/functions/_shared/adapters/risk-set.test.ts`:

```ts
import { assertEquals } from "@std/assert";
import { type RiskHolding, type RiskSetStore, monitoredReasons, refreshRiskSet } from "./risk-set.ts";

Deno.test("reasons: outside the top 50, not a universe member, below US$50B; operating companies only", () => {
  const base = { isOperatingCompany: true, worldwideRank: 12, marketCapUsd: 90e9 };
  assertEquals(monitoredReasons(base), []);
  assertEquals(monitoredReasons({ ...base, worldwideRank: 50 }), []);
  assertEquals(monitoredReasons({ ...base, worldwideRank: 51 }), ["outside_top50"]);
  assertEquals(monitoredReasons({ ...base, worldwideRank: null }), ["not_in_universe"]);
  assertEquals(monitoredReasons({ ...base, marketCapUsd: 49.999e9 }), ["below_50b"]);
  assertEquals(monitoredReasons({ ...base, marketCapUsd: 50e9 }), []);
  assertEquals(monitoredReasons({ ...base, worldwideRank: null, marketCapUsd: 3e9 }), ["not_in_universe", "below_50b"]);
  assertEquals(monitoredReasons({ ...base, worldwideRank: 70, marketCapUsd: null }), ["outside_top50"]);
  assertEquals(monitoredReasons({ ...base, worldwideRank: 12, marketCapUsd: null }), []);
  assertEquals(monitoredReasons({ isOperatingCompany: false, worldwideRank: null, marketCapUsd: 1e9 }), []);
});

function fakeStore(holdings: RiskHolding[]) {
  const synced: Array<{ userId: string; active: Array<{ securityId: string; reasons: string[] }> }> = [];
  const store: RiskSetStore = {
    holdings: (userId) => Promise.resolve(userId === undefined ? holdings : holdings.filter((h) => h.userId === userId)),
    syncState: (userId, active) => (synced.push({ userId, active }), Promise.resolve()),
    pause: () => Promise.resolve(),
    remove: () => Promise.resolve(),
  };
  return { store, synced };
}

Deno.test("refreshRiskSet writes active rows with reasons for monitored holdings and none for the rest", async () => {
  const { store, synced } = fakeStore([
    { userId: "u1", securityId: "s-big", isOperating: true, worldwideRank: 3, marketCapUsd: 3e12 },
    { userId: "u1", securityId: "s-small", isOperating: true, worldwideRank: null, marketCapUsd: 5e9 },
    { userId: "u1", securityId: "s-etf", isOperating: false, worldwideRank: null, marketCapUsd: null },
    { userId: "u2", securityId: "s-mid", isOperating: true, worldwideRank: 80, marketCapUsd: 60e9 },
  ]);
  const out = await refreshRiskSet(store, "u1");
  assertEquals(out, { monitored: 1 });
  assertEquals(synced, [{ userId: "u1", active: [{ securityId: "s-small", reasons: ["not_in_universe", "below_50b"] }] }]);
});

Deno.test("without a user id every user with holdings is synchronised (stage 8 risk_set)", async () => {
  const { store, synced } = fakeStore([
    { userId: "u1", securityId: "a", isOperating: true, worldwideRank: 90, marketCapUsd: 70e9 },
    { userId: "u2", securityId: "b", isOperating: true, worldwideRank: 10, marketCapUsd: 70e9 },
  ]);
  assertEquals(await refreshRiskSet(store), { monitored: 1 });
  assertEquals(synced.map((s) => [s.userId, s.active.length]), [["u1", 1], ["u2", 0]]);
});
```

`supabase/functions/_shared/adapters/risk-set.ts`:

```ts
// Holdings that need the daily material-change monitor of P2 (spec 9.7): operating companies that are outside the worldwide top 50,
// not universe members, or below US$50B.
import type { SupabaseClient } from "@supabase/supabase-js";

export const TOP_N = 50;
export const MIN_CAP_USD = 50e9;

export interface RiskHolding {
  userId: string;
  /** the signal (canonical) security, falling back to the held line */
  securityId: string;
  isOperating: boolean;
  worldwideRank: number | null;
  marketCapUsd: number | null;
}

export interface RiskSetStore {
  holdings(userId?: string): Promise<RiskHolding[]>;
  /** upserts `active` rows (reasons) for the user and pauses the user's other rows; never deletes findings */
  syncState(userId: string, active: Array<{ securityId: string; reasons: string[] }>): Promise<void>;
  pause(userId: string): Promise<void>;
  remove(userId: string): Promise<void>;
}

export function monitoredReasons(i: { isOperatingCompany: boolean; worldwideRank: number | null; marketCapUsd: number | null }): string[] {
  if (!i.isOperatingCompany) return [];
  const reasons: string[] = [];
  if (i.worldwideRank === null) reasons.push("not_in_universe");
  else if (i.worldwideRank > TOP_N) reasons.push("outside_top50");
  if (i.marketCapUsd !== null && i.marketCapUsd < MIN_CAP_USD) reasons.push("below_50b");
  return reasons;
}

export async function refreshRiskSet(store: RiskSetStore, userId?: string): Promise<{ monitored: number }> {
  const all = await store.holdings(userId);
  const byUser = new Map<string, RiskHolding[]>();
  for (const h of all) byUser.set(h.userId, [...(byUser.get(h.userId) ?? []), h]);
  if (userId !== undefined && !byUser.has(userId)) byUser.set(userId, []);
  let monitored = 0;
  for (const [user, holdings] of byUser) {
    const active = holdings
      .map((h) => ({ securityId: h.securityId, reasons: monitoredReasons({ isOperatingCompany: h.isOperating, worldwideRank: h.worldwideRank, marketCapUsd: h.marketCapUsd }) }))
      .filter((r) => r.reasons.length > 0);
    await store.syncState(user, active);
    monitored += active.length;
  }
  return { monitored };
}

/** Row values never end up in a message: the operation and the PostgREST code only. */
export class RiskStoreError extends Error {
  constructor(readonly op: string, readonly code: string | null) {
    super(`risk set store: ${op}${code === null ? "" : ` (${code})`}`);
    this.name = "RiskStoreError";
  }
}

export function createRiskSetStore(sb: SupabaseClient): RiskSetStore {
  return {
    async holdings(userId): Promise<RiskHolding[]> {
      const users: string[] = [];
      if (userId !== undefined) users.push(userId);
      else {
        const { data } = await sb.from("broker_connections").select("user_id").in("status", ["linked", "error", "expired"]);
        for (const r of (data as Array<{ user_id: string }> | null) ?? []) users.push(r.user_id);
      }
      const out: RiskHolding[] = [];
      for (const u of users) {
        const { data, error } = await sb.rpc("monitored_holdings_for", { p_user: u });
        if (error) throw new RiskStoreError("monitored_holdings_for", error.code ?? null);
        const rows = (data as Array<{ security_id: string; signal_security_id: string }> | null) ?? [];
        const ids = [...new Set(rows.map((r) => r.signal_security_id))];
        if (ids.length === 0) continue;
        const secs = await sb.from("securities").select("id,quote_type").in("id", ids);
        const types = new Map(((secs.data as Array<{ id: string; quote_type: string }> | null) ?? []).map((s) => [s.id, s.quote_type]));
        const snaps = await sb.from("universe_snapshots").select("security_id,rank,market_cap_usd,scan_run_id,ranked_at").eq("mode", "worldwide").in("security_id", ids).order("ranked_at", { ascending: false }).limit(500);
        const latest = new Map<string, { rank: number; cap: number }>();
        for (const s of (snaps.data as Array<{ security_id: string; rank: number; market_cap_usd: number }> | null) ?? []) {
          if (!latest.has(s.security_id)) latest.set(s.security_id, { rank: s.rank, cap: s.market_cap_usd });
        }
        const caps = await sb.from("scan_security_results").select("security_id,market_cap_usd,computed_at").in("security_id", ids).not("market_cap_usd", "is", null).order("computed_at", { ascending: false }).limit(500);
        const capOf = new Map<string, number>();
        for (const c of (caps.data as Array<{ security_id: string; market_cap_usd: number }> | null) ?? []) if (!capOf.has(c.security_id)) capOf.set(c.security_id, c.market_cap_usd);
        for (const id of ids) {
          out.push({ userId: u, securityId: id, isOperating: types.get(id) === "EQUITY", worldwideRank: latest.get(id)?.rank ?? null, marketCapUsd: latest.get(id)?.cap ?? capOf.get(id) ?? null });
        }
      }
      return out;
    },
    async syncState(userId, active) {
      if (active.length > 0) {
        const { error } = await sb.from("risk_monitor_state").upsert(
          active.map((a) => ({ user_id: userId, security_id: a.securityId, reasons: a.reasons, status: "active" })),
          { onConflict: "user_id,security_id" },
        );
        if (error) throw new RiskStoreError("risk_monitor_state.upsert", error.code ?? null);
      }
      let q = sb.from("risk_monitor_state").update({ status: "paused" }).eq("user_id", userId).eq("status", "active");
      if (active.length > 0) q = q.not("security_id", "in", `(${active.map((a) => a.securityId).join(",")})`);
      const { error } = await q;
      if (error) throw new RiskStoreError("risk_monitor_state.pause", error.code ?? null);
    },
    async pause(userId) {
      const { error } = await sb.from("risk_monitor_state").update({ status: "paused" }).eq("user_id", userId);
      if (error) throw new RiskStoreError("risk_monitor_state.pauseAll", error.code ?? null);
    },
    async remove(userId) {
      const { error } = await sb.from("risk_monitor_state").delete().eq("user_id", userId);
      if (error) throw new RiskStoreError("risk_monitor_state.remove", error.code ?? null);
    },
  };
}
```

Run: `deno test -A --config supabase/functions/deno.json supabase/functions/_shared/adapters/risk-set.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Test doubles (`testing.ts`)**

`supabase/functions/broker-sync/testing.ts` (used by `machine.test.ts`, `service.test.ts`, `handler.test.ts`; not imported by production code):

```ts
import { type Sealed, seal as realSeal, open as realOpen, toBytea } from "@adapters/crypto.ts";
import type { FlexClient, SendResult, StatementResult } from "@adapters/flex.ts";
import { parseFlexStatement } from "@adapters/flex-parse.ts";
import type { IngestPayload } from "./persist.ts";
import {
  ACTIVE_STATES, type AuditEvent, type BrokerDeps, type ConnectionPatch, type ConnectionRow, type RunKind, type RunPatch, type RunRow, type SyncStore,
} from "./types.ts";

export const FIXTURE_XML = await Deno.readTextFile(new URL("../_shared/adapters/fixtures/flex/activity-sample.xml", import.meta.url));
export const USER = "a0000000-0000-4000-8000-00000000000a";
export const CONN = "c1000000-0000-4000-8000-00000000000a";
export const TOKEN = "987654321012345678901234";

export function randomKey(): string {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
}

export class FakeClock {
  t = Date.UTC(2026, 9, 15, 5, 0, 0);
  sleeps: number[] = [];
  now = (): number => this.t;
  sleep = (ms: number): Promise<void> => {
    this.sleeps.push(ms);
    this.t += ms;
    return Promise.resolve();
  };
}

export class FakeStore implements SyncStore {
  conns = new Map<string, ConnectionRow>();
  runs = new Map<string, RunRow>();
  audits: AuditEvent[] = [];
  ingests: Array<{ runId: string; payload: IngestPayload }> = [];
  deleted: Array<{ userId: string; includeRuns: boolean }> = [];
  admins = new Set<string>();
  manual: { outcome: "created" | "busy" | "cooldown" | "not_linked"; retryAfterSeconds: number } = { outcome: "created", retryAfterSeconds: 0 };
  failIngest = false;
  private seq = 0;

  getConnection(userId: string) {
    return Promise.resolve([...this.conns.values()].find((c) => c.user_id === userId) ?? null);
  }
  getConnectionById(id: string) {
    return Promise.resolve(this.conns.get(id) ?? null);
  }
  upsertLinking(i: { id: string; userId: string; sealed: Sealed; queryId: string; tokenExpiresOn: string }) {
    const old = this.conns.get(i.id);
    const row: ConnectionRow = {
      id: i.id, user_id: i.userId, status: "linking", flex_token_ciphertext: toBytea(i.sealed.ciphertext), flex_token_iv: toBytea(i.sealed.iv),
      key_version: i.sealed.version, token_expires_on: i.tokenExpiresOn, query_id: i.queryId, account_id_masked: old?.account_id_masked ?? null,
      base_currency: old?.base_currency ?? null, account_type: old?.account_type ?? null, linked_at: old?.linked_at ?? null, last_verified_at: old?.last_verified_at ?? null,
      last_sync_at: old?.last_sync_at ?? null, last_statement_date: old?.last_statement_date ?? null, last_error_code: null, last_error_message: null, last_error_at: null,
      next_flex_fetch_not_before: null, coverage_from: old?.coverage_from ?? null,
    };
    this.conns.set(i.id, row);
    return Promise.resolve({ ...row });
  }
  patchConnection(id: string, patch: ConnectionPatch) {
    const c = this.conns.get(id);
    if (c !== undefined) this.conns.set(id, { ...c, ...patch });
    return Promise.resolve();
  }
  zeroToken(id: string) {
    const c = this.conns.get(id);
    if (c !== undefined) {
      this.conns.set(id, { ...c, status: "unlinked", flex_token_ciphertext: null, flex_token_iv: null, key_version: null, query_id: null, token_expires_on: null, linked_at: null });
    }
    return Promise.resolve();
  }
  deleteBrokerData(userId: string, o: { includeRuns?: boolean } = {}) {
    this.deleted.push({ userId, includeRuns: o.includeRuns === true });
    return Promise.resolve();
  }
  cancelActiveRuns(userId: string, reason: string) {
    for (const r of this.runs.values()) {
      if (r.user_id === userId && ACTIVE_STATES.includes(r.state)) this.runs.set(r.id, { ...r, state: "failed", error_code: -7, error_message: reason });
    }
    return Promise.resolve();
  }
  createRun(i: { userId: string; connectionId: string; kind: RunKind; statementFrom: string | null; statementTo: string | null; idempotencyKey: string }) {
    const active = [...this.runs.values()].some((r) => r.user_id === i.userId && ACTIVE_STATES.includes(r.state));
    const dup = [...this.runs.values()].some((r) => r.idempotency_key === i.idempotencyKey);
    if (active || dup) return Promise.resolve(null);
    const run: RunRow = {
      id: `run-${++this.seq}`, user_id: i.userId, connection_id: i.connectionId, kind: i.kind, state: "queued", reference_code: null, poll_count: 0, next_poll_at: null,
      statement_from: i.statementFrom, statement_to: i.statementTo, error_code: null, error_message: null, rows_summary: {}, idempotency_key: i.idempotencyKey,
    };
    this.runs.set(run.id, run);
    return Promise.resolve({ ...run });
  }
  getRun(id: string) {
    return Promise.resolve(this.runs.get(id) ?? null);
  }
  latestActiveRun(userId: string) {
    return Promise.resolve([...this.runs.values()].find((r) => r.user_id === userId && ACTIVE_STATES.includes(r.state)) ?? null);
  }
  leased = new Set<string>();
  leaseRun(id: string) {
    const r = this.runs.get(id);
    if (r === undefined || !ACTIVE_STATES.includes(r.state) || this.leased.has(id)) return Promise.resolve(null);
    this.leased.add(id);
    return Promise.resolve({ ...r });
  }
  claimRuns(limit: number) {
    const due = [...this.runs.values()].filter((r) => ACTIVE_STATES.includes(r.state) && !this.leased.has(r.id) && (r.next_poll_at === null || Date.parse(r.next_poll_at) <= this.clockNow()));
    const take = due.slice(0, limit);
    for (const r of take) this.leased.add(r.id);
    return Promise.resolve(take.map((r) => ({ ...r })));
  }
  clockNow: () => number = () => Date.now();
  patchRun(id: string, patch: RunPatch) {
    const r = this.runs.get(id);
    if (r === undefined) throw new Error(`unknown run ${id}`);
    const { lease_until, requested_at: _a, last_poll_at: _b, finished_at: _c, ...rest } = patch;
    const next = { ...r, ...rest } as RunRow;
    if (lease_until === null) this.leased.delete(id);
    this.runs.set(id, next);
    return Promise.resolve({ ...next });
  }
  async enqueueManualSync(userId: string) {
    if (this.manual.outcome !== "created") return { runId: null, ...this.manual };
    const conn = [...this.conns.values()].find((c) => c.user_id === userId);
    const run = conn === undefined ? null : await this.createRun({ userId, connectionId: conn.id, kind: "manual", statementFrom: null, statementTo: null, idempotencyKey: `${userId}:manual:${++this.seq}` });
    return run === null ? { runId: null, outcome: "busy" as const, retryAfterSeconds: 0 } : { runId: run.id, outcome: "created" as const, retryAfterSeconds: 0 };
  }
  ingest(runId: string, payload: IngestPayload) {
    if (this.failIngest) return Promise.reject(new Error("db down"));
    this.ingests.push({ runId, payload });
    const conn = this.conns.get(this.runs.get(runId)?.connection_id ?? "");
    if (conn !== undefined) {
      this.conns.set(conn.id, {
        ...conn,
        account_id_masked: payload.meta.account_id_masked,
        base_currency: payload.meta.base_currency,
        account_type: payload.meta.account_type,
        last_statement_date: payload.meta.statement_to,
        last_sync_at: new Date(this.clockNow()).toISOString(),
      });
    }
    return Promise.resolve({ positions: payload.positions.length, trades: payload.trades.length, closed_lots: payload.closed_lots.length, cash: payload.cash.length, fx: payload.fx.length, nav: payload.nav.length, corporate_actions: payload.corporate_actions.length });
  }
  listConnectionsForRekey(current: number) {
    return Promise.resolve([...this.conns.values()].filter((c) => c.key_version !== null && c.key_version !== current && c.flex_token_ciphertext !== null));
  }
  rekeyConnection(id: string, sealed: Sealed) {
    const c = this.conns.get(id);
    if (c !== undefined) this.conns.set(id, { ...c, flex_token_ciphertext: toBytea(sealed.ciphertext), flex_token_iv: toBytea(sealed.iv), key_version: sealed.version });
    return Promise.resolve();
  }
  isAdmin(userId: string) {
    return Promise.resolve(this.admins.has(userId));
  }
  audit(event: AuditEvent) {
    this.audits.push(event);
    return Promise.resolve();
  }
}

export class FakeFlex implements FlexClient {
  calls: Array<{ kind: "send" | "get"; token: string; arg: string; period?: unknown }> = [];
  constructor(public sends: SendResult[] = [], public gets: StatementResult[] = []) {}
  sendRequest(token: string, queryId: string, period?: unknown) {
    this.calls.push({ kind: "send", token, arg: queryId, period });
    return Promise.resolve(this.sends.shift() ?? { ok: false as const, code: 0, message: "no scripted response" });
  }
  getStatement(token: string, referenceCode: string) {
    this.calls.push({ kind: "get", token, arg: referenceCode });
    return Promise.resolve(this.gets.shift() ?? { ok: false as const, code: 0, message: "no scripted response" });
  }
}

export const SEND_OK: SendResult = { ok: true, referenceCode: "1234567890", url: null };
export const STATEMENT_OK: StatementResult = { ok: true, xml: FIXTURE_XML };
export const flexFail = (code: number): { ok: false; code: number; message: string } => ({ ok: false, code, message: `error ${code}` });

export interface Rig {
  deps: BrokerDeps;
  store: FakeStore;
  flex: FakeFlex;
  clock: FakeClock;
  env: Map<string, string>;
  logs: Array<{ event: string; data?: Record<string, unknown> }>;
  matched: string[];
  riskRefreshed: string[];
  riskPaused: string[];
  riskRemoved: string[];
}

/** A linked connection for USER whose token was sealed with key V1; `deps.keys` read the keys from `env` like the real function does. */
export async function makeRig(o: { linked?: boolean; flex?: FakeFlex } = {}): Promise<Rig> {
  const env = new Map<string, string>([["FLEX_ENC_KEY_V1", randomKey()], ["FLEX_ENC_KEY_CURRENT", "1"]]);
  const reader = { get: (name: string) => env.get(name) };
  const store = new FakeStore();
  const clock = new FakeClock();
  store.clockNow = clock.now;
  const flex = o.flex ?? new FakeFlex();
  const logs: Rig["logs"] = [];
  const rig: Rig = { deps: undefined as never, store, flex, clock, env, logs, matched: [], riskRefreshed: [], riskPaused: [], riskRemoved: [] };
  rig.deps = {
    store,
    flex,
    keys: {
      seal: (plain, ctx) => realSeal(plain, ctx, reader),
      open: (sealed, ctx) => realOpen(sealed, ctx, reader),
      currentVersion: () => Number(env.get("FLEX_ENC_KEY_CURRENT") ?? "1"),
    },
    parse: (xml) => parseFlexStatement(xml),
    matcher: { matchUserPositions: (u) => (rig.matched.push(u), Promise.resolve({ matched: 2, unmatched: 0, notEquity: 0 })) },
    riskSet: {
      refresh: (u) => (rig.riskRefreshed.push(u), Promise.resolve({ monitored: 0 })),
      pause: (u) => (rig.riskPaused.push(u), Promise.resolve()),
      remove: (u) => (rig.riskRemoved.push(u), Promise.resolve()),
    },
    now: clock.now,
    sleep: clock.sleep,
    log: (event, data) => void logs.push({ event, ...(data === undefined ? {} : { data }) }),
  };
  if (o.linked !== false) {
    const sealed = await rig.deps.keys.seal(TOKEN, { userId: USER, connectionId: CONN });
    await store.upsertLinking({ id: CONN, userId: USER, sealed, queryId: "123456", tokenExpiresOn: "2027-01-01" });
  }
  return rig;
}

export async function newRun(rig: Rig, kind: RunKind = "verify", window: { from: string | null; to: string | null } = { from: null, to: null }): Promise<RunRow> {
  const run = await rig.store.createRun({ userId: USER, connectionId: CONN, kind, statementFrom: window.from, statementTo: window.to, idempotencyKey: `${USER}:${kind}:${rig.store.runs.size + 1}` });
  if (run === null) throw new Error("run was not created");
  return run;
}
```

- [ ] **Step 6: State machine tests (`machine.test.ts`)**

`supabase/functions/broker-sync/machine.test.ts`:

```ts
import { assert, assertEquals } from "@std/assert";
import { POLL_DELAYS_S } from "@core/flex-errors.ts";
import { advanceRun, processStatement, runUntilSettled, workerTick } from "./machine.ts";
import { CONN, FIXTURE_XML, FakeFlex, SEND_OK, STATEMENT_OK, TOKEN, USER, flexFail, makeRig, newRun } from "./testing.ts";

const at = (rig: { clock: { t: number } }, iso: string | null) => (iso === null ? null : Date.parse(iso) - rig.clock.t);

Deno.test("verify happy path: queued -> requested -> done, linked, backfill queued, never logs the token", async () => {
  const rig = await makeRig({ flex: new FakeFlex([SEND_OK], [STATEMENT_OK]) });
  let run = await newRun(rig);
  run = await advanceRun(rig.deps, run);
  assertEquals([run.state, run.reference_code, at(rig, run.next_poll_at)], ["requested", "1234567890", 5000]);
  assertEquals(rig.flex.calls[0], { kind: "send", token: TOKEN, arg: "123456", period: undefined });

  rig.clock.t += 5000;
  run = await advanceRun(rig.deps, run);
  assertEquals(run.state, "done");
  assertEquals(rig.store.ingests.length, 1);
  assertEquals(rig.matched, [USER]);
  assertEquals(rig.riskRefreshed, [USER]);
  assertEquals((run.rows_summary as { positions: number }).positions, 2);
  const conn = await rig.store.getConnectionById(CONN);
  assertEquals(conn?.status, "linked");
  assert(conn?.linked_at !== null && conn?.last_verified_at !== null);
  const backfill = [...rig.store.runs.values()].find((r) => r.kind === "backfill");
  assertEquals([backfill?.state, backfill?.statement_from], ["queued", null]);
  assert(rig.store.audits.some((a) => a.eventType === "broker.test" && a.data["result"] === "ok"));
  assert(!JSON.stringify(rig.logs).includes(TOKEN));
  assert(!JSON.stringify(rig.store.audits).includes(TOKEN));
});

Deno.test("a second verify of an already linked connection queues no second backfill", async () => {
  const rig = await makeRig({ flex: new FakeFlex([SEND_OK, SEND_OK], [STATEMENT_OK, STATEMENT_OK]) });
  for (let i = 0; i < 2; i++) {
    let run = await newRun(rig);
    run = await advanceRun(rig.deps, run);
    run = await advanceRun(rig.deps, run);
    assertEquals(run.state, "done");
    for (const r of rig.store.runs.values()) if (r.kind === "backfill") rig.store.runs.set(r.id, { ...r, state: "done" });
  }
  assertEquals([...rig.store.runs.values()].filter((r) => r.kind === "backfill").length, 1);
});

Deno.test("daily and backfill runs choose the period: explicit fd/td, or p=365", async () => {
  const rig = await makeRig({ flex: new FakeFlex([SEND_OK, SEND_OK], []) });
  const daily = await newRun(rig, "daily", { from: "2026-10-09", to: "2026-10-14" });
  await advanceRun(rig.deps, daily);
  rig.store.runs.set(daily.id, { ...(rig.store.runs.get(daily.id) as typeof daily), state: "done" });
  const backfill = await newRun(rig, "backfill");
  await advanceRun(rig.deps, backfill);
  assertEquals(rig.flex.calls[0]?.period, { from: "2026-10-09", to: "2026-10-14" });
  assertEquals(rig.flex.calls[1]?.period, { days: 365 });
});

Deno.test("1019 loop: polls are counted, delays follow the budget, then the statement arrives", async () => {
  const rig = await makeRig({ flex: new FakeFlex([SEND_OK], [flexFail(1019), flexFail(1019), flexFail(1019), STATEMENT_OK]) });
  let run = await advanceRun(rig.deps, await newRun(rig));
  const delays: Array<number | null> = [];
  const polls: number[] = [];
  for (let i = 0; i < 3; i++) {
    rig.clock.t = Date.parse(run.next_poll_at as string);
    run = await advanceRun(rig.deps, run);
    assertEquals(run.state, "polling");
    polls.push(run.poll_count);
    delays.push(at(rig, run.next_poll_at));
  }
  assertEquals(polls, [1, 2, 3]);
  assertEquals(delays, [POLL_DELAYS_S[0], POLL_DELAYS_S[1], POLL_DELAYS_S[2]].map((s) => (s as number) * 1000));
  rig.clock.t = Date.parse(run.next_poll_at as string);
  run = await advanceRun(rig.deps, run);
  assertEquals(run.state, "done");
});

Deno.test("the tenth failed poll ends the run with the poll-limit code", async () => {
  const rig = await makeRig({ flex: new FakeFlex([SEND_OK], Array.from({ length: 12 }, () => flexFail(1019))) });
  let run = await advanceRun(rig.deps, await newRun(rig));
  let polls = 0;
  while (run.state === "requested" || run.state === "polling") {
    rig.clock.t = Date.parse(run.next_poll_at as string);
    run = await advanceRun(rig.deps, run);
    polls += 1;
  }
  assertEquals([run.state, run.error_code, polls], ["failed", -4, 10]);
  assertEquals((await rig.store.getConnectionById(CONN))?.last_error_code, -4);
});

Deno.test("1018 never counts as a poll and waits a minute", async () => {
  const rig = await makeRig({ flex: new FakeFlex([SEND_OK], [flexFail(1018), STATEMENT_OK]) });
  let run = await advanceRun(rig.deps, await newRun(rig));
  rig.clock.t = Date.parse(run.next_poll_at as string);
  run = await advanceRun(rig.deps, run);
  assertEquals([run.state, run.poll_count, at(rig, run.next_poll_at)], ["polling", 0, 60_000]);
});

Deno.test("1012 expires the run and the connection; credential errors put the connection in error", async () => {
  const expired = await makeRig({ flex: new FakeFlex([flexFail(1012)]) });
  let run = await advanceRun(expired.deps, await newRun(expired));
  assertEquals([run.state, run.error_code, (await expired.store.getConnectionById(CONN))?.status], ["expired", 1012, "expired"]);
  for (const code of [1015, 1013, 1014, 1011, 1010]) {
    const rig = await makeRig({ flex: new FakeFlex([flexFail(code)]) });
    run = await advanceRun(rig.deps, await newRun(rig));
    const conn = await rig.store.getConnectionById(CONN);
    assertEquals([run.state, run.error_code, conn?.status, conn?.last_error_code], ["failed", code, "error", code]);
  }
});

Deno.test("1017 restarts the request once and then fails", async () => {
  const rig = await makeRig({ flex: new FakeFlex([SEND_OK, SEND_OK], [flexFail(1017), flexFail(1017)]) });
  let run = await advanceRun(rig.deps, await newRun(rig));
  rig.clock.t = Date.parse(run.next_poll_at as string);
  run = await advanceRun(rig.deps, run);
  assertEquals([run.state, run.reference_code, run.rows_summary["restarted"]], ["queued", null, true]);
  rig.clock.t = Date.parse(run.next_poll_at as string);
  run = await advanceRun(rig.deps, run);
  assertEquals(run.state, "requested");
  rig.clock.t = Date.parse(run.next_poll_at as string);
  run = await advanceRun(rig.deps, run);
  assertEquals([run.state, run.error_code], ["failed", 1017]);
});

Deno.test("a retryable send error keeps the run queued and gives up after five sends", async () => {
  const rig = await makeRig({ flex: new FakeFlex(Array.from({ length: 6 }, () => flexFail(1018))) });
  let run = await newRun(rig);
  for (let i = 0; i < 4; i++) {
    run = await advanceRun(rig.deps, run);
    assertEquals([run.state, at(rig, run.next_poll_at)], ["queued", 60_000]);
    rig.clock.t = Date.parse(run.next_poll_at as string);
  }
  run = await advanceRun(rig.deps, run);
  assertEquals([run.state, run.error_code], ["failed", -5]);
});

Deno.test("unknown codes are retried twice and then fatal", async () => {
  const rig = await makeRig({ flex: new FakeFlex([SEND_OK], [flexFail(1999), flexFail(1999), flexFail(1999)]) });
  let run = await advanceRun(rig.deps, await newRun(rig));
  for (const expected of ["polling", "polling", "failed"]) {
    rig.clock.t = Date.parse((run.next_poll_at ?? new Date(rig.clock.t).toISOString()) as string);
    run = await advanceRun(rig.deps, run);
    assertEquals(run.state, expected);
  }
  assertEquals(run.error_code, 1999);
});

Deno.test("a key that can no longer be opened fails the run with -2 and makes NO Flex call (rotated key)", async () => {
  const rig = await makeRig();
  rig.env.delete("FLEX_ENC_KEY_V1");
  rig.env.set("FLEX_ENC_KEY_V2", btoa("0123456789abcdef0123456789abcdef"));
  rig.env.set("FLEX_ENC_KEY_CURRENT", "2");
  const run = await advanceRun(rig.deps, await newRun(rig));
  const conn = await rig.store.getConnectionById(CONN);
  assertEquals([run.state, run.error_code, conn?.status, conn?.last_error_code], ["failed", -2, "error", -2]);
  assertEquals(rig.flex.calls.length, 0);
});

Deno.test("a parse error writes nothing and keeps the previous data (code -1)", async () => {
  const rig = await makeRig();
  const run = await newRun(rig, "daily");
  const conn = (await rig.store.getConnectionById(CONN)) as NonNullable<Awaited<ReturnType<typeof rig.store.getConnectionById>>>;
  const out = await processStatement(rig.deps, run, conn, "<FlexQueryResponse><FlexStatements>");
  assertEquals([out.state, out.error_code], ["failed", -1]);
  assertEquals(rig.store.ingests.length, 0);
  // a failed daily statement leaves the connection status alone (only the error fields change)
  const after = await rig.store.getConnectionById(CONN);
  assertEquals([after?.status, after?.last_error_code], ["linking", -1]);
});

Deno.test("a statement without a required section or field is rejected with the checklist (code -6)", async () => {
  const rig = await makeRig();
  const run = await newRun(rig, "verify");
  const conn = (await rig.store.getConnectionById(CONN)) as NonNullable<Awaited<ReturnType<typeof rig.store.getConnectionById>>>;
  const out = await processStatement(rig.deps, run, conn, FIXTURE_XML.replace(/<CashTransactions>[\s\S]*<\/CashTransactions>/, ""));
  assertEquals([out.state, out.error_code], ["failed", -6]);
  const sections = out.rows_summary["sections"] as Array<{ section: string; present: boolean }>;
  assertEquals(sections.find((s) => s.section === "Cash Transactions")?.present, false);
  assertEquals(rig.store.ingests.length, 0);
  assertEquals((await rig.store.getConnectionById(CONN))?.status, "error");
});

Deno.test("a statement of another account fails a daily run (-3) but a verify run may switch accounts after deleting the old data", async () => {
  const rig = await makeRig();
  await rig.store.patchConnection(CONN, { status: "linked", account_id_masked: "U***9999", linked_at: "2026-10-01T00:00:00Z" });
  const conn = (await rig.store.getConnectionById(CONN)) as NonNullable<Awaited<ReturnType<typeof rig.store.getConnectionById>>>;
  const daily = await processStatement(rig.deps, await newRun(rig, "daily"), conn, FIXTURE_XML);
  assertEquals([daily.state, daily.error_code], ["failed", -3]);
  assertEquals(rig.store.ingests.length, 0);
  rig.store.runs.set(daily.id, { ...daily, state: "done" });

  const verify = await processStatement(rig.deps, await newRun(rig, "verify"), conn, FIXTURE_XML);
  assertEquals(verify.state, "done");
  assertEquals(rig.store.deleted, [{ userId: USER, includeRuns: false }]);
  assertEquals(rig.store.ingests.length, 1);
});

Deno.test("matching and risk-set failures never fail the sync", async () => {
  const rig = await makeRig({ flex: new FakeFlex([SEND_OK], [STATEMENT_OK]) });
  rig.deps.matcher.matchUserPositions = () => Promise.reject(new Error("yahoo down"));
  rig.deps.riskSet.refresh = () => Promise.reject(new Error("db down"));
  let run = await advanceRun(rig.deps, await newRun(rig));
  run = await advanceRun(rig.deps, run);
  assertEquals(run.state, "done");
  assertEquals(run.rows_summary["match_error"], true);
});

Deno.test("runUntilSettled waits inline, hands a long poll over to the tick, and never exceeds its budget", async () => {
  const quick = await makeRig({ flex: new FakeFlex([SEND_OK], [flexFail(1019), STATEMENT_OK]) });
  const done = await runUntilSettled(quick.deps, (await newRun(quick)).id, 60_000);
  assertEquals(done?.state, "done");
  assertEquals(quick.clock.sleeps, [5000, 15_000]);

  const slow = await makeRig({ flex: new FakeFlex([SEND_OK], Array.from({ length: 12 }, () => flexFail(1019))) });
  const start = slow.clock.t;
  const handedOver = await runUntilSettled(slow.deps, (await newRun(slow)).id, 60_000);
  assertEquals(handedOver?.state, "polling");
  assert(slow.clock.t - start <= 60_000);
  assertEquals(slow.store.leased.has(handedOver?.id ?? ""), false);
});

Deno.test("runUntilSettled does nothing when another worker holds the lease", async () => {
  const rig = await makeRig({ flex: new FakeFlex([SEND_OK]) });
  const run = await newRun(rig);
  rig.store.leased.add(run.id);
  const out = await runUntilSettled(rig.deps, run.id, 60_000);
  assertEquals(out?.state, "queued");
  assertEquals(rig.flex.calls.length, 0);
});

Deno.test("the tick advances due runs, skips runs that are not due, and counts crashes (third crash ends the run)", async () => {
  const rig = await makeRig({ flex: new FakeFlex([SEND_OK], [STATEMENT_OK]) });
  const run = await newRun(rig, "daily");
  assertEquals((await workerTick(rig.deps, 10_000)).processed, 1);
  assertEquals(rig.store.runs.get(run.id)?.state, "requested");
  assertEquals((await workerTick(rig.deps, 10_000)).processed, 0);
  rig.clock.t += 6000;
  assertEquals((await workerTick(rig.deps, 10_000)).processed, 1);
  assertEquals(rig.store.runs.get(run.id)?.state, "done");

  const crashy = await makeRig({ flex: new FakeFlex([SEND_OK], [STATEMENT_OK, STATEMENT_OK, STATEMENT_OK]) });
  const c = await newRun(crashy, "daily");
  await advanceRun(crashy.deps, c).then((r) => crashy.store.runs.set(r.id, r));
  crashy.store.failIngest = true;
  for (let i = 0; i < 3; i++) {
    crashy.clock.t += 120_000;
    crashy.store.leased.clear();
    await workerTick(crashy.deps, 10_000);
  }
  assertEquals([crashy.store.runs.get(c.id)?.state, crashy.store.runs.get(c.id)?.error_code], ["failed", -7]);
  assert(crashy.logs.some((l) => l.event === "run_crashed"));
  assert(!JSON.stringify(crashy.logs).includes("db down"));
});

Deno.test("a run whose connection was unlinked ends without any Flex call", async () => {
  const rig = await makeRig({ flex: new FakeFlex([SEND_OK]) });
  const run = await newRun(rig);
  await rig.store.zeroToken(CONN);
  const out = await advanceRun(rig.deps, run);
  assertEquals([out.state, out.error_code, rig.flex.calls.length], ["failed", -7, 0]);
});
```

- [ ] **Step 7: Implement `machine.ts`**

`supabase/functions/broker-sync/machine.ts`:

```ts
// The sync run state machine (spec 12.4): one transition per call, so a user action (bounded inline wait) and the minute tick share it.
import { CryptoError, fromBytea } from "@adapters/crypto.ts";
import type { FlexPeriod } from "@adapters/flex.ts";
import { requiredSectionReport } from "@adapters/flex-parse.ts";
import { MAX_POLLS, POLL_DELAYS_S, SEND_RETRY_LIMIT, classifyFlexCode, flexErrorInfo } from "@core/flex-errors.ts";
import { maskAccountId, toIngestPayload } from "./persist.ts";
import { type BrokerDeps, type ConnectionRow, type RunRow, isTerminal } from "./types.ts";

const iso = (ms: number): string => new Date(ms).toISOString();
const FIRST_POLL_DELAY_MS = 5_000;
const LEASE_SECONDS = 150;

const errName = (e: unknown): string => (e instanceof Error ? e.name : "error");

export async function openToken(d: BrokerDeps, conn: ConnectionRow): Promise<string> {
  if (conn.flex_token_ciphertext === null || conn.flex_token_iv === null || conn.key_version === null) throw new CryptoError("bad_input", "no token stored");
  return await d.keys.open(
    { ciphertext: fromBytea(conn.flex_token_ciphertext), iv: fromBytea(conn.flex_token_iv), version: conn.key_version },
    { userId: conn.user_id, connectionId: conn.id },
  );
}

function periodFor(run: RunRow): FlexPeriod | undefined {
  if (run.kind === "backfill") return { days: 365 };
  if (run.statement_from !== null && run.statement_to !== null) {
    return run.statement_from <= run.statement_to ? { from: run.statement_from, to: run.statement_to } : { days: 30 };
  }
  return undefined;
}

async function failWith(
  d: BrokerDeps,
  run: RunRow,
  conn: ConnectionRow,
  code: number,
  o: { state?: "failed" | "expired"; detail?: Record<string, unknown> } = {},
): Promise<RunRow> {
  const info = flexErrorInfo(code);
  const state = o.state ?? (info.cls === "expired" ? "expired" : "failed");
  const patched = await d.store.patchRun(run.id, {
    state,
    error_code: code,
    error_message: info.message,
    finished_at: iso(d.now()),
    lease_until: null,
    next_poll_at: null,
    rows_summary: { ...run.rows_summary, ...(o.detail ?? {}) },
  });
  const impact = info.connection ?? (run.kind === "verify" ? "error" : null);
  await d.store.patchConnection(conn.id, {
    ...(impact === null ? {} : { status: impact }),
    last_error_code: code,
    last_error_message: info.message,
    last_error_at: iso(d.now()),
  });
  await d.store.audit({
    actorUserId: conn.user_id,
    actor: "service",
    eventType: run.kind === "verify" ? "broker.test" : "broker.sync_failed",
    data: { run: run.id, result: "failed", code },
  });
  d.log("run_failed", { run: run.id, kind: run.kind, code });
  return patched;
}

async function onFlexError(d: BrokerDeps, run: RunRow, conn: ConnectionRow, code: number, phase: "send" | "fetch"): Promise<RunRow> {
  const info = flexErrorInfo(code);
  const unknownSeen = Number(run.rows_summary["unknown_codes"] ?? 0);
  const cls = classifyFlexCode(code, unknownSeen);
  const summary = { ...run.rows_summary, ...(info.ibkrText === "(unknown)" ? { unknown_codes: unknownSeen + 1 } : {}) };

  if (cls === "expired") return await failWith(d, run, conn, code, { state: "expired" });

  if (cls === "retry") {
    if (phase === "send") {
      const sends = Number(summary["send_attempts"] ?? 0) + 1;
      if (sends >= SEND_RETRY_LIMIT) return await failWith(d, run, conn, -5);
      return await d.store.patchRun(run.id, {
        state: "queued",
        rows_summary: { ...summary, send_attempts: sends },
        next_poll_at: iso(d.now() + (info.retryAfterSeconds ?? 30) * 1000),
        lease_until: null,
      });
    }
    const polls = run.poll_count + (info.countsAsPoll ? 1 : 0);
    if (info.countsAsPoll && polls >= MAX_POLLS) return await failWith(d, run, conn, -4);
    const delayS = info.countsAsPoll ? (POLL_DELAYS_S[Math.min(polls, POLL_DELAYS_S.length) - 1] ?? 60) : (info.retryAfterSeconds ?? 60);
    return await d.store.patchRun(run.id, {
      state: "polling",
      poll_count: polls,
      last_poll_at: iso(d.now()),
      next_poll_at: iso(d.now() + delayS * 1000),
      rows_summary: summary,
      lease_until: null,
    });
  }

  if (code === 1017 && summary["restarted"] !== true) {
    return await d.store.patchRun(run.id, {
      state: "queued",
      reference_code: null,
      poll_count: 0,
      rows_summary: { ...summary, restarted: true },
      next_poll_at: iso(d.now() + FIRST_POLL_DELAY_MS),
      lease_until: null,
    });
  }
  return await failWith(d, run, conn, code);
}

/** Parse, validate, ingest (one SQL transaction), match, update the risk set. Nothing is written unless the whole statement is valid. */
export async function processStatement(d: BrokerDeps, run: RunRow, conn: ConnectionRow, xml: string): Promise<RunRow> {
  await d.store.patchRun(run.id, { state: "parsing" });
  const parsed = d.parse(xml);
  if (!parsed.ok) return await failWith(d, run, conn, -1, { detail: { parse_code: parsed.code, issues: parsed.issues.slice(0, 20) } });
  const statement = parsed.statement;

  const report = requiredSectionReport(statement);
  if (report.some((r) => !r.present || r.missingFields.length > 0)) return await failWith(d, run, conn, -6, { detail: { sections: report } });

  const masked = maskAccountId(statement.accountId);
  const switched = conn.account_id_masked !== null && conn.account_id_masked !== masked;
  if (switched && run.kind !== "verify") return await failWith(d, run, conn, -3);
  if (switched) {
    await d.store.deleteBrokerData(conn.user_id);
    await d.store.audit({ actorUserId: conn.user_id, actor: "service", eventType: "broker.account_changed", data: { run: run.id } });
  }

  const counts = await d.store.ingest(run.id, await toIngestPayload(conn.user_id, statement));

  let match: Record<string, number> | null = null;
  try {
    match = { ...(await d.matcher.matchUserPositions(conn.user_id)) };
  } catch (e) {
    d.log("match_failed", { run: run.id, error: errName(e) });
  }
  try {
    await d.riskSet.refresh(conn.user_id);
  } catch (e) {
    d.log("risk_set_failed", { run: run.id, error: errName(e) });
  }

  const done = await d.store.patchRun(run.id, {
    state: "done",
    finished_at: iso(d.now()),
    lease_until: null,
    next_poll_at: null,
    error_code: null,
    error_message: null,
    rows_summary: {
      ...run.rows_summary,
      ...counts,
      ...(match === null ? { match_error: true } : { match }),
      sections: report,
      warnings: statement.warnings,
    },
  });

  if (run.kind === "verify") {
    await d.store.patchConnection(conn.id, {
      status: "linked",
      last_verified_at: iso(d.now()),
      linked_at: conn.linked_at ?? iso(d.now()),
      last_error_code: null,
      last_error_message: null,
      last_error_at: null,
    });
    if (conn.linked_at === null) {
      await d.store.createRun({
        userId: conn.user_id, connectionId: conn.id, kind: "backfill", statementFrom: null, statementTo: null, idempotencyKey: `${conn.user_id}:backfill:${run.id}`,
      });
    }
    await d.store.audit({ actorUserId: conn.user_id, actor: "user", eventType: "broker.test", data: { run: run.id, result: "ok" } });
  }
  d.log("run_done", { run: run.id, kind: run.kind });
  return done;
}

export async function advanceRun(d: BrokerDeps, run: RunRow): Promise<RunRow> {
  if (isTerminal(run.state)) return run;
  const conn = await d.store.getConnectionById(run.connection_id);
  if (conn === null || conn.status === "unlinked") {
    return await d.store.patchRun(run.id, {
      state: "failed", error_code: -7, error_message: "The connection was removed.", finished_at: iso(d.now()), lease_until: null, next_poll_at: null,
    });
  }
  let token: string;
  try {
    token = await openToken(d, conn);
  } catch (e) {
    if (e instanceof CryptoError) {
      d.log("token_unavailable", { run: run.id, reason: e.code });
      return await failWith(d, run, conn, -2, { detail: { crypto: e.code } });
    }
    throw e;
  }

  if (run.state === "queued") {
    if (conn.query_id === null) return await failWith(d, run, conn, 1014);
    const res = await d.flex.sendRequest(token, conn.query_id, periodFor(run));
    if (res.ok) {
      return await d.store.patchRun(run.id, {
        state: "requested",
        reference_code: res.referenceCode,
        requested_at: iso(d.now()),
        poll_count: 0,
        next_poll_at: iso(d.now() + FIRST_POLL_DELAY_MS),
        lease_until: null,
      });
    }
    return await onFlexError(d, run, conn, res.code, "send");
  }

  if (run.reference_code === null) return await onFlexError(d, run, conn, 1017, "fetch");
  const res = await d.flex.getStatement(token, run.reference_code);
  if (!res.ok) return await onFlexError(d, run, conn, res.code, "fetch");
  return await processStatement(d, run, conn, res.xml);
}

/** Advances a run inline until it is terminal or the next poll would exceed the budget (then the minute tick takes over). */
export async function runUntilSettled(d: BrokerDeps, runId: string, budgetMs: number): Promise<RunRow | null> {
  const deadline = d.now() + budgetMs;
  let run = await d.store.leaseRun(runId, LEASE_SECONDS);
  if (run === null) return await d.store.getRun(runId);
  while (!isTerminal(run.state)) {
    run = await advanceRun(d, run);
    if (isTerminal(run.state)) break;
    const due = run.next_poll_at === null ? d.now() : Date.parse(run.next_poll_at);
    const wait = Math.max(0, due - d.now());
    if (d.now() + wait > deadline) break;
    if (wait > 0) await d.sleep(wait);
    const next = await d.store.leaseRun(run.id, LEASE_SECONDS);
    if (next === null) break;
    run = next;
  }
  return run;
}

async function handleCrash(d: BrokerDeps, run: RunRow, e: unknown): Promise<void> {
  const crashes = Number(run.rows_summary["crashes"] ?? 0) + 1;
  d.log("run_crashed", { run: run.id, error: errName(e), crashes });
  const rows_summary = { ...run.rows_summary, crashes };
  if (crashes >= 3) {
    await d.store.patchRun(run.id, {
      state: "failed", error_code: -7, error_message: flexErrorInfo(-7).message, finished_at: iso(d.now()), lease_until: null, next_poll_at: null, rows_summary,
    });
  } else {
    await d.store.patchRun(run.id, { lease_until: null, next_poll_at: iso(d.now() + 60_000), rows_summary });
  }
}

/** Minute tick: claims due runs (leases, SKIP LOCKED in SQL), advances each once, stops at the budget. */
export async function workerTick(d: BrokerDeps, budgetMs: number): Promise<{ processed: number }> {
  const deadline = d.now() + budgetMs;
  let processed = 0;
  while (d.now() < deadline) {
    const runs = await d.store.claimRuns(3, LEASE_SECONDS);
    if (runs.length === 0) break;
    for (const run of runs) {
      processed += 1;
      try {
        await advanceRun(d, run);
      } catch (e) {
        await handleCrash(d, run, e);
      }
    }
  }
  return { processed };
}
```

Run: `deno test -A --config supabase/functions/deno.json supabase/functions/broker-sync/machine.test.ts`
Expected: PASS (19 tests). If the crash test is flaky because of the fake's lease handling, check that `FakeStore.patchRun` releases the lease when `lease_until === null` (it does) and that the test clears `leased` between ticks (it does).

- [ ] **Step 8: Service actions (`service.test.ts`, then `service.ts`)**

`supabase/functions/broker-sync/service.test.ts`:

```ts
import { assert, assertEquals } from "@std/assert";
import { ingestFixture, link, rekeyAll, syncNow, testConnection, unlink, validateLinkInput } from "./service.ts";
import { CONN, FIXTURE_XML, FakeFlex, SEND_OK, STATEMENT_OK, TOKEN, USER, flexFail, makeRig, randomKey } from "./testing.ts";

const TODAY = "2026-10-15";
const input = (o: Record<string, unknown> = {}) => ({ token: TOKEN, queryId: "123456", tokenExpiresOn: "2027-06-01", ...o });

function svc(rig: Awaited<ReturnType<typeof makeRig>>, o: { fixtureMode?: boolean } = {}) {
  const background: Array<Promise<unknown>> = [];
  return { background, deps: { ...rig.deps, background: (p: Promise<unknown>) => void background.push(p), todayIso: () => TODAY, fixtureMode: o.fixtureMode ?? false } };
}

Deno.test("validateLinkInput: token charset and length, numeric query id, expiry in the future and at most one year", () => {
  assertEquals(validateLinkInput(input(), TODAY).ok, true);
  for (const [field, bad] of [
    ["token", ""], ["token", "short"], ["token", "has space in it 123"], ["token", "x".repeat(300)],
    ["queryId", "abc"], ["queryId", "12"], ["queryId", "1234567890123"],
    ["tokenExpiresOn", "2026-10-15"], ["tokenExpiresOn", "2026-10-14"], ["tokenExpiresOn", "2027-10-17"], ["tokenExpiresOn", "not a date"], ["tokenExpiresOn", "2027-02-30"],
  ] as const) {
    const r = validateLinkInput(input({ [field]: bad }), TODAY);
    assertEquals(r.ok === false && r.field, field, `${field}=${bad}`);
  }
  assertEquals(validateLinkInput(input({ tokenExpiresOn: "2027-10-16" }), TODAY).ok, true);
  assertEquals(validateLinkInput(null, TODAY).ok, false);
});

Deno.test("link stores the token sealed, never returns it, verifies inline and ends linked", async () => {
  const rig = await makeRig({ linked: false, flex: new FakeFlex([SEND_OK], [STATEMENT_OK]) });
  const { deps } = svc(rig);
  const out = await link(deps, USER, input());
  assertEquals(out.status, 200);
  const text = JSON.stringify(out.body);
  assert(!text.includes(TOKEN));
  assert(!text.includes("ciphertext") && !text.includes("flex_token") && !text.includes("key_version"));
  const body = out.body as { run: { state: string }; connection: { status: string; account_id_masked: string } };
  assertEquals([body.run.state, body.connection.status, body.connection.account_id_masked], ["done", "linked", "U***4567"]);
  const stored = [...rig.store.conns.values()][0];
  const plainHex = Array.from(new TextEncoder().encode(TOKEN), (b) => b.toString(16).padStart(2, "0")).join("");
  assert(stored?.flex_token_ciphertext !== null && stored?.flex_token_ciphertext !== undefined);
  assert(!stored.flex_token_ciphertext.includes(plainHex));
  assertEquals(stored.key_version, 1);
  assert(rig.store.audits.some((a) => a.eventType === "broker.link"));
  assert(!JSON.stringify(rig.store.audits).includes(TOKEN));
  assertEquals(rig.flex.calls[0]?.token, TOKEN);
});

Deno.test("link rejects bad input with the offending field and a run that is already active with 409", async () => {
  const rig = await makeRig({ linked: false });
  const { deps } = svc(rig);
  const bad = await link(deps, USER, input({ queryId: "x" }));
  assertEquals([bad.status, (bad.body as { field: string }).field], [400, "queryId"]);
  assertEquals(rig.flex.calls.length, 0);

  const busy = await makeRig({ flex: new FakeFlex([SEND_OK]) });
  await busy.store.createRun({ userId: USER, connectionId: CONN, kind: "daily", statementFrom: null, statementTo: null, idempotencyKey: "x" });
  const out = await link(svc(busy).deps, USER, input());
  assertEquals(out.status, 409);
  assertEquals((out.body as { error: string }).error, "run_in_progress");
});

Deno.test("link with a token IBKR rejects ends in error with the mapped message", async () => {
  const rig = await makeRig({ linked: false, flex: new FakeFlex([flexFail(1015)]) });
  const out = await link(svc(rig).deps, USER, input());
  const body = out.body as { run: { state: string; error_code: number }; connection: { status: string; last_error_code: number } };
  assertEquals([out.status, body.run.state, body.run.error_code, body.connection.status, body.connection.last_error_code], [200, "failed", 1015, "error", 1015]);
});

Deno.test("test connection needs a stored token and runs a verify inline", async () => {
  const none = await makeRig({ linked: false });
  assertEquals((await testConnection(svc(none).deps, USER)).status, 409);
  const rig = await makeRig({ flex: new FakeFlex([SEND_OK], [STATEMENT_OK]) });
  const out = await testConnection(svc(rig).deps, USER);
  assertEquals([out.status, (out.body as { run: { kind: string; state: string } }).run.kind, (out.body as { run: { state: string } }).run.state], [200, "verify", "done"]);
});

Deno.test("sync: created runs in the background, busy 409, cooldown 429 with Retry-After, not linked 409", async () => {
  const rig = await makeRig({ flex: new FakeFlex([SEND_OK], [STATEMENT_OK]) });
  const s = svc(rig);
  const created = await syncNow(s.deps, USER);
  assertEquals(created.status, 202);
  assertEquals(s.background.length, 1);
  await Promise.all(s.background);
  assertEquals([...rig.store.runs.values()].map((r) => [r.kind, r.state]), [["manual", "done"]]);

  for (const [outcome, status] of [["busy", 409], ["not_linked", 409]] as const) {
    rig.store.manual = { outcome, retryAfterSeconds: 0 };
    assertEquals((await syncNow(s.deps, USER)).status, status);
  }
  rig.store.manual = { outcome: "cooldown", retryAfterSeconds: 321 };
  const cool = await syncNow(s.deps, USER);
  assertEquals([cool.status, cool.headers?.["retry-after"], (cool.body as { retryAfterSeconds: number }).retryAfterSeconds], [429, "321", 321]);
});

Deno.test("unlink zeroes the ciphertext, IV, key version and query id, cancels runs, pauses monitoring and audits", async () => {
  const rig = await makeRig();
  await rig.store.createRun({ userId: USER, connectionId: CONN, kind: "daily", statementFrom: null, statementTo: null, idempotencyKey: "d" });
  const out = await unlink(svc(rig).deps, USER, { deleteData: false });
  assertEquals(out.status, 200);
  const c = rig.store.conns.get(CONN);
  assertEquals([c?.status, c?.flex_token_ciphertext, c?.flex_token_iv, c?.key_version, c?.query_id, c?.token_expires_on], ["unlinked", null, null, null, null, null]);
  assertEquals([...rig.store.runs.values()].every((r) => r.state === "failed"), true);
  assertEquals(rig.riskPaused, [USER]);
  assertEquals(rig.store.deleted, []);
  assert(rig.store.audits.some((a) => a.eventType === "broker.unlink" && a.data["delete_data"] === false));
  assert(!JSON.stringify(out.body).includes("ciphertext"));
});

Deno.test("unlink with deleteData also removes the synced rows and the monitoring state; unlinking twice is a no-op", async () => {
  const rig = await makeRig();
  const d = svc(rig).deps;
  await unlink(d, USER, { deleteData: true });
  assertEquals(rig.store.deleted, [{ userId: USER, includeRuns: true }]);
  assertEquals(rig.riskRemoved, [USER]);
  assertEquals((await unlink(d, USER, { deleteData: false })).status, 200);
  assertEquals((await unlink(svc(await makeRig({ linked: false })).deps, USER, {})).status, 200);
});

Deno.test("rekey re-encrypts under the current key, a second rekey is a no-op, an unreadable row is counted as failed", async () => {
  const rig = await makeRig();
  const v2 = randomKey();
  rig.env.set("FLEX_ENC_KEY_V2", v2);
  rig.env.set("FLEX_ENC_KEY_CURRENT", "2");
  const d = svc(rig).deps;
  const first = await rekeyAll(d, "admin-1");
  assertEquals(first.body, { ok: true, rekeyed: 1, failed: 0 });
  assertEquals(rig.store.conns.get(CONN)?.key_version, 2);
  rig.env.delete("FLEX_ENC_KEY_V1");
  assertEquals((await rekeyAll(d, null)).body, { ok: true, rekeyed: 0, failed: 0 });

  const broken = await makeRig();
  broken.env.delete("FLEX_ENC_KEY_V1");
  broken.env.set("FLEX_ENC_KEY_V2", v2);
  broken.env.set("FLEX_ENC_KEY_CURRENT", "2");
  assertEquals((await rekeyAll(svc(broken).deps, null)).body, { ok: true, rekeyed: 0, failed: 1 });
  assert(broken.store.audits.some((a) => a.eventType === "broker.token_rekey" && a.data["failed"] === 1));
});

Deno.test("ingest_fixture is refused unless fixture mode is on, and otherwise loads the XML through the same path as a real statement", async () => {
  const rig = await makeRig();
  const off = await ingestFixture(svc(rig, { fixtureMode: false }).deps, { userId: USER, xml: FIXTURE_XML });
  assertEquals(off.status, 403);
  assertEquals(rig.store.ingests.length, 0);
  const on = await ingestFixture(svc(rig, { fixtureMode: true }).deps, { userId: USER, xml: FIXTURE_XML });
  assertEquals(on.status, 200);
  assertEquals(rig.store.ingests.length, 1);
  assertEquals((await ingestFixture(svc(rig, { fixtureMode: true }).deps, { userId: 5, xml: "" })).status, 400);
});
```

Note on the `sync` test: the first lines create and then re-label a manual run only to give the fake a run id (`manual-run`) that `enqueueManualSync` returns; keep them as written.

`supabase/functions/broker-sync/service.ts`:

```ts
// Actions of broker-sync (user mode and worker mode). Pure over BrokerDeps; the HTTP layer is handler.ts.
import { type BrokerDeps, type ConnectionRow, publicConnection, publicRun } from "./types.ts";
import { openToken, processStatement, runUntilSettled } from "./machine.ts";

export interface ServiceDeps extends BrokerDeps {
  /** keeps working after the response (EdgeRuntime.waitUntil); tests collect the promises */
  background(promise: Promise<unknown>): void;
  /** today's date in Europe/Sofia, "YYYY-MM-DD" */
  todayIso(): string;
  fixtureMode: boolean;
}

export interface ServiceResult {
  status: number;
  body: Record<string, unknown>;
  headers?: Record<string, string>;
}

const INLINE_BUDGET_MS = 60_000;
const BACKGROUND_BUDGET_MS = 120_000;

export interface LinkInput {
  token: string;
  queryId: string;
  tokenExpiresOn: string;
}

function dayNumberOf(iso: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (m === null) return null;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const back = new Date(t);
  if (back.getUTCFullYear() !== Number(m[1]) || back.getUTCMonth() !== Number(m[2]) - 1 || back.getUTCDate() !== Number(m[3])) return null;
  return Math.floor(t / 86_400_000);
}

export function validateLinkInput(raw: unknown, todayIso: string): { ok: true; value: LinkInput } | { ok: false; field: string; message: string } {
  const o = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const token = o["token"];
  if (typeof token !== "string" || !/^[A-Za-z0-9._-]{8,200}$/.test(token)) return { ok: false, field: "token", message: "Enter the token exactly as shown by IBKR." };
  const queryId = o["queryId"];
  if (typeof queryId !== "string" || !/^\d{3,12}$/.test(queryId)) return { ok: false, field: "queryId", message: "The Query ID is a number of 3 to 12 digits." };
  const expires = o["tokenExpiresOn"];
  const e = typeof expires === "string" ? dayNumberOf(expires) : null;
  const today = dayNumberOf(todayIso);
  if (e === null || today === null) return { ok: false, field: "tokenExpiresOn", message: "Enter the token expiry date." };
  if (e <= today) return { ok: false, field: "tokenExpiresOn", message: "The token expiry date must be in the future." };
  if (e - today > 366) return { ok: false, field: "tokenExpiresOn", message: "IBKR tokens last at most one year." };
  return { ok: true, value: { token, queryId, tokenExpiresOn: expires as string } };
}

async function inlineVerify(d: ServiceDeps, conn: ConnectionRow): Promise<ServiceResult> {
  const run = await d.store.createRun({
    userId: conn.user_id, connectionId: conn.id, kind: "verify", statementFrom: null, statementTo: null, idempotencyKey: `${conn.user_id}:verify:${crypto.randomUUID()}`,
  });
  if (run === null) return { status: 409, body: { error: "run_in_progress" } };
  const settled = await runUntilSettled(d, run.id, INLINE_BUDGET_MS);
  const fresh = await d.store.getConnection(conn.user_id);
  return { status: 200, body: { ok: true, run: settled === null ? null : publicRun(settled), connection: fresh === null ? null : publicConnection(fresh) } };
}

export async function link(d: ServiceDeps, userId: string, raw: unknown): Promise<ServiceResult> {
  const v = validateLinkInput(raw, d.todayIso());
  if (!v.ok) return { status: 400, body: { error: "invalid_input", field: v.field, message: v.message } };
  const active = await d.store.latestActiveRun(userId);
  if (active !== null) return { status: 409, body: { error: "run_in_progress", run: publicRun(active) } };

  const existing = await d.store.getConnection(userId);
  const id = existing?.id ?? crypto.randomUUID();
  const sealed = await d.keys.seal(v.value.token, { userId, connectionId: id });
  const conn = await d.store.upsertLinking({ id, userId, sealed, queryId: v.value.queryId, tokenExpiresOn: v.value.tokenExpiresOn });
  await d.store.audit({ actorUserId: userId, actor: "user", eventType: "broker.link", data: { connection: conn.id, kv: sealed.version } });
  d.log("link", { connection: conn.id });
  return await inlineVerify(d, conn);
}

export async function testConnection(d: ServiceDeps, userId: string): Promise<ServiceResult> {
  const conn = await d.store.getConnection(userId);
  if (conn === null || conn.flex_token_ciphertext === null || conn.status === "unlinked") return { status: 409, body: { error: "not_linked" } };
  const active = await d.store.latestActiveRun(userId);
  if (active !== null) return { status: 409, body: { error: "run_in_progress", run: publicRun(active) } };
  return await inlineVerify(d, conn);
}

export async function syncNow(d: ServiceDeps, userId: string): Promise<ServiceResult> {
  const r = await d.store.enqueueManualSync(userId);
  if (r.outcome === "created" && r.runId !== null) {
    const runId = r.runId;
    d.background(runUntilSettled(d, runId, BACKGROUND_BUDGET_MS).catch((e: unknown) => d.log("sync_background_failed", { run: runId, error: e instanceof Error ? e.name : "error" })));
    const run = await d.store.getRun(runId);
    return { status: 202, body: { ok: true, run: run === null ? { id: runId } : publicRun(run) } };
  }
  if (r.outcome === "cooldown") {
    return { status: 429, headers: { "retry-after": String(r.retryAfterSeconds) }, body: { error: "cooldown", retryAfterSeconds: r.retryAfterSeconds } };
  }
  return { status: 409, body: { error: r.outcome === "busy" ? "run_in_progress" : "not_linked" } };
}

export async function unlink(d: ServiceDeps, userId: string, raw: unknown): Promise<ServiceResult> {
  const deleteData = typeof raw === "object" && raw !== null && (raw as Record<string, unknown>)["deleteData"] === true;
  const conn = await d.store.getConnection(userId);
  if (conn === null) return { status: 200, body: { ok: true, connection: null } };
  await d.store.cancelActiveRuns(userId, "The broker was unlinked.");
  await d.store.zeroToken(conn.id);
  await d.riskSet.pause(userId);
  if (deleteData) {
    await d.store.deleteBrokerData(userId, { includeRuns: true });
    await d.riskSet.remove(userId);
  }
  await d.store.audit({ actorUserId: userId, actor: "user", eventType: "broker.unlink", data: { delete_data: deleteData } });
  const fresh = await d.store.getConnection(userId);
  return { status: 200, body: { ok: true, connection: fresh === null ? null : publicConnection(fresh) } };
}

/** Admin: decrypt with the stored key version, encrypt with the current one (spec 6.7). Safe to repeat. */
export async function rekeyAll(d: ServiceDeps, actorUserId: string | null): Promise<ServiceResult> {
  const current = d.keys.currentVersion();
  let rekeyed = 0;
  let failed = 0;
  for (const conn of await d.store.listConnectionsForRekey(current)) {
    try {
      const plain = await openToken(d, conn);
      await d.store.rekeyConnection(conn.id, await d.keys.seal(plain, { userId: conn.user_id, connectionId: conn.id }));
      rekeyed += 1;
    } catch {
      failed += 1;
    }
  }
  await d.store.audit({ actorUserId, actor: actorUserId === null ? "service" : "admin", eventType: "broker.token_rekey", data: { rekeyed, failed, to: current } });
  return { status: 200, body: { ok: true, rekeyed, failed } };
}

/** Integration tests only (P5b-D13): loads a statement through exactly the path of a real one, without calling IBKR. */
export async function ingestFixture(d: ServiceDeps, raw: unknown): Promise<ServiceResult> {
  if (!d.fixtureMode) return { status: 403, body: { error: "fixture_mode_disabled" } };
  const o = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  if (typeof o["userId"] !== "string" || typeof o["xml"] !== "string" || o["xml"] === "") return { status: 400, body: { error: "invalid_input" } };
  const conn = await d.store.getConnection(o["userId"]);
  if (conn === null) return { status: 404, body: { error: "not_linked" } };
  const run = await d.store.createRun({
    userId: conn.user_id, connectionId: conn.id, kind: "daily", statementFrom: null, statementTo: null, idempotencyKey: `${conn.user_id}:fixture:${crypto.randomUUID()}`,
  });
  if (run === null) return { status: 409, body: { error: "run_in_progress" } };
  const done = await processStatement(d, run, conn, o["xml"]);
  return { status: 200, body: { ok: true, run: publicRun(done) } };
}
```

Run: `deno test -A --config supabase/functions/deno.json supabase/functions/broker-sync/service.test.ts`
Expected: PASS (10 tests). If the "stored ciphertext" assertion in the link test looks odd to you: it only checks that the stored bytes are not the plain token (the token bytes `0x39...` are not a prefix); it exists to catch an accidental plaintext store.

- [ ] **Step 9: HTTP handler (`handler.test.ts`, `handler.ts`)**

`supabase/functions/broker-sync/handler.test.ts`:

```ts
import { assert, assertEquals } from "@std/assert";
import { FakeFlex, SEND_OK, STATEMENT_OK, TOKEN, USER, flexFail, makeRig } from "./testing.ts";
import { type HandlerDeps, handleRequest, isLocalUrl } from "./handler.ts";

const SECRET = "cron-secret";
const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request("https://x.test/functions/v1/broker-sync", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://site.test", ...headers },
    body: JSON.stringify(body),
  });
const jwt = { authorization: "Bearer aaa.bbb.ccc" };

async function setup(o: { flex?: FakeFlex; fixtureMode?: boolean; admin?: boolean } = {}) {
  const rig = await makeRig({ flex: o.flex ?? new FakeFlex() });
  if (o.admin === true) rig.store.admins.add(USER);
  const deps: HandlerDeps = {
    brokerDeps: { ...rig.deps, background: () => undefined, todayIso: () => "2026-10-15", fixtureMode: o.fixtureMode ?? false },
    verifier: { verify: (token) => Promise.resolve(token === "aaa.bbb.ccc" ? { userId: USER } : null) },
    cronSecret: SECRET,
    allowedOrigins: ["https://site.test"],
  };
  return { rig, deps };
}

Deno.test("CORS preflight is answered, other methods are 405", async () => {
  const { deps } = await setup();
  const pre = await handleRequest(new Request("https://x.test/", { method: "OPTIONS", headers: { origin: "https://site.test" } }), deps);
  assertEquals([pre.status, pre.headers.get("access-control-allow-origin")], [204, "https://site.test"]);
  assertEquals((await handleRequest(new Request("https://x.test/", { method: "GET" }), deps)).status, 405);
});

Deno.test("user mode needs a valid JWT; the cron header needs the right secret", async () => {
  const { deps } = await setup();
  assertEquals((await handleRequest(post({ action: "test" }), deps)).status, 401);
  assertEquals((await handleRequest(post({ action: "test" }, { authorization: "Bearer bad.bad.bad" }), deps)).status, 401);
  assertEquals((await handleRequest(post({ action: "tick" }, { "x-cron-secret": "wrong" }), deps)).status, 401);
  assertEquals((await handleRequest(post({ action: "tick" }), deps)).status, 401);
});

Deno.test("worker actions are not available to users, user actions are not available to the worker", async () => {
  const { deps } = await setup();
  assertEquals((await handleRequest(post({ action: "tick" }, jwt), deps)).status, 403);
  assertEquals((await handleRequest(post({ action: "ingest_fixture", userId: USER, xml: "x" }, jwt), deps)).status, 403);
  assertEquals((await handleRequest(post({ action: "link" }, { "x-cron-secret": SECRET }), deps)).status, 400);
  assertEquals((await handleRequest(post({ action: "nonsense" }, jwt), deps)).status, 400);
  assertEquals((await handleRequest(post({}, jwt), deps)).status, 400);
});

Deno.test("link over HTTP: 400 for bad input, 200 with a safe body and the token never in the response", async () => {
  const bad = await setup();
  const res400 = await handleRequest(post({ action: "link", token: TOKEN, queryId: "abc", tokenExpiresOn: "2027-06-01" }, jwt), bad.deps);
  assertEquals(res400.status, 400);
  assertEquals((await res400.json()).field, "queryId");

  const { deps, rig } = await setup({ flex: new FakeFlex([SEND_OK], [STATEMENT_OK]) });
  await rig.store.zeroToken("c1000000-0000-4000-8000-00000000000a");
  const res = await handleRequest(post({ action: "link", token: TOKEN, queryId: "123456", tokenExpiresOn: "2027-06-01" }, jwt), deps);
  const text = await res.text();
  assertEquals(res.status, 200);
  assert(!text.includes(TOKEN));
  assert(!/ciphertext|flex_token|key_version/.test(text));
  assertEquals(res.headers.get("cache-control"), "no-store");
  assertEquals(res.headers.get("access-control-allow-origin"), "https://site.test");
});

Deno.test("sync cooldown is a 429 with Retry-After", async () => {
  const { deps, rig } = await setup();
  rig.store.manual = { outcome: "cooldown", retryAfterSeconds: 400 };
  const res = await handleRequest(post({ action: "sync" }, jwt), deps);
  assertEquals([res.status, res.headers.get("retry-after")], [429, "400"]);
});

Deno.test("rekey is allowed for the cron secret and for admins only", async () => {
  const user = await setup();
  assertEquals((await handleRequest(post({ action: "rekey" }, jwt), user.deps)).status, 403);
  const admin = await setup({ admin: true });
  assertEquals((await handleRequest(post({ action: "rekey" }, jwt), admin.deps)).status, 200);
  assertEquals((await handleRequest(post({ action: "rekey" }, { "x-cron-secret": SECRET }), user.deps)).status, 200);
});

Deno.test("tick answers 200 with the number of processed runs; an unexpected error is a 500 without details", async () => {
  const { deps, rig } = await setup({ flex: new FakeFlex([flexFail(1018)]) });
  await rig.store.createRun({ userId: USER, connectionId: "c1000000-0000-4000-8000-00000000000a", kind: "daily", statementFrom: null, statementTo: null, idempotencyKey: "k" });
  const ok = await handleRequest(post({ action: "tick" }, { "x-cron-secret": SECRET }), deps);
  assertEquals([ok.status, (await ok.json()).processed], [200, 1]);
  rig.store.claimRuns = () => Promise.reject(new Error(`boom ${TOKEN}`));
  const boom = await handleRequest(post({ action: "tick" }, { "x-cron-secret": SECRET }), deps);
  assertEquals(boom.status, 500);
  const text = await boom.text();
  assertEquals(JSON.parse(text), { error: "internal_error" });
  assert(!text.includes(TOKEN));
});

Deno.test("ingest_fixture works in worker mode only with fixture mode on", async () => {
  const off = await setup();
  assertEquals((await handleRequest(post({ action: "ingest_fixture", userId: USER, xml: "<x/>" }, { "x-cron-secret": SECRET }), off.deps)).status, 403);
  const on = await setup({ fixtureMode: true });
  assertEquals((await handleRequest(post({ action: "ingest_fixture", userId: USER, xml: "<x/>" }, { "x-cron-secret": SECRET }), on.deps)).status, 200);
});

Deno.test("fixture mode is only ever enabled for a local Supabase URL", () => {
  for (const url of ["http://127.0.0.1:54321", "http://localhost:54321", "http://host.docker.internal:54321"]) assertEquals(isLocalUrl(url), true, url);
  for (const url of ["https://abc.supabase.co", "http://127.0.0.1.evil.com", "", "not a url"]) assertEquals(isLocalUrl(url), false, url);
});
```

`supabase/functions/broker-sync/handler.ts`:

```ts
import { corsHeaders, json, readJson, requireCronSecret } from "@adapters/http.ts";
import { type UserVerifier, authenticate } from "@adapters/user-auth.ts";
import { workerTick } from "./machine.ts";
import { type ServiceDeps, type ServiceResult, ingestFixture, link, rekeyAll, syncNow, testConnection, unlink } from "./service.ts";

export interface HandlerDeps {
  brokerDeps: ServiceDeps;
  verifier: UserVerifier;
  cronSecret: string;
  allowedOrigins?: string[];
}

const TICK_BUDGET_MS = 100_000;
const USER_ACTIONS = new Set(["link", "test", "sync", "unlink", "rekey"]);
const WORKER_ACTIONS = new Set(["tick", "rekey", "ingest_fixture"]);

/** Fixture mode needs FLEX_FIXTURE_MODE=1 AND a local Supabase URL (spec 7.12: mocks must never look like production data). */
export function isLocalUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === "127.0.0.1" || host === "localhost" || host === "host.docker.internal";
  } catch {
    return false;
  }
}

function respond(r: ServiceResult, cors: Record<string, string>): Response {
  return json(r.body, { status: r.status, headers: { ...cors, ...(r.headers ?? {}) } });
}

export async function handleRequest(req: Request, d: HandlerDeps): Promise<Response> {
  const cors = corsHeaders(req.headers.get("origin"), d.allowedOrigins);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, { status: 405, headers: { ...cors, allow: "POST, OPTIONS" } });

  try {
    const workerMode = req.headers.has("x-cron-secret");
    if (workerMode) {
      const denied = await requireCronSecret(req, d.cronSecret);
      if (denied !== null) return denied;
    }
    const auth = workerMode ? null : await authenticate(req, d.verifier, cors);
    if (auth !== null && !auth.ok) return auth.response;

    const body = await readJson(req, workerMode ? 5_000_000 : 10_000);
    if (!body.ok) return body.response;
    const input = typeof body.value === "object" && body.value !== null ? (body.value as Record<string, unknown>) : {};
    const action = typeof input["action"] === "string" ? input["action"] : "";
    if (!(USER_ACTIONS.has(action) || WORKER_ACTIONS.has(action))) return json({ error: "unknown_action" }, { status: 400, headers: cors });

    if (workerMode) {
      if (!WORKER_ACTIONS.has(action)) return json({ error: "unknown_action" }, { status: 400, headers: cors });
      if (action === "tick") return json({ ok: true, ...(await workerTick(d.brokerDeps, TICK_BUDGET_MS)) }, { headers: cors });
      if (action === "rekey") return respond(await rekeyAll(d.brokerDeps, null), cors);
      return respond(await ingestFixture(d.brokerDeps, input), cors);
    }

    if (!USER_ACTIONS.has(action)) return json({ error: "forbidden" }, { status: 403, headers: cors });
    const userId = (auth as { ok: true; userId: string }).userId;
    switch (action) {
      case "link":
        return respond(await link(d.brokerDeps, userId, input), cors);
      case "test":
        return respond(await testConnection(d.brokerDeps, userId), cors);
      case "sync":
        return respond(await syncNow(d.brokerDeps, userId), cors);
      case "unlink":
        return respond(await unlink(d.brokerDeps, userId, input), cors);
      default:
        if (!(await d.brokerDeps.store.isAdmin(userId))) return json({ error: "forbidden" }, { status: 403, headers: cors });
        return respond(await rekeyAll(d.brokerDeps, userId), cors);
    }
  } catch (e) {
    d.brokerDeps.log("request_failed", { error: e instanceof Error ? e.name : "error" });
    return json({ error: "internal_error" }, { status: 500, headers: cors });
  }
}
```

Run: `deno test -A --config supabase/functions/deno.json supabase/functions/broker-sync/handler.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 10: Supabase-backed store and `index.ts` (wiring; covered by the integration test of Task 9)**

`supabase/functions/broker-sync/store.ts`:

```ts
import type { SupabaseClient } from "@supabase/supabase-js";
import { type Sealed, toBytea } from "@adapters/crypto.ts";
import type { MarketDataProvider } from "@adapters/providers.ts";
import { resolveCurrency } from "@core/units.ts";
import { normalizeName } from "@core/identity.ts";
import type { MatchOutcome, MatchPorts, MatchStore, PositionRef, SecurityLite } from "./matching.ts";
import type { IngestPayload } from "./persist.ts";
import type { AuditEvent, ConnectionPatch, ConnectionRow, RunKind, RunPatch, RunRow, SyncStore } from "./types.ts";

/** Errors carry the operation and the PostgREST code only: row values (ciphertext, token) never end up in a message. */
export class StoreError extends Error {
  constructor(readonly op: string, readonly code: string | null) {
    super(`broker store: ${op}${code === null ? "" : ` (${code})`}`);
    this.name = "StoreError";
  }
}

const CONN_COLS =
  "id,user_id,status,flex_token_ciphertext,flex_token_iv,key_version,token_expires_on,query_id,account_id_masked,base_currency,account_type,linked_at,last_verified_at,last_sync_at,last_statement_date,last_error_code,last_error_message,last_error_at,next_flex_fetch_not_before,coverage_from";
const RUN_COLS = "id,user_id,connection_id,kind,state,reference_code,poll_count,next_poll_at,statement_from,statement_to,error_code,error_message,rows_summary,idempotency_key";
const DATA_TABLES = ["broker_positions", "broker_trades", "broker_closed_lots", "broker_cash_transactions", "broker_corporate_actions", "broker_fx_rates", "broker_nav"];

export function createSupabaseStore(sb: SupabaseClient): SyncStore {
  const app = () => sb.schema("app");
  const fail = (op: string, error: { code?: string } | null): never => {
    throw new StoreError(op, error?.code ?? null);
  };

  return {
    async getConnection(userId) {
      const { data, error } = await sb.from("broker_connections").select(CONN_COLS).eq("user_id", userId).maybeSingle();
      if (error) fail("getConnection", error);
      return (data as ConnectionRow | null) ?? null;
    },
    async getConnectionById(id) {
      const { data, error } = await sb.from("broker_connections").select(CONN_COLS).eq("id", id).maybeSingle();
      if (error) fail("getConnectionById", error);
      return (data as ConnectionRow | null) ?? null;
    },
    async upsertLinking(i) {
      const { data, error } = await sb
        .from("broker_connections")
        .upsert(
          {
            id: i.id, user_id: i.userId, status: "linking", flex_token_ciphertext: toBytea(i.sealed.ciphertext), flex_token_iv: toBytea(i.sealed.iv),
            key_version: i.sealed.version, query_id: i.queryId, token_expires_on: i.tokenExpiresOn, last_error_code: null, last_error_message: null, last_error_at: null,
          },
          { onConflict: "user_id" },
        )
        .select(CONN_COLS)
        .single();
      if (error) fail("upsertLinking", error);
      return data as unknown as ConnectionRow;
    },
    async patchConnection(id, patch: ConnectionPatch) {
      const { error } = await sb.from("broker_connections").update(patch).eq("id", id);
      if (error) fail("patchConnection", error);
    },
    async zeroToken(id) {
      const { error } = await sb
        .from("broker_connections")
        .update({
          status: "unlinked", flex_token_ciphertext: null, flex_token_iv: null, key_version: null, query_id: null, token_expires_on: null, linked_at: null,
          last_error_code: null, last_error_message: null, last_error_at: null, next_flex_fetch_not_before: null,
        })
        .eq("id", id);
      if (error) fail("zeroToken", error);
    },
    async deleteBrokerData(userId, o = {}) {
      for (const table of DATA_TABLES) {
        const { error } = await sb.from(table).delete().eq("user_id", userId);
        if (error) fail(`delete ${table}`, error);
      }
      if (o.includeRuns === true) {
        const { error } = await sb.from("broker_sync_runs").delete().eq("user_id", userId);
        if (error) fail("delete broker_sync_runs", error);
      }
    },
    async cancelActiveRuns(userId, reason) {
      const { error } = await sb
        .from("broker_sync_runs")
        .update({ state: "failed", error_code: -7, error_message: reason, finished_at: new Date().toISOString(), lease_until: null, next_poll_at: null })
        .eq("user_id", userId)
        .in("state", ["queued", "requested", "polling", "parsing"]);
      if (error) fail("cancelActiveRuns", error);
    },
    async createRun(i: { userId: string; connectionId: string; kind: RunKind; statementFrom: string | null; statementTo: string | null; idempotencyKey: string }) {
      const { data, error } = await sb
        .from("broker_sync_runs")
        .insert({ user_id: i.userId, connection_id: i.connectionId, kind: i.kind, state: "queued", statement_from: i.statementFrom, statement_to: i.statementTo, idempotency_key: i.idempotencyKey })
        .select(RUN_COLS)
        .single();
      if (error?.code === "23505") return null;
      if (error) fail("createRun", error);
      return data as unknown as RunRow;
    },
    async getRun(id) {
      const { data, error } = await sb.from("broker_sync_runs").select(RUN_COLS).eq("id", id).maybeSingle();
      if (error) fail("getRun", error);
      return (data as RunRow | null) ?? null;
    },
    async latestActiveRun(userId) {
      const { data, error } = await sb.from("broker_sync_runs").select(RUN_COLS).eq("user_id", userId).in("state", ["queued", "requested", "polling", "parsing"]).limit(1);
      if (error) fail("latestActiveRun", error);
      return ((data as RunRow[] | null) ?? [])[0] ?? null;
    },
    async leaseRun(id, seconds) {
      const { data, error } = await app().rpc("lease_broker_run", { p_run: id, p_lease_seconds: seconds });
      if (error) fail("leaseRun", error);
      return ((data as RunRow[] | null) ?? [])[0] ?? null;
    },
    async claimRuns(limit, seconds) {
      const { data, error } = await app().rpc("claim_broker_runs", { p_limit: limit, p_lease_seconds: seconds });
      if (error) fail("claimRuns", error);
      return (data as RunRow[] | null) ?? [];
    },
    async patchRun(id, patch: RunPatch) {
      const { data, error } = await sb.from("broker_sync_runs").update(patch).eq("id", id).select(RUN_COLS).single();
      if (error) fail("patchRun", error);
      return data as unknown as RunRow;
    },
    async enqueueManualSync(userId) {
      const { data, error } = await app().rpc("enqueue_manual_sync", { p_user: userId });
      if (error) fail("enqueueManualSync", error);
      const row = ((data as Array<{ run_id: string | null; outcome: "created" | "busy" | "cooldown" | "not_linked"; retry_after_seconds: number }> | null) ?? [])[0];
      if (row === undefined) return fail("enqueueManualSync", null);
      return { runId: row.run_id, outcome: row.outcome, retryAfterSeconds: row.retry_after_seconds };
    },
    async ingest(runId, payload: IngestPayload) {
      const { data, error } = await app().rpc("broker_ingest_statement", { p_run_id: runId, p_payload: payload });
      if (error) fail("ingest", error);
      const out = (data ?? {}) as Record<string, unknown>;
      return Object.fromEntries(Object.entries(out).filter(([k, v]) => k !== "report_date" && typeof v === "number")) as Record<string, number>;
    },
    async listConnectionsForRekey(current) {
      const { data, error } = await sb.from("broker_connections").select(CONN_COLS).not("key_version", "is", null).neq("key_version", current).not("flex_token_ciphertext", "is", null);
      if (error) fail("listConnectionsForRekey", error);
      return (data as ConnectionRow[] | null) ?? [];
    },
    async rekeyConnection(id, sealed: Sealed) {
      const { error } = await sb
        .from("broker_connections")
        .update({ flex_token_ciphertext: toBytea(sealed.ciphertext), flex_token_iv: toBytea(sealed.iv), key_version: sealed.version })
        .eq("id", id);
      if (error) fail("rekeyConnection", error);
    },
    async isAdmin(userId) {
      const { data, error } = await sb.from("profiles").select("is_admin").eq("user_id", userId).maybeSingle();
      if (error) fail("isAdmin", error);
      return (data as { is_admin: boolean } | null)?.is_admin === true;
    },
    async audit(e: AuditEvent) {
      const { error } = await sb
        .from("audit_events")
        .insert({ actor: e.actor, actor_user_id: e.actorUserId, event_type: e.eventType, target_type: "broker_connection", data: e.data });
      if (error) fail("audit", error);
    },
  };
}

const SEC_COLS = "id,yahoo_symbol,exchange_code,currency_major,quote_type,company_id,isin,is_canonical";

export function createMatchPorts(sb: SupabaseClient, market: MarketDataProvider): MatchPorts {
  return {
    async securitiesByIsin(isin) {
      const { data, error } = await sb.from("securities").select(SEC_COLS).eq("isin", isin).eq("status", "active");
      if (error) throw new StoreError("securitiesByIsin", error.code ?? null);
      return (data as SecurityLite[] | null) ?? [];
    },
    async securityBySymbol(symbol) {
      const { data, error } = await sb.from("securities").select(SEC_COLS).eq("yahoo_symbol", symbol).maybeSingle();
      if (error) throw new StoreError("securityBySymbol", error.code ?? null);
      return (data as SecurityLite | null) ?? null;
    },
    async exchangeByIbkrId(id) {
      const { data, error } = await sb.from("exchanges").select("code,yahoo_suffix").eq("ibkr_exchange_id", id).limit(1);
      if (error) throw new StoreError("exchangeByIbkrId", error.code ?? null);
      const row = ((data as Array<{ code: string; yahoo_suffix: string | null }> | null) ?? [])[0];
      return row === undefined ? null : { code: row.code, yahooSuffix: row.yahoo_suffix === "" ? null : row.yahoo_suffix };
    },
    async canonicalOf(companyId) {
      const { data, error } = await sb.from("securities").select(SEC_COLS).eq("company_id", companyId).eq("is_canonical", true).maybeSingle();
      if (error) throw new StoreError("canonicalOf", error.code ?? null);
      return (data as SecurityLite | null) ?? null;
    },
    async setSecurityIsin(securityId, isin) {
      const { error } = await sb.from("securities").update({ isin }).eq("id", securityId).is("isin", null);
      if (error) throw new StoreError("setSecurityIsin", error.code ?? null);
    },
    async searchIsin(isin) {
      const { hits } = await market.search(isin, { quotesCount: 3, newsCount: 0 });
      return hits.filter((h) => h.quoteType === "EQUITY" || h.quoteType === "ETF").map((h) => ({ symbol: h.symbol, quoteType: h.quoteType }));
    },
    async ensureSecurity(symbol) {
      const quote = (await market.quote([symbol]))[0];
      if (quote === undefined) return { error: "no_quote" };
      const exchange = await sb.from("exchanges").select("code").eq("code", quote.exchange).maybeSingle();
      if (exchange.error || exchange.data === null) return { error: "unknown_exchange" };
      const name = quote.longName ?? quote.shortName ?? symbol;
      const company = await sb.from("companies").insert({ name, name_normalized: normalizeName(name), identity_note: "created_by_broker_match" }).select("id").single();
      if (company.error) throw new StoreError("ensureSecurity.company", company.error.code ?? null);
      const unit = resolveCurrency(quote.currency);
      const created = await sb
        .from("securities")
        .insert({
          company_id: (company.data as { id: string }).id, yahoo_symbol: symbol, exchange_code: quote.exchange, currency: quote.currency, currency_major: unit.major,
          minor_divisor: unit.divisor, quote_type: quote.quoteType, long_name: quote.longName, financial_currency: quote.financialCurrency,
        })
        .select(SEC_COLS)
        .single();
      if (created.error) throw new StoreError("ensureSecurity.security", created.error.code ?? null);
      return created.data as unknown as SecurityLite;
    },
  };
}

export function createMatchStore(sb: SupabaseClient): MatchStore {
  return {
    async positionsToMatch(userId): Promise<PositionRef[]> {
      const latest = await sb.from("broker_positions").select("report_date").eq("user_id", userId).order("report_date", { ascending: false }).limit(1);
      const date = ((latest.data as Array<{ report_date: string }> | null) ?? [])[0]?.report_date;
      if (date === undefined) return [];
      const { data, error } = await sb
        .from("broker_positions")
        .select("id,conid,isin,symbol,listing_exchange,currency,asset_class,sub_category")
        .eq("user_id", userId)
        .eq("report_date", date)
        .eq("match_status", "unmatched");
      if (error) throw new StoreError("positionsToMatch", error.code ?? null);
      return ((data as Array<Record<string, string | number | null>> | null) ?? []).map((r) => ({
        id: r["id"] as number, conid: r["conid"] as number, isin: r["isin"] as string | null, symbol: r["symbol"] as string,
        listingExchange: r["listing_exchange"] as string | null, currency: r["currency"] as string, assetClass: r["asset_class"] as string | null,
        subCategory: r["sub_category"] as string | null,
      }));
    },
    async applyOutcome(_userId, o: MatchOutcome) {
      const unavailable = o.matchStatus === "unmatched" || o.matchStatus === "not_equity";
      const { error } = await sb
        .from("broker_positions")
        .update({
          security_id: o.securityId, signal_security_id: o.signalSecurityId, match_status: o.matchStatus,
          valuation_tag: unavailable ? "unavailable" : null,
          valuation_reason: unavailable ? (o.reason === "no_match" ? "no Yahoo match" : (o.reason ?? "not evaluated")) : null,
        })
        .eq("id", o.positionId);
      if (error) throw new StoreError("applyOutcome", error.code ?? null);
    },
  };
}
```

`supabase/functions/broker-sync/index.ts` (replaces the placeholder):

```ts
import { createClient } from "@supabase/supabase-js";
import { systemClock } from "@adapters/clock.ts";
import { currentKeyVersion, open, seal } from "@adapters/crypto.ts";
import { createQuoteCacheKv, createServiceClient } from "@adapters/db.ts";
import { requireEnv } from "@adapters/env.ts";
import { createFlexClient, createRpcLimiter } from "@adapters/flex.ts";
import { parseFlexStatement } from "@adapters/flex-parse.ts";
import { allowedOriginsFromEnv } from "@adapters/http.ts";
import { createClaimsVerifier } from "@adapters/user-auth.ts";
import { createYahooProvider } from "@adapters/yahoo.ts";
import { type HandlerDeps, handleRequest, isLocalUrl } from "./handler.ts";
import { matchUserPositions } from "./matching.ts";
import { createRiskSetStore, refreshRiskSet } from "@adapters/risk-set.ts";
import { createMatchPorts, createMatchStore, createSupabaseStore } from "./store.ts";

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined;

/** Sofia date "YYYY-MM-DD". */
function sofiaToday(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Sofia", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

function buildDeps(): HandlerDeps {
  const url = requireEnv("SUPABASE_URL");
  const sb = createServiceClient();
  const env = { get: (name: string) => Deno.env.get(name) };
  const store = createSupabaseStore(sb);
  const market = createYahooProvider({ fetchImpl: fetch, store: createQuoteCacheKv(sb), clock: systemClock });
  const matchPorts = createMatchPorts(sb, market);
  const matchStore = createMatchStore(sb);
  const riskStore = createRiskSetStore(sb);
  const flex = createFlexClient({
    userAgent: requireEnv("FLEX_USER_AGENT"),
    limiter: createRpcLimiter({
      take: async (key) => {
        const { data, error } = await sb.schema("app").rpc("flex_rl_take", { p_key: key });
        if (error) throw new Error("limiter unavailable");
        return Number(data ?? 0);
      },
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    }),
  });
  return {
    brokerDeps: {
      store,
      flex,
      keys: {
        seal: (plain, ctx) => seal(plain, ctx, env),
        open: (sealed, ctx) => open(sealed, ctx, env),
        currentVersion: () => currentKeyVersion(env),
      },
      parse: (xml) => parseFlexStatement(xml),
      matcher: { matchUserPositions: (userId) => matchUserPositions(userId, matchStore, matchPorts) },
      riskSet: {
        refresh: (userId) => refreshRiskSet(riskStore, userId),
        pause: (userId) => riskStore.pause(userId),
        remove: (userId) => riskStore.remove(userId),
      },
      now: () => Date.now(),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      log: (event, data) => console.log(JSON.stringify({ fn: "broker-sync", event, ...data })),
      background: (p) => (typeof EdgeRuntime === "undefined" ? void p : EdgeRuntime.waitUntil(p)),
      todayIso: sofiaToday,
      fixtureMode: Deno.env.get("FLEX_FIXTURE_MODE") === "1" && isLocalUrl(url),
    },
    verifier: createClaimsVerifier({ url, anonKey: requireEnv("SUPABASE_ANON_KEY"), createClient: createClient as never }),
    cronSecret: requireEnv("CRON_SHARED_SECRET"),
    allowedOrigins: allowedOriginsFromEnv(),
  };
}

let deps: HandlerDeps | undefined;
Deno.serve((req) => handleRequest(req, (deps ??= buildDeps())));
```

Adapt notes (one line each; P1 owns these names): `createServiceClient`/`createQuoteCacheKv` are in `adapters/db.ts`, `systemClock` in `adapters/clock.ts`, `createYahooProvider({ fetchImpl, store, clock })` in `adapters/yahoo.ts`; `normalizeName` in `core/identity.ts`; `SUPABASE_ANON_KEY` is provided by the platform to every function.

Run: `bun run functions:check`
Expected: exit 0 (type-checks `index.ts`, `store.ts`, `handler.ts`; if an import name differs, fix that one line).

- [ ] **Step 11: `portfolio_scan` stage: tests first**

`supabase/functions/worker-tick/handlers/portfolio_scan.test.ts`:

```ts
import { assertEquals } from "@std/assert";
import {
  type HoldingResult, type PremiumStore, applyPremiumEpisodes, buildHoldingRows, planPortfolioJobs, tagFor,
} from "./portfolio_scan.ts";

const END = { upper2: 140, upper1: 120, base: 100, lower1: 85, lower2: 70 };
const result = (o: Partial<HoldingResult> = {}): HoldingResult => ({
  securityId: "s1", status: "processed", sessionDate: "2026-10-14", close: 100, channel: { end: END }, quoteType: "EQUITY", companyId: "co1", ...o,
});

Deno.test("planPortfolioJobs seeds holdings chunks of 12 plus premium and risk_set, always (an empty portfolio still ends the stage)", () => {
  const ids = Array.from({ length: 25 }, (_, i) => `s${i}`);
  const plan = planPortfolioJobs(ids);
  assertEquals(plan.keys, ["holdings:0", "holdings:1", "holdings:2", "premium", "risk_set"]);
  assertEquals((plan.payloads?.[2] as { securityIds: string[] }).securityIds.length, 1);
  assertEquals(plan.priorities, [10, 10, 10, 20, 30]);
  assertEquals(planPortfolioJobs([]).keys, ["premium", "risk_set"]);
});

Deno.test("tag mapping: Discounted at or below the -4 line, Premium at +1, Extra premium at +2, none in between, Unavailable without a channel", () => {
  assertEquals(tagFor(result({ close: 70 }), null).tag, "discounted");
  assertEquals(tagFor(result({ close: 69.99 }), null).tag, "discounted");
  assertEquals(tagFor(result({ close: 70.01 }), null).tag, "none");
  assertEquals(tagFor(result({ close: 120 }), null).tag, "premium");
  assertEquals(tagFor(result({ close: 140 }), null).tag, "extra_premium");
  assertEquals(tagFor(result({ close: 100 }), null).tag, "none");
  assertEquals(tagFor(result({ channel: null }), null).tag, "unavailable");
  assertEquals(tagFor(result({ status: "insufficient_data" }), null).tag, "unavailable");
  assertEquals(tagFor(result({ status: "stale" }), null).tag, "unavailable");
  assertEquals(tagFor(result({ quoteType: "ETF", close: 50 }), null).tag, "unavailable");
  assertEquals(tagFor(undefined, null), { tag: "unavailable", reason: "no scan result for this security", sessionDate: null });
});

Deno.test("holdings outside the universe use the -4 line, members of the top 10 use -3, and a zero or negative lower line is never a discount", () => {
  assertEquals(tagFor(result({ close: 80 }), null).tag, "none"); // -4 line is 70
  assertEquals(tagFor(result({ close: 80 }), 11).tag, "none");
  assertEquals(tagFor(result({ close: 80 }), 7).tag, "discounted"); // rank 1-10 uses -3 = 85
  assertEquals(tagFor(result({ close: 0, channel: { end: { ...END, lower2: 0 } } }), null).tag, "none"); // close <= 0 line, but the zero-line rule blocks it
});

Deno.test("the tag explains its basis with the session date of the completed close, never the delayed quote", () => {
  const t = tagFor(result({ close: 70 }), null);
  assertEquals(t.sessionDate, "2026-10-14");
  assertEquals(t.reason, "based on close of 2026-10-14");
});

Deno.test("buildHoldingRows writes holding_only results with the channel, freshness status and validity", () => {
  const rows = buildHoldingRows({
    runId: "r1",
    length: 2500,
    nowIso: "2026-10-15T08:00:00.000Z",
    securities: [{ id: "s1", quote_type: "EQUITY", exchange_code: "NMS" }, { id: "s2", quote_type: "EQUITY", exchange_code: "NMS" }, { id: "s3", quote_type: "EQUITY", exchange_code: "NMS" }],
    series: [
      { security_id: "s1", close: [1, 2, 3], bar_count: 2600, last_session_date: "2026-10-14", completeness: {}, end: END },
      { security_id: "s2", close: [1, 2, 3], bar_count: 100, last_session_date: "2026-10-14", completeness: {}, end: null },
    ],
    freshness: () => "fresh",
  });
  assertEquals(rows.map((r) => [r["security_id"], r["status"], r["scope"]]), [["s1", "processed", "holding_only"], ["s2", "insufficient_data", "holding_only"], ["s3", "failed", "holding_only"]]);
  assertEquals((rows[0]?.["channel"] as { end: typeof END }).end.upper1, 120);
  assertEquals(rows[0]?.["tier1_member"], false);
  assertEquals(rows[2]?.["reason_codes"], ["unprocessed"]);
});

function fakePremiumStore() {
  const episodes: Array<{ id: string; kind: string; closed: boolean; opened: string; last: number }> = [];
  const store: PremiumStore = {
    active: (securityId, kind) => {
      const e = episodes.find((x) => x.kind === kind && !x.closed);
      return Promise.resolve(e === undefined ? null : { id: e.id, kind: kind, mode: "worldwide", line: kind === "premium1" ? "+1" : "+2", openedSessionDay: 0, lastEvaluatedSessionDay: e.last });
    },
    open: (e) => (episodes.push({ id: `e${episodes.length}`, kind: e.kind, closed: false, opened: e.sessionDate, last: e.sessionDay }), Promise.resolve()),
    close: (id) => {
      const e = episodes.find((x) => x.id === id);
      if (e !== undefined) e.closed = true;
      return Promise.resolve();
    },
    touch: (id, _date, day) => {
      const e = episodes.find((x) => x.id === id);
      if (e !== undefined) e.last = day;
      return Promise.resolve();
    },
  };
  return { store, episodes };
}

const obs = (close: number, sessionDate: string, canOpen = true) => ({ runId: "r1", securityId: "s1", companyId: "co1", sessionDate, close, end: { upper1: 120, upper2: 140 }, canOpen });

Deno.test("premium episodes: +1 and +2 are independent, carry mode worldwide, open once, re-arm only below the line", async () => {
  const { store, episodes } = fakePremiumStore();
  assertEquals(await applyPremiumEpisodes(store, obs(125, "2026-10-12")), { opened: 1, closed: 0 }); // +1 only
  assertEquals(await applyPremiumEpisodes(store, obs(125, "2026-10-12")), { opened: 0, closed: 0 }); // same session: idempotent
  assertEquals(await applyPremiumEpisodes(store, obs(150, "2026-10-13")), { opened: 1, closed: 0 }); // +2 opens, +1 continues
  assertEquals(await applyPremiumEpisodes(store, obs(130, "2026-10-14")), { opened: 0, closed: 1 }); // +2 closes, +1 stays
  assertEquals(episodes.map((e) => [e.kind, e.closed]), [["premium1", false], ["premium2", true]]);
  assertEquals(await applyPremiumEpisodes(store, obs(110, "2026-10-15")), { opened: 0, closed: 1 }); // +1 closes
  assertEquals(await applyPremiumEpisodes(store, obs(121, "2026-10-16")), { opened: 1, closed: 0 }); // new +1 episode
  assertEquals(episodes.filter((e) => e.kind === "premium1").length, 2);
});

Deno.test("premium episodes need an evaluable held equity but no rising channel, rank or market cap (A-36)", async () => {
  const { store, episodes } = fakePremiumStore();
  assertEquals(await applyPremiumEpisodes(store, obs(125, "2026-10-12", false)), { opened: 0, closed: 0 });
  assertEquals(episodes.length, 0);
});
```

`supabase/functions/worker-tick/handlers/portfolio_scan.ts`:

```ts
// Stage 8 `portfolio_scan` (spec 7.4, 8.5, 8.6, 9.7): holding bars and results, valuation tags, premium episodes, risk-monitor set.
import { computeChannel, type Channel } from "../../_shared/core/indicator.ts";
import { freshnessOf } from "../../_shared/core/calendar.ts";
import { classifyHolding } from "../../_shared/core/thresholds.ts";
import { type ActiveEpisode, type Observation, stepPremium } from "../../_shared/core/episodes.ts";
import { chunk } from "../lib/batching.ts";
import { dayOfDate, fetchByIds, loadExchanges, upsertChunks } from "../lib/data.ts";
import { DeferError, FatalJobError, type Handler, type HandlerContext, type SeedPlan, type Seeder } from "../types.ts";
import { handleFetchBars } from "./fetch_bars.ts";
import { createRiskSetStore, refreshRiskSet } from "../../_shared/adapters/risk-set.ts";

export const HOLDINGS_BATCH = 12;
export const PRIORITY = { holdings: 10, premium: 20, risk_set: 30 } as const;

export interface HoldingResult {
  securityId: string;
  status: string;
  sessionDate: string | null;
  close: number | null;
  channel: { end: Channel["end"] } | null;
  quoteType: string;
  companyId: string;
}

/** `premium` and `risk_set` are always seeded, so a run without holdings still finishes the stage. */
export function planPortfolioJobs(todo: readonly string[]): SeedPlan {
  const parts = chunk([...todo], HOLDINGS_BATCH);
  return {
    keys: [...parts.map((_, i) => `holdings:${i}`), "premium", "risk_set"],
    payloads: [...parts.map((ids) => ({ securityIds: ids })), {}, {}],
    priorities: [...parts.map(() => PRIORITY.holdings), PRIORITY.premium, PRIORITY.risk_set],
  };
}

/** Held signal securities that the universe scan of this run did not process (those need fetch + compute here). */
export const seedPortfolioScan: Seeder = async (ctx) => {
  const held = await heldSignalSecurities(ctx.db.sb);
  const done = await alreadyScanned(ctx.db.sb, ctx.run.id, held);
  return planPortfolioJobs(held.filter((id) => !done.has(id)));
};

async function alreadyScanned(sb: HandlerContext["db"]["sb"], runId: string, ids: readonly string[]): Promise<Set<string>> {
  const out = new Set<string>();
  for (const part of chunk([...ids], 100)) {
    const { data, error } = await sb.from("scan_security_results").select("security_id").eq("scan_run_id", runId).eq("scope", "universe").eq("status", "processed").in("security_id", part);
    if (error) throw new FatalJobError(`scan_security_results: ${error.code ?? "error"}`);
    for (const r of (data as Array<{ security_id: string }> | null) ?? []) out.add(r.security_id);
  }
  return out;
}

async function heldSignalSecurities(sb: HandlerContext["db"]["sb"]): Promise<string[]> {
  const { data, error } = await sb.schema("app").rpc("held_signal_securities");
  if (error) throw new FatalJobError(`held_signal_securities: ${error.code ?? "error"}`);
  return ((data as Array<{ security_id: string }> | null) ?? []).map((r) => r.security_id).sort();
}

// ---------------------------------------------------------------------------------------------------- holdings: bars + holding_only results

export interface SeriesInput {
  security_id: string;
  close: number[];
  bar_count: number;
  last_session_date: string;
  completeness: Record<string, unknown>;
  end: Channel["end"] | null;
}

export function buildHoldingRows(a: {
  runId: string;
  length: number;
  nowIso: string;
  securities: Array<{ id: string; quote_type: string; exchange_code: string }>;
  series: SeriesInput[];
  freshness: (lastSessionDate: string, exchangeCode: string) => "fresh" | "stale" | "unavailable";
}): Array<Record<string, unknown>> {
  const byId = new Map(a.series.map((s) => [s.security_id, s]));
  return a.securities.map((sec) => {
    const base = { scan_run_id: a.runId, security_id: sec.id, scope: "holding_only", computed_at: a.nowIso, tier1_member: false };
    const s = byId.get(sec.id);
    if (s === undefined) return { ...base, status: "failed", reason_codes: ["unprocessed"] };
    const freshness = a.freshness(s.last_session_date, sec.exchange_code);
    const status = s.bar_count < a.length ? "insufficient_data" : freshness !== "fresh" ? "stale" : "processed";
    return {
      ...base,
      status,
      reason_codes: [],
      session_date: s.last_session_date,
      close: s.close[s.close.length - 1] ?? null,
      freshness,
      valid_bars: s.bar_count,
      channel: s.end === null ? null : { end: s.end },
    };
  });
}

async function handleHoldings(ctx: HandlerContext): Promise<Record<string, unknown>> {
  const sb = ctx.db.sb;
  const ids = Array.isArray(ctx.job.payload["securityIds"]) ? (ctx.job.payload["securityIds"] as string[]) : [];
  // bars: P1's fetch_bars handler works for any security ids in the payload
  const fetched = await handleFetchBars({ ...ctx, job: { ...ctx.job, payload: { securityIds: ids } } });

  const securities = await fetchByIds<{ id: string; quote_type: string; exchange_code: string }>(sb, "securities", "id, quote_type, exchange_code", "id", ids);
  const rows = await fetchByIds<{ security_id: string; close: number[]; high: number[]; low: number[]; bar_count: number; last_session_date: string; completeness: Record<string, unknown> }>(
    sb, "price_series", "security_id, close, high, low, bar_count, last_session_date, completeness", "security_id", ids,
  );
  const settings = ctx.run.settings.indicator;
  const exchanges = await loadExchanges(sb);
  const series: SeriesInput[] = rows.map((r) => {
    const outcome = computeChannel({ close: r.close, high: r.high, low: r.low }, settings);
    return { security_id: r.security_id, close: r.close, bar_count: r.bar_count, last_session_date: r.last_session_date, completeness: r.completeness, end: outcome.ok ? outcome.channel.end : null };
  });
  const out = buildHoldingRows({
    runId: ctx.run.id,
    length: settings.length,
    nowIso: new Date(ctx.run.startedAtMs).toISOString(),
    securities,
    series,
    freshness: (last, exchange) => freshnessOf(dayOfDate(last), ctx.run.scanDay, exchanges.get(exchange)?.max_gap_days ?? 5),
  });
  await upsertChunks(sb, "scan_security_results", out, "scan_run_id,security_id", 100);
  return { requested: ids.length, fetched, written: out.length };
}

// ---------------------------------------------------------------------------------------------------- tags

export function tagFor(r: HoldingResult | undefined, worldwideRank: number | null): { tag: string; reason: string; sessionDate: string | null } {
  if (r === undefined) return { tag: "unavailable", reason: "no scan result for this security", sessionDate: null };
  if (r.status !== "processed" || r.channel === null) {
    return { tag: "unavailable", reason: r.status === "processed" ? "channel not computable" : `data ${r.status.replace("_", " ")}`, sessionDate: r.sessionDate };
  }
  const tag = classifyHolding({ evaluable: true, quoteType: r.quoteType, close: r.close, end: r.channel.end, worldwideRank });
  if (tag === "unavailable") return { tag, reason: "not an equity", sessionDate: r.sessionDate };
  return { tag, reason: `based on close of ${r.sessionDate}`, sessionDate: r.sessionDate };
}

// ---------------------------------------------------------------------------------------------------- premium episodes

export interface PremiumStore {
  active(securityId: string, kind: "premium1" | "premium2"): Promise<ActiveEpisode | null>;
  open(e: { runId: string; securityId: string; companyId: string; kind: "premium1" | "premium2"; line: "+1" | "+2"; sessionDate: string; sessionDay: number; close: number; lineValue: number; notify: boolean; reason: string }): Promise<void>;
  close(id: string, runId: string, sessionDate: string, reason: string): Promise<void>;
  touch(id: string, sessionDate: string, sessionDay: number): Promise<void>;
}

export async function applyPremiumEpisodes(
  store: PremiumStore,
  i: { runId: string; securityId: string; companyId: string; sessionDate: string; close: number; end: { upper1: number; upper2: number }; canOpen: boolean },
): Promise<{ opened: number; closed: number }> {
  const sessionDay = dayOfDate(i.sessionDate);
  let opened = 0;
  let closed = 0;
  for (const [kind, line, lineValue] of [["premium1", "+1", i.end.upper1], ["premium2", "+2", i.end.upper2]] as const) {
    const active = await store.active(i.securityId, kind);
    const obs: Observation = { sessionDay, close: i.close, lineEnd: lineValue, canOpen: i.canOpen, rank: null, applicableLine: line };
    for (const action of stepPremium(active, obs, kind)) {
      if (action.type === "open") {
        await store.open({ runId: i.runId, securityId: i.securityId, companyId: i.companyId, kind, line, sessionDate: i.sessionDate, sessionDay, close: i.close, lineValue, notify: action.notify, reason: action.reason });
        opened += 1;
      } else if (action.type === "close" && active !== null) {
        await store.close(active.id, i.runId, i.sessionDate, action.reason);
        closed += 1;
      } else if (active !== null && sessionDay > active.lastEvaluatedSessionDay) {
        await store.touch(active.id, i.sessionDate, sessionDay);
      }
    }
  }
  return { opened, closed };
}

function createPremiumStore(sb: HandlerContext["db"]["sb"]): PremiumStore {
  return {
    async active(securityId, kind) {
      const { data, error } = await sb
        .from("signal_episodes")
        .select("id,kind,mode,threshold_line,opened_session_date,last_evaluated_session_date")
        .eq("security_id", securityId).eq("kind", kind).eq("mode", "worldwide").eq("status", "active").maybeSingle();
      if (error) throw new FatalJobError(`signal_episodes: ${error.code ?? "error"}`);
      const r = data as { id: string; threshold_line: "+1" | "+2"; opened_session_date: string; last_evaluated_session_date: string } | null;
      return r === null ? null : { id: r.id, kind, mode: "worldwide", line: r.threshold_line, openedSessionDay: dayOfDate(r.opened_session_date), lastEvaluatedSessionDay: dayOfDate(r.last_evaluated_session_date) };
    },
    async open(e) {
      const { error } = await sb.from("signal_episodes").insert({
        security_id: e.securityId, company_id: e.companyId, kind: e.kind, mode: "worldwide", threshold_line: e.line, status: "active",
        opened_scan_run_id: e.runId, opened_session_date: e.sessionDate, opened_close: e.close, opened_line_value: e.lineValue, opened_rank: null,
        open_reason: e.reason, notify: e.notify, last_evaluated_session_date: e.sessionDate,
      });
      if (error && error.code !== "23505") throw new FatalJobError(`signal_episodes.insert: ${error.code ?? "error"}`);
    },
    async close(id, runId, sessionDate, reason) {
      const { error } = await sb.from("signal_episodes").update({ status: "closed", closed_scan_run_id: runId, closed_session_date: sessionDate, close_reason: reason, last_evaluated_session_date: sessionDate }).eq("id", id);
      if (error) throw new FatalJobError(`signal_episodes.close: ${error.code ?? "error"}`);
    },
    async touch(id, sessionDate) {
      const { error } = await sb.from("signal_episodes").update({ last_evaluated_session_date: sessionDate }).eq("id", id);
      if (error) throw new FatalJobError(`signal_episodes.touch: ${error.code ?? "error"}`);
    },
  };
}

async function handlePremium(ctx: HandlerContext): Promise<Record<string, unknown>> {
  const sb = ctx.db.sb;
  // wait until every holdings job of this run is terminal (a dead chunk simply leaves its tags Unavailable)
  const { data: open } = await sb.from("scan_jobs").select("id").eq("scan_run_id", ctx.run.id).eq("stage", "portfolio_scan").like("key", "holdings:%").in("status", ["queued", "leased", "failed"]).limit(1);
  if (((open as unknown[] | null) ?? []).length > 0) throw new DeferError(20, "holdings_pending");

  const held = await heldSignalSecurities(sb);
  if (held.length === 0) return { held: 0 };
  const secs = await fetchByIds<{ id: string; quote_type: string; company_id: string }>(sb, "securities", "id, quote_type, company_id", "id", held);
  type ResultRow = { security_id: string; status: string; session_date: string | null; close: number | null; channel: { end: Channel["end"] } | null };
  const forRun = await sb.from("scan_security_results").select("security_id,status,session_date,close,channel").eq("scan_run_id", ctx.run.id).in("security_id", held);
  const current = new Map(((forRun.data as ResultRow[] | null) ?? []).map((r) => [r.security_id, r]));
  const ranks = await sb.from("universe_snapshots").select("security_id,rank").eq("scan_run_id", ctx.run.id).eq("mode", "worldwide").in("security_id", held);
  const rankOf = new Map(((ranks.data as Array<{ security_id: string; rank: number }> | null) ?? []).map((r) => [r.security_id, r.rank]));

  const premium = createPremiumStore(sb);
  const counts = { tagged: 0, opened: 0, closed: 0 };
  for (const sec of secs) {
    ctx.signal.throwIfAborted();
    const r = current.get(sec.id);
    const holding: HoldingResult | undefined = r === undefined ? undefined : { securityId: sec.id, status: r.status, sessionDate: r.session_date, close: r.close, channel: r.channel, quoteType: sec.quote_type, companyId: sec.company_id };
    const t = tagFor(holding, rankOf.get(sec.id) ?? null);
    const { error } = await sb.schema("app").rpc("apply_holding_tag", { p_security: sec.id, p_tag: t.tag, p_session: t.sessionDate, p_reason: t.reason });
    if (error) throw new FatalJobError(`apply_holding_tag: ${error.code ?? "error"}`);
    counts.tagged += 1;
    if (holding !== undefined && holding.status === "processed" && holding.channel !== null && holding.close !== null && holding.sessionDate !== null && sec.quote_type === "EQUITY") {
      const e = await applyPremiumEpisodes(premium, {
        runId: ctx.run.id, securityId: sec.id, companyId: sec.company_id, sessionDate: holding.sessionDate, close: holding.close,
        end: { upper1: holding.channel.end.upper1, upper2: holding.channel.end.upper2 }, canOpen: true,
      });
      counts.opened += e.opened;
      counts.closed += e.closed;
    }
  }
  await ctx.log("portfolio_premium", counts);
  return counts;
}

async function handleRiskSet(ctx: HandlerContext): Promise<Record<string, unknown>> {
  return await refreshRiskSet(createRiskSetStore(ctx.db.sb));
}

export const handlePortfolioScan: Handler = async (ctx) => {
  const kind = ctx.job.key.split(":")[0];
  if (kind === "holdings") return await handleHoldings(ctx);
  if (kind === "premium") return await handlePremium(ctx);
  if (kind === "risk_set") return await handleRiskSet(ctx);
  throw new FatalJobError(`unknown portfolio_scan job ${ctx.job.key}`);
};
```

Run: `deno test -A --config supabase/functions/deno.json supabase/functions/worker-tick/handlers/portfolio_scan.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 12: Register the stage in `worker-tick`**

In `supabase/functions/worker-tick/stages.ts` add (merge with P2's additions for `news`/`research` if they already landed):

```ts
import { handlePortfolioScan, seedPortfolioScan } from "./handlers/portfolio_scan.ts";

// PIPELINE_ORDER: append "portfolio_scan" after "publish" (the SQL function app.next_stage_to_seed was patched in Task 1)
PIPELINE_ORDER.push("portfolio_scan");        // or add it to the array literal
// HANDLERS: portfolio_scan: handlePortfolioScan,
// SEEDERS:  portfolio_scan: seedPortfolioScan,
```

Recommended (one line, merge with P2's research/news entries): in `supabase/functions/_shared/adapters/settings.ts` add `portfolio_scan: 1` to `DEFAULT_PIPELINE.stageCaps` and update the expected object in `settings.test.ts` (`stageCaps` assertion). The jobs are correct without the cap (`premium` defers until every `holdings:*` job is terminal) but the cap keeps Yahoo usage to one holdings job at a time.

Run: `bun run functions:check` then `bun run functions:test`
Expected: exit 0 and all suites pass, including the unchanged P1 `worker-tick` loop tests (the loop test that enumerates `PIPELINE_ORDER` must be updated to include `portfolio_scan` if it pins the array).

- [ ] **Step 13: Local smoke of the SQL seam (optional but recommended before the commit)**

With the stack running (`bun run supabase:start`) and `supabase/functions/.env` containing the keys from Task 2:

```powershell
bun run supabase:serve
```

In a second terminal: `Invoke-RestMethod -Method Post -Uri http://127.0.0.1:54321/functions/v1/broker-sync -Headers @{ "x-cron-secret" = "local-dev-cron-secret" } -ContentType "application/json" -Body '{"action":"tick"}'`
Expected: `{ ok: true, processed: 0 }`. Without the header the same call returns 401.

- [ ] **Step 14: Lint, type-check, full Deno suite, commit**

Run: `bun run lint:fix`, `bun run lint`, `bun run functions:check`, `bun run functions:test`
Expected: exit 0.

```text
git add supabase/functions/broker-sync supabase/functions/worker-tick supabase/functions/_shared/adapters/settings.ts supabase/functions/_shared/adapters/settings.test.ts
git commit -m "feat(broker): add broker-sync function, state machine, matching, risk set and the portfolio_scan stage"
```

---

## Task 5: `portfolio-refresh` Edge Function, valuation core and the refresh hooks

**Concurrency:** starts after Tasks 1, 2 and 3 (it needs `app.claim_manual_refresh`, `user-auth.ts` and `accounting.ts`). May run at the same time as Task 4 (disjoint files).

**Files:**
- Create (core): `supabase/functions/_shared/core/statement-day.ts`, `statement-day.test.ts`, `portfolio-view.ts`, `portfolio-view.test.ts`
- Replace the scaffold: `supabase/functions/portfolio-refresh/index.ts`; create `handler.ts`, `quotes.ts`, `store.ts`, `handler.test.ts`, `quotes.test.ts`
- Create (web, shared by the Portfolio and Analytics pages): `apps/web/src/features/portfolio/portfolio-api.ts`, `portfolio-api.test.ts`, `default.ts`, `cooldown.ts`, `cooldown.test.ts`, `use-visible-interval.ts`, `use-visible-interval.test.tsx`, `use-portfolio.ts`, `use-portfolio.test.tsx`, `use-manual-refresh.ts`, `use-manual-refresh.test.tsx`, `pull-to-refresh.tsx`, `pull-to-refresh.test.tsx`, `refresh-bar.tsx`, `refresh-bar.test.tsx`, `money-text.tsx`, `money-text.test.tsx`, `provenance.tsx`

**Interfaces:**
- Consumes: Task 1 (`app.claim_manual_refresh`, `broker_sync_runs`, `quote_cache`), Task 2 (`user-auth.ts`), Task 3 (`accounting.ts`), P1 (`units.ts`, `calendar.ts`, `createYahooProvider`, `createQuoteCacheKv`, `systemClock`, `createServiceClient`), P4 (`quote_cache` rows `quote:<symbol>`, `lib/format.ts`).
- Produces: `expectedStatementDate`, `statementFreshness`, `dailySyncDue`, `t1Disclosure`, `AUTO_REFRESH_MS`, `MANUAL_COOLDOWN_S`; `buildPortfolioView`, `neededFxPairs`, `selectLatestSnapshot`, `PortfolioResponse`; the `portfolio-refresh` HTTP contract (GET auto, POST `{ manual: true }`); `usePortfolio`, `useManualRefresh`, `RefreshBar`, `PullToRefresh`, `MoneyText`, `ProvenanceBadge`, `CooldownError`.

### HTTP contract of `portfolio-refresh`

| Request | Behaviour |
|---|---|
| `GET` (auto refresh) | JWT required; re-values the latest statement snapshot with delayed Yahoo quotes (P4 cache keys `quote:<symbol>`, TTL 5 min); never calls Flex; enqueues a `daily` run when a new statement day is due; does **not** touch the cooldown |
| `POST {"manual": true}` | same, after one atomic `app.claim_manual_refresh`; refused with **429**, header `Retry-After: <s>` and body `{ error: "cooldown", retryAfterSeconds }` when the last manual refresh is younger than 60 s |
| `409 {error: "not_linked"}` | no linked connection |
| 200 body | `PortfolioResponse`: `serverTime`, `nextAutoRefreshAt`, `manualAvailableAt`, `lastSuccessfulAt`, `baseCurrency`, `reportDate`, `lastStatementDate`, `statement { expectedDate, freshness }`, `syncQueued`, `quoteError`, `view` (positions with `independent` unrealized P&L, `fxSource`/`fxDate`, `quoteTime`, totals, per-currency breakdown) |

- [ ] **Step 1: Statement-day helpers, tests first**

`supabase/functions/_shared/core/statement-day.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  AUTO_REFRESH_MS,
  MANUAL_COOLDOWN_S,
  dailySyncDue,
  expectedStatementDate,
  statementFreshness,
  t1Disclosure,
} from "./statement-day.ts";

// 2026-10-15 is a Thursday; Sofia is UTC+3 until 2026-10-25 and UTC+2 after
const utc = (m: number, d: number, h: number, min = 0) => Date.UTC(2026, m - 1, d, h, min);

describe("expectedStatementDate: the previous weekday in Europe/Sofia, counted from 08:00 local", () => {
  const table: Array<[string, number, string]> = [
    ["Thursday 10:00 Sofia", utc(10, 15, 7), "2026-10-14"],
    ["Thursday 07:59 Sofia (before the daily run) counts as Wednesday", utc(10, 15, 4, 59), "2026-10-13"],
    ["Thursday 08:00 Sofia", utc(10, 15, 5), "2026-10-14"],
    ["Monday 10:00 Sofia skips the weekend", utc(10, 19, 7), "2026-10-16"],
    ["Monday 07:00 Sofia", utc(10, 19, 4), "2026-10-16"],
    ["Saturday noon", utc(10, 17, 9), "2026-10-16"],
    ["Sunday noon", utc(10, 18, 9), "2026-10-16"],
    ["DST change day 2026-10-25, 05:00 UTC is 07:00 Sofia", utc(10, 25, 5), "2026-10-23"],
    ["DST change day 2026-10-25, 06:00 UTC is 08:00 Sofia", utc(10, 25, 6), "2026-10-23"],
    ["winter Tuesday 2026-12-15 10:00 Sofia", utc(12, 15, 8), "2026-12-14"],
  ];
  for (const [name, ms, expected] of table) it(name, () => expect(expectedStatementDate(ms)).toBe(expected));
});

describe("statementFreshness", () => {
  it("is current when the statement reaches the expected date, behind (with days) otherwise, unknown without a statement", () => {
    expect(statementFreshness("2026-10-14", "2026-10-14")).toEqual({ kind: "current" });
    expect(statementFreshness("2026-10-15", "2026-10-14")).toEqual({ kind: "current" });
    expect(statementFreshness("2026-10-13", "2026-10-14")).toEqual({ kind: "behind", days: 1 });
    expect(statementFreshness("2026-10-09", "2026-10-14")).toEqual({ kind: "behind", days: 5 });
    expect(statementFreshness(null, "2026-10-14")).toEqual({ kind: "unknown" });
  });
});

describe("dailySyncDue (spec 12.8): a new statement day is expected and Flex is not being hammered", () => {
  const base = { lastStatementDate: "2026-10-13", expected: "2026-10-14", nextFetchNotBeforeMs: null, nowMs: 1_000, hasActiveRun: false };
  it("is due when the last statement is older than expected", () => {
    expect(dailySyncDue(base)).toBe(true);
    expect(dailySyncDue({ ...base, lastStatementDate: null })).toBe(true);
  });
  it("is not due when the statement is current, a run is active, or the 6 hour holiday back-off is running", () => {
    expect(dailySyncDue({ ...base, lastStatementDate: "2026-10-14" })).toBe(false);
    expect(dailySyncDue({ ...base, hasActiveRun: true })).toBe(false);
    expect(dailySyncDue({ ...base, nextFetchNotBeforeMs: 2_000 })).toBe(false);
    expect(dailySyncDue({ ...base, nextFetchNotBeforeMs: 1_000 })).toBe(true);
  });
});

describe("constants and disclosure text", () => {
  it("auto refresh is 5 minutes and the manual cooldown is 60 seconds", () => {
    expect(AUTO_REFRESH_MS).toBe(300_000);
    expect(MANUAL_COOLDOWN_S).toBe(60);
  });
  it("the T+1 disclosure is the exact spec text", () => {
    expect(t1Disclosure("2026-10-14")).toBe(
      "Positions, trades and cost basis come from your IBKR Activity Flex statement as of 2026-10-14 (end of day). Trades made today appear after IBKR builds tomorrow's statement. Prices shown are delayed Yahoo quotes.",
    );
    expect(t1Disclosure(null)).toContain("as of an unknown date");
  });
});
```

Run: `bun run test:core statement-day`
Expected: FAIL (module not found).

`supabase/functions/_shared/core/statement-day.ts`:

```ts
// When a Flex statement is expected, how stale it is, and the disclosure text (spec 12.6, 12.8). Pure.
import { SOFIA, dayNumber, isoDate, isoWeekdayOf, localParts } from "./calendar.ts";

export const AUTO_REFRESH_MS = 5 * 60_000;
export const MANUAL_COOLDOWN_S = 60;
/** The daily Flex sync starts at 08:00 Europe/Sofia (A-33): before that hour the previous day's statement is not expected yet. */
export const STATEMENT_HOUR_LOCAL = 8;

/** The previous weekday (Sofia calendar) counted from 08:00 local; weekends are skipped, exchange holidays are not modelled. */
export function expectedStatementDate(nowMs: number): string {
  const p = localParts(nowMs, SOFIA);
  let reference = dayNumber(p.year, p.month, p.day);
  if (p.hour < STATEMENT_HOUR_LOCAL) reference -= 1;
  let day = reference - 1;
  while (isoWeekdayOf(day) >= 6) day -= 1;
  return isoDate(day);
}

export type StatementFreshness = { kind: "current" } | { kind: "behind"; days: number } | { kind: "unknown" };

export function statementFreshness(reportDate: string | null, expected: string): StatementFreshness {
  if (reportDate === null) return { kind: "unknown" };
  if (reportDate >= expected) return { kind: "current" };
  const num = (iso: string): number => dayNumber(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)), Number(iso.slice(8, 10)));
  return { kind: "behind", days: num(expected) - num(reportDate) };
}

export function dailySyncDue(i: {
  lastStatementDate: string | null;
  expected: string;
  nextFetchNotBeforeMs: number | null;
  nowMs: number;
  hasActiveRun: boolean;
}): boolean {
  if (i.hasActiveRun) return false;
  if (i.lastStatementDate !== null && i.lastStatementDate >= i.expected) return false;
  return i.nextFetchNotBeforeMs === null || i.nextFetchNotBeforeMs <= i.nowMs;
}

export function t1Disclosure(reportDate: string | null): string {
  return `Positions, trades and cost basis come from your IBKR Activity Flex statement as of ${reportDate ?? "an unknown date"} (end of day). Trades made today appear after IBKR builds tomorrow's statement. Prices shown are delayed Yahoo quotes.`;
}
```

Run: `bun run test:core statement-day`
Expected: PASS.

- [ ] **Step 2: Valuation core `portfolio-view.ts`, tests first**

`supabase/functions/_shared/core/portfolio-view.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { FxRate, Money } from "./accounting.ts";
import {
  type HeldPosition,
  type QuoteInfo,
  buildPortfolioView,
  neededFxPairs,
  selectLatestSnapshot,
} from "./portfolio-view.ts";

const NOW = Date.UTC(2026, 9, 15, 12, 0, 0);

const pos = (o: Partial<HeldPosition> = {}): HeldPosition => ({
  id: 1, conid: 100001, symbol: "AAPL", description: "APPLE INC", assetClass: "STK", currency: "USD", quantity: 10, multiplier: 1,
  costBasisMoney: 2001.7, costBasisPrice: 200.17, markPrice: 230, fifoPnlUnrealized: 298.3, fxRateToBase: 0.92, reportDate: "2026-10-14",
  valuationSymbol: "AAPL", valuationTag: null, valuationSessionDate: null, valuationReason: null, matchStatus: "matched_isin", ...o,
});

const quote = (o: Partial<QuoteInfo> = {}): QuoteInfo => ({
  symbol: "AAPL", price: 232, currency: "USD", changePercent: 1, regularMarketTime: NOW - 60_000, marketState: "REGULAR", fetchedAtMs: NOW - 30_000, ...o,
});

const yahoo = (rate: number): FxRate => ({ rate, rateDate: "2026-10-15", source: "yahoo" });
const input = (positions: HeldPosition[], quotes: QuoteInfo[], fx: Record<string, FxRate> = {}, base = "EUR") => ({
  nowMs: NOW, baseCurrency: base, reportDate: "2026-10-14", lastStatementDate: "2026-10-14", positions,
  quotes: new Map(quotes.map((q) => [q.symbol, q])), fx: new Map(Object.entries(fx)),
});

const v = (m: Money): number => {
  if (m.kind !== "ok") throw new Error(`unavailable: ${m.reason}`);
  return m.value;
};

describe("valuation with a delayed quote", () => {
  const view = buildPortfolioView(input([pos()], [quote()], { "USD>EUR": yahoo(0.93) }));
  const row = view.positions[0];

  it("values, independent unrealized P&L (value minus cost), average cost and estimated daily P&L", () => {
    expect(row?.price).toMatchObject({ value: 232, ccy: "USD", source: { kind: "delayed_quote", marketState: "REGULAR" } });
    expect(v(row?.marketValue as Money)).toBe(2320);
    expect(v(row?.unrealizedIndependent as Money)).toBeCloseTo(318.3, 10);
    expect(row?.averageCost).toBeCloseTo(200.17, 10);
    expect(v(row?.dailyPnl as Money)).toBeCloseTo(10 * (232 - 232 / 1.01), 8);
    expect(row?.unrealizedBroker).toBe(298.3);
    expect(row?.reconciles).toBe(true);
    expect(row?.quoteTime).toBe(new Date(NOW - 60_000).toISOString());
  });

  it("converts to the base currency with the current Yahoo rate and says so", () => {
    expect(row?.fxSource).toBe("yahoo");
    expect(row?.fxDate).toBe("2026-10-15");
    expect(v(row?.valueBase as Money)).toBeCloseTo(2320 * 0.93, 8);
    expect(v(row?.costBase as Money)).toBeCloseTo(2001.7 * 0.93, 8);
  });

  it("the summary uses one rate per position, so total value minus total cost equals total unrealized", () => {
    const t = view.totals;
    expect(v(t.valueBase) - v(t.costBase)).toBeCloseTo(v(t.unrealizedBase), 8);
    expect(t.excluded).toEqual([]);
    expect(view.quotesFetchedAt).toBe(new Date(NOW - 30_000).toISOString());
  });
});

describe("GBp positions are never valued as GBP (pence vs pounds)", () => {
  const shel = pos({ id: 2, conid: 100002, symbol: "SHEL", currency: "GBP", quantity: 100, costBasisMoney: 2500, costBasisPrice: 25, markPrice: 27.35, fifoPnlUnrealized: 235, fxRateToBase: 1.15, valuationSymbol: "SHEL.L" });

  it("a Yahoo price in GBp is divided by 100 before use", () => {
    const row = buildPortfolioView(input([shel], [quote({ symbol: "SHEL.L", price: 2735, currency: "GBp", changePercent: null })], { "GBP>EUR": yahoo(1.16) })).positions[0];
    expect(row?.price.value).toBeCloseTo(27.35, 10);
    expect(row?.price.ccy).toBe("GBP");
    expect(row?.price.note).toMatch(/GBp/);
    expect(v(row?.marketValue as Money)).toBeCloseTo(2735, 8);
    expect(v(row?.unrealizedIndependent as Money)).toBeCloseTo(235, 8);
  });

  it("a price that is 100 times the statement close is rejected and the statement close is used with the reason", () => {
    const row = buildPortfolioView(input([shel], [quote({ symbol: "SHEL.L", price: 2735, currency: "GBP" })])).positions[0];
    expect(row?.price.source).toMatchObject({ kind: "statement_close", reportDate: "2026-10-14" });
    expect((row?.price.source as { reason: string }).reason).toMatch(/unit/i);
    expect(v(row?.marketValue as Money)).toBeCloseTo(2735, 8);
  });

  it("a quote in another currency than the position is converted, or rejected without a rate", () => {
    const eur = quote({ symbol: "AAPL", price: 200, currency: "EUR" });
    const withFx = buildPortfolioView(input([pos()], [eur], { "EUR>USD": yahoo(1.1), "USD>EUR": yahoo(0.91) })).positions[0];
    expect(withFx?.price.value).toBeCloseTo(220, 8);
    expect(withFx?.price.note).toMatch(/EUR/);
    const without = buildPortfolioView(input([pos()], [eur], { "USD>EUR": yahoo(0.91) })).positions[0];
    expect(without?.price.source.kind).toBe("statement_close");
  });
});

describe("no delayed quote", () => {
  it("falls back to the statement close, labelled, and has no daily P&L", () => {
    const row = buildPortfolioView(input([pos()], [], { "USD>EUR": yahoo(0.93) })).positions[0];
    expect(row?.price.source).toMatchObject({ kind: "statement_close", reportDate: "2026-10-14", reason: "no delayed quote" });
    expect(v(row?.marketValue as Money)).toBe(2300);
    expect(row?.dailyPnl.kind).toBe("unavailable");
    expect(row?.quoteTime).toBeNull();
  });

  it("no quote and no statement mark price is unavailable, never zero", () => {
    const row = buildPortfolioView(input([pos({ markPrice: null })], [])).positions[0];
    expect(row?.price.value).toBeNull();
    expect(row?.marketValue.kind).toBe("unavailable");
    expect(row?.unrealizedIndependent.kind).toBe("unavailable");
  });
});

describe("currency conversion fallbacks", () => {
  it("without a Yahoo rate the Flex rate of the report date is used and labelled flex", () => {
    const row = buildPortfolioView(input([pos()], [quote()])).positions[0];
    expect([row?.fxSource, row?.fxDate]).toEqual(["flex", "2026-10-14"]);
    expect(v(row?.valueBase as Money)).toBeCloseTo(2320 * 0.92, 8);
  });

  it("a position in the base currency needs no rate", () => {
    const row = buildPortfolioView(input([pos({ currency: "EUR", fxRateToBase: null })], [quote({ currency: "EUR" })])).positions[0];
    expect(row?.fxSource).toBe("base");
    expect(v(row?.valueBase as Money)).toBe(2320);
  });

  it("without any rate the base figures are unavailable, the position is excluded from the totals with a reason, and the native breakdown keeps it", () => {
    const view = buildPortfolioView(input([pos({ fxRateToBase: null })], [quote()]));
    expect(view.positions[0]?.valueBase.kind).toBe("unavailable");
    expect(view.positions[0]?.fxSource).toBe("unavailable");
    expect(view.totals.valueBase.kind).toBe("unavailable");
    expect(view.totals.excluded).toEqual([{ symbol: "AAPL", reason: "Missing FX rate USD->EUR" }]);
    expect(v(view.perCurrency[0]?.value as Money)).toBe(2320);
    expect(view.perCurrency[0]?.ccy).toBe("USD");
  });
});

describe("totals", () => {
  const shel = pos({ id: 2, conid: 100002, symbol: "SHEL", currency: "GBP", quantity: 100, costBasisMoney: 2500, markPrice: 27.35, fifoPnlUnrealized: 235, fxRateToBase: 1.15, valuationSymbol: "SHEL.L" });
  const quotes = [quote(), quote({ symbol: "SHEL.L", price: 2735, currency: "GBp" })];
  const fx = { "USD>EUR": yahoo(0.93), "GBP>EUR": yahoo(1.16) };

  it("sums mixed currencies only after conversion and breaks them down per currency", () => {
    const view = buildPortfolioView(input([pos(), shel], quotes, fx));
    expect(v(view.totals.valueBase)).toBeCloseTo(2320 * 0.93 + 2735 * 1.16, 6);
    expect(v(view.totals.costBase)).toBeCloseTo(2001.7 * 0.93 + 2500 * 1.16, 6);
    expect(view.perCurrency.map((c) => c.ccy)).toEqual(["GBP", "USD"]);
    expect(v(view.perCurrency[1]?.value as Money)).toBe(2320);
  });

  it("a position without cost basis is excluded from the totals with the reason", () => {
    const view = buildPortfolioView(input([pos(), pos({ id: 3, symbol: "ZZZ", costBasisMoney: null, valuationSymbol: null })], quotes, fx));
    expect(view.totals.excluded.map((e) => e.symbol)).toEqual(["ZZZ"]);
    expect(v(view.totals.valueBase)).toBeCloseTo(2320 * 0.93, 8);
  });

  it("daily P&L excludes positions without a delayed quote and counts them", () => {
    const view = buildPortfolioView(input([pos(), shel], [quote()], fx));
    expect(view.totals.dailyExcluded).toBe(1);
    expect(v(view.totals.dailyBase)).toBeCloseTo(10 * (232 - 232 / 1.01) * 0.93, 6);
  });

  it("an empty portfolio is a real zero in the base currency", () => {
    const view = buildPortfolioView(input([], []));
    expect(view.totals.valueBase).toEqual({ kind: "ok", value: 0, ccy: "EUR" });
    expect(view.totals.included).toBe(0);
  });
});

describe("statement reconciliation marker and tags", () => {
  it("flags a Flex unrealized value that does not reconcile with the statement mark price; null when not comparable", () => {
    expect(buildPortfolioView(input([pos({ fifoPnlUnrealized: 100 })], [quote()])).positions[0]?.reconciles).toBe(false);
    expect(buildPortfolioView(input([pos({ fifoPnlUnrealized: null })], [quote()])).positions[0]?.reconciles).toBeNull();
  });

  it("tags: not evaluated is Unavailable with a reason, scan tags keep their basis, none stays none", () => {
    const rows = buildPortfolioView(
      input(
        [
          pos({ id: 1 }),
          pos({ id: 2, symbol: "B", valuationTag: "discounted", valuationReason: "based on close of 2026-10-14", valuationSessionDate: "2026-10-14" }),
          pos({ id: 3, symbol: "C", valuationTag: "none", valuationReason: "based on close of 2026-10-14" }),
          pos({ id: 4, symbol: "D", valuationTag: "unavailable", valuationReason: "no Yahoo match" }),
        ],
        [quote()],
      ),
    ).positions;
    expect(rows.map((r) => r.tag)).toEqual(["unavailable", "discounted", "none", "unavailable"]);
    expect(rows[0]?.tagBasis).toBe("not evaluated yet");
    expect(rows[1]?.tagBasis).toBe("based on close of 2026-10-14");
    expect(rows[3]?.tagBasis).toBe("no Yahoo match");
  });
});

describe("snapshot selection and FX pairs", () => {
  it("only the newest report date is used (an older snapshot is never presented as current)", () => {
    const rows = [pos({ id: 1, reportDate: "2026-10-13" }), pos({ id: 2, reportDate: "2026-10-14" }), pos({ id: 3, reportDate: "2026-10-14" })];
    expect(selectLatestSnapshot(rows).map((r) => r.id)).toEqual([2, 3]);
    expect(selectLatestSnapshot([])).toEqual([]);
  });

  it("neededFxPairs lists position->base and quote->position pairs once", () => {
    const shel = pos({ id: 2, symbol: "SHEL", currency: "GBP", valuationSymbol: "SHEL.L" });
    const pairs = neededFxPairs([pos(), pos({ id: 5 }), shel], new Map([["SHEL.L", quote({ symbol: "SHEL.L", currency: "GBp" })], ["AAPL", quote({ currency: "EUR" })]]), "EUR");
    expect(pairs).toEqual([{ from: "USD", to: "EUR" }, { from: "EUR", to: "USD" }, { from: "GBP", to: "EUR" }]);
  });
});
```

Run: `bun run test:core portfolio-view`
Expected: FAIL (module not found).

`supabase/functions/_shared/core/portfolio-view.ts`:

```ts
// Valuation of the latest Flex snapshot with delayed quotes (spec 12.8). Pure: quotes and FX arrive as data.
import {
  type FxRate, type Money, type Position, averageCostPerUnit, canReconcile, convertMoney, dailyPnlEstimate, ok, reconcileUnrealized, sumInBasePartial,
  unavailable, unrealizedPnl,
} from "./accounting.ts";
import type { StatementFreshness } from "./statement-day.ts";
import { resolveCurrency } from "./units.ts";

export type { FxRate, Money } from "./accounting.ts";

export type ValuationTag = "discounted" | "premium" | "extra_premium" | "unavailable" | "none";

/** One row of the latest broker_positions snapshot joined with its valuation symbol. */
export interface HeldPosition {
  id: number;
  conid: number;
  symbol: string;
  description: string | null;
  assetClass: string | null;
  currency: string;
  quantity: number;
  multiplier: number;
  costBasisMoney: number | null;
  costBasisPrice: number | null;
  markPrice: number | null;
  fifoPnlUnrealized: number | null;
  fxRateToBase: number | null;
  reportDate: string;
  valuationSymbol: string | null;
  valuationTag: string | null;
  valuationSessionDate: string | null;
  valuationReason: string | null;
  matchStatus: string;
}

export interface QuoteInfo {
  symbol: string;
  price: number | null;
  /** as quoted by Yahoo: GBp, ZAc, ILA, KWF are minor units */
  currency: string;
  changePercent: number | null;
  regularMarketTime: number | null;
  marketState: string | null;
  fetchedAtMs: number;
}

export type PriceSource =
  | { kind: "delayed_quote"; asOfMs: number | null; marketState: string | null; fetchedAtMs: number }
  | { kind: "statement_close"; reportDate: string; reason: string }
  | { kind: "unavailable"; reason: string };

export interface PositionView {
  id: number;
  conid: number;
  ticker: string;
  name: string | null;
  assetClass: string | null;
  currency: string;
  quantity: number;
  multiplier: number;
  price: { value: number | null; ccy: string; source: PriceSource; note: string | null };
  quoteTime: string | null;
  costBasis: Money;
  marketValue: Money;
  averageCost: number | null;
  dailyPnl: Money;
  unrealizedIndependent: Money;
  unrealizedBroker: number | null;
  /** true: Flex FIFO value agrees with the statement mark; false: "does not reconcile"; null: not comparable */
  reconciles: boolean | null;
  valueBase: Money;
  costBase: Money;
  unrealizedBase: Money;
  dailyBase: Money;
  fxSource: "base" | "yahoo" | "flex" | "unavailable";
  fxDate: string | null;
  tag: ValuationTag;
  tagBasis: string | null;
  matchStatus: string;
}

export interface CurrencyBreakdown {
  ccy: string;
  count: number;
  excluded: number;
  cost: Money;
  value: Money;
  unrealized: Money;
  daily: Money;
}

export interface PortfolioTotals {
  costBase: Money;
  valueBase: Money;
  unrealizedBase: Money;
  dailyBase: Money;
  included: number;
  excluded: Array<{ symbol: string; reason: string }>;
  dailyExcluded: number;
}

export interface PortfolioView {
  baseCurrency: string;
  reportDate: string | null;
  positions: PositionView[];
  totals: PortfolioTotals;
  perCurrency: CurrencyBreakdown[];
  quotesFetchedAt: string | null;
}

/** The shape returned by the portfolio-refresh function and consumed by the SPA. */
export interface PortfolioResponse {
  serverTime: string;
  nextAutoRefreshAt: string;
  manualAvailableAt: string;
  lastSuccessfulAt: string | null;
  baseCurrency: string | null;
  reportDate: string | null;
  lastStatementDate: string | null;
  statement: { expectedDate: string; freshness: StatementFreshness };
  syncQueued: boolean;
  quoteError: string | null;
  view: PortfolioView;
}

export interface ViewInput {
  nowMs: number;
  baseCurrency: string;
  reportDate: string | null;
  lastStatementDate: string | null;
  positions: readonly HeldPosition[];
  quotes: ReadonlyMap<string, QuoteInfo>;
  /** current Yahoo rates, key `${from}>${to}` (value of 1 `from` in `to`) */
  fx: ReadonlyMap<string, FxRate>;
}

export const fxKey = (from: string, to: string): string => `${from}>${to}`;

/** Only the newest report date is a current snapshot; older rows are history and are never valued. */
export function selectLatestSnapshot<T extends { reportDate: string }>(rows: readonly T[]): T[] {
  let latest = "";
  for (const r of rows) if (r.reportDate > latest) latest = r.reportDate;
  return rows.filter((r) => r.reportDate === latest);
}

export function neededFxPairs(positions: readonly HeldPosition[], quotes: ReadonlyMap<string, QuoteInfo>, base: string): Array<{ from: string; to: string }> {
  const pairs = new Map<string, { from: string; to: string }>();
  const add = (from: string, to: string) => {
    if (from !== to) pairs.set(fxKey(from, to), { from, to });
  };
  for (const p of positions) {
    add(p.currency, base);
    const q = p.valuationSymbol === null ? undefined : quotes.get(p.valuationSymbol);
    if (q !== undefined) add(resolveCurrency(q.currency).major, p.currency);
  }
  return [...pairs.values()];
}

const UNIT_RATIO = { low: 80, high: 120 };

function quotePrice(p: HeldPosition, q: QuoteInfo | undefined, fx: ReadonlyMap<string, FxRate>): { price: number; note: string | null } | { reason: string } {
  if (q === undefined || q.price === null || !Number.isFinite(q.price) || q.price <= 0) return { reason: "no delayed quote" };
  const unit = resolveCurrency(q.currency);
  let price = q.price / unit.divisor;
  let note: string | null = unit.divisor === 1 ? null : `quoted in ${q.currency}, converted to ${unit.major}`;
  if (unit.major !== p.currency) {
    const converted = convertMoney(price, unit.major, p.currency, fx.get(fxKey(unit.major, p.currency)) ?? null);
    if (converted.kind === "unavailable") return { reason: converted.reason };
    price = converted.value;
    note = `quote converted from ${unit.major} to ${p.currency}`;
  }
  if (p.markPrice !== null && p.markPrice > 0) {
    const ratio = price / p.markPrice;
    if ((ratio > UNIT_RATIO.low && ratio < UNIT_RATIO.high) || (ratio > 1 / UNIT_RATIO.high && ratio < 1 / UNIT_RATIO.low)) {
      return { reason: "price unit mismatch (pence versus pounds), delayed quote rejected" };
    }
  }
  return { price, note };
}

function baseRate(p: HeldPosition, base: string, fx: ReadonlyMap<string, FxRate>): { rate: FxRate | null; source: PositionView["fxSource"]; date: string | null } {
  if (p.currency === base) return { rate: { rate: 1, rateDate: p.reportDate, source: "flex" }, source: "base", date: null };
  const live = fx.get(fxKey(p.currency, base));
  if (live !== undefined) return { rate: live, source: "yahoo", date: live.rateDate };
  if (p.fxRateToBase !== null) return { rate: { rate: p.fxRateToBase, rateDate: p.reportDate, source: "flex" }, source: "flex", date: p.reportDate };
  return { rate: null, source: "unavailable", date: null };
}

const TAGS: readonly ValuationTag[] = ["discounted", "premium", "extra_premium", "unavailable", "none"];

export function buildPortfolioView(input: ViewInput): PortfolioView {
  const base = input.baseCurrency;
  const rows: PositionView[] = input.positions.map((p) => {
    const q = p.valuationSymbol === null ? undefined : input.quotes.get(p.valuationSymbol);
    const qp = quotePrice(p, q, input.fx);
    let priceValue: number | null = null;
    let source: PriceSource;
    let note: string | null = null;
    if ("price" in qp && q !== undefined) {
      priceValue = qp.price;
      note = qp.note;
      source = { kind: "delayed_quote", asOfMs: q.regularMarketTime, marketState: q.marketState, fetchedAtMs: q.fetchedAtMs };
    } else if (p.markPrice !== null) {
      priceValue = p.markPrice;
      source = { kind: "statement_close", reportDate: p.reportDate, reason: "reason" in qp ? qp.reason : "no delayed quote" };
    } else {
      source = { kind: "unavailable", reason: "reason" in qp ? qp.reason : "no delayed quote" };
    }

    const acc: Position | null =
      p.costBasisMoney === null
        ? null
        : { conid: p.conid, ccy: p.currency, qty: p.quantity, multiplier: p.multiplier, costBasisMoney: p.costBasisMoney, markPrice: p.markPrice, fifoUnrealized: p.fifoPnlUnrealized, fxToBase: p.fxRateToBase };
    const priceReason = source.kind === "unavailable" ? source.reason : "price unavailable";
    const costBasis: Money = p.costBasisMoney === null ? unavailable("Cost basis missing in the statement") : ok(p.costBasisMoney, p.currency);
    const marketValue: Money = priceValue === null ? unavailable(priceReason) : ok(p.quantity * p.multiplier * priceValue, p.currency);
    const unrealized: Money = acc === null ? unavailable("Cost basis missing in the statement") : priceValue === null ? unavailable(priceReason) : ok(unrealizedPnl(acc, priceValue), p.currency);

    let daily: Money = unavailable("Daily change needs a delayed quote");
    if (source.kind === "delayed_quote" && priceValue !== null && acc !== null) {
      const pct = q?.changePercent ?? null;
      daily = pct === null || pct <= -100 ? unavailable("Daily change unavailable") : dailyPnlEstimate(acc, priceValue, priceValue / (1 + pct / 100));
    }

    const rate = baseRate(p, base, input.fx);
    const toBase = (m: Money): Money => (m.kind === "ok" ? convertMoney(m.value, m.ccy, base, rate.rate) : m);

    const tag: ValuationTag = p.valuationTag !== null && (TAGS as readonly string[]).includes(p.valuationTag) ? (p.valuationTag as ValuationTag) : "unavailable";
    return {
      id: p.id,
      conid: p.conid,
      ticker: p.symbol,
      name: p.description,
      assetClass: p.assetClass,
      currency: p.currency,
      quantity: p.quantity,
      multiplier: p.multiplier,
      price: { value: priceValue, ccy: p.currency, source, note },
      quoteTime: source.kind === "delayed_quote" && source.asOfMs !== null ? new Date(source.asOfMs).toISOString() : null,
      costBasis,
      marketValue,
      averageCost: acc === null ? null : averageCostPerUnit(acc),
      dailyPnl: daily,
      unrealizedIndependent: unrealized,
      unrealizedBroker: p.fifoPnlUnrealized,
      reconciles: acc === null || !canReconcile(acc) ? null : reconcileUnrealized(acc).withinTolerance,
      valueBase: toBase(marketValue),
      costBase: toBase(costBasis),
      unrealizedBase: toBase(unrealized),
      dailyBase: toBase(daily),
      fxSource: rate.source,
      fxDate: rate.date,
      tag,
      tagBasis: p.valuationTag === null ? "not evaluated yet" : p.valuationReason,
      matchStatus: p.matchStatus,
    };
  });

  // base totals: only positions whose cost AND value convert, so that value - cost = unrealized holds exactly
  const excluded: Array<{ symbol: string; reason: string }> = [];
  const usable = rows.filter((r) => {
    const bad = [r.costBase, r.valueBase].find((m): m is Extract<Money, { kind: "unavailable" }> => m.kind === "unavailable");
    if (bad === undefined) return true;
    excluded.push({ symbol: r.ticker, reason: bad.reason });
    return false;
  });
  // when positions exist but none converts, the totals are unavailable (never a silent zero)
  const nothingUsable = rows.length > 0 && usable.length === 0;
  const noTotal = { total: unavailable(excluded[0]?.reason ?? "No position could be valued"), excluded: 0, reasons: [] as string[] };
  const sum = (pick: (r: PositionView) => Money) => (nothingUsable ? noTotal : sumInBasePartial(usable.map(pick), base));
  const daily = sum((r) => r.dailyBase);

  const byCcy = new Map<string, PositionView[]>();
  for (const r of rows) byCcy.set(r.currency, [...(byCcy.get(r.currency) ?? []), r]);
  const perCurrency: CurrencyBreakdown[] = [...byCcy.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([ccy, list]) => {
      const complete = list.filter((r) => r.costBasis.kind === "ok" && r.marketValue.kind === "ok");
      const native = (pick: (r: PositionView) => Money) => sumInBasePartial(complete.map(pick), ccy).total;
      return {
        ccy,
        count: complete.length,
        excluded: list.length - complete.length,
        cost: native((r) => r.costBasis),
        value: native((r) => r.marketValue),
        unrealized: native((r) => r.unrealizedIndependent),
        daily: native((r) => r.dailyPnl),
      };
    });

  const fetched = [...input.quotes.values()].map((q) => q.fetchedAtMs);
  return {
    baseCurrency: base,
    reportDate: input.reportDate,
    positions: rows,
    totals: {
      costBase: sum((r) => r.costBase).total,
      valueBase: sum((r) => r.valueBase).total,
      unrealizedBase: sum((r) => r.unrealizedBase).total,
      dailyBase: daily.total,
      included: usable.length,
      excluded,
      dailyExcluded: daily.excluded,
    },
    perCurrency,
    quotesFetchedAt: fetched.length === 0 ? null : new Date(Math.max(...fetched)).toISOString(),
  };
}
```

Run: `bun run test:core portfolio-view`
Expected: PASS. If the daily total test fails by a rounding detail, compare with `toBeCloseTo(..., 6)` first; the formula is `qty * (price - price / (1 + pct / 100))` per position.

- [ ] **Step 3: Quote source for the function (`quotes.test.ts`, `quotes.ts`)**

`supabase/functions/portfolio-refresh/quotes.test.ts`:

```ts
import { assertEquals } from "@std/assert";
import { type QuoteKv, createCachedQuoteSource } from "./quotes.ts";

const NOW = Date.UTC(2026, 9, 15, 12, 0, 0);

function kv(initial: Record<string, { payload: unknown; fetchedAt: number; expiresAt: number }> = {}) {
  const rows = new Map(Object.entries(initial));
  const puts: Array<{ key: string; expiresAt: number }> = [];
  const store: QuoteKv = {
    get: (keys) => Promise.resolve(new Map(keys.filter((k) => rows.has(k)).map((k) => [k, rows.get(k) as never]))),
    put: (entries) => {
      for (const e of entries) {
        rows.set(e.key, { payload: e.payload, fetchedAt: e.fetchedAt, expiresAt: e.expiresAt });
        puts.push({ key: e.key, expiresAt: e.expiresAt });
      }
      return Promise.resolve();
    },
  };
  return { store, rows, puts };
}

const rec = (symbol: string, price: number, currency = "USD") => ({
  symbol, currency, exchange: "NMS", fullExchangeName: null, longName: null, regularMarketPrice: price, regularMarketTime: NOW - 120_000,
  regularMarketChangePercent: 0.5, marketState: "REGULAR",
});

Deno.test("fresh cache entries are used without calling the provider", async () => {
  const k = kv({ "quote:AAPL": { payload: { ...rec("AAPL", 230), fetchedAt: new Date(NOW - 60_000).toISOString(), stale: false }, fetchedAt: NOW - 60_000, expiresAt: NOW + 240_000 } });
  let calls = 0;
  const src = createCachedQuoteSource({ kv: k.store, market: { quote: () => (calls++, Promise.resolve([])) }, nowMs: () => NOW });
  const out = await src.quotes(["AAPL"]);
  assertEquals(calls, 0);
  assertEquals(out.error, null);
  assertEquals(out.map.get("AAPL")?.price, 230);
  assertEquals(out.map.get("AAPL")?.fetchedAtMs, NOW - 60_000);
});

Deno.test("misses and expired entries are fetched in one batch and cached for five minutes under quote:<symbol>", async () => {
  const k = kv({ "quote:OLD": { payload: { ...rec("OLD", 1), fetchedAt: "x", stale: false }, fetchedAt: NOW - 900_000, expiresAt: NOW - 600_000 } });
  const asked: string[][] = [];
  const src = createCachedQuoteSource({
    kv: k.store,
    market: { quote: (symbols) => (asked.push(symbols), Promise.resolve([rec("AAPL", 232), rec("OLD", 2), rec("SHEL.L", 2735, "GBp")])) },
    nowMs: () => NOW,
  });
  const out = await src.quotes(["AAPL", "OLD", "SHEL.L"]);
  assertEquals(asked, [["AAPL", "OLD", "SHEL.L"]]);
  assertEquals(out.map.get("SHEL.L")?.currency, "GBp");
  assertEquals(out.map.get("SHEL.L")?.price, 2735);
  assertEquals(k.puts.map((p) => [p.key, p.expiresAt - NOW]), [["quote:AAPL", 300_000], ["quote:OLD", 300_000], ["quote:SHEL.L", 300_000]]);
});

Deno.test("a provider failure falls back to the stale cache and reports the error; unknown symbols are simply missing", async () => {
  const k = kv({ "quote:AAPL": { payload: { ...rec("AAPL", 229), fetchedAt: "x", stale: false }, fetchedAt: NOW - 3_600_000, expiresAt: NOW - 3_300_000 } });
  const src = createCachedQuoteSource({ kv: k.store, market: { quote: () => Promise.reject(new Error("429")) }, nowMs: () => NOW });
  const out = await src.quotes(["AAPL", "NOPE"]);
  assertEquals(out.map.get("AAPL")?.price, 229);
  assertEquals(out.map.has("NOPE"), false);
  assertEquals(out.error, "quote_provider_unavailable");

  const empty = createCachedQuoteSource({ kv: kv().store, market: { quote: () => Promise.resolve([rec("AAPL", 232)]) }, nowMs: () => NOW });
  assertEquals((await empty.quotes(["AAPL", "NOPE"])).map.has("NOPE"), false);
  assertEquals((await empty.quotes([])).map.size, 0);
});

Deno.test("fx rates are Yahoo pair quotes (USDEUR=X) turned into rates dated by the quote time", async () => {
  const asked: string[][] = [];
  const src = createCachedQuoteSource({
    kv: kv().store,
    market: { quote: (symbols) => (asked.push(symbols), Promise.resolve([rec("USDEUR=X", 0.93, "EUR"), rec("GBPEUR=X", 1.16, "EUR")])) },
    nowMs: () => NOW,
  });
  const out = await src.fx([{ from: "USD", to: "EUR" }, { from: "GBP", to: "EUR" }, { from: "XXX", to: "EUR" }]);
  assertEquals(asked, [["USDEUR=X", "GBPEUR=X", "XXXEUR=X"]]);
  assertEquals(out.map.get("USD>EUR"), { rate: 0.93, rateDate: "2026-10-15", source: "yahoo" });
  assertEquals(out.map.get("GBP>EUR")?.rate, 1.16);
  assertEquals(out.map.has("XXX>EUR"), false);
});
```

`supabase/functions/portfolio-refresh/quotes.ts`:

```ts
// Delayed quotes for the held symbols through the P4 quote cache (`quote:<symbol>`, TTL 5 minutes). No Flex, no ad-hoc Yahoo calls
// for symbols that are fresh in the cache; a provider failure falls back to the stale cache and is reported, never hidden.
import type { FxRate, QuoteInfo } from "@core/portfolio-view.ts";

export const QUOTE_TTL_MS = 300_000;

export interface CachedRow {
  payload: unknown;
  fetchedAt: number;
  expiresAt: number;
}

export interface QuoteKv {
  get(keys: string[]): Promise<Map<string, CachedRow>>;
  put(entries: Array<{ key: string; payload: unknown; fetchedAt: number; expiresAt: number }>): Promise<void>;
}

export interface MarketQuote {
  symbol: string;
  currency: string;
  exchange?: string | null;
  fullExchangeName?: string | null;
  longName?: string | null;
  regularMarketPrice: number | null;
  regularMarketTime: number | null;
  regularMarketChangePercent: number | null;
  marketState: string | null;
}

export interface QuoteSource {
  quotes(symbols: readonly string[]): Promise<{ map: Map<string, QuoteInfo>; error: string | null }>;
  fx(pairs: ReadonlyArray<{ from: string; to: string }>): Promise<{ map: Map<string, FxRate>; error: string | null }>;
}

interface Payload {
  symbol: string;
  currency: string;
  regularMarketPrice: number | null;
  regularMarketTime: number | null;
  regularMarketChangePercent: number | null;
  marketState: string | null;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

function toInfo(symbol: string, row: CachedRow): QuoteInfo | null {
  const p = row.payload as Partial<Payload> | null;
  if (p === null || typeof p !== "object" || typeof p.currency !== "string") return null;
  return {
    symbol,
    price: num(p.regularMarketPrice),
    currency: p.currency,
    changePercent: num(p.regularMarketChangePercent),
    regularMarketTime: num(p.regularMarketTime),
    marketState: typeof p.marketState === "string" ? p.marketState : null,
    fetchedAtMs: row.fetchedAt,
  };
}

export function createCachedQuoteSource(deps: { kv: QuoteKv; market: { quote(symbols: string[]): Promise<MarketQuote[]> }; nowMs: () => number }): QuoteSource {
  async function load(symbols: readonly string[]): Promise<{ map: Map<string, QuoteInfo>; error: string | null }> {
    const wanted = [...new Set(symbols)];
    const out = new Map<string, QuoteInfo>();
    if (wanted.length === 0) return { map: out, error: null };
    const now = deps.nowMs();
    const cached = await deps.kv.get(wanted.map((s) => `quote:${s}`));
    const missing: string[] = [];
    for (const s of wanted) {
      const row = cached.get(`quote:${s}`);
      const info = row === undefined ? null : toInfo(s, row);
      if (row !== undefined && info !== null && row.expiresAt > now) out.set(s, info);
      else missing.push(s);
    }
    if (missing.length === 0) return { map: out, error: null };
    try {
      const fetched = await deps.market.quote(missing);
      const entries = fetched.map((q) => ({
        key: `quote:${q.symbol}`,
        payload: { ...q, fetchedAt: new Date(now).toISOString(), stale: false },
        fetchedAt: now,
        expiresAt: now + QUOTE_TTL_MS,
      }));
      if (entries.length > 0) await deps.kv.put(entries);
      for (const q of fetched) {
        out.set(q.symbol, {
          symbol: q.symbol, price: q.regularMarketPrice, currency: q.currency, changePercent: q.regularMarketChangePercent,
          regularMarketTime: q.regularMarketTime, marketState: q.marketState, fetchedAtMs: now,
        });
      }
      return { map: out, error: null };
    } catch {
      for (const s of missing) {
        const row = cached.get(`quote:${s}`);
        const info = row === undefined ? null : toInfo(s, row);
        if (info !== null) out.set(s, info);
      }
      return { map: out, error: "quote_provider_unavailable" };
    }
  }

  return {
    quotes: load,
    async fx(pairs) {
      const symbols = pairs.map((p) => `${p.from}${p.to}=X`);
      const res = await load(symbols);
      const map = new Map<string, FxRate>();
      for (const p of pairs) {
        const q = res.map.get(`${p.from}${p.to}=X`);
        if (q === undefined || q.price === null || q.price <= 0) continue;
        map.set(`${p.from}>${p.to}`, { rate: q.price, rateDate: new Date(q.regularMarketTime ?? q.fetchedAtMs).toISOString().slice(0, 10), source: "yahoo" });
      }
      return { map, error: res.error };
    },
  };
}
```

Run: `deno test -A --config supabase/functions/deno.json supabase/functions/portfolio-refresh/quotes.test.ts`
Expected: PASS (4 tests). The payload shape written to `quote:<symbol>` is the P4 `QuoteDto` shape (`symbol, currency, exchange, fullExchangeName, longName, regularMarketPrice, regularMarketTime, regularMarketChangePercent, marketState, fetchedAt, stale`); if P4's `quotes/cache.ts` or `service.ts` differs in a field name, change `toInfo` and the payload spread in this one file.

- [ ] **Step 4: Handler tests (cooldown, parallel requests, no Flex call)**

`supabase/functions/portfolio-refresh/handler.test.ts`:

```ts
import { assert, assertEquals } from "@std/assert";
import type { FxRate, HeldPosition, QuoteInfo } from "@core/portfolio-view.ts";
import { type RefreshConnection, type RefreshDeps, type RefreshStore, handleRequest } from "./handler.ts";
import type { QuoteSource } from "./quotes.ts";

const NOW = Date.UTC(2026, 9, 15, 7, 0, 0); // Thursday 10:00 Sofia: expected statement 2026-10-14
const USER = "a0000000-0000-4000-8000-00000000000a";

const position: HeldPosition = {
  id: 1, conid: 100001, symbol: "AAPL", description: "APPLE INC", assetClass: "STK", currency: "USD", quantity: 10, multiplier: 1, costBasisMoney: 2001.7,
  costBasisPrice: 200.17, markPrice: 230, fifoPnlUnrealized: 298.3, fxRateToBase: 0.92, reportDate: "2026-10-14", valuationSymbol: "AAPL",
  valuationTag: null, valuationSessionDate: null, valuationReason: null, matchStatus: "matched_isin",
};

function rig(o: { conn?: Partial<RefreshConnection> | null; positions?: HeldPosition[]; quoteError?: boolean; activeRun?: boolean } = {}) {
  let lastManual: number | null = null;
  const state = { claims: 0, enqueued: [] as string[], flexCalls: 0, positionLoads: 0 };
  const conn: RefreshConnection | null =
    o.conn === null
      ? null
      : { status: "linked", base_currency: "EUR", last_statement_date: "2026-10-14", next_flex_fetch_not_before: null, last_manual_refresh_at: null, last_sync_at: null, coverage_from: null, ...o.conn };
  const store: RefreshStore = {
    getConnection: () => Promise.resolve(conn === null ? null : { ...conn, last_manual_refresh_at: lastManual === null ? null : new Date(lastManual).toISOString() }),
    // atomic by construction: the check and the write have no await between them, like the single SQL UPDATE ... WHERE
    claimManualRefresh: async () => {
      await Promise.resolve();
      state.claims += 1;
      if (lastManual === null || NOW - lastManual >= 60_000) {
        lastManual = NOW;
        return { claimed: true, availableAt: new Date(NOW + 60_000).toISOString() };
      }
      return { claimed: false, availableAt: new Date(lastManual + 60_000).toISOString() };
    },
    loadLatestPositions: () => (state.positionLoads++, Promise.resolve(o.positions ?? [position])),
    hasActiveRun: () => Promise.resolve(o.activeRun === true),
    enqueueDailySync: (_user, runDate) => (state.enqueued.push(runDate), Promise.resolve(true)),
  };
  const quotes: QuoteSource = {
    quotes: () => Promise.resolve({
      map: new Map<string, QuoteInfo>(o.quoteError === true ? [] : [["AAPL", { symbol: "AAPL", price: 232, currency: "USD", changePercent: 1, regularMarketTime: NOW - 60_000, marketState: "REGULAR", fetchedAtMs: NOW - 30_000 }]]),
      error: o.quoteError === true ? "quote_provider_unavailable" : null,
    }),
    fx: () => Promise.resolve({ map: new Map<string, FxRate>([["USD>EUR", { rate: 0.93, rateDate: "2026-10-15", source: "yahoo" }]]), error: null }),
  };
  const deps: RefreshDeps = {
    verifier: { verify: (t) => Promise.resolve(t === "aaa.bbb.ccc" ? { userId: USER } : null) },
    store,
    quotes,
    nowMs: () => NOW,
    allowedOrigins: ["https://site.test"],
    log: () => undefined,
  };
  return { deps, state };
}

const req = (method: string, body?: unknown, headers: Record<string, string> = { authorization: "Bearer aaa.bbb.ccc", origin: "https://site.test" }) =>
  new Request("https://x.test/functions/v1/portfolio-refresh", { method, headers: { "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

Deno.test("401 without a valid JWT, 405 for other methods, CORS preflight answered", async () => {
  const { deps } = rig();
  assertEquals((await handleRequest(req("GET", undefined, {}), deps)).status, 401);
  assertEquals((await handleRequest(req("GET", undefined, { authorization: "Bearer bad.bad.bad" }), deps)).status, 401);
  assertEquals((await handleRequest(req("DELETE"), deps)).status, 405);
  const pre = await handleRequest(new Request("https://x.test/", { method: "OPTIONS", headers: { origin: "https://site.test" } }), deps);
  assertEquals([pre.status, pre.headers.get("access-control-allow-origin")], [204, "https://site.test"]);
});

Deno.test("409 not_linked without a usable connection", async () => {
  for (const conn of [null, { status: "unlinked" as const }, { status: "linking" as const }]) {
    const { deps } = rig({ conn });
    const res = await handleRequest(req("GET"), deps);
    assertEquals([res.status, (await res.json()).error], [409, "not_linked"]);
  }
});

Deno.test("GET: values the latest snapshot, carries server times, never claims the cooldown, never calls Flex", async () => {
  const { deps, state } = rig();
  const res = await handleRequest(req("GET"), deps);
  const body = await res.json();
  assertEquals(res.status, 200);
  assertEquals(state.claims, 0);
  assertEquals(state.flexCalls, 0);
  assertEquals(body.serverTime, new Date(NOW).toISOString());
  assertEquals(body.nextAutoRefreshAt, new Date(NOW + 300_000).toISOString());
  assertEquals(body.manualAvailableAt, new Date(NOW).toISOString());
  assertEquals(body.baseCurrency, "EUR");
  assertEquals(body.reportDate, "2026-10-14");
  assertEquals(body.statement, { expectedDate: "2026-10-14", freshness: { kind: "current" } });
  assertEquals(body.lastSuccessfulAt, new Date(NOW - 30_000).toISOString());
  assertEquals(body.view.positions[0].price.value, 232);
  assertEquals(body.view.positions[0].fxSource, "yahoo");
  assertEquals(res.headers.get("cache-control"), "no-store");
  assert(!JSON.stringify(body).includes("flex_token"));
});

Deno.test("a statement that is behind enqueues the daily run once; an active run or the 6 hour back-off prevents it", async () => {
  const behind = rig({ conn: { last_statement_date: "2026-10-09" } });
  const body = await (await handleRequest(req("GET"), behind.deps)).json();
  assertEquals([body.syncQueued, behind.state.enqueued, body.statement.freshness], [true, ["2026-10-15"], { kind: "behind", days: 5 }]);

  const active = rig({ conn: { last_statement_date: "2026-10-09" }, activeRun: true });
  assertEquals((await (await handleRequest(req("GET"), active.deps)).json()).syncQueued, false);
  const backoff = rig({ conn: { last_statement_date: "2026-10-09", next_flex_fetch_not_before: new Date(NOW + 3_600_000).toISOString() } });
  assertEquals((await (await handleRequest(req("GET"), backoff.deps)).json()).syncQueued, false);
  assertEquals(backoff.state.enqueued, []);
});

Deno.test("POST manual: first call 200 with manualAvailableAt 60 s ahead, second call 429 with Retry-After", async () => {
  const { deps } = rig();
  const first = await handleRequest(req("POST", { manual: true }), deps);
  assertEquals(first.status, 200);
  assertEquals((await first.json()).manualAvailableAt, new Date(NOW + 60_000).toISOString());
  const second = await handleRequest(req("POST", { manual: true }), deps);
  assertEquals(second.status, 429);
  assertEquals(second.headers.get("retry-after"), "60");
  assertEquals(await second.json(), { error: "cooldown", retryAfterSeconds: 60 });
});

Deno.test("five parallel manual refreshes: exactly one passes, four get 429 (no check-then-act in the handler)", async () => {
  const { deps, state } = rig();
  const results = await Promise.all(Array.from({ length: 5 }, () => handleRequest(req("POST", { manual: true }), deps)));
  const statuses = results.map((r) => r.status).sort();
  assertEquals(statuses, [200, 429, 429, 429, 429]);
  assertEquals(state.claims, 5);
  assert(results.filter((r) => r.status === 429).every((r) => r.headers.get("retry-after") === "60"));
});

Deno.test("a POST without manual:true behaves like an auto refresh", async () => {
  const { deps, state } = rig();
  assertEquals((await handleRequest(req("POST", {}), deps)).status, 200);
  assertEquals(state.claims, 0);
});

Deno.test("a quote failure still answers 200: statement closes are used, the error is reported, nothing is zero", async () => {
  const { deps } = rig({ quoteError: true });
  const res = await handleRequest(req("GET"), deps);
  const body = await res.json();
  assertEquals(res.status, 200);
  assertEquals(body.quoteError, "quote_provider_unavailable");
  assertEquals(body.lastSuccessfulAt, null);
  assertEquals(body.view.positions[0].price.source.kind, "statement_close");
  assertEquals(body.view.positions[0].marketValue.value, 2300);
});

Deno.test("a store failure is a 500 without details", async () => {
  const { deps } = rig();
  deps.store.loadLatestPositions = () => Promise.reject(new Error("db password=secret"));
  const res = await handleRequest(req("GET"), deps);
  const text = await res.text();
  assertEquals(res.status, 500);
  assertEquals(JSON.parse(text), { error: "internal_error" });
  assert(!text.includes("secret"));
});

Deno.test("only the newest report date is valued even if the store returns older rows", async () => {
  const { deps } = rig({ positions: [{ ...position, id: 7, reportDate: "2026-10-09" }, position] });
  const body = await (await handleRequest(req("GET"), deps)).json();
  assertEquals(body.view.positions.map((p: { id: number }) => p.id), [1]);
});
```

- [ ] **Step 5: Implement the handler, store and `index.ts`**

`supabase/functions/portfolio-refresh/handler.ts`:

```ts
import { corsHeaders, json, readJson } from "@adapters/http.ts";
import { type UserVerifier, authenticate } from "@adapters/user-auth.ts";
import { type HeldPosition, type PortfolioResponse, buildPortfolioView, neededFxPairs, selectLatestSnapshot } from "@core/portfolio-view.ts";
import { AUTO_REFRESH_MS, MANUAL_COOLDOWN_S, dailySyncDue, expectedStatementDate, statementFreshness } from "@core/statement-day.ts";
import { scanDateLocal } from "@core/calendar.ts";
import type { QuoteSource } from "./quotes.ts";

export interface RefreshConnection {
  status: string;
  base_currency: string | null;
  last_statement_date: string | null;
  next_flex_fetch_not_before: string | null;
  last_manual_refresh_at: string | null;
  last_sync_at: string | null;
  coverage_from: string | null;
}

export interface RefreshStore {
  getConnection(userId: string): Promise<RefreshConnection | null>;
  /** ONE atomic UPDATE ... WHERE (app.claim_manual_refresh); the handler never checks the cooldown itself */
  claimManualRefresh(userId: string): Promise<{ claimed: boolean; availableAt: string | null }>;
  loadLatestPositions(userId: string): Promise<HeldPosition[]>;
  hasActiveRun(userId: string): Promise<boolean>;
  /** true when a run was created (idempotency key `<user>:daily:<Sofia date>` shared with the cron) */
  enqueueDailySync(userId: string, runDate: string): Promise<boolean>;
}

export interface RefreshDeps {
  verifier: UserVerifier;
  store: RefreshStore;
  quotes: QuoteSource;
  nowMs(): number;
  allowedOrigins?: string[];
  log(event: string, data?: Record<string, unknown>): void;
}

const iso = (ms: number): string => new Date(ms).toISOString();

export async function handleRequest(req: Request, d: RefreshDeps): Promise<Response> {
  const cors = corsHeaders(req.headers.get("origin"), d.allowedOrigins);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "GET" && req.method !== "POST") {
    return json({ error: "method_not_allowed" }, { status: 405, headers: { ...cors, allow: "GET, POST, OPTIONS" } });
  }
  try {
    const auth = await authenticate(req, d.verifier, cors);
    if (!auth.ok) return auth.response;
    const userId = auth.userId;

    let manual = false;
    if (req.method === "POST") {
      const body = await readJson(req, 2_000);
      if (!body.ok) return body.response;
      manual = typeof body.value === "object" && body.value !== null && (body.value as Record<string, unknown>)["manual"] === true;
    }

    const conn = await d.store.getConnection(userId);
    if (conn === null || conn.status === "unlinked" || conn.status === "linking") return json({ error: "not_linked" }, { status: 409, headers: cors });

    const now = d.nowMs();
    let manualAvailableMs = conn.last_manual_refresh_at === null ? now : Math.max(now, Date.parse(conn.last_manual_refresh_at) + MANUAL_COOLDOWN_S * 1000);
    if (manual) {
      const claim = await d.store.claimManualRefresh(userId);
      if (!claim.claimed) {
        const retry = Math.max(1, Math.ceil(((claim.availableAt === null ? now + MANUAL_COOLDOWN_S * 1000 : Date.parse(claim.availableAt)) - now) / 1000));
        return json({ error: "cooldown", retryAfterSeconds: retry }, { status: 429, headers: { ...cors, "retry-after": String(retry) } });
      }
      manualAvailableMs = claim.availableAt === null ? now + MANUAL_COOLDOWN_S * 1000 : Date.parse(claim.availableAt);
    }

    // a new statement day is expected: queue the daily run (best effort, never fails the refresh)
    const expected = expectedStatementDate(now);
    let syncQueued = false;
    try {
      if (dailySyncDue({
        lastStatementDate: conn.last_statement_date, expected, nowMs: now, hasActiveRun: await d.store.hasActiveRun(userId),
        nextFetchNotBeforeMs: conn.next_flex_fetch_not_before === null ? null : Date.parse(conn.next_flex_fetch_not_before),
      })) {
        syncQueued = await d.store.enqueueDailySync(userId, scanDateLocal(now));
      }
    } catch (e) {
      d.log("daily_sync_enqueue_failed", { error: e instanceof Error ? e.name : "error" });
    }

    const positions = selectLatestSnapshot(await d.store.loadLatestPositions(userId));
    const base = conn.base_currency ?? "";
    const reportDate = positions[0]?.reportDate ?? conn.last_statement_date;
    const q = await d.quotes.quotes(positions.flatMap((p) => (p.valuationSymbol === null ? [] : [p.valuationSymbol])));
    const fx = await d.quotes.fx(neededFxPairs(positions, q.map, base));
    const view = buildPortfolioView({ nowMs: now, baseCurrency: base, reportDate, lastStatementDate: conn.last_statement_date, positions, quotes: q.map, fx: fx.map });

    const body: PortfolioResponse = {
      serverTime: iso(now),
      nextAutoRefreshAt: iso(now + AUTO_REFRESH_MS),
      manualAvailableAt: iso(manualAvailableMs),
      lastSuccessfulAt: view.quotesFetchedAt,
      baseCurrency: conn.base_currency,
      reportDate,
      lastStatementDate: conn.last_statement_date,
      statement: { expectedDate: expected, freshness: statementFreshness(conn.last_statement_date ?? reportDate, expected) },
      syncQueued,
      quoteError: q.error ?? fx.error,
      view,
    };
    return json(body, { headers: cors });
  } catch (e) {
    d.log("refresh_failed", { error: e instanceof Error ? e.name : "error" });
    return json({ error: "internal_error" }, { status: 500, headers: cors });
  }
}
```

`supabase/functions/portfolio-refresh/store.ts`:

```ts
import type { SupabaseClient } from "@supabase/supabase-js";
import type { HeldPosition } from "@core/portfolio-view.ts";
import type { RefreshConnection, RefreshStore } from "./handler.ts";
import type { CachedRow, QuoteKv } from "./quotes.ts";

export class RefreshStoreError extends Error {
  constructor(readonly op: string, readonly code: string | null) {
    super(`portfolio-refresh store: ${op}${code === null ? "" : ` (${code})`}`);
    this.name = "RefreshStoreError";
  }
}

const dayMinus = (iso: string, days: number): string => {
  const t = Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10))) - days * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
};

export function createRefreshStore(sb: SupabaseClient): RefreshStore {
  return {
    async getConnection(userId) {
      const { data, error } = await sb
        .from("broker_connections")
        .select("status,base_currency,last_statement_date,next_flex_fetch_not_before,last_manual_refresh_at,last_sync_at,coverage_from")
        .eq("user_id", userId)
        .maybeSingle();
      if (error) throw new RefreshStoreError("getConnection", error.code ?? null);
      return (data as RefreshConnection | null) ?? null;
    },
    async claimManualRefresh(userId) {
      const { data, error } = await sb.schema("app").rpc("claim_manual_refresh", { p_user: userId });
      if (error) throw new RefreshStoreError("claimManualRefresh", error.code ?? null);
      const row = ((data as Array<{ claimed: boolean; available_at: string | null }> | null) ?? [])[0];
      return { claimed: row?.claimed === true, availableAt: row?.available_at ?? null };
    },
    async loadLatestPositions(userId): Promise<HeldPosition[]> {
      const latest = await sb.from("broker_positions").select("report_date").eq("user_id", userId).order("report_date", { ascending: false }).limit(1);
      const date = ((latest.data as Array<{ report_date: string }> | null) ?? [])[0]?.report_date;
      if (date === undefined) return [];
      const { data, error } = await sb
        .from("broker_positions")
        .select("id,conid,symbol,description,asset_class,currency,quantity,multiplier,cost_basis_money,cost_basis_price,mark_price,fifo_pnl_unrealized,fx_rate_to_base,report_date,security_id,valuation_tag,valuation_session_date,valuation_reason,match_status")
        .eq("user_id", userId)
        .eq("report_date", date)
        .neq("quantity", 0);
      if (error) throw new RefreshStoreError("loadLatestPositions", error.code ?? null);
      const rows = (data as Array<Record<string, unknown>> | null) ?? [];
      const ids = [...new Set(rows.flatMap((r) => (typeof r["security_id"] === "string" ? [r["security_id"] as string] : [])))];
      const symbols = new Map<string, string>();
      if (ids.length > 0) {
        const secs = await sb.from("securities").select("id,yahoo_symbol").in("id", ids);
        for (const s of (secs.data as Array<{ id: string; yahoo_symbol: string }> | null) ?? []) symbols.set(s.id, s.yahoo_symbol);
      }
      const n = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
      return rows.map((r) => ({
        id: Number(r["id"]), conid: Number(r["conid"]), symbol: String(r["symbol"]), description: (r["description"] as string | null) ?? null,
        assetClass: (r["asset_class"] as string | null) ?? null, currency: String(r["currency"]), quantity: Number(r["quantity"]), multiplier: Number(r["multiplier"]),
        costBasisMoney: n(r["cost_basis_money"]), costBasisPrice: n(r["cost_basis_price"]), markPrice: n(r["mark_price"]), fifoPnlUnrealized: n(r["fifo_pnl_unrealized"]),
        fxRateToBase: n(r["fx_rate_to_base"]), reportDate: String(r["report_date"]),
        valuationSymbol: typeof r["security_id"] === "string" ? (symbols.get(r["security_id"] as string) ?? null) : null,
        valuationTag: (r["valuation_tag"] as string | null) ?? null, valuationSessionDate: (r["valuation_session_date"] as string | null) ?? null,
        valuationReason: (r["valuation_reason"] as string | null) ?? null, matchStatus: String(r["match_status"]),
      }));
    },
    async hasActiveRun(userId) {
      const { data, error } = await sb.from("broker_sync_runs").select("id").eq("user_id", userId).in("state", ["queued", "requested", "polling", "parsing"]).limit(1);
      if (error) throw new RefreshStoreError("hasActiveRun", error.code ?? null);
      return ((data as unknown[] | null) ?? []).length > 0;
    },
    async enqueueDailySync(userId, runDate) {
      const conn = await sb.from("broker_connections").select("id,last_statement_date,status").eq("user_id", userId).maybeSingle();
      const c = conn.data as { id: string; last_statement_date: string | null; status: string } | null;
      if (c === null || c.status !== "linked") return false;
      const { error } = await sb.from("broker_sync_runs").insert({
        user_id: userId, connection_id: c.id, kind: "daily", state: "queued",
        statement_from: c.last_statement_date === null ? null : dayMinus(c.last_statement_date, 5), statement_to: dayMinus(runDate, 1),
        idempotency_key: `${userId}:daily:${runDate}`,
      });
      if (error?.code === "23505") return false;
      if (error) throw new RefreshStoreError("enqueueDailySync", error.code ?? null);
      return true;
    },
  };
}

export function createQuoteKv(sb: SupabaseClient): QuoteKv {
  return {
    async get(keys) {
      const { data, error } = await sb.from("quote_cache").select("key,payload,fetched_at,expires_at").in("key", keys);
      if (error) throw new RefreshStoreError("quote_cache.get", error.code ?? null);
      const out = new Map<string, CachedRow>();
      for (const r of (data as Array<{ key: string; payload: unknown; fetched_at: string; expires_at: string }> | null) ?? []) {
        out.set(r.key, { payload: r.payload, fetchedAt: Date.parse(r.fetched_at), expiresAt: Date.parse(r.expires_at) });
      }
      return out;
    },
    async put(entries) {
      const { error } = await sb.from("quote_cache").upsert(
        entries.map((e) => ({ key: e.key, payload: e.payload, provider: "yahoo", fetched_at: new Date(e.fetchedAt).toISOString(), expires_at: new Date(e.expiresAt).toISOString() })),
        { onConflict: "key" },
      );
      if (error) throw new RefreshStoreError("quote_cache.put", error.code ?? null);
    },
  };
}
```

`supabase/functions/portfolio-refresh/index.ts` (replaces the placeholder):

```ts
import { createClient } from "@supabase/supabase-js";
import { systemClock } from "@adapters/clock.ts";
import { createQuoteCacheKv, createServiceClient } from "@adapters/db.ts";
import { requireEnv } from "@adapters/env.ts";
import { allowedOriginsFromEnv } from "@adapters/http.ts";
import { createClaimsVerifier } from "@adapters/user-auth.ts";
import { createYahooProvider } from "@adapters/yahoo.ts";
import { type RefreshDeps, handleRequest } from "./handler.ts";
import { createCachedQuoteSource } from "./quotes.ts";
import { createQuoteKv, createRefreshStore } from "./store.ts";

function buildDeps(): RefreshDeps {
  const sb = createServiceClient();
  const market = createYahooProvider({ fetchImpl: fetch, store: createQuoteCacheKv(sb), clock: systemClock });
  return {
    verifier: createClaimsVerifier({ url: requireEnv("SUPABASE_URL"), anonKey: requireEnv("SUPABASE_ANON_KEY"), createClient: createClient as never }),
    store: createRefreshStore(sb),
    quotes: createCachedQuoteSource({ kv: createQuoteKv(sb), market: { quote: (symbols) => market.quote(symbols) as never }, nowMs: () => Date.now() }),
    nowMs: () => Date.now(),
    allowedOrigins: allowedOriginsFromEnv(),
    log: (event, data) => console.log(JSON.stringify({ fn: "portfolio-refresh", event, ...data })),
  };
}

let deps: RefreshDeps | undefined;
Deno.serve((req) => handleRequest(req, (deps ??= buildDeps())));
```

Run: `deno test -A --config supabase/functions/deno.json supabase/functions/portfolio-refresh/` then `bun run functions:check`
Expected: PASS (14 tests in the folder) and exit 0. The `quotes()` result of P1's `market.quote` returns `QuoteRecord[]` (spec 5.1) whose field names match `MarketQuote`; the `as never` cast in `index.ts` is the one place to adapt if a field differs.

- [ ] **Step 6: Commit the backend part**

Run: `bun run lint:fix`, `bun run lint`, `bun run typecheck`, `bun run functions:test`, `bun run test:core`
Expected: all exit 0.

```text
git add supabase/functions/_shared/core supabase/functions/portfolio-refresh
git commit -m "feat(portfolio): add statement-day and valuation core and the portfolio-refresh function with an atomic manual cooldown"
```

- [ ] **Step 7: Web API client and cooldown helpers (tests first)**

`apps/web/src/features/portfolio/cooldown.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { formatCountdown, msUntil, serverOffsetMs } from "./cooldown";

describe("countdowns derive from server time, not from the local clock alone", () => {
  it("the offset is server time minus the local time at receipt", () => {
    expect(serverOffsetMs("2026-10-15T07:00:00.000Z", Date.parse("2026-10-15T07:00:05.000Z"))).toBe(-5000);
  });

  it("msUntil compares the target with the local clock corrected by the offset and never goes below zero", () => {
    const target = "2026-10-15T07:01:00.000Z";
    const local = Date.parse("2026-10-15T07:00:05.000Z");
    expect(msUntil(target, local, -5000)).toBe(60_000);
    expect(msUntil(target, local + 30_000, -5000)).toBe(30_000);
    expect(msUntil(target, local + 120_000, -5000)).toBe(0);
    expect(msUntil(null, local, 0)).toBe(0);
  });

  it("a skewed local clock still shows the server's countdown", () => {
    const serverNow = Date.parse("2026-10-15T07:00:00.000Z");
    const localSkewed = serverNow + 3_600_000;
    const offset = serverOffsetMs("2026-10-15T07:00:00.000Z", localSkewed);
    expect(msUntil("2026-10-15T07:01:00.000Z", localSkewed, offset)).toBe(60_000);
  });

  it("formats m:ss rounding up", () => {
    expect(formatCountdown(59_001)).toBe("1:00");
    expect(formatCountdown(42_000)).toBe("0:42");
    expect(formatCountdown(0)).toBe("0:00");
    expect(formatCountdown(299_500)).toBe("5:00");
  });
});
```

`apps/web/src/features/portfolio/cooldown.ts`:

```ts
export const COOLDOWN_MS = 60_000;

/** serverTime minus the local clock at the moment the response arrived; add it to the local clock to get server time. */
export function serverOffsetMs(serverTimeIso: string, receivedAtMs: number): number {
  return Date.parse(serverTimeIso) - receivedAtMs;
}

export function msUntil(targetIso: string | null, localNowMs: number, offsetMs: number): number {
  if (targetIso === null) return 0;
  return Math.max(0, Date.parse(targetIso) - (localNowMs + offsetMs));
}

export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}
```

`apps/web/src/features/portfolio/portfolio-api.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { CooldownError, NotLinkedError, RefreshFailure, createPortfolioApi } from "./portfolio-api";

const body = { serverTime: "2026-10-15T07:00:00.000Z", view: { positions: [] } };

function api(res: Response | Error, token: string | null = "jwt") {
  const fetchImpl = vi.fn(() => (res instanceof Error ? Promise.reject(res) : Promise.resolve(res)));
  return {
    fetchImpl,
    client: createPortfolioApi({ url: "https://p.test/functions/v1/portfolio-refresh", anonKey: "anon", getAccessToken: () => Promise.resolve(token), fetchImpl: fetchImpl as never, now: () => 42 }),
  };
}

describe("portfolio api", () => {
  it("GET sends the bearer token and the anon key and stamps the receipt time", async () => {
    const { client, fetchImpl } = api(new Response(JSON.stringify(body), { status: 200 }));
    const out = await client.get();
    expect(out.receivedAtMs).toBe(42);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://p.test/functions/v1/portfolio-refresh");
    expect(init.method).toBe("GET");
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer jwt");
    expect((init.headers as Record<string, string>)["apikey"]).toBe("anon");
  });

  it("manual refresh is a POST with manual:true", async () => {
    const { client, fetchImpl } = api(new Response(JSON.stringify(body), { status: 200 }));
    await client.refresh();
    const init = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect([init.method, init.body]).toEqual(["POST", JSON.stringify({ manual: true })]);
  });

  it("429 becomes a CooldownError with the Retry-After seconds", async () => {
    const { client } = api(new Response(JSON.stringify({ error: "cooldown", retryAfterSeconds: 41 }), { status: 429, headers: { "retry-after": "41" } }));
    await expect(client.refresh()).rejects.toMatchObject({ name: "CooldownError", retryAfterSeconds: 41 });
    await expect(api(new Response("{}", { status: 429 })).client.refresh()).rejects.toBeInstanceOf(CooldownError);
  });

  it("409 is NotLinkedError, other statuses and network errors are RefreshFailure with no raw details", async () => {
    await expect(api(new Response("{}", { status: 409 })).client.get()).rejects.toBeInstanceOf(NotLinkedError);
    const failure = await api(new Response("secret details", { status: 500 })).client.get().catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(RefreshFailure);
    expect(String((failure as Error).message)).not.toContain("secret");
    await expect(api(new TypeError("Failed to fetch")).client.get()).rejects.toMatchObject({ status: null });
  });

  it("no session means no request", async () => {
    const { client, fetchImpl } = api(new Response("{}"), null);
    await expect(client.get()).rejects.toMatchObject({ status: 401 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
```

`apps/web/src/features/portfolio/portfolio-api.ts`:

```ts
import type { PortfolioResponse } from "@core/portfolio-view.ts";

export type ClientPortfolio = PortfolioResponse & { receivedAtMs: number };

export class CooldownError extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super(`Manual refresh is available again in ${retryAfterSeconds} seconds.`);
    this.name = "CooldownError";
  }
}

export class NotLinkedError extends Error {
  constructor() {
    super("No broker is linked.");
    this.name = "NotLinkedError";
  }
}

export class RefreshFailure extends Error {
  constructor(readonly status: number | null, message: string) {
    super(message);
    this.name = "RefreshFailure";
  }
}

export interface PortfolioApiOptions {
  url: string;
  anonKey: string;
  getAccessToken(): Promise<string | null>;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export interface PortfolioApi {
  get(): Promise<ClientPortfolio>;
  refresh(): Promise<ClientPortfolio>;
}

export function createPortfolioApi(o: PortfolioApiOptions): PortfolioApi {
  const doFetch = o.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const now = o.now ?? (() => Date.now());

  async function call(method: "GET" | "POST"): Promise<ClientPortfolio> {
    const token = await o.getAccessToken();
    if (token === null) throw new RefreshFailure(401, "Sign in again to refresh.");
    const headers: Record<string, string> = { Authorization: `Bearer ${token}`, apikey: o.anonKey };
    if (method === "POST") headers["Content-Type"] = "application/json";
    let res: Response;
    try {
      res = await doFetch(o.url, { method, headers, ...(method === "POST" ? { body: JSON.stringify({ manual: true }) } : {}) });
    } catch {
      throw new RefreshFailure(null, "Network error: could not reach the server.");
    }
    if (res.status === 429) {
      const fromHeader = Number(res.headers.get("retry-after"));
      const fromBody = await res.json().then((b: { retryAfterSeconds?: number }) => Number(b.retryAfterSeconds)).catch(() => Number.NaN);
      throw new CooldownError([fromHeader, fromBody].find((n) => Number.isFinite(n) && n > 0) ?? 60);
    }
    if (res.status === 409) throw new NotLinkedError();
    if (!res.ok) throw new RefreshFailure(res.status, `The refresh failed (HTTP ${res.status}).`);
    return { ...((await res.json()) as PortfolioResponse), receivedAtMs: now() };
  }

  return { get: () => call("GET"), refresh: () => call("POST") };
}
```

`apps/web/src/features/portfolio/default.ts`:

```ts
import { supabase } from "@/lib/supabase";
import { createPortfolioApi } from "./portfolio-api";

const base = import.meta.env.VITE_SUPABASE_URL || "http://127.0.0.1:54321";

/** The real client. Vitest replaces this module with a mock (`vi.mock("./default")`) in the tests that need data. */
export const portfolioApi = createPortfolioApi({
  url: `${base}/functions/v1/portfolio-refresh`,
  anonKey: import.meta.env.VITE_SUPABASE_ANON_KEY || "",
  getAccessToken: async () => (await supabase.auth.getSession()).data.session?.access_token ?? null,
});
```

Run: `bun run test:web features/portfolio/cooldown features/portfolio/portfolio-api`
Expected: PASS (cooldown 4, api 5).

- [ ] **Step 8: Visibility-aware interval, `usePortfolio`, `useManualRefresh` (tests first)**

`apps/web/src/features/portfolio/use-visible-interval.test.tsx`:

```tsx
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useVisibleInterval } from "./use-visible-interval";

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  document.dispatchEvent(new Event("visibilitychange"));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-15T07:00:00Z"));
  setVisibility("visible");
});
afterEach(() => {
  vi.useRealTimers();
});

describe("useVisibleInterval", () => {
  it("calls the callback every interval while the page is visible", () => {
    const cb = vi.fn();
    renderHook(() => useVisibleInterval(cb, 300_000));
    vi.advanceTimersByTime(300_000);
    expect(cb).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(600_000);
    expect(cb).toHaveBeenCalledTimes(3);
  });

  it("pauses while the page is hidden and does not fire in the background", () => {
    const cb = vi.fn();
    renderHook(() => useVisibleInterval(cb, 300_000));
    act(() => setVisibility("hidden"));
    vi.advanceTimersByTime(1_200_000);
    expect(cb).not.toHaveBeenCalled();
  });

  it("on becoming visible runs immediately when the last run is older than the interval, and resumes", () => {
    const cb = vi.fn();
    let last = Date.now();
    renderHook(() => useVisibleInterval(cb, 300_000, { lastRunAt: () => last }));
    act(() => setVisibility("hidden"));
    vi.advanceTimersByTime(400_000);
    act(() => setVisibility("visible"));
    expect(cb).toHaveBeenCalledTimes(1);
    last = Date.now();
    vi.advanceTimersByTime(300_000);
    expect(cb).toHaveBeenCalledTimes(2);
  });

  it("does not run immediately when the last run is recent", () => {
    const cb = vi.fn();
    renderHook(() => useVisibleInterval(cb, 300_000, { lastRunAt: () => Date.now() - 10_000 }));
    act(() => setVisibility("hidden"));
    act(() => setVisibility("visible"));
    expect(cb).not.toHaveBeenCalled();
  });

  it("stops when disabled and clears its timer on unmount", () => {
    const cb = vi.fn();
    const { rerender, unmount } = renderHook(({ enabled }) => useVisibleInterval(cb, 1000, { enabled }), { initialProps: { enabled: false } });
    vi.advanceTimersByTime(5000);
    expect(cb).not.toHaveBeenCalled();
    rerender({ enabled: true });
    vi.advanceTimersByTime(2000);
    expect(cb).toHaveBeenCalledTimes(2);
    unmount();
    vi.advanceTimersByTime(5000);
    expect(cb).toHaveBeenCalledTimes(2);
  });
});
```

`apps/web/src/features/portfolio/use-visible-interval.ts`:

```ts
import { useEffect, useRef } from "react";

/**
 * Calls `callback` every `ms` while the document is visible and `enabled`. Hidden: the timer is cleared (no background polling).
 * On becoming visible it runs once immediately when the last run (`lastRunAt`) is older than `ms`, then resumes the interval.
 * The app does not rely on TanStack Query's background-refetch options (spec 14.2).
 */
export function useVisibleInterval(callback: () => void, ms: number, opts: { enabled?: boolean; lastRunAt?: () => number | null } = {}): void {
  const cb = useRef(callback);
  const lastRunAt = useRef(opts.lastRunAt);
  cb.current = callback;
  lastRunAt.current = opts.lastRunAt;
  const enabled = opts.enabled ?? true;

  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setInterval> | null = null;
    const stop = () => {
      if (timer !== null) clearInterval(timer);
      timer = null;
    };
    const start = () => {
      stop();
      timer = setInterval(() => cb.current(), ms);
    };
    const onChange = () => {
      if (document.visibilityState === "hidden") {
        stop();
        return;
      }
      const last = lastRunAt.current?.() ?? null;
      if (last !== null && Date.now() - last >= ms) cb.current();
      start();
    };
    if (document.visibilityState !== "hidden") start();
    document.addEventListener("visibilitychange", onChange);
    return () => {
      document.removeEventListener("visibilitychange", onChange);
      stop();
    };
  }, [enabled, ms]);
}
```

`apps/web/src/features/portfolio/use-portfolio.test.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientPortfolio } from "./portfolio-api";
import { PORTFOLIO_KEY, usePortfolio } from "./use-portfolio";

const get = vi.fn();
vi.mock("./default", () => ({ portfolioApi: { get: (...a: unknown[]) => get(...a), refresh: vi.fn() } }));

const data = (marker: string): ClientPortfolio =>
  ({ serverTime: "2026-10-15T07:00:00.000Z", nextAutoRefreshAt: "2026-10-15T07:05:00.000Z", manualAvailableAt: "2026-10-15T07:00:00.000Z", lastSuccessfulAt: marker, receivedAtMs: 0, view: { positions: [] } }) as never;

function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return { client, Wrapper: ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider> };
}

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  document.dispatchEvent(new Event("visibilitychange"));
}

beforeEach(() => {
  get.mockReset();
  setVisibility("visible");
});
afterEach(() => vi.useRealTimers());

describe("usePortfolio", () => {
  it("fetches on mount and exposes the data", async () => {
    get.mockResolvedValue(data("a"));
    const { Wrapper } = wrapper();
    const { result } = renderHook(() => usePortfolio(), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.data?.lastSuccessfulAt).toBe("a"));
  });

  it("refetches every five minutes while visible and not while hidden", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    get.mockResolvedValue(data("a"));
    const { Wrapper } = wrapper();
    renderHook(() => usePortfolio(), { wrapper: Wrapper });
    await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(1));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300_000);
    });
    expect(get).toHaveBeenCalledTimes(2);
    act(() => setVisibility("hidden"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(900_000);
    });
    expect(get).toHaveBeenCalledTimes(2);
  });

  it("a failed refresh keeps the last successful data and reports the error (never zeros)", async () => {
    get.mockResolvedValueOnce(data("good"));
    get.mockRejectedValue(new Error("Network error"));
    const { Wrapper, client } = wrapper();
    const { result } = renderHook(() => usePortfolio(), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.data?.lastSuccessfulAt).toBe("good"));
    await act(async () => {
      await result.current.refetch();
    });
    expect(result.current.isError).toBe(true);
    expect(result.current.data?.lastSuccessfulAt).toBe("good");
    expect(client.getQueryData<ClientPortfolio>(PORTFOLIO_KEY)?.lastSuccessfulAt).toBe("good");
  });

  it("does nothing while disabled", async () => {
    const { Wrapper } = wrapper();
    renderHook(() => usePortfolio({ enabled: false }), { wrapper: Wrapper });
    await new Promise((r) => setTimeout(r, 20));
    expect(get).not.toHaveBeenCalled();
  });
});
```

`apps/web/src/features/portfolio/use-portfolio.ts`:

```ts
import { useQuery } from "@tanstack/react-query";
import { AUTO_REFRESH_MS } from "@core/statement-day.ts";
import { portfolioApi } from "./default";
import { NotLinkedError } from "./portfolio-api";
import { useVisibleInterval } from "./use-visible-interval";

export const PORTFOLIO_KEY = ["portfolio"] as const;

/**
 * Valued positions (spec 14.2 key ["portfolio"]). Auto refresh every 5 minutes only while the page is visible; an auto refresh never
 * calls Flex. A failed refetch keeps `data` (TanStack Query semantics) so the UI shows the last successful figures plus the error.
 */
export function usePortfolio(opts: { enabled?: boolean } = {}) {
  const enabled = opts.enabled ?? true;
  const query = useQuery({
    queryKey: PORTFOLIO_KEY,
    queryFn: () => portfolioApi.get(),
    enabled,
    staleTime: 0,
    retry: (failureCount, error) => !(error instanceof NotLinkedError) && failureCount < 1,
    refetchOnWindowFocus: false,
    refetchInterval: false,
  });
  useVisibleInterval(() => void query.refetch(), AUTO_REFRESH_MS, { enabled, lastRunAt: () => (query.dataUpdatedAt > 0 ? query.dataUpdatedAt : null) });
  return query;
}
```

`apps/web/src/features/portfolio/use-manual-refresh.test.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CooldownError, type ClientPortfolio } from "./portfolio-api";
import { PORTFOLIO_KEY } from "./use-portfolio";
import { useManualRefresh } from "./use-manual-refresh";

const refresh = vi.fn();
vi.mock("./default", () => ({ portfolioApi: { get: vi.fn(), refresh: (...a: unknown[]) => refresh(...a) } }));

const NOW = new Date("2026-10-15T07:00:00.000Z");
const payload = (over: Partial<ClientPortfolio> = {}): ClientPortfolio =>
  ({ serverTime: NOW.toISOString(), manualAvailableAt: new Date(NOW.getTime() + 60_000).toISOString(), receivedAtMs: NOW.getTime(), view: { positions: [] }, ...over }) as never;

function setup(initial?: ClientPortfolio) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (initial !== undefined) client.setQueryData(PORTFOLIO_KEY, initial);
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return { client, ...renderHook(() => useManualRefresh(), { wrapper }) };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  refresh.mockReset();
});
afterEach(() => vi.useRealTimers());

describe("useManualRefresh (client cooldown mirrors the server's 60 s)", () => {
  it("is available when the server says so", () => {
    const { result } = setup(payload({ manualAvailableAt: NOW.toISOString() }));
    expect(result.current.secondsLeft).toBe(0);
    expect(result.current.available).toBe(true);
  });

  it("a successful refresh starts a 60 s countdown from the server's manualAvailableAt and counts down", async () => {
    refresh.mockResolvedValue(payload());
    const { result, client } = setup(payload({ manualAvailableAt: NOW.toISOString() }));
    await act(async () => {
      await result.current.refresh();
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(client.getQueryData<ClientPortfolio>(PORTFOLIO_KEY)?.manualAvailableAt).toBe(new Date(NOW.getTime() + 60_000).toISOString());
    expect(result.current.secondsLeft).toBe(60);
    act(() => {
      vi.advanceTimersByTime(45_000);
    });
    expect(result.current.secondsLeft).toBe(15);
    act(() => {
      vi.advanceTimersByTime(15_000);
    });
    expect(result.current.secondsLeft).toBe(0);
    expect(result.current.available).toBe(true);
  });

  it("ignores clicks during the countdown and while a refresh is running (no overlapping requests)", async () => {
    let release: (v: ClientPortfolio) => void = () => undefined;
    refresh.mockImplementation(() => new Promise<ClientPortfolio>((r) => (release = r)));
    const { result } = setup(payload({ manualAvailableAt: NOW.toISOString() }));
    let first: Promise<void> = Promise.resolve();
    act(() => {
      first = result.current.refresh();
      void result.current.refresh();
      void result.current.refresh();
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(result.current.refreshing).toBe(true);
    await act(async () => {
      release(payload());
      await first;
    });
    await act(async () => {
      await result.current.refresh();
    });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("a server 429 sets the countdown from Retry-After and keeps the data", async () => {
    refresh.mockRejectedValue(new CooldownError(37));
    const { result, client } = setup(payload({ manualAvailableAt: NOW.toISOString() }));
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.secondsLeft).toBe(37);
    expect(result.current.error).toBeNull();
    expect(client.getQueryData(PORTFOLIO_KEY)).toBeDefined();
  });

  it("another failure keeps the data, reports the message and does not start a cooldown", async () => {
    refresh.mockRejectedValue(new Error("Network error: could not reach the server."));
    const { result, client } = setup(payload({ manualAvailableAt: NOW.toISOString() }));
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.error).toBe("Network error: could not reach the server.");
    expect(result.current.secondsLeft).toBe(0);
    expect(client.getQueryData<ClientPortfolio>(PORTFOLIO_KEY)?.serverTime).toBe(NOW.toISOString());
  });

  it("the countdown follows the server clock when the local clock is skewed", () => {
    vi.setSystemTime(new Date(NOW.getTime() + 3_600_000));
    const { result } = setup(payload({ receivedAtMs: NOW.getTime() + 3_600_000 }));
    expect(result.current.secondsLeft).toBe(60);
  });
});
```

`apps/web/src/features/portfolio/use-manual-refresh.ts`:

```ts
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { msUntil, serverOffsetMs } from "./cooldown";
import { portfolioApi } from "./default";
import { CooldownError, type ClientPortfolio } from "./portfolio-api";
import { PORTFOLIO_KEY } from "./use-portfolio";

export interface ManualRefresh {
  refresh(): Promise<void>;
  secondsLeft: number;
  available: boolean;
  refreshing: boolean;
  error: string | null;
}

/**
 * The manual refresh button / pull-to-refresh. The 60 s cooldown is shown from the SERVER's `manualAvailableAt` (corrected for clock
 * skew) and enforced again by the backend (HTTP 429). Clicks during the countdown or while a request runs are ignored. It subscribes
 * to the cached `["portfolio"]` data (no fetch of its own), so a manual result updates every component that shows the portfolio.
 */
export function useManualRefresh(): ManualRefresh {
  const queryClient = useQueryClient();
  const { data } = useQuery<ClientPortfolio>({ queryKey: PORTFOLIO_KEY, queryFn: () => portfolioApi.get(), enabled: false });
  const [now, setNow] = useState(() => Date.now());
  const [override, setOverride] = useState<number | null>(null); // local ms timestamp from a 429
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);

  const offset = data === undefined ? 0 : serverOffsetMs(data.serverTime, data.receivedAtMs);
  const serverLeft = data === undefined ? 0 : msUntil(data.manualAvailableAt, now, offset);
  const overrideLeft = override === null ? 0 : Math.max(0, override - now);
  const leftMs = Math.max(serverLeft, overrideLeft);

  const cooling = leftMs > 0;
  useEffect(() => {
    if (!cooling) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [cooling]);

  const refresh = useCallback(async () => {
    if (busy.current || leftMs > 0) return;
    busy.current = true;
    setRefreshing(true);
    setError(null);
    try {
      const fresh = await portfolioApi.refresh();
      queryClient.setQueryData<ClientPortfolio>(PORTFOLIO_KEY, fresh);
      setOverride(null);
    } catch (e) {
      if (e instanceof CooldownError) setOverride(Date.now() + e.retryAfterSeconds * 1000);
      else setError(e instanceof Error ? e.message : "The refresh failed.");
    } finally {
      busy.current = false;
      setRefreshing(false);
      setNow(Date.now());
    }
  }, [leftMs, queryClient]);

  return { refresh, secondsLeft: Math.ceil(leftMs / 1000), available: leftMs <= 0 && !refreshing, refreshing, error };
}
```

Run: `bun run test:web features/portfolio/use-`
Expected: PASS (visible-interval 5, portfolio 4, manual-refresh 6).

- [ ] **Step 9: Presentational pieces: `MoneyText`, `ProvenanceBadge`, `PullToRefresh`, `RefreshBar` (design skills)**

**REQUIRED before this step:** load `frontend-design:frontend-design` and `ui-ux-pro-max:ui-ux-pro-max`. The code below is a complete working baseline; the skills may refine spacing and visual hierarchy. Fixed: every sentence, button name and aria text used by the tests; shadcn components and P0 tokens only; never colour alone; usable at phone width.

`apps/web/src/features/portfolio/money-text.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MoneyText, formatAmount } from "./money-text";

describe("MoneyText", () => {
  it("formats an ok amount with the currency code as text and tabular figures", () => {
    render(<MoneyText money={{ kind: "ok", value: 2320, ccy: "USD" }} />);
    expect(screen.getByText("2,320.00 USD")).toBeTruthy();
  });

  it("signed amounts show an explicit sign and zero stays a real zero", () => {
    render(<MoneyText money={{ kind: "ok", value: 318.3, ccy: "EUR" }} signed />);
    expect(screen.getByText("+318.30 EUR")).toBeTruthy();
    render(<MoneyText money={{ kind: "ok", value: 0, ccy: "EUR" }} signed />);
    expect(screen.getByText("0.00 EUR")).toBeTruthy();
    render(<MoneyText money={{ kind: "ok", value: -5, ccy: "EUR" }} signed />);
    expect(screen.getByText("-5.00 EUR")).toBeTruthy();
  });

  it("an unavailable amount is a dash with the reason for screen readers, never 0", () => {
    render(<MoneyText money={{ kind: "unavailable", reason: "Missing FX rate USD->EUR" }} />);
    expect(screen.getByText("Unavailable: Missing FX rate USD->EUR")).toBeTruthy();
    expect(screen.queryByText(/0\.00/)).toBeNull();
    expect(screen.getByTitle("Missing FX rate USD->EUR")).toBeTruthy();
  });

  it("formatAmount keeps sub-unit precision for small prices", () => {
    expect(formatAmount(0.0123)).toBe("0.0123");
    expect(formatAmount(1234.5)).toBe("1,234.50");
  });
});
```

`apps/web/src/features/portfolio/money-text.tsx`:

```tsx
import type { Money } from "@core/accounting.ts";

const two = new Intl.NumberFormat("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const small = new Intl.NumberFormat("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 6 });

export function formatAmount(value: number): string {
  return value !== 0 && Math.abs(value) < 1 ? small.format(value) : two.format(value);
}

/** "2,320.00 USD"; an unavailable amount renders a dash plus a visually hidden reason (never 0). */
export function MoneyText({ money, signed = false, className = "" }: { money: Money; signed?: boolean; className?: string }) {
  if (money.kind === "unavailable") {
    return (
      <span className={className} title={money.reason}>
        <span aria-hidden="true">{"—"}</span>
        <span className="sr-only">{`Unavailable: ${money.reason}`}</span>
      </span>
    );
  }
  const sign = signed && money.value > 0 ? "+" : "";
  return <span className={`tabular-nums ${className}`}>{`${sign}${formatAmount(money.value)} ${money.ccy}`}</span>;
}
```

`apps/web/src/features/portfolio/provenance.tsx`:

```tsx
import { Calculator, Landmark } from "lucide-react";

export type Provenance = "broker" | "calculated";

const META = {
  broker: { label: "Broker-reported", Icon: Landmark },
  calculated: { label: "Calculated by this app", Icon: Calculator },
} as const;

/** Every analytics number says where it comes from; the label is text, the icon is decoration. */
export function ProvenanceBadge({ kind }: { kind: Provenance }) {
  const { label, Icon } = META[kind];
  return (
    <span className="inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-xs text-muted-foreground" data-testid={`provenance-${kind}`}>
      <Icon aria-hidden="true" size={12} />
      {label}
    </span>
  );
}
```

`apps/web/src/features/portfolio/pull-to-refresh.test.tsx`:

```tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PullToRefresh } from "./pull-to-refresh";

const touch = (y: number) => ({ touches: [{ clientY: y }], changedTouches: [{ clientY: y }] });

function setup(props: { disabled?: boolean } = {}) {
  const onRefresh = vi.fn();
  render(
    <PullToRefresh onRefresh={onRefresh} {...props}>
      <p>content</p>
    </PullToRefresh>,
  );
  return { onRefresh, area: screen.getByTestId("pull-area") };
}

describe("PullToRefresh", () => {
  it("a downward pull of at least 70 px from the top triggers a refresh on release", () => {
    window.scrollY = 0;
    const { onRefresh, area } = setup();
    fireEvent.touchStart(area, touch(100));
    fireEvent.touchMove(area, touch(190));
    expect(screen.getByText("Release to refresh")).toBeTruthy();
    fireEvent.touchEnd(area, touch(190));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("a short pull, an upward swipe, a pull that starts below the top or a disabled control do nothing", () => {
    window.scrollY = 0;
    const a = setup();
    fireEvent.touchStart(a.area, touch(100));
    fireEvent.touchMove(a.area, touch(140));
    fireEvent.touchEnd(a.area, touch(140));
    fireEvent.touchStart(a.area, touch(300));
    fireEvent.touchMove(a.area, touch(100));
    fireEvent.touchEnd(a.area, touch(100));
    expect(a.onRefresh).not.toHaveBeenCalled();

    window.scrollY = 200;
    const b = setup();
    fireEvent.touchStart(b.area, touch(100));
    fireEvent.touchEnd(b.area, touch(260));
    expect(b.onRefresh).not.toHaveBeenCalled();

    window.scrollY = 0;
    const c = setup({ disabled: true });
    fireEvent.touchStart(c.area, touch(100));
    fireEvent.touchEnd(c.area, touch(260));
    expect(c.onRefresh).not.toHaveBeenCalled();
  });
});
```

`apps/web/src/features/portfolio/pull-to-refresh.tsx`:

```tsx
import { type ReactNode, useRef, useState } from "react";

const THRESHOLD_PX = 70;

/** Simple overscroll gesture for touch devices: pull down from the top of the page, release past 70 px. The button is the primary control. */
export function PullToRefresh({ onRefresh, disabled = false, children }: { onRefresh: () => void; disabled?: boolean; children: ReactNode }) {
  const startY = useRef<number | null>(null);
  const [pull, setPull] = useState(0);

  return (
    <div
      data-testid="pull-area"
      onTouchStart={(e) => {
        startY.current = !disabled && window.scrollY <= 0 ? (e.touches[0]?.clientY ?? null) : null;
      }}
      onTouchMove={(e) => {
        if (startY.current === null) return;
        const dy = (e.touches[0]?.clientY ?? startY.current) - startY.current;
        setPull(dy > 0 ? Math.min(dy, 140) : 0);
      }}
      onTouchEnd={(e) => {
        const start = startY.current;
        startY.current = null;
        const dy = start === null ? 0 : (e.changedTouches[0]?.clientY ?? start) - start;
        setPull(0);
        if (start !== null && dy >= THRESHOLD_PX) onRefresh();
      }}
    >
      {pull > 0 ? (
        <p role="status" className="py-1 text-center text-xs text-muted-foreground">
          {pull >= THRESHOLD_PX ? "Release to refresh" : "Pull to refresh"}
        </p>
      ) : null}
      {children}
    </div>
  );
}
```

`apps/web/src/features/portfolio/refresh-bar.test.tsx`:

```tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientPortfolio } from "./portfolio-api";
import { RefreshBar } from "./refresh-bar";

vi.mock("./default", () => ({ portfolioApi: { get: vi.fn(), refresh: vi.fn() } }));
const manualRefresh = vi.fn();
vi.mock("./use-manual-refresh", () => ({ useManualRefresh: () => manualState }));
let manualState = { refresh: manualRefresh, secondsLeft: 0, available: true, refreshing: false, error: null as string | null };

const NOW = new Date("2026-10-15T07:00:00.000Z");
const data = (over: Partial<ClientPortfolio> = {}): ClientPortfolio =>
  ({
    serverTime: NOW.toISOString(), nextAutoRefreshAt: new Date(NOW.getTime() + 272_000).toISOString(), manualAvailableAt: NOW.toISOString(),
    lastSuccessfulAt: "2026-10-15T06:58:00.000Z", reportDate: "2026-10-14", lastStatementDate: "2026-10-14", syncQueued: false, quoteError: null,
    statement: { expectedDate: "2026-10-14", freshness: { kind: "current" } }, receivedAtMs: NOW.getTime(), view: { positions: [] }, ...over,
  }) as never;

const props = (over: Partial<Parameters<typeof RefreshBar>[0]> = {}) => ({ data: data(), error: null, fetching: false, ...over });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  manualState = { refresh: manualRefresh, secondsLeft: 0, available: true, refreshing: false, error: null };
  manualRefresh.mockReset();
});
afterEach(() => vi.useRealTimers());

describe("RefreshBar", () => {
  it("always says the broker data is an end-of-day statement (T+1) and the prices are delayed quotes", () => {
    render(<RefreshBar {...props()} />);
    expect(screen.getByText(/Broker data as of 14 Oct 2026 \(end of day, T\+1\)/)).toBeTruthy();
    expect(screen.getByText("Positions, trades and cost basis come from your IBKR Activity Flex statement as of 2026-10-14 (end of day). Trades made today appear after IBKR builds tomorrow's statement. Prices shown are delayed Yahoo quotes.")).toBeTruthy();
  });

  it("a statement that is behind says so with the number of days and never calls itself today's", () => {
    render(<RefreshBar {...props({ data: data({ statement: { expectedDate: "2026-10-14", freshness: { kind: "behind", days: 3 } } as never, reportDate: "2026-10-11" }) })} />);
    expect(screen.getByText(/The statement is 3 days behind the expected date/)).toBeTruthy();
    expect(screen.queryByText(/today's positions/i)).toBeNull();
  });

  it("shows the last successful refresh in Sofia time and the countdown to the next automatic refresh", () => {
    render(<RefreshBar {...props()} />);
    expect(screen.getByText(/Last successful refresh: 15 Oct 2026, 09:58/)).toBeTruthy();
    expect(screen.getByText(/Next automatic refresh in 4:32/)).toBeTruthy();
  });

  it("the Refresh button calls the manual refresh; during the cooldown it is disabled and shows the countdown", () => {
    const { rerender } = render(<RefreshBar {...props()} />);
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(manualRefresh).toHaveBeenCalledTimes(1);
    manualState = { ...manualState, secondsLeft: 42, available: false };
    rerender(<RefreshBar {...props()} />);
    const button = screen.getByRole("button", { name: /Refresh in 0:42/ });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(button);
    expect(manualRefresh).toHaveBeenCalledTimes(1);
  });

  it("a failed refresh shows the error and the time of the data still on screen, never a blank", () => {
    render(<RefreshBar {...props({ error: new Error("Network error: could not reach the server.") })} />);
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("Network error: could not reach the server.");
    expect(alert.textContent).toContain("Showing the data from 15 Oct 2026, 09:58");
  });

  it("a quote problem is reported while the statement prices stay visible", () => {
    render(<RefreshBar {...props({ data: data({ quoteError: "quote_provider_unavailable", lastSuccessfulAt: null }) })} />);
    expect(screen.getByRole("alert").textContent).toContain("Delayed quotes are unavailable");
    expect(screen.getByText(/Last successful refresh: none yet/)).toBeTruthy();
  });

  it("the manual refresh error from the hook is shown too", () => {
    manualState = { ...manualState, error: "The refresh failed (HTTP 500)." };
    render(<RefreshBar {...props()} />);
    expect(screen.getByRole("alert").textContent).toContain("The refresh failed (HTTP 500).");
  });
});
```

`apps/web/src/features/portfolio/refresh-bar.tsx`:

```tsx
import { AlertTriangle, RefreshCw } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { t1Disclosure } from "@core/statement-day.ts";
import { Button } from "@/components/ui/button";
import { formatSessionDate, formatSofia } from "@/lib/format";
import { formatCountdown, msUntil, serverOffsetMs } from "./cooldown";
import type { ClientPortfolio } from "./portfolio-api";
import { PullToRefresh } from "./pull-to-refresh";
import { useManualRefresh } from "./use-manual-refresh";

export interface RefreshBarProps {
  data: ClientPortfolio | undefined;
  /** error of the last background or manual fetch; `data` is still the last successful result */
  error: Error | null;
  fetching: boolean;
  children?: ReactNode;
}

export function RefreshBar({ data, error, fetching, children }: RefreshBarProps) {
  const manual = useManualRefresh();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const offset = data === undefined ? 0 : serverOffsetMs(data.serverTime, data.receivedAtMs);
  const nextMs = data === undefined ? 0 : msUntil(data.nextAutoRefreshAt, now, offset);
  const last = data?.lastSuccessfulAt ?? null;
  const behind = data?.statement.freshness.kind === "behind" ? data.statement.freshness.days : null;
  const problems = [
    error === null ? null : `Could not refresh: ${error.message}${last === null ? "" : ` Showing the data from ${formatSofia(last)}.`}`,
    data?.quoteError ? "Delayed quotes are unavailable right now; values use the statement close of the report date." : null,
    manual.error,
  ].filter((p): p is string => p !== null);

  return (
    <PullToRefresh onRefresh={() => void manual.refresh()} disabled={!manual.available}>
      <section aria-label="Refresh status" className="space-y-2 rounded-md border p-3 text-sm">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="font-medium">
            {data?.reportDate ? `Broker data as of ${formatSessionDate(data.reportDate)} (end of day, T+1)` : "Broker data: no statement yet"}
          </p>
          <Button type="button" size="sm" variant="outline" disabled={!manual.available} onClick={() => void manual.refresh()}>
            <RefreshCw aria-hidden="true" className={manual.refreshing || fetching ? "animate-spin motion-reduce:animate-none" : ""} size={14} />
            {manual.secondsLeft > 0 ? `Refresh in ${formatCountdown(manual.secondsLeft * 1000)}` : "Refresh"}
          </Button>
        </div>
        {behind !== null ? (
          <p className="inline-flex items-center gap-1 rounded border border-[var(--status-amber-bd)] px-2 py-0.5">
            <AlertTriangle aria-hidden="true" size={14} />
            {`The statement is ${behind} day${behind === 1 ? "" : "s"} behind the expected date${data?.syncQueued ? "; a sync was requested" : ""}.`}
          </p>
        ) : null}
        <p className="text-muted-foreground">{t1Disclosure(data?.reportDate ?? null)}</p>
        <p className="text-muted-foreground">
          {`Last successful refresh: ${last === null ? "none yet" : formatSofia(last)}`}
          {" · "}
          {document.visibilityState === "hidden" ? "automatic refresh paused while the tab is hidden" : `Next automatic refresh in ${formatCountdown(nextMs)}`}
        </p>
        {problems.map((p) => (
          <p key={p} role="alert" className="rounded border border-[var(--status-red-bd)] px-2 py-1">
            {p}
          </p>
        ))}
        {children}
      </section>
    </PullToRefresh>
  );
}
```

Run: `bun run test:web features/portfolio`
Expected: PASS (all files of this task). In the "behind" test the days text is `The statement is 3 days behind the expected date`.

- [ ] **Step 10: Lint, typecheck, commit**

Run: `bun run lint:fix`, `bun run lint`, `bun run typecheck`, `bun run test:web`
Expected: exit 0.

```text
git add apps/web/src/features/portfolio
git commit -m "feat(web): add portfolio api client, visibility-aware refresh hooks, cooldown, pull-to-refresh and refresh bar"
```

---

## Task 6: Profile -> Broker page

**Concurrency:** starts after Task 4 (the `broker-sync` contract) and may run at the same time as Tasks 7 and 8: it only touches `apps/web/src/features/broker/*` and the P5a placeholder panel file.

**REQUIRED before Step 5 (components):** the implementer MUST load `frontend-design:frontend-design` and `ui-ux-pro-max:ui-ux-pro-max` (Skill tool). The code below is a complete working baseline; the skills may refine layout, spacing and copy styling. Fixed constraints: keep every heading, label, button name and sentence used by the tests; shadcn components and P0 tokens only; status is never colour only (icon plus text); usable at phone width; the token field is `type="password"`.

**Files:**
- Create: `apps/web/src/features/broker/{broker-api,default,use-broker,broker-view,setup-content}.ts`, tests `broker-api.test.ts`, `broker-view.test.ts`
- Create: `apps/web/src/features/broker/components/{error-hint,section-checklist,status-card,link-form,unlink-dialog,setup-guide}.tsx` with tests `error-hint.test.tsx`, `status-card.test.tsx`, `link-form.test.tsx`, `unlink-dialog.test.tsx`, `setup-guide.test.tsx`
- Create: `apps/web/src/features/broker/broker-section.tsx`, `broker-section.test.tsx`
- Modify: `apps/web/src/features/profile/panels/broker-panel.tsx` (P5a placeholder; body only), the P5a assertion of the placeholder sentence in `apps/web/src/features/profile/profile-panels.test.tsx`

**Interfaces:**
- Consumes: Task 4 HTTP contract of `broker-sync` (`link`, `test`, `sync`, `unlink` with the response shapes of `PublicConnection` and `PublicRun`), `@core/flex-errors.ts`, RLS-readable `broker_connections` safe columns and `broker_sync_runs` safe columns (Task 1), P0 shadcn `card badge button input label dialog skeleton`, `lib/supabase.ts`.
- Produces: `BrokerSection` (rendered by `BrokerPanel`), `createBrokerApi`, `useBrokerSnapshot`, `useBrokerActions`, `describeConnection`, `tokenExpiry`, `SETUP_STEPS`, `FLEX_SECTIONS`.

- [ ] **Step 1: API client (tests first)**

`apps/web/src/features/broker/broker-api.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { createBrokerApi } from "./broker-api";

const conn = { id: "c1", status: "linked", account_id_masked: "U***4567" };
const run = { id: "r1", kind: "verify", state: "done", error_code: null, error_message: null, rows_summary: {} };

function api(res: Response | Error) {
  const call = vi.fn(() => (res instanceof Error ? Promise.reject(res) : Promise.resolve(res)));
  return { call, client: createBrokerApi({ readSnapshot: vi.fn(), call }) };
}
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers });

describe("broker api", () => {
  it("link posts the action with the token only in the request body and returns the safe connection", async () => {
    const { client, call } = api(json({ ok: true, connection: conn, run }));
    const out = await client.link({ token: "987654321012345678901234", queryId: "123456", tokenExpiresOn: "2027-06-01" });
    expect(call).toHaveBeenCalledWith({ action: "link", token: "987654321012345678901234", queryId: "123456", tokenExpiresOn: "2027-06-01" });
    expect(out).toEqual({ ok: true, connection: conn, run });
    expect(JSON.stringify(out)).not.toContain("987654321012345678901234");
  });

  it("test, sync and unlink map to their actions", async () => {
    const { client, call } = api(json({ ok: true, connection: conn, run }));
    await client.test();
    await client.sync();
    await client.unlink({ deleteData: true });
    expect(call.mock.calls.map((c) => c[0])).toEqual([{ action: "test" }, { action: "sync" }, { action: "unlink", deleteData: true }]);
  });

  it("maps HTTP outcomes: invalid input with the field, cooldown with Retry-After, busy, not linked, failure", async () => {
    expect(await api(json({ error: "invalid_input", field: "queryId", message: "The Query ID is a number." }, 400)).client.link({ token: "x", queryId: "y", tokenExpiresOn: "z" })).toEqual({
      ok: false, kind: "invalid_input", field: "queryId", message: "The Query ID is a number.",
    });
    expect(await api(json({ error: "cooldown", retryAfterSeconds: 321 }, 429, { "retry-after": "321" })).client.sync()).toEqual({ ok: false, kind: "cooldown", retryAfterSeconds: 321 });
    expect(await api(json({ error: "run_in_progress" }, 409)).client.test()).toEqual({ ok: false, kind: "busy" });
    expect(await api(json({ error: "not_linked" }, 409)).client.test()).toEqual({ ok: false, kind: "not_linked" });
    expect(await api(json({ error: "internal_error" }, 500)).client.sync()).toEqual({ ok: false, kind: "failed", message: "The request failed (HTTP 500)." });
  });

  it("a network error is a failure without raw details", async () => {
    const out = await api(new TypeError("Failed to fetch https://x?t=SECRET")).client.sync();
    expect(out).toEqual({ ok: false, kind: "failed", message: "Network error: could not reach the server." });
  });
});
```

`apps/web/src/features/broker/broker-api.ts`:

```ts
export type BrokerStatus = "unlinked" | "linking" | "linked" | "error" | "expired";

export interface BrokerConnection {
  id: string;
  status: BrokerStatus;
  token_expires_on: string | null;
  query_id: string | null;
  account_id_masked: string | null;
  base_currency: string | null;
  account_type: string | null;
  linked_at: string | null;
  last_verified_at: string | null;
  last_sync_at: string | null;
  last_statement_date: string | null;
  last_error_code: number | null;
  last_error_message: string | null;
  last_error_at: string | null;
  coverage_from: string | null;
}

export interface SectionReport {
  section: string;
  present: boolean;
  missingFields: string[];
}

export interface BrokerRun {
  id: string;
  kind: "verify" | "daily" | "manual" | "backfill";
  state: "queued" | "requested" | "polling" | "parsing" | "done" | "failed" | "expired";
  error_code: number | null;
  error_message: string | null;
  rows_summary: { sections?: SectionReport[]; positions?: number; trades?: number; closed_lots?: number; warnings?: string[] };
  statement_from?: string | null;
  statement_to?: string | null;
}

export interface BrokerSnapshot {
  connection: BrokerConnection | null;
  run: BrokerRun | null;
}

export type ActionResult =
  | { ok: true; connection: BrokerConnection | null; run: BrokerRun | null }
  | { ok: false; kind: "invalid_input"; field: string; message: string }
  | { ok: false; kind: "cooldown"; retryAfterSeconds: number }
  | { ok: false; kind: "busy" }
  | { ok: false; kind: "not_linked" }
  | { ok: false; kind: "failed"; message: string };

export interface LinkInput {
  token: string;
  queryId: string;
  tokenExpiresOn: string;
}

export interface BrokerApi {
  readSnapshot(): Promise<BrokerSnapshot>;
  link(input: LinkInput): Promise<ActionResult>;
  test(): Promise<ActionResult>;
  sync(): Promise<ActionResult>;
  unlink(o: { deleteData: boolean }): Promise<ActionResult>;
}

export interface BrokerApiOptions {
  readSnapshot(): Promise<BrokerSnapshot>;
  /** POST to the broker-sync function with the user's session; the token is only ever in this request body, over HTTPS */
  call(body: Record<string, unknown>): Promise<Response>;
}

export function createBrokerApi(o: BrokerApiOptions): BrokerApi {
  async function act(body: Record<string, unknown>): Promise<ActionResult> {
    let res: Response;
    try {
      res = await o.call(body);
    } catch {
      return { ok: false, kind: "failed", message: "Network error: could not reach the server." };
    }
    const payload = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (res.ok) return { ok: true, connection: (payload["connection"] as BrokerConnection | null | undefined) ?? null, run: (payload["run"] as BrokerRun | null | undefined) ?? null };
    if (res.status === 400 && payload["error"] === "invalid_input") {
      return { ok: false, kind: "invalid_input", field: String(payload["field"] ?? ""), message: String(payload["message"] ?? "Check the value.") };
    }
    if (res.status === 429) {
      const retry = Number(res.headers.get("retry-after")) || Number(payload["retryAfterSeconds"]) || 600;
      return { ok: false, kind: "cooldown", retryAfterSeconds: retry };
    }
    if (res.status === 409) return payload["error"] === "not_linked" ? { ok: false, kind: "not_linked" } : { ok: false, kind: "busy" };
    return { ok: false, kind: "failed", message: `The request failed (HTTP ${res.status}).` };
  }
  return {
    readSnapshot: o.readSnapshot,
    link: (input) => act({ action: "link", token: input.token, queryId: input.queryId, tokenExpiresOn: input.tokenExpiresOn }),
    test: () => act({ action: "test" }),
    sync: () => act({ action: "sync" }),
    unlink: ({ deleteData }) => act({ action: "unlink", deleteData }),
  };
}
```

`apps/web/src/features/broker/default.ts`:

```ts
import { supabase } from "@/lib/supabase";
import { type BrokerConnection, type BrokerRun, createBrokerApi } from "./broker-api";

const base = import.meta.env.VITE_SUPABASE_URL || "http://127.0.0.1:54321";
const CONNECTION_COLUMNS =
  "id,status,token_expires_on,query_id,account_id_masked,base_currency,account_type,linked_at,last_verified_at,last_sync_at,last_statement_date,last_error_code,last_error_message,last_error_at,coverage_from";

/** The real client. The secret columns are not selectable (spec 6.8), so they are never listed here. */
export const brokerApi = createBrokerApi({
  async readSnapshot() {
    const conn = await supabase.from("broker_connections").select(CONNECTION_COLUMNS).maybeSingle();
    if (conn.error) throw new Error("Could not load the broker connection.");
    const run = await supabase
      .from("broker_sync_runs")
      .select("id,kind,state,error_code,error_message,rows_summary,statement_from,statement_to")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (run.error) throw new Error("Could not load the last sync.");
    return { connection: (conn.data as BrokerConnection | null) ?? null, run: (run.data as BrokerRun | null) ?? null };
  },
  async call(body) {
    const session = (await supabase.auth.getSession()).data.session;
    return await fetch(`${base}/functions/v1/broker-sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${session?.access_token ?? ""}`, apikey: import.meta.env.VITE_SUPABASE_ANON_KEY || "" },
      body: JSON.stringify(body),
    });
  },
});
```

Run: `bun run test:web features/broker/broker-api`
Expected: PASS (4 tests).

- [ ] **Step 2: View helpers and setup content (tests first)**

`apps/web/src/features/broker/broker-view.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { BrokerConnection, BrokerRun } from "./broker-api";
import { describeConnection, runActive, runLabel, tokenExpiry } from "./broker-view";

const conn = (o: Partial<BrokerConnection> = {}): BrokerConnection => ({
  id: "c", status: "linked", token_expires_on: "2027-01-01", query_id: "123456", account_id_masked: "U***4567", base_currency: "EUR", account_type: "Individual",
  linked_at: "2026-10-01T00:00:00Z", last_verified_at: "2026-10-15T05:00:00Z", last_sync_at: "2026-10-15T05:01:00Z", last_statement_date: "2026-10-14",
  last_error_code: null, last_error_message: null, last_error_at: null, coverage_from: "2025-10-15", ...o,
});
const run = (o: Partial<BrokerRun> = {}): BrokerRun => ({ id: "r", kind: "daily", state: "done", error_code: null, error_message: null, rows_summary: {}, ...o });

describe("describeConnection", () => {
  it("no connection and unlinked are Not linked", () => {
    expect(describeConnection(null, null).label).toBe("Not linked");
    expect(describeConnection(conn({ status: "unlinked" }), null).label).toBe("Not linked");
  });
  it("every status has a text label and a distinct icon name (never colour alone)", () => {
    const seen = new Set<string>();
    for (const [status, label] of [["linked", "Linked"], ["error", "Needs attention"], ["expired", "Token expired"], ["linking", "Verifying"]] as const) {
      const d = describeConnection(conn({ status }), null);
      expect(d.label).toBe(label);
      seen.add(d.icon);
    }
    seen.add(describeConnection(null, null).icon);
    expect(seen.size).toBe(5);
  });
  it("an active run turns a linked connection into a visible sync in progress", () => {
    expect(describeConnection(conn(), run({ state: "polling" })).detail).toBe("Waiting for IBKR to generate the statement");
  });
});

describe("runs", () => {
  it("runActive is true for queued, requested, polling and parsing only", () => {
    for (const state of ["queued", "requested", "polling", "parsing"] as const) expect(runActive(run({ state }))).toBe(true);
    for (const state of ["done", "failed", "expired"] as const) expect(runActive(run({ state }))).toBe(false);
    expect(runActive(null)).toBe(false);
  });
  it("runLabel is plain language", () => {
    expect(runLabel("requested")).toBe("Statement requested from IBKR");
    expect(runLabel("parsing")).toBe("Reading the statement");
  });
});

describe("tokenExpiry (banner 14 days before expiry, spec 12.3)", () => {
  const today = new Date("2026-10-15T08:00:00Z");
  it("is null when far away or unknown", () => {
    expect(tokenExpiry("2027-01-01", today)).toBeNull();
    expect(tokenExpiry(null, today)).toBeNull();
  });
  it("is soon within 14 days, with the number of days", () => {
    expect(tokenExpiry("2026-10-29", today)).toEqual({ kind: "soon", days: 14 });
    expect(tokenExpiry("2026-10-16", today)).toEqual({ kind: "soon", days: 1 });
    expect(tokenExpiry("2026-10-30", today)).toBeNull();
  });
  it("is expired on and after the expiry date", () => {
    expect(tokenExpiry("2026-10-15", today)).toEqual({ kind: "expired", days: 0 });
    expect(tokenExpiry("2026-10-01", today)).toEqual({ kind: "expired", days: 14 });
  });
});
```

`apps/web/src/features/broker/broker-view.ts`:

```ts
import type { BrokerConnection, BrokerRun } from "./broker-api";

export type StatusIcon = "plug-off" | "check" | "alert" | "clock" | "loader";

export interface ConnectionDescription {
  label: string;
  icon: StatusIcon;
  detail: string | null;
}

export function runActive(run: BrokerRun | null): boolean {
  return run !== null && (run.state === "queued" || run.state === "requested" || run.state === "polling" || run.state === "parsing");
}

export function runLabel(state: BrokerRun["state"]): string {
  switch (state) {
    case "queued": return "Waiting to start";
    case "requested": return "Statement requested from IBKR";
    case "polling": return "Waiting for IBKR to generate the statement";
    case "parsing": return "Reading the statement";
    case "done": return "Finished";
    case "failed": return "Failed";
    case "expired": return "Token expired";
  }
}

export function describeConnection(conn: BrokerConnection | null, run: BrokerRun | null): ConnectionDescription {
  if (conn === null || conn.status === "unlinked") return { label: "Not linked", icon: "plug-off", detail: null };
  if (conn.status === "expired") return { label: "Token expired", icon: "clock", detail: null };
  if (conn.status === "error") return { label: "Needs attention", icon: "alert", detail: null };
  if (conn.status === "linking") return { label: "Verifying", icon: "loader", detail: run !== null ? runLabel(run.state) : "Verifying with IBKR" };
  return { label: "Linked", icon: "check", detail: runActive(run) && run !== null ? runLabel(run.state) : null };
}

const DAY_MS = 86_400_000;

/** Banner rule of spec 12.3: from 14 days before the user-entered expiry date. */
export function tokenExpiry(expiresOn: string | null, now: Date): { kind: "soon" | "expired"; days: number } | null {
  if (expiresOn === null) return null;
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const target = Date.parse(`${expiresOn}T00:00:00Z`);
  const days = Math.round((target - today) / DAY_MS);
  if (days <= 0) return { kind: "expired", days: -days };
  return days <= 14 ? { kind: "soon", days } : null;
}
```

`apps/web/src/features/broker/setup-content.ts`:

```ts
/** Step-by-step Flex setup (spec 12.2, research flex 2.1). Attribute spellings are not shown to users; labels are the Flex editor labels. */
export const SETUP_STEPS: readonly string[] = [
  "In the IBKR Client Portal open Performance & Reports, then Reporting, then Flex Queries.",
  "Create an Activity Flex Query: press the “+” next to Activity Flex Query, give it a name (for example Screener), open each section listed below and tick the listed fields, then save.",
  "In Delivery Configuration choose Format XML, Period Last 365 Calendar Days, your account, Date Format yyyyMMdd, Time Format HHmmss and Date/Time Separator ; (semi-colon).",
  "Open the Info icon next to the query and note the Query ID (the number at the top).",
  "On the same page open Flex Web Service Configuration, tick Flex Web Service Status and save. Create a token that stays active for the longest period you are comfortable with (6 hours to 1 year). Do not set an IP restriction: this app calls IBKR from changing server addresses.",
  "Paste the token and the Query ID below, enter the date your token expires, and press Link. The token gives read access to all account activity for the queries you defined: treat it as a secret.",
];

export interface FlexSection {
  section: string;
  fields: string[];
  note?: string;
}

export const FLEX_SECTIONS: readonly FlexSection[] = [
  { section: "Account Information", fields: ["Account ID", "Account Alias", "Currency", "Name", "Account Type"] },
  {
    section: "Open Positions (Level of Detail: Summary)",
    fields: ["Currency", "Asset Class", "FX Rate to Base", "Symbol", "Description", "Conid", "ISIN", "Report Date", "Quantity", "Multiplier", "Mark Price", "Position Value", "Open Price", "Cost Basis Price", "Cost Basis Money", "Percent of NAV", "FIFO Unrealized PNL", "Side", "Level of Detail"],
  },
  {
    section: "Trades (Levels of Detail: Executions and Closed Lots)",
    fields: ["Currency", "Asset Class", "FX Rate to Base", "Symbol", "Description", "Conid", "ListingExchange", "ISIN", "Trade ID", "Report Date", "Trade Date", "Trade Time", "Settle Date Target", "Transaction Type", "Exchange", "Quantity", "Trade Price", "Multiplier", "Trade Money", "Proceeds", "Taxes", "IB Commission", "IB Commission Currency", "Open/Close Indicator", "Notes/Codes", "Cost Basis", "Realized PNL", "Buy/Sell", "IB Order ID", "IB Execution ID", "Open Date Time", "Level of Detail", "Net Cash", "Order Type"],
    note: "Select both levels of detail: Executions and Closed Lots. Without Closed Lots the realized profit and loss cannot be summed.",
  },
  { section: "Cash Transactions", fields: ["Currency", "Asset Class", "FX Rate to Base", "Symbol", "Description", "Conid", "ISIN", "Date/Time", "Amount", "Type", "Trade ID", "Code"] },
  { section: "Currency Conversion Rate", fields: ["Date/Time", "From Currency", "To Currency", "Rate"] },
  { section: "Net Asset Value (NAV) Summary in Base", fields: ["Report Date", "Cash", "Stock", "Options", "Bonds", "Interest Accruals", "Dividend Accruals", "Total"] },
  { section: "Financial Instrument Information", fields: ["Asset Class", "Symbol", "Subcategory", "Listing Exchange", "Description", "Conid", "ISIN"] },
  { section: "Corporate Actions", fields: ["Report Date", "Date/Time", "Amount", "Proceeds", "Value", "Quantity", "Realized P/L", "Code", "Type", "ID", "Transaction ID", "Conid", "Symbol", "ISIN"] },
  { section: "Transfers (ACATS, Internal)", fields: ["Report Date", "Date", "Type", "Direction", "Quantity", "Transfer Price", "Position Amount", "P/L Amount", "Code", "Transaction ID", "Conid", "Symbol", "ISIN"] },
  { section: "Optional: Change in Dividend Accruals", fields: ["Ex Date", "Pay Date", "Gross Rate", "Gross Amount", "Tax", "Net Amount"] },
];

export const REQUIREMENTS: readonly string[] = [
  "Supported method: IBKR Flex Web Service, read-only (an Activity Flex Query plus a token).",
  "Account permissions: you must be able to create Flex Queries and a Flex Web Service token in the Client Portal.",
  "No gateway, no application registration and no local process are needed. No market-data subscription is needed: prices come from delayed Yahoo quotes.",
  "No IBKR username or password is ever requested or stored.",
];

export const LIMITS: readonly string[] = [
  "No live or intraday prices and no real-time positions: IBKR builds the Activity statement once per day at close of business, so the data is as of the previous trading day (T+1).",
  "No orders: this app cannot place, change or cancel orders. The trade history shows executions from your statements only.",
  "The app cannot revoke your token. After unlinking, disable or regenerate the token in Flex Web Service Configuration.",
  "A token expires after at most one year; link again with a new token before that date.",
];
```

Run: `bun run test:web features/broker/broker-view`
Expected: PASS (8 tests).

- [ ] **Step 3: Component tests (written before the components)**

`apps/web/src/features/broker/components/error-hint.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ErrorHint } from "./error-hint";

describe("ErrorHint", () => {
  const cases: Array<[number, RegExp, RegExp]> = [
    [1012, /The Flex token has expired/, /Generate a new token in Client Portal/],
    [1015, /IBKR does not recognise the token/, /Copy the Current Token again/],
    [1014, /IBKR does not recognise the Query ID/, /Check the Query ID/],
    [1013, /IP restriction/, /Remove the IP restriction/],
    [1018, /1 request per second and 10 per minute/, /waits a minute/],
    [1019, /still generating the statement/, /retries automatically/],
    [-2, /cannot be decrypted/, /Link again/],
    [-6, /missing required sections or fields/, /select every section and field/],
  ];
  for (const [code, message, hint] of cases) {
    it(`code ${code} shows the message and the troubleshooting hint`, () => {
      render(<ErrorHint code={code} />);
      expect(screen.getByText(message)).toBeTruthy();
      expect(screen.getByText(hint)).toBeTruthy();
      expect(screen.getByText(`Error code ${code}`)).toBeTruthy();
    });
  }

  it("an unknown code still gets a generic explanation and nothing renders without a code", () => {
    render(<ErrorHint code={1999} />);
    expect(screen.getByText(/unknown error code \(1999\)/)).toBeTruthy();
    const { container } = render(<ErrorHint code={null} />);
    expect(container.textContent).toBe("");
  });
});
```

`apps/web/src/features/broker/components/error-hint.tsx`:

```tsx
import { flexErrorInfo } from "@core/flex-errors.ts";

/** IBKR / internal error code with its plain message and troubleshooting hint (same table the backend uses). */
export function ErrorHint({ code }: { code: number | null }) {
  if (code === null) return null;
  const info = flexErrorInfo(code);
  return (
    <div className="space-y-1 text-sm">
      <p className="font-medium">{info.message}</p>
      <p className="text-muted-foreground">{info.hint}</p>
      <p className="text-xs text-muted-foreground">{`Error code ${code}`}</p>
    </div>
  );
}
```

`apps/web/src/features/broker/components/section-checklist.tsx`:

```tsx
import { Check, X } from "lucide-react";
import type { SectionReport } from "../broker-api";

/** The sections of the verification statement: found or missing, and the exact fields that are missing (spec 12.3). */
export function SectionChecklist({ sections }: { sections: SectionReport[] }) {
  return (
    <ul aria-label="Statement sections" className="space-y-1 text-sm">
      {sections.map((s) => {
        const ok = s.present && s.missingFields.length === 0;
        return (
          <li key={s.section} className="flex items-start gap-2">
            {ok ? <Check aria-hidden="true" size={16} /> : <X aria-hidden="true" size={16} />}
            <span>
              {`${s.section}: ${!s.present ? "missing" : s.missingFields.length > 0 ? "found, fields missing" : "found"}`}
              {s.missingFields.length > 0 ? <span className="block text-muted-foreground">{`Missing fields: ${s.missingFields.join(", ")}`}</span> : null}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
```

`apps/web/src/features/broker/components/status-card.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { BrokerConnection, BrokerRun } from "../broker-api";
import { StatusCard } from "./status-card";

const conn = (o: Partial<BrokerConnection> = {}): BrokerConnection => ({
  id: "c", status: "linked", token_expires_on: "2027-06-01", query_id: "123456", account_id_masked: "U***4567", base_currency: "EUR", account_type: "Individual",
  linked_at: "2026-10-01T00:00:00Z", last_verified_at: "2026-10-15T05:00:00Z", last_sync_at: "2026-10-15T05:01:00Z", last_statement_date: "2026-10-14",
  last_error_code: null, last_error_message: null, last_error_at: null, coverage_from: "2025-10-15", ...o,
});
const run = (o: Partial<BrokerRun> = {}): BrokerRun => ({ id: "r", kind: "daily", state: "done", error_code: null, error_message: null, rows_summary: {}, ...o });
const NOW = new Date("2026-10-15T08:00:00Z");

describe("StatusCard", () => {
  it("not linked", () => {
    render(<StatusCard connection={null} run={null} now={NOW} />);
    expect(screen.getByText("Not linked")).toBeTruthy();
    expect(screen.queryByText("Account")).toBeNull();
  });

  it("linked shows account, base currency and the timestamps in Sofia time, never the token", () => {
    render(<StatusCard connection={conn()} run={run()} now={NOW} />);
    expect(screen.getByText("Linked")).toBeTruthy();
    expect(screen.getByText("U***4567")).toBeTruthy();
    expect(screen.getByText("EUR")).toBeTruthy();
    expect(screen.getByText("15 Oct 2026, 08:00")).toBeTruthy();
    expect(screen.getByText("14 Oct 2026")).toBeTruthy();
    expect(screen.getByText(/History loaded from/)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/token\s*[:=]/i);
  });

  it("a running sync is visible with its step", () => {
    render(<StatusCard connection={conn()} run={run({ state: "polling" })} now={NOW} />);
    expect(screen.getByText("Waiting for IBKR to generate the statement")).toBeTruthy();
  });

  it("error shows the last error with its hint and the statement section checklist with the exact missing fields", () => {
    render(
      <StatusCard
        connection={conn({ status: "error", last_error_code: -6, last_error_at: "2026-10-15T05:02:00Z" })}
        run={run({ kind: "verify", state: "failed", error_code: -6, rows_summary: { sections: [
          { section: "Account Information", present: true, missingFields: [] },
          { section: "Open Positions", present: true, missingFields: ["Cost Basis Money"] },
          { section: "Cash Transactions", present: false, missingFields: [] },
        ] } })}
        now={NOW}
      />,
    );
    expect(screen.getByText("Needs attention")).toBeTruthy();
    expect(screen.getByText(/missing required sections or fields/)).toBeTruthy();
    expect(screen.getByText("Open Positions: found, fields missing")).toBeTruthy();
    expect(screen.getByText("Missing fields: Cost Basis Money")).toBeTruthy();
    expect(screen.getByText("Cash Transactions: missing")).toBeTruthy();
  });

  it("expired shows the 1012 guidance", () => {
    render(<StatusCard connection={conn({ status: "expired", last_error_code: 1012 })} run={null} now={NOW} />);
    expect(screen.getByText("Token expired")).toBeTruthy();
    expect(screen.getByText(/Generate a new token in Client Portal/)).toBeTruthy();
  });

  it("warns 14 days before the token expires and when it has expired", () => {
    const { rerender } = render(<StatusCard connection={conn({ token_expires_on: "2026-10-22" })} run={null} now={NOW} />);
    expect(screen.getByText(/Your Flex token expires in 7 days/)).toBeTruthy();
    rerender(<StatusCard connection={conn({ token_expires_on: "2026-10-10" })} run={null} now={NOW} />);
    expect(screen.getByText(/Your Flex token expired 5 days ago/)).toBeTruthy();
  });

  it("a linked connection with a failed daily sync shows the error but stays Linked", () => {
    render(<StatusCard connection={conn({ last_error_code: 1021, last_error_at: "2026-10-15T05:30:00Z" })} run={run({ state: "failed", error_code: 1021 })} now={NOW} />);
    expect(screen.getByText("Linked")).toBeTruthy();
    expect(screen.getByText(/IBKR could not deliver the statement yet/)).toBeTruthy();
  });
});
```

`apps/web/src/features/broker/components/status-card.tsx`:

```tsx
import { AlertTriangle, CheckCircle2, Clock, Loader2, PlugZap } from "lucide-react";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatSessionDate, formatSofia } from "@/lib/format";
import type { BrokerConnection, BrokerRun } from "../broker-api";
import { type StatusIcon, describeConnection, runActive, tokenExpiry } from "../broker-view";
import { ErrorHint } from "./error-hint";
import { SectionChecklist } from "./section-checklist";

const ICONS: Record<StatusIcon, typeof Clock> = { "plug-off": PlugZap, check: CheckCircle2, alert: AlertTriangle, clock: Clock, loader: Loader2 };

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex justify-between gap-4 border-b py-1 last:border-0">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right">{children}</dd>
    </div>
  );
}

export function StatusCard({ connection, run, now }: { connection: BrokerConnection | null; run: BrokerRun | null; now: Date }) {
  const d = describeConnection(connection, run);
  const Icon = ICONS[d.icon];
  const expiry = connection === null ? null : tokenExpiry(connection.token_expires_on, now);
  const linkedLike = connection !== null && connection.status !== "unlinked";
  const sections = run?.rows_summary.sections;
  const showError = connection !== null && connection.last_error_code !== null;

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-2">
        <CardTitle>Connection status</CardTitle>
        <Badge variant="outline" className="gap-1">
          <Icon aria-hidden="true" size={14} className={d.icon === "loader" || runActive(run) ? "animate-spin motion-reduce:animate-none" : ""} />
          {d.label}
        </Badge>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {d.detail !== null ? <p role="status">{d.detail}</p> : null}
        {expiry !== null ? (
          <p role="alert" className="rounded border px-2 py-1">
            {expiry.kind === "soon"
              ? `Your Flex token expires in ${expiry.days} day${expiry.days === 1 ? "" : "s"}. Create a new token in Client Portal and link again before then.`
              : `Your Flex token expired ${expiry.days === 0 ? "today" : `${expiry.days} day${expiry.days === 1 ? "" : "s"} ago`}. Create a new token and link again.`}
          </p>
        ) : null}
        {linkedLike && connection !== null ? (
          <dl>
            <Row label="Account">{connection.account_id_masked ?? "pending"}</Row>
            <Row label="Base currency">{connection.base_currency ?? "pending"}</Row>
            <Row label="Last verified">{connection.last_verified_at === null ? "never" : formatSofia(connection.last_verified_at)}</Row>
            <Row label="Last sync">{connection.last_sync_at === null ? "never" : formatSofia(connection.last_sync_at)}</Row>
            <Row label="Last statement date">{connection.last_statement_date === null ? "none yet" : formatSessionDate(connection.last_statement_date)}</Row>
          </dl>
        ) : null}
        {linkedLike && connection?.coverage_from ? (
          <p className="text-muted-foreground">{`History loaded from ${formatSessionDate(connection.coverage_from)}: earlier activity is not included.`}</p>
        ) : null}
        {showError && connection !== null ? (
          <div className="space-y-2 rounded border p-2">
            <ErrorHint code={connection.last_error_code} />
            {connection.last_error_at !== null ? <p className="text-xs text-muted-foreground">{`Last error: ${formatSofia(connection.last_error_at)}`}</p> : null}
          </div>
        ) : null}
        {sections !== undefined && sections.length > 0 && run?.state === "failed" ? <SectionChecklist sections={sections} /> : null}
      </CardContent>
    </Card>
  );
}
```

`apps/web/src/features/broker/components/link-form.test.tsx`:

```tsx
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LinkForm } from "./link-form";

const TOKEN = "987654321012345678901234";

function fill(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}
function submit() {
  const form = screen.getByRole("button", { name: /^Link/ }).closest("form");
  if (form === null) throw new Error("no form");
  fireEvent.submit(form);
}
function fillAll() {
  fill("Flex token", TOKEN);
  fill("Query ID", "123456");
  fill("Token expiry date", "2027-06-01");
}

afterEach(() => vi.restoreAllMocks());

describe("LinkForm", () => {
  it("the token field is a password field, autocomplete off, and never prefilled", () => {
    render(<LinkForm pending={false} onSubmit={vi.fn()} fieldError={null} now={new Date("2026-10-15T08:00:00Z")} />);
    const token = screen.getByLabelText("Flex token") as HTMLInputElement;
    expect([token.type, token.autocomplete, token.value]).toEqual(["password", "off", ""]);
  });

  it("submits the three values and clears the token right after the submit", async () => {
    const onSubmit = vi.fn().mockResolvedValue({ ok: true });
    render(<LinkForm pending={false} onSubmit={onSubmit} fieldError={null} now={new Date("2026-10-15T08:00:00Z")} />);
    fillAll();
    submit();
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith({ token: TOKEN, queryId: "123456", tokenExpiresOn: "2027-06-01" }));
    await waitFor(() => expect((screen.getByLabelText("Flex token") as HTMLInputElement).value).toBe(""));
  });

  it("never writes the token to localStorage, sessionStorage or the document", async () => {
    const local = vi.spyOn(Storage.prototype, "setItem");
    const onSubmit = vi.fn().mockResolvedValue({ ok: true });
    render(<LinkForm pending={false} onSubmit={onSubmit} fieldError={null} now={new Date("2026-10-15T08:00:00Z")} />);
    fillAll();
    submit();
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(local).not.toHaveBeenCalled();
    expect(document.body.innerHTML).not.toContain(TOKEN);
  });

  it("client-side checks name the field and do not call the server", () => {
    const onSubmit = vi.fn();
    render(<LinkForm pending={false} onSubmit={onSubmit} fieldError={null} now={new Date("2026-10-15T08:00:00Z")} />);
    fill("Flex token", "short");
    fill("Query ID", "abc");
    fill("Token expiry date", "2026-10-01");
    submit();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText("Enter the token exactly as shown by IBKR.")).toBeTruthy();
    expect(screen.getByText("The Query ID is a number of 3 to 12 digits.")).toBeTruthy();
    expect(screen.getByText("The token expiry date must be in the future.")).toBeTruthy();
  });

  it("a server field error is shown next to the field and the typed values are kept for that field error", async () => {
    const onSubmit = vi.fn().mockResolvedValue({ ok: false, kind: "invalid_input", field: "queryId", message: "The Query ID is a number of 3 to 12 digits." });
    const { rerender } = render(<LinkForm pending={false} onSubmit={onSubmit} fieldError={null} now={new Date("2026-10-15T08:00:00Z")} />);
    fillAll();
    submit();
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    rerender(<LinkForm pending={false} onSubmit={onSubmit} fieldError={{ field: "queryId", message: "The Query ID is a number of 3 to 12 digits." }} now={new Date("2026-10-15T08:00:00Z")} />);
    expect(screen.getByText("The Query ID is a number of 3 to 12 digits.")).toBeTruthy();
    expect((screen.getByLabelText("Query ID") as HTMLInputElement).value).toBe("123456");
  });

  it("while pending the button says so and cannot be pressed twice", () => {
    render(<LinkForm pending onSubmit={vi.fn()} fieldError={null} now={new Date("2026-10-15T08:00:00Z")} />);
    const button = screen.getByRole("button", { name: /Linking/ }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.getByText(/this can take up to a minute/)).toBeTruthy();
  });
});
```

`apps/web/src/features/broker/components/link-form.tsx`:

```tsx
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { ActionResult, LinkInput } from "../broker-api";

export interface LinkFormProps {
  pending: boolean;
  onSubmit(input: LinkInput): Promise<ActionResult | undefined> | void;
  fieldError: { field: string; message: string } | null;
  now: Date;
}

const isoDay = (d: Date, plusDays = 0) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + plusDays)).toISOString().slice(0, 10);

function check(values: LinkInput, now: Date): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!/^[A-Za-z0-9._-]{8,200}$/.test(values.token)) errors["token"] = "Enter the token exactly as shown by IBKR.";
  if (!/^\d{3,12}$/.test(values.queryId)) errors["queryId"] = "The Query ID is a number of 3 to 12 digits.";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(values.tokenExpiresOn) || values.tokenExpiresOn <= isoDay(now)) errors["tokenExpiresOn"] = "The token expiry date must be in the future.";
  else if (values.tokenExpiresOn > isoDay(now, 366)) errors["tokenExpiresOn"] = "IBKR tokens last at most one year.";
  return errors;
}

/** The token goes from this input to the broker-sync function over HTTPS and nowhere else: no storage, cleared right after submit. */
export function LinkForm({ pending, onSubmit, fieldError, now }: LinkFormProps) {
  const [token, setToken] = useState("");
  const [queryId, setQueryId] = useState("");
  const [expires, setExpires] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const shown = { ...errors, ...(fieldError === null ? {} : { [fieldError.field]: fieldError.message }) };

  return (
    <form
      className="space-y-3"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        const values = { token: token.trim(), queryId: queryId.trim(), tokenExpiresOn: expires };
        const found = check(values, now);
        setErrors(found);
        if (Object.keys(found).length > 0) return;
        setToken("");
        void Promise.resolve(onSubmit(values)).catch(() => undefined);
      }}
    >
      <div className="space-y-1">
        <Label htmlFor="flex-token">Flex token</Label>
        <Input id="flex-token" name="flex-token" type="password" autoComplete="off" spellCheck={false} value={token} onChange={(e) => setToken(e.target.value)} aria-invalid={shown["token"] !== undefined} aria-describedby={shown["token"] ? "flex-token-error" : undefined} />
        {shown["token"] ? <p id="flex-token-error" role="alert" className="text-sm">{shown["token"]}</p> : null}
      </div>
      <div className="space-y-1">
        <Label htmlFor="flex-query">Query ID</Label>
        <Input id="flex-query" name="flex-query" inputMode="numeric" autoComplete="off" value={queryId} onChange={(e) => setQueryId(e.target.value)} aria-invalid={shown["queryId"] !== undefined} />
        {shown["queryId"] ? <p role="alert" className="text-sm">{shown["queryId"]}</p> : null}
      </div>
      <div className="space-y-1">
        <Label htmlFor="flex-expiry">Token expiry date</Label>
        <Input id="flex-expiry" name="flex-expiry" type="date" min={isoDay(now, 1)} max={isoDay(now, 366)} value={expires} onChange={(e) => setExpires(e.target.value)} aria-invalid={shown["tokenExpiresOn"] !== undefined} />
        {shown["tokenExpiresOn"] ? <p role="alert" className="text-sm">{shown["tokenExpiresOn"]}</p> : null}
      </div>
      <Button type="submit" disabled={pending}>
        {pending ? "Linking..." : "Link"}
      </Button>
      {pending ? <p role="status" className="text-sm text-muted-foreground">Verifying with IBKR: this can take up to a minute.</p> : null}
    </form>
  );
}
```

Note on the test "a server field error ... typed values are kept": the form clears the **token** on every valid submit (the secret never lingers); the Query ID and the expiry date stay.

`apps/web/src/features/broker/components/unlink-dialog.test.tsx`:

```tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { UnlinkDialog } from "./unlink-dialog";

describe("UnlinkDialog", () => {
  it("explains what happens, tells the user to revoke the token at IBKR and keeps data deletion off by default", () => {
    render(<UnlinkDialog open onOpenChange={vi.fn()} onConfirm={vi.fn()} pending={false} />);
    expect(screen.getByText(/revoke the token in IBKR/i)).toBeTruthy();
    expect(screen.getByText(/the app cannot revoke it/i)).toBeTruthy();
    const box = screen.getByLabelText("Also delete my synced broker data") as HTMLInputElement;
    expect(box.checked).toBe(false);
  });

  it("confirm passes the checkbox value; cancel does nothing", () => {
    const onConfirm = vi.fn();
    const onOpenChange = vi.fn();
    render(<UnlinkDialog open onOpenChange={onOpenChange} onConfirm={onConfirm} pending={false} />);
    fireEvent.click(screen.getByLabelText("Also delete my synced broker data"));
    fireEvent.click(screen.getByRole("button", { name: "Unlink" }));
    expect(onConfirm).toHaveBeenCalledWith({ deleteData: true });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("is not rendered when closed and cannot be confirmed twice while pending", () => {
    const { rerender } = render(<UnlinkDialog open={false} onOpenChange={vi.fn()} onConfirm={vi.fn()} pending={false} />);
    expect(screen.queryByText(/revoke the token/i)).toBeNull();
    rerender(<UnlinkDialog open onOpenChange={vi.fn()} onConfirm={vi.fn()} pending />);
    expect((screen.getByRole("button", { name: /Unlinking/ }) as HTMLButtonElement).disabled).toBe(true);
  });
});
```

`apps/web/src/features/broker/components/unlink-dialog.tsx`:

```tsx
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export function UnlinkDialog({
  open,
  onOpenChange,
  onConfirm,
  pending,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  onConfirm(o: { deleteData: boolean }): void;
  pending: boolean;
}) {
  const [deleteData, setDeleteData] = useState(false);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Unlink your IBKR account?</DialogTitle>
          <DialogDescription>
            The app deletes the stored token and the Query ID and stops syncing. Your positions, trades and analytics stay unless you tick the box below.
          </DialogDescription>
        </DialogHeader>
        <p className="text-sm">
          Please revoke the token in IBKR (Client Portal, Flex Web Service Configuration: disable the service or generate a new token): the app cannot revoke it, because IBKR documents no revocation API.
        </p>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={deleteData} onChange={(e) => setDeleteData(e.target.checked)} />
          Also delete my synced broker data
        </label>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" variant="destructive" disabled={pending} onClick={() => onConfirm({ deleteData })}>
            {pending ? "Unlinking..." : "Unlink"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

`apps/web/src/features/broker/components/setup-guide.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FLEX_SECTIONS, LIMITS, REQUIREMENTS, SETUP_STEPS } from "../setup-content";
import { SetupGuide } from "./setup-guide";

describe("SetupGuide", () => {
  it("lists every setup step in order", () => {
    render(<SetupGuide />);
    const items = screen.getAllByRole("listitem").map((li) => li.textContent ?? "");
    for (const step of SETUP_STEPS) expect(items.some((t) => t.includes(step.slice(0, 40)))).toBe(true);
  });

  it("names the Flex query settings: XML, 365 days, yyyyMMdd, no IP restriction", () => {
    render(<SetupGuide />);
    expect(screen.getByText(/Format XML, Period Last 365 Calendar Days/)).toBeTruthy();
    expect(screen.getByText(/Do not set an IP restriction/)).toBeTruthy();
  });

  it("lists every Flex section of the checklist and the Closed Lots warning", () => {
    render(<SetupGuide />);
    for (const s of FLEX_SECTIONS) expect(screen.getByText(s.section)).toBeTruthy();
    expect(screen.getByText(/Select both levels of detail/)).toBeTruthy();
  });

  it("states the requirements and what the integration cannot do (T+1, no orders)", () => {
    render(<SetupGuide />);
    for (const line of [...REQUIREMENTS, ...LIMITS]) expect(screen.getByText(line)).toBeTruthy();
    expect(screen.getByText(/T\+1/)).toBeTruthy();
  });
});
```

`apps/web/src/features/broker/components/setup-guide.tsx`:

```tsx
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { FLEX_SECTIONS, LIMITS, REQUIREMENTS, SETUP_STEPS } from "../setup-content";

export function SetupGuide() {
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>How to set up IBKR Flex</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          <ol className="list-decimal space-y-2 pl-5">
            {SETUP_STEPS.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ol>
          <details>
            <summary className="cursor-pointer font-medium">Sections and fields to include in the query</summary>
            <div className="mt-2 space-y-3">
              {FLEX_SECTIONS.map((s) => (
                <div key={s.section}>
                  <h4 className="font-medium">{s.section}</h4>
                  <p className="text-muted-foreground">{s.fields.join(", ")}</p>
                  {s.note ? <p>{s.note}</p> : null}
                </div>
              ))}
            </div>
          </details>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Requirements</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="list-disc space-y-1 pl-5 text-sm">
            {REQUIREMENTS.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>What this cannot do</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="list-disc space-y-1 pl-5 text-sm">
            {LIMITS.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
```

Run (all component tests exist but `BrokerSection` is not written yet): `bun run test:web features/broker/components`
Expected: FAIL first (modules not found), PASS once each component file above is written next to its test.

- [ ] **Step 4: Hooks**

`apps/web/src/features/broker/use-broker.ts`:

```ts
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { BrokerSnapshot, LinkInput } from "./broker-api";
import { runActive } from "./broker-view";
import { brokerApi } from "./default";

export const BROKER_KEY = ["broker", "status"] as const;

/** Table reads under RLS (safe columns only). Polls every 5 s ONLY while a sync run is active (spec 14.2). */
export function useBrokerSnapshot() {
  return useQuery<BrokerSnapshot>({
    queryKey: BROKER_KEY,
    queryFn: () => brokerApi.readSnapshot(),
    staleTime: 60_000,
    refetchInterval: (q) => (runActive(q.state.data?.run ?? null) ? 5000 : false),
  });
}

export function useBrokerActions() {
  const qc = useQueryClient();
  const settled = async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: BROKER_KEY }),
      qc.invalidateQueries({ queryKey: ["portfolio"] }),
      qc.invalidateQueries({ queryKey: ["analytics"] }),
    ]);
  };
  return {
    link: useMutation({ mutationFn: (input: LinkInput) => brokerApi.link(input), onSettled: settled }),
    test: useMutation({ mutationFn: () => brokerApi.test(), onSettled: settled }),
    sync: useMutation({ mutationFn: () => brokerApi.sync(), onSettled: settled }),
    unlink: useMutation({ mutationFn: (o: { deleteData: boolean }) => brokerApi.unlink(o), onSettled: settled }),
  };
}
```

- [ ] **Step 5: `BrokerSection` (integration test first)**

`apps/web/src/features/broker/broker-section.test.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionResult, BrokerConnection, BrokerRun, BrokerSnapshot } from "./broker-api";
import { BrokerSection } from "./broker-section";

const api = { readSnapshot: vi.fn(), link: vi.fn(), test: vi.fn(), sync: vi.fn(), unlink: vi.fn() };
vi.mock("./default", () => ({ brokerApi: { readSnapshot: (...a: unknown[]) => api.readSnapshot(...a), link: (...a: unknown[]) => api.link(...a), test: (...a: unknown[]) => api.test(...a), sync: (...a: unknown[]) => api.sync(...a), unlink: (...a: unknown[]) => api.unlink(...a) } }));

const TOKEN = "987654321012345678901234";
const linked: BrokerConnection = {
  id: "c", status: "linked", token_expires_on: "2027-06-01", query_id: "123456", account_id_masked: "U***4567", base_currency: "EUR", account_type: "Individual",
  linked_at: "2026-10-01T00:00:00Z", last_verified_at: "2026-10-15T05:00:00Z", last_sync_at: "2026-10-15T05:01:00Z", last_statement_date: "2026-10-14",
  last_error_code: null, last_error_at: null, last_error_message: null, coverage_from: "2025-10-15",
};
const doneRun: BrokerRun = { id: "r", kind: "daily", state: "done", error_code: null, error_message: null, rows_summary: {} };
const snap = (connection: BrokerConnection | null, run: BrokerRun | null = null): BrokerSnapshot => ({ connection, run });

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <BrokerSection />
    </QueryClientProvider>,
  );
}
const fill = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
function submitLink() {
  fill("Flex token", TOKEN);
  fill("Query ID", "123456");
  fill("Token expiry date", "2027-06-01");
  const form = screen.getByRole("button", { name: /^Link/ }).closest("form");
  if (form === null) throw new Error("no form");
  fireEvent.submit(form);
}

beforeEach(() => {
  for (const f of Object.values(api)) f.mockReset();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-15T08:00:00Z"));
});
afterEach(() => vi.useRealTimers());

describe("BrokerSection", () => {
  it("shows the supported method, requirements, setup guide and the link form when nothing is linked", async () => {
    api.readSnapshot.mockResolvedValue(snap(null));
    mount();
    expect(await screen.findByText("IBKR Flex Web Service, read-only")).toBeTruthy();
    expect(await screen.findByText("Not linked")).toBeTruthy();
    expect(screen.getByLabelText("Flex token")).toBeTruthy();
    expect(screen.getByText("How to set up IBKR Flex")).toBeTruthy();
    expect(screen.getByText("What this cannot do")).toBeTruthy();
    expect(screen.getByText(/recorded in the audit log/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Sync now" })).toBeNull();
  });

  it("link: sends the values once, clears the token, refreshes the status to Linked", async () => {
    api.readSnapshot.mockResolvedValueOnce(snap(null)).mockResolvedValue(snap(linked, doneRun));
    api.link.mockResolvedValue({ ok: true, connection: linked, run: doneRun } satisfies ActionResult);
    mount();
    await screen.findByText("Not linked");
    submitLink();
    await waitFor(() => expect(api.link).toHaveBeenCalledWith({ token: TOKEN, queryId: "123456", tokenExpiresOn: "2027-06-01" }));
    expect(await screen.findByText("Linked")).toBeTruthy();
    expect(api.link).toHaveBeenCalledTimes(1);
    expect(document.body.innerHTML).not.toContain(TOKEN);
  });

  it("link rejected by IBKR (1015): the status turns to error with the token hint, the token is gone from the form", async () => {
    const bad: BrokerConnection = { ...linked, status: "error", last_error_code: 1015, last_error_at: "2026-10-15T08:00:10Z" };
    api.readSnapshot.mockResolvedValueOnce(snap(null)).mockResolvedValue(snap(bad, { ...doneRun, kind: "verify", state: "failed", error_code: 1015 }));
    api.link.mockResolvedValue({ ok: true, connection: bad, run: { ...doneRun, state: "failed", error_code: 1015 } } satisfies ActionResult);
    mount();
    await screen.findByText("Not linked");
    submitLink();
    expect(await screen.findByText("Needs attention")).toBeTruthy();
    expect(screen.getByText(/Copy the Current Token again/)).toBeTruthy();
    expect((screen.getByLabelText("Flex token") as HTMLInputElement).value).toBe("");
  });

  it("a server-side field error is shown at the field", async () => {
    api.readSnapshot.mockResolvedValue(snap(null));
    api.link.mockResolvedValue({ ok: false, kind: "invalid_input", field: "tokenExpiresOn", message: "IBKR tokens last at most one year." } satisfies ActionResult);
    mount();
    await screen.findByText("Not linked");
    submitLink();
    expect(await screen.findByText("IBKR tokens last at most one year.")).toBeTruthy();
  });

  it("linked: status details, Test connection, Sync now and the cooldown message", async () => {
    api.readSnapshot.mockResolvedValue(snap(linked, doneRun));
    api.test.mockResolvedValue({ ok: true, connection: linked, run: doneRun } satisfies ActionResult);
    api.sync.mockResolvedValue({ ok: false, kind: "cooldown", retryAfterSeconds: 421 } satisfies ActionResult);
    mount();
    expect(await screen.findByText("U***4567")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    await waitFor(() => expect(api.test).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Sync now" }));
    expect(await screen.findByText(/Manual sync is limited to once every 10 minutes/)).toBeTruthy();
    expect(screen.getByText(/Try again in 8 minutes/)).toBeTruthy();
  });

  it("while a sync runs the buttons are disabled and the step is shown", async () => {
    api.readSnapshot.mockResolvedValue(snap(linked, { ...doneRun, state: "polling" }));
    mount();
    expect(await screen.findByText("Waiting for IBKR to generate the statement")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Sync now" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Test connection" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("unlink asks for confirmation, then unlinks with the delete choice", async () => {
    api.readSnapshot.mockResolvedValueOnce(snap(linked, doneRun)).mockResolvedValue(snap({ ...linked, status: "unlinked" }));
    api.unlink.mockResolvedValue({ ok: true, connection: { ...linked, status: "unlinked" }, run: null } satisfies ActionResult);
    mount();
    await screen.findByText("Linked");
    fireEvent.click(screen.getByRole("button", { name: "Unlink" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByLabelText("Also delete my synced broker data"));
    fireEvent.click(within(dialog).getByRole("button", { name: "Unlink" }));
    await waitFor(() => expect(api.unlink).toHaveBeenCalledWith({ deleteData: true }));
    expect(await screen.findByText("Not linked")).toBeTruthy();
  });

  it("a failed status read shows an error with Retry, never a blank", async () => {
    api.readSnapshot.mockRejectedValueOnce(new Error("Could not load the broker connection.")).mockResolvedValue(snap(null));
    mount();
    expect(await screen.findByText("Could not load the broker connection.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Not linked")).toBeTruthy();
  });
});
```

`apps/web/src/features/broker/broker-section.tsx`:

```tsx
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ErrorState, Loading } from "@/components/data-state/data-state";
import type { ActionResult } from "./broker-api";
import { runActive } from "./broker-view";
import { LinkForm } from "./components/link-form";
import { SetupGuide } from "./components/setup-guide";
import { StatusCard } from "./components/status-card";
import { UnlinkDialog } from "./components/unlink-dialog";
import { useBrokerActions, useBrokerSnapshot } from "./use-broker";

function cooldownMessage(seconds: number): string {
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  return `Manual sync is limited to once every 10 minutes. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`;
}

function message(result: ActionResult | undefined): string | null {
  if (result === undefined || result.ok) return null;
  switch (result.kind) {
    case "cooldown": return cooldownMessage(result.retryAfterSeconds);
    case "busy": return "A sync is already running. Wait for it to finish.";
    case "not_linked": return "No broker is linked.";
    case "failed": return result.message;
    case "invalid_input": return null;
  }
}

export function BrokerSection() {
  const snapshot = useBrokerSnapshot();
  const actions = useBrokerActions();
  const [confirming, setConfirming] = useState(false);
  const [now] = useState(() => new Date());

  if (snapshot.isLoading) return <Loading label="Loading broker status" rows={4} />;
  if (snapshot.isError || snapshot.data === undefined) {
    return <ErrorState message="Could not load the broker connection." onRetry={() => void snapshot.refetch()} />;
  }
  const { connection, run } = snapshot.data;
  const linked = connection !== null && connection.status !== "unlinked";
  const busy = runActive(run) || actions.link.isPending || actions.test.isPending || actions.sync.isPending;
  const linkResult = actions.link.data;
  const fieldError = linkResult !== undefined && !linkResult.ok && linkResult.kind === "invalid_input" ? { field: linkResult.field, message: linkResult.message } : null;
  const notice = message(actions.sync.data) ?? message(actions.test.data) ?? message(actions.link.data) ?? message(actions.unlink.data);

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Supported method</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1 text-sm">
          <p className="font-medium">IBKR Flex Web Service, read-only</p>
          <p className="text-muted-foreground">
            Linking and unlinking are recorded in the audit log (never with the token). The token is encrypted on the server and is never shown again.
          </p>
        </CardContent>
      </Card>

      <StatusCard connection={connection} run={run} now={now} />

      {notice !== null ? (
        <p role="alert" className="rounded border px-3 py-2 text-sm">
          {notice}
        </p>
      ) : null}

      {linked ? (
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" disabled={busy} onClick={() => actions.test.mutate()}>
            Test connection
          </Button>
          <Button type="button" variant="outline" disabled={busy} onClick={() => actions.sync.mutate()}>
            Sync now
          </Button>
          <Button type="button" variant="destructive" disabled={actions.unlink.isPending} onClick={() => setConfirming(true)}>
            Unlink
          </Button>
        </div>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>{linked ? "Replace the token" : "Link your account"}</CardTitle>
        </CardHeader>
        <CardContent>
          <LinkForm pending={actions.link.isPending} onSubmit={(input) => actions.link.mutateAsync(input)} fieldError={fieldError} now={now} />
        </CardContent>
      </Card>

      <SetupGuide />

      <UnlinkDialog
        open={confirming}
        onOpenChange={setConfirming}
        pending={actions.unlink.isPending}
        onConfirm={(o) => actions.unlink.mutate(o, { onSettled: () => setConfirming(false) })}
      />
    </div>
  );
}
```

`apps/web/src/features/profile/panels/broker-panel.tsx` (replace the whole file; P5a: "P5b replaces the body of this file only"):

```tsx
import { BrokerSection } from "@/features/broker/broker-section";

export function BrokerPanel() {
  return <BrokerSection />;
}
```

In `apps/web/src/features/profile/profile-panels.test.tsx` (P5a) replace the test "renders the Broker heading and the replaceable placeholder card" so it no longer expects `Broker linking arrives with the Flex integration.`; add at the top of that file `vi.mock("@/features/broker/default", () => ({ brokerApi: { readSnapshot: () => Promise.resolve({ connection: null, run: null }), link: vi.fn(), test: vi.fn(), sync: vi.fn(), unlink: vi.fn() } }));` and assert `await screen.findByText("IBKR Flex Web Service, read-only")` after the heading assertion.

Run: `bun run test:web features/broker features/profile`
Expected: PASS (every broker suite; the profile suites are unchanged except the replaced assertion).

- [ ] **Step 6: Lint, typecheck, commit**

Run: `bun run lint:fix`, `bun run lint`, `bun run typecheck`, `bun run test:web`
Expected: exit 0.

```text
git add apps/web/src/features/broker apps/web/src/features/profile
git commit -m "feat(web): add Profile Broker page with setup guide, link form, status card, test, sync and unlink"
```

---

## Task 7: Portfolio page (`/portfolio`)

**Concurrency:** starts after Task 5 (data, hooks, `RefreshBar`, `MoneyText`). May run at the same time as Tasks 6 and 8 (disjoint files). Its final wiring step edits `features/pages.tsx` and `router.tsx`; Task 8's wiring step must come after this one.

**REQUIRED before Step 3 (components):** the implementer MUST load `frontend-design:frontend-design` and `ui-ux-pro-max:ui-ux-pro-max`. The code below is a working baseline; the skills may refine density, spacing and the visual weight of the summary. Fixed constraints: every heading, column label, tag text and sentence used by the tests; shadcn and P0 tokens only; status never by colour alone; below `md` each row becomes a card that exposes **all** fields (spec 14.9); numeric cells are right-aligned with tabular figures.

**Files:**
- Create: `apps/web/src/features/portfolio/page/{sort,positions-table,summary-row,trade-history,trades-api,trades-default,use-trades,portfolio-page,test-fixtures}.ts(x)` with tests `sort.test.ts`, `positions-table.test.tsx`, `summary-row.test.tsx`, `trades-api.test.ts`, `trade-history.test.tsx`, `portfolio-page.test.tsx`
- Modify (final wiring step): `apps/web/src/features/pages.tsx`, `apps/web/src/router.tsx`

**Interfaces:**
- Consumes: Task 5 (`usePortfolio`, `RefreshBar`, `MoneyText`, `formatAmount`, `NotLinkedError`, `PortfolioView`/`PositionView`/`PortfolioTotals`), P4 (`ValuationTag`, `Loading`, `ErrorState`, `EmptyState`, `Popover`, `formatSofia`, `formatSessionDate`), P5a (`renderApp`, `signedIn` test helpers, guarded route), Task 1 (RLS read of `broker_trades`).
- Produces: `PortfolioPage`, `PositionsTable`, `SummaryCard`, `SummaryTableRow`, `TradeHistory`, `sortPositions`, `DEFAULT_SORT`.

- [ ] **Step 1: Sorting (pure), tests first**

`apps/web/src/features/portfolio/page/test-fixtures.ts` (test support, imported by the tests of Tasks 7 and 8):

```ts
import type { Money } from "@core/accounting.ts";
import type { PortfolioTotals, PortfolioView, PositionView } from "@core/portfolio-view.ts";
import type { ClientPortfolio } from "../portfolio-api";

export const ok = (value: number, ccy: string): Money => ({ kind: "ok", value, ccy });
export const na = (reason: string): Money => ({ kind: "unavailable", reason });

export function makeRow(o: Partial<PositionView> = {}): PositionView {
  return {
    id: 1, conid: 100001, ticker: "AAPL", name: "APPLE INC", assetClass: "STK", currency: "USD", quantity: 10, multiplier: 1,
    price: { value: 232, ccy: "USD", source: { kind: "delayed_quote", asOfMs: Date.UTC(2026, 9, 15, 6, 59), marketState: "REGULAR", fetchedAtMs: Date.UTC(2026, 9, 15, 7, 0) }, note: null },
    quoteTime: "2026-10-15T06:59:00.000Z", costBasis: ok(2001.7, "USD"), marketValue: ok(2320, "USD"), averageCost: 200.17, dailyPnl: ok(22.97, "USD"),
    unrealizedIndependent: ok(318.3, "USD"), unrealizedBroker: 298.3, reconciles: true, valueBase: ok(2157.6, "EUR"), costBase: ok(1861.58, "EUR"),
    unrealizedBase: ok(296.02, "EUR"), dailyBase: ok(21.36, "EUR"), fxSource: "yahoo", fxDate: "2026-10-15", tag: "none", tagBasis: "based on close of 2026-10-14",
    matchStatus: "matched_isin", ...o,
  };
}

export const SHEL = (o: Partial<PositionView> = {}): PositionView =>
  makeRow({
    id: 2, conid: 100002, ticker: "SHEL", name: "SHELL PLC", currency: "GBP", quantity: 100, price: { value: 24.31, ccy: "GBP", source: { kind: "statement_close", reportDate: "2026-10-14", reason: "no delayed quote" }, note: null },
    quoteTime: null, costBasis: ok(2500, "GBP"), marketValue: ok(2431, "GBP"), averageCost: 25, dailyPnl: na("Daily change needs a delayed quote"),
    unrealizedIndependent: ok(-69, "GBP"), unrealizedBroker: -69, valueBase: ok(2819.96, "EUR"), costBase: ok(2900, "EUR"), unrealizedBase: ok(-80.04, "EUR"),
    dailyBase: na("Daily change needs a delayed quote"), tag: "extra_premium", ...o,
  });

export const NOPX = (o: Partial<PositionView> = {}): PositionView =>
  makeRow({
    id: 3, conid: 100003, ticker: "NOPX", name: "NO PRICE CORP", price: { value: null, ccy: "USD", source: { kind: "unavailable", reason: "no delayed quote" }, note: null },
    quoteTime: null, costBasis: na("Cost basis missing in the statement"), marketValue: na("no delayed quote"), averageCost: null, dailyPnl: na("Daily change needs a delayed quote"),
    unrealizedIndependent: na("Cost basis missing in the statement"), unrealizedBroker: null, reconciles: null, valueBase: na("no delayed quote"), costBase: na("Cost basis missing in the statement"),
    unrealizedBase: na("Cost basis missing in the statement"), dailyBase: na("Daily change needs a delayed quote"), fxSource: "unavailable", fxDate: null, tag: "unavailable", tagBasis: "no Yahoo match", ...o,
  });

export function makeTotals(o: Partial<PortfolioTotals> = {}): PortfolioTotals {
  return {
    costBase: ok(1861.58 + 2900, "EUR"), valueBase: ok(2157.6 + 2819.96, "EUR"), unrealizedBase: ok(296.02 - 80.04, "EUR"), dailyBase: ok(21.36, "EUR"),
    included: 2, excluded: [{ symbol: "NOPX", reason: "Cost basis missing in the statement" }], dailyExcluded: 1, ...o,
  };
}

export function makeView(rows: PositionView[] = [makeRow(), SHEL(), NOPX()], o: Partial<PortfolioView> = {}): PortfolioView {
  return {
    baseCurrency: "EUR", reportDate: "2026-10-14", positions: rows, totals: makeTotals(),
    perCurrency: [
      { ccy: "GBP", count: 1, excluded: 0, cost: ok(2500, "GBP"), value: ok(2431, "GBP"), unrealized: ok(-69, "GBP"), daily: na("Daily change needs a delayed quote") },
      { ccy: "USD", count: 1, excluded: 1, cost: ok(2001.7, "USD"), value: ok(2320, "USD"), unrealized: ok(318.3, "USD"), daily: ok(22.97, "USD") },
    ],
    quotesFetchedAt: "2026-10-15T07:00:00.000Z", ...o,
  };
}

export function makeResponse(o: Partial<ClientPortfolio> = {}): ClientPortfolio {
  const now = Date.UTC(2026, 9, 15, 7, 0, 0);
  return {
    serverTime: new Date(now).toISOString(), nextAutoRefreshAt: new Date(now + 300_000).toISOString(), manualAvailableAt: new Date(now).toISOString(),
    lastSuccessfulAt: "2026-10-15T07:00:00.000Z", baseCurrency: "EUR", reportDate: "2026-10-14", lastStatementDate: "2026-10-14",
    statement: { expectedDate: "2026-10-14", freshness: { kind: "current" } }, syncQueued: false, quoteError: null, view: makeView(), receivedAtMs: now, ...o,
  };
}
```

`apps/web/src/features/portfolio/page/sort.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { DEFAULT_SORT, sortPositions } from "./sort";
import { NOPX, SHEL, makeRow, na, ok } from "./test-fixtures";

const AAPL = makeRow();
const tickers = (rows: { ticker: string }[]) => rows.map((r) => r.ticker);

describe("sortPositions", () => {
  it("the default is unrealized P&L ascending: the most negative first, unavailable last", () => {
    expect(DEFAULT_SORT).toEqual({ key: "unrealized", dir: "asc" });
    expect(tickers(sortPositions([AAPL, NOPX(), SHEL()], DEFAULT_SORT.key, DEFAULT_SORT.dir))).toEqual(["SHEL", "AAPL", "NOPX"]);
  });

  it("descending reverses the figures but unavailable stays last in both directions", () => {
    expect(tickers(sortPositions([SHEL(), NOPX(), AAPL], "unrealized", "desc"))).toEqual(["AAPL", "SHEL", "NOPX"]);
    expect(tickers(sortPositions([NOPX(), AAPL, SHEL()], "value", "asc")).at(-1)).toBe("NOPX");
    expect(tickers(sortPositions([NOPX(), AAPL, SHEL()], "value", "desc")).at(-1)).toBe("NOPX");
  });

  it("money columns sort by the base-currency figure, never by mixed native numbers", () => {
    // native: SHEL 2431 GBP > AAPL 2320 USD; in EUR: SHEL 2819.96 > AAPL 2157.6 (same order), then flip the rates
    const cheapGbp = SHEL({ valueBase: ok(1000, "EUR") });
    expect(tickers(sortPositions([AAPL, cheapGbp], "value", "asc"))).toEqual(["SHEL", "AAPL"]);
    expect(tickers(sortPositions([AAPL, cheapGbp], "value", "desc"))).toEqual(["AAPL", "SHEL"]);
  });

  it("ticker and name sort case-insensitively; quantity and price numerically", () => {
    const a = makeRow({ id: 5, ticker: "abc", name: "zeta", quantity: 5 });
    expect(tickers(sortPositions([SHEL(), a, AAPL], "ticker", "asc"))).toEqual(["AAPL", "abc", "SHEL"]);
    expect(tickers(sortPositions([SHEL(), a, AAPL], "name", "asc"))).toEqual(["AAPL", "SHEL", "abc"]);
    expect(tickers(sortPositions([SHEL(), a, AAPL], "quantity", "desc"))).toEqual(["SHEL", "AAPL", "abc"]);
    expect(tickers(sortPositions([NOPX(), AAPL, SHEL()], "price", "asc"))).toEqual(["SHEL", "AAPL", "NOPX"]);
  });

  it("tags sort Discounted, none, Premium, Extra premium; Unavailable is last in both directions", () => {
    const rows = [makeRow({ id: 1, ticker: "E", tag: "extra_premium" }), makeRow({ id: 2, ticker: "U", tag: "unavailable" }), makeRow({ id: 3, ticker: "D", tag: "discounted" }), makeRow({ id: 4, ticker: "P", tag: "premium" }), makeRow({ id: 5, ticker: "N", tag: "none" })];
    expect(tickers(sortPositions(rows, "tag", "asc"))).toEqual(["D", "N", "P", "E", "U"]);
    expect(tickers(sortPositions(rows, "tag", "desc"))).toEqual(["E", "P", "N", "D", "U"]);
  });

  it("equal values keep a stable order by ticker, and the input is not mutated", () => {
    const a = makeRow({ id: 1, ticker: "B", dailyPnl: ok(1, "USD"), dailyBase: ok(1, "EUR") });
    const b = makeRow({ id: 2, ticker: "A", dailyPnl: ok(1, "USD"), dailyBase: ok(1, "EUR") });
    const input = [a, b];
    expect(tickers(sortPositions(input, "daily", "asc"))).toEqual(["A", "B"]);
    expect(tickers(input)).toEqual(["B", "A"]);
    expect(tickers(sortPositions([makeRow({ ticker: "Z", dailyBase: na("x") }), makeRow({ id: 9, ticker: "Y", dailyBase: na("y") })], "daily", "asc"))).toEqual(["Y", "Z"]);
  });
});
```

`apps/web/src/features/portfolio/page/sort.ts`:

```ts
import type { Money } from "@core/accounting.ts";
import type { PositionView, ValuationTag } from "@core/portfolio-view.ts";

export type SortKey = "ticker" | "name" | "price" | "quantity" | "cost" | "value" | "avgCost" | "daily" | "unrealized" | "tag";
export type SortDir = "asc" | "desc";
export interface SortState {
  key: SortKey;
  dir: SortDir;
}

/** Default sort of the brief: unrealized P&L ascending, the most negative first. */
export const DEFAULT_SORT: SortState = { key: "unrealized", dir: "asc" };

export const SORT_LABELS: Record<SortKey, string> = {
  ticker: "Ticker",
  name: "Name",
  price: "Price",
  quantity: "Quantity",
  cost: "Cost basis",
  value: "Market value",
  avgCost: "Average cost per unit",
  daily: "Daily P&L (estimated)",
  unrealized: "Unrealized P&L",
  tag: "Valuation tag",
};

const TAG_RANK: Record<ValuationTag, number | null> = { discounted: 0, none: 1, premium: 2, extra_premium: 3, unavailable: null };
const num = (m: Money): number | null => (m.kind === "ok" ? m.value : null);

function valueOf(r: PositionView, key: SortKey): string | number | null {
  switch (key) {
    case "ticker": return r.ticker.toUpperCase();
    case "name": return (r.name ?? "").toUpperCase();
    case "price": return r.price.value;
    case "quantity": return r.quantity;
    case "avgCost": return r.averageCost;
    case "cost": return num(r.costBase);
    case "value": return num(r.valueBase);
    case "daily": return num(r.dailyBase);
    case "unrealized": return num(r.unrealizedBase);
    case "tag": return TAG_RANK[r.tag];
  }
}

const cmp = (a: string | number, b: string | number): number =>
  typeof a === "string" && typeof b === "string" ? (a < b ? -1 : a > b ? 1 : 0) : (a as number) - (b as number);

/** Unavailable values sort last in both directions; ties fall back to the ticker so the order is stable. */
export function sortPositions(rows: readonly PositionView[], key: SortKey, dir: SortDir): PositionView[] {
  const tie = (x: PositionView, y: PositionView) => cmp(x.ticker.toUpperCase(), y.ticker.toUpperCase());
  return [...rows].sort((x, y) => {
    const a = valueOf(x, key);
    const b = valueOf(y, key);
    if (a === null && b === null) return tie(x, y);
    if (a === null) return 1;
    if (b === null) return -1;
    const c = cmp(a, b);
    return c === 0 ? tie(x, y) : dir === "asc" ? c : -c;
  });
}
```

Run: `bun run test:web features/portfolio/page/sort`
Expected: PASS (6 tests).

- [ ] **Step 2: Summary row and positions table, tests first**

`apps/web/src/features/portfolio/page/summary-row.test.tsx`:

```tsx
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SummaryCard } from "./summary-row";
import { makeTotals, makeView, na, ok } from "./test-fixtures";

const view = makeView();

describe("SummaryCard", () => {
  it("shows total cost basis, market value, daily P&L and unrealized P&L in the base currency", () => {
    render(<SummaryCard totals={view.totals} perCurrency={view.perCurrency} base="EUR" />);
    const card = screen.getByRole("region", { name: "Portfolio summary" });
    expect(within(card).getByText("4,761.58 EUR")).toBeTruthy();
    expect(within(card).getByText("4,977.56 EUR")).toBeTruthy();
    expect(within(card).getByText("+21.36 EUR")).toBeTruthy();
    expect(within(card).getByText("+215.98 EUR")).toBeTruthy();
  });

  it("states the conversion basis and lists what was excluded from the totals", () => {
    render(<SummaryCard totals={view.totals} perCurrency={view.perCurrency} base="EUR" />);
    expect(screen.getByText(/Converted to EUR at current rates/)).toBeTruthy();
    expect(screen.getByText(/1 position is excluded from the totals: NOPX \(Cost basis missing in the statement\)/)).toBeTruthy();
    expect(screen.getByText(/Daily P&L leaves out 1 position without a delayed quote/)).toBeTruthy();
  });

  it("a per-currency breakdown popover shows each currency in its own unit, never a mixed sum", () => {
    render(<SummaryCard totals={view.totals} perCurrency={view.perCurrency} base="EUR" />);
    fireEvent.click(screen.getByRole("button", { name: "Per-currency breakdown" }));
    const panel = screen.getByRole("dialog", { name: "Per-currency breakdown" });
    expect(within(panel).getByText("GBP")).toBeTruthy();
    expect(within(panel).getByText("2,431.00 GBP")).toBeTruthy();
    expect(within(panel).getByText("USD")).toBeTruthy();
    expect(within(panel).getByText("2,320.00 USD")).toBeTruthy();
  });

  it("unavailable totals render a dash with the reason, never 0", () => {
    const totals = makeTotals({ valueBase: na("Missing FX rate USD->EUR"), costBase: na("Missing FX rate USD->EUR"), unrealizedBase: na("Missing FX rate USD->EUR"), dailyBase: na("Daily change unavailable"), excluded: [], dailyExcluded: 0 });
    render(<SummaryCard totals={totals} perCurrency={view.perCurrency} base="EUR" />);
    expect(screen.getAllByText("Unavailable: Missing FX rate USD->EUR").length).toBe(3);
    expect(screen.queryByText("0.00 EUR")).toBeNull();
  });

  it("an empty portfolio is a real zero", () => {
    render(<SummaryCard totals={makeTotals({ costBase: ok(0, "EUR"), valueBase: ok(0, "EUR"), unrealizedBase: ok(0, "EUR"), dailyBase: ok(0, "EUR"), included: 0, excluded: [], dailyExcluded: 0 })} perCurrency={[]} base="EUR" />);
    expect(screen.getAllByText("0.00 EUR").length).toBe(4);
  });
});
```

`apps/web/src/features/portfolio/page/summary-row.tsx`:

```tsx
import type { CurrencyBreakdown, PortfolioTotals } from "@core/portfolio-view.ts";
import type { ReactNode } from "react";
import { Popover } from "@/components/popover";
import { MoneyText } from "../money-text";

function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-base font-medium">{children}</dd>
    </div>
  );
}

function notes(totals: PortfolioTotals, base: string) {
  return (
    <div className="space-y-1 text-xs text-muted-foreground">
      <p>{`Converted to ${base} at current rates (Yahoo delayed FX; the statement rate where a position says so), so value minus cost equals the unrealized P&L.`}</p>
      {totals.excluded.length > 0 ? (
        <p>{`${totals.excluded.length} position${totals.excluded.length === 1 ? " is" : "s are"} excluded from the totals: ${totals.excluded.map((e) => `${e.symbol} (${e.reason})`).join(", ")}.`}</p>
      ) : null}
      {totals.dailyExcluded > 0 ? <p>{`Daily P&L leaves out ${totals.dailyExcluded} position${totals.dailyExcluded === 1 ? "" : "s"} without a delayed quote.`}</p> : null}
    </div>
  );
}

function Breakdown({ perCurrency }: { perCurrency: readonly CurrencyBreakdown[] }) {
  return (
    <Popover trigger={<span className="underline">Per-currency breakdown</span>} triggerLabel="Per-currency breakdown" panelLabel="Per-currency breakdown" panelClassName="w-96">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-left">
            <th scope="col">Currency</th>
            <th scope="col">Cost basis</th>
            <th scope="col">Market value</th>
            <th scope="col">Unrealized</th>
          </tr>
        </thead>
        <tbody>
          {perCurrency.map((c) => (
            <tr key={c.ccy}>
              <th scope="row" className="text-left font-normal">{c.ccy}</th>
              <td><MoneyText money={c.cost} /></td>
              <td><MoneyText money={c.value} /></td>
              <td><MoneyText money={c.unrealized} signed /></td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-2 text-xs text-muted-foreground">Each currency is shown in its own unit. Positions without a price or cost basis are left out of their row.</p>
    </Popover>
  );
}

/** Summary above the list (all breakpoints; on phones it replaces the table's summary row, spec 14.9). */
export function SummaryCard({ totals, perCurrency, base }: { totals: PortfolioTotals; perCurrency: readonly CurrencyBreakdown[]; base: string }) {
  return (
    <section aria-label="Portfolio summary" className="space-y-2 rounded-md border p-3">
      <dl className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Total cost basis"><MoneyText money={totals.costBase} /></Stat>
        <Stat label="Market value"><MoneyText money={totals.valueBase} /></Stat>
        <Stat label="Daily P&L (estimated)"><MoneyText money={totals.dailyBase} signed /></Stat>
        <Stat label="Unrealized P&L"><MoneyText money={totals.unrealizedBase} signed /></Stat>
      </dl>
      {notes(totals, base)}
      <Breakdown perCurrency={perCurrency} />
    </section>
  );
}

/** The same four figures as the final row of the desktop table. */
export function SummaryTableRow({ totals, base }: { totals: PortfolioTotals; base: string }) {
  return (
    <tr className="border-t-2 font-medium">
      <th scope="row" colSpan={4} className="px-2 py-2 text-left">{`Total in ${base}`}</th>
      <td className="px-2 py-2 text-right"><MoneyText money={totals.costBase} /></td>
      <td className="px-2 py-2 text-right"><MoneyText money={totals.valueBase} /></td>
      <td className="px-2 py-2" />
      <td className="px-2 py-2 text-right"><MoneyText money={totals.dailyBase} signed /></td>
      <td className="px-2 py-2 text-right"><MoneyText money={totals.unrealizedBase} signed /></td>
      <td className="px-2 py-2" />
    </tr>
  );
}
```

`apps/web/src/features/portfolio/page/positions-table.test.tsx`:

```tsx
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PositionsTable } from "./positions-table";
import { NOPX, SHEL, makeRow, makeView, ok } from "./test-fixtures";

const view = makeView();

function mount(rows = view.positions) {
  render(<PositionsTable rows={rows} totals={view.totals} perCurrency={view.perCurrency} base="EUR" />);
  return { table: screen.getByTestId("positions-table"), cards: screen.getByTestId("positions-cards") };
}
const order = (container: HTMLElement) => within(container).getAllByTestId("row-ticker").map((el) => el.textContent);

describe("PositionsTable", () => {
  it("default order is unrealized P&L ascending (most negative first) with unavailable last, and the header says so", () => {
    const { table } = mount();
    expect(order(table)).toEqual(["SHEL", "AAPL", "NOPX"]);
    const header = within(table).getByRole("columnheader", { name: /Unrealized P&L/ });
    expect(header.getAttribute("aria-sort")).toBe("ascending");
    expect(within(table).getByRole("columnheader", { name: /Ticker/ }).getAttribute("aria-sort")).toBe("none");
  });

  it("every column header sorts; a second click reverses; unavailable rows stay last", () => {
    const { table } = mount();
    const click = (name: RegExp) => fireEvent.click(within(table).getByRole("button", { name }));
    click(/Unrealized P&L/);
    expect(order(table)).toEqual(["AAPL", "SHEL", "NOPX"]);
    click(/Market value/);
    expect(order(table)).toEqual(["AAPL", "SHEL", "NOPX"]);
    click(/Market value/);
    expect(order(table)).toEqual(["SHEL", "AAPL", "NOPX"]);
    for (const label of [/Ticker/, /Name/, /Price/, /Quantity/, /Cost basis/, /Average cost per unit/, /Daily P&L/, /Valuation tag/]) {
      click(label);
      expect(within(table).getByRole("columnheader", { name: label }).getAttribute("aria-sort")).toBe("ascending");
    }
  });

  it("price cell: delayed quote with its time and market state, or the statement close labelled; currency code as text", () => {
    const { table } = mount();
    const aapl = within(table).getByTestId("row-AAPL");
    expect(within(aapl).getByText("232.00 USD")).toBeTruthy();
    expect(within(aapl).getByText(/delayed quote, 15 Oct 2026, 09:59, REGULAR/)).toBeTruthy();
    const shel = within(table).getByTestId("row-SHEL");
    expect(within(shel).getByText("24.31 GBP")).toBeTruthy();
    expect(within(shel).getByText("close of 14 Oct 2026")).toBeTruthy();
  });

  it("unavailable figures are a dash with the reason, never 0", () => {
    const { table } = mount();
    const row = within(table).getByTestId("row-NOPX");
    expect(within(row).getAllByText(/^Unavailable: /).length).toBeGreaterThanOrEqual(4);
    expect(within(row).queryByText(/^0\.00/)).toBeNull();
  });

  it("unrealized P&L is the independent value; the broker FIFO value is in the tooltip; a mismatch gets a visible marker", () => {
    const rows = [makeRow({ reconciles: false }), SHEL()];
    const { table } = mount(rows);
    const aapl = within(table).getByTestId("row-AAPL");
    expect(within(aapl).getByText("+318.30 USD")).toBeTruthy();
    expect(within(aapl).getByTitle("Broker-reported FIFO unrealized P&L at the statement close: +298.30 USD")).toBeTruthy();
    expect(within(aapl).getByText("Does not reconcile")).toBeTruthy();
    expect(within(within(table).getByTestId("row-SHEL")).queryByText("Does not reconcile")).toBeNull();
  });

  it("the average cost per unit is defined for assistive technology and mouse users", () => {
    const { table } = mount();
    expect(within(table).getByText(/Cost basis divided by quantity times multiplier/)).toBeTruthy();
  });

  it("valuation tags are text: Discounted, Premium, Extra premium, Unavailable, and none is an em dash with hidden text", () => {
    const rows = [makeRow({ id: 1, ticker: "D", tag: "discounted" }), makeRow({ id: 2, ticker: "P", tag: "premium" }), SHEL(), NOPX(), makeRow({ id: 5, ticker: "N", tag: "none" })];
    const { table } = mount(rows);
    for (const label of ["Discounted", "Premium", "Extra premium", "Unavailable"]) expect(within(table).getAllByText(label).length).toBeGreaterThan(0);
    expect(within(within(table).getByTestId("row-N")).getByText("within channel")).toBeTruthy();
    expect(within(within(table).getByTestId("row-D")).getByText("based on close of 2026-10-14")).toBeTruthy();
  });

  it("the summary row is the last row of the table and shows the base totals", () => {
    const { table } = mount();
    const rows = within(table).getAllByRole("row");
    expect(rows.at(-1)?.textContent).toContain("Total in EUR");
    expect(rows.at(-1)?.textContent).toContain("4,977.56 EUR");
  });

  it("each position also appears as a card exposing every field, with a Sort by control", () => {
    const { cards } = mount();
    const card = within(cards).getByTestId("card-SHEL");
    for (const label of ["Price", "Quantity", "Cost basis", "Average cost per unit", "Daily P&L (estimated)", "Unrealized P&L", "Valuation tag", "Market value"]) {
      expect(within(card).getByText(label)).toBeTruthy();
    }
    fireEvent.change(within(cards).getByLabelText("Sort by"), { target: { value: "ticker" } });
    expect(within(cards).getAllByTestId("card-ticker").map((e) => e.textContent)).toEqual(["AAPL", "NOPX", "SHEL"]);
    fireEvent.click(within(cards).getByRole("button", { name: /Ascending/ }));
    expect(within(cards).getAllByTestId("card-ticker").map((e) => e.textContent)).toEqual(["SHEL", "NOPX", "AAPL"]);
  });

  it("converted values name their basis (Yahoo rate and date, or the statement rate)", () => {
    const { table } = mount([makeRow({ valueBase: ok(2157.6, "EUR") }), SHEL({ fxSource: "flex", fxDate: "2026-10-14" })]);
    expect(within(within(table).getByTestId("row-AAPL")).getByText(/2,157\.60 EUR \(Yahoo rate, 15 Oct 2026\)/)).toBeTruthy();
    expect(within(within(table).getByTestId("row-SHEL")).getByText(/\(statement rate, 14 Oct 2026\)/)).toBeTruthy();
  });

  it("an empty list renders an explanation instead of an empty table", () => {
    render(<PositionsTable rows={[]} totals={view.totals} perCurrency={[]} base="EUR" />);
    expect(screen.getByText("No open positions in the latest statement.")).toBeTruthy();
  });
});
```

`apps/web/src/features/portfolio/page/positions-table.tsx`:

```tsx
import type { CurrencyBreakdown, PortfolioTotals, PositionView } from "@core/portfolio-view.ts";
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import { useMemo, useState } from "react";
import { EmptyState } from "@/components/data-state/data-state";
import { ValuationTag } from "@/components/status/valuation-tag";
import { formatSessionDate, formatSofia } from "@/lib/format";
import { MoneyText, formatAmount } from "../money-text";
import { SummaryCard, SummaryTableRow } from "./summary-row";
import { DEFAULT_SORT, SORT_LABELS, type SortDir, type SortKey, type SortState, sortPositions } from "./sort";

const qty = new Intl.NumberFormat("en-GB", { maximumFractionDigits: 6 });
const AVG_COST_DEFINITION = "Cost basis divided by quantity times multiplier. It equals IBKR's Cost Basis Price (commissions are netted into it by IBKR).";
const COLUMNS: SortKey[] = ["ticker", "name", "price", "quantity", "cost", "value", "avgCost", "daily", "unrealized", "tag"];
const NUMERIC: ReadonlySet<SortKey> = new Set(["price", "quantity", "cost", "value", "avgCost", "daily", "unrealized"]);

function PriceCell({ row }: { row: PositionView }) {
  const s = row.price.source;
  return (
    <div>
      {row.price.value === null ? <MoneyText money={{ kind: "unavailable", reason: s.kind === "unavailable" ? s.reason : "price unavailable" }} /> : <span className="tabular-nums">{`${formatAmount(row.price.value)} ${row.price.ccy}`}</span>}
      <small className="block text-xs text-muted-foreground" title={s.kind === "statement_close" ? s.reason : undefined}>
        {s.kind === "delayed_quote"
          ? `delayed quote${row.quoteTime === null ? "" : `, ${formatSofia(row.quoteTime)}`}${s.marketState === null ? "" : `, ${s.marketState}`}`
          : s.kind === "statement_close"
            ? `close of ${formatSessionDate(s.reportDate)}`
            : "no price"}
      </small>
      {row.price.note !== null ? <small className="block text-xs text-muted-foreground">{row.price.note}</small> : null}
    </div>
  );
}

function ValueCell({ row, base }: { row: PositionView; base: string }) {
  const basis = row.fxSource === "yahoo" ? `Yahoo rate, ${formatSessionDate(row.fxDate)}` : row.fxSource === "flex" ? `statement rate, ${formatSessionDate(row.fxDate)}` : null;
  return (
    <div>
      <MoneyText money={row.marketValue} />
      {row.currency !== base && row.valueBase.kind === "ok" && basis !== null ? (
        <small className="block text-xs text-muted-foreground">{`≈ ${formatAmount(row.valueBase.value)} ${base} (${basis})`}</small>
      ) : null}
    </div>
  );
}

function UnrealizedCell({ row }: { row: PositionView }) {
  const broker = row.unrealizedBroker === null ? "not reported" : `${row.unrealizedBroker > 0 ? "+" : ""}${formatAmount(row.unrealizedBroker)} ${row.currency}`;
  const title = `Broker-reported FIFO unrealized P&L at the statement close: ${broker}`;
  return (
    <div title={title}>
      <MoneyText money={row.unrealizedIndependent} signed />
      <span className="sr-only">{title}</span>
      {row.reconciles === false ? <small className="mt-0.5 block rounded border px-1 text-xs">Does not reconcile</small> : null}
    </div>
  );
}

function TagCell({ row }: { row: PositionView }) {
  return (
    <div>
      {row.tag === "none" ? (
        <>
          <span aria-hidden="true">{"—"}</span>
          <span className="sr-only">within channel</span>
        </>
      ) : (
        <ValuationTag kind={row.tag} />
      )}
      {row.tagBasis !== null ? <small className="block text-xs text-muted-foreground">{row.tagBasis}</small> : null}
    </div>
  );
}

function AvgCost({ row }: { row: PositionView }) {
  return row.averageCost === null ? <MoneyText money={{ kind: "unavailable", reason: "quantity is zero or cost basis missing" }} /> : <span className="tabular-nums">{`${formatAmount(row.averageCost)} ${row.currency}`}</span>;
}

function SortHeader({ k, sort, onSort }: { k: SortKey; sort: SortState; onSort(k: SortKey): void }) {
  const active = sort.key === k;
  const Icon = !active ? ArrowUpDown : sort.dir === "asc" ? ArrowUp : ArrowDown;
  return (
    <th scope="col" aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"} className={`px-2 py-2 ${NUMERIC.has(k) ? "text-right" : "text-left"}`}>
      <button type="button" className="inline-flex items-center gap-1 font-medium" onClick={() => onSort(k)} title={k === "avgCost" ? AVG_COST_DEFINITION : undefined} aria-describedby={k === "avgCost" ? "avg-cost-definition" : undefined}>
        {SORT_LABELS[k]}
        <Icon aria-hidden="true" size={12} />
      </button>
    </th>
  );
}

export function PositionsTable({ rows, totals, perCurrency, base }: { rows: readonly PositionView[]; totals: PortfolioTotals; perCurrency: readonly CurrencyBreakdown[]; base: string }) {
  const [sort, setSort] = useState<SortState>(DEFAULT_SORT);
  const sorted = useMemo(() => sortPositions(rows, sort.key, sort.dir), [rows, sort]);
  if (rows.length === 0) return <EmptyState title="No open positions in the latest statement." description="Positions appear after the next statement day." />;
  const onSort = (key: SortKey) => setSort((s) => (s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" }));
  const dir: SortDir = sort.dir;

  return (
    <div className="space-y-4">
      <div className="md:hidden">
        <SummaryCard totals={totals} perCurrency={perCurrency} base={base} />
      </div>

      <table data-testid="positions-table" className="hidden w-full text-sm md:table">
        <caption className="sr-only">
          {`Open positions with valuation, sorted by ${SORT_LABELS[sort.key]}. `}
          <span id="avg-cost-definition">{AVG_COST_DEFINITION}</span>
        </caption>
        <thead className="sticky top-0 bg-background">
          <tr>
            {COLUMNS.map((k) => (
              <SortHeader key={k} k={k} sort={sort} onSort={onSort} />
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((r) => (
            <tr key={r.id} data-testid={`row-${r.ticker}`} className="border-t align-top">
              <td className="px-2 py-2 font-medium"><span data-testid="row-ticker">{r.ticker}</span></td>
              <td className="max-w-[14rem] truncate px-2 py-2" title={r.name ?? undefined}>{r.name ?? "—"}</td>
              <td className="px-2 py-2 text-right"><PriceCell row={r} /></td>
              <td className="px-2 py-2 text-right tabular-nums">{qty.format(r.quantity)}</td>
              <td className="px-2 py-2 text-right"><MoneyText money={r.costBasis} /></td>
              <td className="px-2 py-2 text-right"><ValueCell row={r} base={base} /></td>
              <td className="px-2 py-2 text-right"><AvgCost row={r} /></td>
              <td className="px-2 py-2 text-right"><MoneyText money={r.dailyPnl} signed /></td>
              <td className="px-2 py-2 text-right"><UnrealizedCell row={r} /></td>
              <td className="px-2 py-2"><TagCell row={r} /></td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <SummaryTableRow totals={totals} base={base} />
        </tfoot>
      </table>

      <div data-testid="positions-cards" className="space-y-3 md:hidden">
        <div className="flex items-end gap-2">
          <label className="text-sm">
            <span className="block text-xs text-muted-foreground">Sort by</span>
            <select className="rounded border bg-background px-2 py-1" value={sort.key} onChange={(e) => setSort({ key: e.target.value as SortKey, dir: "asc" })}>
              {COLUMNS.map((k) => (
                <option key={k} value={k}>{SORT_LABELS[k]}</option>
              ))}
            </select>
          </label>
          <button type="button" className="rounded border px-2 py-1 text-sm" onClick={() => setSort((s) => ({ ...s, dir: s.dir === "asc" ? "desc" : "asc" }))}>
            {dir === "asc" ? "Ascending" : "Descending"}
          </button>
        </div>
        <ul className="space-y-3">
          {sorted.map((r) => (
            <li key={r.id} data-testid={`card-${r.ticker}`} className="rounded-md border p-3">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <h3 className="font-medium" data-testid="card-ticker">{r.ticker}</h3>
                  <p className="text-xs text-muted-foreground">{r.name}</p>
                </div>
                <div className="text-right">
                  <p className="text-xs text-muted-foreground">Market value</p>
                  <ValueCell row={r} base={base} />
                </div>
              </div>
              <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
                <dt className="text-muted-foreground">Price</dt><dd className="text-right"><PriceCell row={r} /></dd>
                <dt className="text-muted-foreground">Quantity</dt><dd className="text-right tabular-nums">{qty.format(r.quantity)}</dd>
                <dt className="text-muted-foreground">Cost basis</dt><dd className="text-right"><MoneyText money={r.costBasis} /></dd>
                <dt className="text-muted-foreground">Average cost per unit</dt><dd className="text-right"><AvgCost row={r} /></dd>
                <dt className="text-muted-foreground">Daily P&L (estimated)</dt><dd className="text-right"><MoneyText money={r.dailyPnl} signed /></dd>
                <dt className="text-muted-foreground">Unrealized P&L</dt><dd className="text-right"><UnrealizedCell row={r} /></dd>
                <dt className="text-muted-foreground">Valuation tag</dt><dd className="text-right"><TagCell row={r} /></dd>
              </dl>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
```

Run: `bun run test:web features/portfolio/page/summary-row features/portfolio/page/positions-table`
Expected: PASS. Notes for the two known sharp edges: (1) `getByText("Unrealized P&L")` etc. inside `card-SHEL` finds the `dt` labels, so the card labels must be exactly the strings of `SORT_LABELS` plus `Market value`; (2) in the "delayed quote" assertion the minute shown is Sofia time (06:59 UTC = 09:59).

- [ ] **Step 3: Trade history (API, hook, component), tests first**

`apps/web/src/features/portfolio/page/trades-api.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { TRADES_PAGE_SIZE, createTradesApi } from "./trades-api";

function fakeClient(result: { data: unknown; error: unknown; count: number | null }) {
  const calls: Array<[string, ...unknown[]]> = [];
  const chain: Record<string, unknown> = {};
  for (const name of ["select", "order", "range"]) {
    chain[name] = vi.fn((...args: unknown[]) => {
      calls.push([name, ...args]);
      return name === "range" ? Promise.resolve(result) : chain;
    });
  }
  return { client: { from: vi.fn(() => chain) } as never, calls };
}

describe("trades api", () => {
  it("reads executions newest first (date, time, id) one page at a time with an exact count", async () => {
    const { client, calls } = fakeClient({ data: [{ id: 1, ib_exec_id: "e1", symbol: "AAPL", quantity: "-4", trade_price: "26.5", ib_commission: "-0.4", net_cash: "105.6", fifo_pnl_realized: "4.6" }], error: null, count: 61 });
    const out = await createTradesApi(client).page(2);
    expect(calls.filter(([n]) => n === "order").map(([, col, opts]) => [col, (opts as { ascending: boolean }).ascending])).toEqual([["trade_date", false], ["trade_time", false], ["id", false]]);
    expect(calls.find(([n]) => n === "range")?.slice(1)).toEqual([2 * TRADES_PAGE_SIZE, 3 * TRADES_PAGE_SIZE - 1]);
    expect(out.total).toBe(61);
    expect(out.rows[0]).toMatchObject({ quantity: -4, trade_price: 26.5, ib_commission: -0.4, net_cash: 105.6, fifo_pnl_realized: 4.6 });
  });

  it("numeric columns arrive as strings or numbers and nulls stay null", async () => {
    const { client } = fakeClient({ data: [{ id: 2, ib_exec_id: "e2", symbol: "X", quantity: 3, trade_price: 1, ib_commission: null, net_cash: null, fifo_pnl_realized: null }], error: null, count: 1 });
    const out = await createTradesApi(client).page(0);
    expect(out.rows[0]).toMatchObject({ quantity: 3, ib_commission: null, net_cash: null, fifo_pnl_realized: null });
  });

  it("an error is thrown without row data", async () => {
    const { client } = fakeClient({ data: null, error: { message: "boom", code: "42501" }, count: null });
    await expect(createTradesApi(client).page(0)).rejects.toThrow("Could not load the trade history.");
  });
});
```

`apps/web/src/features/portfolio/page/trades-api.ts`:

```ts
import type { SupabaseClient } from "@supabase/supabase-js";

export const TRADES_PAGE_SIZE = 25;

export interface TradeRow {
  id: number;
  trade_id: string | null;
  ib_exec_id: string;
  ib_order_id: string | null;
  symbol: string;
  description: string | null;
  exchange: string | null;
  listing_exchange: string | null;
  currency: string;
  trade_date: string;
  trade_time: string | null;
  buy_sell: "BUY" | "SELL";
  quantity: number;
  trade_price: number;
  ib_commission: number | null;
  ib_commission_currency: string | null;
  net_cash: number | null;
  fifo_pnl_realized: number | null;
  open_close: string | null;
}

export interface TradesPage {
  rows: TradeRow[];
  total: number;
}

export interface TradesApi {
  page(index: number): Promise<TradesPage>;
}

const COLUMNS = "id,trade_id,ib_exec_id,ib_order_id,symbol,description,exchange,listing_exchange,currency,trade_date,trade_time,buy_sell,quantity,trade_price,ib_commission,ib_commission_currency,net_cash,fifo_pnl_realized,open_close";
const n = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

/** Executions only (orders are out of scope): newest first, 25 per page, read under RLS. */
export function createTradesApi(client: Pick<SupabaseClient, "from">): TradesApi {
  return {
    async page(index) {
      const from = index * TRADES_PAGE_SIZE;
      const { data, error, count } = await client
        .from("broker_trades")
        .select(COLUMNS, { count: "exact" })
        .order("trade_date", { ascending: false })
        .order("trade_time", { ascending: false, nullsFirst: false })
        .order("id", { ascending: false })
        .range(from, from + TRADES_PAGE_SIZE - 1);
      if (error) throw new Error("Could not load the trade history.");
      const rows = ((data as Array<Record<string, unknown>> | null) ?? []).map((r) => ({
        ...(r as unknown as TradeRow),
        quantity: Number(r["quantity"]),
        trade_price: Number(r["trade_price"]),
        ib_commission: n(r["ib_commission"]),
        net_cash: n(r["net_cash"]),
        fifo_pnl_realized: n(r["fifo_pnl_realized"]),
      }));
      return { rows, total: count ?? rows.length };
    },
  };
}
```

`apps/web/src/features/portfolio/page/trades-default.ts`:

```ts
import { supabase } from "@/lib/supabase";
import { createTradesApi } from "./trades-api";

export const tradesApi = createTradesApi(supabase);
```

`apps/web/src/features/portfolio/page/use-trades.ts`:

```ts
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { tradesApi } from "./trades-default";

export function useTrades(page: number) {
  return useQuery({ queryKey: ["portfolio", "trades", page], queryFn: () => tradesApi.page(page), staleTime: 5 * 60_000, placeholderData: keepPreviousData });
}
```

`apps/web/src/features/portfolio/page/trade-history.test.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TradeRow } from "./trades-api";
import { TradeHistory } from "./trade-history";

const page = vi.fn();
vi.mock("./trades-default", () => ({ tradesApi: { page: (...a: unknown[]) => page(...a) } }));

const row = (o: Partial<TradeRow> = {}): TradeRow => ({
  id: 3, trade_id: "2002001", ib_exec_id: "e3", ib_order_id: "5002", symbol: "SHEL", description: "SHELL PLC", exchange: "LSE", listing_exchange: "LSE", currency: "GBP",
  trade_date: "2026-10-08", trade_time: "11:05:00", buy_sell: "SELL", quantity: -4, trade_price: 26.5, ib_commission: -0.4, ib_commission_currency: "GBP", net_cash: 105.6,
  fifo_pnl_realized: 4.6, open_close: "C", ...o,
});
const buys = [
  row({ id: 2, trade_id: "1001002", ib_exec_id: "e2", ib_order_id: "5001", symbol: "AAPL", description: "APPLE INC", exchange: "NASDAQ", currency: "USD", trade_date: "2026-10-09", trade_time: "09:30:07", buy_sell: "BUY", quantity: 4, trade_price: 200.75, ib_commission: -0.7, ib_commission_currency: "USD", net_cash: -803.7, fifo_pnl_realized: 0, open_close: "O" }),
  row({ id: 1, trade_id: "1001001", ib_exec_id: "e1", ib_order_id: "5001", symbol: "AAPL", description: "APPLE INC", exchange: "NASDAQ", currency: "USD", trade_date: "2026-10-09", trade_time: "09:30:01", buy_sell: "BUY", quantity: 6, trade_price: 199.5, ib_commission: -1, ib_commission_currency: "USD", net_cash: -1198, fifo_pnl_realized: 0, open_close: "O" }),
];

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <TradeHistory />
    </QueryClientProvider>,
  );
}

beforeEach(() => page.mockReset());

describe("TradeHistory", () => {
  it("shows executions in the order given (newest first) with every column", async () => {
    page.mockResolvedValue({ rows: [row(), ...buys], total: 3 });
    mount();
    const table = await screen.findByTestId("trades-table");
    expect(within(table).getAllByTestId("trade-symbol").map((e) => e.textContent)).toEqual(["SHEL", "AAPL", "AAPL"]);
    const sell = within(table).getAllByRole("row")[1] as HTMLElement;
    expect(within(sell).getByText("8 Oct 2026")).toBeTruthy();
    expect(within(sell).getByText("Sell")).toBeTruthy();
    expect(within(sell).getByText("4")).toBeTruthy();
    expect(within(sell).getByText("26.50 GBP")).toBeTruthy();
    expect(within(sell).getByText("LSE")).toBeTruthy();
    expect(within(sell).getByText("0.40 GBP")).toBeTruthy();
    expect(within(sell).getByText("+105.60 GBP")).toBeTruthy();
    expect(within(sell).getByText("+4.60 GBP")).toBeTruthy();
  });

  it("a partial fill is shown as separate executions of one order", async () => {
    page.mockResolvedValue({ rows: buys, total: 2 });
    mount();
    const table = await screen.findByTestId("trades-table");
    expect(within(table).getAllByText("Order 5001 (2 fills)")).toHaveLength(2);
    expect(within(table).getByText("6")).toBeTruthy();
    expect(within(table).getByText("4")).toBeTruthy();
    expect(within(table).getByText("199.50 USD")).toBeTruthy();
    expect(within(table).getByText("200.75 USD")).toBeTruthy();
  });

  it("opening trades show a dash for realized P&L, never 0", async () => {
    page.mockResolvedValue({ rows: [buys[1] as TradeRow], total: 1 });
    mount();
    const table = await screen.findByTestId("trades-table");
    expect(within(table).queryByText(/0\.00 USD/)).toBeNull();
    expect(within(table).getByText("Unavailable: opening trade, nothing realized")).toBeTruthy();
  });

  it("pagination: counts, Next and Previous, page size 25", async () => {
    page.mockImplementation((i: number) => Promise.resolve({ rows: i === 0 ? Array.from({ length: 25 }, (_, k) => row({ id: 100 - k, ib_exec_id: `x${k}` })) : [row({ id: 1, ib_exec_id: "last" })], total: 26 }));
    mount();
    expect(await screen.findByText("Showing 1-25 of 26")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Previous page" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect(await screen.findByText("Showing 26-26 of 26")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Next page" }) as HTMLButtonElement).disabled).toBe(true);
    expect(page).toHaveBeenCalledWith(1);
  });

  it("empty and error states", async () => {
    page.mockResolvedValueOnce({ rows: [], total: 0 });
    mount();
    expect(await screen.findByText("No executions in the loaded statements.")).toBeTruthy();
  });

  it("an error offers Retry", async () => {
    page.mockRejectedValueOnce(new Error("Could not load the trade history.")).mockResolvedValue({ rows: [row()], total: 1 });
    mount();
    expect(await screen.findByText("Could not load the trade history.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByTestId("trades-table")).toBeTruthy();
  });

  it("every execution is also a card with all fields", async () => {
    page.mockResolvedValue({ rows: [row()], total: 1 });
    mount();
    const card = await screen.findByTestId("trade-card-e3");
    for (const label of ["Date", "Instrument", "Action", "Quantity", "Execution price", "Exchange", "Commission", "Net cash", "Realized P&L", "Order"]) {
      expect(within(card).getByText(label)).toBeTruthy();
    }
  });
});
```

`apps/web/src/features/portfolio/page/trade-history.tsx`:

```tsx
import { useState } from "react";
import { EmptyState, ErrorState, Loading } from "@/components/data-state/data-state";
import { formatSessionDate } from "@/lib/format";
import { MoneyText, formatAmount } from "../money-text";
import { TRADES_PAGE_SIZE, type TradeRow } from "./trades-api";
import { useTrades } from "./use-trades";

const qty = new Intl.NumberFormat("en-GB", { maximumFractionDigits: 6 });

function realized(r: TradeRow) {
  if (r.fifo_pnl_realized === null || (r.open_close !== "C" && r.fifo_pnl_realized === 0)) {
    return <MoneyText money={{ kind: "unavailable", reason: "opening trade, nothing realized" }} />;
  }
  return <MoneyText money={{ kind: "ok", value: r.fifo_pnl_realized, ccy: r.currency }} signed />;
}

const cost = (r: TradeRow) =>
  r.ib_commission === null ? <MoneyText money={{ kind: "unavailable", reason: "commission not reported" }} /> : <span className="tabular-nums">{`${formatAmount(Math.abs(r.ib_commission))} ${r.ib_commission_currency ?? r.currency}`}</span>;

const net = (r: TradeRow) => (r.net_cash === null ? <MoneyText money={{ kind: "unavailable", reason: "net cash not reported" }} /> : <MoneyText money={{ kind: "ok", value: r.net_cash, ccy: r.currency }} signed />);

function orderLabel(r: TradeRow, fills: Map<string, number>): string {
  if (r.ib_order_id === null) return "—";
  const n = fills.get(r.ib_order_id) ?? 1;
  return `Order ${r.ib_order_id}${n > 1 ? ` (${n} fills)` : ""}`;
}

export function TradeHistory() {
  const [page, setPage] = useState(0);
  const q = useTrades(page);
  if (q.isLoading) return <Loading label="Loading trade history" rows={4} />;
  if (q.isError && q.data === undefined) return <ErrorState title="Trade history unavailable" message="Could not load the trade history." onRetry={() => void q.refetch()} />;
  const data = q.data;
  if (data === undefined || data.total === 0) return <EmptyState title="No executions in the loaded statements." description="Executions from your IBKR statements appear here, newest first." />;

  const fills = new Map<string, number>();
  for (const r of data.rows) if (r.ib_order_id !== null) fills.set(r.ib_order_id, (fills.get(r.ib_order_id) ?? 0) + 1);
  const first = page * TRADES_PAGE_SIZE + 1;
  const last = Math.min(data.total, page * TRADES_PAGE_SIZE + data.rows.length);
  const pages = Math.max(1, Math.ceil(data.total / TRADES_PAGE_SIZE));

  return (
    <section aria-labelledby="trade-history-title" className="space-y-3">
      <h2 id="trade-history-title" className="text-lg font-semibold">Trade history</h2>
      <p className="text-xs text-muted-foreground">Executions from your IBKR statements (not orders). Times are as reported by IBKR.</p>

      <table data-testid="trades-table" className="hidden w-full text-sm md:table">
        <thead>
          <tr className="text-left">
            {["Date", "Instrument", "Action", "Quantity", "Execution price", "Exchange", "Commission", "Net cash", "Realized P&L", "Order"].map((h) => (
              <th key={h} scope="col" className="px-2 py-2 font-medium">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.rows.map((r) => (
            <tr key={r.ib_exec_id} className="border-t align-top">
              <td className="px-2 py-2"><span>{formatSessionDate(r.trade_date)}</span>{r.trade_time !== null ? <small className="block text-xs text-muted-foreground" title="Time as reported by IBKR">{r.trade_time}</small> : null}</td>
              <td className="px-2 py-2"><span data-testid="trade-symbol" className="font-medium">{r.symbol}</span>{r.description !== null ? <small className="block text-xs text-muted-foreground">{r.description}</small> : null}</td>
              <td className="px-2 py-2">{r.buy_sell === "BUY" ? "Buy" : "Sell"}</td>
              <td className="px-2 py-2 tabular-nums">{qty.format(Math.abs(r.quantity))}</td>
              <td className="px-2 py-2 tabular-nums">{`${formatAmount(r.trade_price)} ${r.currency}`}</td>
              <td className="px-2 py-2">{r.exchange ?? r.listing_exchange ?? "—"}</td>
              <td className="px-2 py-2">{cost(r)}</td>
              <td className="px-2 py-2">{net(r)}</td>
              <td className="px-2 py-2">{realized(r)}</td>
              <td className="px-2 py-2 text-xs">{orderLabel(r, fills)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <ul className="space-y-3 md:hidden">
        {data.rows.map((r) => (
          <li key={r.ib_exec_id} data-testid={`trade-card-${r.ib_exec_id}`} className="rounded-md border p-3">
            <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
              <dt className="text-muted-foreground">Date</dt><dd className="text-right">{formatSessionDate(r.trade_date)}{r.trade_time !== null ? ` ${r.trade_time}` : ""}</dd>
              <dt className="text-muted-foreground">Instrument</dt><dd className="text-right">{r.symbol}</dd>
              <dt className="text-muted-foreground">Action</dt><dd className="text-right">{r.buy_sell === "BUY" ? "Buy" : "Sell"}</dd>
              <dt className="text-muted-foreground">Quantity</dt><dd className="text-right tabular-nums">{qty.format(Math.abs(r.quantity))}</dd>
              <dt className="text-muted-foreground">Execution price</dt><dd className="text-right tabular-nums">{`${formatAmount(r.trade_price)} ${r.currency}`}</dd>
              <dt className="text-muted-foreground">Exchange</dt><dd className="text-right">{r.exchange ?? r.listing_exchange ?? "—"}</dd>
              <dt className="text-muted-foreground">Commission</dt><dd className="text-right">{cost(r)}</dd>
              <dt className="text-muted-foreground">Net cash</dt><dd className="text-right">{net(r)}</dd>
              <dt className="text-muted-foreground">Realized P&L</dt><dd className="text-right">{realized(r)}</dd>
              <dt className="text-muted-foreground">Order</dt><dd className="text-right">{orderLabel(r, fills)}</dd>
            </dl>
          </li>
        ))}
      </ul>

      <nav aria-label="Trade history pages" className="flex items-center justify-between gap-2 text-sm">
        <p>{`Showing ${first}-${last} of ${data.total}`}</p>
        <div className="flex items-center gap-2">
          <button type="button" className="rounded border px-2 py-1 disabled:opacity-50" disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>Previous page</button>
          <span>{`Page ${page + 1} of ${pages}`}</span>
          <button type="button" className="rounded border px-2 py-1 disabled:opacity-50" disabled={page + 1 >= pages} onClick={() => setPage((p) => p + 1)}>Next page</button>
        </div>
      </nav>
    </section>
  );
}
```

Run: `bun run test:web features/portfolio/page/trades features/portfolio/page/trade-history`
Expected: PASS (trades-api 3, trade-history 7). In the trade-history tests `getByText("4")` and `getByText("6")` are scoped inside the table / row, where the quantity cell is the only element with exactly that text; the card list (hidden on desktop by CSS only, still in the DOM) uses `getByTestId("trade-card-e3")` so there is no ambiguity in those tests because the table queries are scoped with `within(table)`.

- [ ] **Step 4: The page, wiring and page tests**

`apps/web/src/features/portfolio/page/portfolio-page.test.tsx`:

```tsx
import { act, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { signedIn } from "@/test/auth-fixtures";
import { renderApp } from "@/test/render-app";
import { NotLinkedError, RefreshFailure } from "../portfolio-api";
import { NOPX, SHEL, makeResponse, makeRow, makeView } from "./test-fixtures";

const get = vi.fn();
const refresh = vi.fn();
vi.mock("@/features/portfolio/default", () => ({ portfolioApi: { get: (...a: unknown[]) => get(...a), refresh: (...a: unknown[]) => refresh(...a) } }));
vi.mock("@/features/portfolio/page/trades-default", () => ({ tradesApi: { page: () => Promise.resolve({ rows: [], total: 0 }) } }));

beforeEach(() => {
  get.mockReset();
  refresh.mockReset();
});

describe("PortfolioPage", () => {
  it("not linked: a short explanation and a button to Profile -> Broker", async () => {
    get.mockRejectedValue(new NotLinkedError());
    await renderApp("/portfolio", signedIn());
    expect(await screen.findByText("No broker is linked")).toBeTruthy();
    const link = screen.getByRole("link", { name: "Link your broker" });
    expect(link.getAttribute("href")).toBe("/profile/broker");
  });

  it("shows the header with the T+1 disclosure, the summary, the positions in default order and the trade history section", async () => {
    get.mockResolvedValue(makeResponse());
    await renderApp("/portfolio", signedIn());
    expect(await screen.findByRole("heading", { level: 1, name: "Portfolio" })).toBeTruthy();
    expect(await screen.findByText(/Broker data as of 14 Oct 2026 \(end of day, T\+1\)/)).toBeTruthy();
    expect(screen.getByText(/Prices shown are delayed Yahoo quotes\./)).toBeTruthy();
    const table = await screen.findByTestId("positions-table");
    expect(within(table).getAllByTestId("row-ticker").map((e) => e.textContent)).toEqual(["SHEL", "AAPL", "NOPX"]);
    expect(screen.getByRole("region", { name: "Portfolio summary" })).toBeTruthy();
    expect(await screen.findByText("No executions in the loaded statements.")).toBeTruthy();
  });

  it("a behind statement is flagged and the page never calls it today's positions", async () => {
    get.mockResolvedValue(makeResponse({ statement: { expectedDate: "2026-10-14", freshness: { kind: "behind", days: 2 } } as never, reportDate: "2026-10-12" }));
    await renderApp("/portfolio", signedIn());
    expect(await screen.findByText(/The statement is 2 days behind the expected date/)).toBeTruthy();
    expect(screen.queryByText(/today's positions/i)).toBeNull();
  });

  it("an empty portfolio shows the explanation, not an empty table or zeros", async () => {
    get.mockResolvedValue(makeResponse({ view: makeView([]) }));
    await renderApp("/portfolio", signedIn());
    expect(await screen.findByText("No open positions in the latest statement.")).toBeTruthy();
  });

  it("a failed refresh keeps the last successful table on screen and shows the error banner", async () => {
    get.mockResolvedValueOnce(makeResponse({ view: makeView([makeRow(), SHEL(), NOPX()]) }));
    get.mockRejectedValue(new RefreshFailure(null, "Network error: could not reach the server."));
    const { queryClient } = await renderApp("/portfolio", signedIn());
    await screen.findByTestId("positions-table");
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: ["portfolio"] }).catch(() => undefined);
    });
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Network error: could not reach the server."), { timeout: 4000 });
    expect(screen.getByTestId("positions-table")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("Showing the data from 15 Oct 2026, 10:00");
  });

  it("the first load failing shows an error with Retry, never a blank page", async () => {
    get.mockRejectedValue(new RefreshFailure(500, "The refresh failed (HTTP 500)."));
    await renderApp("/portfolio", signedIn());
    // the query retries once after one second before it reports the failure
    expect(await screen.findByText("The refresh failed (HTTP 500).", {}, { timeout: 4000 })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("shows a loading skeleton first", async () => {
    get.mockReturnValue(new Promise(() => undefined));
    await renderApp("/portfolio", signedIn());
    expect((await screen.findAllByRole("status")).length).toBeGreaterThan(0);
  });
});
```

`apps/web/src/features/portfolio/page/portfolio-page.tsx`:

```tsx
import { Link } from "@tanstack/react-router";
import { useEffect } from "react";
import { EmptyState, ErrorState, Loading } from "@/components/data-state/data-state";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { NotLinkedError } from "../portfolio-api";
import { RefreshBar } from "../refresh-bar";
import { usePortfolio } from "../use-portfolio";
import { PositionsTable } from "./positions-table";
import { TradeHistory } from "./trade-history";

function NotLinked() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>No broker is linked</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p>Link your IBKR account to see your positions, trades and analytics. The connection is read-only (IBKR Flex Web Service) and uses end-of-day statements.</p>
        <Button asChild>
          <Link to="/profile/broker">Link your broker</Link>
        </Button>
      </CardContent>
    </Card>
  );
}

export function PortfolioPage() {
  useEffect(() => {
    document.title = "Portfolio - Stock Screener";
  }, []);
  const q = usePortfolio();

  let body: ReactNode;
  if (q.isLoading) body = <Loading label="Loading portfolio" rows={6} />;
  else if (q.data === undefined && q.error instanceof NotLinkedError) body = <NotLinked />;
  else if (q.data === undefined) body = <ErrorState message={q.error instanceof Error ? q.error.message : "Could not load the portfolio."} onRetry={() => void q.refetch()} />;
  else {
    const view = q.data.view;
    body = (
      <>
        <RefreshBar data={q.data} error={q.error instanceof Error ? q.error : null} fetching={q.isFetching} />
        {view.positions.length === 0 ? (
          <EmptyState title="No open positions in the latest statement." description="Positions appear after the next statement day." />
        ) : (
          <PositionsTable rows={view.positions} totals={view.totals} perCurrency={view.perCurrency} base={view.baseCurrency} />
        )}
        <TradeHistory />
      </>
    );
  }

  return (
    <section aria-labelledby="page-title" className="space-y-6">
      <h1 id="page-title" className="text-2xl font-semibold tracking-tight">
        Portfolio
      </h1>
      {body}
    </section>
  );
}
```

Wiring (only after the page exists):
1. `apps/web/src/features/pages.tsx`: delete the `PortfolioPage` placeholder function (and the `PagePlaceholder` import if no placeholder is left).
2. `apps/web/src/router.tsx`: remove `PortfolioPage` from the `@/features/pages` import and add `import { PortfolioPage } from "@/features/portfolio/page/portfolio-page";`; the existing `component: guarded(PortfolioPage)` stays unchanged.

Run: `bun run test:web features/portfolio` then the full `bun run test:web`
Expected: PASS. If an earlier P0/P5a test asserted the placeholder description of `/portfolio`, change it to the heading `Portfolio` (the heading is unchanged).

- [ ] **Step 5: Lint, typecheck, commit**

Run: `bun run lint:fix`, `bun run lint`, `bun run typecheck`, `bun run test:web`
Expected: exit 0.

```text
git add apps/web/src/features/portfolio apps/web/src/features/pages.tsx apps/web/src/router.tsx
git commit -m "feat(web): add Portfolio page with sortable positions, summary, responsive cards and trade history"
```

---

## Task 8: Analytics page (`/analytics`)

**Concurrency:** starts after Task 5. May run at the same time as Tasks 6 and 7 (disjoint files); its final wiring step edits `features/pages.tsx` and `router.tsx` and must come after Task 7's wiring step.

**REQUIRED before Step 4 (components):** the implementer MUST load `frontend-design:frontend-design`, `ui-ux-pro-max:ui-ux-pro-max` and `dataviz` (the NAV chart). The code below is a working baseline; the skills may refine hierarchy, chart styling and colours (keep the single series, the labelled axes, the text alternative and the contrast rules). Fixed constraints: every sentence, label and card title used by the tests; each figure carries a provenance badge in text (`Broker-reported` or `Calculated by this app`); `unavailable` is a dash with the reason, never 0; usable at phone width.

**Files:**
- Create: `apps/web/src/features/analytics/{analytics-data,analytics-model,default,use-analytics,test-fixtures}.ts`, tests `analytics-data.test.ts`, `analytics-model.test.ts`
- Create: `apps/web/src/features/analytics/components/{kpi-card,currency-table,nav-chart,dividend-toggle}.tsx` with tests `kpi-card.test.tsx`, `currency-table.test.tsx`, `nav-chart.test.tsx`
- Create: `apps/web/src/features/analytics/analytics-page.tsx`, `analytics-page.test.tsx`
- Modify (final wiring step): `apps/web/src/features/pages.tsx`, `apps/web/src/router.tsx`

**Interfaces:**
- Consumes: Task 3 (`accounting.ts`), Task 5 (`usePortfolio`, `RefreshBar`, `MoneyText`, `ProvenanceBadge`, `useVisibleInterval`, `PortfolioView`), Task 1 tables (RLS reads), P4 (`Loading`, `ErrorState`, `EmptyState`, `formatSessionDate`), P4 `lightweight-charts` 5.2.1, P5a (`renderApp`, `signedIn`).
- Produces: `AnalyticsPage`, `buildAnalytics`, `coverageText`, `loadAnalyticsData`, `fetchAllPages`.

- [ ] **Step 1: Data loading (paging and row mapping), tests first**

`apps/web/src/features/analytics/analytics-data.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { fetchAllPages, mapCash, mapLot, mapNav, mapPosition, mapRate } from "./analytics-data";

describe("fetchAllPages: PostgREST returns at most 1,000 rows per request", () => {
  it("reads pages until a short page and concatenates them in order", async () => {
    const page = vi.fn((from: number, to: number) =>
      Promise.resolve({ data: Array.from({ length: Math.min(to, 2349) - from + 1 }, (_, i) => from + i), error: null }),
    );
    const rows = await fetchAllPages<number>(page, 1000);
    expect(rows).toHaveLength(2350);
    expect(rows[0]).toBe(0);
    expect(rows.at(-1)).toBe(2349);
    expect(page.mock.calls.map((c) => [c[0], c[1]])).toEqual([[0, 999], [1000, 1999], [2000, 2999]]);
  });

  it("an exactly full last page triggers one more (empty) request; an empty table is one request", async () => {
    const full = vi.fn((from: number) => Promise.resolve({ data: from === 0 ? Array.from({ length: 1000 }, (_, i) => i) : [], error: null }));
    expect(await fetchAllPages<number>(full, 1000)).toHaveLength(1000);
    expect(full).toHaveBeenCalledTimes(2);
    const empty = vi.fn(() => Promise.resolve({ data: [], error: null }));
    expect(await fetchAllPages(empty, 1000)).toEqual([]);
    expect(empty).toHaveBeenCalledTimes(1);
  });

  it("an error stops the loading with a message that carries no row data", async () => {
    await expect(fetchAllPages(() => Promise.resolve({ data: null, error: { message: "secret detail", code: "42501" } }), 1000)).rejects.toThrow("Could not load the statement history.");
  });
});

describe("row mappers coerce PostgREST numerics and keep the dedupe key", () => {
  it("closed lot", () => {
    expect(mapLot({ conid: 100002, currency: "GBP", quantity: "3", cost_basis: "75", proceeds: "79.5", fifo_pnl_realized: "4.2", close_date: "2026-10-08", fx_rate_to_base: "1.15", dedupe_hash: "h1" })).toEqual({
      conid: 100002, ccy: "GBP", qty: 3, costBasis: 75, proceeds: 79.5, realizedPnl: 4.2, closeDate: "2026-10-08", fxToBase: 1.15, key: "h1",
    });
    expect(mapLot({ conid: 1, currency: "USD", quantity: 1, cost_basis: 1, proceeds: null, fifo_pnl_realized: 0, close_date: "2026-10-08", fx_rate_to_base: null, dedupe_hash: "h" }).fxToBase).toBeNull();
  });

  it("cash transaction uses the date part of occurred_at", () => {
    expect(mapCash({ occurred_at: "2026-10-10T20:25:00+00:00", currency: "USD", amount: "2.6", category: "dividend", conid: 100001, fx_rate_to_base: "0.92" })).toEqual({
      date: "2026-10-10", ccy: "USD", amount: 2.6, category: "dividend", conid: 100001, fxToBase: 0.92,
    });
  });

  it("statement position, NAV row and FX rate", () => {
    expect(mapPosition({ currency: "USD", cost_basis_money: "2001.7", fifo_pnl_unrealized: "298.3", fx_rate_to_base: "0.92" })).toEqual({ ccy: "USD", costBasisMoney: 2001.7, fifoUnrealized: 298.3, fxToBase: 0.92 });
    expect(mapPosition({ currency: "USD", cost_basis_money: null, fifo_pnl_unrealized: null, fx_rate_to_base: null })).toEqual({ ccy: "USD", costBasisMoney: null, fifoUnrealized: null, fxToBase: null });
    expect(mapNav({ report_date: "2026-10-14", currency: "EUR", total: "9950.20" })).toEqual({ date: "2026-10-14", total: 9950.2, ccy: "EUR" });
    expect(mapRate({ rate_date: "2026-10-14", from_ccy: "USD", to_ccy: "EUR", rate: "0.92" })).toEqual({ rateDate: "2026-10-14", fromCcy: "USD", toCcy: "EUR", rate: 0.92 });
  });
});
```

`apps/web/src/features/analytics/analytics-data.ts`:

```ts
import type { CashTx, ClosedLot, FlexRateRow, NavPoint } from "@core/accounting.ts";
import type { SupabaseClient } from "@supabase/supabase-js";

export const PAGE_SIZE = 1000;

export interface StatementPosition {
  ccy: string;
  costBasisMoney: number | null;
  fifoUnrealized: number | null;
  fxToBase: number | null;
}

export interface CommissionRow {
  commission: number | null;
  commissionCcy: string;
  tradeCcy: string;
  fxToBase: number | null;
  tradeDate: string;
}

export interface AnalyticsData {
  lots: ClosedLot[];
  cash: CashTx[];
  trades: CommissionRow[];
  nav: NavPoint[];
  fxRates: FlexRateRow[];
  positions: StatementPosition[];
  baseCurrency: string | null;
  coverageFrom: string | null;
  lastStatementDate: string | null;
  /** ACATS/internal transfers exist: their value is not in the cash flows, so historical performance is unavailable (spec 12.9) */
  hasUnvaluedTransfers: boolean;
}

type Raw = Record<string, unknown>;
const num = (v: unknown): number => Number(v);
const opt = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

export const mapLot = (r: Raw): ClosedLot => ({
  conid: num(r["conid"]), ccy: String(r["currency"]), qty: num(r["quantity"]), costBasis: num(r["cost_basis"]), proceeds: num(r["proceeds"] ?? 0),
  realizedPnl: num(r["fifo_pnl_realized"]), closeDate: String(r["close_date"]), fxToBase: opt(r["fx_rate_to_base"]), key: String(r["dedupe_hash"]),
});

export const mapCash = (r: Raw): CashTx => ({
  date: String(r["occurred_at"]).slice(0, 10), ccy: String(r["currency"]), amount: num(r["amount"]), category: r["category"] as CashTx["category"],
  conid: opt(r["conid"]), fxToBase: opt(r["fx_rate_to_base"]),
});

export const mapPosition = (r: Raw): StatementPosition => ({
  ccy: String(r["currency"]), costBasisMoney: opt(r["cost_basis_money"]), fifoUnrealized: opt(r["fifo_pnl_unrealized"]), fxToBase: opt(r["fx_rate_to_base"]),
});

export const mapNav = (r: Raw): NavPoint => ({ date: String(r["report_date"]), total: num(r["total"]), ccy: String(r["currency"]) });

export const mapRate = (r: Raw): FlexRateRow => ({ rateDate: String(r["rate_date"]), fromCcy: String(r["from_ccy"]), toCcy: String(r["to_ccy"]), rate: num(r["rate"]) });

export const mapCommission = (r: Raw): CommissionRow => ({
  commission: opt(r["ib_commission"]), commissionCcy: String(r["ib_commission_currency"] ?? r["currency"]), tradeCcy: String(r["currency"]),
  fxToBase: opt(r["fx_rate_to_base"]), tradeDate: String(r["trade_date"]),
});

export async function fetchAllPages<T>(fetchPage: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>, pageSize = PAGE_SIZE): Promise<T[]> {
  const out: T[] = [];
  for (let page = 0; page < 500; page++) {
    const from = page * pageSize;
    const { data, error } = await fetchPage(from, from + pageSize - 1);
    if (error) throw new Error("Could not load the statement history.");
    const rows = data ?? [];
    out.push(...rows);
    if (rows.length < pageSize) return out;
  }
  throw new Error("Could not load the statement history.");
}

/** Reads the statement tables under RLS (own rows only). Deterministic paging: every table is ordered by its identity column. */
export async function loadAnalyticsData(client: Pick<SupabaseClient, "from">): Promise<AnalyticsData> {
  const read = (table: string, columns: string) =>
    fetchAllPages<Raw>((a, b) => client.from(table).select(columns).order("id", { ascending: true }).range(a, b) as unknown as PromiseLike<{ data: Raw[] | null; error: unknown }>);

  const latest = await client.from("broker_positions").select("report_date").order("report_date", { ascending: false }).limit(1);
  const latestDate = ((latest.data as Array<{ report_date: string }> | null) ?? [])[0]?.report_date;
  const connection = await client.from("broker_connections").select("base_currency,coverage_from,last_statement_date").maybeSingle();
  if (connection.error) throw new Error("Could not load the statement history.");
  const transfers = await client.from("broker_corporate_actions").select("id", { count: "exact", head: true }).eq("kind", "transfer");

  const [lots, cash, trades, nav, rates, positions] = await Promise.all([
    read("broker_closed_lots", "id,conid,currency,quantity,cost_basis,proceeds,fifo_pnl_realized,close_date,fx_rate_to_base,dedupe_hash"),
    read("broker_cash_transactions", "id,occurred_at,currency,amount,category,conid,fx_rate_to_base"),
    read("broker_trades", "id,ib_commission,ib_commission_currency,currency,fx_rate_to_base,trade_date"),
    read("broker_nav", "id,report_date,currency,total"),
    read("broker_fx_rates", "id,rate_date,from_ccy,to_ccy,rate"),
    latestDate === undefined
      ? Promise.resolve([] as Raw[])
      : fetchAllPages<Raw>((a, b) => client.from("broker_positions").select("id,currency,cost_basis_money,fifo_pnl_unrealized,fx_rate_to_base").eq("report_date", latestDate).order("id").range(a, b) as unknown as PromiseLike<{ data: Raw[] | null; error: unknown }>),
  ]);
  const c = connection.data as { base_currency: string | null; coverage_from: string | null; last_statement_date: string | null } | null;
  return {
    lots: lots.map(mapLot),
    cash: cash.map(mapCash),
    trades: trades.map(mapCommission),
    nav: nav.map(mapNav),
    fxRates: rates.map(mapRate),
    positions: positions.map(mapPosition),
    baseCurrency: c?.base_currency ?? null,
    coverageFrom: c?.coverage_from ?? null,
    lastStatementDate: c?.last_statement_date ?? null,
    hasUnvaluedTransfers: (transfers.count ?? 0) > 0,
  };
}
```

`apps/web/src/features/analytics/default.ts`:

```ts
import { supabase } from "@/lib/supabase";
import { type AnalyticsData, loadAnalyticsData } from "./analytics-data";

/** The real loader. Vitest replaces this module with a mock in the tests that need data. */
export const analyticsApi = { load: (): Promise<AnalyticsData> => loadAnalyticsData(supabase) };
```

`apps/web/src/features/analytics/use-analytics.ts`:

```ts
import { useQuery } from "@tanstack/react-query";
import { AUTO_REFRESH_MS } from "@core/statement-day.ts";
import { useVisibleInterval } from "../portfolio/use-visible-interval";
import { analyticsApi } from "./default";

export const ANALYTICS_KEY = ["analytics", "data"] as const;

/** Statement history (spec 14.2 key ["analytics", params]): refreshed every 5 minutes while the page is visible. */
export function useAnalyticsData(opts: { enabled: boolean }) {
  const query = useQuery({ queryKey: ANALYTICS_KEY, queryFn: () => analyticsApi.load(), enabled: opts.enabled, staleTime: AUTO_REFRESH_MS, retry: 1, refetchOnWindowFocus: false });
  useVisibleInterval(() => void query.refetch(), AUTO_REFRESH_MS, { enabled: opts.enabled, lastRunAt: () => (query.dataUpdatedAt > 0 ? query.dataUpdatedAt : null) });
  return query;
}
```

Run: `bun run test:web features/analytics/analytics-data`
Expected: PASS (5 tests).

- [ ] **Step 2: The analytics model (arithmetic and definitions), tests first**

`apps/web/src/features/analytics/test-fixtures.ts`:

```ts
import type { AnalyticsData } from "./analytics-data";

/** EUR account; the numbers of the Flex fixture (partial sale of SHEL, AAPL dividend and withholding, deposit and fee, two NAV rows). */
export function makeData(o: Partial<AnalyticsData> = {}): AnalyticsData {
  return {
    lots: [
      { conid: 100002, ccy: "GBP", qty: 3, costBasis: 75, proceeds: 79.5, realizedPnl: 4.2, closeDate: "2026-10-08", fxToBase: 1.15, key: "lot-a" },
      { conid: 100002, ccy: "GBP", qty: 1, costBasis: 26, proceeds: 26.5, realizedPnl: 0.4, closeDate: "2026-10-08", fxToBase: 1.15, key: "lot-b" },
    ],
    cash: [
      { date: "2026-10-10", ccy: "USD", amount: 2.6, category: "dividend", conid: 100001, fxToBase: 0.92 },
      { date: "2026-10-10", ccy: "USD", amount: -0.39, category: "withholding_tax", conid: 100001, fxToBase: 0.92 },
      { date: "2026-09-16", ccy: "EUR", amount: 5000, category: "deposit_withdrawal", conid: null, fxToBase: 1 },
      { date: "2026-10-01", ccy: "EUR", amount: -2, category: "fee", conid: null, fxToBase: 1 },
    ],
    trades: [
      { commission: -1, commissionCcy: "USD", tradeCcy: "USD", fxToBase: 0.92, tradeDate: "2026-10-09" },
      { commission: -0.7, commissionCcy: "USD", tradeCcy: "USD", fxToBase: 0.92, tradeDate: "2026-10-09" },
      { commission: -0.4, commissionCcy: "GBP", tradeCcy: "GBP", fxToBase: 1.15, tradeDate: "2026-10-08" },
    ],
    nav: [{ date: "2026-10-13", total: 9800.55, ccy: "EUR" }, { date: "2026-10-14", total: 9950.2, ccy: "EUR" }],
    fxRates: [{ rateDate: "2026-10-14", fromCcy: "USD", toCcy: "EUR", rate: 0.92 }, { rateDate: "2026-10-14", fromCcy: "GBP", toCcy: "EUR", rate: 1.15 }],
    positions: [
      { ccy: "USD", costBasisMoney: 2001.7, fifoUnrealized: 298.3, fxToBase: 0.92 },
      { ccy: "GBP", costBasisMoney: 2500, fifoUnrealized: 235, fxToBase: 1.15 },
    ],
    baseCurrency: "EUR",
    coverageFrom: "2025-10-15",
    lastStatementDate: "2026-10-14",
    hasUnvaluedTransfers: false,
    ...o,
  };
}
```

`apps/web/src/features/analytics/analytics-model.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { Money } from "@core/accounting.ts";
import { makeView, na, ok } from "../portfolio/page/test-fixtures";
import { buildAnalytics, coverageText } from "./analytics-model";
import { makeData } from "./test-fixtures";

const v = (m: Money): number => {
  if (m.kind !== "ok") throw new Error(`unavailable: ${m.reason}`);
  return m.value;
};
const view = makeView(); // unrealized (calculated, EUR) = 296.02 - 80.04 = 215.98, value 4977.56
const build = (o: Partial<Parameters<typeof buildAnalytics>[0]> = {}) => buildAnalytics({ base: "EUR", includeDividends: false, view, data: makeData(), ...o });

describe("figures and their origin", () => {
  const m = build();

  it("total value: the broker NAV of the last statement date and, separately, the positions at delayed prices", () => {
    expect(v(m.totalValue.nav)).toBe(9950.2);
    expect(m.totalValue.navDate).toBe("2026-10-14");
    expect(v(m.totalValue.calculated)).toBeCloseTo(4977.56, 6);
  });

  it("cost basis is the Flex cost basis converted with the Flex rates (broker-reported)", () => {
    expect(v(m.costBasis)).toBeCloseTo(2001.7 * 0.92 + 2500 * 1.15, 8);
  });

  it("unrealized P&L: independently calculated (current prices) and broker FIFO (statement)", () => {
    expect(v(m.unrealized.calculated)).toBeCloseTo(215.98, 6);
    expect(v(m.unrealized.broker)).toBeCloseTo(298.3 * 0.92 + 235 * 1.15, 8);
  });

  it("realized trading P&L is the sum of the closed lots of the partial sale in the base currency, commissions not subtracted again", () => {
    expect(m.realized.lotCount).toBe(2);
    expect(m.realized.byCcy["GBP"]).toBeCloseTo(4.6, 10);
    expect(v(m.realized.base)).toBeCloseTo(4.6 * 1.15, 10);
  });

  it("dividends gross, withholding and net are separate", () => {
    expect(v(m.dividends.gross)).toBeCloseTo(2.6 * 0.92, 10);
    expect(v(m.dividends.withholding)).toBeCloseTo(-0.39 * 0.92, 10);
    expect(v(m.dividends.net)).toBeCloseTo(2.21 * 0.92, 10);
  });

  it("commissions are a memo (already inside realized P&L); fees and interest are the other costs", () => {
    expect(v(m.costs.commissions)).toBeCloseTo(1.7 * 0.92 + 0.4 * 1.15, 10);
    expect(v(m.costs.other)).toBeCloseTo(2, 10);
  });

  it("a commission in another currency than the trade uses the Flex conversion rate of the trade date", () => {
    const data = makeData({ trades: [{ commission: -1, commissionCcy: "USD", tradeCcy: "GBP", fxToBase: 1.15, tradeDate: "2026-10-14" }] });
    expect(v(build({ data }).costs.commissions)).toBeCloseTo(0.92, 10);
    const noRate = makeData({ trades: [{ commission: -1, commissionCcy: "CHF", tradeCcy: "GBP", fxToBase: 1.15, tradeDate: "2026-10-14" }] });
    expect(build({ data: noRate }).costs.commissions.kind).toBe("unavailable");
  });
});

describe("the include-dividends toggle feeds the combined performance", () => {
  const realized = 4.6 * 1.15;
  const unrealized = 215.98;
  const dividendsNet = 2.21 * 0.92;
  const other = 2;

  it("excluded: realized plus unrealized; with other costs as a separate line", () => {
    const m = build({ includeDividends: false });
    expect(v(m.combined)).toBeCloseTo(realized + unrealized, 8);
    expect(v(m.combinedAfterOtherCosts)).toBeCloseTo(realized + unrealized - other, 8);
  });

  it("included: adds the NET dividends exactly once", () => {
    const m = build({ includeDividends: true });
    expect(v(m.combined)).toBeCloseTo(realized + unrealized + dividendsNet, 8);
    expect(v(m.combinedAfterOtherCosts)).toBeCloseTo(realized + unrealized + dividendsNet - other, 8);
  });

  it("toggling never double counts: included minus excluded equals net dividends", () => {
    expect(v(build({ includeDividends: true }).combined) - v(build({ includeDividends: false }).combined)).toBeCloseTo(dividendsNet, 10);
  });

  it("an unavailable calculated unrealized figure makes the combined figure unavailable, not zero", () => {
    const m = build({ view: makeView(undefined, { totals: { ...view.totals, unrealizedBase: na("Missing FX rate USD->EUR") } }) });
    expect(m.combined.kind).toBe("unavailable");
    expect(m.combinedAfterOtherCosts.kind).toBe("unavailable");
  });

  it("without valued positions the calculated figures are unavailable with a reason", () => {
    const m = build({ view: null });
    expect(m.totalValue.calculated.kind).toBe("unavailable");
    expect(m.combined.kind).toBe("unavailable");
  });
});

describe("history, coverage and breakdown", () => {
  it("historical performance is NAV minus net flows after the first NAV date; unavailable when transfers are not valued", () => {
    const m = build();
    expect(m.historical.kind).toBe("ok");
    if (m.historical.kind === "ok") expect(m.historical.points.at(-1)?.performance).toBeCloseTo(149.65, 8);
    const withTransfers = build({ data: makeData({ hasUnvaluedTransfers: true }) });
    expect(withTransfers.historical.kind).toBe("unavailable");
    expect(build({ data: makeData({ nav: [] }) }).historical.kind).toBe("unavailable");
  });

  it("NAV points feed the chart; fewer than two rows is reported", () => {
    expect(build().navPoints).toEqual([{ date: "2026-10-13", value: 9800.55 }, { date: "2026-10-14", value: 9950.2 }]);
    expect(build({ data: makeData({ nav: [{ date: "2026-10-14", total: 9950.2, ccy: "EUR" }] }) }).navPoints).toHaveLength(1);
  });

  it("coverage text names the loaded period and warns about earlier activity", () => {
    expect(coverageText("2025-10-15", "2026-10-14")).toBe("History loaded from 15 Oct 2025 to 14 Oct 2026 — earlier activity is not included. Realized P&L may be incomplete before 15 Oct 2025.");
    expect(coverageText(null, null)).toBe("No statement history is loaded yet.");
    expect(coverageText("2025-10-15", null)).toContain("History loaded from 15 Oct 2025");
  });

  it("per-currency breakdown shows each currency in its own unit", () => {
    const rows = build().perCurrency;
    expect(rows.map((r) => r.ccy)).toEqual(["EUR", "GBP", "USD"]);
    const gbp = rows.find((r) => r.ccy === "GBP");
    expect(v(gbp?.realized as Money)).toBeCloseTo(4.6, 10);
    expect(v(gbp?.commissions as Money)).toBeCloseTo(0.4, 10);
    expect(v(gbp?.value as Money)).toBe(2431);
    const usd = rows.find((r) => r.ccy === "USD");
    expect(v(usd?.dividendsNet as Money)).toBeCloseTo(2.21, 10);
    expect(v(usd?.commissions as Money)).toBeCloseTo(1.7, 10);
    const eur = rows.find((r) => r.ccy === "EUR");
    expect(v(eur?.otherCosts as Money)).toBeCloseTo(2, 10);
  });

  it("no positions and no history give honest zeros only where the data is genuinely empty", () => {
    const m = build({ view: makeView([]), data: makeData({ lots: [], cash: [], trades: [], positions: [], nav: [] }) });
    expect(v(m.realized.base)).toBe(0);
    expect(v(m.dividends.net)).toBe(0);
    expect(v(m.costBasis)).toBe(0);
    expect(m.totalValue.nav.kind).toBe("unavailable");
  });
});
```

`apps/web/src/features/analytics/analytics-model.ts`:

```ts
// Figures of the Analytics page and their definitions (spec 12.9, 4.9). Pure: all inputs are arguments.
import {
  type CashTx, type FlexRateRow, type Money, afterOtherCosts, combinedPerformance, commissionSummary, convertMoney, dividendSummary, flexRateFor,
  ok, otherCostsSummary, performanceSeries, realizedSummary, sumInBase, unavailable,
} from "@core/accounting.ts";
import type { PortfolioView } from "@core/portfolio-view.ts";
import { formatSessionDate } from "@/lib/format";
import type { AnalyticsData } from "./analytics-data";

export interface PerCurrencyRow {
  ccy: string;
  realized: Money;
  dividendsGross: Money;
  dividendsWithholding: Money;
  dividendsNet: Money;
  commissions: Money;
  otherCosts: Money;
  cost: Money;
  value: Money;
  unrealized: Money;
}

export interface AnalyticsModel {
  totalValue: { nav: Money; navDate: string | null; calculated: Money };
  costBasis: Money;
  unrealized: { calculated: Money; broker: Money };
  realized: { base: Money; byCcy: Record<string, number>; lotCount: number };
  dividends: { gross: Money; withholding: Money; net: Money };
  costs: { commissions: Money; other: Money };
  combined: Money;
  combinedAfterOtherCosts: Money;
  historical: ReturnType<typeof performanceSeries>;
  navPoints: Array<{ date: string; value: number }>;
  perCurrency: PerCurrencyRow[];
  coverage: string;
  includeDividends: boolean;
}

export function coverageText(from: string | null, to: string | null): string {
  if (from === null) return "No statement history is loaded yet.";
  const start = formatSessionDate(from);
  const range = to === null ? `from ${start}` : `from ${start} to ${formatSessionDate(to)}`;
  return `History loaded ${range} — earlier activity is not included. Realized P&L may be incomplete before ${start}.`;
}

const rowRate = (fx: number | null, date: string) => (fx === null ? null : { rate: fx, rateDate: date, source: "flex" as const });

function commissionRows(data: AnalyticsData, base: string) {
  return data.trades
    .filter((t): t is typeof t & { commission: number } => t.commission !== null)
    .map((t) => {
      const fx = t.commissionCcy === t.tradeCcy ? t.fxToBase : (flexRateFor(data.fxRates as FlexRateRow[], t.commissionCcy, base, t.tradeDate)?.rate ?? null);
      return { commission: t.commission, ccy: t.commissionCcy, fxToBase: fx };
    });
}

/** NAV rows oldest first, as chart points. */
export function navSeries(nav: readonly { date: string; total: number }[]): Array<{ date: string; value: number }> {
  return [...nav].sort((a, b) => (a.date < b.date ? -1 : 1)).map((n) => ({ date: n.date, value: n.total }));
}

export function buildAnalytics(i: { base: string; includeDividends: boolean; view: PortfolioView | null; data: AnalyticsData }): AnalyticsModel {
  const { base, data, view } = i;
  const lastNav = [...data.nav].sort((a, b) => (a.date < b.date ? -1 : 1)).at(-1);
  const navDate = lastNav?.date ?? null;

  const costItems = data.positions.map((p) =>
    p.costBasisMoney === null ? unavailable("Cost basis missing in the statement") : convertMoney(p.costBasisMoney, p.ccy, base, rowRate(p.fxToBase, navDate ?? "")),
  );
  const brokerUnrealized = data.positions.map((p) =>
    p.fifoUnrealized === null ? unavailable("FIFO unrealized P&L missing in the statement") : convertMoney(p.fifoUnrealized, p.ccy, base, rowRate(p.fxToBase, navDate ?? "")),
  );

  const realized = realizedSummary(data.lots, base);
  const dividends = dividendSummary(data.cash, base);
  const commissions = commissionSummary(commissionRows(data, base), base);
  const other = otherCostsSummary(data.cash, base);

  const calculatedUnrealized: Money = view === null ? unavailable("Positions are not valued yet") : view.totals.unrealizedBase;
  const combined = combinedPerformance({ realized: realized.realizedBase, unrealized: calculatedUnrealized, dividendsNet: dividends.netBase, includeDividends: i.includeDividends });

  const currencies = new Set<string>();
  for (const l of data.lots) currencies.add(l.ccy);
  for (const c of data.cash) currencies.add(c.ccy);
  for (const t of data.trades) currencies.add(t.commissionCcy);
  for (const c of view?.perCurrency ?? []) currencies.add(c.ccy);
  const perCurrency: PerCurrencyRow[] = [...currencies].sort().map((ccy) => {
    const cash = data.cash.filter((c) => c.ccy === ccy);
    const div = dividendSummary(cash, ccy);
    const realizedNative = realized.byCcy[ccy];
    const held = view?.perCurrency.find((c) => c.ccy === ccy);
    return {
      ccy,
      realized: ok(realizedNative ?? 0, ccy),
      dividendsGross: div.grossBase,
      dividendsWithholding: div.withholdingBase,
      dividendsNet: div.netBase,
      commissions: commissionSummary(commissionRows({ ...data, trades: data.trades.filter((t) => t.commissionCcy === ccy) }, ccy), ccy),
      otherCosts: otherCostsSummary(cash, ccy),
      cost: held?.cost ?? ok(0, ccy),
      value: held?.value ?? ok(0, ccy),
      unrealized: held?.unrealized ?? ok(0, ccy),
    };
  });

  const flows: CashTx[] = data.cash;
  return {
    totalValue: {
      nav: lastNav === undefined ? unavailable("No NAV row in the loaded statements") : ok(lastNav.total, lastNav.ccy),
      navDate,
      calculated: view === null ? unavailable("Positions are not valued yet") : view.totals.valueBase,
    },
    costBasis: sumInBase(costItems, { ccy: base }),
    unrealized: { calculated: calculatedUnrealized, broker: sumInBase(brokerUnrealized, { ccy: base }) },
    realized: { base: realized.realizedBase, byCcy: realized.byCcy, lotCount: realized.lotCount },
    dividends: { gross: dividends.grossBase, withholding: dividends.withholdingBase, net: dividends.netBase },
    costs: { commissions, other },
    combined,
    combinedAfterOtherCosts: afterOtherCosts(combined, other),
    historical: performanceSeries(data.nav, flows, base, { flowsComplete: !data.hasUnvaluedTransfers }),
    navPoints: navSeries(data.nav),
    perCurrency,
    coverage: coverageText(data.coverageFrom, data.lastStatementDate),
    includeDividends: i.includeDividends,
  };
}
```

Run: `bun run test:web features/analytics/analytics-model`
Expected: PASS (15 tests). If a numeric assertion is off by rounding, compare with the closed form in the test, not with the rendered text: the model is double arithmetic and `toBeCloseTo(..., 8)` is the contract.

- [ ] **Step 3: Components (tests first)**

`apps/web/src/features/analytics/components/kpi-card.test.tsx`:

```tsx
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { KpiCard } from "./kpi-card";

describe("KpiCard", () => {
  it("shows the title, the content and a provenance badge in text for each origin", () => {
    render(
      <KpiCard title="Cost basis" provenance={["broker"]}>
        <p>4,716.56 EUR</p>
      </KpiCard>,
    );
    const card = screen.getByRole("article", { name: "Cost basis" });
    expect(within(card).getByText("4,716.56 EUR")).toBeTruthy();
    expect(within(card).getByText("Broker-reported")).toBeTruthy();
  });

  it("a card may carry both origins and a note", () => {
    render(
      <KpiCard title="Total portfolio value" provenance={["broker", "calculated"]} note="NAV is the statement value.">
        <p>x</p>
      </KpiCard>,
    );
    expect(screen.getByText("Broker-reported")).toBeTruthy();
    expect(screen.getByText("Calculated by this app")).toBeTruthy();
    expect(screen.getByText("NAV is the statement value.")).toBeTruthy();
  });
});
```

`apps/web/src/features/analytics/components/kpi-card.tsx`:

```tsx
import type { ReactNode } from "react";
import { type Provenance, ProvenanceBadge } from "../../portfolio/provenance";

export function KpiCard({ title, provenance, note, children }: { title: string; provenance: Provenance[]; note?: string; children: ReactNode }) {
  const id = `kpi-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  return (
    <article aria-labelledby={id} className="space-y-2 rounded-md border p-3">
      <h3 id={id} className="text-sm font-medium text-muted-foreground">{title}</h3>
      <div className="space-y-1 text-sm">{children}</div>
      {note !== undefined ? <p className="text-xs text-muted-foreground">{note}</p> : null}
      <footer className="flex flex-wrap gap-1">
        {provenance.map((p) => (
          <ProvenanceBadge key={p} kind={p} />
        ))}
      </footer>
    </article>
  );
}
```

`apps/web/src/features/analytics/components/dividend-toggle.tsx`:

```tsx
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";

export function DividendToggle({ checked, onChange }: { checked: boolean; onChange(v: boolean): void }) {
  return (
    <div className="flex items-center gap-2">
      <Switch id="include-dividends" checked={checked} onCheckedChange={onChange} />
      <Label htmlFor="include-dividends">Include dividends in combined realized performance</Label>
    </div>
  );
}
```

`apps/web/src/features/analytics/components/currency-table.test.tsx`:

```tsx
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { makeView } from "../../portfolio/page/test-fixtures";
import { buildAnalytics } from "../analytics-model";
import { makeData } from "../test-fixtures";
import { CurrencyTable } from "./currency-table";

describe("CurrencyTable", () => {
  it("one row per currency in its own unit, with a caption that says nothing is converted", () => {
    const m = buildAnalytics({ base: "EUR", includeDividends: false, view: makeView(), data: makeData() });
    render(<CurrencyTable rows={m.perCurrency} />);
    const table = screen.getByRole("table", { name: /Per-currency breakdown/ });
    expect(within(table).getAllByRole("row")).toHaveLength(4);
    expect(within(table).getByText("+4.60 GBP")).toBeTruthy();
    expect(within(table).getByText("2,431.00 GBP")).toBeTruthy();
    expect(within(table).getByText("+2.21 USD")).toBeTruthy();
    expect(screen.getByText(/not converted/i)).toBeTruthy();
  });

  it("an unavailable cell is a dash with the reason, never 0", () => {
    const first = buildAnalytics({ base: "EUR", includeDividends: false, view: makeView(), data: makeData() }).perCurrency[0];
    if (first === undefined) throw new Error("no row");
    const rows = [{ ...first, commissions: { kind: "unavailable" as const, reason: "Missing FX rate CHF->EUR" } }];
    render(<CurrencyTable rows={rows} />);
    expect(screen.getByText("Unavailable: Missing FX rate CHF->EUR")).toBeTruthy();
  });

  it("an empty list renders an explanation", () => {
    render(<CurrencyTable rows={[]} />);
    expect(screen.getByText("No currency has any activity yet.")).toBeTruthy();
  });
});
```
`apps/web/src/features/analytics/components/currency-table.tsx`:

```tsx
import { MoneyText } from "../../portfolio/money-text";
import type { PerCurrencyRow } from "../analytics-model";

const HEADERS = ["Currency", "Realized P&L", "Dividends gross", "Withholding", "Dividends net", "Commissions", "Other costs", "Cost basis", "Market value", "Unrealized P&L"];

export function CurrencyTable({ rows }: { rows: readonly PerCurrencyRow[] }) {
  if (rows.length === 0) return <p className="text-sm text-muted-foreground">No currency has any activity yet.</p>;
  return (
    <div className="overflow-x-auto">
      <table aria-label="Per-currency breakdown" className="w-full text-sm">
        <caption className="mb-1 text-left text-xs text-muted-foreground">Native currencies, not converted: each row is in its own unit.</caption>
        <thead>
          <tr>
            {HEADERS.map((h, i) => (
              <th key={h} scope="col" className={`px-2 py-1 font-medium ${i === 0 ? "text-left" : "text-right"}`}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.ccy} className="border-t">
              <th scope="row" className="px-2 py-1 text-left font-medium">{r.ccy}</th>
              <td className="px-2 py-1 text-right"><MoneyText money={r.realized} signed /></td>
              <td className="px-2 py-1 text-right"><MoneyText money={r.dividendsGross} /></td>
              <td className="px-2 py-1 text-right"><MoneyText money={r.dividendsWithholding} signed /></td>
              <td className="px-2 py-1 text-right"><MoneyText money={r.dividendsNet} signed /></td>
              <td className="px-2 py-1 text-right"><MoneyText money={r.commissions} /></td>
              <td className="px-2 py-1 text-right"><MoneyText money={r.otherCosts} /></td>
              <td className="px-2 py-1 text-right"><MoneyText money={r.cost} /></td>
              <td className="px-2 py-1 text-right"><MoneyText money={r.value} /></td>
              <td className="px-2 py-1 text-right"><MoneyText money={r.unrealized} signed /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

`apps/web/src/features/analytics/components/nav-chart.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NavChart } from "./nav-chart";

const series = { setData: vi.fn() };
const chart = { addSeries: vi.fn(() => series), timeScale: vi.fn(() => ({ fitContent: vi.fn() })), remove: vi.fn() };
const createChart = vi.fn(() => chart);
vi.mock("lightweight-charts", () => ({ createChart: (...a: unknown[]) => (createChart as (...x: unknown[]) => unknown)(...a), LineSeries: "line-series" }));

beforeEach(() => {
  series.setData.mockClear();
  chart.addSeries.mockClear();
  chart.remove.mockClear();
  createChart.mockClear();
});

const points = [{ date: "2026-10-13", value: 9800.55 }, { date: "2026-10-14", value: 9950.2 }];

describe("NavChart", () => {
  it("draws a single line of the NAV when there are at least two statement days", () => {
    const { unmount } = render(<NavChart points={points} currency="EUR" />);
    expect(createChart).toHaveBeenCalledTimes(1);
    expect(chart.addSeries).toHaveBeenCalledWith("line-series", expect.objectContaining({ lineWidth: 2 }));
    expect(series.setData).toHaveBeenCalledWith([{ time: "2026-10-13", value: 9800.55 }, { time: "2026-10-14", value: 9950.2 }]);
    unmount();
    expect(chart.remove).toHaveBeenCalledTimes(1);
  });

  it("gives screen readers a table alternative with the dates and values", () => {
    render(<NavChart points={points} currency="EUR" />);
    expect(screen.getByRole("table", { name: "NAV history (data)" })).toBeTruthy();
    expect(screen.getByText("9,950.20 EUR")).toBeTruthy();
  });

  it("one row (or none) is not a line: it says so and creates no chart", () => {
    render(<NavChart points={[points[0] as (typeof points)[number]]} currency="EUR" />);
    expect(screen.getByText("Not enough NAV history yet: a line needs at least two statement days.")).toBeTruthy();
    expect(createChart).not.toHaveBeenCalled();
  });
});
```

`apps/web/src/features/analytics/components/nav-chart.tsx`:

```tsx
import { LineSeries, createChart } from "lightweight-charts";
import { useEffect, useRef } from "react";
import { formatAmount } from "../../portfolio/money-text";

export interface NavPointView {
  date: string;
  value: number;
}

/** One line (NAV in the base currency per statement day). The chart is decoration for sighted users; the table below is the data. */
export function NavChart({ points, currency }: { points: readonly NavPointView[]; currency: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (points.length < 2 || ref.current === null) return;
    const dark = document.documentElement.classList.contains("dark");
    const chart = createChart(ref.current, {
      autoSize: true,
      height: 260,
      layout: { background: { color: "transparent" }, textColor: dark ? "#d4d4d8" : "#3f3f46" },
      grid: { vertLines: { visible: false }, horzLines: { color: dark ? "#27272a" : "#e4e4e7" } },
      rightPriceScale: { borderVisible: false },
      timeScale: { borderVisible: false },
    });
    const line = chart.addSeries(LineSeries, { color: dark ? "#7aa2ff" : "#1d4ed8", lineWidth: 2, priceFormat: { type: "price", precision: 2, minMove: 0.01 } });
    line.setData(points.map((p) => ({ time: p.date, value: p.value })));
    chart.timeScale().fitContent();
    return () => chart.remove();
  }, [points]);

  if (points.length < 2) {
    return <p className="text-sm text-muted-foreground">Not enough NAV history yet: a line needs at least two statement days.</p>;
  }
  return (
    <figure className="space-y-2">
      <div ref={ref} role="img" aria-label={`Net asset value in ${currency} by statement day, from ${points[0]?.date} to ${points.at(-1)?.date}`} className="h-[260px] w-full" />
      <figcaption className="text-xs text-muted-foreground">{`Net asset value in ${currency}, one point per statement day (broker-reported).`}</figcaption>
      <table aria-label="NAV history (data)" className="sr-only">
        <tbody>
          {points.map((p) => (
            <tr key={p.date}>
              <th scope="row">{p.date}</th>
              <td>{`${formatAmount(p.value)} ${currency}`}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}
```

Run: `bun run test:web features/analytics/components`
Expected: PASS (kpi-card 2, currency-table 3, nav-chart 3).

- [ ] **Step 4: The page, wiring and page tests**

`apps/web/src/features/analytics/analytics-page.test.tsx`:

```tsx
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { signedIn } from "@/test/auth-fixtures";
import { renderApp } from "@/test/render-app";
import { NotLinkedError } from "../portfolio/portfolio-api";
import { makeResponse, makeView, na } from "../portfolio/page/test-fixtures";
import { makeData } from "./test-fixtures";

const get = vi.fn();
const load = vi.fn();
vi.mock("@/features/portfolio/default", () => ({ portfolioApi: { get: (...a: unknown[]) => get(...a), refresh: vi.fn() } }));
vi.mock("@/features/analytics/default", () => ({ analyticsApi: { load: (...a: unknown[]) => load(...a) } }));
const createChart = vi.fn(() => ({ addSeries: () => ({ setData: vi.fn() }), timeScale: () => ({ fitContent: vi.fn() }), remove: vi.fn() }));
vi.mock("lightweight-charts", () => ({ createChart: (...a: unknown[]) => (createChart as (...x: unknown[]) => unknown)(...a), LineSeries: "line-series" }));

beforeEach(() => {
  get.mockReset();
  load.mockReset();
  createChart.mockClear();
  get.mockResolvedValue(makeResponse());
  load.mockResolvedValue(makeData());
});

const card = (name: string) => screen.getByRole("article", { name });

describe("AnalyticsPage", () => {
  it("not linked: the link prompt with a button to Profile -> Broker", async () => {
    get.mockRejectedValue(new NotLinkedError());
    await renderApp("/analytics", signedIn());
    expect(await screen.findByText("No broker is linked")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Link your broker" }).getAttribute("href")).toBe("/profile/broker");
  });

  it("shows every figure with its origin: broker-reported or calculated by this app", async () => {
    await renderApp("/analytics", signedIn());
    expect(await screen.findByRole("heading", { level: 1, name: "Analytics" })).toBeTruthy();
    const total = await screen.findByRole("article", { name: "Total portfolio value" });
    expect(within(total).getByText("9,950.20 EUR")).toBeTruthy();
    expect(within(total).getByText("4,977.56 EUR")).toBeTruthy();
    for (const name of ["Total portfolio value", "Cost basis of current positions", "Unrealized P&L", "Realized trading P&L", "Dividends", "Commissions and other costs", "Combined performance", "Historical performance"]) {
      const c = card(name);
      expect(within(c).queryByTestId("provenance-broker") !== null || within(c).queryByTestId("provenance-calculated") !== null).toBe(true);
    }
    expect(within(card("Combined performance")).getByTestId("provenance-calculated")).toBeTruthy();
    expect(within(card("Realized trading P&L")).getByTestId("provenance-broker")).toBeTruthy();
  });

  it("unrealized P&L: calculated (current prices) and broker FIFO side by side; realized from the closed lots of the partial sale", async () => {
    await renderApp("/analytics", signedIn());
    const unrealized = await screen.findByRole("article", { name: "Unrealized P&L" });
    expect(within(unrealized).getByText("+215.98 EUR")).toBeTruthy();
    expect(within(unrealized).getByText(/Broker FIFO at the statement close/)).toBeTruthy();
    const realized = card("Realized trading P&L");
    expect(within(realized).getByText("+5.29 EUR")).toBeTruthy();
    expect(within(realized).getByText(/2 closed lots/)).toBeTruthy();
    expect(within(realized).getByText(/Commissions are already netted by IBKR and are not subtracted again/)).toBeTruthy();
  });

  it("dividends gross, withholding and net, and the commission memo versus other costs", async () => {
    await renderApp("/analytics", signedIn());
    const div = await screen.findByRole("article", { name: "Dividends" });
    expect(within(div).getByText("Gross")).toBeTruthy();
    expect(within(div).getByText("2.39 EUR")).toBeTruthy();
    expect(within(div).getByText("-0.36 EUR")).toBeTruthy();
    expect(within(div).getByText("+2.03 EUR")).toBeTruthy();
    const costs = card("Commissions and other costs");
    expect(within(costs).getByText(/already inside the realized P&L/)).toBeTruthy();
    expect(within(costs).getByText("2.02 EUR")).toBeTruthy();
    expect(within(costs).getByText("2.00 EUR")).toBeTruthy();
  });

  it("the toggle includes the net dividends in the combined figure and the label says which it is", async () => {
    await renderApp("/analytics", signedIn());
    const combined = await screen.findByRole("article", { name: "Combined performance" });
    expect(within(combined).getByText("+221.27 EUR")).toBeTruthy();
    expect(within(combined).getByText(/dividends excluded/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("switch", { name: "Include dividends in combined realized performance" }));
    await waitFor(() => expect(within(card("Combined performance")).getByText("+223.30 EUR")).toBeTruthy());
    expect(within(card("Combined performance")).getByText(/dividends included/i)).toBeTruthy();
    expect(within(card("Combined performance")).getByText("+221.30 EUR")).toBeTruthy(); // after other costs
  });

  it("the coverage disclosure states the loaded period", async () => {
    await renderApp("/analytics", signedIn());
    expect(await screen.findByText("History loaded from 15 Oct 2025 to 14 Oct 2026 — earlier activity is not included. Realized P&L may be incomplete before 15 Oct 2025.")).toBeTruthy();
  });

  it("an unavailable input makes the combined figure a dash with the reason, never 0", async () => {
    get.mockResolvedValue(makeResponse({ view: makeView(undefined, { totals: { ...makeView().totals, unrealizedBase: na("Missing FX rate USD->EUR") } }) }));
    await renderApp("/analytics", signedIn());
    const combined = await screen.findByRole("article", { name: "Combined performance" });
    expect(within(combined).getAllByText("Unavailable: Missing FX rate USD->EUR").length).toBeGreaterThan(0);
    expect(within(combined).queryByText(/^\+?0\.00 EUR/)).toBeNull();
  });

  it("per-currency breakdown and the NAV chart (two rows) are shown", async () => {
    await renderApp("/analytics", signedIn());
    expect(await screen.findByRole("table", { name: /Per-currency breakdown/ })).toBeTruthy();
    await waitFor(() => expect(createChart).toHaveBeenCalled());
    expect(screen.getByRole("table", { name: "NAV history (data)" })).toBeTruthy();
  });

  it("with fewer than two NAV rows the chart says so", async () => {
    load.mockResolvedValue(makeData({ nav: [{ date: "2026-10-14", total: 9950.2, ccy: "EUR" }] }));
    await renderApp("/analytics", signedIn());
    expect(await screen.findByText("Not enough NAV history yet: a line needs at least two statement days.")).toBeTruthy();
    expect(createChart).not.toHaveBeenCalled();
  });

  it("transfers that are not valued make the historical performance unavailable with a reason", async () => {
    load.mockResolvedValue(makeData({ hasUnvaluedTransfers: true }));
    await renderApp("/analytics", signedIn());
    const hist = await screen.findByRole("article", { name: "Historical performance" });
    expect(within(hist).getByText("Unavailable: Transfers or other flows are not valued")).toBeTruthy();
  });

  it("history failing to load shows an error with Retry while the refresh bar stays", async () => {
    load.mockRejectedValue(new Error("Could not load the statement history."));
    await renderApp("/analytics", signedIn());
    expect(await screen.findByText("Could not load the statement history.", {}, { timeout: 4000 })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(screen.getByLabelText("Refresh status")).toBeTruthy();
  });

  it("a failed portfolio refresh keeps the figures and shows the error banner", async () => {
    const { queryClient } = await renderApp("/analytics", signedIn());
    await screen.findByRole("article", { name: "Combined performance" });
    get.mockRejectedValue(new Error("Network error: could not reach the server."));
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: ["portfolio"] }).catch(() => undefined);
    });
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Network error: could not reach the server."), { timeout: 4000 });
    expect(card("Combined performance")).toBeTruthy();
  });
});
```

Rounding in the expectations above: displayed values are rounded to two decimals; `2.39 EUR` is 2.392, `-0.36 EUR` is -0.3588, `+2.03 EUR` is 2.0332, `2.02 EUR` is 2.024, `+221.27 EUR` is 5.29 + 215.98 (5.29 = 4.6 * 1.15), `+223.30 EUR` is 223.3032, `+221.30 EUR` is 221.3032 (after other costs 2.00).

`apps/web/src/features/analytics/analytics-page.tsx`:

```tsx
import { Link } from "@tanstack/react-router";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { EmptyState, ErrorState, Loading } from "@/components/data-state/data-state";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { MoneyText } from "../portfolio/money-text";
import { NotLinkedError } from "../portfolio/portfolio-api";
import { RefreshBar } from "../portfolio/refresh-bar";
import { usePortfolio } from "../portfolio/use-portfolio";
import { buildAnalytics, navSeries } from "./analytics-model";
import { CurrencyTable } from "./components/currency-table";
import { DividendToggle } from "./components/dividend-toggle";
import { KpiCard } from "./components/kpi-card";
import { NavChart } from "./components/nav-chart";
import { useAnalyticsData } from "./use-analytics";

function NotLinked() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>No broker is linked</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p>Analytics need your IBKR statements. Link your account (read-only, end-of-day data) to see performance, dividends and costs.</p>
        <Button asChild>
          <Link to="/profile/broker">Link your broker</Link>
        </Button>
      </CardContent>
    </Card>
  );
}

function Line({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      <span>{children}</span>
    </div>
  );
}

export function AnalyticsPage() {
  useEffect(() => {
    document.title = "Analytics - Stock Screener";
  }, []);
  const [includeDividends, setIncludeDividends] = useState(false);
  const portfolio = usePortfolio();
  const tables = useAnalyticsData({ enabled: portfolio.data !== undefined });
  const view = portfolio.data?.view ?? null;
  const base = portfolio.data?.baseCurrency ?? tables.data?.baseCurrency ?? "";
  const model = useMemo(() => (tables.data === undefined ? null : buildAnalytics({ base, includeDividends, view, data: tables.data })), [tables.data, base, includeDividends, view]);

  const navPoints = useMemo(() => (tables.data === undefined ? [] : navSeries(tables.data.nav)), [tables.data]);

  let body: ReactNode;
  if (portfolio.isLoading) body = <Loading label="Loading analytics" rows={6} />;
  else if (portfolio.data === undefined && portfolio.error instanceof NotLinkedError) body = <NotLinked />;
  else if (portfolio.data === undefined) body = <ErrorState message={portfolio.error instanceof Error ? portfolio.error.message : "Could not load the portfolio."} onRetry={() => void portfolio.refetch()} />;
  else {
    body = (
      <>
        <RefreshBar data={portfolio.data} error={portfolio.error instanceof Error ? portfolio.error : null} fetching={portfolio.isFetching} />
        {tables.isLoading ? <Loading label="Loading statement history" rows={4} /> : null}
        {tables.isError && model === null ? <ErrorState message="Could not load the statement history." onRetry={() => void tables.refetch()} /> : null}
        {model !== null ? (
          <>
            <p className="text-sm">{model.coverage}</p>
            <DividendToggle checked={includeDividends} onChange={setIncludeDividends} />
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
              <KpiCard title="Total portfolio value" provenance={["broker", "calculated"]} note="NAV is the broker's statement value; the second line values the positions at delayed prices.">
                <Line label={model.totalValue.navDate === null ? "NAV" : `NAV at ${model.totalValue.navDate}`}><MoneyText money={model.totalValue.nav} /></Line>
                <Line label="Positions at delayed prices"><MoneyText money={model.totalValue.calculated} /></Line>
              </KpiCard>
              <KpiCard title="Cost basis of current positions" provenance={["broker"]} note="Flex cost basis converted with the Flex rates of the statement.">
                <Line label="Cost basis"><MoneyText money={model.costBasis} /></Line>
              </KpiCard>
              <KpiCard title="Unrealized P&L" provenance={["calculated", "broker"]} note="Broker FIFO at the statement close is the authoritative statement figure; the calculated figure uses current prices.">
                <Line label="Calculated"><MoneyText money={model.unrealized.calculated} signed /></Line>
                <Line label="Broker FIFO at the statement close"><MoneyText money={model.unrealized.broker} signed /></Line>
              </KpiCard>
              <KpiCard title="Realized trading P&L" provenance={["broker"]} note="Commissions are already netted by IBKR and are not subtracted again.">
                <Line label="Realized (closed lots, base currency)"><MoneyText money={model.realized.base} signed /></Line>
                <p className="text-xs text-muted-foreground">{`Re-summed from ${model.realized.lotCount} closed lot${model.realized.lotCount === 1 ? "" : "s"}, partial sales included.`}</p>
              </KpiCard>
              <KpiCard title="Dividends" provenance={["broker"]} note="Broker rows aggregated by this app; kept separate from trading P&L.">
                <Line label="Gross"><MoneyText money={model.dividends.gross} /></Line>
                <Line label="Withholding tax"><MoneyText money={model.dividends.withholding} /></Line>
                <Line label="Net"><MoneyText money={model.dividends.net} signed /></Line>
              </KpiCard>
              <KpiCard title="Commissions and other costs" provenance={["broker"]}>
                <Line label="Commissions (memo)"><MoneyText money={model.costs.commissions} /></Line>
                <p className="text-xs text-muted-foreground">Commissions are already inside the realized P&L and are not deducted again.</p>
                <Line label="Other costs (fees and interest)"><MoneyText money={model.costs.other} /></Line>
              </KpiCard>
              <KpiCard title="Combined performance" provenance={["calculated"]} note={includeDividends ? "Realized plus unrealized plus net dividends (dividends included)." : "Realized plus unrealized (dividends excluded)."}>
                <Line label="Combined"><MoneyText money={model.combined} signed /></Line>
                <Line label="After other costs"><MoneyText money={model.combinedAfterOtherCosts} signed /></Line>
              </KpiCard>
              <KpiCard title="Historical performance" provenance={["calculated"]} note="NAV minus cumulative net deposits and withdrawals since the first NAV day.">
                <Line label="Since the first NAV day">
                  <MoneyText money={model.historical.kind === "ok" ? { kind: "ok", value: model.historical.points.at(-1)?.performance ?? 0, ccy: base } : { kind: "unavailable", reason: model.historical.reason }} signed />
                </Line>
              </KpiCard>
            </div>
            <Card>
              <CardHeader>
                <CardTitle>Per-currency breakdown</CardTitle>
              </CardHeader>
              <CardContent>
                <CurrencyTable rows={model.perCurrency} />
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>NAV history</CardTitle>
              </CardHeader>
              <CardContent>
                <NavChart points={navPoints} currency={base} />
              </CardContent>
            </Card>
          </>
        ) : null}
        {portfolio.data.view.positions.length === 0 && model === null && !tables.isLoading && !tables.isError ? <EmptyState title="Nothing to analyse yet." description="Figures appear after the first statement is loaded." /> : null}
      </>
    );
  }

  return (
    <section aria-labelledby="page-title" className="space-y-6">
      <h1 id="page-title" className="text-2xl font-semibold tracking-tight">
        Analytics
      </h1>
      {body}
    </section>
  );
}
```

Wiring (after Task 7's wiring step): in `apps/web/src/features/pages.tsx` delete the `AnalyticsPage` placeholder; in `apps/web/src/router.tsx` remove `AnalyticsPage` from the `@/features/pages` import and add `import { AnalyticsPage } from "@/features/analytics/analytics-page";` (the existing `guarded(AnalyticsPage)` stays). If both placeholders are gone, delete `pages.tsx` imports of `PagePlaceholder` that became unused.

Run: `bun run test:web features/analytics` then `bun run test:web`
Expected: PASS. Two notes: (1) rendered cells show two decimals; the arithmetic assertions of the model test use closed forms with 8 digits; (2) the first test of `analytics-page.test.tsx` shares the `NotLinked` wording with the Portfolio page on purpose (`No broker is linked`, button `Link your broker`).

- [ ] **Step 5: Lint, typecheck, commit**

Run: `bun run lint:fix`, `bun run lint`, `bun run typecheck`, `bun run test:web`
Expected: exit 0.

```text
git add apps/web/src/features/analytics apps/web/src/features/pages.tsx apps/web/src/router.tsx
git commit -m "feat(web): add Analytics page with provenance labels, dividend toggle, coverage disclosure and NAV chart"
```

---

## Task 9: Integration test and operator guide

**Concurrency:** after Tasks 1 to 8 (it exercises the whole stack). Nothing runs in parallel with it.

**Files:**
- Create: `tools/test-broker-integration.ts`
- Modify: root `package.json` (script `test:integration:broker`; if P1's `test:integration` script exists, append `&& bun run test:integration:broker` to it), `supabase/functions/.env.example` (a comment line only)
- Modify: `docs/operator-guide.md` (section 5 and section 10; the other sections stay untouched)

**Interfaces:** consumes the served functions `broker-sync` (worker mode `ingest_fixture`, needs `FLEX_FIXTURE_MODE=1`, local URL only) and `portfolio-refresh`, the fixture `supabase/functions/_shared/adapters/fixtures/flex/activity-sample.xml`, the local stack. Produces the Review-Focus pins 2 and 4 against a real database (no duplicate lots on re-run; parallel manual refresh: one 200, four 429).

- [ ] **Step 1: Write the integration script**

Environment (PowerShell, from the repository root, with the stack and the functions running):

```powershell
bun run supabase:start
bunx supabase status -o env   # copy API_URL, ANON_KEY, SERVICE_ROLE_KEY
# supabase/functions/.env must contain CRON_SHARED_SECRET, FLEX_ENC_KEY_V1, FLEX_USER_AGENT and FLEX_FIXTURE_MODE=1
bun run supabase:serve
```

`tools/test-broker-integration.ts`:

```ts
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const url = process.env["SUPABASE_URL"] ?? "http://127.0.0.1:54321";
const service = process.env["SUPABASE_SERVICE_ROLE_KEY"] ?? "";
const anon = process.env["SUPABASE_ANON_KEY"] ?? "";
const cron = process.env["CRON_SHARED_SECRET"] ?? "";
if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(url)) throw new Error("refusing to run against a non-local Supabase URL");
if (service === "" || anon === "" || cron === "") throw new Error("set SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY and CRON_SHARED_SECRET (bunx supabase status -o env)");

const xml = readFileSync(new URL("../supabase/functions/_shared/adapters/fixtures/flex/activity-sample.xml", import.meta.url), "utf8");
const admin = createClient(url, service, { auth: { persistSession: false } });
let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok || detail === "" ? "" : `: ${detail}`}`);
  if (!ok) failures += 1;
};

async function makeUser(label: string) {
  const email = `p5b-${label}-${crypto.randomUUID().slice(0, 8)}@example.test`;
  const password = `Pw-${crypto.randomUUID()}`;
  const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (created.error || !created.data.user) throw new Error(`createUser ${label}`);
  const client = createClient(url, anon, { auth: { persistSession: false } });
  const signed = await client.auth.signInWithPassword({ email, password });
  if (signed.error || !signed.data.session) throw new Error(`signIn ${label}`);
  return { id: created.data.user.id, client, jwt: signed.data.session.access_token };
}

async function count(client: ReturnType<typeof createClient>, table: string, userId?: string): Promise<number> {
  let q = client.from(table).select("id", { count: "exact", head: true });
  if (userId !== undefined) q = q.eq("user_id", userId);
  const { count: n, error } = await q;
  if (error) throw new Error(`${table}: ${error.code}`);
  return n ?? 0;
}

const post = (fn: string, body: unknown, headers: Record<string, string>) =>
  fetch(`${url}/functions/v1/${fn}`, { method: "POST", headers: { "content-type": "application/json", apikey: anon, ...headers }, body: JSON.stringify(body) });

const a = await makeUser("a");
const b = await makeUser("b");
try {
  // reference data the matcher needs: exchanges, companies and securities with ISINs (the identity stage normally creates them)
  await admin.from("exchanges").upsert([
    { code: "NMS", name: "Nasdaq", country: "United States", timezone: "America/New_York", currencies: ["USD"], ibkr_exchange_id: "NASDAQ", yahoo_suffix: "" },
    { code: "LSE", name: "London Stock Exchange", country: "United Kingdom", timezone: "Europe/London", currencies: ["GBP", "GBp"], ibkr_exchange_id: "LSE", yahoo_suffix: ".L" },
  ], { onConflict: "code" });
  const co1 = await admin.from("companies").insert({ name: "Apple Inc", name_normalized: "apple" }).select("id").single();
  const co2 = await admin.from("companies").insert({ name: "Shell plc", name_normalized: "shell" }).select("id").single();
  const s1 = await admin.from("securities").upsert({ company_id: co1.data?.id, yahoo_symbol: "AAPL", exchange_code: "NMS", currency: "USD", currency_major: "USD", quote_type: "EQUITY", isin: "US0378331005", is_canonical: true }, { onConflict: "yahoo_symbol" }).select("id").single();
  const s2 = await admin.from("securities").upsert({ company_id: co2.data?.id, yahoo_symbol: "SHEL.L", exchange_code: "LSE", currency: "GBp", currency_major: "GBP", minor_divisor: 100, quote_type: "EQUITY", isin: "GB00BP6MXD84", is_canonical: true }, { onConflict: "yahoo_symbol" }).select("id").single();
  check("reference data seeded", Boolean(s1.data && s2.data));

  // fresh delayed quotes in the cache so portfolio-refresh never calls Yahoo
  const future = new Date(Date.now() + 300_000).toISOString();
  const row = (symbol: string, price: number, currency: string, pct: number) => ({ key: `quote:${symbol}`, payload: { symbol, currency, exchange: "X", regularMarketPrice: price, regularMarketTime: Date.now() - 60_000, regularMarketChangePercent: pct, marketState: "REGULAR", fetchedAt: new Date().toISOString(), stale: false }, provider: "yahoo", expires_at: future });
  await admin.from("quote_cache").upsert([row("AAPL", 232, "USD", 1), row("SHEL.L", 2735, "GBp", 0.5), row("USDEUR=X", 0.93, "EUR", 0), row("GBPEUR=X", 1.16, "EUR", 0)], { onConflict: "key" });

  // a linked connection for A (no real token: the fixture path never calls IBKR)
  await admin.from("broker_connections").upsert({ user_id: a.id, status: "linked", query_id: "123456", linked_at: new Date().toISOString() }, { onConflict: "user_id" });

  const ingest = () => post("broker-sync", { action: "ingest_fixture", userId: a.id, xml }, { "x-cron-secret": cron });
  const first = await ingest();
  const firstBody = (await first.json()) as { run?: { state: string } };
  check("fixture statement ingested through broker-sync worker mode", first.status === 200 && firstBody.run?.state === "done", JSON.stringify(firstBody));

  const tables = ["broker_positions", "broker_trades", "broker_closed_lots", "broker_cash_transactions", "broker_fx_rates", "broker_nav"] as const;
  const expected = [2, 3, 2, 4, 2, 2];
  const before: number[] = [];
  for (const [i, t] of tables.entries()) {
    before.push(await count(admin, t, a.id));
    check(`rows in ${t}`, before[i] === expected[i], `${before[i]} != ${expected[i]}`);
  }
  const lots = await admin.from("broker_closed_lots").select("fifo_pnl_realized").eq("user_id", a.id);
  const sum = (lots.data ?? []).reduce((n, r) => n + Number(r.fifo_pnl_realized), 0);
  check("partial-sale lots add up to the execution P/L (4.60)", Math.abs(sum - 4.6) < 1e-9, String(sum));

  const pos = await admin.from("broker_positions").select("symbol,security_id,signal_security_id,match_status").eq("user_id", a.id);
  check("both positions matched by ISIN", (pos.data ?? []).length === 2 && (pos.data ?? []).every((p) => p.match_status === "matched_isin" && p.security_id !== null && p.signal_security_id !== null), JSON.stringify(pos.data));

  await ingest();
  const after: number[] = [];
  for (const t of tables) after.push(await count(admin, t, a.id));
  check("idempotent re-run: no duplicate rows", JSON.stringify(after) === JSON.stringify(before), `${after} vs ${before}`);

  // isolation and secrets
  for (const t of tables) check(`user B sees no ${t} rows`, (await count(b.client, t)) === 0);
  check("user A sees own positions", (await count(a.client, "broker_positions")) === 2);
  const secret = await a.client.from("broker_connections").select("flex_token_ciphertext");
  check("the owner cannot select the token ciphertext", secret.error?.code === "42501", JSON.stringify(secret.error));
  const star = await a.client.from("broker_connections").select("*");
  check("select * on broker_connections is refused", star.error !== null);
  const write = await a.client.from("broker_connections").update({ status: "unlinked" }).eq("user_id", a.id);
  check("clients cannot write the connection", write.error !== null || (await admin.from("broker_connections").select("status").eq("user_id", a.id).single()).data?.status === "linked");

  // portfolio-refresh: auth, valuation, cooldown
  const refresh = (jwt: string, manual: boolean) => fetch(`${url}/functions/v1/portfolio-refresh`, { method: manual ? "POST" : "GET", headers: { authorization: `Bearer ${jwt}`, apikey: anon, "content-type": "application/json" }, ...(manual ? { body: JSON.stringify({ manual: true }) } : {}) });
  check("portfolio-refresh needs a JWT", (await fetch(`${url}/functions/v1/portfolio-refresh`, { headers: { apikey: anon } })).status === 401);
  const g = await refresh(a.jwt, false);
  const gb = (await g.json()) as { view?: { positions: Array<{ ticker: string; price: { value: number } }> } };
  check("GET values the positions with the cached delayed quotes (GBp converted)", g.status === 200 && Math.abs((gb.view?.positions.find((p) => p.ticker === "SHEL")?.price.value ?? 0) - 27.35) < 1e-9, JSON.stringify(gb).slice(0, 200));
  check("user B is not linked", (await refresh(b.jwt, false)).status === 409);

  const m1 = await refresh(a.jwt, true);
  const m2 = await refresh(a.jwt, true);
  check("manual refresh: first 200, second 429 with Retry-After", m1.status === 200 && m2.status === 429 && Number(m2.headers.get("retry-after")) > 0, `${m1.status} ${m2.status}`);

  await admin.from("broker_connections").update({ last_manual_refresh_at: null }).eq("user_id", a.id);
  const burst = await Promise.all(Array.from({ length: 5 }, () => refresh(a.jwt, true)));
  const statuses = burst.map((r) => r.status).sort();
  check("five parallel manual refreshes: exactly one passes", JSON.stringify(statuses) === JSON.stringify([200, 429, 429, 429, 429]), statuses.join(","));

  // the worker endpoint refuses callers without the secret, fixture ingestion needs the secret too
  check("broker-sync tick without the secret is 401", (await post("broker-sync", { action: "tick" }, {})).status === 401);
  check("a user JWT cannot ingest a fixture", (await post("broker-sync", { action: "ingest_fixture", userId: a.id, xml }, { authorization: `Bearer ${a.jwt}` })).status === 403);
} finally {
  await admin.auth.admin.deleteUser(a.id);
  await admin.auth.admin.deleteUser(b.id);
}
if (failures > 0) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
console.log("broker integration: all checks passed");
```

Add to root `package.json` `scripts`: `"test:integration:broker": "bun run tools/test-broker-integration.ts"`. Add a comment line to `supabase/functions/.env.example` above `FLEX_FIXTURE_MODE=`: `# 1 only for the local integration run (refused unless SUPABASE_URL is local)`.

- [ ] **Step 2: Run it (first real end-to-end run of Tasks 1 to 5: expect to debug)**

With the stack and `bun run supabase:serve` running:

```powershell
$env:SUPABASE_URL = "http://127.0.0.1:54321"
$env:SUPABASE_ANON_KEY = "<anon key from supabase status>"
$env:SUPABASE_SERVICE_ROLE_KEY = "<service role key from supabase status>"
$env:CRON_SHARED_SECRET = "<value of CRON_SHARED_SECRET in supabase/functions/.env>"
bun run test:integration:broker
```

Expected: every line `PASS`, final line `broker integration: all checks passed`, exit 0. Typical first-run failures: `app` schema not exposed to PostgREST (P1 added it to `[api] schemas`, check `supabase/config.toml`), `FLEX_FIXTURE_MODE` unset (`ingest_fixture` answers 403), a P1 table with an extra NOT NULL column (the seed inserts list the columns of spec 6.3; add the missing one), and the matcher's `exchanges.ibkr_exchange_id` values (`NASDAQ`, `LSE` as in the fixture).

- [ ] **Step 3: Operator guide section 5 (Flex setup, secrets, key rotation)**

In `docs/operator-guide.md` replace the line `## 5. Set up and verify IBKR Flex (pending P5)` and the empty line below it with:

````markdown
## 5. Set up and verify IBKR Flex (filled in P5b)

Scope: read-only reporting through the IBKR Flex Web Service. The app never places orders, never asks for an IBKR username or password and never stores a token in the browser.

### 5.1 Function secrets

| Secret | Value | Notes |
|---|---|---|
| `FLEX_ENC_KEY_V1` | base64 of exactly 32 random bytes | AES-256-GCM key for the stored Flex tokens. Generate it in PowerShell: `[Convert]::ToBase64String([System.Security.Cryptography.RandomNumberGenerator]::GetBytes(32))` |
| `FLEX_ENC_KEY_CURRENT` | `1` | Version used for new ciphertext; the stored `key_version` selects the key when opening |
| `FLEX_USER_AGENT` | for example `PersonalStockScreener/1.0 (+you@example.com)` | IBKR requires a User-Agent on every Flex request |
| `CRON_SHARED_SECRET` | already set (section 2) | Authenticates the minute tick and the daily cron call of `broker-sync` |

Set them with `bunx supabase secrets set --env-file <file>` (the file is never committed) or in the dashboard. `FLEX_FIXTURE_MODE` must **never** be set on the hosted project.

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
````

- [ ] **Step 4: Operator guide section 10 (inspect syncs and reconcile)**

Replace `## 10. Inspect broker sync status and reconcile analytics (pending P5)` and its empty line with:

````markdown
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
````

- [ ] **Step 5: Commit**

```text
git add tools/test-broker-integration.ts package.json supabase/functions/.env.example docs/operator-guide.md
git commit -m "test(broker): add the local broker integration test and the Flex operator guide sections"
```

---

## Task 10: Phase exit checklist

**Files:** none new; this task only verifies and, if a check demands it, fixes the owning file.

- [ ] **Step 1: Run every automated check (PowerShell, repository root)**

```powershell
bun run lint
bun run typecheck
bun run test:core
bun run test:web
bun run test:tools
bun run functions:check
bun run functions:test
bun run check:functions-config
bun run supabase:reset
bun run test:db
bun run test:integration:broker
bun run build
bun run check:bundle
```

Expected: every command exits 0; `check:bundle` finds no secret in the web bundle (the SPA knows only `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`; it contains no Flex token, no `FLEX_ENC_KEY` and no service-role key).

- [ ] **Step 2: Spec 12 coverage check**

| Spec item | Where it is pinned |
|---|---|
| 12.1 read-only, T+1 never live | `RefreshBar` disclosure, `statement-day.test.ts`, no order code anywhere |
| 12.2 setup instructions and field checklist | `setup-content.ts`, `setup-guide.test.tsx` |
| 12.3 link, test, unlink, token expiry banner, rekey | `service.test.ts`, `handler.test.ts`, `status-card.test.tsx`, `broker-view.test.ts` |
| 12.4 state machine, error codes, limits | `machine.test.ts`, `flex-errors.test.ts`, `flex.test.ts`, pgTAP limiter and active-run index |
| 12.5 parsing targets, fail closed, no raw storage | `flex-parse.test.ts`, `persist.test.ts` (no `raw` in the payload), fixture |
| 12.6 T+1 text | `statement-day.test.ts` exact string, `refresh-bar.test.tsx` |
| 12.7 matching | `matching.test.ts` (ISIN, search, symbol plus exchange, never guesses, ETF, canonical signal line) |
| 12.8 valuation and refresh rules, cooldown, failure rule | `portfolio-view.test.ts`, `handler.test.ts` (five parallel requests), `use-manual-refresh.test.tsx`, `use-portfolio.test.tsx`, pgTAP `claim_manual_refresh`, integration burst |
| 12.9 analytics definitions, toggle, coverage | `accounting.test.ts`, `analytics-model.test.ts`, `analytics-page.test.tsx` |
| 12.10 privacy | `persist.test.ts`, allow-listed `publicConnection`/`publicRun`, `redact`-safe event fields, handler 500 without details |
| 6.3.6, 6.8, 6.9 schema, secret columns, RLS | `0500_broker_schema.test.sql`, integration isolation checks |
| 7.1 daily cron guards (A-33) | pgTAP `start_daily_broker_syncs` on summer, winter and 2026-10-25 |
| 7.4 stage 8, 8.5, 8.6, 9.7 | `portfolio_scan.test.ts`, `risk-set.test.ts`, pgTAP `held_signal_securities`, `holds_security` |
| 14.1, 14.3, 14.9 pages, five states, responsive cards | Tasks 6 to 8 component and page tests |

- [ ] **Step 3: Owner acceptance (needs the real account; record the outcome in the operator guide)**

Exit criteria of spec P5: the owner's real account links, syncs and reconciles (P/L figures agree with Flex within rounding); two-user isolation proven (pgTAP and the integration test); the manual refresh cooldown is proven in the UI (disabled button with countdown) and in the backend (429 with `Retry-After`). Work through P5-01 to P5-06 of operator guide section 5.4.

- [ ] **Step 4: Final commit if a check needed a fix**

```text
git add -A
git commit -m "chore(p5b): phase exit fixes"
```

---

## Self-review (spec 12 coverage, placeholders, names)

- **Spec 12 coverage:** 12.1 to 12.10 each map to a task and a named test (table in Task 10). The state machine follows spec states (`queued`, `requested`, `polling`, `parsing`, `done`, `failed`, `expired`) and the brief's names are mapped in P5b-D1.
- **Deviations recorded:** P5b-D1 to P5b-D16 (enum names, column names, no raw column, `NULLS NOT DISTINCT`, no status-update RPC, one active run, separate `broker-tick` cron job instead of editing `kick_workers`, `app.holder`/`holds_security`, held line versus signal security, 365-day setup period, constant cash-type rules, extra core files and Task 5 dependencies, one FX rate for the portfolio summary, fixture action, holding-only scope for results, minimal security creation, estimated daily P&L).
- **Placeholders:** none intended. The pgTAP plan number (92) was counted when this plan was written and `finish()` verifies it. Names to adapt against sibling plans are marked "adapt" with the single line to change (P4 cache payload fields, P1 import names, P5a test helpers).
- **Name consistency:** `claim_manual_refresh`, `enqueue_manual_sync`, `broker_ingest_statement`, `flex_rl_take`, `apply_holding_tag`, `held_signal_securities`, `monitored_holdings_for`, `holds_security`, `kick_broker_sync`; TypeScript `advanceRun`, `runUntilSettled`, `workerTick`, `processStatement`, `buildPortfolioView`, `neededFxPairs`, `selectLatestSnapshot`, `expectedStatementDate`, `usePortfolio`, `useManualRefresh`, `RefreshBar`, `MoneyText`, `ProvenanceBadge`, `buildAnalytics`, `loadAnalyticsData`.
- **Unverified (must be checked against a real statement, P5-01):** XML element and attribute spellings (the parser uses a case-insensitive alias table and the fixture is synthetic), the Cash Transactions `Type` vocabulary, Corporate Actions types, whether Open Positions in a multi-day window carry only the last report date, whether `fd`/`td` may exceed 365 days, XML size and parser CPU for 365 days, daily statement availability time, GBP major units for LSE positions, the Date/Time Separator and date-format option labels in the Flex editor.
