# On-demand research, home tickers, trade everywhere, portfolio polish — plan (2026-10-19)

Spec: `docs/superpowers/specs/2026-10-19-on-demand-research-design.md` (binding; section numbers below refer to it).
Mockups: https://claude.ai/artifact/57VRLttSEFrXCopGUhLGMh, sources in `.superpowers/sdd/2026-10-19-ui-mockups/project/`
(Main, Phone, ScanStates, Holdings, TradeHistory, HowItWorks). Base commit: see the ledger.

## Global Constraints

- TDD for every behaviour change: failing test first (RED), then implementation (GREEN); both in the report.
- Touch only the files your task lists (a task may create new files under the paths it names). No documentation edits
  except Task 9. Do not edit `apps/web/src/lib/database.types.ts` (the lead regenerates it).
- Migrations are forward-only and replay-safe (`create or replace`, `if not exists`, `on conflict`), header comment in the
  style of `supabase/migrations/20261015008000_research_cadence.sql`, sorted after `20261015008700`; each task uses the
  file number it is given. A view's column guard (`20261015006000_eur_handoff.sql` style) is updated when columns are added.
- Settings defaults: `update app_settings set value = '<defaults>'::jsonb || value` (stored values win), except where the
  spec says a value changes (`tavily_daily_cap` 60: set it explicitly).
- Texts exactly as in the spec and the boards. No layout or style beyond the boards; shadcn primitives from
  `apps/web/src/components/ui`; IBM Plex Sans; existing tokens.
- Commits: conventional subjects (`feat(scope): …`, `fix(scope): …`), body explains why, last line exactly
  `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. Stage only your own files with `git add <path>...`; never stage
  `docs/discovery/**`. Other agents commit concurrently: on an `index.lock` error wait 10 seconds and retry.
- Commands: Deno tests `deno test -A --config supabase/functions/deno.json <file>`; `bun run test:core`; `bun run test:web`;
  `bun run test:tools`; `bun run functions:check`; `bun run lint`; `bun run typecheck`. Never run `supabase db reset`,
  `bun run test:db`, integration or e2e suites unless your task says so (the lead runs the full suites at the end).
- Hosted facts for context only: 25 exchanges, ~400 members, Tavily 1,000 credits/month free, Gemini primary, Groq backup.

### Task 1: data rules in SQL and the market-cap formula (backend)

Spec 5.3, 5.4, 5.1 (feed columns, settings). Files: `supabase/functions/worker-tick/lib/quotes.ts` (+ its test),
new migration `supabase/migrations/20261015008800_listed_in_feed_research_state.sql`, new pgTAP
`supabase/tests/1000_listed_in_feed_research_state.test.sql`.

1. Market cap (5.3): in `applyQuoteRows`/its helper, `market_cap_native = regularMarketPrice × sharesOutstanding`; quality
   `missing` when either is null; `market_cap_usd` from that value with the existing FX conversion; Yahoo's `marketCap` is
   no longer read for the snapshot (keep the field in `QUOTE_FIELDS` only if something else needs it). Tests: a row with
   price 130000 and shares 133905 yields 17,407,650,000; a row without shares yields quality `missing`; the existing
   threshold behaviour still uses the computed value.
2. Listed-in (5.4): `public.company_list(...)` filters `p_country` on the exchange's country (`exchanges.country` of the
   company's canonical listing), replacing `coalesce(c0.country, ex0.country)`; the returned `country` column keeps the
   company's home country and a new `listing_country` column is added (update the row type and the web-facing comment).
   `todays_discounts_feed` / `v_todays_discounts` gain `listing_country` the same way.
3. Feed research state (5.1): the feed gains `research_started_at`, `research_wait_reason`, `research_requested_by`
   (`usage ->> 'source'`) from the newest in-flight `research_reports` row of the security (status in `queued`, `running`,
   `quota_deferred`) and `research_failed_at` from its newest `failed` row (lateral joins). Extend the LATEST view
   definition (`20261015008500_every_rank_minus3.sql`), update the column guard, keep anon `select` grants as they are.
4. Settings: `research` gains `visitor_scans_per_hour_per_ip` 3, `visitor_scans_per_day` 8, `visitor_retry_minutes` 60
   (defaults, stored win) and `tavily_daily_cap` is set to 60 explicitly.
5. pgTAP: `company_list` with `p_country = 'United States'` returns an Irish-domiciled company listed on NYQ and excludes a US
   company whose canonical listing is on a non-US exchange; the feed exposes the four research columns (null when no report;
   filled when a `running` report exists); the settings hold the new keys and `tavily_daily_cap = 60`.
   You are the only task allowed to run `bun run supabase:reset` and `bun run test:db` (retry after a minute if the reset
   fails on another task's migration).

Run also: the quotes Deno test, `bun run functions:check`, `bun run lint`, `bun run typecheck`.
Commits: `feat(universe): market cap = last close × shares outstanding`, `feat(db): listed-in filter and research state
in the feed`.

### Task 2: research on request in the pipeline (backend)

Spec 5.1 (pipeline side), 6a. Files: `supabase/functions/_shared/adapters/research_types.ts`,
`supabase/functions/_shared/adapters/research_store.ts`, `supabase/functions/worker-tick/handlers/research_steps.ts`,
`research_seed.ts`, `risk_check.ts`, `classify_final.ts`, `supabase/functions/scan-control/actions/research_now.ts` and the
tests next to each (`research_seed.test.ts`, `research_cadence.test.ts`, `research.test.ts`, `risk_check` tests,
`classify_final` tests, `research_now` tests, `testing/fake_store.ts` as needed).

1. Trigger `visitor`: add to `ResearchTrigger`, `TRIGGER_PRIORITY` (same as `manual`), `REPORT_CLASS` (same as `manual`),
   the gate exemptions in `waitForWindow` (`manual` or `visitor` → no weekday/cadence gate), `REUSE_TRIGGERS` and
   `PRESERVE_TRIGGERS` revisited as the spec says (visitor/manual never reuse; monitor_first keeps its rule).
2. `requestVisitorResearch(deps, { security_id })` in `research_now.ts` next to `researchNow`: run = `latestPublishedRun()`
   (new store method: newest `scan_runs` row with `results_published_at not null`; `latestScanRun` unchanged), trigger
   `visitor`, idempotency key `<security_id>:visitor:<accepted-at ISO minute>`, payload `{ source: "visitor" }`, same job key
   scheme and enqueue path as `researchNow`; returns `{ ok, report_id?, job_key, scan_run_id, started_at }`. It performs NO
   policy checks (Task 3 does); it must never block on an existing failed report.
3. Seeder (`planResearchStage`): remove `new_discount`, `premium` and `refresh` seeding; keep deferred resumes and
   `seedExtras`. `risk_check.ts`: stop seeding card change checks; keep `monitor_first` / `monitor_change` for monitored
   holdings. Coverage `research.required` counts only what was seeded.
4. `classify_final.ts`: a card with no report and nothing in flight gets `operational_category = 'pending'`,
   `category_reason = 'not_requested'`; a queued/running report keeps `research_pending`; a complete report older than
   `reuse_days` counts as absent (existing rule) → `not_requested`.
5. `usage.source` is written from the payload for visitor reports; the public visibility rule (`hasDiscountCard`) applies.
6. `ResearchSettings` (type and parser in `research_types.ts` / wherever `settings()` reads `app_settings.research`) gains
   `visitor_scans_per_hour_per_ip` (3), `visitor_scans_per_day` (8), `visitor_retry_minutes` (60) with those defaults, so
   Task 3 can read them; `tavily_daily_cap` keeps its existing field.

Tests: TDD per item; run the touched Deno test files, `bun run functions:check`, `bun run lint`, `bun run typecheck`.
Commits: `feat(research): visitor trigger and requestVisitorResearch`, `feat(research): the daily scan researches only
monitored holdings`.

### Task 3: the `research-request` Edge Function (backend; after Task 2)

Spec 5.1 (endpoint), 6a. Files: new `supabase/functions/research-request/` (index.ts, deno.json like `quotes`, tests),
`supabase/functions/_shared/adapters/rate-limit.ts` (+ test), new migration
`supabase/migrations/20261015009000_research_request_rate_limit.sql` only if the counter RPC needs a sibling for the hour
window (prefer reusing `quotes_rl_incr` with a different key prefix), `supabase/config.toml` entry for the function
(`verify_jwt = false`, mirror `quotes`).

1. Generalise `withIpRateLimit` to accept `window: "minute" | "hour"` and a key prefix; default stays per-minute so `quotes`
   is unchanged. Add `countOnly: "accepted"` semantics: the handler decides whether the request counts (the limiter exposes
   an `incr` after the handler's policy checks pass), and on a counter failure the request is refused (`try_later`, 429).
2. Endpoint: `POST { security_id }`, CORS as `quotes`. Checks in the spec's order with the spec's reason codes and statuses:
   `not_on_list`, `in_flight`, `cooldown` (+ `next_allowed_at`), `retry_later` (+ `next_allowed_at`), `network_limit`,
   `budget_paused` (visitor daily cap via `consumeQuota("visitor","scans",1,"day",visitor_scans_per_day)`, Tavily credits
   left ≥ 8 and LLM requests left ≥ 10 via the quota ledger, research kill switch). On success call
   `requestVisitorResearch`, write the `audit_events` row (`actor_id` null, `action` `research_request`, `target_type`
   `security`, `target_id`, `details { source, ip_hash, report_id }`), count the IP, answer `{ ok: true, report_id,
   started_at }`.
3. Tests with the fake store/db pattern used by `quotes` and `scan-control` tests: each reason code; success enqueues once;
   rejected requests do not count toward the IP limit; counter failure → `try_later`.

Run the function's tests, `bun run functions:check`, `bun run lint`, `bun run typecheck`, `bun run check:functions-config`.
Commit: `feat(research): public research-request endpoint with visitor limits`.

### Task 4: notifications for companies new on the list (backend)

Spec 5.12, 5.5 (ticker in digests). Files: new migration `supabase/migrations/20261015008900_digest_new_on_list.sql`,
`supabase/functions/worker-tick/handlers/digest-stage.ts` (+ test), `supabase/functions/_shared/core/digest.ts` (+ test),
new pgTAP `supabase/tests/1010_digest_new_on_list.test.sql`.

1. `public.notify_discount_candidates(p_scan_run, p_user, p_finished_only)`: candidates are rows of `todays_discounts` of
   the run whose `is_new_episode` is true OR whose `security_id` has no row in the previous published run's
   `todays_discounts` of the same mode; drop the green/amber, `withheld` and `p_finished_only` conditions (keep the
   parameter for signature stability, ignored); keep the user's mode/listing filter and the A-13 carry-over. Return the
   research outcome columns when a complete report exists (nullable).
2. Digest stage: no waiting for research completion; build when the list is published; the entry shows the home ticker
   (`displayTicker` from `supabase/functions/_shared/core/ticker.ts`, created by Task 6 and present when this task starts),
   name, close, the −3/−4 fact, and the outcome or "Not researched yet — open the card to start a scan".
3. pgTAP: a run with a re-entering company (not in the previous run) and a continuing one (present before) → only the
   re-entering one is a candidate; a pending company is a candidate; outcome columns null when no report.
   Do NOT run `supabase db reset`/`test:db` (Task 1 owns the local database; the lead runs pgTAP for your file).

Run the Deno/core tests, `bun run functions:check`, `bun run lint`, `bun run typecheck`.
Commit: `feat(notifications): digest companies new on the list, without waiting for research`.

### Task 5: Flex statement entities (backend, small)

Spec 5.11. Files: `supabase/functions/_shared/adapters/flex-parse.ts`, `flex-parse.test.ts`, fixture
`supabase/functions/_shared/adapters/fixtures/flex/activity-sample.xml`.
Decode `&amp; &lt; &gt; &quot; &apos;` and numeric character references in attribute values after parsing (keep
`processEntities: false` on the parser so DOCTYPE entities are never expanded; strip a `<!DOCTYPE …>` if present before
parsing). Fixture: a position described `VANG S&amp;P500 USDD`; test asserts the parsed description is `VANG S&P500 USDD`
and a numeric reference decodes. Run the flex-parse test file, `bun run functions:check`, `bun run lint`.
Commit: `fix(broker): decode XML entities in Flex attribute values`.

### Task 6: Overview cards, Scan with AI, Copy the prompt, home tickers, Listed-in, Quotes picker (web)

Spec 5.1 (web side), 5.2, 5.4, 5.5, 5.9, 5.10 (only the Overview link). Boards: Main, Phone, ScanStates. Files:
`apps/web/src/features/overview/**`, `apps/web/src/features/screening/**` (types, hooks, api, rpc-names,
country-filter), `apps/web/src/components/country-filter.tsx`, `apps/web/src/features/quotes/quotes-page.tsx`,
`apps/web/src/features/quotes/selection.ts` (+ tests), `apps/web/src/lib/format.ts` (ticker helper only),
`apps/web/e2e/**` overview specs. Do not edit `apps/web/src/features/handoff/**` or `apps/web/src/features/portfolio/**`
(Task 7 owns them); import `TradeOnIbkrButton` as today.

1. Feed types gain `listing_country`, `research_started_at`, `research_wait_reason`, `research_requested_by`,
   `research_failed_at`. Card state machine per spec 5.1 (not scanned / running / done / failed / limits reached), texts
   exactly as the ScanStates board; progress bar = elapsed/40 min capped at 90%; "Started N minutes ago by a visitor"
   (`research_requested_by`); done state shows "Researched by <model>, <time ago>" and "Next AI scan in N h"; expiry after
   30 days returns to not scanned.
2. Scan with AI calls `POST <functions>/research-request` (`apps/web/src/features/screening/research-request-api.ts`), then
   refetches the feed; a 4xx maps to the matching card state; the "limits reached" state uses the board's text.
3. Copy the prompt: `apps/web/src/features/overview/research-prompt.ts` builds the text of spec 5.2 from the row (unit test
   asserts the company facts, the two questions, the output format and the right sources block for US vs non-US);
   `navigator.clipboard.writeText`, button reads "Copied" for 2 s.
4. Home tickers: a pure helper `displayTicker(yahooSymbol, exchangeCode)` in NEW `supabase/functions/_shared/core/ticker.ts`
   (+ `ticker.test.ts`, runs under `bun run test:core`; US exchange codes: NYQ, NMS, NGM, NCM, ASE, PCX, BTS, NYS, NAS keep
   the symbol; otherwise strip the part after the last "."; dash forms stay), imported by the web as `@core/ticker.ts` (the
   alias already serves `@core/portfolio-view.ts`) and later by the digest (Task 4). Used for the card heading, the company
   table, the Quotes picker and the research page header; identity line "<Country> · <Exchange name> · Yahoo <yahoo_symbol>".
5. Listed-in: filter control reads "Listed in" with "All exchanges" / "United States"; `filterByCountry` and the Overview
   sentence use `listing_country`; `company_list` keeps `p_country` = 'United States'. Remove "Trading opens after research
   clears" and the research gating of the trade control; the Overview sentence gets the "How it works" link to
   `/how-it-works` (route created by Task 8; link only here).
6. Quotes picker lists every row of the feed in rank order (cards and withheld).
7. e2e (`apps/web/e2e/local/*overview*`): add stubbed cases for the five card states and the Listed-in filter; do not run
   e2e (the lead does); unit tests must pass.

Run `bun run test:web`, `bun run lint`, `bun run typecheck`. Load the `frontend-design` skill before editing components.
Commits: `feat(overview): Scan with AI and Copy the prompt`, `feat(overview): home tickers and Listed-in filter`,
`feat(quotes): picker lists every company on the list`.

### Task 7: Portfolio holdings info boxes, Trade column, held-instrument hand-off, trade history filters (web)

Spec 5.6, 5.7, 5.8. Boards: Holdings, TradeHistory. Files: `apps/web/src/features/portfolio/**`,
`apps/web/src/features/handoff/**`, new `apps/web/src/components/ui/popover.tsx` (shadcn Popover over Radix; add the
dependency `@radix-ui/react-popover` with `bun add` in `apps/web`), `apps/web/e2e/**` portfolio specs. Do not edit
`apps/web/src/features/overview/**` or `apps/web/src/features/screening/**`.

1. Popover primitive; holdings table: ⓘ buttons in the Price, Value, Unrealized P&L and Valuation headers (general text) and
   in each Price cell (row facts: quote source and time, statement close, FX basis, calculated vs broker-reported, broker
   FIFO, reconciles); remove the grey small-print lines from the cells; the summary row's explanation moves to the same box.
   Texts as the Holdings board.
2. Trade column last, on every row (desktop and phone layout). Screened holdings keep the canonical-listing target.
   Unscreened holdings: `holdingTarget` gains a held-instrument mode `{ kind: "held", symbol, listingExchange, conid,
   description, currency }`; the Trade on IBKR dialog shows it as the destination with no EUR panel and builds the iBot prompt
   with `set destination <listing exchange>` (`SMART` when the statement's exchange is not an IBKR destination; keep a small
   map of known codes). Valuation tag "Not screened" (grey) for unscreened rows.
3. Trade history: filter bar (symbol or name, type, side, currency, from, to; "Clear filters"), server-side filters in
   `trades-api.ts` (`ilike` on symbol/description, `eq` side/currency, `gte`/`lte` dates; type: Currency (FX) = symbol matches
   `^[A-Z]{3}\.[A-Z]{3}$`, Bonds = `asset_class` bond, Stocks and ETFs = the rest), URL search params, results line "N
   executions match".
4. Unit tests for each; e2e stubbed cases for the popover, the Trade column on an ETF row, and a filtered history.

Run `bun run test:web`, `bun run lint`, `bun run typecheck`. Load the `frontend-design` skill before editing components.
Commits: `feat(portfolio): info boxes and a Trade column on every holding`, `feat(portfolio): trade history filters`.

### Task 8: How it works page (web, small)

Spec 5.10. Board: HowItWorks. Files: new `apps/web/src/features/how-it-works/how-it-works-page.tsx` (+ test), the route
registration (`apps/web/src/routes/**` or the router file, as the app does for `/quotes`), the footer link in the layout
component. Content exactly the board's six sections; settings-driven numbers read from the public settings/scan status
hook where one exists, else literal. Do not edit `apps/web/src/features/overview/**` (Task 6 adds the link there).
Run `bun run test:web`, `bun run lint`, `bun run typecheck`. Commit: `feat(web): How it works page`.

### Task 9: documentation (haiku, after everything)

Files: `docs/operator-guide.md`, `localtest.md`, `README.md`. Add: the `research-request` endpoint and its reason codes;
the new `research` settings and `tavily_daily_cap` 60; the market-cap rule; the Listed-in filter semantics; the digest
rule; "Scans are paused" troubleshooting line. Commit: `docs: on-demand research, listed-in filter, market cap rule`.

### Task 10: coverage counters for on-demand research (backend, small; after Task 2)

Spec 5.1 ("the `research.required`/`pending` coverage counters count only what was actually seeded"). Files:
`supabase/functions/worker-tick/handlers/publish.ts` (+ test), `supabase/functions/worker-tick/lib/coverage.ts` (+
`lib.test.ts`), and if needed the research store's unused methods `listPendingDiscountSecurities`, `listPremiumSecurities`,
`listStaleCurrentReports`, `listPersistingDiscounts` in `supabase/functions/_shared/adapters/research_store.ts` and
`research_types.ts` (remove them and their fake-store counterparts if nothing else uses them; grep first).
`research.required` = the number of research jobs the run actually seeded (deferred resumes + monitored holdings), not the
number of card securities; `pending` = required minus complete/failed/reused among those; `cards` keeps counting the cards.
A run with 5 cards and no seeded research reports `required 0, pending 0, cards 5`. Tests cover that case and a run with two
resumed deferred reports. Run the touched Deno tests, `bun run functions:check`, `bun run lint`, `bun run typecheck`.
Commit: `fix(scan): research coverage counts seeded work only`.

### Task 12: mirror the card price bar (web, small; owner request 2026-10-19)

Owner: "invert the order of the price bar in each card. Right now it's −4 → −3 implying the price is lowest on the left. I want it
the other way around." Files: `apps/web/src/features/overview/channel-gauge.tsx` (+ test), `close-label.ts` (+ test) and any
overview test or e2e stub that asserts the gauge order. Rule: the gauge reads left = the −3 line, right = the −4 line (price falls
to the right); the price dot, the markers, the shaded region and the two labels under the track ("−3 at …" left, "−4 at …" right)
are mirrored accordingly; the close-label clamp logic is mirrored so the label never overflows either edge. Nothing else about
the card changes; the phone layout follows. This supersedes the boards' gauge drawing. Run `bun run test:web`, `bunx biome ci` on
the touched files, `bunx tsc -p apps/web --noEmit`. Commit: `feat(overview): price bar reads −3 on the left, −4 on the right`.
