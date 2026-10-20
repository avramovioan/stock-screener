# Portfolio follow-ups — plan (2026-10-19, evening 2)

Owner feedback after using the new portfolio and the Overview with parked research: daily P&L missing for unscreened holdings;
cards show a parked report as "running"; Flex refresh expectations (separate decision, not in this plan).

## Global Constraints

- TDD (RED then GREEN in the report). Touch only the files your task lists. No documentation edits.
- Commits: conventional subjects, body explains why, last line exactly `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`;
  stage only your files; never `docs/discovery/**`. Another agent commits concurrently: on `index.lock` wait 10 s and retry.
- Web commands: `bun run test:web`, `bunx biome ci <files>` (0 errors), `bunx tsc -p apps/web --noEmit`. Backend: Deno test files,
  `bun run test:core`, `bun run functions:check`, `bun run lint`, `bun run typecheck`. Never run db reset, test:db, integration, e2e.

### Task 1: paused research state and stale-run guard (web)

Files: `apps/web/src/features/overview/research-state.ts` (+ test), `research-panel.tsx` (+ tests under overview), the feed type in
`apps/web/src/features/screening/types.ts` only if `next_attempt_at` is missing from `DiscountRow` (the feed column exists).

1. New state `paused` for an in-flight report whose `research_wait_reason` is `llm_quota`, `search_quota`, `provider_unavailable`,
   `weekend` or `cadence_72h`: title "Research paused"; line 1 by reason: `llm_quota` → "Today's free AI budget is used up.",
   `search_quota` → "Today's free search budget is used up.", `provider_unavailable` → "The AI provider is unavailable right now.",
   `weekend` → "No AI work at the weekend.", `cadence_72h` → "Waiting for the 72-hour window."; line 2: "Resumes <formatSofiaShort
   (next_attempt_at)>" when `next_attempt_at` is present, else "Resumes at the next scan."; no progress bar, no "Started … usually
   15 to 40 minutes"; Scan with AI disabled (in flight) with `title="A paused scan resumes by itself"`; Copy the prompt stays.
2. `rate_limited` stays `running` with the existing second line "Provider busy, retrying".
3. Stale guard: a `running` card whose `research_started_at` is more than 90 minutes old shows, instead of the "Usually 15 to 40
   minutes" sentence, "Taking longer than usual. An unfinished scan is retried after the daily reset."; the progress bar stays at 90%.
4. Tests: each wait reason → paused with the right texts; `rate_limited` → running; 30-minute and 2-hour running cards.

Commit: `fix(overview): paused research is its own card state; stale runs say so`.

### Task 2: delayed quotes for unscreened holdings (backend)

Files: new `supabase/functions/_shared/core/yahoo-symbol.ts` (+ test), `supabase/functions/portfolio-refresh/store.ts` (+ test),
`supabase/functions/portfolio-refresh/handler.ts` only if the quote fetch needs the new symbols threaded (+ test).

1. Pure `yahooSymbolForHolding(symbol, listingExchange, assetClass)`: null for bonds (`assetClass` matching /bond/i) and for symbols
   containing a space; US venues (`NASDAQ`, `NYSE`, `ARCA`, `AMEX`, `BATS`, `NYSENAT`) → the symbol unchanged (dots to dashes:
   `BRK.B` → `BRK-B`); suffix map: `AEB` → `.AS`, `IBIS`/`IBIS2` → `.DE`, `LSE`/`LSEETF` → `.L`, `SBF` → `.PA`, `EBS` → `.SW`,
   `BVME` → `.MI`, `BME` → `.MC`, `SFB` → `.ST`, `CPH` → `.CO`, `HEX` → `.HE`, `TSE` → `.TO`, `ASX` → `.AX`, `SEHK` → `.HK`;
   unknown exchange → null. Tests for each branch.
2. `portfolio-refresh/store.ts`: `valuationSymbol` = the matched security's `yahoo_symbol` when present (as today), else
   `yahooSymbolForHolding(symbol, listing_exchange, asset_class)`. Nothing else changes: the quote fetch and `dailyPnlEstimate`
   already work from `valuationSymbol`. Test: an unmatched ETF on AEB gets `VUSA.AS`; a bond gets null; a matched security keeps its
   screener symbol.

Commit: `feat(portfolio): delayed quotes and daily P&L for unscreened holdings`.

### Task 3: refresh means quotes; statement sync on demand; freshness stated plainly (web)

Owner decision 2026-10-19: keep IBKR Flex (once-a-day statements) and make freshness explicit. Files:
`apps/web/src/features/portfolio/refresh-bar.tsx` (+ test), `apps/web/src/features/portfolio/use-manual-refresh.ts` (+ test, only if
needed), `apps/web/src/features/portfolio/page/portfolio-page.tsx` (+ test). Reuse, do not edit: `apps/web/src/features/broker/
broker-api.ts` (`sync()` posts `{ action: "sync" }` to `broker-sync`), `apps/web/src/features/broker/use-broker.ts` (mutation and run
polling), the broker status types (`BrokerRun` states queued/requested/polling/parsing/done/failed/expired).

1. Status line (replaces "Broker data: …"): `Positions from the IBKR statement of <report date> · Prices: delayed quotes as of
   <time Sofia> (15–20 min)`; when quotes are unavailable: `… · Prices: statement close of <report date>`; before the first
   statement: `No statement yet`. Keep the existing "behind by N days" warning.
2. Buttons: the existing manual refresh is relabelled `Refresh quotes` (pull-to-refresh unchanged). A second outline button
   `Sync statement now` calls the broker `sync()` action; while a run is active it reads `Syncing statement…` with the spinner and is
   disabled; on `done` the holdings and trades queries are refetched and a polite status says `Statement synced at <time>`; on the
   cooldown answer (`retry_after_seconds`) it shows `Statement synced recently; next at <time>` as a visible toast and in the button
   title; on `failed`/`expired` a single error toast with the run's error message.
3. One line of help under the bar: `IBKR produces statements once a day after the close; today's trades appear in tomorrow's
   statement.`
4. Tests: status line in the three states; relabelled button; sync button states (idle, active, done refetch, cooldown toast,
   failure toast). Check the cooldown window in `app.enqueue_manual_sync` (`supabase/migrations/20261015005000_broker_schema.sql`
   ~line 364) and mention it in the report.

Commit: `feat(portfolio): refresh quotes, sync statement on demand, plain freshness line`.
