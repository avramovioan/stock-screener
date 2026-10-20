# Portfolio polish — plan (2026-10-19, evening)

Owner feedback after seeing the new portfolio table locally (web only; functions not yet deployed). Approved board:
`.superpowers/sdd/2026-10-19-ui-mockups/project/Holdings.dc.html` (revised: ticker + ⓘ, no name column, no-wrap numbers, equal
data columns, Trade column with two icon buttons). Base: see the ledger.

## Owner's words (binding)

"I still see Broker-reported in the portfolio table" · "the EUR is on a new line everywhere, which I hate" · "remove the name of the
stock and only leave the ticker. Move the name to an info icon next to the ticker" · "The name still has &amp;" · "Unavailable in the
valuation tag on MSF and ORC … perhaps a button to re-evaluate them once per day manually (beside the automatic scan), with prompt
copy button as well … below the Trade button two more buttons, icons only; equal alignment and spacing between each column except the
last one with the trade button" · "for VUSA you listed destination AEB, while it's also listed in IBIS or IBIS2. Always prefer XETRA."

## Global Constraints

- TDD (RED then GREEN in the report). Touch only the files your task lists. No documentation edits except where a task says so.
- Commits: conventional subjects, body explains why, last line exactly `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`;
  stage only your files; never `docs/discovery/**`. Other agents commit concurrently: on `index.lock` wait 10 s and retry.
- Commands: `bun run test:web`, `bunx biome ci <files>` (0 errors), `bunx tsc -p apps/web --noEmit`; backend: Deno test files,
  `bun run functions:check`, `bun run lint`, `bun run typecheck`. Never run db reset, test:db, integration or e2e (the lead does).
- Texts and layout exactly as the board; shadcn primitives (`Popover` exists in `apps/web/src/components/ui/popover.tsx`).

### Task 1: holdings table layout (web)

Files: `apps/web/src/features/portfolio/page/positions-table.tsx` (+ test), `holding-extras.tsx` (+ test), `money-text.tsx`
(+ test), `summary-row.tsx`, `provenance.tsx` (delete if unused afterwards), `apps/web/src/lib/format.ts` (one helper, see 5),
`apps/web/src/features/portfolio/page/holding-prompt.ts` (new, + test), e2e stubs/specs under `apps/web/e2e/**` that assert the
old layout. Do not edit `features/handoff/**` (Task 3) or `supabase/**` (Task 2); call Task 2's endpoint by the contract below.

1. Columns: Ticker · Price ⓘ · Qty · Value ⓘ · P&L ⓘ · Valuation ⓘ · Trade. `table-layout: fixed`; the six data columns share one
   width, the Trade column is narrower (board: 15% × 6 and 10%). Numbers right-aligned, `white-space: nowrap` on every numeric cell
   and on `MoneyText` (the currency never wraps to a new line). The P&L cell shows unrealized on top and today's change beneath in
   12px ("+88.20 EUR today"). No `ProvenanceBadge` anywhere in the table; its "Broker-reported" fact moves into the ticker's ⓘ box
   ("Cost basis … broker-reported"). The phone layout mirrors the same content.
2. Ticker cell: the ticker plus an ⓘ button (`aria-label="About <ticker>"`) opening a popover with: the company name (first line,
   bold), "Held as <symbol> on <exchange>, <currency> · ISIN <isin>", "Screened as <canonical ticker> on <exchange> · rank N" when
   the holding maps to a screened company (else "Not a screened company"), "Cost basis <amount>, broker-reported", and, for
   monitored holdings, the research line with the existing "Open full report" link (the `MonitoredHoldingBlock` moves here from the
   removed name cell). The name column is removed.
3. Trade column: `TradeOnIbkrButton` as today, and beneath it a centred row of two 36×36 icon buttons: Re-evaluate (refresh-cw
   icon; `aria-label="Re-evaluate <ticker> against today's channel"`, `title="Re-evaluate (once a day)"`; disabled with an
   explanatory `aria-label` for unscreened holdings) and Copy the prompt (copy icon; `aria-label="Copy the evaluation prompt for
   <ticker>"`). Re-evaluate calls Task 2's endpoint `POST <functions>/portfolio-refresh` with the user's JWT and body
   `{ "action": "revalue", "conid": <number> }`; on `{ ok: true }` it refetches the holdings; on 429 it shows the tooltip text
   "Re-evaluated already today; next at <time>" from `next_allowed_at`; other errors toast once. Copy the prompt reuses the Overview's
   prompt builder (`apps/web/src/features/overview/research-prompt.ts`): extract its input type into a generic shape if needed so a
   holding can feed it (name, ticker, exchange, currency, last price and date; lines when known, else the sentence "The −3/−4 line
   levels are not available for this holding"); "Copied" feedback as on the cards.
4. Decode XML entities on display for descriptions and names coming from statements (`&amp; &lt; &gt; &quot; &apos;` and numeric
   references) with a tiny helper in `apps/web/src/lib/format.ts` (+ test); the parser fix lands separately on the server.
5. Tests: column headers and order; no "Broker-reported" text in cells; money text has `whitespace-nowrap`; the ⓘ box content for a
   screened and an unscreened holding; the two icon buttons and their disabled state; the revalue call and its 429 handling; the
   decoded description "VANG S&P500 USDD".

Commit: `feat(portfolio): ticker-only table with info boxes, no-wrap numbers, re-evaluate and copy-prompt actions`.

### Task 2: re-evaluate a holding's valuation on request (backend)

Files: `supabase/functions/portfolio-refresh/handler.ts`, `index.ts`, `store.ts` (+ tests), new
`supabase/functions/_shared/core/holding-tag.ts` (+ test) holding the pure `tagFor` moved out of
`supabase/functions/worker-tick/handlers/portfolio_scan.ts` (which then imports it; its tests keep passing), new migration
`supabase/migrations/20261015009200_holding_revalue.sql`, pgTAP `supabase/tests/1030_holding_revalue.test.sql`.

1. Contract: `POST { "action": "revalue", "conid": <number> }` with the user's JWT (the function already authenticates the user for
   the manual quote refresh). Responses: `{ ok: true, tag, reason, session_date, next_allowed_at }` (200); `{ ok: false, reason:
   "not_found" }` (404, no such holding for this user); `{ ok: false, reason: "not_screened" }` (409, the holding has no
   `signal_security_id`); `{ ok: false, reason: "cooldown", next_allowed_at }` (429, re-evaluated less than 24 h ago);
   `{ ok: false, reason: "no_scan" }` (409, no published run yet). The existing quote-refresh action is unchanged.
2. Computation (service role inside the function, scoped to the caller's holding): latest published run; the holding's
   `signal_security_id`'s `scan_security_results` row of that run (status, close, channel, quote type via `securities`); the
   worldwide rank from the run's ranking snapshot (the same source `portfolio_scan.ts` uses); `tagFor(...)` from the shared core
   module; write `valuation_tag`, `valuation_session_date`, `valuation_reason` and the new `valuation_revalued_at` on the
   `broker_positions` row.
3. Migration: `alter table public.broker_positions add column if not exists valuation_revalued_at timestamptz;` plus a security-definer
   RPC `app.claim_holding_revalue(p_user uuid, p_conid bigint)` that atomically checks the 24 h window and stamps the column (pattern:
   `app.claim_manual_refresh`), granted to service_role only. pgTAP: first claim ok, second within 24 h refused with the next time,
   another user's conid not found.
4. Tests: handler tests with the fake store for each response; a core test for `tagFor` (moved logic, same cases as before).
   Run the function's and worker's Deno tests, `bun run test:core`, `bun run functions:check`, `bun run lint`, `bun run typecheck`.
   For pgTAP run your file via psql in a rolled-back transaction after `bunx supabase migration up` (the lead runs the full suite).

Commit: `feat(portfolio): re-evaluate a holding's valuation on request, once a day`.

### Task 3: held-instrument hand-off prefers Xetra (web)

Files: `apps/web/src/features/handoff/held-destination.ts` (+ test), `handoff-api.ts` (+ test), `trade-on-ibkr-dialog.tsx`,
`holding-target.ts` (+ test). Do not edit `features/portfolio/**` (Task 1).

1. For a held instrument with an ISIN, look the ISIN up in `ibkr_catalogue` (anon-readable; columns `exchange_id, conid, symbol,
   local_symbol, isin, currency`) through `handoff-api.ts`. Destination preference: a Xetra row (`exchange_id` `IBIS`) → destination
   = the user's default destination when it is `IBIS2` or `IBIS`, else `IBIS`; otherwise an `AEB` row → `AEB`; otherwise the
   statement's listing exchange via the existing `heldDestination` rule (SMART fallback). The prompt symbol is the catalogue row's
   `local_symbol` for the chosen exchange, else the held symbol.
2. The dialog shows the chosen destination and a one-line note "Xetra preferred" / "Amsterdam (no Xetra listing found)" / "Listing
   exchange from your statement". Loading state while the lookup runs; the lookup failing falls back silently to the statement rule.
3. Tests: VUSA-like fixture with IBIS and AEB rows → IBIS2 when the default is IBIS2, IBIS when the default is AEB; AEB-only → AEB;
   no rows → statement exchange; lookup error → statement exchange.

Commit: `feat(handoff): held instruments prefer Xetra via the IBKR catalogue`.
