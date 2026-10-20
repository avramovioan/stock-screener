# P6 - "Trade on IBKR" Hand-off Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking. Tests are written and seen failing before the code that makes them pass. Every task ends with a commit. Task 5 additionally requires the `frontend-design` and `ui-ux-pro-max:ui-ux-pro-max` skills (load them before touching component markup or classes; the tests pin text, roles and test ids, not styling).

**Goal:** Give the owner a safe path from a Today's Discounts card (or a Portfolio row) to an order that *they* create in IBKR. The app resolves the EUR-listed equivalent of a canonical security through IBKR's public IBIS and AEB catalogue (weekly import, confirmed by ISIN through Yahoo and cross-checked on Yahoo's EUR line), generates the iBot prompt `Create <buy|sell> <limit|market> order for <qty> shares of <IBKR local symbol> at <price> and set destination <IBIS2|IBIS|AEB>`, and shows it in a hand-off dialog with a Copy button, the delayed EUR quote, a checklist and a persistent notice that **the app places no orders**. The EUR mapping is display and hand-off only; it never enters a screening calculation.

**Architecture:** Three layers. (1) Database: `ibkr_catalogue`, `eur_equivalents` (with a status-shape CHECK that makes `verified` impossible without contract, Yahoo symbol and verification time), audited `eur_equivalent_overrides`, public read for display data, service-role helpers `app.replace_eur_equivalents` and `app.eur_resolve_targets`, the real EUR join in the public cards view, and the two new stages in the pipeline order. (2) Edge: `adapters/ibkr-catalogue.ts` (gentle, bounded pagination of the undocumented `/webrest/*` endpoint) and two `worker-tick` handlers (`eur_catalogue` weekly import, `eur_resolve` per security) built as pure matching code (`eur_match.ts`) plus ports, so they are tested with fakes; failures are data, never scan failures. (3) Web and core: `core/handoff.ts` (prompt builder, validation, destination rules, listing choice, estimate) is pure and shared; `features/handoff/*` derives everything the dialog shows from plain inputs (`derive.ts`), reads EUR lines and the profile preference through one small API module, and renders `TradeOnIbkrDialog` from the Overview card (linked users) and from any holding row.

**Tech Stack:** Supabase Postgres 17 (pgTAP, RLS, plpgsql), Deno 2.x Edge Functions (`deno test`, `npm:@supabase/supabase-js@2.117.3`), TypeScript 6.0.3 strict (`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`), Bun 1.3.14 and Node 22.13.1 (Windows 11), Vitest 5 (projects `core`, `tools`, `web`; happy-dom, Testing Library 16), React 19, TanStack Query 5, shadcn/ui (`dialog`, `button`, `input`, `label`, `card`), lucide-react, sonner, Playwright 1.64.1, Biome 2.5.15.

**Spec:** `docs/superpowers/specs/2026-10-15-stock-screener-design.md` sections 13 (hand-off), 5.7 (EUR-equivalent resolution), 6.3 (`eur_equivalents`, `ibkr_catalogue`, `profiles.default_destination`), 6.6.4 (cards view), 6.9, 7.4 (stages `eur_catalogue`, `eur_resolve`), 12.7 (ISIN from Flex positions), 14.3 and 14.4 (card subtitle), 17, 18 P6, 19 (A-19, A-28, A-38, A-39, Q-08, Q-10). Brief: `prompt.txt` lines 735-767 (European EUR equivalent: the mapping never changes screening) and 1250-1276 (order preparation fields, here display only: the owner replaced order submission by this hand-off). Research: `docs/discovery/research/ibkr-flex-links-ibot.md` sections 3-6 and `docs/discovery/research/yahoo-finance2-spike.md` section 3.5.

---

## What this plan builds on

**P0 (read from the repository):** Bun workspace, Biome (`bun run lint`, `bun run lint:fix`), strict tsconfig base, Vitest projects `core` (`supabase/functions/_shared/core/**/*.test.ts`, Node), `tools` and `web` (happy-dom, aliases `@` -> `apps/web/src`, `@core` -> `supabase/functions/_shared/core`), the core purity guard (`bun run typecheck` runs `tools/check-core-purity.ts`: core files import only core files with `.ts` extensions and use no `Date.now()`, `new Date()` without arguments, `Math.random()`), `supabase/functions/deno.json` (import map `@core/`, `@adapters/`, `@supabase/supabase-js`, `@std/assert`), `bun run functions:check`, `bun run functions:test` (ignores `_shared/core`), `bun run check:functions-config`, `bun run test:db` (`supabase test db`, pgTAP files in `supabase/tests/`), shadcn primitives in `apps/web/src/components/ui/` (Biome ignores that folder).

**P1 (plan `2026-10-15-p1-engine-pipeline.md`; written but not yet executed in the repository when this plan was drafted).** This plan uses these names; where a name differs in the real code, change only the line the step names:

| P1 artifact | Used as | Seam |
|---|---|---|
| `worker-tick/types.ts` | `Handler = (ctx: HandlerContext) => Promise<Record<string, unknown>>`; `HandlerContext { db (with .sb: SupabaseClient), job, run: RunInfo, providers: { market, fx }, signal, deadlineMs, log }`; `RunInfo { id, scanDateLocal, scanDay, startedAtMs, providerMode, fixtureSet }`; `Seeder`, `SeedContext`, `SeedPlan { keys, payloads?, priorities? }` | type imports in `eur_resolve.ts`, `eur_catalogue.ts`, `eur_register.ts` |
| `worker-tick/stages.ts` | `PIPELINE_ORDER`, `HANDLERS`, `SEEDERS` records keyed by `job_stage` (the enum already contains `eur_catalogue` and `eur_resolve`) | Task 3 step 9 |
| `app.seed_stage` | zero keys inserts a `_empty` done marker, so a stage with nothing to do never blocks the pipeline | `seedEurResolve` returns no keys |
| `app.next_stage_to_seed(uuid)` | plpgsql with a `v_order job_stage[] := array[...]` literal; later phases rewrite it | `20261015006100_eur_stage_order.sql` rewrites the literal in place |
| `adapters/clock.ts` | `Clock { now(); sleep(ms) }`, `systemClock`, `createFakeClock()` (records `sleeps`) | catalogue adapter and tests |
| `adapters/providers.ts` | `MarketDataProvider.search(q, { quotesCount, newsCount })`, `.quote(symbols)`, `QuoteRecord { symbol, quoteType, currency, longName, sharesOutstanding, regularMarketPrice, ... }` | resolver and tests |
| `adapters/yahoo.ts` | `mapQuote(raw): QuoteRecord \| null` | `fixture-eur.ts` |
| `adapters/fixture-providers.ts` | `World`, `loadWorld()`, `createFixtureProviders(world, set)`; `ALLOW_FIXTURE_PROVIDERS=1` guard | Task 6 |
| `core/identity.ts` | `normalizeName(name)` (NFKD, lower-case, drop punctuation and trailing legal forms `inc corp corporation co company ltd limited plc ag se sa nv bv spa ab asa oyj kk`) | name matching |
| `adapters/settings.ts` | `DEFAULT_PIPELINE.stageCaps` | Task 3 step 9 |
| tables | `securities (id, company_id, yahoo_symbol, currency, currency_major, minor_divisor, long_name, shares_outstanding, isin, is_canonical)`, `companies (id, name, canonical_security_id)`, `fx_rates (rate_date, ccy, usd_per_unit)`, `app_settings (key, value, is_public, description)`, `todays_discounts`, `signal_episodes`, `scan_runs`, `scan_jobs`, `scan_events` | SQL and store |
| `audit_events` | P1 DDL: `(actor_id, action, target_type, target_id, details)`; spec 6.3 and P5a use `(actor, actor_user_id, event_type, data)` | the override audit trigger is generated for whichever shape exists |
| `public.v_todays_discounts` | 30 columns; the last five EUR columns are typed nulls "replaced by the real join later" | Task 1 replaces the view (guarded) |
| `tools/test-integration.ts`, `tools/lib/local-stack.ts` | fixture-mode scan driver (`runScan`, `rest`, `rpc`, `callFunction`), world with MSFT, MSF.DE, SAP.DE, ASML.AS, ... | Task 6 |

**P2 (plan written):** adds stages `news` and `research` after `publish`; its plan does not touch the EUR stages or the cards view.

**P4 (plan written):** `DiscountCard` and `TradeControl` in `apps/web/src/features/overview/discount-card.tsx` (a disabled `Submit Order` button for linked viewers, `data-testid="submit-order-button"`), `useViewerState` (`anonymous | no_broker | linked`), `useQuotes(symbols)` and `QuoteDto` (`POST /quotes/quote`), `lib/supabase.ts`, `lib/format.ts`, test fixtures `makeDiscount`.

**P5a (plan written):** `useAuth()` from `@/features/auth/auth-provider` (`user?.id`), `profiles` own-row RLS and column grants, `features/profile/broker-page.tsx` with the replaceable `BrokerPanel`, `src/test/setup.ts` with a global mock of `@/features/profile/default`.

**P5b (no plan in the repository when this plan was drafted):** `broker_connections.status = 'linked'` (spec 6.3.6), `broker_positions.isin` and `.security_id` (spec 6.3.6) and a Portfolio positions table. The SQL helper and the store read `broker_positions` defensively (the table may be missing); the Portfolio wiring in Task 5 step 14 is conditional.

If anything differs from this description, adapt the path or name in the step that uses it and record the difference in the commit message. Do not restructure P0 to P5 output.

## Conventions used in every task

- **Commands (PowerShell or Git Bash; every command works on Windows):** web tests `bun run test:web <filter>`, core tests `bun run test:core <filter>`, tool tests `bun run test:tools <filter>`; Deno tests for one file `deno test -A --config supabase/functions/deno.json <path>`, all functions `bun run functions:test`; type check of Deno code `bun run functions:check`; database `bunx supabase db reset` then `bun run test:db`; integration `bun run test:integration`; local end-to-end `bun run test:e2e:local`; whole gate `bun run lint`, `bun run typecheck`, `bun run test`.
- **Biome** enforces 100 columns, double quotes, `useImportType` and the recommended rules. The code in this plan was formatted with the repository's `biome.json`; still run `bun run lint:fix` before every commit and review what it changed. Info-level `useLiteralKeys` hints on `obj["key"]` are expected (the tsconfig requires bracket access to index signatures) and do not fail `biome ci`.
- Core files import nothing; Deno files keep `.ts` extensions on relative imports; web imports use `@/` and `@core/...ts`.
- File names are kebab-case in `apps/web` (P0 convention) and snake_case under `worker-tick/handlers` (P1 convention: `identity.ts`, `fetch_bars.ts`).
- **No network in any test.** Deno tests inject `fetchImpl`, clock and pause; web tests mock the API modules. Nothing in this plan contacts IBKR or Yahoo from a test.
- Commit after every task with a Conventional Commit message ending with the attribution line the repository requires. Never skip hooks.

## Global Constraints (exact values; every task must respect them)

| Constraint | Value |
|---|---|
| Screening independence | The EUR mapping **never replaces the canonical listing in any calculation** (brief 12). Nothing in `supabase/functions/_shared/core` except `handoff.ts` knows about it; `handoff.ts` is imported only by the web feature and the EUR handlers; eligibility, ranking, thresholds and episodes never read `eur_equivalents` or `ibkr_catalogue` |
| `verified` | Only when **all** hold: ISIN confirmed (Yahoo `search(isin)` first hit symbol equals the canonical Yahoo symbol, and equals a known ISIN when one is known); the Yahoo line `<localSymbol>.DE` (IBIS) or `.AS` (AEB) has `quoteType = EQUITY`, currency `EUR`, normalised `longName` equal to the canonical name; `sharesOutstanding` identical **when both are present**; `price x EURUSD / usdPerUnit(ccy)` within **1%** of the canonical price (GBp and other minor units divided first); a usable local symbol. Missing data or a price outside 1% gives `unverified` with the failing checks stored; a hard mismatch (other primary symbol, not an equity, not EUR, other name, other share count) rejects the candidate (it is stored nowhere; with no other candidate the status is `none`) |
| `unverified` | The dialog shows no prompt until the user ticks the checkbox `I have checked this is the same share`; no EUR quote is requested or shown for an unverified line |
| `none` | Card and dialog say `No verified EUR equivalent`; no EUR price, no generated prompt, a manual local-symbol input marked `Unverified symbol` is offered and its prompt carries a red notice |
| Prompt template | Exactly `Create <buy\|sell> <limit\|market> order for <qty> shares of <IBKR local symbol> at <price> and set destination <destination>`; the ` at <price>` clause is **omitted for market orders** (A-38); `shares` for every quantity including 1; owner's example `Create buy limit order for 10 shares of MSF at 400 and set destination IBIS2`. Documented-style second variant `Buy 10 shares of MSF at 400 limit` with the ticket note `On the ticket set the destination to IBIS.` |
| Input rules | quantity: positive whole number up to 9 digits; limit price: dot decimal separator, at most **4** decimals, greater than zero, **no thousands separators and no decimal comma** (a comma is rejected with an explanation, never reinterpreted); local symbol: upper-case A-Z, 0-9 and dots, 1-12 characters, **never a Yahoo ticker** (`.DE` and `.AS` suffixes are refused) |
| Destinations | `IBIS2` (default, label `Xetra (IBIS2 — owner practice, not in IBKR's public catalogue)`), `IBIS` (`Xetra`), `AEB` (`Euronext Amsterdam`); `profiles.default_destination` defaults to `IBIS2`; only destinations that fit the shown listing's exchange are offered (IBIS listing: IBIS2 and IBIS; AEB listing: AEB; no listing: all three) and a default that does not fit is replaced with a reason |
| Listing preference | verified before unverified before none; **Xetra (IBIS) before Euronext Amsterdam (AEB)** |
| No orders | The app never places, modifies or cancels an order. The dialog shows, in every state including loading and error, the notice `This app does not place orders. Paste the prompt into IBKR's iBot or create the order yourself, then confirm it in IBKR.` and has no submit control; the button that opens it is labelled `Trade on IBKR` |
| IBKR link | `https://www.interactivebrokers.com/sso/Login` (login only: no documented deep link exists, Q-08), `target="_blank"`, `rel="noopener noreferrer"`, label `Open IBKR Client Portal` |
| Catalogue import | **weekly** (job key `eur_catalogue:<iso-week>`), exchanges IBIS then AEB, `POST https://www.interactivebrokers.com/webrest/search/products-by-exchangeId` body `{"domain":"com","exchangeId":...,"pageNumber":n,"pageSize":100,"sortDirection":"asc","sortField":"symbol"}`, headers `Content-Type: application/json`, `Referer: https://www.interactivebrokers.com/en/trading/products-exchanges.php`, a descriptive `User-Agent`; **at most 35 pages and 50 requests per import**, **300 ms** between requests, 3 retries with 1 s, 2 s, 4 s backoff for 429, 5xx and network errors (`Retry-After` honoured up to 60 s), no retry for other 4xx or a malformed body, then the import is abandoned: **one attempt per Sofia day**, recorded before the first request; never on a user request path; only `STK` rows in `EUR` are kept; `app_settings.eur_catalogue.enabled = false` switches it off |
| Quote | Yahoo delayed EUR quote of a **verified** line only, labelled `Delayed quote (Yahoo): <price> EUR as of <d Mon yyyy, HH:mm UTC>, 15 minutes or more delayed, not an IBKR price`, never `live`; a quote in another currency is ignored; refresh button with a 10 s cooldown; unavailable: `Quote unavailable`; the limit price is prefilled with the quote rounded to 2 decimals and flagged `edit before use` |
| Cache | EUR resolution is cached **30 days** per canonical security and re-resolved earlier when it is doubtful (`unverified` or `none`) and the catalogue was imported after it, or an override changed; a security is resolved only when it is a card, a watch-list symbol (`app_settings.eur_catalogue.extra_symbols`) or a held company's canonical security |
| Privacy | Nothing typed or generated in the dialog is logged, stored in the browser or sent anywhere; the browser only reads `eur_equivalents` and its own `profiles.default_destination`, writes its own `profiles.default_destination`, and calls the public `quotes` function. EUR events in `scan_events` carry no user data |
| Soft failure | A doubtful or missing EUR line is data. The EUR stages complete with a status in their result instead of failing; only an open Yahoo breaker, an exhausted request budget, an aborted signal or a database fault propagate |

## Decisions and deviations the lead must record

| # | Decision | Reason |
|---|---|---|
| P6-D1 | The card button is labelled `Trade on IBKR` (spec 13.5) instead of the disabled `Submit Order` of P4-D3; its test id becomes `trade-on-ibkr-button`; one constant `TRADE_BUTTON_LABEL` | The spec chose the label so nothing implies submission; P4-D3 said P6 owns the final label. Reverting is a one-line change if the owner insists on the brief's wording |
| P6-D2 | The acknowledgement checkbox reads `I have checked this is the same share` (brief) | Spec 13.4 words it `I will verify the contract on the IBKR ticket`; the brief's wording asks for the stronger statement |
| P6-D3 | The link label is `Open IBKR Client Portal` (brief; spec: `Open IBKR login`) and the second spec link `/portal` is omitted | One link to a URL IBKR documents (login), as the brief requires |
| P6-D4 | A missing `sharesOutstanding` on either line does **not** block `verified` (A-28 and the brief: "equal shares outstanding when present"); spec 5.7 step 4 lists it as an example of `unverified`. `app_settings.eur_catalogue.require_shares = true` makes it block | The spec contradicts itself; the lenient reading keeps ADRs and thin quote records usable, the other three identity checks still gate |
| P6-D5 | A candidate with a hard mismatch is rejected and not stored; `unverified` means missing data or a price outside 1%. With no surviving candidate the row is `none` with the rejected candidates listed in `verification` | Spec 5.7 says a different `longName` "rejects the candidate"; storing a look-alike as `unverified` would put it in front of the owner |
| P6-D6 | A `none` result is stored as one row in the IBIS slot with no contract; a database CHECK ties each status to the columns it needs | The table keeps one row per (security, exchange) and the cache needs a negative entry |
| P6-D7 | Stage placement: `eur_catalogue` right after `identity` and `eur_resolve` right after `news` (else after `publish`), done by rewriting the `v_order` array literal of `app.next_stage_to_seed` in place (migration `20261015006100`) and by `PIPELINE_ORDER` in `stages.ts`; the weekly job key is `eur_catalogue:<iso-week>` (spec 7.4 shows `eur_catalogue`) | Later phases replace the function with longer lists; an in-place rewrite stays correct whatever the list is |
| P6-D8 | `eur_catalogue` always seeds one job per run so each run records its decision (imported or skipped with a reason) in `scan_jobs.result`; `eur_resolve` seeds one job per target (at most `max_resolve_per_run`, default 40) or none (P1's `_empty` marker) | Auditable weekly behaviour; bounded Yahoo traffic |
| P6-D9 | Import state lives in `app_settings.eur_catalogue_state`; only exchanges read to the end are written; an abandoned exchange keeps last week's rows | A partial import must not look like a full one |
| P6-D10 | `ibkr_catalogue` uses `product_type` and `fetched_at` (brief) where spec 6.3 says `type` and `imported_at` (guarded rename if P1 created the table); anon and authenticated may read it (brief; spec 6.9 lists no policies) | Public display data; the web does not read it in P6 but the brief grants it |
| P6-D11 | The cards view gets the real EUR join here (P1 left typed nulls); the lateral order is verified, unverified, none, then IBIS first (spec 6.6.4 sorted only by `status = verified` then IBIS); `status` is cast to `text` to keep P1's column type | A `none` IBIS row must not outrank an unverified AEB line |
| P6-D12 | The override audit trigger is generated for the existing `audit_events` shape (P1's or spec 6.3's) | P1 and P5a disagree on the column names |
| P6-D13 | `app.eur_resolve_targets` adds an operator watch list `eur_catalogue.extra_symbols` (Yahoo symbols of canonical securities) to cards and held companies | Lets the operator pre-resolve a symbol before it becomes a card, and gives the integration test a deterministic MSFT target |
| P6-D14 | The Yahoo quote is requested and shown only for a `verified` line, only in EUR, with a UTC timestamp; unverified lines never feed a price | A look-alike must not prefill a limit price |
| P6-D15 | The documented-style prompt variant (spec 13.2) and the ticket checklist (spec 13.1) are included; the statement text of spec 13.1 is split into the brief's notice plus `TICKET_REVIEW_NOTE` | Brief wording for the persistent notice, spec content for the rest |
| P6-D16 | `Copied` is shown inline and as a toast (spec says toast) | The inline text is testable and works when no toaster is mounted |
| P6-D17 | `TradeOnIbkrButton` is exported for any row; it is wired into Portfolio only when P5b's positions table exists (step 14); the target for a holding is the company's canonical (screening) security | P5b has no plan yet |
| P6-D18 | Default destination UI is a separate `DefaultDestinationCard` rendered under `BrokerPanel` and its own `handoffApi`/`default.ts`, so P5a's `ProfileApi` and P5b's panel body stay untouched | Disjoint files |
| P6-D19 | Fixture mode gets `fixtures/integration/eur-fixtures.json` (generated by `tools/gen-eur-fixtures.ts` from the integration world; synthetic MSF.DE derived from the world's MSFT quote, a synthetic AEB look-alike row with MSFT's ticker) | The integration test must exercise verification and the look-alike trap without touching IBKR or Yahoo |

## Review Focus (five failure modes, each pinned by tests in the owning task)

1. **A look-alike ETP verified as the EUR equivalent.** Task 3 `eur.test.ts`: `the MSFT.AS look-alike (tracker ETP) is rejected and never becomes the EUR equivalent`, `the look-alike alone yields none`, `an ISIN that Yahoo ties to another primary listing rejects the candidate`, `a non-EUR Yahoo line is rejected`, `shares outstanding: different counts reject`, `assessCandidate never reports verified when the ISIN could not be confirmed`; Task 1 pgTAP (`verified` needs the Yahoo symbol and `verified_at`; `none` carries no contract); Task 6 integration (the fixture catalogue contains an AEB look-alike with MSFT's ticker and MSFT ends with exactly one row, IBIS `MSF`).
2. **The prompt built with the Yahoo suffix instead of the IBKR local symbol.** Task 4 core tests (`UNA` not `UNA.AS`; `refuses a Yahoo ticker as the local symbol`), Task 3 (`Unilever: the probe uses the IBKR localSymbol UNA`; a catalogue symbol like `MSF.DE` can never be verified), Task 5 (`derive.ts never reads the Yahoo symbol` static guard; `uses the IBKR local symbol, never the Yahoo ticker`).
3. **A decimal-comma price in the prompt.** Task 4 (`parsePriceInput` rejects `472,85`, `1,234.50`, `1.234,50`; `formatPriceForPrompt` never emits a comma, grouping or exponent), Task 5 (`rejects a decimal comma with an explanation instead of guessing, and shows no prompt`).
4. **The dialog shown as an order ticket without the disclaimer.** Task 5 (`the no-orders notice` tests: present while loading, on error and for verified, unverified and none; no control labelled submit or place order; static guard against `Submit Order` wording; the button is `Trade on IBKR`), Task 6 e2e (notice text visible in the real app).
5. **The catalogue import hammering IBKR on failure.** Task 2 (`HTTP 500 is retried exactly 3 times ... no 5th request`, `a 403 or 404 is not retried at all`, `the request budget caps retries across the whole import`, `the page budget stops an endless catalogue`, 300 ms spacing shared across exchanges), Task 3 (`a failing endpoint is abandoned for the day, never retried that day, and tried again the next day`, `a second run in the same ISO week does nothing and makes no request`), Task 6 integration (day 2 of the same ISO week makes no catalogue request).

## Task map and concurrency

| Task | Depends on | Files owned (disjoint across concurrent tasks) | Can run concurrently with |
|---|---|---|---|
| 1 Migration and pgTAP | P1, P5a | `supabase/migrations/20261015006000_eur_handoff.sql`, `supabase/tests/0600_eur_handoff.test.sql` | 2, 4 |
| 2 Catalogue adapter | P1 `clock.ts` | `supabase/functions/_shared/adapters/ibkr-catalogue.ts`, `.test.ts`, `fixtures/ibkr-catalogue-ibis-page1.json`, `fixtures/ibkr-catalogue-aeb-page1.json` | 1, 4 |
| 4 `core/handoff.ts` | P0 | `supabase/functions/_shared/core/handoff.ts`, `handoff.test.ts` | 1, 2 |
| 3 `eur_catalogue` and `eur_resolve` handlers | 1, 2 **and 4** (imports `isValidLocalSymbol` and the `EurExchange` and `EurStatus` types from `core/handoff.ts`), P1 | `supabase/functions/worker-tick/handlers/eur_*.ts`, `eur.test.ts`, `supabase/functions/_shared/adapters/fixture-eur.ts` (+ test), `supabase/migrations/20261015006100_eur_stage_order.sql`, `supabase/tests/0601_eur_stage_order.test.sql`, one-line edits in `worker-tick/stages.ts`, `adapters/settings.ts` (+ its test) | 5 (disjoint files) |
| 5 Web hand-off | 1 (the `eur_equivalents` read and the profile column) and 4 | `apps/web/src/features/handoff/*`, `apps/web/src/test/handoff-default-mock.ts`, edits in `features/overview/discount-card.tsx` (+ its P4 test), `features/profile/broker-page.tsx`, `src/test/setup.ts`, Portfolio positions table when present | 3 |
| 6 Integration, e2e and operator guide | 1-5 | `fixtures/integration/eur-fixtures.json`, `tools/lib/eur-fixtures.ts` (+ test), `tools/gen-eur-fixtures.ts`, edits in `adapters/fixture-providers.ts`, `supabase/config.toml`, `tools/test-integration.ts`, `tools/lib/local-stack.ts`, `apps/web/e2e/local/handoff.local.spec.ts`, `docs/operator-guide.md` | - |
| 7 Phase exit checklist | all | none (runs checks; fixes land in the owning files) | - |

Tasks 1, 2 and 4 touch no common file and may be dispatched in parallel. Task 3 starts after all three have landed. Task 5 may start after Tasks 1 and 4 (it needs no Edge code) and run alongside Task 3. Task 6 starts after all of 1-5.

**Verified while drafting (2026-10-15):** in a scratch copy of the repository with stubs for the P1, P4 and P5a seams, the Deno adapter, handler and fixture-overlay tests (52 tests), the Vitest suites for core, tools and web (78 tests, including the dialog tests with a real Radix dialog under happy-dom) passed, `deno check` passed against the real `@supabase/supabase-js` types, `tsc` passed with the repository's strict flags for the web and core code, and Biome reported no errors. **Not executed (no Docker, no Supabase stack, no network were allowed):** both migrations and both pgTAP files, the integration test, the Playwright spec, every edit to P1, P4 and P5a files, and the P5b-dependent code paths. Expect to debug those on first run; the steps say where.

---

## Task 1: Migration `20261015006000_eur_handoff.sql` and pgTAP

**Concurrency:** may run at the same time as Tasks 2 and 4 (disjoint files). Implementer: sonnet.

**Files:**
- Create: `supabase/migrations/20261015006000_eur_handoff.sql`
- Create: `supabase/tests/0600_eur_handoff.test.sql` (if P0 moved the smoke test to `supabase/tests/database/`, put this file next to it)

**Interfaces:**
- Consumes: P1 tables `securities`, `companies`, `exchanges`, `profiles` (already has `default_destination`), `audit_events`, `app_settings`, `fx_rates`, `scan_runs`, `scan_jobs`, `signal_episodes`, `todays_discounts`, the view `public.v_todays_discounts`, `app.touch_updated_at()`; P5a own-row policies on `profiles`.
- Produces: enum `eur_status` (created only if missing), tables `ibkr_catalogue`, `eur_equivalents`, `eur_equivalent_overrides`, trigger function `app.audit_eur_override`, `app.replace_eur_equivalents(uuid, jsonb) returns int`, `app.eur_resolve_targets(uuid, int) returns setof uuid`, settings rows `eur_catalogue` and `eur_catalogue_state`, the replaced view `public.v_todays_discounts`.

- [ ] **Step 1: Verify the baseline**

Run (PowerShell, from the repository root):
```powershell
Get-ChildItem supabase\migrations | Select-Object Name
git grep -n "create table audit_events" -- supabase/migrations
git grep -n "create or replace view public.v_todays_discounts" -- supabase/migrations
git grep -n "eur_status\|ibkr_catalogue\|eur_equivalents" -- supabase/migrations
```
Expected: P0 and P1 (and P5a, P2 if present) migrations, all sorting before `20261015006000_*`; `audit_events` defined once (note which column names it uses: the migration adapts to both shapes); the view defined once; if `eur_status`, `ibkr_catalogue` or `eur_equivalents` already exist (P1 may have created them from spec 6.3) the migration is written to coexist: `create table if not exists`, guarded renames of `type` to `product_type` and `imported_at` to `fetched_at`, `add column if not exists`. If a P1 or P5a migration sorts after `20261015006000`, rename this file to a later timestamp (keep the `_eur_handoff.sql` suffix) and use that name everywhere below; the stage-order migration of Task 3 must sort after it.

- [ ] **Step 2: Write the failing pgTAP test**

`supabase/tests/0600_eur_handoff.test.sql` (59 assertions: structure, constraints that make A-28 true in the database, the replace helper, anon and authenticated privileges, `profiles.default_destination`, overrides with audit, the resolve-target rules including the watch list, and the public cards view):

```sql
begin;
select plan(59);

-- helper: set the JWT claims that auth.uid() reads (same helper as 0300_auth_profiles.test.sql)
create function pg_temp.set_claims(p_uid text) returns void
language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    case when p_uid = '' then '{"role":"authenticated"}'
         else json_build_object('sub', p_uid, 'role', 'authenticated')::text end, true);
  perform set_config('request.jwt.claim.sub', p_uid, true);
end $$;

-- fixtures (as the table owner) ---------------------------------------------------------------------------
insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, raw_app_meta_data, created_at, updated_at)
values
  ('61111111-1111-4111-8111-111111111111', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'p6a@example.test', '{}', '{"provider":"email","providers":["email"]}', now(), now()),
  ('62222222-2222-4222-8222-222222222222', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'p6b@example.test', '{}', '{"provider":"email","providers":["email"]}', now(), now());

insert into public.companies (id, name, name_normalized) values
  ('c1000000-0000-4000-8000-000000000001', 'Microsoft Corporation', 'microsoft'),
  ('c1000000-0000-4000-8000-000000000002', 'ASML Holding N.V.', 'asml holding'),
  ('c1000000-0000-4000-8000-000000000003', 'Nothing Inc.', 'nothing'),
  ('c1000000-0000-4000-8000-000000000004', 'Newcomer Inc.', 'newcomer'),
  ('c1000000-0000-4000-8000-000000000005', 'Watched Inc.', 'watched');
insert into public.securities (id, company_id, yahoo_symbol, exchange_code, currency, currency_major, quote_type, role, is_canonical) values
  ('d1000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000001', 'MSFT', 'NMS', 'USD', 'USD', 'EQUITY', 'canonical', true),
  ('d1000000-0000-4000-8000-000000000002', 'c1000000-0000-4000-8000-000000000002', 'ASML', 'NMS', 'USD', 'USD', 'EQUITY', 'canonical', true),
  ('d1000000-0000-4000-8000-000000000003', 'c1000000-0000-4000-8000-000000000003', 'NOTH', 'NMS', 'USD', 'USD', 'EQUITY', 'canonical', true),
  ('d1000000-0000-4000-8000-000000000004', 'c1000000-0000-4000-8000-000000000004', 'NEW1', 'NMS', 'USD', 'USD', 'EQUITY', 'canonical', true),
  ('d1000000-0000-4000-8000-000000000005', 'c1000000-0000-4000-8000-000000000005', 'WATCH', 'NMS', 'USD', 'USD', 'EQUITY', 'canonical', true);
insert into public.ibkr_catalogue (exchange_id, conid, symbol, local_symbol, isin, currency, description, product_type)
values ('IBIS', 12178239, 'MSF', 'MSF', 'US5949181045', 'EUR', 'MICROSOFT CORP', 'STK');

-- 1-8 structure ----------------------------------------------------------------------------------------------
select has_table('public', 'ibkr_catalogue', 'ibkr_catalogue exists');
select has_table('public', 'eur_equivalents', 'eur_equivalents exists');
select has_table('public', 'eur_equivalent_overrides', 'eur_equivalent_overrides exists');
select col_is_pk('public', 'ibkr_catalogue', array['exchange_id', 'conid'], 'ibkr_catalogue primary key is (exchange_id, conid)');
select has_index('public', 'ibkr_catalogue', 'ibkr_catalogue_isin_idx', 'ibkr_catalogue is indexed by isin');
select has_index('public', 'ibkr_catalogue', 'ibkr_catalogue_local_symbol_idx', 'ibkr_catalogue is indexed by local_symbol');
select enum_has_labels('public', 'eur_status', array['verified', 'unverified', 'none'], 'eur_status labels');
select has_column('public', 'profiles', 'default_destination', 'profiles.default_destination exists');

-- 9-18 eur_equivalents constraints (A-28 in the database) -----------------------------------------------------
select lives_ok($$insert into public.eur_equivalents (security_id, ibkr_exchange_id, ibkr_conid, ibkr_local_symbol, isin, eur_symbol_yahoo, status, verified_at)
  values ('d1000000-0000-4000-8000-000000000001', 'IBIS', 12178239, 'MSF', 'US5949181045', 'MSF.DE', 'verified', now())$$, 'a complete verified row is accepted');
select throws_ok($$insert into public.eur_equivalents (security_id, ibkr_exchange_id, ibkr_conid, ibkr_local_symbol, status, verified_at)
  values ('d1000000-0000-4000-8000-000000000001', 'IBIS', 1, 'X', 'unverified', null)$$, '23505', null, 'one row per security and exchange');
select throws_ok($$insert into public.eur_equivalents (security_id, ibkr_exchange_id, ibkr_conid, ibkr_local_symbol, status, verified_at)
  values ('d1000000-0000-4000-8000-000000000002', 'IBIS', 1, 'X', 'verified', now())$$, '23514', null, 'verified needs the Yahoo symbol');
select throws_ok($$insert into public.eur_equivalents (security_id, ibkr_exchange_id, ibkr_conid, ibkr_local_symbol, eur_symbol_yahoo, status, verified_at)
  values ('d1000000-0000-4000-8000-000000000002', 'IBIS', 1, 'X', 'X.DE', 'verified', null)$$, '23514', null, 'verified needs verified_at');
select throws_ok($$insert into public.eur_equivalents (security_id, ibkr_exchange_id, ibkr_conid, ibkr_local_symbol, status, verified_at)
  values ('d1000000-0000-4000-8000-000000000002', 'IBIS', 1, 'X', 'unverified', now())$$, '23514', null, 'unverified never carries verified_at');
select throws_ok($$insert into public.eur_equivalents (security_id, ibkr_exchange_id, ibkr_conid, status)
  values ('d1000000-0000-4000-8000-000000000003', 'IBIS', 1, 'none')$$, '23514', null, 'none carries no contract');
select throws_ok($$insert into public.eur_equivalents (security_id, ibkr_exchange_id, ibkr_conid, ibkr_local_symbol, status)
  values ('d1000000-0000-4000-8000-000000000002', 'FWB', 1, 'X', 'unverified')$$, '23514', null, 'only IBIS and AEB are accepted');
select lives_ok($$insert into public.eur_equivalents (security_id, ibkr_exchange_id, ibkr_conid, ibkr_local_symbol, isin, status)
  values ('d1000000-0000-4000-8000-000000000001', 'AEB', 5, 'MSF', 'US5949181045', 'unverified')$$, 'an unverified row is accepted without a Yahoo symbol');
select lives_ok($$insert into public.eur_equivalents (security_id, ibkr_exchange_id, status)
  values ('d1000000-0000-4000-8000-000000000003', 'IBIS', 'none')$$, 'a none row is accepted');
select throws_ok($$insert into public.eur_equivalents (security_id, ibkr_exchange_id, ibkr_conid, ibkr_local_symbol, currency, status)
  values ('d1000000-0000-4000-8000-000000000002', 'AEB', 1, 'X', 'USD', 'unverified')$$, '23514', null, 'the currency is EUR');

-- 19-25 app.replace_eur_equivalents --------------------------------------------------------------------------
select is(app.replace_eur_equivalents('d1000000-0000-4000-8000-000000000002', $j$[
  {"ibkr_exchange_id":"IBIS","ibkr_conid":777,"ibkr_local_symbol":"ASME","isin":"NL0010273215","eur_symbol_yahoo":null,"status":"unverified","verification":{"failed":["isin_confirmed"]},"verified_at":null},
  {"ibkr_exchange_id":"AEB","ibkr_conid":117589399,"ibkr_local_symbol":"ASML","isin":"NL0010273215","eur_symbol_yahoo":"ASML.AS","status":"verified","verification":{"failed":[]},"verified_at":"2026-10-15T07:30:00Z"}
]$j$::jsonb), 2, 'two rows are written');
select is((select count(*)::int from public.eur_equivalents where security_id = 'd1000000-0000-4000-8000-000000000002'), 2, 'ASML has an IBIS and an AEB row');
select is(app.replace_eur_equivalents('d1000000-0000-4000-8000-000000000002', $j$[
  {"ibkr_exchange_id":"AEB","ibkr_conid":117589399,"ibkr_local_symbol":"ASML","isin":"NL0010273215","eur_symbol_yahoo":"ASML.AS","status":"verified","verification":{"failed":[]},"verified_at":"2026-10-16T07:30:00Z"}
]$j$::jsonb), 1, 'a second call upserts');
select is((select array_agg(ibkr_exchange_id order by ibkr_exchange_id) from public.eur_equivalents where security_id = 'd1000000-0000-4000-8000-000000000002'),
  array['AEB'], 'the IBIS row that is no longer in the set is deleted');
select throws_ok($$select app.replace_eur_equivalents('d1000000-0000-4000-8000-000000000002', '[]'::jsonb)$$, '22023', null, 'an empty array never wipes a security');
select throws_ok($$select app.replace_eur_equivalents('d1000000-0000-4000-8000-000000000002', '{}'::jsonb)$$, '22023', null, 'a non-array is refused');
select throws_ok($$select app.replace_eur_equivalents('d1000000-0000-4000-8000-000000000002',
  '[{"ibkr_exchange_id":"IBIS","ibkr_conid":1,"ibkr_local_symbol":"X","status":"maybe"}]'::jsonb)$$, '22P02', null, 'an unknown status is refused');

-- 26-33 anon ----------------------------------------------------------------------------------------------------
set local role anon;
select ok((select count(*) from public.eur_equivalents) >= 2, 'anon reads eur_equivalents');
select ok((select count(*) from public.ibkr_catalogue) >= 1, 'anon reads ibkr_catalogue');
select throws_ok($$insert into public.eur_equivalents (security_id, ibkr_exchange_id, status) values ('d1000000-0000-4000-8000-000000000004', 'IBIS', 'none')$$,
  '42501', null, 'anon cannot insert eur_equivalents');
select throws_ok($$update public.eur_equivalents set status = 'none'$$, '42501', null, 'anon cannot update eur_equivalents');
select throws_ok($$insert into public.ibkr_catalogue (exchange_id, conid, symbol, local_symbol, currency, product_type) values ('IBIS', 1, 'X', 'X', 'EUR', 'STK')$$,
  '42501', null, 'anon cannot insert ibkr_catalogue');
select throws_ok($$select * from public.eur_equivalent_overrides$$, '42501', null, 'anon cannot read the overrides');
select throws_ok($$select app.replace_eur_equivalents('d1000000-0000-4000-8000-000000000002', '[]'::jsonb)$$, '42501', null, 'anon cannot call replace_eur_equivalents');
select throws_ok($$select * from app.eur_resolve_targets('00000000-0000-0000-0000-000000000000', 1)$$, '42501', null, 'anon cannot call eur_resolve_targets');
reset role;

-- 34-43 authenticated users (profiles.default_destination, A-39) -----------------------------------------------
select pg_temp.set_claims('61111111-1111-4111-8111-111111111111');
set local role authenticated;
select ok((select count(*) from public.eur_equivalents) >= 2, 'authenticated reads eur_equivalents');
select throws_ok($$delete from public.eur_equivalents$$, '42501', null, 'authenticated cannot delete eur_equivalents');
select throws_ok($$select * from public.eur_equivalent_overrides$$, '42501', null, 'authenticated cannot read the overrides');
select throws_ok($$select app.replace_eur_equivalents('d1000000-0000-4000-8000-000000000002', '[]'::jsonb)$$, '42501', null, 'authenticated cannot call replace_eur_equivalents');
select is((select default_destination from public.profiles where user_id = '61111111-1111-4111-8111-111111111111'), 'IBIS2', 'the default destination starts as IBIS2');
select lives_ok($$update public.profiles set default_destination = 'AEB' where user_id = '61111111-1111-4111-8111-111111111111'$$, 'the owner changes their destination');
select is((select default_destination from public.profiles where user_id = '61111111-1111-4111-8111-111111111111'), 'AEB', 'the change is stored');
select throws_ok($$update public.profiles set default_destination = 'XETRA' where user_id = '61111111-1111-4111-8111-111111111111'$$, '23514', null, 'only IBIS2, IBIS and AEB are accepted');
select lives_ok($$update public.profiles set default_destination = 'IBIS' where user_id = '62222222-2222-4222-8222-222222222222'$$, 'updating another user''s profile is a silent no-op');
reset role;
select is((select default_destination from public.profiles where user_id = '62222222-2222-4222-8222-222222222222'), 'IBIS2', 'another user''s destination is unchanged');

-- 44-50 overrides (service role = the table owner here) ---------------------------------------------------------
select throws_ok($$insert into public.eur_equivalent_overrides (security_id, ibkr_exchange_id, action, reason)
  values ('d1000000-0000-4000-8000-000000000003', 'IBIS', 'block', 'short')$$, '23514', null, 'a reason of at least 10 characters is required');
select throws_ok($$insert into public.eur_equivalent_overrides (security_id, ibkr_exchange_id, action, reason)
  values ('d1000000-0000-4000-8000-000000000003', 'IBIS', 'force', 'checked on the IBKR ticket')$$, '23514', null, 'force needs conid, local symbol and Yahoo symbol');
select lives_ok($$insert into public.eur_equivalent_overrides (security_id, ibkr_exchange_id, action, ibkr_conid, ibkr_local_symbol, eur_symbol_yahoo, reason)
  values ('d1000000-0000-4000-8000-000000000003', 'IBIS', 'force', 99, 'NOTH', 'NOTH.DE', 'checked on the IBKR ticket')$$, 'a force override is accepted');
select throws_ok($$insert into public.eur_equivalent_overrides (security_id, ibkr_exchange_id, action, reason)
  values ('d1000000-0000-4000-8000-000000000003', 'IBIS', 'block', 'second active override')$$, '23505', null, 'one active override per security and exchange');
select is((select count(*)::int from public.audit_events where target_type = 'security' and target_id = 'd1000000-0000-4000-8000-000000000003'), 1, 'the insert is audited');
select lives_ok($$update public.eur_equivalent_overrides set active = false where security_id = 'd1000000-0000-4000-8000-000000000003'$$, 'an override can be deactivated');
select is((select count(*)::int from public.audit_events where target_type = 'security' and target_id = 'd1000000-0000-4000-8000-000000000003'), 2, 'the update is audited');

-- 51-55 eur_resolve_targets ------------------------------------------------------------------------------------
insert into public.scan_runs (id, scan_date_local, settings_snapshot, results_published_at)
values ('e1000000-0000-4000-8000-000000000001', '2026-10-15', '{}'::jsonb, now());
insert into public.signal_episodes (id, security_id, company_id, kind, mode, threshold_line, opened_scan_run_id, opened_session_date, opened_close, opened_line_value, open_reason, last_evaluated_session_date)
select ('f1000000-0000-4000-8000-00000000000' || n)::uuid, ('d1000000-0000-4000-8000-00000000000' || n)::uuid, ('c1000000-0000-4000-8000-00000000000' || n)::uuid,
       'discount', 'worldwide', '-3', 'e1000000-0000-4000-8000-000000000001', '2026-10-14', 100, 110, 'new_entry', '2026-10-14'
  from generate_series(1, 4) as n;
insert into public.todays_discounts (scan_run_id, mode, security_id, company_id, episode_id, is_new_episode, rank, close, currency, session_date, threshold_line,
                                     lower_line_end, channel, trend_ok, eligibility, operational_category, category_reason, data_freshness, display_order)
select 'e1000000-0000-4000-8000-000000000001', 'worldwide', ('d1000000-0000-4000-8000-00000000000' || n)::uuid, ('c1000000-0000-4000-8000-00000000000' || n)::uuid,
       ('f1000000-0000-4000-8000-00000000000' || n)::uuid, true, n, 100, 'USD', '2026-10-14', '-3', 110, '{}'::jsonb, true, '{}'::jsonb, 'pending', 'research_pending', 'fresh', n
  from generate_series(1, 4) as n;

-- fresh rows: only the security without any row (NEW1) is due
select is((select array_agg(t order by t) from app.eur_resolve_targets('e1000000-0000-4000-8000-000000000001', 40) t),
  array['d1000000-0000-4000-8000-000000000004']::uuid[], 'only the never-resolved security is due');

-- age the rows by hand (the touch trigger would reset updated_at)
alter table public.eur_equivalents disable trigger eur_equivalents_touch;
alter table public.eur_equivalent_overrides disable trigger eur_overrides_touch;
update public.eur_equivalents set updated_at = now() - interval '31 days' where security_id = 'd1000000-0000-4000-8000-000000000001' and ibkr_exchange_id = 'IBIS';
update public.eur_equivalents set updated_at = now() - interval '1 day' where security_id = 'd1000000-0000-4000-8000-000000000001' and ibkr_exchange_id = 'AEB';
update public.eur_equivalent_overrides set updated_at = now() + interval '1 hour' where security_id = 'd1000000-0000-4000-8000-000000000003';
select is((select array_agg(t order by t) from app.eur_resolve_targets('e1000000-0000-4000-8000-000000000001', 40) t),
  array['d1000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000003', 'd1000000-0000-4000-8000-000000000004']::uuid[],
  'an expired row (31 days), a changed override and a never-resolved security are due; a fresh verified row is not');
select is((select count(*)::int from app.eur_resolve_targets('e1000000-0000-4000-8000-000000000001', 1)), 1, 'the limit is honoured');
-- the operator watch list adds canonical securities that are not cards (and a malformed value never breaks the function)
update public.app_settings set value = jsonb_set(value, '{extra_symbols}', '["WATCH", "NMSX"]'::jsonb) where key = 'eur_catalogue';
select is((select array_agg(t order by t) from app.eur_resolve_targets('e1000000-0000-4000-8000-000000000001', 40) t),
  array['d1000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000003', 'd1000000-0000-4000-8000-000000000004', 'd1000000-0000-4000-8000-000000000005']::uuid[],
  'a watch-list symbol is resolved even though it is not a card; unknown symbols are ignored');
update public.app_settings set value = jsonb_set(value, '{extra_symbols}', '"WATCH"'::jsonb) where key = 'eur_catalogue';
select lives_ok($$select count(*) from app.eur_resolve_targets('e1000000-0000-4000-8000-000000000001', 40)$$, 'a malformed watch list is ignored, not an error');
alter table public.eur_equivalents enable trigger eur_equivalents_touch;
alter table public.eur_equivalent_overrides enable trigger eur_overrides_touch;

-- 56-59 the public cards view and feed ---------------------------------------------------------------------------
-- MSFT: verified IBIS + unverified AEB; ASML: verified AEB only; NOTH: none row; NEW1: no row
select app.replace_eur_equivalents('d1000000-0000-4000-8000-000000000003', '[{"ibkr_exchange_id":"IBIS","status":"none","verification":{"reason":"no_catalogue_candidate"}}]'::jsonb);
set local role anon;
select is((select eur_status || ':' || ibkr_exchange_id || ':' || eur_symbol_yahoo from public.v_todays_discounts where yahoo_symbol = 'MSFT'),
  'verified:IBIS:MSF.DE', 'the card shows the verified IBIS line before the unverified AEB line');
select is((select eur_status || ':' || ibkr_exchange_id from public.v_todays_discounts where yahoo_symbol = 'ASML'), 'verified:AEB', 'a verified AEB line is shown when it is the only verified one');
select is((select eur_status || ':' || coalesce(eur_symbol_yahoo, '-') from public.v_todays_discounts where yahoo_symbol = 'NOTH'), 'none:-', 'a none row shows no EUR symbol');
select is((select count(*)::int from public.todays_discounts_feed('worldwide') where eur_status is null), 1, 'a security without any row has a null EUR status (the UI says "No verified EUR equivalent")');
reset role;

select * from finish();
rollback;
```

- [ ] **Step 3: Run; Expected: FAIL**

```powershell
bunx supabase start
bunx supabase db reset
bun run test:db
```
Expected: `0600_eur_handoff.test.sql` fails at the first assertion (`ibkr_catalogue exists`) and the fixture inserts into `ibkr_catalogue` error out (relation does not exist); the other pgTAP files still pass.

- [ ] **Step 4: Write the migration**

`supabase/migrations/20261015006000_eur_handoff.sql`:

```sql
-- P6: "Trade on IBKR" hand-off data (spec 5.7, 6.3, 6.9, 13.3).
--   ibkr_catalogue                weekly import of the public IBIS and AEB product lists (A-19); display data, readable by anon
--   eur_equivalents               the resolved EUR line per canonical security and exchange; display data, readable by anon
--   eur_equivalent_overrides      operator decisions (force / block), audited; service role only
--   profiles.default_destination  the owner's preferred iBot destination (A-39); already created by P1, re-asserted here
--   app.replace_eur_equivalents / app.eur_resolve_targets   service-role helpers used by worker-tick
-- The EUR mapping is never read by screening: nothing in eligibility, ranking, thresholds or episodes references these tables.

do $$
begin
  if to_regclass('public.securities') is null or to_regclass('public.profiles') is null
     or to_regclass('public.audit_events') is null or to_regclass('public.app_settings') is null
     or to_regclass('public.fx_rates') is null or to_regclass('public.todays_discounts') is null then
    raise exception 'P6 needs public.securities, profiles, audit_events, app_settings, fx_rates and todays_discounts from P1';
  end if;
end $$;

-- 1. enum -------------------------------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace where n.nspname = 'public' and t.typname = 'eur_status') then
    create type public.eur_status as enum ('verified', 'unverified', 'none');
  end if;
end $$;

-- 2. ibkr_catalogue ---------------------------------------------------------------------------------------
create table if not exists public.ibkr_catalogue (
  exchange_id  text not null,
  conid        bigint not null,
  symbol       text not null,
  local_symbol text not null,
  isin         text,
  currency     text not null,
  description  text,
  product_type text not null,
  fetched_at   timestamptz not null default now(),
  primary key (exchange_id, conid)
);

-- spec 6.3 named two columns `type` and `imported_at`; keep one set of names whichever migration created the table first
do $$
begin
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'ibkr_catalogue' and column_name = 'type') then
    alter table public.ibkr_catalogue rename column type to product_type;
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'ibkr_catalogue' and column_name = 'imported_at') then
    alter table public.ibkr_catalogue rename column imported_at to fetched_at;
  end if;
end $$;

create index if not exists ibkr_catalogue_isin_idx on public.ibkr_catalogue (isin);
create index if not exists ibkr_catalogue_local_symbol_idx on public.ibkr_catalogue (local_symbol);
create index if not exists ibkr_catalogue_symbol_idx on public.ibkr_catalogue (symbol);

-- 3. eur_equivalents --------------------------------------------------------------------------------------
create table if not exists public.eur_equivalents (
  id                uuid primary key default gen_random_uuid(),
  security_id       uuid not null references public.securities (id) on delete cascade,   -- the CANONICAL security it relates to
  ibkr_exchange_id  text not null check (ibkr_exchange_id in ('IBIS', 'AEB')),
  ibkr_conid        bigint,
  ibkr_local_symbol text,
  isin              text,
  eur_symbol_yahoo  text,
  currency          char(3) not null default 'EUR',
  status            public.eur_status not null,
  verification      jsonb not null default '{}'::jsonb,   -- checks, similarity, price deviation, fx rate_date (5.7 step 5)
  verified_at       timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (security_id, ibkr_exchange_id)
);
alter table public.eur_equivalents add column if not exists created_at timestamptz not null default now();
alter table public.eur_equivalents add column if not exists updated_at timestamptz not null default now();

-- A-28 at the database level: `verified` needs the contract, the Yahoo line and a verification time; `none` carries no contract at all.
alter table public.eur_equivalents drop constraint if exists eur_equivalents_status_shape;
alter table public.eur_equivalents add constraint eur_equivalents_status_shape check (
  currency = 'EUR' and (
    (status = 'none' and ibkr_conid is null and ibkr_local_symbol is null and eur_symbol_yahoo is null and verified_at is null)
    or (status = 'unverified' and ibkr_conid is not null and ibkr_local_symbol is not null and verified_at is null)
    or (status = 'verified' and ibkr_conid is not null and ibkr_local_symbol is not null and eur_symbol_yahoo is not null and verified_at is not null)
  )
);

drop trigger if exists eur_equivalents_touch on public.eur_equivalents;
create trigger eur_equivalents_touch before update on public.eur_equivalents
  for each row execute function app.touch_updated_at();

-- P1 left todays_discounts.eur_equivalent_id without a foreign key ("arrives with P2"); nothing writes it, the cards join by security
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'todays_discounts_eur_equivalent_fk') then
    alter table public.todays_discounts add constraint todays_discounts_eur_equivalent_fk
      foreign key (eur_equivalent_id) references public.eur_equivalents (id) on delete set null;
  end if;
end $$;

-- 4. eur_equivalent_overrides (operator decisions, audited) -----------------------------------------------
create table if not exists public.eur_equivalent_overrides (
  id                uuid primary key default gen_random_uuid(),
  security_id       uuid not null references public.securities (id) on delete cascade,
  ibkr_exchange_id  text not null check (ibkr_exchange_id in ('IBIS', 'AEB')),
  action            text not null check (action in ('force', 'block')),   -- force: use this line as verified; block: no EUR line on this exchange
  ibkr_conid        bigint,
  ibkr_local_symbol text,
  eur_symbol_yahoo  text,
  isin              text,
  reason            text not null check (length(btrim(reason)) >= 10),
  active            boolean not null default true,
  created_by        uuid references auth.users (id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  check (action = 'block' or (ibkr_conid is not null and ibkr_local_symbol is not null and eur_symbol_yahoo is not null))
);
create unique index if not exists eur_overrides_one_active
  on public.eur_equivalent_overrides (security_id, ibkr_exchange_id) where active;

drop trigger if exists eur_overrides_touch on public.eur_equivalent_overrides;
create trigger eur_overrides_touch before update on public.eur_equivalent_overrides
  for each row execute function app.touch_updated_at();

-- Every change is written to audit_events. P1's table has (actor_id, action, target_type, target_id, details); spec 6.3 names the columns
-- (actor, actor_user_id, event_type, target_type, target_id, data). The trigger function is generated for whichever shape exists.
do $outer$
declare
  v_cols text;
  v_vals text;
begin
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'audit_events' and column_name = 'event_type') then
    v_cols := 'actor, actor_user_id, event_type, target_type, target_id, data';
    v_vals := $v$case when auth.uid() is null then 'service' else 'admin' end, auth.uid(), 'eur_override.' || lower(tg_op), 'security', r.security_id::text, v_data$v$;
  elsif exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'audit_events' and column_name = 'action') then
    v_cols := 'actor_id, action, target_type, target_id, details';
    v_vals := $v$auth.uid(), 'eur_override.' || lower(tg_op), 'security', r.security_id::text, v_data$v$;
  else
    raise exception 'public.audit_events has neither event_type nor action: adapt app.audit_eur_override by hand';
  end if;
  execute format($f$
    create or replace function app.audit_eur_override() returns trigger
    language plpgsql security definer set search_path = '' as $fn$
    declare
      r public.eur_equivalent_overrides;
      v_data jsonb;
    begin
      r := case when tg_op = 'DELETE' then old else new end;
      v_data := jsonb_build_object('override_id', r.id, 'exchange', r.ibkr_exchange_id, 'action', r.action, 'active', r.active, 'reason', r.reason);
      insert into public.audit_events (%s) values (%s);
      return r;
    end $fn$ $f$, v_cols, v_vals);
end $outer$;

drop trigger if exists eur_overrides_audit on public.eur_equivalent_overrides;
create trigger eur_overrides_audit after insert or update or delete on public.eur_equivalent_overrides
  for each row execute function app.audit_eur_override();

-- 5. RLS: display data is public (nothing user specific), writes are service role only ---------------------
alter table public.ibkr_catalogue enable row level security;
alter table public.eur_equivalents enable row level security;
alter table public.eur_equivalent_overrides enable row level security;

revoke all on public.ibkr_catalogue, public.eur_equivalents, public.eur_equivalent_overrides from anon, authenticated;
grant select on public.ibkr_catalogue, public.eur_equivalents to anon, authenticated;

drop policy if exists ibkr_catalogue_public_read on public.ibkr_catalogue;
create policy ibkr_catalogue_public_read on public.ibkr_catalogue for select to anon, authenticated using (true);
drop policy if exists eur_equivalents_public_read on public.eur_equivalents;
create policy eur_equivalents_public_read on public.eur_equivalents for select to anon, authenticated using (true);
-- eur_equivalent_overrides: RLS on, no grant and no policy for anon or authenticated; the service role (which bypasses RLS) is the only user

-- 6. profiles.default_destination (A-39): P1 created it; make sure the constraint and the column grants exist ----
alter table public.profiles add column if not exists default_destination text not null default 'IBIS2';
alter table public.profiles drop constraint if exists profiles_default_destination_check;
alter table public.profiles add constraint profiles_default_destination_check check (default_destination in ('IBIS2', 'IBIS', 'AEB'));
grant select (default_destination) on public.profiles to authenticated;
grant update (default_destination) on public.profiles to authenticated;

-- 7. settings ---------------------------------------------------------------------------------------------
insert into public.app_settings (key, value, description, is_public) values
  ('eur_catalogue', '{"enabled": true, "require_shares": false, "max_resolve_per_run": 40, "extra_symbols": []}'::jsonb,
   'Weekly IBKR catalogue import and EUR-equivalent resolution (spec 5.7). enabled=false stops the import; require_shares=true makes a missing sharesOutstanding block verification.', false),
  ('eur_catalogue_state', '{}'::jsonb, 'Bookkeeping of the weekly catalogue import, written by worker-tick', false)
on conflict (key) do nothing;

-- 8. service-role helpers -----------------------------------------------------------------------------------
-- One transaction: upsert the given rows, then delete the security's rows for exchanges that are no longer in the set.
create or replace function app.replace_eur_equivalents(p_security_id uuid, p_rows jsonb) returns int
language plpgsql security definer set search_path = public, app as $$
declare
  v_n int;
begin
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then
    raise exception 'p_rows must be a non-empty json array' using errcode = '22023';
  end if;
  insert into eur_equivalents (security_id, ibkr_exchange_id, ibkr_conid, ibkr_local_symbol, isin, eur_symbol_yahoo, status, verification, verified_at)
  select p_security_id, r.ibkr_exchange_id, r.ibkr_conid, r.ibkr_local_symbol, r.isin, r.eur_symbol_yahoo,
         r.status::eur_status, coalesce(r.verification, '{}'::jsonb), r.verified_at
    from jsonb_to_recordset(p_rows) as r(ibkr_exchange_id text, ibkr_conid bigint, ibkr_local_symbol text, isin text, eur_symbol_yahoo text,
                                         status text, verification jsonb, verified_at timestamptz)
  on conflict (security_id, ibkr_exchange_id) do update set
    ibkr_conid = excluded.ibkr_conid, ibkr_local_symbol = excluded.ibkr_local_symbol, isin = excluded.isin,
    eur_symbol_yahoo = excluded.eur_symbol_yahoo, status = excluded.status, verification = excluded.verification,
    verified_at = excluded.verified_at;
  get diagnostics v_n = row_count;
  delete from eur_equivalents
   where security_id = p_security_id
     and ibkr_exchange_id not in (select r.ibkr_exchange_id from jsonb_to_recordset(p_rows) as r(ibkr_exchange_id text));
  return v_n;
end $$;

-- Canonical securities that need (re)resolution: today's cards, the operator watch list (app_settings eur_catalogue.extra_symbols, Yahoo symbols)
-- and, when P5 data exists, the canonical securities of held companies.
-- Due when never resolved; older than 30 days; doubtful (unverified or none) and older than the latest catalogue import;
-- or an override changed after the last resolution.
create or replace function app.eur_resolve_targets(p_run uuid, p_limit int default 40) returns setof uuid
language plpgsql stable security definer set search_path = public, app as $$
declare
  v_held text := '';
begin
  if to_regclass('public.broker_positions') is not null then
    v_held := $h$ union
      select c.canonical_security_id from broker_positions p
        join securities s on s.id = p.security_id
        join companies c on c.id = s.company_id
       where c.canonical_security_id is not null $h$;
  end if;
  return query execute format($q$
    with watchlist as (
      select case when jsonb_typeof(a.v) = 'array' then a.v else '[]'::jsonb end as symbols
        from (select (select value -> 'extra_symbols' from app_settings where key = 'eur_catalogue') as v) a
    ),
    cand as (
      select t.security_id as id from todays_discounts t where t.scan_run_id = $1
      union
      select s.id from securities s where s.is_canonical and s.yahoo_symbol in (select jsonb_array_elements_text(symbols) from watchlist)
      %s
    )
    select c.id from cand c
     where not exists (select 1 from eur_equivalents e where e.security_id = c.id)
        or exists (select 1 from eur_equivalents e where e.security_id = c.id and e.updated_at < now() - interval '30 days')
        or exists (select 1 from eur_equivalents e where e.security_id = c.id and e.status <> 'verified'
                     and e.updated_at < coalesce((select max(k.fetched_at) from ibkr_catalogue k), '-infinity'::timestamptz))
        or exists (select 1 from eur_equivalent_overrides o where o.security_id = c.id
                     and o.updated_at > coalesce((select max(e.updated_at) from eur_equivalents e where e.security_id = c.id), '-infinity'::timestamptz))
     order by c.id
     limit $2 $q$, v_held) using p_run, p_limit;
end $$;

revoke all on function app.replace_eur_equivalents(uuid, jsonb) from public, anon, authenticated;
revoke all on function app.eur_resolve_targets(uuid, int) from public, anon, authenticated;
grant execute on function app.replace_eur_equivalents(uuid, jsonb) to service_role;
grant execute on function app.eur_resolve_targets(uuid, int) to service_role;

-- 9. the public cards view: real EUR columns instead of P1's typed nulls (spec 6.6.4) --------------------------
-- Guard: the view must still have exactly P1's column list; if a later phase changed it, merge by hand instead of overwriting it.
do $$
declare
  v_expected text[] := array['scan_run_id','mode','rank','display_order','withheld','security_id','yahoo_symbol','name','exchange_code','exchange_name',
    'close','currency','session_date','threshold_line','lower_line_end','data_freshness','is_new_episode','since_date','operational_category',
    'category_reason','conclusion','bankruptcy_risk','summary','research_completed_at','report_id','eur_symbol_yahoo','ibkr_local_symbol',
    'ibkr_exchange_id','eur_status','eur_verified_at'];
  v_actual text[];
begin
  select array_agg(column_name::text order by ordinal_position) into v_actual
    from information_schema.columns where table_schema = 'public' and table_name = 'v_todays_discounts';
  if v_actual is distinct from v_expected then
    raise exception 'public.v_todays_discounts columns changed since P1 (%). Merge the eur_equivalents lateral join into the current definition by hand.', v_actual;
  end if;
end $$;

create or replace view public.v_todays_discounts with (security_invoker = true) as
select t.scan_run_id, t.mode, t.rank, t.display_order, t.withheld, s.id as security_id, s.yahoo_symbol, c.name, ex.code as exchange_code, ex.name as exchange_name,
       t.close, t.currency, t.session_date, t.threshold_line, t.lower_line_end, t.data_freshness, t.is_new_episode, e.opened_session_date as since_date,
       t.operational_category, t.category_reason, t.conclusion, t.bankruptcy_risk, t.summary, t.research_completed_at, t.report_id,
       eq.eur_symbol_yahoo, eq.ibkr_local_symbol, eq.ibkr_exchange_id, eq.status::text as eur_status, eq.verified_at as eur_verified_at
  from todays_discounts t
  join securities s on s.id = t.security_id
  join companies c on c.id = t.company_id
  join exchanges ex on ex.code = s.exchange_code
  join signal_episodes e on e.id = t.episode_id
  left join lateral (
    select q.* from eur_equivalents q
     where q.security_id = t.security_id
     order by case q.status when 'verified' then 0 when 'unverified' then 1 else 2 end, (q.ibkr_exchange_id = 'IBIS') desc
     limit 1
  ) eq on true
 where t.scan_run_id = (select id from scan_runs where results_published_at is not null order by scan_date_local desc limit 1);
```

Notes for the implementer:
- `eur_equivalents_status_shape` is the database-level form of A-28: `verified` needs `ibkr_conid`, `ibkr_local_symbol`, `eur_symbol_yahoo` and `verified_at`; `unverified` needs the contract and no `verified_at`; `none` carries nothing.
- The view guard compares the current column list of `v_todays_discounts` with P1's 30 columns. If a later phase changed the view the migration stops with the actual list: merge the `left join lateral` and the five EUR columns into the current definition by hand (keep `eq.status::text as eur_status`; `CREATE OR REPLACE VIEW` cannot change a column type).
- The `audit_events` trigger is generated by a `DO` block for the table shape that exists; if neither `event_type` nor `action` exists the block raises and tells you to adapt it.
- `app.eur_resolve_targets` reads `broker_positions` only through dynamic SQL guarded by `to_regclass`, so the migration applies before P5b's tables exist.

- [ ] **Step 5: Run; Expected: PASS**

```powershell
bunx supabase db reset
bun run test:db
```
Expected: `0600_eur_handoff.test.sql .. ok` with `Tests=59`, all other files still pass. If the fixture insert of `signal_episodes` or `todays_discounts` fails because P1 added a NOT NULL column, add the column to the two `insert ... select ... generate_series` statements (values are irrelevant to the assertions) and note it in the commit. If an `anon` assertion on `v_todays_discounts` fails with `permission denied`, check that P1 grants `select` on `scan_runs` (the columns `id`, `scan_date_local`, `results_published_at`) to `anon`; the view is `security_invoker`.

- [ ] **Step 6: Commit**

```powershell
git add supabase/migrations/20261015006000_eur_handoff.sql supabase/tests/0600_eur_handoff.test.sql
git commit -m "feat(db): add EUR hand-off tables, overrides with audit, resolve helpers and the real EUR join in the cards view"
```

---

## Task 2: Adapter `ibkr-catalogue.ts` (gentle, bounded pagination)

**Concurrency:** may run at the same time as Tasks 1 and 4 (disjoint files). Implementer: sonnet.

**Files:**
- Create: `supabase/functions/_shared/adapters/ibkr-catalogue.ts`, `supabase/functions/_shared/adapters/ibkr-catalogue.test.ts`
- Create: `supabase/functions/_shared/adapters/fixtures/ibkr-catalogue-ibis-page1.json`, `supabase/functions/_shared/adapters/fixtures/ibkr-catalogue-aeb-page1.json`

**Interfaces:**
- Consumes: `adapters/clock.ts` (`Clock`, `createFakeClock`; P1 Task 8).
- Produces: `fetchExchangeProducts(exchangeId, { fetchImpl, clock, pause, budget?, signal?, fetchedAt? }): Promise<FetchExchangeResult>`, `createImportBudget({ maxPages?, maxRequests? })`, `mapProduct`, `retryAfterMs`, `createFixtureCatalogueFetch(pages)`, constants `CATALOGUE_ENDPOINT`, `CATALOGUE_REFERER`, `CATALOGUE_USER_AGENT`, `PAGE_SIZE` (100), `SPACING_MS` (300), `MAX_PAGES` (35), `MAX_REQUESTS` (50), `MAX_RETRIES` (3), types `CatalogueRow`, `FetchExchangeResult`, `ImportAbort`, `ImportBudget`, `CatalogueFetch`.

- [ ] **Step 1: Write the fixtures**

Shape, symbols, conids and ISINs come from research `ibkr-flex-links-ibot.md` sections 4 and 6 (MSF 12178239, APC 13013300, SAP 14204; ASML 117589399, ADYEN 321202935, Unilever UNVB with localSymbol UNA 837455595); only the Microsoft description is verbatim, the others are reconstructed, and the ETF, USD-stock and IOPT rows are synthetic filter probes (each says so).

`supabase/functions/_shared/adapters/fixtures/ibkr-catalogue-ibis-page1.json`:

```json
{
  "_note": "Test fixture. Shape, symbols, conids and ISINs of MSF, APC and SAP come from docs/discovery/research/ibkr-flex-links-ibot.md sections 4 and 6; only the MSF description (MICROSOFT CORP) is verbatim, the other descriptions are reconstructed. The last two rows are SYNTHETIC filter probes (an ETF and a USD-quoted stock), not real products.",
  "products": [
    {
      "type": "STK",
      "symbol": "MSF",
      "exchangeId": "IBIS",
      "localSymbol": "MSF",
      "description": "MICROSOFT CORP",
      "conid": 12178239,
      "isin": "US5949181045",
      "cusip": "594918104",
      "currency": "EUR",
      "country": "DE",
      "isPrimeExchId": "T"
    },
    {
      "type": "STK",
      "symbol": "APC",
      "exchangeId": "IBIS",
      "localSymbol": "APC",
      "description": "APPLE INC",
      "conid": 13013300,
      "isin": "US0378331005",
      "currency": "EUR",
      "country": "DE"
    },
    {
      "type": "STK",
      "symbol": "SAP",
      "exchangeId": "IBIS",
      "localSymbol": "SAP",
      "description": "SAP SE",
      "conid": 14204,
      "isin": "DE0007164600",
      "currency": "EUR",
      "country": "DE"
    },
    {
      "type": "ETF",
      "symbol": "TESTETF",
      "exchangeId": "IBIS",
      "localSymbol": "TESTETF",
      "description": "SYNTHETIC ETF ROW (TEST ONLY)",
      "conid": 900000001,
      "isin": null,
      "currency": "EUR",
      "country": "DE"
    },
    {
      "type": "STK",
      "symbol": "TESTUSD",
      "exchangeId": "IBIS",
      "localSymbol": "TESTUSD",
      "description": "SYNTHETIC USD STOCK ROW (TEST ONLY)",
      "conid": 900000002,
      "isin": null,
      "currency": "USD",
      "country": "DE"
    }
  ],
  "productTypeCount": [{ "productType": "STK", "count": 4 }, { "productType": "ETF", "count": 1 }],
  "productCount": 5
}
```

`supabase/functions/_shared/adapters/fixtures/ibkr-catalogue-aeb-page1.json`:

```json
{
  "_note": "Test fixture. Symbols, localSymbols, conids and ISINs of ASML, ADYEN and Unilever PLC (symbol UNVB, localSymbol UNA) come from docs/discovery/research/ibkr-flex-links-ibot.md section 6; the descriptions are reconstructed. The IOPT row is a SYNTHETIC filter probe, not a real product.",
  "products": [
    {
      "type": "STK",
      "symbol": "ADYEN",
      "exchangeId": "AEB",
      "localSymbol": "ADYEN",
      "description": "ADYEN NV",
      "conid": 321202935,
      "isin": "NL0012969182",
      "currency": "EUR",
      "country": "NL"
    },
    {
      "type": "STK",
      "symbol": "ASML",
      "exchangeId": "AEB",
      "localSymbol": "ASML",
      "description": "ASML HOLDING NV",
      "conid": 117589399,
      "isin": "NL0010273215",
      "currency": "EUR",
      "country": "NL"
    },
    {
      "type": "IOPT",
      "symbol": "TESTTRK",
      "exchangeId": "AEB",
      "localSymbol": "TESTTRK",
      "description": "SYNTHETIC TRACKER ETP ROW (TEST ONLY)",
      "conid": 900000003,
      "isin": null,
      "currency": "EUR",
      "country": "NL"
    },
    {
      "type": "STK",
      "symbol": "UNVB",
      "exchangeId": "AEB",
      "localSymbol": "UNA",
      "description": "UNILEVER PLC",
      "conid": 837455595,
      "isin": "GB00BVZK7T90",
      "currency": "EUR",
      "country": "NL"
    }
  ],
  "productTypeCount": [{ "productType": "STK", "count": 3 }, { "productType": "IOPT", "count": 1 }],
  "productCount": 4
}
```

- [ ] **Step 2: Write the failing test**

`supabase/functions/_shared/adapters/ibkr-catalogue.test.ts`:

```ts
import { assert, assertEquals } from "@std/assert";
import { createFakeClock } from "./clock.ts";
import {
  CATALOGUE_ENDPOINT,
  CATALOGUE_REFERER,
  CATALOGUE_USER_AGENT,
  type CatalogueFetch,
  createFixtureCatalogueFetch,
  createImportBudget,
  fetchExchangeProducts,
  mapProduct,
  PAGE_SIZE,
  retryAfterMs,
} from "./ibkr-catalogue.ts";

const fixture = async (name: string): Promise<{ products: unknown[]; productCount: number }> =>
  JSON.parse(await Deno.readTextFile(new URL(`./fixtures/${name}`, import.meta.url)));

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

interface Call {
  url: string;
  init: RequestInit;
  at: number;
  body: {
    domain: string;
    exchangeId: string;
    pageNumber: number;
    pageSize: number;
    sortDirection: string;
    sortField: string;
  };
}

/** A scripted fetch: each entry answers one request in order; the last entry repeats. Records every call with the fake time. */
function harness(
  script: Array<Response | Error | ((call: Call) => Response)>,
  budgetOpts?: { maxPages?: number; maxRequests?: number },
) {
  const clock = createFakeClock();
  const calls: Call[] = [];
  let i = 0;
  const fetchImpl: CatalogueFetch = (url, init = {}) => {
    const call: Call = { url, init, at: clock.now(), body: JSON.parse(String(init.body)) };
    calls.push(call);
    const next = script[Math.min(i++, script.length - 1)] as
      | Response
      | Error
      | ((c: Call) => Response);
    if (next instanceof Error) return Promise.reject(next);
    return Promise.resolve(typeof next === "function" ? next(call) : next.clone());
  };
  const budget = createImportBudget(budgetOpts);
  const deps = {
    fetchImpl,
    clock,
    pause: (ms: number) => clock.sleep(ms),
    budget,
    fetchedAt: "2026-10-15T07:00:00.000Z",
  };
  return { clock, calls, deps, budget };
}

const filler = (page: number): unknown[] =>
  Array.from({ length: PAGE_SIZE }, (_, n) => ({
    type: "ETF",
    symbol: `F${page}_${n}`,
    localSymbol: `F${page}_${n}`,
    conid: page * 1000 + n + 1,
    currency: "EUR",
  }));

Deno.test("IBIS fixture: only EUR stocks are kept, mapped to ibkr_catalogue columns; the request is exactly what the research probe sent", async () => {
  const page = await fixture("ibkr-catalogue-ibis-page1.json");
  const h = harness([json(page)]);
  const r = await fetchExchangeProducts("IBIS", h.deps);
  assertEquals(r.complete, true);
  assertEquals(r.aborted, null);
  assertEquals(r.scanned, 5);
  assertEquals(r.productCount, 5);
  assertEquals(r.skipped, { wrong_type: 1, wrong_currency: 1, invalid: 0 });
  assertEquals(
    r.rows.map((x) => [x.local_symbol, x.conid, x.isin]),
    [
      ["MSF", 12178239, "US5949181045"],
      ["APC", 13013300, "US0378331005"],
      ["SAP", 14204, "DE0007164600"],
    ],
  );
  assertEquals(r.rows[0], {
    exchange_id: "IBIS",
    conid: 12178239,
    symbol: "MSF",
    local_symbol: "MSF",
    isin: "US5949181045",
    currency: "EUR",
    description: "MICROSOFT CORP",
    product_type: "STK",
    fetched_at: "2026-10-15T07:00:00.000Z",
  });

  assertEquals(h.calls.length, 1);
  const call = h.calls[0] as Call;
  assertEquals(call.url, CATALOGUE_ENDPOINT);
  assertEquals(call.init.method, "POST");
  assertEquals(call.body, {
    domain: "com",
    exchangeId: "IBIS",
    pageNumber: 1,
    pageSize: 100,
    sortDirection: "asc",
    sortField: "symbol",
  });
  assertEquals(Object.keys(call.body), [
    "domain",
    "exchangeId",
    "pageNumber",
    "pageSize",
    "sortDirection",
    "sortField",
  ]);
  const headers = call.init.headers as Record<string, string>;
  assertEquals(headers["Content-Type"], "application/json");
  assertEquals(headers["Referer"], CATALOGUE_REFERER);
  assertEquals(headers["User-Agent"], CATALOGUE_USER_AGENT);
  assert(
    CATALOGUE_USER_AGENT.includes("personal-stock-screener"),
    "a descriptive User-Agent identifies the importer",
  );
});

Deno.test("AEB fixture: Unilever keeps symbol UNVB and localSymbol UNA; the IOPT tracker row is dropped", async () => {
  const page = await fixture("ibkr-catalogue-aeb-page1.json");
  const r = await fetchExchangeProducts("AEB", harness([json(page)]).deps);
  assertEquals(
    r.rows.map((x) => [x.symbol, x.local_symbol, x.conid]),
    [
      ["ADYEN", "ADYEN", 321202935],
      ["ASML", "ASML", 117589399],
      ["UNVB", "UNA", 837455595],
    ],
  );
  assertEquals(r.skipped.wrong_type, 1);
  assert(
    r.rows.every(
      (x) => x.exchange_id === "AEB" && x.currency === "EUR" && x.product_type === "STK",
    ),
  );
});

Deno.test("mapProduct: rejects malformed rows, normalises the ISIN, never throws", () => {
  const ok = {
    type: "STK",
    symbol: " MSF ",
    localSymbol: "MSF",
    conid: "12178239",
    currency: "EUR",
    isin: "us5949181045",
    description: "  ",
  };
  const mapped = mapProduct(ok, "IBIS", "t");
  assert("row" in mapped);
  if ("row" in mapped) {
    assertEquals(
      [mapped.row.symbol, mapped.row.conid, mapped.row.isin, mapped.row.description],
      ["MSF", 12178239, "US5949181045", null],
    );
  }
  assertEquals(mapProduct({ ...ok, isin: "not-an-isin" }, "IBIS", "t"), {
    row: {
      exchange_id: "IBIS",
      conid: 12178239,
      symbol: "MSF",
      local_symbol: "MSF",
      isin: null,
      currency: "EUR",
      description: null,
      product_type: "STK",
      fetched_at: "t",
    },
  });
  for (const bad of [
    null,
    5,
    [],
    {},
    { ...ok, conid: 0 },
    { ...ok, conid: 1.5 },
    { ...ok, symbol: "" },
    { ...ok, localSymbol: undefined },
  ]) {
    assertEquals("skip" in mapProduct(bad, "IBIS", "t"), true);
  }
  assertEquals(mapProduct({ ...ok, type: "ETF" }, "IBIS", "t"), { skip: "wrong_type" });
  assertEquals(mapProduct({ ...ok, currency: "USD" }, "IBIS", "t"), { skip: "wrong_currency" });
});

Deno.test("pagination: a full page is followed by the next page, a short page ends it, requests are 300 ms apart", async () => {
  const last = await fixture("ibkr-catalogue-ibis-page1.json");
  const h = harness([json({ products: filler(1), productCount: 105 }), json(last)]);
  const r = await fetchExchangeProducts("IBIS", h.deps);
  assertEquals(r.complete, true);
  assertEquals(
    h.calls.map((c) => c.body.pageNumber),
    [1, 2],
  );
  assertEquals(r.pages, 2);
  assertEquals(r.scanned, 105);
  assertEquals(r.rows.length, 3);
  assert((h.calls[1] as Call).at - (h.calls[0] as Call).at >= 300, "300 ms spacing");
});

Deno.test("pagination: a full last page is confirmed by productCount, an empty page also ends it", async () => {
  const a = harness([json({ products: filler(1), productCount: 100 })]);
  assertEquals((await fetchExchangeProducts("IBIS", a.deps)).complete, true);
  assertEquals(a.calls.length, 1, "productCount reached, no extra request");

  const b = harness([json({ products: filler(1) }), json({ products: [] })]);
  const r = await fetchExchangeProducts("IBIS", b.deps);
  assertEquals(r.complete, true);
  assertEquals(b.calls.length, 2);
});

Deno.test("spacing holds across exchanges because the budget is shared", async () => {
  const ibis = await fixture("ibkr-catalogue-ibis-page1.json");
  const aeb = await fixture("ibkr-catalogue-aeb-page1.json");
  const fetchImpl = createFixtureCatalogueFetch({ IBIS: [ibis.products], AEB: [aeb.products] });
  const clock = createFakeClock();
  const starts: number[] = [];
  const spy: CatalogueFetch = (url, init) => {
    starts.push(clock.now());
    return fetchImpl(url, init);
  };
  const budget = createImportBudget();
  const deps = { fetchImpl: spy, clock, pause: (ms: number) => clock.sleep(ms), budget };
  await fetchExchangeProducts("IBIS", deps);
  const second = await fetchExchangeProducts("AEB", deps);
  assertEquals(second.rows.length, 3);
  assertEquals(starts.length, 2);
  assert((starts[1] as number) - (starts[0] as number) >= 300);
  assertEquals([budget.pages, budget.requests], [2, 2]);
});

Deno.test("HTTP 500 is retried exactly 3 times with 1 s, 2 s and 4 s backoff, then the import is abandoned (no 5th request)", async () => {
  const h = harness([new Response("boom", { status: 500 })]);
  const r = await fetchExchangeProducts("IBIS", h.deps);
  assertEquals(h.calls.length, 4);
  assertEquals(r.complete, false);
  assertEquals(r.aborted, { reason: "http_error", status: 500, page: 1 });
  assertEquals(r.rows, []);
  assertEquals(
    h.clock.sleeps.filter((ms) => ms >= 1000),
    [1000, 2000, 4000],
  );
});

Deno.test("a 429 with Retry-After waits for the longer of the header and the backoff, then continues", async () => {
  const page = await fixture("ibkr-catalogue-ibis-page1.json");
  const h = harness([
    new Response("slow down", { status: 429, headers: { "retry-after": "7" } }),
    json(page),
  ]);
  const r = await fetchExchangeProducts("IBIS", h.deps);
  assertEquals(r.complete, true);
  assertEquals(h.calls.length, 2);
  assert(h.clock.sleeps.includes(7000));
  assertEquals(retryAfterMs(new Response(null, { headers: { "retry-after": "9999" } })), 60_000);
  assertEquals(
    retryAfterMs(
      new Response(null, { headers: { "retry-after": "Wed, 21 Oct 2026 07:28:00 GMT" } }),
    ),
    null,
  );
});

Deno.test("a 403 or 404 is not retried at all", async () => {
  for (const status of [403, 404, 400]) {
    const h = harness([new Response("no", { status })]);
    const r = await fetchExchangeProducts("IBIS", h.deps);
    assertEquals(h.calls.length, 1);
    assertEquals(r.aborted?.reason, "http_error");
    assertEquals(r.aborted?.status, status);
  }
});

Deno.test("a network error is retried once and then succeeds; a persistent one aborts after 4 attempts", async () => {
  const page = await fixture("ibkr-catalogue-ibis-page1.json");
  const a = harness([new TypeError("connection reset"), json(page)]);
  assertEquals((await fetchExchangeProducts("IBIS", a.deps)).complete, true);
  assertEquals(a.calls.length, 2);

  const b = harness([new TypeError("down")]);
  const r = await fetchExchangeProducts("IBIS", b.deps);
  assertEquals(b.calls.length, 4);
  assertEquals(r.aborted, { reason: "network_error", status: null, page: 1 });
});

Deno.test("an unexpected body is not retried: invalid JSON and a missing products array abort at once", async () => {
  const a = harness([new Response("<html>maintenance</html>", { status: 200 })]);
  assertEquals((await fetchExchangeProducts("IBIS", a.deps)).aborted?.reason, "bad_shape");
  assertEquals(a.calls.length, 1);
  const b = harness([json({ error: "nope" })]);
  assertEquals((await fetchExchangeProducts("IBIS", b.deps)).aborted?.reason, "bad_shape");
});

Deno.test("an abort after page 1 keeps the rows read so far but is never complete", async () => {
  const h = harness([
    json({ products: filler(1), productCount: 250 }),
    new Response("x", { status: 503 }),
  ]);
  const r = await fetchExchangeProducts("IBIS", h.deps);
  assertEquals(r.complete, false);
  assertEquals(r.pages, 1);
  assertEquals(r.aborted?.page, 2);
  assertEquals(h.calls.length, 1 + 4);
});

Deno.test("the page budget stops an endless catalogue at maxPages", async () => {
  const h = harness(
    [(call) => json({ products: filler(call.body.pageNumber), productCount: 99999 })],
    { maxPages: 3 },
  );
  const r = await fetchExchangeProducts("IBIS", h.deps);
  assertEquals(r.pages, 3);
  assertEquals(r.complete, false);
  assertEquals(r.aborted, { reason: "page_budget", status: null, page: 4 });
  assertEquals(h.calls.length, 3);
});

Deno.test("the request budget caps retries across the whole import: a flapping endpoint cannot be hammered", async () => {
  const h = harness([new Response("x", { status: 500 })], { maxRequests: 3 });
  const r = await fetchExchangeProducts("IBIS", h.deps);
  assertEquals(h.calls.length, 3);
  assertEquals(r.aborted?.reason, "request_budget");
  // a second exchange sharing the budget makes no request at all
  const second = await fetchExchangeProducts("AEB", h.deps);
  assertEquals(h.calls.length, 3);
  assertEquals(second.aborted?.reason, "request_budget");
});

Deno.test("an aborted signal stops before the next request", async () => {
  const h = harness([json({ products: filler(1), productCount: 500 })]);
  const ctl = new AbortController();
  const deps = {
    ...h.deps,
    signal: ctl.signal,
    pause: async (ms: number) => {
      ctl.abort();
      await h.clock.sleep(ms);
    },
  };
  const r = await fetchExchangeProducts("IBIS", deps);
  assertEquals(r.aborted?.reason, "aborted");
  assertEquals(h.calls.length, 1);
});

Deno.test("createFixtureCatalogueFetch serves pages by exchange and page number", async () => {
  const f = createFixtureCatalogueFetch({ IBIS: [[{ a: 1 }], [{ a: 2 }]] });
  const res = await f(CATALOGUE_ENDPOINT, {
    method: "POST",
    body: JSON.stringify({ exchangeId: "IBIS", pageNumber: 2 }),
  });
  assertEquals((await res.json()).products, [{ a: 2 }]);
  const empty = await f(CATALOGUE_ENDPOINT, {
    method: "POST",
    body: JSON.stringify({ exchangeId: "NOPE", pageNumber: 1 }),
  });
  assertEquals((await empty.json()).products, []);
});
```

- [ ] **Step 3: Run; Expected: FAIL**

```powershell
deno test -A --config supabase/functions/deno.json supabase/functions/_shared/adapters/ibkr-catalogue.test.ts
```
Expected: FAIL with `Module not found "file:///.../ibkr-catalogue.ts"`.

- [ ] **Step 4: Implement**

`supabase/functions/_shared/adapters/ibkr-catalogue.ts`:

```ts
import type { Clock } from "./clock.ts";

/**
 * Weekly import of IBKR's public product catalogue for Xetra (IBIS) and Euronext Amsterdam (AEB) (spec 5.7, flex 4).
 * The endpoints are undocumented and unauthenticated; permission for programmatic use is UNVERIFIED (Q-10), so this adapter is deliberately
 * gentle: 100-row pages, 300 ms between requests, at most 35 pages and 50 requests per import, three retries with exponential backoff
 * and then the import is abandoned for the day. It never loops and never runs on a user request path.
 */

export const CATALOGUE_ENDPOINT =
  "https://www.interactivebrokers.com/webrest/search/products-by-exchangeId";
export const CATALOGUE_REFERER =
  "https://www.interactivebrokers.com/en/trading/products-exchanges.php";
export const CATALOGUE_USER_AGENT =
  "personal-stock-screener/1.0 (single-owner weekly catalogue import of IBIS and AEB; low volume: about 35 requests per week)";
export const PAGE_SIZE = 100; // pageSize 2000 returned HTTP 500 in the research probe
export const SPACING_MS = 300;
export const MAX_PAGES = 35; // IBIS 23 pages + AEB 11 pages today (flex 4)
export const MAX_REQUESTS = 50; // pages plus retries, across the whole import
export const MAX_RETRIES = 3;
export const BACKOFF_BASE_MS = 1_000;
export const RETRY_AFTER_CAP_MS = 60_000;

export type CatalogueFetch = (url: string, init?: RequestInit) => Promise<Response>;

/** Row shape of public.ibkr_catalogue (spec 6.3; `type` and `imported_at` are named `product_type` and `fetched_at`, A-19 variant). */
export interface CatalogueRow {
  exchange_id: string;
  conid: number;
  symbol: string;
  local_symbol: string;
  isin: string | null;
  currency: string;
  description: string | null;
  product_type: string;
  fetched_at: string;
}

export type AbortReason =
  | "http_error"
  | "network_error"
  | "bad_shape"
  | "page_budget"
  | "request_budget"
  | "aborted";
export interface ImportAbort {
  reason: AbortReason;
  status: number | null;
  page: number;
}

export interface SkipCounts {
  wrong_type: number;
  wrong_currency: number;
  invalid: number;
}

export interface FetchExchangeResult {
  exchangeId: string;
  rows: CatalogueRow[]; // STK and EUR only
  scanned: number; // every product row seen, before filtering
  pages: number;
  productCount: number | null;
  complete: boolean;
  aborted: ImportAbort | null;
  skipped: SkipCounts;
}

/** Shared by every exchange of one import so the page, request and spacing limits hold for the whole import. */
export interface ImportBudget {
  maxPages: number;
  maxRequests: number;
  pages: number;
  requests: number;
  lastRequestAt: number | null;
}

export function createImportBudget(
  opts: { maxPages?: number; maxRequests?: number } = {},
): ImportBudget {
  return {
    maxPages: opts.maxPages ?? MAX_PAGES,
    maxRequests: opts.maxRequests ?? MAX_REQUESTS,
    pages: 0,
    requests: 0,
    lastRequestAt: null,
  };
}

export interface FetchDeps {
  fetchImpl: CatalogueFetch;
  clock: Pick<Clock, "now">;
  pause: (ms: number) => Promise<void>;
  budget?: ImportBudget;
  signal?: AbortSignal;
  /** ISO timestamp written into every row (injected so tests are deterministic). */
  fetchedAt?: string;
}

const ISIN = /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/;

type Skip = keyof SkipCounts;

/** Pure: one raw product to a catalogue row, or the reason it is skipped. Only EUR stocks are kept (ETFs, indices, other currencies are not equivalents). */
export function mapProduct(
  raw: unknown,
  exchangeId: string,
  fetchedAt: string,
): { row: CatalogueRow } | { skip: Skip } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { skip: "invalid" };
  const p = raw as Record<string, unknown>;
  if (p["type"] !== "STK")
    return { skip: typeof p["type"] === "string" ? "wrong_type" : "invalid" };
  if (p["currency"] !== "EUR")
    return { skip: typeof p["currency"] === "string" ? "wrong_currency" : "invalid" };
  const conid =
    typeof p["conid"] === "string" && /^\d+$/.test(p["conid"]) ? Number(p["conid"]) : p["conid"];
  const symbol = typeof p["symbol"] === "string" ? p["symbol"].trim() : "";
  const localSymbol = typeof p["localSymbol"] === "string" ? p["localSymbol"].trim() : "";
  if (
    typeof conid !== "number" ||
    !Number.isSafeInteger(conid) ||
    conid <= 0 ||
    symbol === "" ||
    localSymbol === ""
  )
    return { skip: "invalid" };
  const isin =
    typeof p["isin"] === "string" && ISIN.test(p["isin"].trim().toUpperCase())
      ? p["isin"].trim().toUpperCase()
      : null;
  const description =
    typeof p["description"] === "string" && p["description"].trim() !== ""
      ? p["description"].trim()
      : null;
  return {
    row: {
      exchange_id: exchangeId,
      conid,
      symbol,
      local_symbol: localSymbol,
      isin,
      currency: "EUR",
      description,
      product_type: "STK",
      fetched_at: fetchedAt,
    },
  };
}

/** Seconds only (the HTTP-date form is ignored); capped so a hostile header cannot park the job. */
export function retryAfterMs(res: Pick<Response, "headers">): number | null {
  const v = res.headers.get("retry-after");
  if (v === null || !/^\d+$/.test(v.trim())) return null;
  return Math.min(RETRY_AFTER_CAP_MS, Number(v.trim()) * 1_000);
}

const retryable = (status: number): boolean => status === 429 || status >= 500;
const backoffMs = (failures: number): number => BACKOFF_BASE_MS * 2 ** failures; // 1 s, 2 s, 4 s

type PageOutcome =
  | { kind: "page"; products: unknown[]; productCount: number | null }
  | { kind: "abort"; abort: Omit<ImportAbort, "page"> };

async function requestPage(
  exchangeId: string,
  pageNumber: number,
  deps: FetchDeps,
  budget: ImportBudget,
): Promise<PageOutcome> {
  const body = JSON.stringify({
    domain: "com",
    exchangeId,
    pageNumber,
    pageSize: PAGE_SIZE,
    sortDirection: "asc",
    sortField: "symbol",
  });
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json",
    Referer: CATALOGUE_REFERER,
    "User-Agent": CATALOGUE_USER_AGENT,
  };
  const isAborted = (): boolean => deps.signal?.aborted === true;
  for (let failures = 0; failures <= MAX_RETRIES; failures++) {
    if (isAborted()) return { kind: "abort", abort: { reason: "aborted", status: null } };
    if (budget.requests >= budget.maxRequests)
      return { kind: "abort", abort: { reason: "request_budget", status: null } };
    const wait =
      budget.lastRequestAt === null
        ? 0
        : Math.max(0, SPACING_MS - (deps.clock.now() - budget.lastRequestAt));
    if (wait > 0) await deps.pause(wait);
    if (isAborted()) return { kind: "abort", abort: { reason: "aborted", status: null } };
    budget.lastRequestAt = deps.clock.now();
    budget.requests += 1;

    let res: Response;
    try {
      res = await deps.fetchImpl(CATALOGUE_ENDPOINT, {
        method: "POST",
        headers,
        body,
        ...(deps.signal ? { signal: deps.signal } : {}),
      });
    } catch (_e) {
      if (isAborted()) return { kind: "abort", abort: { reason: "aborted", status: null } };
      if (failures === MAX_RETRIES)
        return { kind: "abort", abort: { reason: "network_error", status: null } };
      await deps.pause(backoffMs(failures));
      continue;
    }

    if (res.ok) {
      let json: unknown;
      try {
        json = await res.json();
      } catch (_e) {
        return { kind: "abort", abort: { reason: "bad_shape", status: res.status } };
      }
      const products = (json as { products?: unknown } | null)?.products;
      if (!Array.isArray(products))
        return { kind: "abort", abort: { reason: "bad_shape", status: res.status } };
      const count = (json as { productCount?: unknown }).productCount;
      return {
        kind: "page",
        products,
        productCount: typeof count === "number" && Number.isFinite(count) ? count : null,
      };
    }

    const status = res.status;
    const hint = retryAfterMs(res);
    await res.body?.cancel();
    if (!retryable(status) || failures === MAX_RETRIES)
      return { kind: "abort", abort: { reason: "http_error", status } };
    await deps.pause(Math.max(backoffMs(failures), hint ?? 0));
  }
  return { kind: "abort", abort: { reason: "http_error", status: null } }; // unreachable: the loop returns on its last iteration
}

/**
 * Pages through one exchange. Stops on the first short or empty page, when `productCount` rows were seen, on the first abort condition
 * (HTTP error after retries, bad response shape, page or request budget, abort signal). Never throws for network or HTTP problems: the
 * caller reads `complete` and `aborted`. An aborted result still carries the rows read so far, but the caller must not treat it as a full import.
 */
export async function fetchExchangeProducts(
  exchangeId: string,
  deps: FetchDeps,
): Promise<FetchExchangeResult> {
  const budget = deps.budget ?? createImportBudget();
  const fetchedAt = deps.fetchedAt ?? new Date(deps.clock.now()).toISOString();
  const result: FetchExchangeResult = {
    exchangeId,
    rows: [],
    scanned: 0,
    pages: 0,
    productCount: null,
    complete: false,
    aborted: null,
    skipped: { wrong_type: 0, wrong_currency: 0, invalid: 0 },
  };
  for (let page = 1; ; page++) {
    if (budget.pages >= budget.maxPages) {
      result.aborted = { reason: "page_budget", status: null, page };
      return result;
    }
    const outcome = await requestPage(exchangeId, page, deps, budget);
    if (outcome.kind === "abort") {
      result.aborted = { ...outcome.abort, page };
      return result;
    }
    budget.pages += 1;
    result.pages += 1;
    if (outcome.productCount !== null) result.productCount = outcome.productCount;
    for (const raw of outcome.products) {
      result.scanned += 1;
      const mapped = mapProduct(raw, exchangeId, fetchedAt);
      if ("row" in mapped) result.rows.push(mapped.row);
      else result.skipped[mapped.skip] += 1;
    }
    const seenAll = result.productCount !== null && result.scanned >= result.productCount;
    if (outcome.products.length < PAGE_SIZE || seenAll) {
      result.complete = true;
      return result;
    }
  }
}

/** Offline `fetch` for fixture mode and tests: answers the catalogue endpoint from per-exchange page arrays (an unknown page is an empty page). */
export function createFixtureCatalogueFetch(pages: Record<string, unknown[][]>): CatalogueFetch {
  return (_url, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      exchangeId?: string;
      pageNumber?: number;
    };
    const list = pages[String(body.exchangeId)] ?? [];
    const products = list[(body.pageNumber ?? 1) - 1] ?? [];
    const productCount = list.reduce((n, p) => n + p.length, 0);
    return Promise.resolve(
      new Response(JSON.stringify({ products, productTypeCount: [], productCount }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  };
}
```

- [ ] **Step 5: Run; Expected: PASS**

```powershell
deno test -A --config supabase/functions/deno.json supabase/functions/_shared/adapters/ibkr-catalogue.test.ts
bun run functions:check
bun run lint:fix
bun run lint
```
Expected: 16 tests pass (`ok | 16 passed | 0 failed`); `functions:check` and `lint` clean.

- [ ] **Step 6: Commit**

```powershell
git add supabase/functions/_shared/adapters/ibkr-catalogue.ts supabase/functions/_shared/adapters/ibkr-catalogue.test.ts supabase/functions/_shared/adapters/fixtures/ibkr-catalogue-ibis-page1.json supabase/functions/_shared/adapters/fixtures/ibkr-catalogue-aeb-page1.json
git commit -m "feat(adapters): add the gentle IBKR catalogue adapter with bounded pagination and backoff"
```

---

## Task 3: `eur_catalogue` and `eur_resolve` handlers in `worker-tick`

**Depends on:** Tasks 1, 2 and 4 (it imports `isValidLocalSymbol` and the `EurExchange`/`EurStatus` types from `core/handoff.ts`) and P1. Implementer: sonnet.

**Files:**
- Create: `supabase/functions/_shared/adapters/fixture-eur.ts`, `supabase/functions/_shared/adapters/fixture-eur.test.ts` (offline EUR data for fixture mode)
- Create: `supabase/functions/worker-tick/handlers/eur_match.ts` (pure rules), `eur_resolve.ts` (ports, `resolveEurEquivalent`, handler, seeder), `eur_catalogue.ts` (weekly import handler, seeder), `eur_store.ts` (service-role store), `eur_register.ts` (the four registrations), `eur.test.ts`
- Create: `supabase/migrations/20261015006100_eur_stage_order.sql`, `supabase/tests/0601_eur_stage_order.test.sql`, `supabase/functions/worker-tick/stages-eur.test.ts`
- Modify: `supabase/functions/worker-tick/stages.ts`, `supabase/functions/_shared/adapters/settings.ts` and its test

**Interfaces:**
- Consumes: Task 2 (`fetchExchangeProducts`, `createImportBudget`, `CatalogueRow`, `CatalogueFetch`), Task 4 (`isValidLocalSymbol`, `EurExchange`, `EurStatus`), P1 (`normalizeName`, `MarketDataProvider`, `QuoteRecord`, `Handler`, `HandlerContext`, `Seeder`, `SeedPlan`, `systemClock`), Task 1 (`app.replace_eur_equivalents`, `app.eur_resolve_targets`, tables, settings rows).
- Produces: `matchBasis`, `rankCandidates`, `assessCandidate`, `nameSimilarity`, `priceDeviation`, `baseTicker`, `probeSymbol`, `isoWeek` (pure); `resolveEurEquivalent`, `runEurResolve`, `seedEurResolve`, `parseEurSettings`, ports `ResolveStore`, `CatalogueStore`; `runEurCatalogue`, `seedEurCatalogue`, `parseCatalogueState`; `createEurStore(sb)`; `handleEurCatalogue`, `handleEurResolve`, `seedEurCatalogueStage`, `seedEurResolveStage`.

**What the handlers do (spec 5.7):**
1. Candidates: `ibkr_catalogue` rows (STK, EUR, IBIS or AEB) whose ISIN is a known ISIN of the security (`securities.isin`, or `broker_positions.isin` of any listing of the same company), or whose description matches the name at similarity >= 0.9 (edit distance on `normalizeName` output), or whose `symbol` equals the Yahoo base ticker; at most 3 per exchange, IBIS first.
2. ISIN confirmation: Yahoo `search(candidate.isin)`, first hit symbol must equal the canonical Yahoo symbol (and a known ISIN must equal the candidate's).
3. Yahoo cross-check in **one** `quote()` call for the canonical line and every probe `<localSymbol>.DE` or `.AS`: `quoteType = EQUITY`, currency EUR, equal normalised name, equal shares when both present, price within 1% after FX from `fx_rates`.
4. Status per exchange (verified before unverified; hard mismatches are dropped), `app.replace_eur_equivalents` in one transaction, `securities.isin` written only for a verified match; overrides win (`force` writes a manual verified row without Yahoo traffic for that exchange, `block` removes the exchange).
5. The import (`eur_catalogue:<iso-week>`): disabled, already imported this week and already attempted today are skipped with a reason; the attempt is recorded before the first request; abandoned imports leave the previous rows alone.

- [ ] **Step 1: Verify the contracts**

```powershell
git grep -n "export function normalizeName" -- supabase/functions/_shared/core
git grep -n "export type Handler\|export interface HandlerContext\|export interface SeedPlan" -- supabase/functions/worker-tick/types.ts
git grep -n "PIPELINE_ORDER\|HANDLERS\|SEEDERS" -- supabase/functions/worker-tick/stages.ts
git grep -n "export const systemClock" -- supabase/functions/_shared/adapters/clock.ts
git grep -n "fx_rates" -- supabase/migrations
```
Expected: one hit each. If `normalizeName` lives elsewhere or has another signature, change only the import in `eur_match.ts` and `eur_resolve.ts`. Confirm Task 4 is merged: `git grep -n "export function isValidLocalSymbol" -- supabase/functions/_shared/core/handoff.ts`.

- [ ] **Step 2: Write the failing test**

`supabase/functions/worker-tick/handlers/eur.test.ts` covers the pure helpers, the verification rules (including every Review Focus case), overrides, the handlers and seeders with fakes, and the weekly import behaviour (fixture pages, aborts, same-day and same-week skips):

```ts
import { assert, assertEquals, assertRejects } from "@std/assert";
import { createFakeClock } from "../../_shared/adapters/clock.ts";
import {
  type CatalogueRow,
  createFixtureCatalogueFetch,
} from "../../_shared/adapters/ibkr-catalogue.ts";
import type { QuoteRecord } from "../../_shared/adapters/providers.ts";
import { parseCatalogueState, runEurCatalogue, seedEurCatalogue } from "./eur_catalogue.ts";
import {
  assessCandidate,
  baseTicker,
  type CanonicalSecurity,
  type CatalogueCandidate,
  isoWeek,
  matchBasis,
  nameSimilarity,
  priceDeviation,
  probeSymbol,
  rankCandidates,
} from "./eur_match.ts";
import {
  type CatalogueStore,
  type EurEquivalentRow,
  type FxRate,
  type OverrideRow,
  parseEurSettings,
  type ResolveStore,
  resolveEurEquivalent,
  runEurResolve,
  seedEurResolve,
} from "./eur_resolve.ts";

// ------------------------------------------------------------------------------------------------ fixtures and fakes

const NOW = Date.UTC(2026, 9, 15, 7, 30, 0);
const SHARES = 7_425_545_491;

const MSFT: CanonicalSecurity = {
  id: "sec-msft",
  yahooSymbol: "MSFT",
  currency: "USD",
  currencyMajor: "USD",
  minorDivisor: 1,
  longName: "Microsoft Corporation",
  companyName: "Microsoft Corporation",
  sharesOutstanding: SHARES,
  isin: null,
};
const UNILEVER: CanonicalSecurity = {
  id: "sec-ulvr",
  yahooSymbol: "ULVR.L",
  currency: "GBp",
  currencyMajor: "GBP",
  minorDivisor: 100,
  longName: "Unilever PLC",
  companyName: "Unilever PLC",
  sharesOutstanding: 2_480_000_000,
  isin: null,
};

const MSF: CatalogueCandidate = {
  exchange_id: "IBIS",
  conid: 12178239,
  symbol: "MSF",
  local_symbol: "MSF",
  isin: "US5949181045",
  description: "MICROSOFT CORP",
};
const UNA: CatalogueCandidate = {
  exchange_id: "AEB",
  conid: 837455595,
  symbol: "UNVB",
  local_symbol: "UNA",
  isin: "GB00BVZK7T90",
  description: "UNILEVER PLC",
};
// A look-alike on AEB: same ticker as the US stock, but it is the tracker ETP (research: MSFT.AS is "LS 1x Microsoft Tracker ETP Securities").
const MSFT_TRACKER: CatalogueCandidate = {
  exchange_id: "AEB",
  conid: 900000010,
  symbol: "MSFT",
  local_symbol: "MSFT",
  isin: "XS0000000010",
  description: "LS 1X MICROSOFT TRACKER ETP",
};

const quote = (symbol: string, over: Partial<QuoteRecord> = {}): QuoteRecord => ({
  symbol,
  quoteType: "EQUITY",
  currency: "EUR",
  financialCurrency: null,
  exchange: "GER",
  fullExchangeName: "XETRA",
  longName: "Microsoft Corporation",
  shortName: null,
  marketCap: null,
  sharesOutstanding: SHARES,
  regularMarketPrice: 472.85,
  regularMarketTime: NOW,
  regularMarketPreviousClose: null,
  regularMarketChangePercent: null,
  marketState: "CLOSED",
  firstTradeDateMs: null,
  exchangeTimezoneName: null,
  priceHint: null,
  ...over,
});
const msftQuote = (over: Partial<QuoteRecord> = {}): QuoteRecord =>
  quote("MSFT", {
    currency: "USD",
    exchange: "NMS",
    fullExchangeName: "NasdaqGS",
    regularMarketPrice: 533.69,
    ...over,
  });

const FX: Record<string, FxRate> = {
  EUR: { usdPerUnit: 1.1213, rateDate: "2026-10-14" },
  USD: { usdPerUnit: 1, rateDate: "2026-10-14" },
  GBP: { usdPerUnit: 1.3, rateDate: "2026-10-14" },
};

function fakeMarket(opts: {
  search?: Record<string, string | null>;
  quotes?: QuoteRecord[];
  failQuote?: Error;
  failSearch?: Error;
}) {
  const calls = { search: [] as string[], quote: [] as string[][] };
  return {
    calls,
    market: {
      search(q: string) {
        calls.search.push(q);
        if (opts.failSearch) return Promise.reject(opts.failSearch);
        const symbol = opts.search?.[q] ?? null;
        return Promise.resolve({
          hits:
            symbol === null
              ? []
              : [
                  {
                    symbol,
                    exchange: "NMS",
                    quoteType: "EQUITY",
                    longName: null,
                    shortName: null,
                    sector: null,
                    industry: null,
                  },
                ],
          news: [],
        });
      },
      quote(symbols: string[]) {
        calls.quote.push(symbols);
        if (opts.failQuote) return Promise.reject(opts.failQuote);
        const wanted = new Set(symbols.map((s) => s.toUpperCase()));
        return Promise.resolve(
          (opts.quotes ?? []).filter((x) => wanted.has(x.symbol.toUpperCase())),
        );
      },
    },
  };
}

function fakeStore(
  opts: {
    candidates?: CatalogueCandidate[];
    overrides?: OverrideRow[];
    held?: string[];
    security?: CanonicalSecurity | null;
    targets?: string[];
    settings?: Record<string, unknown>;
  } = {},
) {
  const settings = new Map<string, unknown>(Object.entries(opts.settings ?? {}));
  const log = {
    replaced: [] as { id: string; rows: EurEquivalentRow[] }[],
    isins: [] as [string, string][],
    upserts: [] as CatalogueRow[][],
    findQueries: [] as unknown[],
  };
  const store: ResolveStore & CatalogueStore = {
    getSetting: (k) => Promise.resolve(settings.get(k) ?? null),
    setSetting: (k, v) => {
      settings.set(k, structuredClone(v));
      return Promise.resolve();
    },
    loadSecurity: () => Promise.resolve(opts.security === undefined ? MSFT : opts.security),
    heldIsins: () => Promise.resolve(opts.held ?? []),
    activeOverrides: () => Promise.resolve(opts.overrides ?? []),
    findCandidates: (q) => {
      log.findQueries.push(q);
      return Promise.resolve(opts.candidates ?? []);
    },
    loadFx: (ccys) =>
      Promise.resolve(new Map(ccys.flatMap((c) => (FX[c] ? [[c, FX[c] as FxRate] as const] : [])))),
    replaceEquivalents: (id, rows) => {
      log.replaced.push({ id, rows });
      return Promise.resolve();
    },
    setSecurityIsin: (id, isin) => {
      log.isins.push([id, isin]);
      return Promise.resolve();
    },
    resolveTargets: () => Promise.resolve(opts.targets ?? []),
    upsertCatalogue: (rows) => {
      log.upserts.push(rows);
      return Promise.resolve();
    },
  };
  return { store, settings, log };
}

const resolve = (
  security: CanonicalSecurity,
  m: ReturnType<typeof fakeMarket>,
  s: ReturnType<typeof fakeStore>,
  requireShares = false,
) =>
  resolveEurEquivalent(security, {
    store: s.store,
    market: m.market,
    scanDate: "2026-10-15",
    nowMs: NOW,
    requireShares,
  });

/** The verification document of a stored row, typed for the assertion at hand. */
const verificationOf = <T>(row: EurEquivalentRow | undefined): T => (row?.verification ?? {}) as T;

// ------------------------------------------------------------------------------------------------ pure helpers

Deno.test("nameSimilarity: IBKR descriptions against Yahoo long names", () => {
  assertEquals(nameSimilarity("MICROSOFT CORP", "Microsoft Corporation"), 1);
  assertEquals(nameSimilarity("ASML HOLDING NV", "ASML Holding N.V."), 1);
  assert(nameSimilarity("SAP SE", "SAP SE") === 1);
  assert(
    nameSimilarity("GOOGLE INC.", "Alphabet Inc.") < 0.9,
    "a stale IBKR description must not match; ISIN is what matches those",
  );
  assert(nameSimilarity("LS 1X MICROSOFT TRACKER ETP", "Microsoft Corporation") < 0.9);
  assertEquals(nameSimilarity("", "Microsoft"), 0);
});

Deno.test("baseTicker, probeSymbol and isoWeek", () => {
  assertEquals(
    [baseTicker("MSFT"), baseTicker("SAP.DE"), baseTicker("BRK-B"), baseTicker("ulvr.l")],
    ["MSFT", "SAP", "BRK-B", "ULVR"],
  );
  assertEquals([probeSymbol("IBIS", "MSF"), probeSymbol("AEB", "UNA")], ["MSF.DE", "UNA.AS"]);
  assertEquals(isoWeek("2026-10-15"), "2026-W42");
  assertEquals(isoWeek("2026-10-18"), "2026-W42"); // Sunday
  assertEquals(isoWeek("2026-10-19"), "2026-W43"); // Monday
  assertEquals(isoWeek("2026-01-01"), "2026-W01");
  assertEquals(isoWeek("2027-01-01"), "2026-W53");
  assertEquals(isoWeek("2024-12-30"), "2025-W01");
  assertEquals(isoWeek("2024-02-29"), "2024-W09");
});

Deno.test("priceDeviation: MSF.DE x EURUSD against MSFT is 0.65% apart (spike 3.5); GBp is divided by the minor divisor", () => {
  const fx = { eurUsd: 1.1213, ccyUsd: 1, rateDate: "2026-10-14" };
  const d = priceDeviation({
    eurPrice: 472.85,
    canonicalPrice: 533.69,
    canonicalMinorDivisor: 1,
    canonicalMajor: "USD",
    fx,
  });
  assert(d !== null && Math.abs(d + 0.0065) < 0.0002, `got ${d}`);
  // ULVR.L at 4,500 GBp = 45 GBP = 58.5 USD; EUR price 52.17 x 1.1213 = 58.5 USD
  const u = priceDeviation({
    eurPrice: 52.17,
    canonicalPrice: 4500,
    canonicalMinorDivisor: 100,
    canonicalMajor: "GBP",
    fx: { eurUsd: 1.1213, ccyUsd: 1.3, rateDate: "x" },
  });
  assert(u !== null && Math.abs(u) < 0.001, `got ${u}`);
  assertEquals(
    priceDeviation({
      eurPrice: 100,
      canonicalPrice: 100,
      canonicalMinorDivisor: 1,
      canonicalMajor: "EUR",
      fx: { eurUsd: null, ccyUsd: null, rateDate: null },
    }),
    0,
  );
  assertEquals(
    priceDeviation({
      eurPrice: 100,
      canonicalPrice: 100,
      canonicalMinorDivisor: 1,
      canonicalMajor: "USD",
      fx: { eurUsd: null, ccyUsd: 1, rateDate: null },
    }),
    null,
  );
  assertEquals(
    priceDeviation({
      eurPrice: null,
      canonicalPrice: 100,
      canonicalMinorDivisor: 1,
      canonicalMajor: "USD",
      fx,
    }),
    null,
  );
});

Deno.test("matchBasis: ISIN beats description beats ticker; unrelated rows are dropped", () => {
  assertEquals(matchBasis(MSFT, ["US5949181045"], MSF)?.basis, "isin");
  assertEquals(matchBasis(MSFT, [], MSF)?.basis, "description");
  assertEquals(
    matchBasis(MSFT, [], { ...MSF, symbol: "MSFT", description: "UNRELATED NAME" })?.basis,
    "symbol",
  );
  assertEquals(matchBasis(MSFT, [], { ...MSF, description: "UNRELATED NAME" }), null);
});

Deno.test("rankCandidates: IBIS before AEB, ISIN basis first, at most N per exchange", () => {
  const mk = (
    c: CatalogueCandidate,
    basis: "isin" | "description" | "symbol",
    similarity: number | null = 1,
  ) => ({ candidate: c, match: { basis, similarity } });
  const out = rankCandidates(
    [
      mk(UNA, "isin"),
      mk(MSF, "description"),
      mk({ ...MSF, conid: 1 }, "isin"),
      mk({ ...MSF, conid: 2 }, "isin"),
      mk({ ...MSF, conid: 3 }, "isin"),
    ],
    2,
  );
  assertEquals(
    out.map((r) => r.candidate.conid),
    [1, 2, 837455595],
  );
});

Deno.test("parseEurSettings and parseCatalogueState tolerate garbage", () => {
  assertEquals(parseEurSettings(null), {
    enabled: true,
    requireShares: false,
    maxResolvePerRun: 40,
  });
  assertEquals(parseEurSettings({ enabled: false, require_shares: true, max_resolve_per_run: 5 }), {
    enabled: false,
    requireShares: true,
    maxResolvePerRun: 5,
  });
  assertEquals(parseEurSettings({ enabled: "no", max_resolve_per_run: 9999 }), {
    enabled: true,
    requireShares: false,
    maxResolvePerRun: 40,
  });
  assertEquals(parseCatalogueState("x"), {
    last_success_week: null,
    last_success_at: null,
    last_attempt_day: null,
    last_result: null,
    detail: null,
  });
});

// ------------------------------------------------------------------------------------------------ resolution (spec 5.7)

Deno.test("MSFT resolves to MSF.DE as verified on IBIS, and the confirmed ISIN is stored for later use", async () => {
  const m = fakeMarket({
    search: { US5949181045: "MSFT" },
    quotes: [msftQuote(), quote("MSF.DE")],
  });
  const s = fakeStore({ candidates: [MSF] });
  const out = await resolve(MSFT, m, s);
  assertEquals(out.summary.result, "verified");
  assertEquals(out.rows.length, 1);
  const row = out.rows[0] as EurEquivalentRow;
  assertEquals(
    [row.ibkr_exchange_id, row.ibkr_local_symbol, row.ibkr_conid, row.eur_symbol_yahoo, row.status],
    ["IBIS", "MSF", 12178239, "MSF.DE", "verified"],
  );
  assertEquals(row.isin, "US5949181045");
  assertEquals(row.verified_at, "2026-10-15T07:30:00.000Z");
  const v = row.verification as {
    checks: Record<string, string>;
    failed: string[];
    price_deviation_pct: number;
    method: string;
    basis: string;
  };
  assertEquals(v.failed, []);
  assertEquals(v.method, "automatic");
  assertEquals(v.basis, "description"); // the ISIN of MSFT was not known yet; the description (1.0) found the row
  assert(
    Object.values(v.checks).every((c) => c === "pass"),
    JSON.stringify(v.checks),
  );
  assert(Math.abs(v.price_deviation_pct + 0.65) < 0.05);
  assertEquals(out.isin, "US5949181045");
  assertEquals(m.calls.search, ["US5949181045"]);
  assertEquals(m.calls.quote.length, 1, "one quote() call for the canonical line and every probe");
  assertEquals(m.calls.quote[0], ["MSFT", "MSF.DE"]);
});

Deno.test("a known ISIN (from Flex) finds the row even when the catalogue description is stale", async () => {
  const stale: CatalogueCandidate = {
    exchange_id: "IBIS",
    conid: 208914695,
    symbol: "ABEC",
    local_symbol: "ABEC",
    isin: "US02079K1079",
    description: "GOOGLE INC.",
  };
  const alphabet: CanonicalSecurity = {
    ...MSFT,
    id: "sec-goog",
    yahooSymbol: "GOOG",
    longName: "Alphabet Inc.",
    companyName: "Alphabet Inc.",
  };
  const m = fakeMarket({
    search: { US02079K1079: "GOOG" },
    quotes: [
      msftQuote({ symbol: "GOOG", longName: "Alphabet Inc.", regularMarketPrice: 200 }),
      quote("ABEC.DE", { longName: "Alphabet Inc.", regularMarketPrice: 178.4 }),
    ],
  });
  const s = fakeStore({ candidates: [stale], held: ["US02079K1079"] });
  const out = await resolve(alphabet, m, s);
  assertEquals(out.summary.result, "verified");
  assertEquals(verificationOf<{ basis: string }>(out.rows[0]).basis, "isin");
});

Deno.test("the MSFT.AS look-alike (tracker ETP) is rejected and never becomes the EUR equivalent", async () => {
  const m = fakeMarket({
    search: { US5949181045: "MSFT", XS0000000010: "MSFT.AS" },
    quotes: [
      msftQuote(),
      quote("MSF.DE"),
      quote("MSFT.AS", {
        quoteType: "ETF",
        longName: "LS 1x Microsoft Tracker ETP Securities",
        sharesOutstanding: null,
        regularMarketPrice: 9.664,
      }),
    ],
  });
  const s = fakeStore({ candidates: [MSF, MSFT_TRACKER] });
  const out = await resolve(MSFT, m, s);
  assertEquals(out.summary, {
    result: "verified",
    candidates: 2,
    verified: 1,
    unverified: 0,
    rejected: 1,
    overrides: 0,
  });
  assertEquals(
    out.rows.map((r) => r.ibkr_exchange_id),
    ["IBIS"],
    "no AEB row is stored for the look-alike",
  );
  assert(out.rows.every((r) => r.eur_symbol_yahoo !== "MSFT.AS"));
});

Deno.test("the look-alike alone yields none, with the hard failures recorded, never unverified", async () => {
  const m = fakeMarket({
    search: { XS0000000010: "MSFT.AS" },
    quotes: [
      msftQuote(),
      quote("MSFT.AS", {
        quoteType: "ETF",
        longName: "LS 1x Microsoft Tracker ETP Securities",
        regularMarketPrice: 9.664,
      }),
    ],
  });
  const out = await resolve(MSFT, m, fakeStore({ candidates: [MSFT_TRACKER] }));
  assertEquals(out.summary.result, "none");
  const row = out.rows[0] as EurEquivalentRow;
  assertEquals([row.status, row.ibkr_local_symbol, row.eur_symbol_yahoo], ["none", null, null]);
  const v = row.verification as { reason: string; rejected: { hard_failed: string[] }[] };
  assertEquals(v.reason, "all_candidates_rejected");
  assertEquals(v.rejected[0]?.hard_failed.sort(), [
    "isin_confirmed",
    "name_match",
    "quote_type_equity",
  ]);
});

Deno.test("a price 3% off is unverified with the reason recorded", async () => {
  const m = fakeMarket({
    search: { US5949181045: "MSFT" },
    quotes: [msftQuote({ regularMarketPrice: 549.7 }), quote("MSF.DE")],
  });
  const out = await resolve(MSFT, m, fakeStore({ candidates: [MSF] }));
  assertEquals(out.summary.result, "unverified");
  const row = out.rows[0] as EurEquivalentRow;
  assertEquals(row.status, "unverified");
  assertEquals(row.verified_at, null);
  assertEquals(
    row.eur_symbol_yahoo,
    "MSF.DE",
    "the Yahoo line exists, so the unverified row still names it",
  );
  const v = row.verification as {
    failed: string[];
    hard_failed: string[];
    price_deviation_pct: number;
  };
  assertEquals(v.failed, ["price_within_tolerance"]);
  assertEquals(v.hard_failed, []);
  assert(v.price_deviation_pct < -3 && v.price_deviation_pct > -4, `got ${v.price_deviation_pct}`);
  assertEquals(out.isin, null, "an unverified match never writes securities.isin");
});

Deno.test("0.99% off is verified, 1.1% off is not", async () => {
  // implied = 472.85 x 1.1213 = 530.2; canonical = implied / 0.9901 -> deviation -0.99%
  const edge = (472.85 * 1.1213) / 0.9901;
  const ok = await resolve(
    MSFT,
    fakeMarket({
      search: { US5949181045: "MSFT" },
      quotes: [msftQuote({ regularMarketPrice: edge }), quote("MSF.DE")],
    }),
    fakeStore({ candidates: [MSF] }),
  );
  assertEquals(ok.summary.result, "verified");
  const off = await resolve(
    MSFT,
    fakeMarket({
      search: { US5949181045: "MSFT" },
      quotes: [msftQuote({ regularMarketPrice: (472.85 * 1.1213) / 0.989 }), quote("MSF.DE")],
    }),
    fakeStore({ candidates: [MSF] }),
  );
  assertEquals(off.summary.result, "unverified");
});

Deno.test("no catalogue candidate gives none with the reason, written in the IBIS slot", async () => {
  const m = fakeMarket({ quotes: [msftQuote()] });
  const out = await resolve(MSFT, m, fakeStore({ candidates: [] }));
  assertEquals(out.summary.result, "none");
  assertEquals(out.rows.length, 1);
  const row = out.rows[0] as EurEquivalentRow;
  assertEquals([row.ibkr_exchange_id, row.status, row.ibkr_conid], ["IBIS", "none", null]);
  assertEquals((row.verification as { reason: string }).reason, "no_catalogue_candidate");
  assertEquals(m.calls.quote.length, 0, "no candidate means no Yahoo traffic at all");
  assertEquals(m.calls.search.length, 0);
});

Deno.test("an ISIN that Yahoo ties to another primary listing rejects the candidate", async () => {
  const m = fakeMarket({
    search: { US5949181045: "MSFT.MX" },
    quotes: [msftQuote(), quote("MSF.DE")],
  });
  const out = await resolve(MSFT, m, fakeStore({ candidates: [MSF] }));
  assertEquals(out.summary.result, "none");
  assertEquals(out.summary.rejected, 1);
});

Deno.test("search without a hit or without Yahoo line leaves the candidate unverified (missing data), not rejected", async () => {
  const noHit = await resolve(
    MSFT,
    fakeMarket({ search: {}, quotes: [msftQuote(), quote("MSF.DE")] }),
    fakeStore({ candidates: [MSF] }),
  );
  assertEquals(noHit.summary.result, "unverified");
  assertEquals(verificationOf<{ failed: string[] }>(noHit.rows[0]).failed, ["isin_confirmed"]);
  const noLine = await resolve(
    MSFT,
    fakeMarket({ search: { US5949181045: "MSFT" }, quotes: [msftQuote()] }),
    fakeStore({ candidates: [MSF] }),
  );
  assertEquals(noLine.summary.result, "unverified");
  assertEquals(noLine.rows[0]?.eur_symbol_yahoo, null);
  const failed = verificationOf<{ failed: string[] }>(noLine.rows[0]).failed;
  assert(
    ["currency_eur", "quote_type_equity", "name_match", "price_within_tolerance"].every((n) =>
      failed.includes(n),
    ),
  );
});

Deno.test("shares outstanding: different counts reject; missing counts pass unless require_shares is on", async () => {
  const different = await resolve(
    MSFT,
    fakeMarket({
      search: { US5949181045: "MSFT" },
      quotes: [msftQuote(), quote("MSF.DE", { sharesOutstanding: SHARES + 1 })],
    }),
    fakeStore({ candidates: [MSF] }),
  );
  assertEquals(different.summary.result, "none");
  const missing = (): ReturnType<typeof fakeMarket> =>
    fakeMarket({
      search: { US5949181045: "MSFT" },
      quotes: [msftQuote(), quote("MSF.DE", { sharesOutstanding: null })],
    });
  const lenient = await resolve(MSFT, missing(), fakeStore({ candidates: [MSF] }));
  assertEquals(lenient.summary.result, "verified");
  assertEquals(
    verificationOf<{ checks: Record<string, string> }>(lenient.rows[0]).checks[
      "shares_outstanding"
    ],
    "not_available",
  );
  const strict = await resolve(MSFT, missing(), fakeStore({ candidates: [MSF] }), true);
  assertEquals(strict.summary.result, "unverified");
  assertEquals(verificationOf<{ failed: string[] }>(strict.rows[0]).failed, ["shares_outstanding"]);
});

Deno.test("a non-EUR Yahoo line is rejected", async () => {
  const out = await resolve(
    MSFT,
    fakeMarket({
      search: { US5949181045: "MSFT" },
      quotes: [msftQuote(), quote("MSF.DE", { currency: "MXN" })],
    }),
    fakeStore({ candidates: [MSF] }),
  );
  assertEquals(out.summary.result, "none");
});

Deno.test("Unilever: the probe uses the IBKR localSymbol UNA (not the symbol UNVB) and the GBp price is converted", async () => {
  const ulvr = msftQuote({
    symbol: "ULVR.L",
    currency: "GBp",
    longName: "Unilever PLC",
    sharesOutstanding: 2_480_000_000,
    regularMarketPrice: 4500,
  });
  const una = quote("UNA.AS", {
    longName: "Unilever PLC",
    sharesOutstanding: 2_480_000_000,
    regularMarketPrice: 52.17,
    exchange: "AMS",
  });
  const m = fakeMarket({ search: { GB00BVZK7T90: "ULVR.L" }, quotes: [ulvr, una] });
  const out = await resolve(UNILEVER, m, fakeStore({ candidates: [UNA] }));
  assertEquals(m.calls.quote[0], ["ULVR.L", "UNA.AS"]);
  assert(!m.calls.quote[0]?.some((s) => s.startsWith("UNVB")));
  assertEquals(out.summary.result, "verified");
  const row = out.rows[0] as EurEquivalentRow;
  assertEquals(
    [row.ibkr_exchange_id, row.ibkr_local_symbol, row.eur_symbol_yahoo],
    ["AEB", "UNA", "UNA.AS"],
  );
});

Deno.test("both exchanges: each gets its own row, IBIS first; an unverified AEB row does not hide a verified IBIS row", async () => {
  const aeb: CatalogueCandidate = {
    exchange_id: "AEB",
    conid: 5,
    symbol: "MSF",
    local_symbol: "MSF",
    isin: "US5949181045",
    description: "MICROSOFT CORP",
  };
  const m = fakeMarket({
    search: { US5949181045: "MSFT" },
    quotes: [msftQuote(), quote("MSF.DE"), quote("MSF.AS", { regularMarketPrice: 400 })],
  });
  const out = await resolve(MSFT, m, fakeStore({ candidates: [aeb, MSF] }));
  assertEquals(
    out.rows.map((r) => [r.ibkr_exchange_id, r.status]),
    [
      ["IBIS", "verified"],
      ["AEB", "unverified"],
    ],
  );
  assertEquals(m.calls.search, ["US5949181045"], "one search per distinct ISIN");
});

Deno.test("an invalid local symbol cannot be verified (the prompt could not be built from it)", async () => {
  const lower: CatalogueCandidate = { ...MSF, local_symbol: "MSFd" };
  const m = fakeMarket({
    search: { US5949181045: "MSFT" },
    quotes: [msftQuote(), quote("MSFD.DE")],
  });
  const out = await resolve(MSFT, m, fakeStore({ candidates: [lower] }));
  assertEquals(out.summary.result, "unverified");
  assert(verificationOf<{ failed: string[] }>(out.rows[0]).failed.includes("local_symbol_format"));

  // a catalogue row whose "local symbol" is really a Yahoo ticker (MSF.DE) is never verified either
  const yahooLike: CatalogueCandidate = { ...MSF, local_symbol: "MSF.DE" };
  const m2 = fakeMarket({
    search: { US5949181045: "MSFT" },
    quotes: [msftQuote(), quote("MSF.DE.DE")],
  });
  const out2 = await resolve(MSFT, m2, fakeStore({ candidates: [yahooLike] }));
  assertEquals(out2.summary.result, "unverified");
  assert(verificationOf<{ failed: string[] }>(out2.rows[0]).failed.includes("local_symbol_format"));
});

Deno.test("an override row wins: force writes a manual verified row without any Yahoo traffic for that exchange", async () => {
  const force: OverrideRow = {
    id: "ovr-1",
    ibkr_exchange_id: "IBIS",
    action: "force",
    ibkr_conid: 12178239,
    ibkr_local_symbol: "MSF",
    eur_symbol_yahoo: "MSF.DE",
    isin: "US5949181045",
    reason: "checked on the IBKR ticket 2026-10-15",
  };
  const m = fakeMarket({ quotes: [msftQuote()] });
  const out = await resolve(MSFT, m, fakeStore({ candidates: [MSF], overrides: [force] }));
  assertEquals(out.rows.length, 1);
  const row = out.rows[0] as EurEquivalentRow;
  assertEquals(
    [row.status, row.ibkr_local_symbol, row.eur_symbol_yahoo],
    ["verified", "MSF", "MSF.DE"],
  );
  assertEquals(
    (row.verification as { method: string; override_id: string }).method,
    "manual_override",
  );
  assertEquals(m.calls.quote.length + m.calls.search.length, 0);
});

Deno.test("an override block removes the exchange; blocking the only candidate yields none (blocked_by_override)", async () => {
  const block: OverrideRow = {
    id: "ovr-2",
    ibkr_exchange_id: "IBIS",
    action: "block",
    ibkr_conid: null,
    ibkr_local_symbol: null,
    eur_symbol_yahoo: null,
    isin: null,
    reason: "wrong instrument on the ticket",
  };
  const m = fakeMarket({
    search: { US5949181045: "MSFT" },
    quotes: [msftQuote(), quote("MSF.DE")],
  });
  const out = await resolve(MSFT, m, fakeStore({ candidates: [MSF], overrides: [block] }));
  assertEquals(out.summary.result, "none");
  assertEquals(verificationOf<{ reason: string }>(out.rows[0]).reason, "blocked_by_override");
});

Deno.test("a failing Yahoo quote leaves the candidate unverified; an open breaker propagates so the job is deferred", async () => {
  const soft = await resolve(
    MSFT,
    fakeMarket({ search: { US5949181045: "MSFT" }, failQuote: new Error("boom") }),
    fakeStore({ candidates: [MSF] }),
  );
  assertEquals(soft.summary.result, "unverified");
  const breaker = Object.assign(new Error("open"), { name: "YahooUnavailableError" });
  await assertRejects(
    () => resolve(MSFT, fakeMarket({ failSearch: breaker }), fakeStore({ candidates: [MSF] })),
    Error,
    "open",
  );
  await assertRejects(
    () =>
      resolve(
        MSFT,
        fakeMarket({ search: { US5949181045: "MSFT" }, failQuote: breaker }),
        fakeStore({ candidates: [MSF] }),
      ),
    Error,
    "open",
  );
});

Deno.test("assessCandidate never reports verified when the ISIN could not be confirmed", () => {
  const a = assessCandidate({
    security: MSFT,
    securityQuote: msftQuote(),
    candidate: MSF,
    match: { basis: "description", similarity: 1 },
    knownIsins: [],
    isinSearch: "unavailable",
    probe: quote("MSF.DE"),
    fx: { eurUsd: 1.1213, ccyUsd: 1, rateDate: "2026-10-14" },
    requireShares: false,
    nowMs: NOW,
  });
  assertEquals(a.outcome, "unverified");
  assertEquals(a.verification.checks.isin_confirmed, "not_available");
});

// ------------------------------------------------------------------------------------------------ handlers

const resolveCtx = (key: string) => ({
  job: { key },
  run: { scanDateLocal: "2026-10-15", startedAtMs: NOW },
  signal: new AbortController().signal,
  events: [] as { event: string; data?: Record<string, unknown> }[],
});
function ctxWithLog(key: string) {
  const c = resolveCtx(key);
  return {
    ...c,
    log: (event: string, data?: Record<string, unknown>) => {
      c.events.push(data === undefined ? { event } : { event, data });
      return Promise.resolve();
    },
  };
}

Deno.test("runEurResolve: replaces the rows, stores the confirmed ISIN, logs one event without any user data", async () => {
  const m = fakeMarket({
    search: { US5949181045: "MSFT" },
    quotes: [msftQuote(), quote("MSF.DE")],
  });
  const s = fakeStore({ candidates: [MSF] });
  const ctx = ctxWithLog("eur:sec-msft");
  const result = await runEurResolve(ctx, { store: s.store, market: m.market });
  assertEquals(result["status"], "resolved");
  assertEquals(s.log.replaced.length, 1);
  assertEquals(s.log.replaced[0]?.id, "sec-msft");
  assertEquals(s.log.isins, [["sec-msft", "US5949181045"]]);
  assertEquals(
    ctx.events.map((e) => e.event),
    ["eur_resolved"],
  );
  assertEquals(ctx.events[0]?.data?.["exchanges"], ["IBIS:verified"]);
});

Deno.test("runEurResolve: unknown key, missing security and require_shares from settings", async () => {
  const noop = await runEurResolve(ctxWithLog("other:1"), {
    store: fakeStore().store,
    market: fakeMarket({}).market,
  });
  assertEquals(noop, { status: "noop" });
  const gone = await runEurResolve(ctxWithLog("eur:zzz"), {
    store: fakeStore({ security: null }).store,
    market: fakeMarket({}).market,
  });
  assertEquals(gone, { status: "skipped", reason: "security_not_found" });
  const strict = fakeStore({
    candidates: [MSF],
    settings: { eur_catalogue: { require_shares: true } },
  });
  const r = await runEurResolve(ctxWithLog("eur:sec-msft"), {
    store: strict.store,
    market: fakeMarket({
      search: { US5949181045: "MSFT" },
      quotes: [msftQuote(), quote("MSF.DE", { sharesOutstanding: null })],
    }).market,
  });
  assertEquals(r["result"], "unverified");
});

Deno.test("seedEurResolve: one job per target, capped by max_resolve_per_run; an empty plan when nothing is due", async () => {
  const none = await seedEurResolve({ run: { id: "run-1" } as never }, fakeStore().store);
  assertEquals(none, { keys: [] });
  const some = await seedEurResolve(
    { run: { id: "run-1" } as never },
    fakeStore({ targets: ["a", "b"] }).store,
  );
  assertEquals(some.keys, ["eur:a", "eur:b"]);
  assertEquals(some.payloads, [{ securityId: "a" }, { securityId: "b" }]);
});

// ---- catalogue import

const fixture = async (name: string): Promise<{ products: unknown[] }> =>
  JSON.parse(
    await Deno.readTextFile(new URL(`../../_shared/adapters/fixtures/${name}`, import.meta.url)),
  );

async function catalogueHarness(
  over: { settings?: Record<string, unknown>; fetchImpl?: (n: number) => Response } = {},
) {
  const ibis = await fixture("ibkr-catalogue-ibis-page1.json");
  const aeb = await fixture("ibkr-catalogue-aeb-page1.json");
  const fixtureFetch = createFixtureCatalogueFetch({ IBIS: [ibis.products], AEB: [aeb.products] });
  const clock = createFakeClock();
  let requests = 0;
  const fetchImpl = (url: string, init?: RequestInit) => {
    requests += 1;
    return over.fetchImpl ? Promise.resolve(over.fetchImpl(requests)) : fixtureFetch(url, init);
  };
  const s = fakeStore({ settings: over.settings ?? {} });
  const events: { event: string; level?: string }[] = [];
  const ctx = (day: string) => ({
    run: { scanDateLocal: day },
    signal: new AbortController().signal,
    log: (event: string, _d?: Record<string, unknown>, extra?: { level?: string }) => {
      events.push(extra?.level === undefined ? { event } : { event, level: extra.level });
      return Promise.resolve();
    },
  });
  return {
    s,
    clock,
    ctx,
    events,
    requests: () => requests,
    deps: { store: s.store, fetchImpl, clock },
  };
}

Deno.test("catalogue import: both exchanges are read and written, the week is recorded, one info event", async () => {
  const h = await catalogueHarness();
  const r = await runEurCatalogue(h.ctx("2026-10-15"), h.deps);
  assertEquals(r["status"], "imported");
  assertEquals(
    h.s.log.upserts
      .flat()
      .map((x) => `${x.exchange_id}:${x.local_symbol}`)
      .sort(),
    ["AEB:ADYEN", "AEB:ASML", "AEB:UNA", "IBIS:APC", "IBIS:MSF", "IBIS:SAP"],
  );
  assertEquals(h.requests(), 2);
  const state = parseCatalogueState(h.s.settings.get("eur_catalogue_state"));
  assertEquals(
    [state.last_success_week, state.last_result, state.last_attempt_day],
    ["2026-W42", "complete", "2026-10-15"],
  );
  assertEquals(
    h.events.map((e) => e.event),
    ["eur_catalogue_imported"],
  );
  assertEquals(seedEurCatalogue({ run: { scanDateLocal: "2026-10-15" } }).keys, [
    "eur_catalogue:2026-W42",
  ]);
});

Deno.test("catalogue import: a second run in the same ISO week does nothing and makes no request", async () => {
  const h = await catalogueHarness();
  await runEurCatalogue(h.ctx("2026-10-15"), h.deps);
  const before = h.requests();
  const again = await runEurCatalogue(h.ctx("2026-10-17"), h.deps);
  assertEquals(again, {
    status: "skipped",
    reason: "already_imported_this_week",
    week: "2026-W42",
  });
  assertEquals(h.requests(), before);
  const nextWeek = await runEurCatalogue(h.ctx("2026-10-19"), h.deps);
  assertEquals(nextWeek["status"], "imported");
});

Deno.test("catalogue import: app_settings.eur_catalogue.enabled = false switches it off", async () => {
  const h = await catalogueHarness({ settings: { eur_catalogue: { enabled: false } } });
  const r = await runEurCatalogue(h.ctx("2026-10-15"), h.deps);
  assertEquals(r, { status: "skipped", reason: "disabled" });
  assertEquals(h.requests(), 0);
});

Deno.test("catalogue import: a failing endpoint is abandoned for the day, never retried that day, and tried again the next day", async () => {
  const h = await catalogueHarness({ fetchImpl: () => new Response("boom", { status: 500 }) });
  const first = await runEurCatalogue(h.ctx("2026-10-15"), h.deps);
  assertEquals(first["status"], "aborted");
  assertEquals(h.requests(), 4, "one request plus three retries, then stop");
  assertEquals(h.s.log.upserts.length, 0);
  assertEquals(
    (first["abort"] as { exchange: string; reason: string; status: number }).reason,
    "http_error",
  );
  assertEquals(
    h.events.map((e) => [e.event, e.level]),
    [["eur_catalogue_aborted", "warn"]],
  );

  const sameDay = await runEurCatalogue(h.ctx("2026-10-15"), h.deps);
  assertEquals(sameDay["reason"], "already_attempted_today");
  assertEquals(h.requests(), 4, "the same day makes no further request");

  const nextDay = await runEurCatalogue(h.ctx("2026-10-16"), h.deps);
  assertEquals(nextDay["status"], "aborted");
  assertEquals(h.requests(), 8, "the next day gets one more bounded attempt");
});

Deno.test("catalogue import: if AEB fails after IBIS succeeded, IBIS rows are kept, AEB is untouched, the import is not marked successful", async () => {
  const ibis = await fixture("ibkr-catalogue-ibis-page1.json");
  const h = await catalogueHarness({
    fetchImpl: (n) =>
      n === 1
        ? new Response(JSON.stringify({ products: ibis.products, productCount: 5 }), {
            status: 200,
          })
        : new Response("x", { status: 503 }),
  });
  const r = await runEurCatalogue(h.ctx("2026-10-15"), h.deps);
  assertEquals(r["status"], "aborted");
  assertEquals(
    h.s.log.upserts.flat().map((x) => x.exchange_id),
    ["IBIS", "IBIS", "IBIS"],
  );
  const state = parseCatalogueState(h.s.settings.get("eur_catalogue_state"));
  assertEquals([state.last_success_week, state.last_result], [null, "aborted"]);
});

Deno.test("catalogue import: a database error is recorded as data, not thrown (the scan must not degrade)", async () => {
  const h = await catalogueHarness();
  h.s.store.upsertCatalogue = () => Promise.reject(new Error("db down"));
  const r = await runEurCatalogue(h.ctx("2026-10-15"), h.deps);
  assertEquals(r["status"], "error");
  assertEquals(parseCatalogueState(h.s.settings.get("eur_catalogue_state")).last_result, "error");
});

Deno.test("catalogue import: an aborted job signal is rethrown", async () => {
  const h = await catalogueHarness();
  const ctl = new AbortController();
  ctl.abort();
  await assertRejects(() =>
    runEurCatalogue({ ...h.ctx("2026-10-15"), signal: ctl.signal }, h.deps),
  );
});
```

- [ ] **Step 3: Run; Expected: FAIL**

```powershell
deno test -A --config supabase/functions/deno.json supabase/functions/worker-tick/handlers/eur.test.ts
```
Expected: FAIL with `Module not found ".../eur_catalogue.ts"`.

- [ ] **Step 4: Implement the pure rules**

`supabase/functions/worker-tick/handlers/eur_match.ts`:

```ts
import type { QuoteRecord } from "../../_shared/adapters/providers.ts";
import { type EurExchange, isValidLocalSymbol } from "../../_shared/core/handoff.ts";
import { normalizeName } from "../../_shared/core/identity.ts";

/**
 * Pure matching and verification rules of spec 5.7. The EUR line is a display and hand-off convenience: nothing here ever feeds screening.
 * A candidate is `verified` only when every required check passes (A-28); a hard mismatch (different company, not an equity, not EUR,
 * different share count) rejects the candidate outright; missing data or a price outside the tolerance leaves it `unverified`.
 */

export const NAME_SIMILARITY_MIN = 0.9;
export const PRICE_TOLERANCE = 0.01; // A-28: price x FX within 1%
export const PROBE_SUFFIX: Readonly<Record<EurExchange, string>> = { IBIS: ".DE", AEB: ".AS" };

export type CheckName =
  | "isin_confirmed"
  | "currency_eur"
  | "quote_type_equity"
  | "name_match"
  | "shares_outstanding"
  | "price_within_tolerance"
  | "local_symbol_format";
export type CheckResult = "pass" | "fail" | "not_available";
export type CandidateBasis = "isin" | "description" | "symbol";

/** Hard failures reject the candidate: the Yahoo line is positively a different instrument. */
const HARD: ReadonlySet<CheckName> = new Set([
  "isin_confirmed",
  "currency_eur",
  "quote_type_equity",
  "name_match",
  "shares_outstanding",
]);
const ALWAYS_REQUIRED: readonly CheckName[] = [
  "isin_confirmed",
  "currency_eur",
  "quote_type_equity",
  "name_match",
  "price_within_tolerance",
  "local_symbol_format",
];

export interface CatalogueCandidate {
  exchange_id: EurExchange;
  conid: number;
  symbol: string;
  local_symbol: string;
  isin: string | null;
  description: string | null;
}

export interface CanonicalSecurity {
  id: string;
  yahooSymbol: string;
  currency: string; // as Yahoo quotes it, may be a minor unit (GBp)
  currencyMajor: string;
  minorDivisor: number;
  longName: string | null;
  companyName: string;
  sharesOutstanding: number | null;
  isin: string | null;
}

export interface FxPair {
  eurUsd: number | null;
  ccyUsd: number | null; // usdPerUnit of the canonical security's major currency
  rateDate: string | null;
}

export interface Verification {
  method: "automatic" | "manual_override";
  checked_at: string;
  basis: CandidateBasis | null;
  similarity: number | null;
  probe_symbol: string | null;
  checks: Record<CheckName, CheckResult>;
  failed: string[];
  hard_failed: string[];
  price_deviation_pct: number | null;
  fx: { ccy: string; rate_date: string | null; eur_usd: number | null; ccy_usd: number | null };
  notes: string[];
}

export interface Assessment {
  outcome: "verified" | "unverified" | "rejected";
  verification: Verification;
}

// ---------------------------------------------------------------------------------------------- small pure helpers

/** `MSFT` -> `MSFT`, `SAP.DE` -> `SAP`, `BRK-B` -> `BRK-B`. */
export function baseTicker(yahooSymbol: string): string {
  return (yahooSymbol.split(".")[0] ?? yahooSymbol).toUpperCase();
}

export function probeSymbol(exchange: EurExchange, localSymbol: string): string {
  return `${localSymbol.toUpperCase()}${PROBE_SUFFIX[exchange]}`;
}

function levenshtein(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = prev[0] as number;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const above = prev[j] as number;
      prev[j] = Math.min(
        above + 1,
        (prev[j - 1] as number) + 1,
        diagonal + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      diagonal = above;
    }
  }
  return prev[b.length] as number;
}

/** 1 - edit distance / longer length, on `normalizeName` output. Two empty names are not similar. */
export function nameSimilarity(a: string, b: string): number {
  const x = normalizeName(a);
  const y = normalizeName(b);
  if (x === "" || y === "") return 0;
  return 1 - levenshtein(x, y) / Math.max(x.length, y.length);
}

/** Relative gap of the EUR line's implied price to the canonical price, both in major units: (implied - canonical) / canonical. */
export function priceDeviation(input: {
  eurPrice: number | null;
  canonicalPrice: number | null;
  canonicalMinorDivisor: number;
  canonicalMajor: string;
  fx: FxPair;
}): number | null {
  const { eurPrice, canonicalPrice, fx } = input;
  if (eurPrice === null || canonicalPrice === null || !(eurPrice > 0) || !(canonicalPrice > 0))
    return null;
  const canonicalMajorPrice = canonicalPrice / input.canonicalMinorDivisor;
  let implied: number;
  if (input.canonicalMajor === "EUR") {
    implied = eurPrice;
  } else {
    if (fx.eurUsd === null || fx.ccyUsd === null || !(fx.eurUsd > 0) || !(fx.ccyUsd > 0))
      return null;
    implied = (eurPrice * fx.eurUsd) / fx.ccyUsd;
  }
  return (implied - canonicalMajorPrice) / canonicalMajorPrice;
}

/** "2026-10-15" -> "2026-W42" (ISO 8601 week; the week-numbering year can differ from the calendar year around New Year). */
export function isoWeek(date: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (m === null) throw new RangeError(`isoWeek: expected YYYY-MM-DD, got ${date}`);
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  const dayOfWeek = d.getUTCDay() === 0 ? 7 : d.getUTCDay(); // Monday = 1 ... Sunday = 7
  d.setUTCDate(d.getUTCDate() + 4 - dayOfWeek); // the Thursday of this ISO week decides the year
  const jan1 = Date.UTC(d.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((d.getTime() - jan1) / 86_400_000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------------------------- candidate selection

export interface BasisMatch {
  basis: CandidateBasis;
  similarity: number | null;
}

/** Why a catalogue row is a candidate for `security` (spec 5.7 step 1), or null. ISIN beats description beats ticker. */
export function matchBasis(
  security: CanonicalSecurity,
  knownIsins: readonly string[],
  c: CatalogueCandidate,
): BasisMatch | null {
  const similarity =
    c.description === null
      ? null
      : nameSimilarity(c.description, security.longName ?? security.companyName);
  if (c.isin !== null && knownIsins.includes(c.isin)) return { basis: "isin", similarity };
  if (similarity !== null && similarity >= NAME_SIMILARITY_MIN)
    return { basis: "description", similarity };
  if (c.symbol.toUpperCase() === baseTicker(security.yahooSymbol))
    return { basis: "symbol", similarity };
  return null;
}

const BASIS_RANK: Record<CandidateBasis, number> = { isin: 0, description: 1, symbol: 2 };
const EXCHANGE_RANK: Record<EurExchange, number> = { IBIS: 0, AEB: 1 };

export interface RankedCandidate {
  candidate: CatalogueCandidate;
  match: BasisMatch;
}

/** Stable order: IBIS before AEB, then basis strength, then higher similarity, then lower conid; at most `perExchange` per exchange. */
export function rankCandidates(
  items: readonly RankedCandidate[],
  perExchange: number,
): RankedCandidate[] {
  const sorted = [...items].sort(
    (a, b) =>
      EXCHANGE_RANK[a.candidate.exchange_id] - EXCHANGE_RANK[b.candidate.exchange_id] ||
      BASIS_RANK[a.match.basis] - BASIS_RANK[b.match.basis] ||
      (b.match.similarity ?? 0) - (a.match.similarity ?? 0) ||
      a.candidate.conid - b.candidate.conid,
  );
  const taken: Record<EurExchange, number> = { IBIS: 0, AEB: 0 };
  return sorted.filter((i) => taken[i.candidate.exchange_id]++ < perExchange);
}

// ---------------------------------------------------------------------------------------------- assessment

export interface AssessInput {
  security: CanonicalSecurity;
  securityQuote: QuoteRecord | null; // the canonical line, quoted in the same call as the probe
  candidate: CatalogueCandidate;
  match: BasisMatch;
  knownIsins: readonly string[];
  /** Result of Yahoo `search(candidate.isin)`: the primary symbol, null when no hit, "unavailable" when the call failed or there is no ISIN. */
  isinSearch: { primarySymbol: string | null } | "unavailable";
  probe: QuoteRecord | null;
  fx: FxPair;
  requireShares: boolean;
  nowMs: number;
}

const sameName = (a: string, b: string): boolean =>
  normalizeName(a) === normalizeName(b) && normalizeName(a) !== "";

export function assessCandidate(i: AssessInput): Assessment {
  const { security, candidate, probe } = i;
  const notes: string[] = [];
  const checks = {} as Record<CheckName, CheckResult>;

  // 1. ISIN confirmation: Yahoo's search(ISIN) returns the primary listing only (spike 3.5); it must be the canonical symbol.
  if (
    candidate.isin === null ||
    i.isinSearch === "unavailable" ||
    i.isinSearch.primarySymbol === null
  ) {
    checks.isin_confirmed = "not_available";
    notes.push(candidate.isin === null ? "candidate_without_isin" : "isin_search_unavailable");
  } else if (i.isinSearch.primarySymbol.toUpperCase() !== security.yahooSymbol.toUpperCase()) {
    checks.isin_confirmed = "fail";
    notes.push(`isin_primary_is_${i.isinSearch.primarySymbol}`);
  } else if (i.knownIsins.length > 0 && !i.knownIsins.includes(candidate.isin)) {
    checks.isin_confirmed = "fail";
    notes.push("isin_differs_from_known_isin");
  } else {
    checks.isin_confirmed = "pass";
  }

  // 2. The Yahoo line of the EUR listing.
  checks.currency_eur =
    probe === null ? "not_available" : probe.currency === "EUR" ? "pass" : "fail";
  checks.quote_type_equity =
    probe === null ? "not_available" : probe.quoteType === "EQUITY" ? "pass" : "fail";
  if (probe === null) notes.push("no_yahoo_line");

  const canonicalName = i.securityQuote?.longName ?? security.longName ?? security.companyName;
  checks.name_match =
    probe === null || probe.longName === null || canonicalName === ""
      ? "not_available"
      : sameName(probe.longName, canonicalName)
        ? "pass"
        : "fail";

  const canonicalShares = i.securityQuote?.sharesOutstanding ?? security.sharesOutstanding;
  checks.shares_outstanding =
    probe === null || probe.sharesOutstanding === null || canonicalShares === null
      ? "not_available"
      : probe.sharesOutstanding === canonicalShares
        ? "pass"
        : "fail";

  const deviation = priceDeviation({
    eurPrice: probe?.regularMarketPrice ?? null,
    canonicalPrice: i.securityQuote?.regularMarketPrice ?? null,
    canonicalMinorDivisor: security.minorDivisor,
    canonicalMajor: security.currencyMajor,
    fx: i.fx,
  });
  checks.price_within_tolerance =
    deviation === null ? "not_available" : Math.abs(deviation) <= PRICE_TOLERANCE ? "pass" : "fail";
  checks.local_symbol_format = isValidLocalSymbol(candidate.local_symbol) ? "pass" : "fail";

  const required = new Set<CheckName>(ALWAYS_REQUIRED);
  if (i.requireShares) required.add("shares_outstanding");
  const names = Object.keys(checks) as CheckName[];
  const hardFailed = names.filter((n) => checks[n] === "fail" && HARD.has(n));
  const failed = names.filter(
    (n) => checks[n] === "fail" || (checks[n] === "not_available" && required.has(n)),
  );

  return {
    outcome: hardFailed.length > 0 ? "rejected" : failed.length === 0 ? "verified" : "unverified",
    verification: {
      method: "automatic",
      checked_at: new Date(i.nowMs).toISOString(),
      basis: i.match.basis,
      similarity: i.match.similarity === null ? null : Math.round(i.match.similarity * 1000) / 1000,
      probe_symbol: probe?.symbol ?? probeSymbol(candidate.exchange_id, candidate.local_symbol),
      checks,
      failed,
      hard_failed: hardFailed,
      price_deviation_pct: deviation === null ? null : Math.round(deviation * 100_000) / 1000,
      fx: {
        ccy: security.currencyMajor,
        rate_date: i.fx.rateDate,
        eur_usd: i.fx.eurUsd,
        ccy_usd: i.fx.ccyUsd,
      },
      notes,
    },
  };
}
```

- [ ] **Step 5: Implement the resolver, handler and seeder**

`supabase/functions/worker-tick/handlers/eur_resolve.ts`:

```ts
import type { CatalogueRow } from "../../_shared/adapters/ibkr-catalogue.ts";
import type { MarketDataProvider, QuoteRecord } from "../../_shared/adapters/providers.ts";
import type { EurExchange, EurStatus } from "../../_shared/core/handoff.ts";
import { normalizeName } from "../../_shared/core/identity.ts";
import type { HandlerContext, SeedContext, SeedPlan } from "../types.ts";
import {
  type Assessment,
  assessCandidate,
  baseTicker,
  type CanonicalSecurity,
  type CatalogueCandidate,
  type FxPair,
  matchBasis,
  probeSymbol,
  type RankedCandidate,
  rankCandidates,
} from "./eur_match.ts";

/**
 * Stage `eur_resolve` (spec 5.7, 7.4 stage 9). Job key `eur:<security_id>`; with nothing to resolve the seeder returns no keys and
 * `app.seed_stage` leaves its `_empty` done marker (P1), so the pipeline moves on. The result is a display and hand-off convenience:
 * nothing here is read by eligibility, ranking, thresholds or any other screening calculation.
 *
 * Soft failure by design: a missing or doubtful EUR line is data (`unverified`, `none`), never a job failure, so the scan status is not
 * degraded by this convenience. Only an open Yahoo breaker or an exhausted request budget propagate (the loop defers those without consuming an attempt).
 */

export interface FxRate {
  usdPerUnit: number;
  rateDate: string;
}

export interface OverrideRow {
  id: string;
  ibkr_exchange_id: EurExchange;
  action: "force" | "block";
  ibkr_conid: number | null;
  ibkr_local_symbol: string | null;
  eur_symbol_yahoo: string | null;
  isin: string | null;
  reason: string;
}

/** A row of public.eur_equivalents as written by `app.replace_eur_equivalents`. */
export interface EurEquivalentRow {
  ibkr_exchange_id: EurExchange;
  ibkr_conid: number | null;
  ibkr_local_symbol: string | null;
  isin: string | null;
  eur_symbol_yahoo: string | null;
  status: EurStatus;
  verification: Record<string, unknown>;
  verified_at: string | null;
}

export interface SettingsPort {
  getSetting(name: string): Promise<unknown | null>;
  setSetting(name: string, value: unknown): Promise<void>;
}

export interface ResolveStore extends SettingsPort {
  loadSecurity(securityId: string): Promise<CanonicalSecurity | null>;
  /** ISINs of broker positions held in any listing of the security's company (Flex, spec 12.7). Empty before P5 data exists. */
  heldIsins(securityId: string): Promise<string[]>;
  activeOverrides(securityId: string): Promise<OverrideRow[]>;
  findCandidates(q: {
    isins: string[];
    baseTicker: string;
    namePrefix: string;
  }): Promise<CatalogueCandidate[]>;
  loadFx(currencies: string[], scanDate: string): Promise<Map<string, FxRate>>;
  replaceEquivalents(securityId: string, rows: EurEquivalentRow[]): Promise<void>;
  setSecurityIsin(securityId: string, isin: string): Promise<void>;
  resolveTargets(runId: string, limit: number): Promise<string[]>;
}

export interface CatalogueStore extends SettingsPort {
  upsertCatalogue(rows: CatalogueRow[]): Promise<void>;
}

export interface EurSettings {
  enabled: boolean;
  requireShares: boolean;
  maxResolvePerRun: number;
}

/** `app_settings.eur_catalogue`: `{ "enabled": true, "require_shares": false, "max_resolve_per_run": 40 }`. Anything invalid keeps the default. */
export function parseEurSettings(raw: unknown): EurSettings {
  const r =
    typeof raw === "object" && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const max = r["max_resolve_per_run"];
  return {
    enabled: r["enabled"] !== false,
    requireShares: r["require_shares"] === true,
    maxResolvePerRun:
      typeof max === "number" && Number.isInteger(max) && max >= 1 && max <= 200 ? max : 40,
  };
}

const isFatal = (e: unknown): boolean =>
  e instanceof Error &&
  (e.name === "YahooUnavailableError" ||
    e.name === "BudgetExceededError" ||
    e.name === "AbortError");

export interface ResolveDeps {
  store: Pick<ResolveStore, "heldIsins" | "activeOverrides" | "findCandidates" | "loadFx">;
  market: Pick<MarketDataProvider, "search" | "quote">;
  scanDate: string;
  nowMs: number;
  requireShares: boolean;
}

export interface ResolveOutcome {
  rows: EurEquivalentRow[];
  /** The ISIN to write to securities.isin when it is still unknown: only ever an ISIN that Yahoo confirmed for a verified candidate. */
  isin: string | null;
  summary: {
    result: EurStatus;
    candidates: number;
    verified: number;
    unverified: number;
    rejected: number;
    overrides: number;
  };
}

const firstToken = (name: string): string => normalizeName(name).split(" ")[0] ?? "";

function rowFromAssessment(
  a: Assessment,
  c: CatalogueCandidate,
  probe: QuoteRecord | null,
  nowMs: number,
): EurEquivalentRow {
  return {
    ibkr_exchange_id: c.exchange_id,
    ibkr_conid: c.conid,
    ibkr_local_symbol: c.local_symbol,
    isin: c.isin,
    eur_symbol_yahoo: probe === null ? null : probeSymbol(c.exchange_id, c.local_symbol),
    status: a.outcome === "verified" ? "verified" : "unverified",
    verification: a.verification as unknown as Record<string, unknown>,
    verified_at: a.outcome === "verified" ? new Date(nowMs).toISOString() : null,
  };
}

function noneRow(
  nowMs: number,
  reason: string,
  extra: Record<string, unknown> = {},
): EurEquivalentRow {
  return {
    ibkr_exchange_id: "IBIS", // the preferred slot carries the negative result (one row per security and exchange)
    ibkr_conid: null,
    ibkr_local_symbol: null,
    isin: null,
    eur_symbol_yahoo: null,
    status: "none",
    verification: {
      method: "automatic",
      checked_at: new Date(nowMs).toISOString(),
      reason,
      ...extra,
    },
    verified_at: null,
  };
}

function overrideRow(o: OverrideRow, nowMs: number): EurEquivalentRow {
  return {
    ibkr_exchange_id: o.ibkr_exchange_id,
    ibkr_conid: o.ibkr_conid,
    ibkr_local_symbol: o.ibkr_local_symbol,
    isin: o.isin,
    eur_symbol_yahoo: o.eur_symbol_yahoo,
    status: "verified", // the operator vouches for it; the row says so in its verification
    verification: {
      method: "manual_override",
      checked_at: new Date(nowMs).toISOString(),
      override_id: o.id,
      reason: o.reason,
    },
    verified_at: new Date(nowMs).toISOString(),
  };
}

/** Spec 5.7 steps 1-5 for one canonical security. Pure apart from the injected ports. */
export async function resolveEurEquivalent(
  security: CanonicalSecurity,
  deps: ResolveDeps,
): Promise<ResolveOutcome> {
  const { store, market, nowMs } = deps;
  const overrides = await store.activeOverrides(security.id);
  const held = await store.heldIsins(security.id);
  const knownIsins = [
    ...new Set([security.isin, ...held].filter((v): v is string => v !== null && v !== "")),
  ];

  // 1. candidates
  const found = await store.findCandidates({
    isins: knownIsins,
    baseTicker: baseTicker(security.yahooSymbol),
    namePrefix: firstToken(security.longName ?? security.companyName),
  });
  const matched: RankedCandidate[] = [];
  for (const candidate of found) {
    const match = matchBasis(security, knownIsins, candidate);
    if (match !== null) matched.push({ candidate, match });
  }
  const ranked = rankCandidates(matched, 3);

  const blocked = new Set(
    overrides.filter((o) => o.action === "block").map((o) => o.ibkr_exchange_id),
  );
  const forced = overrides.filter((o) => o.action === "force");
  const autoRanked = ranked.filter(
    (r) =>
      !blocked.has(r.candidate.exchange_id) &&
      !forced.some((f) => f.ibkr_exchange_id === r.candidate.exchange_id),
  );

  const assessed: { item: RankedCandidate; probe: QuoteRecord | null; assessment: Assessment }[] =
    [];
  if (autoRanked.length > 0) {
    // 2. ISIN confirmation: one search per distinct ISIN
    const isinResults = new Map<string, { primarySymbol: string | null } | "unavailable">();
    for (const { candidate } of autoRanked) {
      if (candidate.isin === null || isinResults.has(candidate.isin)) continue;
      try {
        const r = await market.search(candidate.isin, { quotesCount: 3, newsCount: 0 });
        isinResults.set(candidate.isin, { primarySymbol: r.hits[0]?.symbol ?? null });
      } catch (e) {
        if (isFatal(e)) throw e;
        isinResults.set(candidate.isin, "unavailable");
      }
    }
    // 3. one quote() call for the canonical line and every probe
    const symbols = [
      ...new Set([
        security.yahooSymbol,
        ...autoRanked.map((r) => probeSymbol(r.candidate.exchange_id, r.candidate.local_symbol)),
      ]),
    ];
    const quotes = new Map<string, QuoteRecord>();
    try {
      for (const q of await market.quote(symbols)) quotes.set(q.symbol.toUpperCase(), q);
    } catch (e) {
      if (isFatal(e)) throw e;
    }
    const rates = await store.loadFx(["EUR", security.currencyMajor], deps.scanDate);
    const eur = rates.get("EUR");
    const fx: FxPair = {
      eurUsd: eur?.usdPerUnit ?? null,
      ccyUsd:
        security.currencyMajor === "USD"
          ? 1
          : (rates.get(security.currencyMajor)?.usdPerUnit ?? null),
      rateDate: eur?.rateDate ?? null,
    };
    const securityQuote = quotes.get(security.yahooSymbol.toUpperCase()) ?? null;
    for (const item of autoRanked) {
      const probe =
        quotes.get(probeSymbol(item.candidate.exchange_id, item.candidate.local_symbol)) ?? null;
      const assessment = assessCandidate({
        security,
        securityQuote,
        candidate: item.candidate,
        match: item.match,
        knownIsins,
        isinSearch:
          item.candidate.isin === null
            ? "unavailable"
            : (isinResults.get(item.candidate.isin) ?? "unavailable"),
        probe,
        fx,
        requireShares: deps.requireShares,
        nowMs,
      });
      assessed.push({ item, probe, assessment });
    }
  }

  // 4-5. status per exchange: verified before unverified; a rejected candidate is not stored; IBIS is preferred by pickListing at read time
  const rows: EurEquivalentRow[] = [];
  let isinToStore: string | null = null;
  for (const exchange of ["IBIS", "AEB"] as const) {
    const force = forced.find((f) => f.ibkr_exchange_id === exchange);
    if (force !== undefined) {
      rows.push(overrideRow(force, nowMs));
      continue;
    }
    const usable = assessed.filter(
      (a) => a.item.candidate.exchange_id === exchange && a.assessment.outcome !== "rejected",
    );
    const best = usable.find((a) => a.assessment.outcome === "verified") ?? usable[0];
    if (best === undefined) continue;
    rows.push(rowFromAssessment(best.assessment, best.item.candidate, best.probe, nowMs));
    if (best.assessment.outcome === "verified" && security.isin === null && isinToStore === null)
      isinToStore = best.item.candidate.isin;
  }
  if (rows.length === 0) {
    const rejected = assessed.map((a) => ({
      exchange: a.item.candidate.exchange_id,
      local_symbol: a.item.candidate.local_symbol,
      conid: a.item.candidate.conid,
      hard_failed: a.assessment.verification.hard_failed,
    }));
    const reason =
      ranked.length === 0
        ? "no_catalogue_candidate"
        : assessed.length === 0
          ? "blocked_by_override"
          : "all_candidates_rejected";
    rows.push(noneRow(nowMs, reason, { candidates: ranked.length, rejected }));
  }

  const count = (o: Assessment["outcome"]): number =>
    assessed.filter((a) => a.assessment.outcome === o).length;
  const result: EurStatus = rows.some((r) => r.status === "verified")
    ? "verified"
    : rows.some((r) => r.status === "unverified")
      ? "unverified"
      : "none";
  return {
    rows,
    isin: isinToStore,
    summary: {
      result,
      candidates: ranked.length,
      verified: count("verified"),
      unverified: count("unverified"),
      rejected: count("rejected"),
      overrides: overrides.length,
    },
  };
}

// ---------------------------------------------------------------------------------------------- handler and seeder

export interface EurResolveCtx {
  job: Pick<HandlerContext["job"], "key">;
  run: Pick<HandlerContext["run"], "scanDateLocal" | "startedAtMs">;
  signal: AbortSignal;
  log: HandlerContext["log"];
}

export async function runEurResolve(
  ctx: EurResolveCtx,
  deps: { store: ResolveStore; market: Pick<MarketDataProvider, "search" | "quote"> },
): Promise<Record<string, unknown>> {
  if (!ctx.job.key.startsWith("eur:")) return { status: "noop" };
  const securityId = ctx.job.key.slice("eur:".length);
  const settings = parseEurSettings(await deps.store.getSetting("eur_catalogue"));
  const security = await deps.store.loadSecurity(securityId);
  if (security === null) {
    await ctx.log(
      "eur_resolve_skipped",
      { reason: "security_not_found" },
      { level: "warn", securityId },
    );
    return { status: "skipped", reason: "security_not_found" };
  }
  ctx.signal.throwIfAborted();
  const outcome = await resolveEurEquivalent(security, {
    store: deps.store,
    market: deps.market,
    scanDate: ctx.run.scanDateLocal,
    nowMs: ctx.run.startedAtMs,
    requireShares: settings.requireShares,
  });
  await deps.store.replaceEquivalents(securityId, outcome.rows);
  if (outcome.isin !== null) await deps.store.setSecurityIsin(securityId, outcome.isin);
  await ctx.log(
    "eur_resolved",
    { ...outcome.summary, exchanges: outcome.rows.map((r) => `${r.ibkr_exchange_id}:${r.status}`) },
    { securityId },
  );
  return { status: "resolved", ...outcome.summary };
}

/** One job per target, at most `max_resolve_per_run`; no targets gives an empty plan. */
export async function seedEurResolve(
  ctx: Pick<SeedContext, "run">,
  store: Pick<ResolveStore, "getSetting" | "resolveTargets">,
): Promise<SeedPlan> {
  const settings = parseEurSettings(await store.getSetting("eur_catalogue"));
  const ids = await store.resolveTargets(ctx.run.id, settings.maxResolvePerRun);
  if (ids.length === 0) return { keys: [] };
  return {
    keys: ids.map((id) => `eur:${id}`),
    payloads: ids.map((id) => ({ securityId: id })),
    priorities: ids.map(() => 150),
  };
}
```

- [ ] **Step 6: Implement the weekly import**

`supabase/functions/worker-tick/handlers/eur_catalogue.ts`:

```ts
import type { Clock } from "../../_shared/adapters/clock.ts";
import {
  type CatalogueFetch,
  type CatalogueRow,
  createImportBudget,
  type FetchExchangeResult,
  fetchExchangeProducts,
} from "../../_shared/adapters/ibkr-catalogue.ts";
import type { HandlerContext, SeedPlan } from "../types.ts";
import { isoWeek } from "./eur_match.ts";
import { type CatalogueStore, parseEurSettings } from "./eur_resolve.ts";

/**
 * Weekly import of IBKR's public IBIS and AEB product lists into `ibkr_catalogue` (spec 5.7, 7.4). Job key `eur_catalogue:<iso-week>`.
 *
 * Gentle by construction: one import per ISO week, one attempt per Sofia day, the attempt is recorded BEFORE the first request (a crash, a job
 * retry or a manual re-run the same day never repeats it), at most 35 pages and 50 requests, and any failure ends the import for the day.
 * Failure is data (`eur_catalogue_state`, a warning event), never a job failure: the scan must not degrade because a convenience list is late.
 * Permission to call the undocumented /webrest/* endpoints is UNVERIFIED (Q-10); `app_settings.eur_catalogue.enabled = false` switches the import off.
 */

export const EXCHANGES = ["IBIS", "AEB"] as const;
const UPSERT_CHUNK = 500;

export interface CatalogueState {
  last_success_week: string | null;
  last_success_at: string | null;
  last_attempt_day: string | null;
  last_result: "complete" | "aborted" | "error" | null;
  detail: Record<string, unknown> | null;
}

export function parseCatalogueState(raw: unknown): CatalogueState {
  const r =
    typeof raw === "object" && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
  const result = r["last_result"];
  return {
    last_success_week: str(r["last_success_week"]),
    last_success_at: str(r["last_success_at"]),
    last_attempt_day: str(r["last_attempt_day"]),
    last_result:
      result === "complete" || result === "aborted" || result === "error" ? result : null,
    detail:
      typeof r["detail"] === "object" && r["detail"] !== null
        ? (r["detail"] as Record<string, unknown>)
        : null,
  };
}

export interface EurCatalogueCtx {
  run: Pick<HandlerContext["run"], "scanDateLocal">;
  signal: AbortSignal;
  log: HandlerContext["log"];
}

export interface EurCatalogueDeps {
  store: CatalogueStore;
  fetchImpl: CatalogueFetch;
  clock: Pick<Clock, "now" | "sleep">;
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export async function runEurCatalogue(
  ctx: EurCatalogueCtx,
  deps: EurCatalogueDeps,
): Promise<Record<string, unknown>> {
  const { store, clock } = deps;
  const today = ctx.run.scanDateLocal;
  const week = isoWeek(today);

  if (!parseEurSettings(await store.getSetting("eur_catalogue")).enabled) {
    await ctx.log("eur_catalogue_skipped", { reason: "disabled", week });
    return { status: "skipped", reason: "disabled" };
  }
  const state = parseCatalogueState(await store.getSetting("eur_catalogue_state"));
  if (state.last_success_week === week)
    return { status: "skipped", reason: "already_imported_this_week", week };
  if (state.last_attempt_day === today) {
    await ctx.log(
      "eur_catalogue_skipped",
      { reason: "already_attempted_today", week },
      { level: "warn" },
    );
    return { status: "skipped", reason: "already_attempted_today", week };
  }

  await store.setSetting("eur_catalogue_state", {
    ...state,
    last_attempt_day: today,
    last_result: null,
    detail: null,
  });
  try {
    const budget = createImportBudget();
    const fetchedAt = new Date(clock.now()).toISOString();
    const results: FetchExchangeResult[] = [];
    for (const exchangeId of EXCHANGES) {
      ctx.signal.throwIfAborted();
      const result = await fetchExchangeProducts(exchangeId, {
        fetchImpl: deps.fetchImpl,
        clock,
        pause: (ms) => clock.sleep(ms),
        budget,
        signal: ctx.signal,
        fetchedAt,
      });
      results.push(result);
      if (result.aborted !== null) break;
    }
    // Only exchanges read to the end are written; an abandoned exchange keeps last week's rows untouched.
    const written: Record<string, number> = {};
    for (const r of results) {
      if (!r.complete) continue;
      for (const part of chunks<CatalogueRow>(r.rows, UPSERT_CHUNK))
        await store.upsertCatalogue(part);
      written[r.exchangeId] = r.rows.length;
    }
    const failed = results.find((r) => r.aborted !== null);
    const counts = {
      pages: budget.pages,
      requests: budget.requests,
      written,
      scanned: Object.fromEntries(results.map((r) => [r.exchangeId, r.scanned])),
    };
    if (failed === undefined && results.length === EXCHANGES.length) {
      await store.setSetting("eur_catalogue_state", {
        last_success_week: week,
        last_success_at: new Date(clock.now()).toISOString(),
        last_attempt_day: today,
        last_result: "complete",
        detail: counts,
      });
      await ctx.log("eur_catalogue_imported", { week, ...counts });
      return { status: "imported", week, ...counts };
    }
    const abort = { exchange: failed?.exchangeId ?? null, ...(failed?.aborted ?? {}) };
    await store.setSetting("eur_catalogue_state", {
      ...state,
      last_attempt_day: today,
      last_result: "aborted",
      detail: { ...counts, abort },
    });
    await ctx.log("eur_catalogue_aborted", { week, ...counts, abort }, { level: "warn" });
    return { status: "aborted", week, ...counts, abort };
  } catch (e) {
    if (ctx.signal.aborted) throw e;
    const errorClass = e instanceof Error ? e.name : "error";
    await store.setSetting("eur_catalogue_state", {
      ...state,
      last_attempt_day: today,
      last_result: "error",
      detail: { error: errorClass },
    });
    await ctx.log("eur_catalogue_failed", { week, error: errorClass }, { level: "warn" });
    return { status: "error", week, error: errorClass };
  }
}

/** Always exactly one job per run, so every run records its decision (imported, or skipped: disabled, already imported this week, already attempted today) in scan_jobs.result. */
export function seedEurCatalogue(ctx: { run: { scanDateLocal: string } }): SeedPlan {
  return {
    keys: [`eur_catalogue:${isoWeek(ctx.run.scanDateLocal)}`],
    payloads: [{}],
    priorities: [130],
  };
}
```

- [ ] **Step 7: Run; Expected: PASS**

```powershell
deno test -A --config supabase/functions/deno.json supabase/functions/worker-tick/handlers/eur.test.ts
```
Expected: all tests in the file pass (`ok | 34 passed | 0 failed`).

- [ ] **Step 8: Implement the store and the registrations**

`supabase/functions/worker-tick/handlers/eur_store.ts` (service-role access; the only file of the stage that touches PostgREST; exercised by the Task 6 integration test):

```ts
import type { SupabaseClient } from "@supabase/supabase-js";
import type { CatalogueRow } from "../../_shared/adapters/ibkr-catalogue.ts";
import type { EurExchange } from "../../_shared/core/handoff.ts";
import type { CanonicalSecurity, CatalogueCandidate } from "./eur_match.ts";
import type {
  CatalogueStore,
  EurEquivalentRow,
  FxRate,
  OverrideRow,
  ResolveStore,
} from "./eur_resolve.ts";

/** Service-role access for the EUR stages. Edge Functions only: it bypasses RLS and must never reach a browser or a log line. */

export class EurStoreError extends Error {
  constructor(
    readonly op: string,
    message: string,
  ) {
    super(`${op}: ${message}`);
    this.name = "EurStoreError";
  }
}

const CANDIDATE_COLUMNS = "exchange_id, conid, symbol, local_symbol, isin, description";
const LIMIT = 50;

function check<T>(op: string, res: { data: T; error: { message: string } | null }): T {
  if (res.error) throw new EurStoreError(op, res.error.message);
  return res.data;
}

/** Letters, digits and spaces only: the value goes into an ILIKE pattern. */
const likeSafe = (s: string): string => s.replace(/[^\p{L}\p{N} ]/gu, "").trim();

export function createEurStore(sb: SupabaseClient): ResolveStore & CatalogueStore {
  const app = () => sb.schema("app");

  return {
    async getSetting(name) {
      const data = check(
        "app_settings.select",
        await sb.from("app_settings").select("value").eq("key", name).maybeSingle(),
      );
      return (data as { value: unknown } | null)?.value ?? null;
    },

    async setSetting(name, value) {
      check(
        "app_settings.upsert",
        await sb
          .from("app_settings")
          .upsert({ key: name, value, is_public: false }, { onConflict: "key" }),
      );
    },

    async loadSecurity(securityId) {
      const data = check(
        "securities.select",
        await sb
          .from("securities")
          .select(
            "id, yahoo_symbol, currency, currency_major, minor_divisor, long_name, shares_outstanding, isin, companies(name)",
          )
          .eq("id", securityId)
          .maybeSingle(),
      ) as {
        id: string;
        yahoo_symbol: string;
        currency: string;
        currency_major: string;
        minor_divisor: number;
        long_name: string | null;
        shares_outstanding: number | null;
        isin: string | null;
        companies: { name: string } | { name: string }[] | null;
      } | null;
      if (data === null) return null;
      const company = Array.isArray(data.companies) ? data.companies[0] : data.companies;
      const security: CanonicalSecurity = {
        id: data.id,
        yahooSymbol: data.yahoo_symbol,
        currency: data.currency,
        currencyMajor: data.currency_major,
        minorDivisor: data.minor_divisor,
        longName: data.long_name,
        companyName: company?.name ?? data.long_name ?? data.yahoo_symbol,
        sharesOutstanding: data.shares_outstanding,
        isin: data.isin,
      };
      return security;
    },

    /** ISINs of positions held in any listing of the company (Flex, spec 12.7). The table arrives with P5; before that this is empty. */
    async heldIsins(securityId) {
      const own = check(
        "securities.company",
        await sb.from("securities").select("company_id").eq("id", securityId).maybeSingle(),
      ) as { company_id: string } | null;
      if (own === null) return [];
      const siblings = check(
        "securities.siblings",
        await sb.from("securities").select("id").eq("company_id", own.company_id),
      ) as { id: string }[];
      const res = await sb
        .from("broker_positions")
        .select("isin")
        .in(
          "security_id",
          siblings.map((s) => s.id),
        )
        .not("isin", "is", null);
      if (res.error) return []; // table missing (before P5) or not readable: no held ISINs, never a failure
      return [...new Set((res.data as { isin: string }[]).map((r) => r.isin))];
    },

    async activeOverrides(securityId) {
      const data = check(
        "eur_equivalent_overrides.select",
        await sb
          .from("eur_equivalent_overrides")
          .select(
            "id, ibkr_exchange_id, action, ibkr_conid, ibkr_local_symbol, eur_symbol_yahoo, isin, reason",
          )
          .eq("security_id", securityId)
          .eq("active", true),
      );
      return (data ?? []) as OverrideRow[];
    },

    async findCandidates(q) {
      const base = () =>
        sb
          .from("ibkr_catalogue")
          .select(CANDIDATE_COLUMNS)
          .in("exchange_id", ["IBIS", "AEB"])
          .eq("product_type", "STK")
          .eq("currency", "EUR")
          .limit(LIMIT);
      const found: CatalogueCandidate[] = [];
      const add = (rows: unknown): void => {
        for (const r of (rows ?? []) as Record<string, unknown>[]) {
          found.push({
            exchange_id: r["exchange_id"] as EurExchange,
            conid: Number(r["conid"]),
            symbol: String(r["symbol"]),
            local_symbol: String(r["local_symbol"]),
            isin: (r["isin"] as string | null) ?? null,
            description: (r["description"] as string | null) ?? null,
          });
        }
      };
      if (q.isins.length > 0)
        add(check("ibkr_catalogue.by_isin", await base().in("isin", q.isins)));
      if (q.baseTicker !== "")
        add(check("ibkr_catalogue.by_symbol", await base().eq("symbol", q.baseTicker)));
      const prefix = likeSafe(q.namePrefix);
      if (prefix.length >= 3)
        add(check("ibkr_catalogue.by_name", await base().ilike("description", `${prefix}%`)));
      const unique = new Map<string, CatalogueCandidate>();
      for (const c of found) unique.set(`${c.exchange_id}:${c.conid}`, c);
      return [...unique.values()];
    },

    async loadFx(currencies, scanDate) {
      const data = check(
        "fx_rates.select",
        await sb
          .from("fx_rates")
          .select("ccy, usd_per_unit, rate_date")
          .in("ccy", currencies)
          .lte("rate_date", scanDate)
          .order("rate_date", { ascending: false })
          .limit(currencies.length * 8),
      ) as { ccy: string; usd_per_unit: number; rate_date: string }[];
      const out = new Map<string, FxRate>();
      for (const r of data ?? [])
        if (!out.has(r.ccy)) out.set(r.ccy, { usdPerUnit: r.usd_per_unit, rateDate: r.rate_date });
      return out;
    },

    async replaceEquivalents(securityId: string, rows: EurEquivalentRow[]) {
      check(
        "replace_eur_equivalents",
        await app().rpc("replace_eur_equivalents", { p_security_id: securityId, p_rows: rows }),
      );
    },

    async setSecurityIsin(securityId, isin) {
      check(
        "securities.set_isin",
        await sb.from("securities").update({ isin }).eq("id", securityId).is("isin", null),
      );
    },

    async resolveTargets(runId, limit) {
      const data = check(
        "eur_resolve_targets",
        await app().rpc("eur_resolve_targets", { p_run: runId, p_limit: limit }),
      );
      return ((data ?? []) as string[]).map(String);
    },

    async upsertCatalogue(rows: CatalogueRow[]) {
      if (rows.length === 0) return;
      check(
        "ibkr_catalogue.upsert",
        await sb.from("ibkr_catalogue").upsert(rows, { onConflict: "exchange_id,conid" }),
      );
    },
  };
}
```

`supabase/functions/_shared/adapters/fixture-eur.test.ts` (write it first and see it fail with `Module not found`, then add the module):

```ts
import { assertEquals } from "@std/assert";
import { type EurFixtures, withEurFixtures } from "./fixture-eur.ts";
import type { MarketDataProvider, QuoteRecord } from "./providers.ts";

const eur: EurFixtures = {
  catalogue: {},
  isins: { US5949181045: "MSFT" },
  quotes: {
    "MSF.DE": {
      symbol: "MSF.DE",
      currency: "EUR",
      exchange: "GER",
      quoteType: "EQUITY",
      longName: "Microsoft Corporation",
      regularMarketPrice: 472.85,
      regularMarketTime: "2026-10-15T07:00:00Z",
      sharesOutstanding: 7_425_545_491,
    },
  },
};

const baseQuote = (symbol: string): QuoteRecord => ({
  symbol,
  quoteType: "EQUITY",
  currency: "USD",
  financialCurrency: null,
  exchange: "NMS",
  fullExchangeName: null,
  longName: "Base",
  shortName: null,
  marketCap: null,
  sharesOutstanding: null,
  regularMarketPrice: 1,
  regularMarketTime: null,
  regularMarketPreviousClose: null,
  regularMarketChangePercent: null,
  marketState: null,
  firstTradeDateMs: null,
  exchangeTimezoneName: null,
  priceHint: null,
});

function base(): MarketDataProvider & { quoted: string[][]; searched: string[] } {
  const quoted: string[][] = [];
  const searched: string[] = [];
  return {
    id: "fixture",
    quoted,
    searched,
    search(q) {
      searched.push(q);
      return Promise.resolve({ hits: [], news: [] });
    },
    quote(symbols) {
      quoted.push(symbols);
      return Promise.resolve(symbols.map(baseQuote));
    },
  };
}

Deno.test("search: a fixture ISIN answers with its primary symbol, anything else falls through", async () => {
  const b = base();
  const m = withEurFixtures(b, eur);
  assertEquals(
    (await m.search("US5949181045")).hits.map((h) => h.symbol),
    ["MSFT"],
  );
  assertEquals(b.searched, []);
  assertEquals((await m.search("DE0007164600")).hits, []);
  assertEquals(b.searched, ["DE0007164600"]);
});

Deno.test("quote: fixture lines are mapped, the other symbols go to the base provider only", async () => {
  const b = base();
  const out = await withEurFixtures(b, eur).quote(["MSFT", "MSF.DE"]);
  assertEquals(b.quoted, [["MSFT"]]);
  assertEquals(out.map((q) => [q.symbol, q.currency, q.regularMarketPrice]).sort(), [
    ["MSF.DE", "EUR", 472.85],
    ["MSFT", "USD", 1],
  ]);
  assertEquals(out.find((q) => q.symbol === "MSF.DE")?.sharesOutstanding, 7_425_545_491);
  const only = base();
  await withEurFixtures(only, eur).quote(["MSF.DE"]);
  assertEquals(only.quoted, [], "no base call when every symbol is a fixture line");
});
```

`supabase/functions/_shared/adapters/fixture-eur.ts` (offline data for fixture mode on the local stack only: ISIN to primary symbol answers for `search`, raw quote records for the EUR lines, catalogue pages; the JSON file it reads is generated in Task 6 and is read only in fixture mode):

```ts
import type { MarketDataProvider, QuoteRecord } from "./providers.ts";
import { mapQuote } from "./yahoo.ts";

/**
 * Offline data for the EUR stages in fixture mode (local stack only, 7.12): catalogue pages for the weekly import, ISIN -> primary symbol
 * answers for Yahoo `search(isin)`, and raw quote records for the EUR lines (`MSF.DE`, the `MSFT.AS` look-alike). Generated by
 * tools/gen-eur-fixtures.ts from the integration world and the IBKR catalogue fixtures; never read in production.
 */
export interface EurFixtures {
  catalogue: Record<string, unknown[][]>; // exchangeId -> pages -> products (the IBKR response rows)
  isins: Record<string, string>; // ISIN -> Yahoo primary symbol
  quotes: Record<string, Record<string, unknown>>; // Yahoo symbol -> raw quote record
}

export async function loadEurFixtures(): Promise<EurFixtures> {
  const text = await Deno.readTextFile(
    new URL("./fixtures/integration/eur-fixtures.json", import.meta.url),
  );
  return JSON.parse(text) as EurFixtures;
}

/** Overlays the EUR fixtures on a fixture market provider: symbols and ISINs it does not know fall through to the base provider. */
export function withEurFixtures(market: MarketDataProvider, eur: EurFixtures): MarketDataProvider {
  return {
    ...market,
    async search(q, o) {
      const symbol = eur.isins[q];
      if (symbol === undefined) return await market.search(q, o);
      return {
        hits: [
          {
            symbol,
            exchange: "NMS",
            quoteType: "EQUITY",
            longName: null,
            shortName: null,
            sector: null,
            industry: null,
          },
        ],
        news: [],
      };
    },
    async quote(symbols, o) {
      const own: QuoteRecord[] = [];
      const rest: string[] = [];
      for (const s of symbols) {
        const raw = eur.quotes[s];
        const mapped = raw === undefined ? null : mapQuote(raw);
        if (mapped !== null) own.push(mapped);
        else rest.push(s);
      }
      const base = rest.length === 0 ? [] : await market.quote(rest, o);
      return [...base, ...own];
    },
  };
}
```

`supabase/functions/worker-tick/handlers/eur_register.ts` (fixture mode answers the catalogue endpoint from `eur-fixtures.json`; live mode uses the global `fetch`):

```ts
import type { SupabaseClient } from "@supabase/supabase-js";
import { systemClock } from "../../_shared/adapters/clock.ts";
import { loadEurFixtures } from "../../_shared/adapters/fixture-eur.ts";
import {
  type CatalogueFetch,
  createFixtureCatalogueFetch,
} from "../../_shared/adapters/ibkr-catalogue.ts";
import type { Handler, Seeder } from "../types.ts";
import { runEurCatalogue, seedEurCatalogue } from "./eur_catalogue.ts";
import { runEurResolve, seedEurResolve } from "./eur_resolve.ts";
import { createEurStore } from "./eur_store.ts";

/**
 * Registration of the two EUR stages. `worker-tick/stages.ts` references these four exports in HANDLERS and SEEDERS and lists both stages
 * in PIPELINE_ORDER. Fixture mode (local stack only) answers the catalogue endpoint from fixtures/integration/eur-fixtures.json so the
 * integration test never touches IBKR; live mode uses the global fetch.
 */

async function catalogueFetch(providerMode: "live" | "fixture"): Promise<CatalogueFetch> {
  if (providerMode === "fixture") {
    if (Deno.env.get("ALLOW_FIXTURE_PROVIDERS") !== "1")
      throw new Error("fixture providers are not allowed in this environment");
    return createFixtureCatalogueFetch((await loadEurFixtures()).catalogue);
  }
  return (url, init) => fetch(url, init);
}

export const handleEurCatalogue: Handler = async (ctx) =>
  runEurCatalogue(ctx, {
    store: createEurStore(ctx.db.sb as SupabaseClient),
    fetchImpl: await catalogueFetch(ctx.run.providerMode),
    clock: systemClock,
  });

export const handleEurResolve: Handler = (ctx) =>
  runEurResolve(ctx, {
    store: createEurStore(ctx.db.sb as SupabaseClient),
    market: ctx.providers.market,
  });

export const seedEurCatalogueStage: Seeder = (ctx) => Promise.resolve(seedEurCatalogue(ctx));

export const seedEurResolveStage: Seeder = (ctx) =>
  seedEurResolve(ctx, createEurStore(ctx.db.sb as SupabaseClient));
```

Run `deno test -A --config supabase/functions/deno.json supabase/functions/_shared/adapters/fixture-eur.test.ts` (2 tests pass) and `bun run functions:check`.

- [ ] **Step 9: Put the stages in the pipeline**

**a) The database order** (re-runnable; it rewrites the `v_order` literal of the function as it exists in your database, so P2's and later phases' stages are preserved). `supabase/migrations/20261015006100_eur_stage_order.sql`:

```sql
-- P6: put the two EUR stages into the pipeline order used by app.next_stage_to_seed (spec 7.4).
--   eur_catalogue  right after `identity`  (weekly import; one job per run, which completes at once when the import is not due)
--   eur_resolve    right after `news` when that stage exists (P2), otherwise right after `publish`
-- Later phases CREATE OR REPLACE next_stage_to_seed with a longer list (P1 note). To stay correct whatever the list is by now, this migration
-- rewrites the array literal of the function as it exists in this database instead of replacing the whole function.
-- Re-runnable: it does nothing when the stages are already in the list. It fails loudly when the array literal cannot be found.

do $$
declare
  v_def   text := pg_get_functiondef('app.next_stage_to_seed(uuid)'::regprocedure);
  v_arr   text;
  v_new   text;
begin
  v_arr := substring(v_def from 'v_order\s+job_stage\[\]\s*:=\s*array\[([^\]]*)\]');
  if v_arr is null then
    raise exception 'app.next_stage_to_seed: the v_order array literal was not found; add eur_catalogue (after identity) and eur_resolve (after news, else after publish) by hand';
  end if;
  if v_arr like '%''eur_catalogue''%' then
    return;
  end if;
  if v_arr not like '%''identity''%' or (v_arr not like '%''news''%' and v_arr not like '%''publish''%') then
    raise exception 'app.next_stage_to_seed: the order does not contain identity and (news or publish): %', v_arr;
  end if;
  v_new := replace(v_arr, '''identity''', '''identity'', ''eur_catalogue''');
  if v_new like '%''news''%' then
    v_new := replace(v_new, '''news''', '''news'', ''eur_resolve''');
  else
    v_new := replace(v_new, '''publish''', '''publish'', ''eur_resolve''');
  end if;
  execute replace(v_def, v_arr, v_new);
end $$;
```

`supabase/tests/0601_eur_stage_order.test.sql`:

```sql
begin;
select plan(6);

-- the order array was rewritten in place: eur_catalogue right after identity, eur_resolve right after news (or publish when there is no news stage)
select matches(pg_get_functiondef('app.next_stage_to_seed(uuid)'::regprocedure), $$'identity',\s*'eur_catalogue'$$, 'eur_catalogue follows identity');
select matches(pg_get_functiondef('app.next_stage_to_seed(uuid)'::regprocedure), $$'(news|publish)',\s*'eur_resolve'$$, 'eur_resolve follows news or publish');
select is((select count(*)::int from regexp_matches(pg_get_functiondef('app.next_stage_to_seed(uuid)'::regprocedure), 'eur_catalogue', 'g')), 1, 'each stage appears once (the migration is re-runnable)');

-- behaviour: after identity only the eur_catalogue job may be seeded, and fetch_bars waits for it
insert into public.scan_runs (id, scan_date_local, settings_snapshot) values ('e2000000-0000-4000-8000-000000000001', '2026-10-15', '{}'::jsonb);
insert into public.scan_jobs (scan_run_id, stage, key, status) values
  ('e2000000-0000-4000-8000-000000000001', 'fx', 'all', 'done'),
  ('e2000000-0000-4000-8000-000000000001', 'universe_sweep', 'NMS', 'done'),
  ('e2000000-0000-4000-8000-000000000001', 'identity', 'group:0', 'done');
select is(app.next_stage_to_seed('e2000000-0000-4000-8000-000000000001'), 'eur_catalogue'::job_stage, 'eur_catalogue is seeded right after identity');

insert into public.scan_jobs (scan_run_id, stage, key, status) values ('e2000000-0000-4000-8000-000000000001', 'eur_catalogue', 'eur_catalogue:2026-W42', 'queued');
select is(app.next_stage_to_seed('e2000000-0000-4000-8000-000000000001')::text, null, 'fetch_bars waits while the eur_catalogue job is open');

update public.scan_jobs set status = 'done' where stage = 'eur_catalogue' and scan_run_id = 'e2000000-0000-4000-8000-000000000001';
select is(app.next_stage_to_seed('e2000000-0000-4000-8000-000000000001'), 'fetch_bars'::job_stage, 'fetch_bars follows once the eur_catalogue job is terminal');

select * from finish();
rollback;
```

**b) The Edge order and registry.** In `supabase/functions/worker-tick/stages.ts` add the import and the entries (keep every existing line; the two `PIPELINE_ORDER` insertions must match step 9a: `eur_catalogue` directly after `identity`, `eur_resolve` directly after `news` when that stage exists, otherwise directly after `publish`):

```ts
import {
  handleEurCatalogue,
  handleEurResolve,
  seedEurCatalogueStage,
  seedEurResolveStage,
} from "./handlers/eur_register.ts";

export const PIPELINE_ORDER: JobStage[] = [
  "fx",
  "universe_sweep",
  "identity",
  "eur_catalogue",
  "fetch_bars",
  "compute",
  "rank_signals",
  "classify",
  "publish",
  // P2 adds "news" and "research" after "publish": then "eur_resolve" goes directly after "news"
  "eur_resolve",
];

// inside HANDLERS:
  eur_catalogue: handleEurCatalogue,
  eur_resolve: handleEurResolve,

// inside SEEDERS:
  eur_catalogue: seedEurCatalogueStage,
  eur_resolve: seedEurResolveStage,
```

`supabase/functions/worker-tick/stages-eur.test.ts`:

```ts
import { assert, assertEquals } from "@std/assert";
import { HANDLERS, PIPELINE_ORDER, SEEDERS } from "./stages.ts";

Deno.test("the EUR stages are registered and placed after identity and after news (or publish)", () => {
  const after = (stage: string) => PIPELINE_ORDER[PIPELINE_ORDER.indexOf(stage as never) + 1];
  assertEquals(after("identity"), "eur_catalogue");
  assertEquals(after(PIPELINE_ORDER.includes("news" as never) ? "news" : "publish"), "eur_resolve");
  for (const stage of ["eur_catalogue", "eur_resolve"] as const) {
    assert(HANDLERS[stage] !== undefined, `${stage} has a handler`);
    assert(SEEDERS[stage] !== undefined, `${stage} has a seeder`);
  }
});
```

**c) Stage caps.** In `supabase/functions/_shared/adapters/settings.ts` add both stages to `DEFAULT_PIPELINE.stageCaps` (cap 1 each: the import and the Yahoo calls are serialised):

```ts
stageCaps: Object.freeze({
  fx: 1,
  universe_sweep: 1,
  identity: 1,
  eur_catalogue: 1,
  fetch_bars: 1,
  compute: 2,
  rank_signals: 1,
  classify: 1,
  publish: 1,
  eur_resolve: 1,
}) as Record<string, number>,
```
and in its test (`settings.test.ts`, the assertion on `settings.pipeline.stageCaps` for default settings) add `eur_catalogue: 1` and `eur_resolve: 1` to the expected object.

- [ ] **Step 10: Check everything**

```powershell
bunx supabase db reset
bun run test:db
bun run functions:check
bun run functions:test
bun run check:functions-config
bun run lint:fix
bun run lint
bun run typecheck
```
Expected: pgTAP `0600` and `0601` pass (`0601` has 6 assertions); Deno tests pass; no config drift (the handlers import only `@supabase/supabase-js`, already in the import map); lint and typecheck clean. If `0601` fails with `order array not found`, read the current definition with `select pg_get_functiondef('app.next_stage_to_seed(uuid)'::regprocedure);` and edit the migration's regular expression or add the two stages by hand, then keep `stages.ts` in the same order.

- [ ] **Step 11: Commit**

```powershell
git add supabase/functions/worker-tick supabase/functions/_shared/adapters/fixture-eur.ts supabase/functions/_shared/adapters/fixture-eur.test.ts supabase/functions/_shared/adapters/settings.ts supabase/functions/_shared/adapters/settings.test.ts supabase/migrations/20261015006100_eur_stage_order.sql supabase/tests/0601_eur_stage_order.test.sql
git commit -m "feat(worker): add the EUR catalogue import and EUR equivalent resolution stages with spec 5.7 verification"
```

---

## Task 4: `core/handoff.ts` (prompt generation, validation, destinations, estimate)

**Concurrency:** may run at the same time as Tasks 1 and 2 (disjoint files); Tasks 3 and 5 depend on it. Implementer: sonnet.

**Files:**
- Create: `supabase/functions/_shared/core/handoff.ts`, `supabase/functions/_shared/core/handoff.test.ts`

**Interfaces:**
- Consumes: nothing (core files import nothing).
- Produces: types `Destination`, `Side`, `OrderType`, `EurExchange`, `EurStatus`, `IbotInput`, `PromptIssue`, `PromptResult`, `EurListing`, `Estimate`; constants `DESTINATIONS`, `DEFAULT_DESTINATION`, `DESTINATION_LABELS`, `IBKR_LOGIN_URL`, `NO_ORDER_NOTICE`, `TICKET_REVIEW_NOTE`, `MAX_PRICE_DECIMALS`; `isDestination`, `localSymbolProblem`, `isValidLocalSymbol`, `validateIbotInput`, `buildIbotPrompt` (`{ ok: true, prompt } | { ok: false, issues }`), `buildDocumentedStylePrompt`, `formatPriceForPrompt`, `parsePriceInput`, `parseQuantityInput`, `pickListing`, `allowedDestinations`, `chooseDestination`, `estimateValue`, `formatEuro`, `ticketChecklist`.

The brief's `handoffSummary(...)` is delivered as three small pure functions the modal composes: `estimateValue` (quantity x price in EUR, always labelled an estimate before fees, no commission), `ticketChecklist` (`On the ticket confirm: conid 12178239 / MSF / EUR / destination IBIS2`) and `chooseDestination`.

- [ ] **Step 1: Write the failing test**

`supabase/functions/_shared/core/handoff.test.ts` (21 tests: the owner's example, the market order without the price clause, a sell on AEB with the IBKR local symbol, price formatting, every validation rule, the Yahoo-ticker refusal, decimal-comma rejection, listing choice, destination rules, estimate, checklist):

```ts
import { describe, expect, it } from "vitest";
import {
  allowedDestinations,
  buildDocumentedStylePrompt,
  buildIbotPrompt,
  chooseDestination,
  DEFAULT_DESTINATION,
  DESTINATION_LABELS,
  DESTINATIONS,
  type EurListing,
  estimateValue,
  formatEuro,
  formatPriceForPrompt,
  IBKR_LOGIN_URL,
  type IbotInput,
  isValidLocalSymbol,
  localSymbolProblem,
  NO_ORDER_NOTICE,
  parsePriceInput,
  parseQuantityInput,
  pickListing,
  ticketChecklist,
} from "./handoff.ts";

const base: IbotInput = {
  side: "buy",
  orderType: "limit",
  quantity: 10,
  localSymbol: "MSF",
  price: 400,
  destination: "IBIS2",
};

function prompt(over: Partial<IbotInput>): string {
  const r = buildIbotPrompt({ ...base, ...over });
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r.issues)}`);
  return r.prompt;
}

describe("constants", () => {
  it("pins the destinations, labels, default and the login link", () => {
    expect(DESTINATIONS).toEqual(["IBIS2", "IBIS", "AEB"]);
    expect(DEFAULT_DESTINATION).toBe("IBIS2");
    expect(DESTINATION_LABELS).toEqual({
      IBIS2: "Xetra (IBIS2 — owner practice, not in IBKR's public catalogue)",
      IBIS: "Xetra",
      AEB: "Euronext Amsterdam",
    });
    expect(IBKR_LOGIN_URL).toBe("https://www.interactivebrokers.com/sso/Login");
    expect(NO_ORDER_NOTICE).toBe(
      "This app does not place orders. Paste the prompt into IBKR's iBot or create the order yourself, then confirm it in IBKR.",
    );
  });
});

describe("buildIbotPrompt", () => {
  it("builds the owner's example exactly", () => {
    expect(prompt({})).toBe(
      "Create buy limit order for 10 shares of MSF at 400 and set destination IBIS2",
    );
  });

  it("omits the price clause for a market order (A-38), even if a price is passed", () => {
    expect(
      prompt({ side: "sell", orderType: "market", price: undefined, destination: "IBIS" }),
    ).toBe("Create sell market order for 10 shares of MSF and set destination IBIS");
    expect(prompt({ orderType: "market", price: 123.45 })).toBe(
      "Create buy market order for 10 shares of MSF and set destination IBIS2",
    );
  });

  it("builds a sell limit on AEB with the IBKR local symbol (UNA), never the Yahoo ticker", () => {
    expect(
      prompt({ side: "sell", quantity: 3, localSymbol: "UNA", price: 51.2, destination: "AEB" }),
    ).toBe("Create sell limit order for 3 shares of UNA at 51.2 and set destination AEB");
  });

  it("prints a dot decimal separator and at most 4 decimals, with no grouping or exponent", () => {
    expect(prompt({ price: 472.85 })).toContain(" at 472.85 ");
    expect(prompt({ price: 1234.5 })).toContain(" at 1234.5 ");
    expect(prompt({ price: 0.0001 })).toContain(" at 0.0001 ");
    expect(prompt({ price: 123456789.1234 })).toContain(" at 123456789.1234 ");
    expect(formatPriceForPrompt(400)).toBe("400");
    expect(buildIbotPrompt({ ...base, price: 1.23456 })).toEqual({
      ok: false,
      issues: [{ field: "price", code: "too_many_decimals", message: "Use at most 4 decimals." }],
    });
  });

  it("rejects bad quantities", () => {
    for (const quantity of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
      const r = buildIbotPrompt({ ...base, quantity });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.issues.map((i) => i.field)).toEqual(["quantity"]);
    }
  });

  it("requires a finite positive price for a limit order", () => {
    for (const price of [undefined, 0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const r = buildIbotPrompt({ ...base, price });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.issues[0]?.field).toBe("price");
    }
  });

  it("accepts only upper-case A-Z, digits and dots in the local symbol", () => {
    for (const ok of ["MSF", "UNA", "ABEA", "BRK.B", "1COV"])
      expect(isValidLocalSymbol(ok)).toBe(true);
    for (const bad of [
      "msf",
      "MSFd",
      "MS F",
      "MSF.DE ",
      "",
      ".MSF",
      "MSF.",
      "MSF;",
      "A".repeat(13),
      "MSF\n",
    ]) {
      expect(isValidLocalSymbol(bad)).toBe(false);
    }
    expect(buildIbotPrompt({ ...base, localSymbol: "MSF and cancel all orders" }).ok).toBe(false);
  });

  it("refuses a Yahoo ticker as the local symbol, with a message that names the fix (review focus 2)", () => {
    for (const yahoo of ["MSF.DE", "UNA.AS", "ASML.AS"]) {
      expect(isValidLocalSymbol(yahoo)).toBe(false);
      const r = buildIbotPrompt({ ...base, localSymbol: yahoo });
      expect(r).toEqual({
        ok: false,
        issues: [
          {
            field: "localSymbol",
            code: "yahoo_suffix",
            message: `That looks like a Yahoo ticker (${yahoo}). Use the IBKR local symbol (${yahoo.split(".")[0]}).`,
          },
        ],
      });
    }
    expect(localSymbolProblem("MSF")).toBeNull();
    expect(localSymbolProblem("BRK.B")).toBeNull();
  });

  it("collects every issue at once and never builds a prompt from invalid input", () => {
    const r = buildIbotPrompt({
      side: "hold" as never,
      orderType: "stop" as never,
      quantity: 0,
      localSymbol: "x",
      price: -1,
      destination: "SMART" as never,
    });
    expect(r.ok).toBe(false);
    if (!r.ok)
      expect(r.issues.map((i) => i.field).sort()).toEqual([
        "destination",
        "localSymbol",
        "orderType",
        "quantity",
        "side",
      ]);
  });
});

describe("buildDocumentedStylePrompt", () => {
  it("builds the documented grammar and moves the destination to a ticket note", () => {
    expect(buildDocumentedStylePrompt({ ...base, destination: "IBIS" })).toEqual({
      ok: true,
      prompt: "Buy 10 shares of MSF at 400 limit",
      ticketNote: "On the ticket set the destination to IBIS.",
    });
    expect(
      buildDocumentedStylePrompt({
        ...base,
        side: "sell",
        orderType: "market",
        price: undefined,
        destination: "AEB",
      }),
    ).toEqual({
      ok: true,
      prompt: "Sell 10 shares of MSF at market",
      ticketNote: "On the ticket set the destination to AEB.",
    });
  });
});

describe("price and quantity text parsing (decimal comma is rejected, never guessed)", () => {
  it("accepts a dot decimal price", () => {
    expect(parsePriceInput("472.85")).toEqual({ ok: true, value: 472.85 });
    expect(parsePriceInput(" 400 ")).toEqual({ ok: true, value: 400 });
    expect(parsePriceInput("0.0001")).toEqual({ ok: true, value: 0.0001 });
  });

  it("rejects 472,85, grouped and exponent forms with a message about the dot", () => {
    for (const text of ["472,85", "1,234.50", "1 234.50", "1.234,50"]) {
      const r = parsePriceInput(text);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.message).toContain("dot");
    }
    for (const text of ["", "abc", "1e3", "-5", "0", "0.00", "1.23456", ".5", "5."])
      expect(parsePriceInput(text).ok).toBe(false);
  });

  it("parses quantities as positive whole numbers only", () => {
    expect(parseQuantityInput("10")).toEqual({ ok: true, value: 10 });
    for (const text of ["", "0", "-1", "1.5", "1,000", "10 shares", "1e3", "1234567890"])
      expect(parseQuantityInput(text).ok).toBe(false);
  });
});

const row = (over: Partial<EurListing>): EurListing => ({
  exchange: "IBIS",
  status: "verified",
  conid: 12178239,
  localSymbol: "MSF",
  isin: "US5949181045",
  eurSymbolYahoo: "MSF.DE",
  verifiedAt: "2026-10-15T08:00:00Z",
  verification: {},
  ...over,
});

describe("pickListing and destinations", () => {
  it("prefers verified over unverified over none, then IBIS over AEB", () => {
    const ibisUnverified = row({ status: "unverified" });
    const aebVerified = row({ exchange: "AEB", localSymbol: "ASML" });
    const ibisVerified = row({});
    expect(pickListing([ibisUnverified, aebVerified])).toBe(aebVerified);
    expect(pickListing([aebVerified, ibisVerified])).toBe(ibisVerified);
    expect(pickListing([row({ status: "none", conid: null, localSymbol: null })])?.status).toBe(
      "none",
    );
    expect(pickListing([])).toBeNull();
  });

  it("offers IBIS2 and IBIS only with an IBIS listing and AEB only with an AEB listing", () => {
    expect(allowedDestinations(["IBIS"])).toEqual(["IBIS2", "IBIS"]);
    expect(allowedDestinations(["AEB"])).toEqual(["AEB"]);
    expect(allowedDestinations(["IBIS", "AEB"])).toEqual(["IBIS2", "IBIS", "AEB"]);
    expect(allowedDestinations([])).toEqual(["IBIS2", "IBIS", "AEB"]);
  });

  it("keeps the default when it applies and pre-selects AEB with a reason when only AEB lists the share", () => {
    expect(chooseDestination("IBIS2", ["IBIS"])).toEqual({
      destination: "IBIS2",
      adjusted: false,
      reason: null,
    });
    const r = chooseDestination("IBIS2", ["AEB"]);
    expect(r.destination).toBe("AEB");
    expect(r.adjusted).toBe(true);
    expect(r.reason).toContain("IBIS2");
    expect(chooseDestination("AEB", [])).toEqual({
      destination: "AEB",
      adjusted: false,
      reason: null,
    });
  });
});

describe("estimate and checklist", () => {
  it("estimates quantity x limit price, labelled an estimate before fees", () => {
    const e = estimateValue({ orderType: "limit", quantity: 10, price: 472.85 });
    expect(e.amount).toBe(4728.5);
    expect(e.basis).toBe("limit price");
    expect(e.label).toBe(
      "Estimate before fees: 4,728.50 EUR (10 x 472.85, limit price); commissions not included",
    );
  });

  it("uses the delayed quote for a market order and says so; unavailable without a price", () => {
    expect(estimateValue({ orderType: "market", quantity: 3, referencePrice: 100.1 }).basis).toBe(
      "delayed quote",
    );
    expect(estimateValue({ orderType: "market", quantity: 3 }).amount).toBeNull();
    expect(estimateValue({ orderType: "limit", quantity: 0, price: 1 }).amount).toBeNull();
  });

  it("formats euros with a dot and grouping for display only", () => {
    expect(formatEuro(4728.5)).toBe("4,728.50");
    expect(formatEuro(0.5)).toBe("0.50");
    expect(formatEuro(1234567.891)).toBe("1,234,567.89");
  });

  it("writes the ticket checklist, with an honest unknown conid on the manual path", () => {
    expect(ticketChecklist({ conid: 12178239, localSymbol: "MSF", destination: "IBIS2" })).toBe(
      "On the ticket confirm: conid 12178239 / MSF / EUR / destination IBIS2",
    );
    expect(ticketChecklist({ conid: null, localSymbol: "MSF", destination: "IBIS" })).toContain(
      "conid unknown",
    );
  });
});
```

- [ ] **Step 2: Run; Expected: FAIL**

```powershell
bun run test:core handoff
```
Expected: FAIL (`Failed to resolve import "./handoff.ts"`).

- [ ] **Step 3: Implement**

`supabase/functions/_shared/core/handoff.ts`:

```ts
// "Trade on IBKR" hand-off (spec 13). Pure: builds text for the owner to paste into IBKR's iBot. The app never places an order.
// Rules: relative ".ts" imports only, no Date.now(), no Intl, no locale-dependent formatting (a decimal comma must never reach a prompt).

export type Destination = "IBIS2" | "IBIS" | "AEB";
export type Side = "buy" | "sell";
export type OrderType = "limit" | "market";
export type EurExchange = "IBIS" | "AEB";
export type EurStatus = "verified" | "unverified" | "none";

export const DESTINATIONS: readonly Destination[] = ["IBIS2", "IBIS", "AEB"];
export const DEFAULT_DESTINATION: Destination = "IBIS2";

export const DESTINATION_LABELS: Readonly<Record<Destination, string>> = {
  IBIS2: "Xetra (IBIS2 — owner practice, not in IBKR's public catalogue)",
  IBIS: "Xetra",
  AEB: "Euronext Amsterdam",
};

export const IBKR_LOGIN_URL = "https://www.interactivebrokers.com/sso/Login";
export const NO_ORDER_NOTICE =
  "This app does not place orders. Paste the prompt into IBKR's iBot or create the order yourself, then confirm it in IBKR.";
export const TICKET_REVIEW_NOTE =
  "iBot prepares an order ticket for your review. Check the instrument (conid and EUR currency), destination, quantity and price, then submit it yourself in IBKR.";

export const MAX_PRICE_DECIMALS = 4;
const MAX_PRICE = 1_000_000_000;
const MAX_QUANTITY = 1_000_000_000;
/** IBKR local symbols on IBIS and AEB are upper-case letters and digits; a dot is allowed (share-class style symbols). */
const LOCAL_SYMBOL = /^[A-Z0-9][A-Z0-9.]{0,11}$/;

export function isDestination(value: unknown): value is Destination {
  return typeof value === "string" && (DESTINATIONS as readonly string[]).includes(value);
}

/** The Yahoo suffixes of the two venues this feature maps (`MSF.DE`, `UNA.AS`). IBKR local symbols on IBIS and AEB never carry them. */
const YAHOO_SUFFIX = /\.(DE|AS)$/;

/** Why a string cannot be used as the IBKR local symbol in a prompt, or null when it can. A Yahoo ticker is the classic wrong input. */
export function localSymbolProblem(value: string): string | null {
  if (YAHOO_SUFFIX.test(value)) {
    const base = value.replace(YAHOO_SUFFIX, "");
    return `That looks like a Yahoo ticker (${value}). Use the IBKR local symbol (${base}).`;
  }
  if (!LOCAL_SYMBOL.test(value) || value.endsWith(".")) {
    return "The IBKR local symbol must use upper-case letters, digits and dots only.";
  }
  return null;
}

export function isValidLocalSymbol(value: string): boolean {
  return localSymbolProblem(value) === null;
}

// ---------------------------------------------------------------------------------------------- prompt

export interface IbotInput {
  side: Side;
  orderType: OrderType;
  quantity: number;
  localSymbol: string;
  price?: number | undefined;
  destination: Destination;
}

export type IssueField =
  | "side"
  | "orderType"
  | "quantity"
  | "localSymbol"
  | "price"
  | "destination";
export interface PromptIssue {
  field: IssueField;
  code: string;
  message: string;
}
export type PromptResult = { ok: true; prompt: string } | { ok: false; issues: PromptIssue[] };
export type DocumentedPromptResult =
  | { ok: true; prompt: string; ticketNote: string }
  | { ok: false; issues: PromptIssue[] };

/** The price exactly as it appears in a prompt: dot decimal separator, at most 4 decimals, no grouping, no exponent. */
export function formatPriceForPrompt(price: number): string {
  return String(Number(price.toFixed(MAX_PRICE_DECIMALS)));
}

export function validateIbotInput(input: IbotInput): PromptIssue[] {
  const issues: PromptIssue[] = [];
  const add = (field: IssueField, code: string, message: string) =>
    issues.push({ field, code, message });
  if (input.side !== "buy" && input.side !== "sell") add("side", "invalid", "Choose buy or sell.");
  if (input.orderType !== "limit" && input.orderType !== "market")
    add("orderType", "invalid", "Choose limit or market.");
  if (
    !Number.isSafeInteger(input.quantity) ||
    input.quantity <= 0 ||
    input.quantity > MAX_QUANTITY
  ) {
    add("quantity", "not_positive_integer", "Quantity must be a positive whole number.");
  }
  const symbolProblem = localSymbolProblem(input.localSymbol);
  if (symbolProblem !== null) {
    add(
      "localSymbol",
      YAHOO_SUFFIX.test(input.localSymbol) ? "yahoo_suffix" : "invalid_format",
      symbolProblem,
    );
  }
  if (!isDestination(input.destination))
    add("destination", "invalid", "Choose IBIS2, IBIS or AEB.");
  if (input.orderType === "limit") {
    const p = input.price;
    if (p === undefined || !Number.isFinite(p) || p <= 0 || p > MAX_PRICE) {
      add("price", "not_positive_number", "A limit order needs a price greater than zero.");
    } else if (Number(p.toFixed(MAX_PRICE_DECIMALS)) !== p) {
      add("price", "too_many_decimals", `Use at most ${MAX_PRICE_DECIMALS} decimals.`);
    }
  }
  return issues;
}

/** Owner's template (D5): `Create <buy|sell> <limit|market> order for <qty> shares of <local symbol> at <price> and set destination <dest>`.
 *  A market order has no `at <price>` clause (A-38). The template says "shares" for every quantity, including 1. */
export function buildIbotPrompt(input: IbotInput): PromptResult {
  const issues = validateIbotInput(input);
  if (issues.length > 0) return { ok: false, issues };
  const at =
    input.orderType === "limit" ? ` at ${formatPriceForPrompt(input.price as number)}` : "";
  return {
    ok: true,
    prompt: `Create ${input.side} ${input.orderType} order for ${input.quantity} shares of ${input.localSymbol}${at} and set destination ${input.destination}`,
  };
}

/** Second, collapsible variant (spec 13.2): the grammar IBKR documents for iBot, with the destination moved to a ticket note. */
export function buildDocumentedStylePrompt(input: IbotInput): DocumentedPromptResult {
  const issues = validateIbotInput(input);
  if (issues.length > 0) return { ok: false, issues };
  const verb = input.side === "buy" ? "Buy" : "Sell";
  const tail =
    input.orderType === "limit"
      ? `at ${formatPriceForPrompt(input.price as number)} limit`
      : "at market";
  return {
    ok: true,
    prompt: `${verb} ${input.quantity} shares of ${input.localSymbol} ${tail}`,
    ticketNote: `On the ticket set the destination to ${input.destination}.`,
  };
}

// ---------------------------------------------------------------------------------------------- field parsing (UI text -> number)

export type ParseResult = { ok: true; value: number } | { ok: false; message: string };

/** A price typed by the user. A comma is rejected, never "fixed": 472,85 could be 472.85 or 47285 and a wrong guess costs money. */
export function parsePriceInput(text: string): ParseResult {
  const t = text.trim();
  if (t === "") return { ok: false, message: "Enter a price." };
  if (/[,\s]/.test(t))
    return {
      ok: false,
      message: "Use a dot as the decimal separator (472.85) and no thousands separators.",
    };
  if (!/^\d+(\.\d{1,4})?$/.test(t))
    return {
      ok: false,
      message: `Enter a positive number with at most ${MAX_PRICE_DECIMALS} decimals.`,
    };
  const value = Number(t);
  if (!(value > 0) || value > MAX_PRICE)
    return { ok: false, message: "The price must be greater than zero." };
  return { ok: true, value };
}

export function parseQuantityInput(text: string): ParseResult {
  const t = text.trim();
  if (t === "") return { ok: false, message: "Enter a quantity." };
  if (!/^[1-9]\d{0,8}$/.test(t))
    return { ok: false, message: "Quantity must be a positive whole number." };
  return { ok: true, value: Number(t) };
}

// ---------------------------------------------------------------------------------------------- EUR listing choice and destinations

export interface EurListing {
  exchange: EurExchange;
  status: EurStatus;
  conid: number | null;
  localSymbol: string | null;
  isin: string | null;
  eurSymbolYahoo: string | null;
  verifiedAt: string | null;
  verification: Record<string, unknown>;
}

const STATUS_RANK: Record<EurStatus, number> = { verified: 0, unverified: 1, none: 2 };
const EXCHANGE_RANK: Record<EurExchange, number> = { IBIS: 0, AEB: 1 };

/** Best EUR line for a security: verified before unverified before none, then IBIS (Xetra) before AEB (spec 5.7, brief 21). */
export function pickListing(rows: readonly EurListing[]): EurListing | null {
  const sorted = [...rows].sort(
    (a, b) =>
      STATUS_RANK[a.status] - STATUS_RANK[b.status] ||
      EXCHANGE_RANK[a.exchange] - EXCHANGE_RANK[b.exchange],
  );
  return sorted[0] ?? null;
}

/** Destinations that make sense for the exchanges that actually list the instrument (spec 13.3). No listing at all: the manual path allows all three. */
export function allowedDestinations(exchanges: readonly EurExchange[]): Destination[] {
  if (exchanges.length === 0) return [...DESTINATIONS];
  const out: Destination[] = [];
  if (exchanges.includes("IBIS")) out.push("IBIS2", "IBIS");
  if (exchanges.includes("AEB")) out.push("AEB");
  return out;
}

export function chooseDestination(
  preferred: Destination,
  exchanges: readonly EurExchange[],
): { destination: Destination; adjusted: boolean; reason: string | null } {
  const allowed = allowedDestinations(exchanges);
  if (allowed.includes(preferred)) return { destination: preferred, adjusted: false, reason: null };
  const destination = allowed[0] ?? preferred;
  return {
    destination,
    adjusted: true,
    reason: `Your default destination ${preferred} does not apply to this instrument (${DESTINATION_LABELS[destination]} is the venue that lists it); ${destination} is pre-selected.`,
  };
}

// ---------------------------------------------------------------------------------------------- modal summary

function groupThousands(integerPart: string): string {
  return integerPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** Display only (never used in a prompt): 4728.5 -> "4,728.50". */
export function formatEuro(amount: number): string {
  const fixed = Math.abs(amount).toFixed(2);
  const [int = "0", frac = "00"] = fixed.split(".");
  return `${amount < 0 ? "-" : ""}${groupThousands(int)}.${frac}`;
}

export interface EstimateInput {
  orderType: OrderType;
  quantity: number;
  price?: number | undefined;
  referencePrice?: number | null | undefined;
}
export interface Estimate {
  amount: number | null;
  basis: "limit price" | "delayed quote" | null;
  label: string;
}

/** "Value before fees: quantity x limit price" (spec 13.1). No commission is estimated (no IBKR source). Always labelled an estimate. */
export function estimateValue(input: EstimateInput): Estimate {
  const usable = (n: number | null | undefined): n is number =>
    typeof n === "number" && Number.isFinite(n) && n > 0;
  let unit: number | null = null;
  let basis: Estimate["basis"] = null;
  if (input.orderType === "limit" && usable(input.price)) {
    unit = input.price;
    basis = "limit price";
  } else if (input.orderType === "market" && usable(input.referencePrice)) {
    unit = input.referencePrice;
    basis = "delayed quote";
  }
  if (unit === null || !Number.isSafeInteger(input.quantity) || input.quantity <= 0) {
    return { amount: null, basis: null, label: "Estimate before fees: not available" };
  }
  const amount = Math.round(input.quantity * unit * 100) / 100;
  return {
    amount,
    basis,
    label: `Estimate before fees: ${formatEuro(amount)} EUR (${input.quantity} x ${formatPriceForPrompt(unit)}, ${basis}); commissions not included`,
  };
}

/** "On the ticket confirm: conid 12178239 / MSF / EUR / destination IBIS2" (spec 13.1). */
export function ticketChecklist(input: {
  conid: number | null;
  localSymbol: string;
  destination: Destination;
}): string {
  const conid =
    input.conid === null ? "conid unknown (symbol not verified)" : `conid ${input.conid}`;
  return `On the ticket confirm: ${conid} / ${input.localSymbol} / EUR / destination ${input.destination}`;
}
```

- [ ] **Step 4: Run; Expected: PASS**

```powershell
bun run test:core handoff
bun run lint:fix
bun run typecheck
```
Expected: 21 tests pass; `typecheck` runs `tools/check-core-purity.ts` and `tsc -p supabase/functions/_shared/core` and is clean (the file imports nothing, uses no clock, no randomness, no `Intl`, no locale formatting: a decimal comma can only come from user text, which `parsePriceInput` rejects).

- [ ] **Step 5: Commit**

```powershell
git add supabase/functions/_shared/core/handoff.ts supabase/functions/_shared/core/handoff.test.ts
git commit -m "feat(core): add the iBot prompt builder, input validation, destination rules and order estimate"
```

---

## Task 5: Web - hand-off dialog and wiring

**Depends on:** Task 1 (the `eur_equivalents` read and `profiles.default_destination`) and Task 4 (`@core/handoff.ts`); may run alongside Task 3. Implementer: sonnet, who **must load the `frontend-design` and `ui-ux-pro-max:ui-ux-pro-max` skills before writing component markup or classes** (steps 7 to 9). The tests pin text, roles, labels and test ids; styling, spacing and responsive layout are the implementer's design work (the dialog must work at 360 px width, scroll inside the viewport, keep the notice visible, use text plus icon for every status, and pass the P4 accessibility rules: never colour alone, visible focus, labels on every input).

**Files:**
- Create under `apps/web/src/features/handoff/`: `types.ts`, `derive.ts`, `quote-text.ts`, `copy-text.ts`, `handoff-api.ts`, `default.ts`, `hooks.ts`, `use-cooldown.ts`, `holding-target.ts`, `eur-listing-panel.tsx`, `prompt-panel.tsx`, `trade-on-ibkr-dialog.tsx`, `trade-on-ibkr-button.tsx`, `default-destination-card.tsx`
- Create tests beside them: `derive.test.ts`, `support.test.ts`, `trade-on-ibkr-dialog.test.tsx`, `trade-on-ibkr-button.test.tsx`, `default-destination-card.test.tsx`, `no-leaks.test.ts`; plus `apps/web/src/features/overview/trade-control.test.tsx` and `apps/web/src/test/handoff-default-mock.ts`
- Modify: `apps/web/src/features/overview/discount-card.tsx` (P4) and its tests, `apps/web/src/features/profile/broker-page.tsx` and `profile-panels.test.tsx` (P5a), `apps/web/src/test/setup.ts`, the Portfolio positions table when it exists (step 14)

**Interfaces:**
- Consumes: `@core/handoff.ts` (Task 4); P4 `useQuotes(symbols)` from `@/features/screening/quotes-hooks` and `QuoteDto` from `@/features/screening/quotes-api`, `supabase` from `@/lib/supabase`, `ViewerState`; P5a `useAuth()` from `@/features/auth/auth-provider`; shadcn `Dialog`, `Button`, `Input`, `Label`, `Card`.
- Produces: `TradeOnIbkrDialog({ open, onOpenChange, target })`, `TradeOnIbkrButton({ target })` (renders a `Trade on IBKR` button and mounts the dialog only while open), `DefaultDestinationCard()`, `deriveHandoff({ listings, form, defaultDestination, referencePrice })`, `holdingTarget(ref)`, `TradeTarget`, `createHandoffApi(client)` / `handoffApi`, hooks `useEurListings`, `useDefaultDestination`, `useSaveDefaultDestination`, `copyText`, `usableEurQuote`, `formatUtcStamp`, `useCooldown`.

**How the pieces fit.** `deriveHandoff` is the whole rulebook of the dialog in one pure function: which listing is shown (`pickListing`), which destinations are offered and which one is selected, whether a prompt may be shown (the `gate`: acknowledgement for `unverified`, a manual symbol for `none`, valid quantity and price), the prompt, the documented-style variant, the estimate and the checklist. The dialog is thin: it feeds `deriveHandoff` from the form state, the EUR rows (public `eur_equivalents` read through `handoffApi`), the profile default (own row) and the delayed quote (`useQuotes`, requested only for a verified line), and renders the result. The local symbol always comes from `listing.localSymbol` (or the user's manual input on the `none` path), never from `eurSymbolYahoo`.

- [ ] **Step 1: Verify the seams**

```powershell
git grep -n "export function useQuotes" -- apps/web/src/features/screening
git grep -n "export interface QuoteDto" -- apps/web/src/features/screening
git grep -n "export function useAuth" -- apps/web/src/features/auth
git grep -n "export const supabase" -- apps/web/src/lib
git grep -n "submit-order-button\|Submit Order" -- apps/web
git grep -n "PositionsTable\|positions-table" -- apps/web/src
```
Expected: one hit each for the first four (P4 and P5a are merged); the `Submit Order` hits are P4's `discount-card.tsx` and its tests (changed in step 11); the last command shows whether P5b's table exists (step 14). If `@supabase/supabase-js` is not a dependency of `apps/web` yet (P4 Task 1 adds it), run `bun add --cwd apps/web --exact @supabase/supabase-js@2.117.3`. If `useQuotes` or `QuoteDto` differ from the shapes above (`useQuotes(symbols)` returning `{ data, isLoading, isFetching, refetch }`; `QuoteDto { symbol, currency, regularMarketPrice, regularMarketTime (epoch ms), stale }`), adapt only `trade-on-ibkr-dialog.tsx` and `quote-text.ts`.

- [ ] **Step 2: Write the failing pure tests**

`apps/web/src/features/handoff/derive.test.ts` (the dialog rulebook: verified, destination, unverified, none, Yahoo ticker refusal):

```ts
import type { EurListing } from "@core/handoff.ts";
import { describe, expect, it } from "vitest";
import { deriveHandoff, type FormState, INITIAL_FORM } from "./derive";

const msf = (over: Partial<EurListing> = {}): EurListing => ({
  exchange: "IBIS",
  status: "verified",
  conid: 12178239,
  localSymbol: "MSF",
  isin: "US5949181045",
  eurSymbolYahoo: "MSF.DE",
  verifiedAt: "2026-10-15T07:30:00Z",
  verification: {},
  ...over,
});
const form = (over: Partial<FormState> = {}): FormState => ({
  ...INITIAL_FORM,
  quantityText: "10",
  priceText: "400",
  ...over,
});
const derive = (
  listings: EurListing[],
  f: FormState,
  extra: { defaultDestination?: "IBIS2" | "IBIS" | "AEB"; referencePrice?: number | null } = {},
) =>
  deriveHandoff({
    listings,
    form: f,
    defaultDestination: extra.defaultDestination ?? "IBIS2",
    referencePrice: extra.referencePrice ?? null,
  });

describe("deriveHandoff: verified listing", () => {
  it("builds the owner's example prompt", () => {
    const v = derive([msf()], form());
    expect(v.mode).toBe("verified");
    expect(v.gate).toBeNull();
    expect(v.prompt).toBe(
      "Create buy limit order for 10 shares of MSF at 400 and set destination IBIS2",
    );
    expect(v.documented).toEqual({
      prompt: "Buy 10 shares of MSF at 400 limit",
      ticketNote: "On the ticket set the destination to IBIS2.",
    });
    expect(v.checklist).toBe(
      "On the ticket confirm: conid 12178239 / MSF / EUR / destination IBIS2",
    );
    expect(v.estimate.label).toBe(
      "Estimate before fees: 4,000.00 EUR (10 x 400, limit price); commissions not included",
    );
  });

  it("uses the IBKR local symbol, never the Yahoo ticker", () => {
    const v = derive(
      [msf({ exchange: "AEB", localSymbol: "UNA", eurSymbolYahoo: "UNA.AS" })],
      form({ destination: "AEB" }),
    );
    expect(v.prompt).toBe(
      "Create buy limit order for 10 shares of UNA at 400 and set destination AEB",
    );
    expect(v.prompt).not.toContain(".AS");
  });

  it("omits the price clause for a market order and estimates with the delayed quote", () => {
    const v = derive([msf()], form({ side: "sell", orderType: "market", priceText: "" }), {
      referencePrice: 472.85,
    });
    expect(v.prompt).toBe(
      "Create sell market order for 10 shares of MSF and set destination IBIS2",
    );
    expect(v.errors.price).toBeNull();
    expect(v.estimate.basis).toBe("delayed quote");
  });

  it("waits for a valid quantity and price and explains a decimal comma instead of guessing", () => {
    expect(derive([msf()], form({ quantityText: "" })).gate).toBe("needs_quantity");
    expect(derive([msf()], form({ quantityText: "0" })).errors.quantity).toContain(
      "positive whole number",
    );
    const comma = derive([msf()], form({ priceText: "472,85" }));
    expect(comma.gate).toBe("needs_price");
    expect(comma.prompt).toBeNull();
    expect(comma.errors.price).toContain("dot");
    expect(derive([msf()], form({ priceText: "" })).errors.price).toBeNull();
  });
});

describe("deriveHandoff: destination (spec 13.3)", () => {
  it("keeps the profile default when the listing is on IBIS", () => {
    const v = derive([msf()], form(), { defaultDestination: "IBIS2" });
    expect([v.destination, v.destinationNote, v.destinationOptions]).toEqual([
      "IBIS2",
      null,
      ["IBIS2", "IBIS"],
    ]);
  });

  it("pre-selects AEB with a reason when only an AEB listing exists", () => {
    const v = derive([msf({ exchange: "AEB", localSymbol: "ASML" })], form(), {
      defaultDestination: "IBIS2",
    });
    expect(v.destination).toBe("AEB");
    expect(v.destinationNote).toContain("IBIS2");
    expect(v.destinationOptions).toEqual(["AEB"]);
  });

  it("keeps an explicit choice and shows no note", () => {
    const v = derive([msf()], form({ destination: "IBIS" }), { defaultDestination: "AEB" });
    expect([v.destination, v.destinationNote]).toEqual(["IBIS", null]);
  });

  it("prefers a verified AEB line over an unverified IBIS line and derives the destinations from the shown line", () => {
    const v = derive(
      [
        msf({ status: "unverified", verifiedAt: null }),
        msf({ exchange: "AEB", localSymbol: "MSFA" }),
      ],
      form({ acknowledged: false }),
    );
    expect(v.mode).toBe("verified");
    expect(v.listing?.exchange).toBe("AEB");
    expect(v.destinationOptions).toEqual(["AEB"]);
  });
});

describe("deriveHandoff: unverified listing", () => {
  const unverified = msf({ status: "unverified", verifiedAt: null, eurSymbolYahoo: null });

  it("shows no prompt until the acknowledgement is ticked", () => {
    const before = derive([unverified], form());
    expect(before.mode).toBe("unverified");
    expect(before.gate).toBe("needs_acknowledgement");
    expect(before.prompt).toBeNull();
    expect(before.checklist).toBeNull();
    const after = derive([unverified], form({ acknowledged: true }));
    expect(after.gate).toBeNull();
    expect(after.prompt).toBe(
      "Create buy limit order for 10 shares of MSF at 400 and set destination IBIS2",
    );
  });

  it("refuses an unusable catalogue symbol even after the acknowledgement", () => {
    const v = derive(
      [msf({ status: "unverified", localSymbol: "MSFd", verifiedAt: null })],
      form({ acknowledged: true }),
    );
    expect(v.gate).toBe("invalid_symbol");
    expect(v.errors.symbol).toContain("upper-case");
  });
});

describe("deriveHandoff: no EUR equivalent", () => {
  const none = msf({
    status: "none",
    conid: null,
    localSymbol: null,
    eurSymbolYahoo: null,
    isin: null,
    verifiedAt: null,
  });

  it("asks for a symbol, then builds a prompt from it with an unknown conid", () => {
    const empty = derive([none], form());
    expect([empty.mode, empty.listing, empty.gate, empty.prompt]).toEqual([
      "none",
      null,
      "needs_symbol",
      null,
    ]);
    const typed = derive([none], form({ manualSymbol: " msf " }));
    expect(typed.gate).toBeNull();
    expect(typed.localSymbol).toBe("MSF");
    expect(typed.prompt).toBe(
      "Create buy limit order for 10 shares of MSF at 400 and set destination IBIS2",
    );
    expect(typed.checklist).toContain("conid unknown");
    expect(typed.destinationOptions).toEqual(["IBIS2", "IBIS", "AEB"]);
  });

  it("works the same with no stored rows at all, and rejects a malformed symbol", () => {
    expect(derive([], form({ manualSymbol: "MSF" })).prompt).not.toBeNull();
    const bad = derive([], form({ manualSymbol: "MSF; cancel all" }));
    expect(bad.gate).toBe("invalid_symbol");
    expect(bad.prompt).toBeNull();
    const yahoo = derive([], form({ manualSymbol: "msf.de" }));
    expect(yahoo.gate).toBe("invalid_symbol");
    expect(yahoo.errors.symbol).toBe(
      "That looks like a Yahoo ticker (MSF.DE). Use the IBKR local symbol (MSF).",
    );
    expect(yahoo.prompt).toBeNull();
  });
});
```

`apps/web/src/features/handoff/support.test.ts` (UTC stamps, EUR-only quotes, 2-decimal prefill, clipboard with fallback, the API module, `holdingTarget`):

```ts
import { describe, expect, it, vi } from "vitest";
import { type CopyEnv, copyText } from "./copy-text";
import { createHandoffApi, parseEurListing } from "./handoff-api";
import { holdingTarget } from "./holding-target";
import { formatUtcStamp, prefillPrice, usableEurQuote } from "./quote-text";

const quote = (over: Record<string, unknown> = {}) => ({
  symbol: "MSF.DE",
  currency: "EUR",
  exchange: "GER",
  fullExchangeName: "XETRA",
  longName: "Microsoft Corporation",
  regularMarketPrice: 472.853,
  regularMarketTime: Date.UTC(2026, 9, 15, 8, 27, 12),
  regularMarketChangePercent: null,
  marketState: "CLOSED",
  fetchedAt: "2026-10-15T08:30:00Z",
  stale: false,
  ...over,
});

describe("quote text", () => {
  it("formats times in UTC whatever the browser time zone", () => {
    expect(formatUtcStamp(Date.UTC(2026, 9, 15, 8, 27))).toBe("15 Oct 2026, 08:27 UTC");
    expect(formatUtcStamp(Date.UTC(2027, 0, 5, 23, 5))).toBe("5 Jan 2027, 23:05 UTC");
  });

  it("accepts a EUR quote and rejects every other currency, missing prices and missing times", () => {
    expect(usableEurQuote(quote())).toEqual({
      price: 472.853,
      stamp: "15 Oct 2026, 08:27 UTC",
      stale: false,
    });
    expect(usableEurQuote(quote({ currency: "USD" }))).toBeNull();
    expect(usableEurQuote(quote({ regularMarketPrice: null }))).toBeNull();
    expect(usableEurQuote(quote({ regularMarketPrice: 0 }))).toBeNull();
    expect(usableEurQuote(quote({ regularMarketTime: null }))).toBeNull();
    expect(usableEurQuote(undefined)).toBeNull();
  });

  it("rounds the prefill to 2 decimals", () => {
    expect(prefillPrice(472.853)).toBe("472.85");
    expect(prefillPrice(400)).toBe("400.00");
  });
});

describe("copyText", () => {
  const box = () => {
    const el = document.createElement("textarea");
    el.value = "prompt";
    document.body.append(el);
    return el;
  };

  it("uses the clipboard API when it works", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const env: CopyEnv = { clipboard: { writeText }, execCopy: vi.fn().mockReturnValue(false) };
    expect(await copyText("prompt", box(), env)).toBe("clipboard");
    expect(writeText).toHaveBeenCalledWith("prompt");
    expect(env.execCopy).not.toHaveBeenCalled();
  });

  it("falls back to select-and-copy when the clipboard API rejects or is missing", async () => {
    const el = box();
    const select = vi.spyOn(el, "select");
    const rejecting: CopyEnv = {
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
      execCopy: vi.fn().mockReturnValue(true),
    };
    expect(await copyText("prompt", el, rejecting)).toBe("fallback");
    expect(select).toHaveBeenCalled();
    expect(await copyText("prompt", el, { clipboard: undefined, execCopy: () => true })).toBe(
      "fallback",
    );
  });

  it("reports failure (text stays selected) when nothing works", async () => {
    expect(await copyText("prompt", box(), { clipboard: undefined, execCopy: () => false })).toBe(
      "failed",
    );
    expect(await copyText("prompt", null, { clipboard: undefined, execCopy: () => true })).toBe(
      "failed",
    );
  });
});

describe("handoff api", () => {
  const verified = {
    ibkr_exchange_id: "IBIS",
    status: "verified",
    ibkr_conid: 12178239,
    ibkr_local_symbol: "MSF",
    isin: "US5949181045",
    eur_symbol_yahoo: "MSF.DE",
    verification: { failed: [] },
    verified_at: "2026-10-15T07:30:00Z",
  };

  it("maps a row and drops rows it does not understand", () => {
    expect(parseEurListing(verified)).toEqual({
      exchange: "IBIS",
      status: "verified",
      conid: 12178239,
      localSymbol: "MSF",
      isin: "US5949181045",
      eurSymbolYahoo: "MSF.DE",
      verifiedAt: "2026-10-15T07:30:00Z",
      verification: { failed: [] },
    });
    expect(parseEurListing({ ...verified, ibkr_exchange_id: "FWB" })).toBeNull();
    expect(parseEurListing({ ...verified, status: "maybe" })).toBeNull();
    expect(parseEurListing(null)).toBeNull();
    expect(
      parseEurListing({ ...verified, ibkr_conid: "12178239", verification: null })?.conid,
    ).toBeNull();
  });

  function client(result: { data: unknown; error: { message: string } | null }) {
    const calls: { table: string; select?: string; eq?: [string, unknown]; update?: unknown }[] =
      [];
    const builder = (table: string) => {
      const call: (typeof calls)[number] = { table };
      calls.push(call);
      const chain: Record<string, unknown> = {
        select: (s: string) => {
          call.select = s;
          return chain;
        },
        eq: (c: string, v: unknown) => {
          call.eq = [c, v];
          return Object.assign(Promise.resolve(result), chain);
        },
        update: (u: unknown) => {
          call.update = u;
          return chain;
        },
        maybeSingle: () => Promise.resolve(result),
      };
      return chain;
    };
    return { calls, from: builder } as never as { from: (t: string) => never } & {
      calls: typeof calls;
    };
  }

  it("reads the EUR lines of one security and the own default destination", async () => {
    const c = client({ data: [verified, { ibkr_exchange_id: "XX" }], error: null });
    const api = createHandoffApi(c as never);
    expect((await api.getEurListings("sec-1")).map((l) => l.localSymbol)).toEqual(["MSF"]);
    expect(c.calls[0]).toMatchObject({ table: "eur_equivalents", eq: ["security_id", "sec-1"] });

    const d = createHandoffApi(
      client({ data: { default_destination: "AEB" }, error: null }) as never,
    );
    expect(await d.getDefaultDestination("u1")).toBe("AEB");
    const bad = createHandoffApi(
      client({ data: { default_destination: "SMART" }, error: null }) as never,
    );
    expect(await bad.getDefaultDestination("u1")).toBe("IBIS2");
  });

  it("writes only a valid destination to the own row and surfaces errors in plain words", async () => {
    const c = client({ data: null, error: null });
    const api = createHandoffApi(c as never);
    await api.setDefaultDestination("u1", "IBIS");
    expect(c.calls[0]).toMatchObject({
      table: "profiles",
      update: { default_destination: "IBIS" },
      eq: ["user_id", "u1"],
    });
    await expect(api.setDefaultDestination("u1", "SMART" as never)).rejects.toThrow(
      "Choose IBIS2, IBIS or AEB.",
    );
    const failing = createHandoffApi(client({ data: null, error: { message: "boom" } }) as never);
    await expect(failing.setDefaultDestination("u1", "AEB")).rejects.toThrow(
      "Could not save your default destination.",
    );
    await expect(failing.getEurListings("s")).rejects.toThrow("Could not load the EUR listing.");
  });
});

describe("holdingTarget", () => {
  it("targets the canonical screening security of the company, with no rank", () => {
    expect(
      holdingTarget({
        canonicalSecurityId: "sec-msft",
        canonicalSymbol: "MSFT",
        companyName: "Microsoft Corporation",
        exchangeName: "NasdaqGS",
        currency: "USD",
      }),
    ).toEqual({
      securityId: "sec-msft",
      symbol: "MSFT",
      companyName: "Microsoft Corporation",
      rank: null,
      exchangeName: "NasdaqGS",
      currency: "USD",
    });
    expect(
      holdingTarget({ canonicalSecurityId: "s", canonicalSymbol: "X", companyName: "X Inc." }),
    ).toMatchObject({ exchangeName: null, currency: null });
  });

  it("offers no target for an unmatched position", () => {
    expect(
      holdingTarget({ canonicalSecurityId: null, canonicalSymbol: null, companyName: "Unknown" }),
    ).toBeNull();
    expect(
      holdingTarget({ canonicalSecurityId: "s", canonicalSymbol: null, companyName: "Unknown" }),
    ).toBeNull();
  });
});
```

- [ ] **Step 3: Run; Expected: FAIL**

```powershell
bun run test:web handoff
```
Expected: both files fail with `Failed to resolve import "./derive"` (and the other modules).

- [ ] **Step 4: Implement the pure modules**

`apps/web/src/features/handoff/types.ts`:

```ts
/** What the dialog needs to know about the instrument being traded: the CANONICAL (screening) listing of the company. */
export interface TradeTarget {
  /** `securities.id` of the canonical listing: `eur_equivalents` rows hang off it. */
  securityId: string;
  /** Yahoo symbol of the screening listing, e.g. `MSFT`. */
  symbol: string;
  companyName: string;
  /** Rank at scan time (cards); null for a holding that is not in today's list. */
  rank: number | null;
  exchangeName: string | null;
  currency: string | null;
}
```

`apps/web/src/features/handoff/derive.ts`:

```ts
import {
  allowedDestinations,
  buildDocumentedStylePrompt,
  buildIbotPrompt,
  chooseDestination,
  type Destination,
  type Estimate,
  type EurListing,
  estimateValue,
  localSymbolProblem,
  type OrderType,
  parsePriceInput,
  parseQuantityInput,
  pickListing,
  type Side,
  ticketChecklist,
} from "@core/handoff.ts";

/** Everything the hand-off dialog shows is derived here from plain inputs, so the rules (spec 13.1-13.4) are testable without React. */

export interface FormState {
  side: Side;
  orderType: OrderType;
  quantityText: string;
  priceText: string;
  /** null until the user touches the selector: the profile default then applies and may be adjusted with a reason (spec 13.3). */
  destination: Destination | null;
  acknowledged: boolean;
  manualSymbol: string;
}

export const INITIAL_FORM: FormState = {
  side: "buy",
  orderType: "limit",
  quantityText: "",
  priceText: "",
  destination: null,
  acknowledged: false,
  manualSymbol: "",
};

export type ListingMode = "verified" | "unverified" | "none";
export type Gate =
  | "needs_acknowledgement"
  | "needs_symbol"
  | "invalid_symbol"
  | "needs_quantity"
  | "needs_price";

export interface HandoffView {
  mode: ListingMode;
  /** The EUR line shown (best of the stored rows); null on the `none` path. */
  listing: EurListing | null;
  localSymbol: string | null;
  conid: number | null;
  destination: Destination;
  destinationOptions: Destination[];
  destinationNote: string | null;
  /** Why no prompt is shown yet; null when the prompt is ready. */
  gate: Gate | null;
  errors: { quantity: string | null; price: string | null; symbol: string | null };
  prompt: string | null;
  documented: { prompt: string; ticketNote: string } | null;
  estimate: Estimate;
  checklist: string | null;
}

export interface DeriveInput {
  listings: readonly EurListing[];
  form: FormState;
  defaultDestination: Destination;
  /** The verified EUR delayed quote, if any: only used to estimate a market order. */
  referencePrice: number | null;
}

export function deriveHandoff(input: DeriveInput): HandoffView {
  const { form } = input;
  const best = pickListing(input.listings);
  const listing = best !== null && best.status !== "none" ? best : null;
  const mode: ListingMode =
    listing === null ? "none" : listing.status === "verified" ? "verified" : "unverified";

  // destination (13.3): only venues that list the shown instrument; the default is adjusted with a reason, an explicit choice is kept
  const exchanges = listing === null ? [] : [listing.exchange];
  const options = allowedDestinations(exchanges);
  const wanted = form.destination ?? input.defaultDestination;
  const adjusted = chooseDestination(wanted, exchanges);
  const destination = options.includes(wanted) ? wanted : adjusted.destination;
  const destinationNote = form.destination === null && adjusted.adjusted ? adjusted.reason : null;

  // local symbol: from the catalogue row, or typed by the user on the `none` path (clearly unverified)
  const manual = form.manualSymbol.trim().toUpperCase();
  const localSymbol = listing !== null ? listing.localSymbol : manual === "" ? null : manual;
  const conid = listing !== null ? listing.conid : null;

  const qty = parseQuantityInput(form.quantityText);
  const price = parsePriceInput(form.priceText);
  const errors = {
    quantity: form.quantityText.trim() === "" || qty.ok ? null : qty.message,
    price:
      form.orderType === "market" || form.priceText.trim() === "" || price.ok
        ? null
        : price.message,
    symbol: null as string | null,
  };

  let gate: Gate | null = null;
  if (mode === "unverified" && !form.acknowledged) gate = "needs_acknowledgement";
  else if (localSymbol === null) gate = "needs_symbol";
  else if (localSymbolProblem(localSymbol) !== null) {
    gate = "invalid_symbol";
    errors.symbol = localSymbolProblem(localSymbol);
  } else if (!qty.ok) gate = "needs_quantity";
  else if (form.orderType === "limit" && !price.ok) gate = "needs_price";

  let prompt: string | null = null;
  let documented: HandoffView["documented"] = null;
  if (gate === null && localSymbol !== null && qty.ok) {
    const ibot = {
      side: form.side,
      orderType: form.orderType,
      quantity: qty.value,
      localSymbol,
      price: price.ok ? price.value : undefined,
      destination,
    };
    const built = buildIbotPrompt(ibot);
    if (built.ok) prompt = built.prompt;
    const doc = buildDocumentedStylePrompt(ibot);
    if (doc.ok) documented = { prompt: doc.prompt, ticketNote: doc.ticketNote };
  }

  return {
    mode,
    listing,
    localSymbol,
    conid,
    destination,
    destinationOptions: options,
    destinationNote,
    gate,
    errors,
    prompt,
    documented,
    estimate: estimateValue({
      orderType: form.orderType,
      quantity: qty.ok ? qty.value : 0,
      price: price.ok ? price.value : undefined,
      referencePrice: input.referencePrice,
    }),
    checklist:
      prompt !== null && localSymbol !== null
        ? ticketChecklist({ conid, localSymbol, destination })
        : null,
  };
}
```

`apps/web/src/features/handoff/quote-text.ts`:

```ts
import type { QuoteDto } from "@/features/screening/quotes-api";

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;
const two = (n: number): string => String(n).padStart(2, "0");

/** "15 Oct 2026, 08:27 UTC": the modal states times in UTC (spec 13.1), independent of the browser's time zone. */
export function formatUtcStamp(epochMs: number): string {
  const d = new Date(epochMs);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${two(d.getUTCHours())}:${two(d.getUTCMinutes())} UTC`;
}

export interface EurQuote {
  price: number;
  stamp: string;
  stale: boolean;
}

/** Only a finite positive EUR price with a timestamp is usable. A quote in any other currency is never shown or used as a prefill. */
export function usableEurQuote(q: QuoteDto | undefined): EurQuote | null {
  if (q === undefined || q.currency !== "EUR") return null;
  const price = q.regularMarketPrice;
  const time = q.regularMarketTime;
  if (
    price === null ||
    !Number.isFinite(price) ||
    price <= 0 ||
    time === null ||
    !Number.isFinite(time)
  )
    return null;
  return { price, stamp: formatUtcStamp(time), stale: q.stale };
}

/** The limit price prefill: the delayed quote rounded to 2 decimals. */
export function prefillPrice(price: number): string {
  return price.toFixed(2);
}
```

`apps/web/src/features/handoff/copy-text.ts`:

```ts
export type CopyOutcome = "clipboard" | "fallback" | "failed";

export interface CopyEnv {
  clipboard: { writeText(text: string): Promise<void> } | undefined;
  /** document.execCommand("copy"): the select-text fallback for browsers or contexts without the async clipboard API. */
  execCopy: () => boolean;
}

export function browserCopyEnv(): CopyEnv {
  return {
    clipboard: typeof navigator !== "undefined" ? navigator.clipboard : undefined,
    execCopy: () => {
      try {
        return document.execCommand("copy");
      } catch {
        return false;
      }
    },
  };
}

/**
 * Copies `text`. Uses the clipboard API when it works; otherwise selects the read-only prompt box and tries execCommand. When both fail
 * the text stays selected so the user can press Ctrl+C (spec 13.1: "clipboard API with select-text fallback").
 */
export async function copyText(
  text: string,
  box: HTMLTextAreaElement | null,
  env: CopyEnv = browserCopyEnv(),
): Promise<CopyOutcome> {
  if (env.clipboard !== undefined) {
    try {
      await env.clipboard.writeText(text);
      return "clipboard";
    } catch {
      // fall through to the select-text fallback (insecure context, permission denied)
    }
  }
  if (box === null) return "failed";
  box.focus();
  box.select();
  return env.execCopy() ? "fallback" : "failed";
}
```

`apps/web/src/features/handoff/holding-target.ts`:

```ts
import type { TradeTarget } from "./types";

export interface HoldingRef {
  /** `securities.id` of the company's canonical (screening) listing: where `eur_equivalents` rows hang. */
  canonicalSecurityId: string | null;
  canonicalSymbol: string | null;
  companyName: string;
  exchangeName?: string | null | undefined;
  currency?: string | null | undefined;
}

/**
 * The hand-off target of a held position. It is always the company's canonical listing, never the held line itself (a holding may be
 * MSF.DE; the EUR equivalent is resolved for MSFT). An unmatched position has no canonical security: no target, so no trade button.
 */
export function holdingTarget(h: HoldingRef): TradeTarget | null {
  if (h.canonicalSecurityId === null || h.canonicalSymbol === null) return null;
  return {
    securityId: h.canonicalSecurityId,
    symbol: h.canonicalSymbol,
    companyName: h.companyName,
    rank: null,
    exchangeName: h.exchangeName ?? null,
    currency: h.currency ?? null,
  };
}
```

`apps/web/src/features/handoff/handoff-api.ts`:

```ts
import {
  DEFAULT_DESTINATION,
  type Destination,
  type EurExchange,
  type EurListing,
  type EurStatus,
  isDestination,
} from "@core/handoff.ts";
import type { SupabaseClient } from "@supabase/supabase-js";

const COLUMNS =
  "ibkr_exchange_id, status, ibkr_conid, ibkr_local_symbol, isin, eur_symbol_yahoo, verification, verified_at";

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

/** One `eur_equivalents` row (public read, RLS `using (true)`) to the core type; anything unexpected is dropped, never guessed. */
export function parseEurListing(raw: unknown): EurListing | null {
  if (!isRecord(raw)) return null;
  const exchange = raw["ibkr_exchange_id"];
  const status = raw["status"];
  if (exchange !== "IBIS" && exchange !== "AEB") return null;
  if (status !== "verified" && status !== "unverified" && status !== "none") return null;
  const conid = raw["ibkr_conid"];
  return {
    exchange: exchange as EurExchange,
    status: status as EurStatus,
    conid: typeof conid === "number" && Number.isSafeInteger(conid) ? conid : null,
    localSymbol: str(raw["ibkr_local_symbol"]),
    isin: str(raw["isin"]),
    eurSymbolYahoo: str(raw["eur_symbol_yahoo"]),
    verifiedAt: str(raw["verified_at"]),
    verification: isRecord(raw["verification"]) ? raw["verification"] : {},
  };
}

/** Reads and writes for the hand-off, through the anon-key client (RLS decides): EUR lines are public, the destination is the caller's own row. */
export function createHandoffApi(client: Pick<SupabaseClient, "from">) {
  return {
    async getEurListings(securityId: string): Promise<EurListing[]> {
      const { data, error } = await client
        .from("eur_equivalents")
        .select(COLUMNS)
        .eq("security_id", securityId);
      if (error) throw new Error("Could not load the EUR listing.");
      return (data ?? []).map(parseEurListing).filter((l): l is EurListing => l !== null);
    },

    async getDefaultDestination(userId: string): Promise<Destination> {
      const { data, error } = await client
        .from("profiles")
        .select("default_destination")
        .eq("user_id", userId)
        .maybeSingle();
      if (error) throw new Error("Could not load your default destination.");
      const value = (data as { default_destination?: unknown } | null)?.default_destination;
      return isDestination(value) ? value : DEFAULT_DESTINATION;
    },

    async setDefaultDestination(userId: string, destination: Destination): Promise<void> {
      if (!isDestination(destination)) throw new Error("Choose IBIS2, IBIS or AEB.");
      const { error } = await client
        .from("profiles")
        .update({ default_destination: destination })
        .eq("user_id", userId);
      if (error) throw new Error("Could not save your default destination.");
    },
  };
}

export type HandoffApi = ReturnType<typeof createHandoffApi>;
```

`apps/web/src/features/handoff/default.ts`:

```ts
import { supabase } from "@/lib/supabase";
import { createHandoffApi } from "./handoff-api";

/** The real instance. Component tests replace this module with `handoffApiMock` (see src/test/handoff-default-mock.ts). */
export const handoffApi = createHandoffApi(supabase);
```

`apps/web/src/features/handoff/hooks.ts`:

```ts
import type { Destination } from "@core/handoff.ts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/features/auth/auth-provider";
import { handoffApi } from "./default";

export const eurListingsKey = (securityId: string) => ["eur-listings", securityId] as const;
export const defaultDestinationKey = (userId: string | null) =>
  ["default-destination", userId] as const;

/** EUR lines of one canonical security (public data, cached 5 minutes). */
export function useEurListings(securityId: string | null) {
  return useQuery({
    queryKey: eurListingsKey(securityId ?? "none"),
    queryFn: () => handoffApi.getEurListings(securityId as string),
    enabled: securityId !== null,
    staleTime: 5 * 60_000,
  });
}

/** The signed-in user's own preference. `gcTime: 0`: the value is dropped from memory as soon as nothing displays it. */
export function useDefaultDestination() {
  const { user } = useAuth();
  const userId = user?.id ?? null;
  return useQuery({
    queryKey: defaultDestinationKey(userId),
    queryFn: () => handoffApi.getDefaultDestination(userId as string),
    enabled: userId !== null,
    staleTime: 0,
    gcTime: 0,
  });
}

export function useSaveDefaultDestination() {
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const client = useQueryClient();
  return useMutation({
    mutationFn: (destination: Destination) => {
      if (userId === null) throw new Error("Sign in to save your default destination.");
      return handoffApi.setDefaultDestination(userId, destination);
    },
    onSuccess: (_void, destination) => {
      client.setQueryData(defaultDestinationKey(userId), destination);
    },
  });
}
```

`apps/web/src/features/handoff/use-cooldown.ts`:

```ts
import { useCallback, useEffect, useRef, useState } from "react";

/** A one-shot cooldown in whole seconds: `start()` begins it, `remaining` counts down to 0 (used for the 10 s quote refresh limit, spec 13.1). */
export function useCooldown(seconds: number): { remaining: number; start: () => void } {
  const [remaining, setRemaining] = useState(0);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const stop = useCallback(() => {
    if (timer.current !== null) {
      clearInterval(timer.current);
      timer.current = null;
    }
  }, []);

  const start = useCallback(() => {
    stop();
    setRemaining(seconds);
    timer.current = setInterval(() => {
      setRemaining((r) => {
        if (r <= 1) {
          stop();
          return 0;
        }
        return r - 1;
      });
    }, 1000);
  }, [seconds, stop]);

  useEffect(() => stop, [stop]);
  return { remaining, start };
}
```

- [ ] **Step 5: Run; Expected: PASS**

```powershell
bun run test:web handoff
```
Expected: `derive.test.ts` (12 tests) and `support.test.ts` (11 tests) pass.

- [ ] **Step 6: Write the failing component tests**

Each file mocks the three seams with `vi.hoisted` and `vi.mock`, so it does not depend on the global setup mock of step 10.

`apps/web/src/features/handoff/trade-on-ibkr-dialog.test.tsx` (18 tests: the owner's example, checklist and link; the UTC delayed quote and prefill; non-EUR quote ignored; refresh cooldown; market order and sell; decimal comma; Copy; destination default, AEB fallback with a reason, IBIS2 label; unverified acknowledgement gating and no quote for an unverified line; the none path with a manual unverified symbol; the notice in loading, error and every status; no submit control):

```tsx
import { NO_ORDER_NOTICE } from "@core/handoff.ts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TradeOnIbkrDialog } from "./trade-on-ibkr-dialog";
import type { TradeTarget } from "./types";

const mocks = vi.hoisted(() => ({
  handoffApi: {
    getEurListings: vi.fn(),
    getDefaultDestination: vi.fn(),
    setDefaultDestination: vi.fn(),
  },
  auth: { useAuth: vi.fn() },
  quotes: { useQuotes: vi.fn() },
}));
vi.mock("@/features/handoff/default", () => ({ handoffApi: mocks.handoffApi }));
vi.mock("@/features/auth/auth-provider", () => mocks.auth);
vi.mock("@/features/screening/quotes-hooks", () => mocks.quotes);

const TARGET: TradeTarget = {
  securityId: "sec-msft",
  symbol: "MSFT",
  companyName: "Microsoft Corporation",
  rank: 53,
  exchangeName: "NasdaqGS",
  currency: "USD",
};

const row = (over: Record<string, unknown> = {}) => ({
  exchange: "IBIS" as const,
  status: "verified" as const,
  conid: 12178239,
  localSymbol: "MSF",
  isin: "US5949181045",
  eurSymbolYahoo: "MSF.DE",
  verifiedAt: "2026-10-15T07:30:00Z",
  verification: {
    method: "automatic",
    failed: [],
    checks: { isin_confirmed: "pass", price_within_tolerance: "pass" },
  },
  ...over,
});
const eurQuote = (over: Record<string, unknown> = {}) => ({
  symbol: "MSF.DE",
  currency: "EUR",
  exchange: "GER",
  fullExchangeName: "XETRA",
  longName: "Microsoft Corporation",
  regularMarketPrice: 472.853,
  regularMarketTime: Date.UTC(2026, 9, 15, 8, 27),
  regularMarketChangePercent: null,
  marketState: "CLOSED",
  fetchedAt: "2026-10-15T08:30:00Z",
  stale: false,
  ...over,
});

const refetch = vi.fn();
function setup(
  opts: {
    listings?: unknown[] | "loading" | "error";
    destination?: string | null;
    quote?: unknown | null;
  } = {},
) {
  const listings = opts.listings ?? [row()];
  if (listings === "loading")
    mocks.handoffApi.getEurListings.mockReturnValue(new Promise(() => {}));
  else if (listings === "error")
    mocks.handoffApi.getEurListings.mockRejectedValue(new Error("boom"));
  else mocks.handoffApi.getEurListings.mockResolvedValue(listings);
  mocks.handoffApi.getDefaultDestination.mockResolvedValue(
    opts.destination === undefined ? "IBIS2" : opts.destination,
  );
  mocks.auth.useAuth.mockReturnValue({ status: "signed-in", user: { id: "u1" }, recovery: false });
  const quote = opts.quote === undefined ? eurQuote() : opts.quote;
  mocks.quotes.useQuotes.mockImplementation((symbols: readonly string[]) => ({
    data: symbols.length > 0 && quote !== null ? [quote] : undefined,
    isLoading: false,
    isError: false,
    isFetching: false,
    refetch,
  }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <TradeOnIbkrDialog open onOpenChange={() => {}} target={TARGET} />
    </QueryClientProvider>,
  );
}

const badge = (status: string) =>
  waitFor(() =>
    expect(screen.getByTestId("listing-badge").getAttribute("data-status")).toBe(status),
  );
const type = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
const prompt = (): string => (screen.getByTestId("ibot-prompt") as HTMLTextAreaElement).value;

beforeEach(() => {
  vi.clearAllMocks();
  refetch.mockResolvedValue(undefined);
});
afterEach(() => cleanup());

describe("verified listing", () => {
  it("builds the owner's example prompt, with the checklist and the login link", async () => {
    setup();
    await badge("verified");
    expect(screen.getByText("MSF")).toBeTruthy();
    expect(screen.getByText("12178239")).toBeTruthy();
    type("Quantity (shares)", "10");
    type("Limit price (EUR)", "400");
    expect(prompt()).toBe(
      "Create buy limit order for 10 shares of MSF at 400 and set destination IBIS2",
    );
    expect(screen.getByTestId("ticket-checklist").textContent).toBe(
      "On the ticket confirm: conid 12178239 / MSF / EUR / destination IBIS2",
    );
    expect(screen.getByTestId("documented-prompt").textContent).toBe(
      "Buy 10 shares of MSF at 400 limit",
    );
    const link = screen.getByTestId("open-ibkr") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("https://www.interactivebrokers.com/sso/Login");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toContain("noopener");
    expect(screen.getByTestId("estimate").textContent).toContain(
      "Estimate before fees: 4,000.00 EUR",
    );
  });

  it("shows the delayed Yahoo quote with its UTC timestamp, never as live, and prefills the limit price rounded to 2 decimals", async () => {
    setup();
    await badge("verified");
    const block = screen.getByTestId("quote-block").textContent ?? "";
    expect(block).toContain(
      "Delayed quote (Yahoo): 472.85 EUR as of 15 Oct 2026, 08:27 UTC, 15 minutes or more delayed, not an IBKR price",
    );
    expect(block.toLowerCase()).not.toContain("live");
    await waitFor(() =>
      expect((screen.getByLabelText("Limit price (EUR)") as HTMLInputElement).value).toBe("472.85"),
    );
    expect(screen.getByText("Prefilled from the delayed quote: edit before use.")).toBeTruthy();
    // typing a price takes over for good: a later quote does not overwrite it
    type("Limit price (EUR)", "400");
    expect((screen.getByLabelText("Limit price (EUR)") as HTMLInputElement).value).toBe("400");
    expect(screen.queryByText("Prefilled from the delayed quote: edit before use.")).toBeNull();
  });

  it("does not use a quote that is not in EUR", async () => {
    setup({ quote: eurQuote({ currency: "USD" }) });
    await badge("verified");
    expect(screen.getByText("Quote unavailable")).toBeTruthy();
    expect((screen.getByLabelText("Limit price (EUR)") as HTMLInputElement).value).toBe("");
  });

  it("limits the quote refresh with a 10 second cooldown", async () => {
    setup();
    await badge("verified");
    const button = screen.getByRole("button", { name: "Refresh quote" }) as HTMLButtonElement;
    fireEvent.click(button);
    expect(refetch).toHaveBeenCalledTimes(1);
    expect(
      (screen.getByRole("button", { name: "Refresh quote (10 s)" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("omits the price for a market order and works for a sell", async () => {
    setup();
    await badge("verified");
    fireEvent.click(screen.getByRole("button", { name: "Sell" }));
    fireEvent.click(screen.getByRole("button", { name: "Market" }));
    type("Quantity (shares)", "3");
    expect(screen.queryByLabelText("Limit price (EUR)")).toBeNull();
    expect(prompt()).toBe("Create sell market order for 3 shares of MSF and set destination IBIS2");
  });

  it("rejects a decimal comma with an explanation instead of guessing, and shows no prompt", async () => {
    setup();
    await badge("verified");
    type("Quantity (shares)", "10");
    type("Limit price (EUR)", "472,85");
    expect(screen.queryByTestId("ibot-prompt")).toBeNull();
    expect(screen.getByRole("alert", { name: "" }).textContent).toContain("dot");
    expect(screen.getByTestId("prompt-gate").textContent).toBe(
      "Enter a limit price to show the prompt.",
    );
  });

  it("copies the prompt with the clipboard API and says so", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    setup();
    await badge("verified");
    type("Quantity (shares)", "10");
    type("Limit price (EUR)", "400");
    await act(async () => {
      fireEvent.click(screen.getByTestId("copy-prompt"));
    });
    expect(writeText).toHaveBeenCalledWith(
      "Create buy limit order for 10 shares of MSF at 400 and set destination IBIS2",
    );
    expect(screen.getByTestId("copy-prompt").textContent).toBe("Copied");
  });
});

describe("destination (spec 13.3)", () => {
  it("pre-selects the profile default when it applies to the listing", async () => {
    setup({ destination: "IBIS" });
    await badge("verified");
    await waitFor(() =>
      expect((screen.getByLabelText("Destination") as HTMLSelectElement).value).toBe("IBIS"),
    );
    expect(screen.queryByTestId("destination-note")).toBeNull();
  });

  it("falls back to IBIS2 for a signed-in user without a stored value", async () => {
    setup({ destination: null });
    await badge("verified");
    expect((screen.getByLabelText("Destination") as HTMLSelectElement).value).toBe("IBIS2");
  });

  it("pre-selects AEB and says why when only an AEB listing exists", async () => {
    setup({
      listings: [
        row({ exchange: "AEB", localSymbol: "ASML", conid: 117589399, eurSymbolYahoo: "ASML.AS" }),
      ],
      destination: "IBIS2",
    });
    await badge("verified");
    await waitFor(() =>
      expect((screen.getByLabelText("Destination") as HTMLSelectElement).value).toBe("AEB"),
    );
    expect(screen.getByTestId("destination-note").textContent).toContain("IBIS2");
    expect(
      Array.from((screen.getByLabelText("Destination") as HTMLSelectElement).options).map(
        (o) => o.value,
      ),
    ).toEqual(["AEB"]);
  });

  it("labels IBIS2 as the owner's practice, not an IBKR catalogue code", async () => {
    setup();
    await badge("verified");
    const options = Array.from(
      (screen.getByLabelText("Destination") as HTMLSelectElement).options,
    ).map((o) => o.textContent);
    expect(options).toEqual([
      "IBIS2 — Xetra (IBIS2 — owner practice, not in IBKR's public catalogue)",
      "IBIS — Xetra",
    ]);
  });
});

describe("unverified listing (A-28)", () => {
  const unverified = row({
    status: "unverified",
    verifiedAt: null,
    eurSymbolYahoo: "MSF.DE",
    verification: {
      method: "automatic",
      failed: ["price_within_tolerance"],
      checks: { isin_confirmed: "pass", price_within_tolerance: "fail" },
    },
  });

  it("shows no prompt until the acknowledgement is ticked, then shows it", async () => {
    setup({ listings: [unverified] });
    await badge("unverified");
    expect(screen.getByRole("alert").textContent).toContain(
      "could not be fully verified: EUR price within 1% of the screening listing",
    );
    type("Quantity (shares)", "10");
    type("Limit price (EUR)", "400");
    expect(screen.queryByTestId("ibot-prompt")).toBeNull();
    expect(screen.getByTestId("prompt-gate").textContent).toBe(
      "Tick the box above to show the prompt.",
    );
    fireEvent.click(screen.getByLabelText("I have checked this is the same share"));
    expect(prompt()).toBe(
      "Create buy limit order for 10 shares of MSF at 400 and set destination IBIS2",
    );
    fireEvent.click(screen.getByLabelText("I have checked this is the same share"));
    expect(screen.queryByTestId("ibot-prompt")).toBeNull();
  });

  it("never requests or shows a quote for an unverified line, so a look-alike cannot feed a price", async () => {
    setup({ listings: [unverified] });
    await badge("unverified");
    expect(screen.queryByTestId("quote-block")).toBeNull();
    expect(mocks.quotes.useQuotes).toHaveBeenLastCalledWith([]);
    expect((screen.getByLabelText("Limit price (EUR)") as HTMLInputElement).value).toBe("");
  });
});

describe("no EUR equivalent", () => {
  it("says so, offers a clearly unverified manual symbol and builds the prompt from it", async () => {
    setup({ listings: [] });
    await screen.findByText("No verified EUR equivalent");
    expect(screen.getByText("None")).toBeTruthy();
    expect(screen.getByText("Unverified symbol.")).toBeTruthy();
    expect(screen.queryByTestId("quote-block")).toBeNull();
    type("Quantity (shares)", "10");
    type("Limit price (EUR)", "400");
    expect(screen.getByTestId("prompt-gate").textContent).toBe(
      "Enter the IBKR local symbol to show the prompt.",
    );
    type("IBKR local symbol (unverified)", "msf");
    expect(prompt()).toBe(
      "Create buy limit order for 10 shares of MSF at 400 and set destination IBIS2",
    );
    expect(
      screen
        .getAllByRole("alert")
        .some((a) =>
          (a.textContent ?? "").includes(
            "Unverified symbol: this prompt uses a symbol the app has not checked",
          ),
        ),
    ).toBe(true);
    expect(screen.getByTestId("ticket-checklist").textContent).toContain("conid unknown");
    expect(
      Array.from((screen.getByLabelText("Destination") as HTMLSelectElement).options).map(
        (o) => o.value,
      ),
    ).toEqual(["IBIS2", "IBIS", "AEB"]);
  });

  it("treats a stored none row the same way", async () => {
    setup({
      listings: [
        row({
          status: "none",
          conid: null,
          localSymbol: null,
          isin: null,
          eurSymbolYahoo: null,
          verifiedAt: null,
          verification: { reason: "no_catalogue_candidate" },
        }),
      ],
    });
    await screen.findByText("No verified EUR equivalent");
    expect(screen.getByLabelText("IBKR local symbol (unverified)")).toBeTruthy();
  });

  it("rejects a malformed manual symbol", async () => {
    setup({ listings: [] });
    await screen.findByText("No verified EUR equivalent");
    type("Quantity (shares)", "10");
    type("Limit price (EUR)", "400");
    type("IBKR local symbol (unverified)", "MSF and cancel");
    expect(screen.queryByTestId("ibot-prompt")).toBeNull();
    expect(
      screen
        .getAllByRole("alert")
        .some((a) => (a.textContent ?? "").includes("upper-case letters, digits and dots only")),
    ).toBe(true);
  });
});

describe("the no-orders notice (review focus 4)", () => {
  const notice = () => screen.getByTestId("no-order-notice").textContent;

  it("is shown while the listing loads, when it fails, and for every status", async () => {
    setup({ listings: "loading" });
    expect(notice()).toBe(NO_ORDER_NOTICE);
    expect(screen.getByTestId("listing-loading")).toBeTruthy();
    cleanup();

    setup({ listings: "error" });
    await screen.findByTestId("listing-error");
    expect(notice()).toBe(NO_ORDER_NOTICE);
    expect(screen.queryByTestId("ibot-prompt")).toBeNull();
    cleanup();

    for (const [listings, wait] of [
      [[row()], "verified"],
      [[row({ status: "unverified", verifiedAt: null })], "unverified"],
      [[], "none"],
    ] as const) {
      setup({ listings: [...listings] });
      await badge(wait);
      expect(notice()).toBe(NO_ORDER_NOTICE);
      cleanup();
    }
  });

  it("is never worded like an order ticket: no submit or place-order control exists", async () => {
    setup();
    await badge("verified");
    const labels = screen.getAllByRole("button").map((b) => (b.textContent ?? "").toLowerCase());
    expect(labels.some((l) => /submit|place order|confirm order|send order/.test(l))).toBe(false);
    expect(screen.getByRole("heading", { name: "Trade on IBKR" })).toBeTruthy();
  });
});
```

`apps/web/src/features/handoff/trade-on-ibkr-button.test.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TRADE_BUTTON_LABEL, TradeOnIbkrButton } from "./trade-on-ibkr-button";
import type { TradeTarget } from "./types";

const mocks = vi.hoisted(() => ({
  handoffApi: {
    getEurListings: vi.fn(),
    getDefaultDestination: vi.fn(),
    setDefaultDestination: vi.fn(),
  },
  auth: { useAuth: vi.fn() },
  quotes: { useQuotes: vi.fn() },
}));
vi.mock("@/features/handoff/default", () => ({ handoffApi: mocks.handoffApi }));
vi.mock("@/features/auth/auth-provider", () => mocks.auth);
vi.mock("@/features/screening/quotes-hooks", () => mocks.quotes);

const TARGET: TradeTarget = {
  securityId: "sec-msft",
  symbol: "MSFT",
  companyName: "Microsoft Corporation",
  rank: 53,
  exchangeName: "NasdaqGS",
  currency: "USD",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.handoffApi.getEurListings.mockResolvedValue([]);
  mocks.handoffApi.getDefaultDestination.mockResolvedValue("IBIS2");
  mocks.auth.useAuth.mockReturnValue({ status: "signed-in", user: { id: "u1" }, recovery: false });
  mocks.quotes.useQuotes.mockReturnValue({
    data: undefined,
    isLoading: false,
    isError: false,
    isFetching: false,
    refetch: vi.fn(),
  });
});
afterEach(() => cleanup());

describe("TradeOnIbkrButton", () => {
  const renderButton = () =>
    render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <TradeOnIbkrButton target={TARGET} />
      </QueryClientProvider>,
    );

  it("is labelled Trade on IBKR (never Submit Order) and loads nothing until it is clicked", () => {
    renderButton();
    expect(TRADE_BUTTON_LABEL).toBe("Trade on IBKR");
    expect(screen.getByRole("button", { name: "Trade on IBKR" })).toBeTruthy();
    expect(mocks.handoffApi.getEurListings).not.toHaveBeenCalled();
    expect(mocks.handoffApi.getDefaultDestination).not.toHaveBeenCalled();
  });

  it("opens the hand-off dialog for the target on click and closes it again", async () => {
    renderButton();
    fireEvent.click(screen.getByRole("button", { name: "Trade on IBKR" }));
    expect(await screen.findByTestId("trade-dialog")).toBeTruthy();
    expect(screen.getByText("#53 MSFT — Microsoft Corporation")).toBeTruthy();
    expect(mocks.handoffApi.getEurListings).toHaveBeenCalledWith("sec-msft");
    fireEvent.keyDown(screen.getByTestId("trade-dialog"), { key: "Escape" });
    await vi.waitFor(() => expect(screen.queryByTestId("trade-dialog")).toBeNull());
  });
});
```

`apps/web/src/features/handoff/default-destination-card.test.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DefaultDestinationCard } from "./default-destination-card";

const mocks = vi.hoisted(() => ({
  handoffApi: {
    getEurListings: vi.fn(),
    getDefaultDestination: vi.fn(),
    setDefaultDestination: vi.fn(),
  },
  auth: { useAuth: vi.fn() },
}));
vi.mock("@/features/handoff/default", () => ({ handoffApi: mocks.handoffApi }));
vi.mock("@/features/auth/auth-provider", () => mocks.auth);

const renderCard = () =>
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <DefaultDestinationCard />
    </QueryClientProvider>,
  );

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.useAuth.mockReturnValue({ status: "signed-in", user: { id: "u1" }, recovery: false });
  mocks.handoffApi.getDefaultDestination.mockResolvedValue("IBIS2");
  mocks.handoffApi.setDefaultDestination.mockResolvedValue(undefined);
});
afterEach(() => cleanup());

describe("DefaultDestinationCard (Profile > Broker)", () => {
  it("shows the stored default and offers the three destinations with their labels", async () => {
    mocks.handoffApi.getDefaultDestination.mockResolvedValue("AEB");
    renderCard();
    const select = (await screen.findByLabelText("Default destination")) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe("AEB"));
    expect(Array.from(select.options).map((o) => o.value)).toEqual(["IBIS2", "IBIS", "AEB"]);
    expect(select.options[0]?.textContent).toContain(
      "owner practice, not in IBKR's public catalogue",
    );
    expect(mocks.handoffApi.getDefaultDestination).toHaveBeenCalledWith("u1");
  });

  it("saves a change to the signed-in user's own row and confirms it", async () => {
    renderCard();
    const select = (await screen.findByLabelText("Default destination")) as HTMLSelectElement;
    await waitFor(() => expect(select.disabled).toBe(false));
    fireEvent.change(select, { target: { value: "IBIS" } });
    await waitFor(() =>
      expect(mocks.handoffApi.setDefaultDestination).toHaveBeenCalledWith("u1", "IBIS"),
    );
    expect(await screen.findByText("Saved")).toBeTruthy();
    expect(select.value).toBe("IBIS");
  });

  it("says so when saving fails", async () => {
    mocks.handoffApi.setDefaultDestination.mockRejectedValue(new Error("nope"));
    renderCard();
    const select = (await screen.findByLabelText("Default destination")) as HTMLSelectElement;
    await waitFor(() => expect(select.disabled).toBe(false));
    fireEvent.change(select, { target: { value: "AEB" } });
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Could not save your default destination.",
    );
  });
});
```

`apps/web/src/features/handoff/no-leaks.test.ts` (static guard over the non-test sources of the feature: no `console.`, browser storage, beacons or cookies; only `handoff-api.ts` and `default.ts` touch the backend; `derive.ts` never reads a Yahoo symbol; no submit-order wording):

```ts
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Nothing typed or generated in the hand-off (side, quantity, price, symbol, prompt) may be logged, stored in the browser or sent anywhere
 * except the two reads and the one own-row write in handoff-api.ts and the existing quotes call. A static guard, because a stray
 * console.log of the prompt would pass every behavioural test.
 */
const dir = import.meta.dirname;
const sources = readdirSync(dir)
  .filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\.(ts|tsx)$/.test(f))
  .map((f) => ({ file: f, text: readFileSync(join(dir, f), "utf8") }));

describe("hand-off source files", () => {
  it("found the feature files", () => {
    expect(sources.map((s) => s.file)).toContain("trade-on-ibkr-dialog.tsx");
    expect(sources.map((s) => s.file)).toContain("derive.ts");
  });

  it("never log, persist or beacon anything", () => {
    for (const { file, text } of sources) {
      for (const forbidden of [
        /\bconsole\./,
        /\blocalStorage\b/,
        /\bsessionStorage\b/,
        /\bindexedDB\b/,
        /\bsendBeacon\b/,
        /\bdocument\.cookie\b/,
      ]) {
        expect(text, `${file} must not use ${forbidden}`).not.toMatch(forbidden);
      }
    }
  });

  it("only handoff-api.ts (and default.ts, which creates the client) talk to the backend", () => {
    for (const { file, text } of sources) {
      if (file === "handoff-api.ts" || file === "default.ts") continue;
      expect(text, `${file} must not call fetch or the supabase client directly`).not.toMatch(
        /\bfetch\(|\.from\(|supabase\b/,
      );
    }
  });

  it("builds prompts from the IBKR local symbol only: derive.ts never reads the Yahoo symbol (review focus 2)", () => {
    const derive = sources.find((s) => s.file === "derive.ts");
    expect(derive?.text).toBeDefined();
    expect(derive?.text).not.toMatch(/eurSymbolYahoo|yahoo_symbol|yahooSymbol/);
  });

  it("never builds an order-submission control", () => {
    for (const { file, text } of sources) {
      expect(text.toLowerCase(), `${file} must not mention submitting an order`).not.toMatch(
        /submit order|place order|placeorder|submitorder/,
      );
    }
  });
});
```

- [ ] **Step 7: Run; Expected: FAIL**

```powershell
bun run test:web handoff
```
Expected: the four new files fail to import the missing components.

- [ ] **Step 8: Implement the components**

Load `frontend-design` and `ui-ux-pro-max:ui-ux-pro-max` now. The code below is a complete, tested baseline: keep every text, role, label, `data-testid` and behaviour the tests pin, and refine layout, spacing, typography and responsive behaviour with the skills (the dialog is the one place where a wrong click costs money, so the notice, the status badge, the prompt box and the checklist must stay prominent; no status by colour alone).

`apps/web/src/features/handoff/eur-listing-panel.tsx` (the EUR line, the verification badge with the checks behind it, the amber banner and acknowledgement for `unverified`, the manual unverified symbol for `none`):

```tsx
import { DESTINATION_LABELS, type EurExchange } from "@core/handoff.ts";
import { Ban, CircleCheck, TriangleAlert } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { HandoffView } from "./derive";
import { formatUtcStamp } from "./quote-text";

const EXCHANGE_NAMES: Record<EurExchange, string> = {
  IBIS: DESTINATION_LABELS.IBIS,
  AEB: DESTINATION_LABELS.AEB,
};

const CHECK_LABELS: Record<string, string> = {
  isin_confirmed: "ISIN confirmed against Yahoo's primary listing",
  currency_eur: "Trades in EUR",
  quote_type_equity: "Ordinary equity (not an ETF or tracker)",
  name_match: "Company name matches",
  shares_outstanding: "Shares outstanding are equal",
  price_within_tolerance: "EUR price within 1% of the screening listing",
  local_symbol_format: "IBKR local symbol is usable in a prompt",
};
const RESULT_TEXT: Record<string, string> = {
  pass: "passed",
  fail: "failed",
  not_available: "not available",
};

export function ListingBadge({ mode }: { mode: HandoffView["mode"] }) {
  if (mode === "verified") {
    return (
      <span
        className="inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-medium"
        data-testid="listing-badge"
        data-status="verified"
      >
        <CircleCheck aria-hidden="true" className="size-3.5" />
        Verified
      </span>
    );
  }
  if (mode === "unverified") {
    return (
      <span
        className="inline-flex items-center gap-1 rounded-md border border-amber-600 px-2 py-0.5 text-xs font-medium"
        data-testid="listing-badge"
        data-status="unverified"
      >
        <TriangleAlert aria-hidden="true" className="size-3.5" />
        Unverified
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-medium"
      data-testid="listing-badge"
      data-status="none"
    >
      <Ban aria-hidden="true" className="size-3.5" />
      None
    </span>
  );
}

function failedLabels(verification: Record<string, unknown>): string[] {
  const failed = verification["failed"];
  return Array.isArray(failed) ? failed.map((n) => CHECK_LABELS[String(n)] ?? String(n)) : [];
}

function Checks({ verification }: { verification: Record<string, unknown> }) {
  if (verification["method"] === "manual_override") {
    return (
      <p className="text-xs text-muted-foreground">{`Confirmed manually by the operator: ${String(verification["reason"] ?? "no reason recorded")}`}</p>
    );
  }
  const checks = verification["checks"];
  if (typeof checks !== "object" || checks === null) return null;
  return (
    <ul className="grid gap-0.5 text-xs text-muted-foreground" aria-label="Verification checks">
      {Object.entries(checks as Record<string, unknown>).map(([name, result]) => (
        <li
          key={name}
        >{`${CHECK_LABELS[name] ?? name}: ${RESULT_TEXT[String(result)] ?? String(result)}`}</li>
      ))}
    </ul>
  );
}

export interface EurListingPanelProps {
  view: HandoffView;
  acknowledged: boolean;
  onAcknowledge: (value: boolean) => void;
  manualSymbol: string;
  onManualSymbol: (value: string) => void;
  screeningSymbol: string;
  screeningCurrency: string | null;
  screeningExchange: string | null;
}

/** The EUR line to use (spec 13.1) and what to do when it is unverified (13.4) or missing. */
export function EurListingPanel(p: EurListingPanelProps) {
  const { view } = p;
  const listing = view.listing;
  return (
    <section aria-labelledby="eur-listing-heading" className="grid gap-2 rounded-md border p-3">
      <div className="flex items-center justify-between gap-2">
        <h3 id="eur-listing-heading" className="text-sm font-semibold">
          EUR listing
        </h3>
        <ListingBadge mode={view.mode} />
      </div>

      {listing !== null ? (
        <>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-sm">
            <dt className="text-muted-foreground">IBKR local symbol</dt>
            <dd className="font-mono">{listing.localSymbol}</dd>
            <dt className="text-muted-foreground">Exchange</dt>
            <dd>{`${listing.exchange} (${EXCHANGE_NAMES[listing.exchange]})`}</dd>
            <dt className="text-muted-foreground">Contract (conid)</dt>
            <dd className="font-mono">{listing.conid}</dd>
            <dt className="text-muted-foreground">ISIN</dt>
            <dd className="font-mono">{listing.isin ?? "unknown"}</dd>
            <dt className="text-muted-foreground">Currency</dt>
            <dd>EUR</dd>
            {listing.verifiedAt !== null ? (
              <>
                <dt className="text-muted-foreground">Verified</dt>
                <dd>{formatUtcStamp(Date.parse(listing.verifiedAt))}</dd>
              </>
            ) : null}
          </dl>
          <Checks verification={listing.verification} />
        </>
      ) : null}

      {view.mode === "unverified" ? (
        <div role="alert" className="grid gap-2 rounded-md border border-amber-600 p-2 text-sm">
          <p>
            {`A possible EUR listing was found but could not be fully verified: ${failedLabels(listing?.verification ?? {}).join("; ") || "some checks could not run"}.`}
          </p>
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              className="mt-1"
              checked={p.acknowledged}
              onChange={(e) => p.onAcknowledge(e.target.checked)}
            />
            <span>I have checked this is the same share</span>
          </label>
        </div>
      ) : null}

      {view.mode === "none" ? (
        <div className="grid gap-2 text-sm">
          <p className="font-medium">No verified EUR equivalent</p>
          <p className="text-muted-foreground">
            {`Screening listing: ${p.screeningSymbol}${p.screeningExchange ? `, ${p.screeningExchange}` : ""}${p.screeningCurrency ? `, ${p.screeningCurrency}` : ""}. Search for it in IBKR yourself, or type the IBKR local symbol of a EUR listing below.`}
          </p>
          <div className="grid gap-1">
            <Label htmlFor="manual-symbol">IBKR local symbol (unverified)</Label>
            <Input
              id="manual-symbol"
              value={p.manualSymbol}
              onChange={(e) => p.onManualSymbol(e.target.value)}
              autoCapitalize="characters"
              spellCheck={false}
              aria-describedby="manual-symbol-note"
            />
            <p id="manual-symbol-note" className="text-xs">
              <span className="font-medium text-destructive">Unverified symbol.</span> The app has
              not checked it: confirm the contract on the IBKR ticket.
            </p>
            {view.errors.symbol !== null ? (
              <p role="alert" className="text-xs text-destructive">
                {view.errors.symbol}
              </p>
            ) : null}
          </div>
        </div>
      ) : null}

      {listing !== null && view.errors.symbol !== null ? (
        <p role="alert" className="text-xs text-destructive">
          {view.errors.symbol}
        </p>
      ) : null}
    </section>
  );
}
```

`apps/web/src/features/handoff/prompt-panel.tsx` (the prompt in a read-only box, Copy with fallback, the documented-style variant, the checklist and the single link out):

```tsx
import { IBKR_LOGIN_URL, TICKET_REVIEW_NOTE } from "@core/handoff.ts";
import { Check, Copy, ExternalLink } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { type CopyOutcome, copyText } from "./copy-text";
import type { Gate, HandoffView } from "./derive";

const GATE_TEXT: Record<Gate, string> = {
  needs_acknowledgement: "Tick the box above to show the prompt.",
  needs_symbol: "Enter the IBKR local symbol to show the prompt.",
  invalid_symbol: "Fix the symbol to show the prompt.",
  needs_quantity: "Enter a quantity to show the prompt.",
  needs_price: "Enter a limit price to show the prompt.",
};

/** The generated iBot prompt, a Copy button, the second (documented-style) variant, the ticket checklist and the one link out (spec 13.1, 13.2). */
export function PromptPanel({ view }: { view: HandoffView }) {
  const box = useRef<HTMLTextAreaElement>(null);
  const [outcome, setOutcome] = useState<CopyOutcome | null>(null);

  async function onCopy() {
    if (view.prompt === null) return;
    const result = await copyText(view.prompt, box.current);
    setOutcome(result);
    if (result !== "failed") toast.success("Copied");
  }

  return (
    <section aria-labelledby="prompt-heading" className="grid gap-2 rounded-md border p-3">
      <h3 id="prompt-heading" className="text-sm font-semibold">
        iBot prompt
      </h3>

      {view.prompt === null ? (
        <p className="text-sm text-muted-foreground" data-testid="prompt-gate">
          {view.gate === null ? "" : GATE_TEXT[view.gate]}
        </p>
      ) : (
        <>
          {view.mode === "none" ? (
            <p role="alert" className="text-xs font-medium text-destructive">
              Unverified symbol: this prompt uses a symbol the app has not checked. Confirm the
              contract on the IBKR ticket.
            </p>
          ) : null}
          <textarea
            ref={box}
            readOnly
            rows={3}
            aria-label="iBot prompt"
            data-testid="ibot-prompt"
            className="w-full rounded-md border bg-muted/40 p-2 font-mono text-sm"
            value={view.prompt}
            onFocus={(e) => e.currentTarget.select()}
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" size="sm" onClick={onCopy} data-testid="copy-prompt">
              {outcome === "clipboard" || outcome === "fallback" ? (
                <Check aria-hidden="true" />
              ) : (
                <Copy aria-hidden="true" />
              )}
              {outcome === "clipboard" || outcome === "fallback" ? "Copied" : "Copy"}
            </Button>
            <span role="status" className="text-xs text-muted-foreground">
              {outcome === "failed" ? "Copy failed: the prompt is selected, press Ctrl+C." : ""}
            </span>
          </div>
          {view.documented !== null ? (
            <details className="text-sm">
              <summary className="cursor-pointer">Documented-style variant</summary>
              <p className="mt-1 font-mono" data-testid="documented-prompt">
                {view.documented.prompt}
              </p>
              <p className="text-xs text-muted-foreground">{view.documented.ticketNote}</p>
            </details>
          ) : null}
          {view.checklist !== null ? (
            <p className="text-sm font-medium" data-testid="ticket-checklist">
              {view.checklist}
            </p>
          ) : null}
        </>
      )}

      <p className="text-xs text-muted-foreground">{TICKET_REVIEW_NOTE}</p>
      <a
        href={IBKR_LOGIN_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex w-fit items-center gap-1 text-sm underline"
        data-testid="open-ibkr"
      >
        Open IBKR Client Portal
        <ExternalLink aria-hidden="true" className="size-3.5" />
        <span className="sr-only">(opens in a new tab)</span>
      </a>
    </section>
  );
}
```

`apps/web/src/features/handoff/trade-on-ibkr-dialog.tsx`:

```tsx
import {
  DEFAULT_DESTINATION,
  DESTINATION_LABELS,
  type Destination,
  isDestination,
  NO_ORDER_NOTICE,
  type OrderType,
  pickListing,
  type Side,
} from "@core/handoff.ts";
import { Info, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useQuotes } from "@/features/screening/quotes-hooks";
import { deriveHandoff, type FormState, INITIAL_FORM } from "./derive";
import { EurListingPanel } from "./eur-listing-panel";
import { useDefaultDestination, useEurListings } from "./hooks";
import { PromptPanel } from "./prompt-panel";
import { prefillPrice, usableEurQuote } from "./quote-text";
import type { TradeTarget } from "./types";
import { useCooldown } from "./use-cooldown";

const REFRESH_COOLDOWN_SECONDS = 10;

export interface TradeOnIbkrDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  target: TradeTarget;
}

function Toggle<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly { value: T; text: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <fieldset className="inline-flex rounded-md border p-0.5">
      <legend className="sr-only">{label}</legend>
      {options.map((o) => (
        <Button
          key={o.value}
          type="button"
          size="sm"
          variant={value === o.value ? "default" : "ghost"}
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
        >
          {o.text}
        </Button>
      ))}
    </fieldset>
  );
}

/**
 * The "Trade on IBKR" hand-off (spec 13). It prepares text for the owner to paste into IBKR's iBot. It never places, modifies or cancels an
 * order, and the notice saying so is rendered in every state, including loading and error. Nothing typed here is logged or sent anywhere.
 */
export function TradeOnIbkrDialog({ open, onOpenChange, target }: TradeOnIbkrDialogProps) {
  const listings = useEurListings(open ? target.securityId : null);
  const preference = useDefaultDestination();
  const [form, setForm] = useState<FormState>(INITIAL_FORM);
  const [priceTouched, setPriceTouched] = useState(false);
  const cooldown = useCooldown(REFRESH_COOLDOWN_SECONDS);

  // The delayed EUR quote is requested only for a VERIFIED listing: an unverified line could be a look-alike and must not feed a price.
  const best = useMemo(() => pickListing(listings.data ?? []), [listings.data]);
  const quoteSymbol = best !== null && best.status === "verified" ? best.eurSymbolYahoo : null;
  const quotes = useQuotes(quoteSymbol === null ? [] : [quoteSymbol]);
  const eurQuote = usableEurQuote(
    quoteSymbol === null ? undefined : quotes.data?.find((q) => q.symbol === quoteSymbol),
  );

  // prefill the limit price with the delayed quote rounded to 2 decimals, until the user types their own
  const quotePrice = eurQuote?.price ?? null;
  useEffect(() => {
    if (quotePrice !== null && !priceTouched)
      setForm((f) => ({ ...f, priceText: prefillPrice(quotePrice) }));
  }, [quotePrice, priceTouched]);

  const preferred: Destination = isDestination(preference.data)
    ? preference.data
    : DEFAULT_DESTINATION;
  const view = useMemo(
    () =>
      deriveHandoff({
        listings: listings.data ?? [],
        form,
        defaultDestination: preferred,
        referencePrice: quotePrice,
      }),
    [listings.data, form, preferred, quotePrice],
  );
  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((f) => ({ ...f, [key]: value }));
  const prefilled = quotePrice !== null && !priceTouched && form.orderType === "limit";

  function reset(next: boolean) {
    if (!next) {
      setForm(INITIAL_FORM);
      setPriceTouched(false);
    }
    onOpenChange(next);
  }

  return (
    <Dialog open={open} onOpenChange={reset}>
      <DialogContent
        className="max-h-[90vh] overflow-y-auto sm:max-w-2xl"
        data-testid="trade-dialog"
      >
        <DialogHeader>
          <DialogTitle>Trade on IBKR</DialogTitle>
          <DialogDescription>
            {`${target.rank !== null ? `#${target.rank} ` : ""}${target.symbol} — ${target.companyName}`}
          </DialogDescription>
        </DialogHeader>

        <p
          role="note"
          data-testid="no-order-notice"
          className="flex gap-2 rounded-md border border-foreground/40 bg-muted/40 p-3 text-sm font-medium"
        >
          <Info aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <span>{NO_ORDER_NOTICE}</span>
        </p>

        {listings.isLoading ? (
          <p className="text-sm text-muted-foreground" data-testid="listing-loading">
            Loading the EUR listing…
          </p>
        ) : listings.isError ? (
          <div role="alert" className="grid gap-2 text-sm" data-testid="listing-error">
            <p>Could not load the EUR listing, so no prompt can be prepared right now.</p>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="w-fit"
              onClick={() => void listings.refetch()}
            >
              Retry
            </Button>
          </div>
        ) : (
          <>
            <EurListingPanel
              view={view}
              acknowledged={form.acknowledged}
              onAcknowledge={(v) => set("acknowledged", v)}
              manualSymbol={form.manualSymbol}
              onManualSymbol={(v) => set("manualSymbol", v)}
              screeningSymbol={target.symbol}
              screeningCurrency={target.currency}
              screeningExchange={target.exchangeName}
            />

            {view.mode === "verified" ? (
              <section
                aria-labelledby="quote-heading"
                className="grid gap-1 rounded-md border p-3 text-sm"
                data-testid="quote-block"
              >
                <h3 id="quote-heading" className="font-semibold">
                  Quote
                </h3>
                {eurQuote !== null ? (
                  <p>
                    {`Delayed quote (Yahoo): ${prefillPrice(eurQuote.price)} EUR as of ${eurQuote.stamp}, 15 minutes or more delayed, not an IBKR price${eurQuote.stale ? " (stale)" : ""}`}
                  </p>
                ) : quotes.isLoading ? (
                  <p className="text-muted-foreground">Loading the delayed quote…</p>
                ) : (
                  <p>Quote unavailable</p>
                )}
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="w-fit"
                  disabled={cooldown.remaining > 0 || quotes.isFetching}
                  onClick={() => {
                    cooldown.start();
                    void quotes.refetch();
                  }}
                >
                  <RefreshCw aria-hidden="true" />
                  {cooldown.remaining > 0
                    ? `Refresh quote (${cooldown.remaining} s)`
                    : "Refresh quote"}
                </Button>
              </section>
            ) : null}

            <section aria-labelledby="order-heading" className="grid gap-3 rounded-md border p-3">
              <h3 id="order-heading" className="text-sm font-semibold">
                Order to prepare
              </h3>
              <div className="flex flex-wrap gap-3">
                <Toggle<Side>
                  label="Side"
                  value={form.side}
                  onChange={(v) => set("side", v)}
                  options={[
                    { value: "buy", text: "Buy" },
                    { value: "sell", text: "Sell" },
                  ]}
                />
                <Toggle<OrderType>
                  label="Order type"
                  value={form.orderType}
                  onChange={(v) => set("orderType", v)}
                  options={[
                    { value: "limit", text: "Limit" },
                    { value: "market", text: "Market" },
                  ]}
                />
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="grid gap-1">
                  <Label htmlFor="quantity">Quantity (shares)</Label>
                  <Input
                    id="quantity"
                    inputMode="numeric"
                    value={form.quantityText}
                    onChange={(e) => set("quantityText", e.target.value)}
                    aria-invalid={view.errors.quantity !== null}
                    aria-describedby="quantity-error"
                  />
                  <p
                    id="quantity-error"
                    role={view.errors.quantity === null ? undefined : "alert"}
                    className="min-h-4 text-xs text-destructive"
                  >
                    {view.errors.quantity ?? ""}
                  </p>
                </div>
                {form.orderType === "limit" ? (
                  <div className="grid gap-1">
                    <Label htmlFor="limit-price">Limit price (EUR)</Label>
                    <Input
                      id="limit-price"
                      inputMode="decimal"
                      value={form.priceText}
                      onChange={(e) => {
                        setPriceTouched(true);
                        set("priceText", e.target.value);
                      }}
                      aria-invalid={view.errors.price !== null}
                      aria-describedby="limit-price-note"
                    />
                    <p
                      id="limit-price-note"
                      role={view.errors.price === null ? undefined : "alert"}
                      className="min-h-4 text-xs text-destructive"
                    >
                      {view.errors.price ?? ""}
                    </p>
                    {prefilled && view.errors.price === null ? (
                      <p className="text-xs text-muted-foreground">
                        Prefilled from the delayed quote: edit before use.
                      </p>
                    ) : null}
                  </div>
                ) : (
                  <p className="self-end text-xs text-muted-foreground">
                    A market order has no price in the prompt.
                  </p>
                )}
              </div>
              <div className="grid gap-1">
                <Label htmlFor="destination">Destination</Label>
                <select
                  id="destination"
                  className="h-9 rounded-md border bg-background px-2 text-sm"
                  value={view.destination}
                  onChange={(e) => {
                    if (isDestination(e.target.value)) set("destination", e.target.value);
                  }}
                >
                  {view.destinationOptions.map((d) => (
                    <option key={d} value={d}>{`${d} — ${DESTINATION_LABELS[d]}`}</option>
                  ))}
                </select>
                {view.destinationNote !== null ? (
                  <p className="text-xs text-muted-foreground" data-testid="destination-note">
                    {view.destinationNote}
                  </p>
                ) : null}
              </div>
              <p className="text-sm" data-testid="estimate">
                {view.estimate.label}
              </p>
            </section>

            <PromptPanel view={view} />
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
```

`apps/web/src/features/handoff/trade-on-ibkr-button.tsx`:

```tsx
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { TradeOnIbkrDialog } from "./trade-on-ibkr-dialog";
import type { TradeTarget } from "./types";

export const TRADE_BUTTON_LABEL = "Trade on IBKR";

/** A button that opens the hand-off dialog. The dialog is mounted only while open, so no EUR or profile request is made for a closed button. */
export function TradeOnIbkrButton({
  target,
  className,
}: {
  target: TradeTarget;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="outline"
        className={className}
        data-testid="trade-on-ibkr-button"
        onClick={() => setOpen(true)}
      >
        {TRADE_BUTTON_LABEL}
      </Button>
      {open ? <TradeOnIbkrDialog open onOpenChange={setOpen} target={target} /> : null}
    </>
  );
}
```

`apps/web/src/features/handoff/default-destination-card.tsx`:

```tsx
import {
  DESTINATION_LABELS,
  DESTINATIONS,
  type Destination,
  isDestination,
} from "@core/handoff.ts";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { useDefaultDestination, useSaveDefaultDestination } from "./hooks";

/** Profile -> Broker: the iBot destination that the hand-off pre-selects (A-39). Saved to profiles.default_destination under the user's own RLS row. */
export function DefaultDestinationCard() {
  const current = useDefaultDestination();
  const save = useSaveDefaultDestination();
  const value: Destination = isDestination(current.data) ? current.data : "IBIS2";

  return (
    <Card>
      <CardHeader>
        <CardTitle>Default destination</CardTitle>
        <CardDescription>
          Pre-selected in the Trade on IBKR hand-off. IBIS2 is your own practice and is not listed
          in IBKR's public catalogue: if iBot rejects it, choose IBIS (Xetra).
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-2">
        <Label htmlFor="default-destination">Default destination</Label>
        <select
          id="default-destination"
          className="h-9 w-full max-w-md rounded-md border bg-background px-2 text-sm"
          value={value}
          disabled={current.isLoading || save.isPending}
          onChange={(e) => {
            if (isDestination(e.target.value)) save.mutate(e.target.value);
          }}
        >
          {DESTINATIONS.map((d) => (
            <option key={d} value={d}>{`${d} — ${DESTINATION_LABELS[d]}`}</option>
          ))}
        </select>
        <p role="status" className="min-h-5 text-sm">
          {save.isPending ? "Saving…" : save.isSuccess ? "Saved" : ""}
        </p>
        {current.isError || save.isError ? (
          <p role="alert" className="text-sm text-destructive">
            {save.isError
              ? "Could not save your default destination."
              : "Could not load your default destination."}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 9: Run; Expected: PASS**

```powershell
bun run test:web handoff
bun run lint:fix
bun run typecheck
```
Expected: 51 tests pass across the six files; typecheck clean (`@core/handoff.ts` is imported with its extension; the web `tsconfig` already includes the core folder). If a Radix `Dialog` warning about a missing `Description` or about `act` appears, it is cosmetic: the dialog has a `DialogDescription`; do not silence real errors.

- [ ] **Step 10: The shared mock for suites that render pages containing the feature**

`apps/web/src/test/handoff-default-mock.ts`:

```ts
import { vi } from "vitest";
import type { HandoffApi } from "@/features/handoff/handoff-api";

export const handoffApiMock = {
  getEurListings: vi.fn(),
  getDefaultDestination: vi.fn(),
  setDefaultDestination: vi.fn(),
} satisfies Record<keyof HandoffApi, unknown>;

export const handoffDefaultMock = { handoffApi: handoffApiMock };
```

In `apps/web/src/test/setup.ts` add below the existing `vi.mock` lines (the same convention as `@/features/profile/default`):

```ts
vi.mock("@/features/handoff/default", async () => (await import("./handoff-default-mock")).handoffDefaultMock);
```

- [ ] **Step 11: The Overview card (linked viewers only; other states keep P4 behaviour)**

In `apps/web/src/features/overview/discount-card.tsx` replace the constants and `TradeControl` (the block starting at `export const TRADE_BUTTON_LABEL = "Submit Order";` through the end of `TradeControl`) with the following, add the two imports, and pass the target from `DiscountCard`:

```tsx
import { TRADE_BUTTON_LABEL, TradeOnIbkrButton } from "@/features/handoff/trade-on-ibkr-button";
import type { TradeTarget } from "@/features/handoff/types";

export { TRADE_BUTTON_LABEL };

/** The hand-off target of a card: the canonical (screening) listing the card is about. */
export function tradeTarget(row: DiscountRow): TradeTarget {
  return {
    securityId: row.security_id,
    symbol: row.yahoo_symbol,
    companyName: row.name,
    rank: row.rank,
    exchangeName: row.exchange_name,
    currency: row.currency,
  };
}

/** Spec 13.5 per viewer type. The linked button opens the hand-off dialog; it never submits anything. */
export function TradeControl({ viewer, target }: { viewer: ViewerState; target: TradeTarget }) {
  if (viewer === "anonymous") {
    return (
      <a href="/auth/sign-in" className="text-sm underline">
        Sign in to trade
      </a>
    );
  }
  if (viewer === "no_broker") {
    return (
      <a href="/profile/broker" className="text-sm underline">
        Link IBKR in Profile → Broker
      </a>
    );
  }
  return <TradeOnIbkrButton target={target} />;
}
```
and in the card footer replace `<TradeControl viewer={viewer} />` with `<TradeControl viewer={viewer} target={tradeTarget(row)} />`. Remove the now unused `TRADE_DISABLED_TOOLTIP` constant (P4 tests referencing it are replaced below). `useId` stays imported (the card heading uses it).

The EUR subtitle (spec 14.3: verified EUR ticker plus delayed EUR price plus timestamp, or `No verified EUR equivalent`, or `EUR price unavailable`) is already P4's `EurLine`; with the real view columns from Task 1 it now shows real data. Nothing to change there.

Update P4's tests: in `apps/web/src/features/overview/todays-discounts.test.tsx` replace the test `linked viewer: a disabled Submit Order button with the explanatory tooltip` with:

```tsx
  it("linked viewer: an enabled Trade on IBKR button (spec 13.5), never labelled Submit Order", async () => {
    viewer.useViewerState.mockReturnValue("linked");
    api.fetchTodaysDiscounts.mockResolvedValue([makeDiscount()]);
    renderWithProviders(<TodaysDiscounts mode="worldwide" />);
    const btn = (await screen.findByTestId("trade-on-ibkr-button")) as HTMLButtonElement;
    expect(btn.textContent).toBe("Trade on IBKR");
    expect(btn.disabled).toBe(false);
    expect(screen.queryByRole("button", { name: /submit order/i })).toBeNull();
  });

  it("an unverified or missing EUR equivalent shows No verified EUR equivalent and requests no EUR quote", async () => {
    api.fetchTodaysDiscounts.mockResolvedValue([
      makeDiscount({ yahoo_symbol: "MSFT", eur_status: "unverified", eur_symbol_yahoo: "MSF.DE" }),
      makeDiscount({ yahoo_symbol: "XYZ", rank: 2, eur_status: "none", eur_symbol_yahoo: null }),
    ]);
    renderWithProviders(<TodaysDiscounts mode="worldwide" />);
    expect((await screen.findAllByText("No verified EUR equivalent")).length).toBe(2);
    expect(quotes.fetchQuotes).not.toHaveBeenCalledWith(["MSF.DE"]);
  });
```
and in the anonymous test change `queryByTestId("submit-order-button")` to `queryByTestId("trade-on-ibkr-button")`. Then run `git grep -n "submit-order-button\|Submit Order\|TRADE_DISABLED_TOOLTIP" -- apps/web` and fix every remaining hit the same way (P4's Playwright specs may mention the old test id).

`apps/web/src/features/overview/trade-control.test.tsx` (the three viewer types against the real `TradeControl`, mocking the three seams):

```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TradeTarget } from "@/features/handoff/types";
import { TradeControl } from "./discount-card";

const mocks = vi.hoisted(() => ({
  handoffApi: {
    getEurListings: vi.fn(),
    getDefaultDestination: vi.fn(),
    setDefaultDestination: vi.fn(),
  },
  auth: { useAuth: vi.fn() },
  quotes: { useQuotes: vi.fn() },
}));
vi.mock("@/features/handoff/default", () => ({ handoffApi: mocks.handoffApi }));
vi.mock("@/features/auth/auth-provider", () => mocks.auth);
vi.mock("@/features/screening/quotes-hooks", () => mocks.quotes);

const TARGET: TradeTarget = {
  securityId: "sec-msft",
  symbol: "MSFT",
  companyName: "Microsoft Corporation",
  rank: 53,
  exchangeName: "NasdaqGS",
  currency: "USD",
};

const renderControl = (viewer: "anonymous" | "no_broker" | "linked") =>
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <TradeControl viewer={viewer} target={TARGET} />
    </QueryClientProvider>,
  );

beforeEach(() => {
  vi.clearAllMocks();
  mocks.handoffApi.getEurListings.mockResolvedValue([]);
  mocks.handoffApi.getDefaultDestination.mockResolvedValue("IBIS2");
  mocks.auth.useAuth.mockReturnValue({ status: "signed-in", user: { id: "u1" }, recovery: false });
  mocks.quotes.useQuotes.mockReturnValue({
    data: undefined,
    isLoading: false,
    isError: false,
    isFetching: false,
    refetch: vi.fn(),
  });
});
afterEach(() => cleanup());

describe("TradeControl (spec 13.5)", () => {
  it("anonymous viewers keep the P4 sign-in link and get no trade control", () => {
    renderControl("anonymous");
    expect(screen.getByRole("link", { name: "Sign in to trade" })).toBeTruthy();
    expect(screen.queryByTestId("trade-on-ibkr-button")).toBeNull();
  });

  it("signed-in viewers without IBKR keep the P4 link to Profile > Broker and get no trade control", () => {
    renderControl("no_broker");
    expect(
      (
        screen.getByRole("link", { name: "Link IBKR in Profile → Broker" }) as HTMLAnchorElement
      ).getAttribute("href"),
    ).toBe("/profile/broker");
    expect(screen.queryByTestId("trade-on-ibkr-button")).toBeNull();
  });

  it("linked viewers get an enabled Trade on IBKR button that opens the hand-off for the card's security", async () => {
    renderControl("linked");
    const button = screen.getByTestId("trade-on-ibkr-button") as HTMLButtonElement;
    expect(button.textContent).toBe("Trade on IBKR");
    expect(button.disabled).toBe(false);
    expect(screen.queryByRole("button", { name: /submit order/i })).toBeNull();
    fireEvent.click(button);
    expect(await screen.findByTestId("trade-dialog")).toBeTruthy();
    expect(mocks.handoffApi.getEurListings).toHaveBeenCalledWith("sec-msft");
    expect(screen.getByTestId("no-order-notice")).toBeTruthy();
  });
});
```

- [ ] **Step 12: Profile -> Broker: the default destination**

In `apps/web/src/features/profile/broker-page.tsx` (P5a) render the card below the panel; P5b replaces only the body of `BrokerPanel`:

```tsx
import { useEffect } from "react";
import { DefaultDestinationCard } from "@/features/handoff/default-destination-card";
import { BrokerPanel } from "./panels/broker-panel";

export function ProfileBrokerPage() {
  useEffect(() => {
    document.title = "Broker - Stock Screener";
  }, []);
  return (
    <section aria-labelledby="page-title" className="space-y-6">
      <h1 id="page-title" className="text-2xl font-semibold tracking-tight">
        Broker
      </h1>
      <BrokerPanel />
      <DefaultDestinationCard />
    </section>
  );
}
```
In `apps/web/src/features/profile/profile-panels.test.tsx` (the Broker test) add the default for the mocked API and an assertion:

```tsx
import { handoffApiMock } from "@/test/handoff-default-mock";
// inside the Broker test, before renderApp:
    handoffApiMock.getDefaultDestination.mockResolvedValue("IBIS2");
// after the existing assertions:
    expect(await screen.findByLabelText("Default destination")).toBeTruthy();
```

- [ ] **Step 13: Run the whole web suite**

```powershell
bun run test:web
bun run lint:fix
bun run lint
bun run typecheck
bun run build
bun run check:bundle
```
Expected: all web tests pass (this task adds 54: 51 in the feature folder and 3 in `trade-control.test.tsx`); lint, typecheck and build clean; `check:bundle` finds no secret (the feature uses only the anon client).

- [ ] **Step 14: Portfolio rows (conditional on P5b)**

If step 1 found P5b's positions table (`PositionsTable`), add a last column `Trade` whose cell is:
```tsx
{(() => {
  const target = holdingTarget({
    canonicalSecurityId: row.signalSecurityId,   // the company's canonical security (spec 12.7 `signal_security`); adapt to P5b's field
    canonicalSymbol: row.signalSymbol,
    companyName: row.name,
    exchangeName: row.signalExchangeName,
    currency: row.signalCurrency,
  });
  return target === null ? <span className="text-xs text-muted-foreground">Unmatched</span> : <TradeOnIbkrButton target={target} />;
})()}
```
with a table test that a matched row renders `trade-on-ibkr-button` and an unmatched row does not (use P5b's fixtures). The Portfolio page is already behind the linked-user gate. If P5b has not landed, skip this step, leave `TradeOnIbkrButton` and `holdingTarget` exported (both are tested), and record "Portfolio wiring pending P5b" in the phase exit report.

- [ ] **Step 15: Commit**

```powershell
git add apps/web/src/features/handoff apps/web/src/features/overview apps/web/src/features/profile apps/web/src/test
git commit -m "feat(web): add the Trade on IBKR hand-off dialog, default destination setting and card wiring"
```

---

## Task 6: Integration test, end-to-end test and operator guide

**Depends on:** Tasks 1 to 5 and P1's fixture-mode integration (`tools/test-integration.ts`, the integration world). Implementer: sonnet.

**Files:**
- Create: `tools/lib/eur-fixtures.ts`, `tools/lib/eur-fixtures.test.ts`, `tools/gen-eur-fixtures.ts`, `supabase/functions/_shared/adapters/fixtures/integration/eur-fixtures.json` (generated, committed), `apps/web/e2e/local/handoff.local.spec.ts`
- Modify: `supabase/functions/_shared/adapters/fixture-providers.ts`, `supabase/config.toml`, `tools/lib/local-stack.ts`, `tools/test-integration.ts`, `package.json` (script `gen:fixtures:eur`), `docs/operator-guide.md`

**What the integration scan proves (fixture mode, local stack):** the weekly import writes both exchanges (including a synthetic AEB look-alike row that shares MSFT's ticker), MSFT (put on the watch list) resolves to exactly one row, IBIS `MSF`, conid 12178239, `verified`, with `securities.isin` filled in; the look-alike is rejected and stored nowhere; the two card securities end as `none` and the public cards view says so; a second scan in the same ISO week skips the import and makes no catalogue request; re-running creates no rows.

- [ ] **Step 1: Write the failing fixture-builder test**

`tools/lib/eur-fixtures.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  buildEurFixtures,
  LOOKALIKE_CONID,
  LOOKALIKE_ISIN,
  MSFT_ISIN,
  type WorldSlice,
} from "./eur-fixtures.ts";

const world = (over: Record<string, unknown> = {}): WorldSlice => ({
  fx: { EUR: 1.1213, USD: 1 },
  securities: {
    MSFT: {
      quote: {
        symbol: "MSFT",
        quoteType: "EQUITY",
        currency: "USD",
        exchange: "NMS",
        longName: "Microsoft Corporation",
        sharesOutstanding: 7_425_545_491,
        regularMarketPrice: 533.69,
        regularMarketTime: "2026-10-14T20:00:00Z",
        ...over,
      },
    },
  },
});
const ibis = [
  {
    type: "STK",
    symbol: "MSF",
    localSymbol: "MSF",
    conid: 12178239,
    isin: MSFT_ISIN,
    currency: "EUR",
    description: "MICROSOFT CORP",
  },
];
const aeb = [
  {
    type: "STK",
    symbol: "ASML",
    localSymbol: "ASML",
    conid: 117589399,
    isin: "NL0010273215",
    currency: "EUR",
    description: "ASML HOLDING NV",
  },
];

describe("buildEurFixtures", () => {
  it("derives MSF.DE from the world's MSFT quote, inside the 1% tolerance", () => {
    const f = buildEurFixtures({ world: world(), ibisProducts: ibis, aebProducts: aeb });
    const q = f.quotes["MSF.DE"] as Record<string, unknown>;
    expect([
      q["symbol"],
      q["currency"],
      q["quoteType"],
      q["longName"],
      q["sharesOutstanding"],
    ]).toEqual(["MSF.DE", "EUR", "EQUITY", "Microsoft Corporation", 7_425_545_491]);
    const deviation = ((q["regularMarketPrice"] as number) * 1.1213 - 533.69) / 533.69;
    expect(Math.abs(deviation)).toBeLessThan(0.006);
  });

  it("adds the look-alike trap: an AEB row that shares MSFT's ticker, its ISIN pointing at the tracker line", () => {
    const f = buildEurFixtures({ world: world(), ibisProducts: ibis, aebProducts: aeb });
    const aebPage = (f.catalogue["AEB"]?.[0] ?? []) as {
      symbol: string;
      conid: number;
      isin: string;
    }[];
    const trap = aebPage.find((p) => p.symbol === "MSFT");
    expect(trap).toMatchObject({ conid: LOOKALIKE_CONID, isin: LOOKALIKE_ISIN });
    expect(f.isins).toEqual({ [MSFT_ISIN]: "MSFT", [LOOKALIKE_ISIN]: "MSFT.AS" });
    expect(f.quotes["MSFT.AS"]).toMatchObject({ quoteType: "ETF", currency: "EUR" });
    expect(f.catalogue["IBIS"]).toEqual([ibis]);
  });

  it("fails loudly when the world cannot support the scenario", () => {
    expect(() =>
      buildEurFixtures({
        world: { fx: { EUR: 1.1 }, securities: {} },
        ibisProducts: ibis,
        aebProducts: aeb,
      }),
    ).toThrow("no MSFT quote");
    expect(() =>
      buildEurFixtures({
        world: world({ regularMarketPrice: null }),
        ibisProducts: ibis,
        aebProducts: aeb,
      }),
    ).toThrow("regularMarketPrice");
    expect(() =>
      buildEurFixtures({
        world: world({ sharesOutstanding: undefined }),
        ibisProducts: ibis,
        aebProducts: aeb,
      }),
    ).toThrow("sharesOutstanding");
    expect(() =>
      buildEurFixtures({ world: { ...world(), fx: {} }, ibisProducts: ibis, aebProducts: aeb }),
    ).toThrow("EUR rate");
  });
});
```

- [ ] **Step 2: Run; Expected: FAIL, then implement**

```powershell
bun run test:tools eur-fixtures
```
Expected: FAIL (`Failed to resolve import "./eur-fixtures.ts"`). Then create `tools/lib/eur-fixtures.ts` (pure; everything it produces is synthetic test data derived from the world's MSFT quote):

```ts
// Builds the offline EUR data for the integration scan (7.12, 17.4) from the integration world and the IBKR catalogue fixtures.
// Pure: the CLI (tools/gen-eur-fixtures.ts) reads and writes the files. Everything here is SYNTHETIC test data derived from the world's MSFT quote.

export const MSFT_ISIN = "US5949181045";
export const LOOKALIKE_ISIN = "XS0000000010";
export const LOOKALIKE_CONID = 900000010;

export interface WorldSlice {
  fx: Record<string, number>;
  securities: Record<string, { quote: Record<string, unknown> }>;
}

export interface EurFixtures {
  catalogue: Record<string, unknown[][]>;
  isins: Record<string, string>;
  quotes: Record<string, Record<string, unknown>>;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

export function buildEurFixtures(input: {
  world: WorldSlice;
  ibisProducts: unknown[];
  aebProducts: unknown[];
}): EurFixtures {
  const msft = input.world.securities["MSFT"]?.quote;
  if (msft === undefined) throw new Error("the integration world has no MSFT quote");
  const price = msft["regularMarketPrice"];
  const shares = msft["sharesOutstanding"];
  const name = msft["longName"];
  const eurUsd = input.world.fx["EUR"];
  if (typeof price !== "number" || !(price > 0))
    throw new Error("world MSFT has no regularMarketPrice");
  if (typeof shares !== "number" || !(shares > 0))
    throw new Error("world MSFT has no sharesOutstanding");
  if (typeof name !== "string" || name === "") throw new Error("world MSFT has no longName");
  if (typeof eurUsd !== "number" || !(eurUsd > 0))
    throw new Error("world fx has no EUR rate (USD per EUR)");

  // MSF.DE: the same company on Xetra, 0.4% away from MSFT x FX (spike 3.5 measured 0.65%): inside the 1% tolerance
  const msfDe: Record<string, unknown> = {
    ...msft,
    symbol: "MSF.DE",
    quoteType: "EQUITY",
    currency: "EUR",
    exchange: "GER",
    fullExchangeName: "XETRA",
    regularMarketPrice: round2((price / eurUsd) * 1.004),
  };
  // MSFT.AS: the tracker ETP that shares MSFT's ticker on Euronext Amsterdam (spike 3.5)
  const msftAs: Record<string, unknown> = {
    symbol: "MSFT.AS",
    quoteType: "ETF",
    currency: "EUR",
    exchange: "AMS",
    fullExchangeName: "Amsterdam",
    longName: "LS 1x Microsoft Tracker ETP Securities",
    regularMarketPrice: 9.664,
    regularMarketTime: msft["regularMarketTime"] ?? null,
  };
  const lookAlike = {
    type: "STK",
    symbol: "MSFT",
    exchangeId: "AEB",
    localSymbol: "MSFT",
    description: "SYNTHETIC LOOK-ALIKE TRACKER (TEST ONLY)",
    conid: LOOKALIKE_CONID,
    isin: LOOKALIKE_ISIN,
    currency: "EUR",
    country: "NL",
  };
  return {
    catalogue: { IBIS: [input.ibisProducts], AEB: [[...input.aebProducts, lookAlike]] },
    isins: { [MSFT_ISIN]: "MSFT", [LOOKALIKE_ISIN]: "MSFT.AS" },
    quotes: { "MSF.DE": msfDe, "MSFT.AS": msftAs },
  };
}
```

`tools/gen-eur-fixtures.ts` (reads `integration/world.json` and the two catalogue fixtures of Task 2):

```ts
// Writes supabase/functions/_shared/adapters/fixtures/integration/eur-fixtures.json for the fixture-mode integration scan.
// Usage: bun run tools/gen-eur-fixtures.ts      (needs fixtures/integration/world.json from tools/gen-integration-fixtures.ts)
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildEurFixtures, type WorldSlice } from "./lib/eur-fixtures.ts";

const dir = join(
  import.meta.dirname,
  "..",
  "supabase",
  "functions",
  "_shared",
  "adapters",
  "fixtures",
);
const read = <T>(file: string): T => JSON.parse(readFileSync(join(dir, file), "utf8")) as T;

const world = read<WorldSlice>("integration/world.json");
const ibis = read<{ products: unknown[] }>("ibkr-catalogue-ibis-page1.json");
const aeb = read<{ products: unknown[] }>("ibkr-catalogue-aeb-page1.json");
const out = buildEurFixtures({ world, ibisProducts: ibis.products, aebProducts: aeb.products });
writeFileSync(join(dir, "integration", "eur-fixtures.json"), `${JSON.stringify(out, null, 2)}\n`);

const price = (out.quotes["MSF.DE"] as { regularMarketPrice: number }).regularMarketPrice;
console.log(
  `wrote eur-fixtures.json: MSF.DE ${price} EUR, ${Object.keys(out.isins).length} ISINs, pages IBIS ${out.catalogue["IBIS"]?.[0]?.length} / AEB ${out.catalogue["AEB"]?.[0]?.length}`,
);
```

Add the script to the root `package.json` next to P1's `gen:fixtures:world`:
```json
"gen:fixtures:eur": "bun run tools/gen-eur-fixtures.ts"
```
Run:
```powershell
bun run test:tools eur-fixtures
bun run gen:fixtures:eur
```
Expected: 3 tests pass; the generator prints `wrote eur-fixtures.json: MSF.DE <price> EUR, 2 ISINs, pages IBIS 5 / AEB 5` and creates `supabase/functions/_shared/adapters/fixtures/integration/eur-fixtures.json`. If the world's MSFT quote lacks `sharesOutstanding` or `longName` the generator stops with a precise message: regenerate the world (`bun run gen:fixtures:world`) or add the field to the world's MSFT quote.

- [ ] **Step 3: Let the fixture providers use the EUR overlay (P1 file)**

In `supabase/functions/_shared/adapters/fixture-providers.ts` (the module `fixture-eur.ts` was added in Task 3): import it, add the optional `eur` field to `World`, load it in `loadWorld`, and wrap the market provider at the end of `createFixtureProviders`.

```ts
import { loadEurFixtures, withEurFixtures, type EurFixtures } from "./fixture-eur.ts";

export interface World {
  // ...the existing fields stay...
  /** Offline EUR data (catalogue pages, ISIN answers, EUR quote lines); absent in a world generated before P6. */
  eur?: EurFixtures | undefined;
}

async function optionalEurFixtures(): Promise<EurFixtures | undefined> {
  try {
    return await loadEurFixtures();
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return undefined;
    throw e;
  }
}

export async function loadWorld(): Promise<World> {
  const text = await Deno.readTextFile(new URL("./fixtures/integration/world.json", import.meta.url));
  const world = JSON.parse(text) as World;
  world.eur = await optionalEurFixtures();
  return world;
}

// at the end of createFixtureProviders, replace `return { market, fx };` with:
  return { market: world.eur === undefined ? market : withEurFixtures(market, world.eur), fx };
```
The edge runtime can read a data file only if `config.toml` lists it. In `supabase/config.toml` extend P1's entry:
```toml
[functions.worker-tick]
verify_jwt = false
static_files = [
  "./functions/_shared/adapters/fixtures/integration/world.json",
  "./functions/_shared/adapters/fixtures/integration/eur-fixtures.json",
]
```
(`eur_register.ts` reads the same file for the catalogue pages in fixture mode, and only when `ALLOW_FIXTURE_PROVIDERS=1`.) Run `bun run functions:check` and `bun run check:functions-config`.

- [ ] **Step 4: A write helper for the integration test (P1 file)**

In `tools/lib/local-stack.ts` add next to `rest`:

```ts
/** PostgREST write with the service key. LOCAL stack only: it refuses any other URL. */
export async function restWrite(stack: Stack, method: "POST" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<void> {
  assertLocalUrl(stack.url);
  const res = await fetch(`${stack.url}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: stack.serviceKey,
      authorization: `Bearer ${stack.serviceKey}`,
      "content-type": "application/json",
      prefer: "return=minimal",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!res.ok) throw new Error(`rest ${method} ${path} -> HTTP ${res.status}: ${await res.text()}`);
}
```

- [ ] **Step 5: Extend `tools/test-integration.ts` (P1 file)**

Make five edits (names `stack`, `rest`, `count`, `runScan`, `day1`, `day2`, `assert` are P1's):

**a)** Import: `import { assertLocalUrl, callFunction, isTerminal, resolveStack, rest, restWrite, rpc, sleep } from "./lib/local-stack.ts";`

**b)** After the line `const count = async (table: string, filter = "") ... ;` add the watch list (the only way a non-card security such as MSFT gets resolved in the fixture world; it is also the operator's pre-resolve knob):

```ts
// ---------------------------------------------------------------- P6 setup: put MSFT on the EUR watch list (it is not a card in the fixture world)
await restWrite(stack, "PATCH", "app_settings?key=eq.eur_catalogue", {
  value: { enabled: true, require_shares: false, max_resolve_per_run: 40, extra_symbols: ["MSFT"] },
});
const countRows = async (table: string, column: string): Promise<number> => (await rest(stack, `${table}?select=${column}`)).length;
```

**c)** In the idempotency block add two counts to **both** the `before` and the `after` objects: `eur: await count("eur_equivalents"), catalogue: await countRows("ibkr_catalogue", "conid"),`.

**d)** After the line that asserts GOOG and MSF.DE are not canonical (end of the day 1 section) add:

```ts
// ---------------------------------------------------------------- P6: weekly catalogue import and EUR equivalents (fixture providers, no IBKR, no Yahoo)
const catalogue = await rest(stack, "ibkr_catalogue?select=exchange_id,local_symbol,conid&order=exchange_id,conid");
assert.deepEqual(
  catalogue.map((c) => `${c.exchange_id}:${c.local_symbol}`).sort(),
  ["AEB:ADYEN", "AEB:ASML", "AEB:MSFT", "AEB:UNA", "IBIS:APC", "IBIS:MSF", "IBIS:SAP"],
  "both exchanges were imported (EUR stocks only; ETF, USD and tracker rows are filtered out; AEB:MSFT is the synthetic look-alike)",
);
const importState = (await rest(stack, "app_settings?select=value&key=eq.eur_catalogue_state"))[0].value;
assert.equal(importState.last_result, "complete", "the import is recorded as complete");
assert.equal(importState.last_success_week, "2026-W42", "for ISO week 2026-W42");
const eurJobs = await rest(stack, `scan_jobs?select=stage,key,status&scan_run_id=eq.${day1.id}&stage=in.(eur_catalogue,eur_resolve)`);
assert.ok(eurJobs.length >= 2 && eurJobs.every((j) => j.status === "done"), "the EUR jobs finished without failing the scan");
assert.deepEqual(await rest(stack, `scan_events?select=event&scan_run_id=eq.${day1.id}&stage=in.(eur_catalogue,eur_resolve)&level=eq.error`), [], "no error events from the EUR stages");

const msft = (await rest(stack, "securities?select=id,isin&yahoo_symbol=eq.MSFT"))[0];
assert.equal(msft.isin, "US5949181045", "the ISIN confirmed through Yahoo search is stored on the canonical security");
const msftRows = await rest(stack, `eur_equivalents?select=ibkr_exchange_id,ibkr_conid,ibkr_local_symbol,eur_symbol_yahoo,status,verified_at&security_id=eq.${msft.id}`);
assert.deepEqual(
  msftRows.map((r) => [r.ibkr_exchange_id, r.ibkr_local_symbol, r.ibkr_conid, r.eur_symbol_yahoo, r.status]),
  [["IBIS", "MSF", 12178239, "MSF.DE", "verified"]],
  "MSFT resolves to MSF.DE on IBIS, verified; the AEB look-alike with MSFT's ticker (a tracker ETP, MSFT.AS) is rejected and stored nowhere",
);
assert.ok(msftRows[0].verified_at !== null, "a verified line carries its verification time");

const cardsEur = await rest(stack, "v_todays_discounts?select=yahoo_symbol,eur_status,eur_symbol_yahoo&mode=eq.worldwide&order=yahoo_symbol");
assert.deepEqual(
  cardsEur,
  [
    { yahoo_symbol: "1299.HK", eur_status: "none", eur_symbol_yahoo: null },
    { yahoo_symbol: "9988.HK", eur_status: "none", eur_symbol_yahoo: null },
  ],
  "cards without a catalogue candidate say none (the UI shows No verified EUR equivalent), through the public view",
);
```

**e)** After the last day-2 assertion (`assert.equal(await count("scan_runs"), 2, "one run per local date");`) add:

```ts
// ---------------------------------------------------------------- P6: the next day of the same ISO week does not call the catalogue again
const day2Import = (await rest(stack, `scan_jobs?select=status,result&stage=eq.eur_catalogue&scan_run_id=eq.${day2.id}`))[0];
assert.equal(day2Import.status, "done");
assert.equal(day2Import.result.reason, "already_imported_this_week", "weekly import: day 2 of week 42 is skipped");
assert.equal(await countRows("ibkr_catalogue", "conid"), 7, "the catalogue was imported exactly once");
```

- [ ] **Step 6: Run the integration test**

Prerequisites as in P1 Task 19 (`bunx supabase start`, `supabase/functions/.env` with `CRON_SHARED_SECRET` and `ALLOW_FIXTURE_PROVIDERS=1`).
```powershell
bun run test:integration
```
Expected: `integration test passed`. This is the first end-to-end run of the EUR handlers and of both migrations against the real stack: if the scan stops in an EUR stage read `bun run scan:local -- failures`; if `eur_equivalents` has no MSFT row check, in this order, `scan_events` for `eur_resolved` / `eur_resolve_skipped`, whether `app_settings.eur_catalogue.extra_symbols` was written (step 5b), whether the fx stage stored an `EUR` row (`select * from fx_rates where ccy = 'EUR'`), and whether the generated `eur-fixtures.json` MSF.DE price is within 1% of MSFT times FX (`bun run gen:fixtures:eur` prints it). If the MSFT row is `unverified`, read its `verification` document: it lists the failing checks.

- [ ] **Step 7: The end-to-end spec**

`apps/web/e2e/local/handoff.local.spec.ts` (runs with P4's `bun run test:e2e:local`; it creates and removes its own user, broker-connection row, card promotion and one synthetic EUR line; the sign-in labels are P5a's `Email`, `Password` and `Sign in`, adapt them if P5a changed them):

```ts
/**
 * End-to-end check of the "Trade on IBKR" hand-off against the REAL local stack (no API stubs).
 *
 * Setup (PowerShell, from the repository root), once per session, after the Overview spec's setup:
 *   bunx supabase start
 *   bunx supabase db reset
 *   bun run scan:local -- --provider fixture
 *   $s = bunx supabase status -o json | ConvertFrom-Json
 *   $env:VITE_SUPABASE_URL = $s.API_URL
 *   $env:VITE_SUPABASE_ANON_KEY = $s.ANON_KEY
 *   $env:E2E_SERVICE_ROLE_KEY = $s.SERVICE_ROLE_KEY   # used ONLY here, to create a user, a card and one EUR line
 *   bun run test:e2e:local
 *
 * What it creates (and removes afterwards): one confirmed user with a `linked` broker connection (a bare row: nothing is synced), the
 * first card of today's list promoted to green if it is withheld, and ONE synthetic verified EUR line `E2E1` (conid 900000099) for that
 * card's security. The line is synthetic on purpose: the test pins the hand-off, not IBKR's catalogue.
 */
import { randomUUID } from "node:crypto";
import { type APIRequestContext, expect, request as pwRequest, test } from "@playwright/test";

const API = process.env.VITE_SUPABASE_URL ?? "http://127.0.0.1:54321";
const ANON = process.env.VITE_SUPABASE_ANON_KEY ?? "";
const SERVICE = process.env.E2E_SERVICE_ROLE_KEY ?? "";
const PASSWORD = "E2e-Passw0rd-9x";
const PROMPT = "Create buy limit order for 10 shares of E2E1 at 400 and set destination IBIS2";

test.skip(!SERVICE, "needs E2E_SERVICE_ROLE_KEY (local stack only)");
test.skip(
  !["127.0.0.1", "localhost"].includes(new URL(API).hostname),
  "refusing to run against a non-local stack",
);

interface FeedRow {
  withheld: boolean;
  scan_run_id: string;
  security_id: string;
  yahoo_symbol: string;
  operational_category: string;
  category_reason: string;
  conclusion: string | null;
  summary: string | null;
}

let svc: APIRequestContext;
let anon: APIRequestContext;
let card: FeedRow | null = null;
let promoted: Record<string, unknown> | null = null;
let userId: string | null = null;
const email = `e2e-handoff-${randomUUID()}@example.com`;

const cardFilter = (r: FeedRow) =>
  `scan_run_id=eq.${r.scan_run_id}&security_id=eq.${r.security_id}&mode=eq.worldwide`;

test.beforeAll(async () => {
  anon = await pwRequest.newContext({
    baseURL: API,
    extraHTTPHeaders: {
      apikey: ANON,
      Authorization: `Bearer ${ANON}`,
      "Content-Type": "application/json",
    },
  });
  svc = await pwRequest.newContext({
    baseURL: API,
    extraHTTPHeaders: {
      apikey: SERVICE,
      Authorization: `Bearer ${SERVICE}`,
      "Content-Type": "application/json",
    },
  });

  const feed = await anon.post("/rest/v1/rpc/todays_discounts_feed", {
    data: { p_mode: "worldwide" },
  });
  const rows = (await feed.json()) as FeedRow[];
  card = rows.find((r) => !r.withheld) ?? rows[0] ?? null;
  if (card === null) return;

  if (card.withheld) {
    promoted = {
      operational_category: card.operational_category,
      withheld: true,
      category_reason: card.category_reason,
      conclusion: card.conclusion,
      summary: card.summary,
    };
    const res = await svc.patch(`/rest/v1/todays_discounts?${cardFilter(card)}`, {
      data: {
        operational_category: "green",
        withheld: false,
        category_reason: "e2e promotion",
        conclusion: "e2e",
        summary: "e2e fixture card",
      },
    });
    expect(res.ok()).toBe(true);
  }

  const eur = await svc.post("/rest/v1/eur_equivalents?on_conflict=security_id,ibkr_exchange_id", {
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    data: {
      security_id: card.security_id,
      ibkr_exchange_id: "IBIS",
      ibkr_conid: 900000099,
      ibkr_local_symbol: "E2E1",
      eur_symbol_yahoo: "E2E1.DE",
      status: "verified",
      verification: {
        method: "automatic",
        failed: [],
        checks: { isin_confirmed: "pass", price_within_tolerance: "pass" },
      },
      verified_at: new Date().toISOString(),
    },
  });
  expect(eur.ok()).toBe(true);

  const created = await svc.post("/auth/v1/admin/users", {
    data: { email, password: PASSWORD, email_confirm: true },
  });
  expect(created.ok()).toBe(true);
  userId = ((await created.json()) as { id: string }).id;
  const link = await svc.post("/rest/v1/broker_connections", {
    data: { user_id: userId, status: "linked" },
  });
  expect(link.ok()).toBe(true);
});

test.afterAll(async () => {
  if (card !== null) {
    await svc.delete(
      `/rest/v1/eur_equivalents?security_id=eq.${card.security_id}&ibkr_local_symbol=eq.E2E1`,
    );
    if (promoted !== null)
      await svc.patch(`/rest/v1/todays_discounts?${cardFilter(card)}`, { data: promoted });
  }
  if (userId !== null) await svc.delete(`/auth/v1/admin/users/${userId}`); // cascades the connection and the profile
  await svc.dispose();
  await anon.dispose();
});

test("anonymous viewers get a sign-in link and no trade control on the card", async ({ page }) => {
  test.skip(card === null, "the fixture scan published no card");
  await page.goto("/");
  const cardEl = page.locator(`[data-testid="discount-card"][data-symbol="${card?.yahoo_symbol}"]`);
  await expect(cardEl.getByRole("link", { name: "Sign in to trade" })).toBeVisible();
  await expect(cardEl.getByTestId("trade-on-ibkr-button")).toHaveCount(0);
});

test("a linked user opens the hand-off from a card, gets the owner's prompt, and nothing is written", async ({
  page,
  context,
}) => {
  test.skip(card === null, "the fixture scan published no card");
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);

  await page.goto("/auth/sign-in");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.goto("/");

  const cardEl = page.locator(`[data-testid="discount-card"][data-symbol="${card?.yahoo_symbol}"]`);
  await expect(cardEl.getByTestId("trade-on-ibkr-button")).toHaveText("Trade on IBKR");

  const writes: string[] = [];
  page.on("request", (r) => {
    const own = r.url().startsWith(API);
    const read =
      r.method() === "GET" ||
      r.method() === "OPTIONS" ||
      r.url().includes("/rest/v1/rpc/") ||
      r.url().includes("/functions/v1/quotes/") ||
      r.url().includes("/auth/v1/token");
    if (own && !read) writes.push(`${r.method()} ${r.url()}`);
  });

  await cardEl.getByTestId("trade-on-ibkr-button").click();
  const dialog = page.getByTestId("trade-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId("no-order-notice")).toContainText(
    "This app does not place orders.",
  );
  await expect(dialog.getByTestId("listing-badge")).toHaveAttribute("data-status", "verified");
  await expect(dialog.getByText("E2E1", { exact: true })).toBeVisible();
  await expect(dialog.getByText("900000099")).toBeVisible();

  await dialog.getByLabel("Quantity (shares)").fill("10");
  await dialog.getByLabel("Limit price (EUR)").fill("400");
  await expect(dialog.getByTestId("ibot-prompt")).toHaveValue(PROMPT);
  await expect(dialog.getByTestId("ticket-checklist")).toHaveText(
    "On the ticket confirm: conid 900000099 / E2E1 / EUR / destination IBIS2",
  );

  const link = dialog.getByTestId("open-ibkr");
  await expect(link).toHaveAttribute("href", "https://www.interactivebrokers.com/sso/Login");
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(link).toHaveAttribute("rel", /noopener/);

  await dialog.getByTestId("copy-prompt").click();
  await expect(dialog.getByTestId("copy-prompt")).toHaveText("Copied");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(PROMPT);

  await dialog.getByLabel("Limit price (EUR)").fill("400,5");
  await expect(dialog.getByTestId("ibot-prompt")).toHaveCount(0);
  await expect(dialog.getByRole("alert").filter({ hasText: "dot" })).toBeVisible();

  expect(writes).toEqual([]);
});
```

Run, following the setup block at the top of the spec (the service-role key is used only by this spec and never reaches the bundle):
```powershell
bun run test:e2e:local
```
Expected: both tests pass; the second one asserts the owner's prompt text for the synthetic `E2E1` line, the checklist, the login link attributes, the clipboard content, the decimal-comma refusal, the notice text, and that the dialog made no write request. A test skips with a stated reason only when the fixture scan published no card or no service key was provided.

- [ ] **Step 8: The operator guide**

In `docs/operator-guide.md` add a new section after section 13 (P7 owns section 13 and the numbering of what follows; if P5 or P7 already used 14, take the next number):

````markdown
## 14. IBKR hand-off and EUR equivalents (P6)

**What it is.** The `Trade on IBKR` dialog (Overview card for linked users, Portfolio rows) prepares text for IBKR's iBot and tells you what to check on the ticket. **The app never places, changes or cancels an order**; you paste the prompt into iBot (Client Portal, TWS or the mobile app) or build the order yourself, check the ticket, and submit it in IBKR.

**IBIS2 caveat.** `IBIS2` is your own practice for Xetra. It is **not in IBKR's public exchange catalogue** and no IBKR source defines it (third parties disagree), so the dialog labels it `Xetra (IBIS2 — owner practice, not in IBKR's public catalogue)`. If iBot rejects or ignores it, open Profile -> Broker, set **Default destination** to `IBIS` (Xetra, verified in IBKR's catalogue and fee page) and generate the prompt again. Whether iBot parses `set destination ...` inside the sentence is unverified (Q-08): the dialog also shows a documented-style variant (`Buy 10 shares of MSF at 400 limit` plus a note to set the destination on the ticket). Always check conid, EUR currency, destination, quantity and price on the ticket.

**Where the EUR line comes from.** Once a week the `eur_catalogue` stage imports IBKR's public IBIS and AEB product lists (`POST /webrest/search/products-by-exchangeId`, about 35 requests 300 ms apart) into `ibkr_catalogue`. Permission to call these undocumented endpoints programmatically is **unverified** (Q-10: IBKR's website terms were not found; `robots.txt` does not disallow them). The import is weekly, tiny, never runs for a user request, abandons itself for the day after three retries, and records one attempt per day. To stop it:

```sql
update app_settings set value = jsonb_set(value, '{enabled}', 'false'::jsonb) where key = 'eur_catalogue';
```
(or `scan-control set_setting`). Existing rows stay; new securities then resolve to `none` and the dialog offers the manual local-symbol path. Check the last import:

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

**Owner tests (P6-01, P6-02), not automated.** P6-01: in real iBot, paste the generated prompt for at least five instruments (Xetra and Amsterdam, including Unilever `UNA`), including `set destination IBIS2`, and write down what the ticket shows; also test whether `https://portal.interactivebrokers.com/portal/?action=QUOTE&conid=<conid>` opens the instrument after login (Q-08; if yes, a feature-flagged link can be added). P6-02: ask IBKR support, or find the website terms, about programmatic use of `/webrest/*` (Q-10).
````

- [ ] **Step 9: Run everything touched and commit**

```powershell
bun run lint:fix
bun run lint
bun run typecheck
bun run test
bun run functions:check
bun run check:functions-config
bunx supabase db reset
bun run test:db
bun run test:integration
git add tools supabase/functions/_shared/adapters supabase/config.toml apps/web/e2e docs/operator-guide.md package.json
git commit -m "test: integration and end-to-end coverage for the EUR hand-off, EUR fixtures and the operator guide"
```
Expected: everything passes; `git status` shows no stray files.

---

## Task 7: Phase exit checklist

**Depends on:** all tasks. Implementer: sonnet; the lead reviews the output. No new files: this task runs the gates against the final tree and records the evidence. Fixes land in the owning task's files.

- [ ] **Step 1: Run the whole gate, in order, and record each result**

```powershell
bun run lint
bun run typecheck
bun run test
bun run functions:check
bun run check:functions-config
bun run build
bun run check:bundle
bunx supabase db reset
bun run test:db
bun run test:integration
bun run test:e2e:local
bun run test:e2e
```
Expected: every command exits 0. `bun run test` covers core (including `handoff.test.ts`), tools (including `eur-fixtures.test.ts`), web and the Deno suites; `test:db` shows `0600_eur_handoff.test.sql` (59 assertions) and `0601_eur_stage_order.test.sql` (6) passing next to every earlier file; `test:integration` ends `integration test passed`; `test:e2e:local` runs the Overview spec of P4 and `handoff.local.spec.ts`.

- [ ] **Step 2: Prove the EUR mapping never touches screening**

```powershell
git grep -n "handoff" -- supabase/functions/_shared/core ":(exclude)supabase/functions/_shared/core/handoff.ts" ":(exclude)supabase/functions/_shared/core/handoff.test.ts"
git grep -n "eur_equivalents\|ibkr_catalogue\|eur_symbol_yahoo" -- supabase/functions ":(exclude)supabase/functions/worker-tick/handlers/eur_*" ":(exclude)supabase/functions/worker-tick/handlers/eur.test.ts" ":(exclude)supabase/functions/_shared/adapters/fixture-eur*" ":(exclude)supabase/functions/_shared/adapters/ibkr-catalogue*"
git grep -n "eur_equivalents\|ibkr_catalogue" -- supabase/migrations
```
Expected: the first command prints nothing (no other core file knows the hand-off); the second prints nothing (eligibility, ranking, thresholds, classification, publication and the quotes function never read the EUR tables); the third lists only `20261015006000_eur_handoff.sql` and, if P1 created the tables first, P1's core schema migration. Record the three outputs.

- [ ] **Step 3: Check the review-focus pins exist and pass**

```powershell
bun run test:core handoff
bun run test:web handoff
deno test -A --config supabase/functions/deno.json supabase/functions/worker-tick/handlers/eur.test.ts supabase/functions/_shared/adapters/ibkr-catalogue.test.ts
```
Expected: the tests named in the Review Focus section exist and pass (each is listed there by name; `git grep -n "look-alike" -- supabase/functions/worker-tick/handlers/eur.test.ts` and `git grep -n "no-orders notice" -- apps/web/src/features/handoff` find them).

- [ ] **Step 4: Manual smoke on the local stack**

With the local stack running, the fixture scan done and the web app on the dev server: sign in as a user with a `linked` broker connection (or run the e2e spec once), open a card, click `Trade on IBKR`, and check: the notice at the top; the EUR listing block with the badge; no prompt until quantity and price are valid; the prompt text; Copy; the login link opens `https://www.interactivebrokers.com/sso/Login` in a new tab; Profile -> Broker shows `Default destination` and saving changes the pre-selected destination the next time the dialog opens. Write down anything that looked wrong.

- [ ] **Step 5: The owner's exit conditions (spec 18 P6)**

These need the owner and a live IBKR account; the implementer prepares the sheet and the owner fills it in. Record in `docs/operator-guide.md` section 14 (or the phase report) a table with these rows, filled by the owner: five instruments (at least one on IBIS and one on AEB, for example Microsoft `MSF`, SAP `SAP`, ASML `ASML`, Adyen `ADYEN`, Unilever `UNA`), the prompt used, whether iBot built a correct ticket (conid, EUR, destination, quantity, price), and what happened with `set destination IBIS2`. Exit: the owner confirms correct tickets for at least five instruments (IBIS and AEB) and that the dialog states plainly that no order is placed. P6-02 (website terms or IBKR support's answer on `/webrest/*`) is recorded as answered or still open; open does not block the phase but keeps Q-10 open in the decision log.

- [ ] **Step 6: Report to the lead**

Report: the command outputs of step 1, the three outputs of step 2, the list of the decisions P6-D1 to P6-D19 with any change made while implementing, the places where the real P1, P4 or P5 code differed from this plan's assumptions (and the one line changed for each), whether the Portfolio wiring (Task 5 step 14) is done or waiting for P5b, and the open owner items (P6-01, P6-02, Q-08, Q-10).

---

## Self-review

**Spec coverage.**

| Spec | Where |
|---|---|
| 13.1 modal contents: instrument, EUR listing with badge and checks, quote with timestamp and delayed label, inputs, estimate, prompt with Copy, hand-off link, statement, checklist | Task 5 (`eur-listing-panel.tsx`, `trade-on-ibkr-dialog.tsx`, `prompt-panel.tsx`, `derive.ts`), Task 4 (`estimateValue`, `ticketChecklist`, `NO_ORDER_NOTICE`, `TICKET_REVIEW_NOTE`) |
| 13.2 prompt generation, market without price clause (A-38), documented-style variant, local symbol from the catalogue, validated inputs | Task 4 (`buildIbotPrompt`, `buildDocumentedStylePrompt`, `parsePriceInput`, `parseQuantityInput`, `localSymbolProblem`), Task 5 (`derive.ts` uses `listing.localSymbol` only) |
| 13.3 destination preference and availability, `profiles.default_destination` default IBIS2 (A-39) | Task 1 (column, grants, CHECK, pgTAP), Task 4 (`allowedDestinations`, `chooseDestination`), Task 5 (`DefaultDestinationCard`, `useDefaultDestination`, dialog select) |
| 13.4 unverified acknowledgement, none path with a manual unverified symbol | Task 5 (`eur-listing-panel.tsx`, `derive.ts` gates), tests |
| 13.5 card behaviour per viewer (button label `Trade on IBKR`) | Task 5 step 11 (decision P6-D1) |
| 5.7 import (endpoints, headers, pagination at 100, weekly, manual fallback), algorithm steps 1-5, 30-day cache, IBIS then AEB, persistence shape | Task 2, Task 3, Task 1 |
| 6.3 / 6.9 tables, RLS | Task 1 (decision P6-D10 for the catalogue read) |
| 6.6.4 cards view EUR columns, 14.3 / 14.4 subtitle | Task 1 step 4 (view), Task 5 step 11 (P4's `EurLine` unchanged, tests added) |
| 7.4 stages `eur_catalogue`, `eur_resolve`, job keys, caps | Task 3 step 9 (decision P6-D7) |
| 12.7 ISIN from Flex positions feeding the match | Task 3 (`heldIsins` in the store, `knownIsins` in the resolver, `eur_resolve_targets` held branch) |
| 17 testing (Deno for catalogue paging and stage handlers with fakes, `buildIbotPrompt` web/core tests, pgTAP, integration, Playwright) | Tasks 1-6 |
| A-28, A-38, A-39, Q-08, Q-10 | Global Constraints, Task 1 CHECK, Task 4, operator guide section 14, Task 7 step 5 |
| Brief 12 (mapping never changes screening) | Global Constraints, Task 7 step 2 |

**Placeholders and consistency.** No step says "add error handling", "similar to", or leaves a code block empty; every code step contains the complete file. Names used consistently: tables `ibkr_catalogue (exchange_id, conid, symbol, local_symbol, isin, currency, description, product_type, fetched_at)`, `eur_equivalents`, `eur_equivalent_overrides`; enum `eur_status`; settings keys `eur_catalogue` (`enabled`, `require_shares`, `max_resolve_per_run`, `extra_symbols`) and `eur_catalogue_state`; job keys `eur_catalogue:<iso-week>` and `eur:<security_id>`; events `eur_catalogue_imported`, `eur_catalogue_aborted`, `eur_catalogue_failed`, `eur_catalogue_skipped`, `eur_resolved`, `eur_resolve_skipped`; core exports `Destination`, `DESTINATION_LABELS`, `buildIbotPrompt`, `parsePriceInput`, `parseQuantityInput`, `pickListing`, `allowedDestinations`, `chooseDestination`, `estimateValue`, `ticketChecklist`, `localSymbolProblem`, `isValidLocalSymbol`, `NO_ORDER_NOTICE`, `IBKR_LOGIN_URL`; web exports `TradeOnIbkrDialog`, `TradeOnIbkrButton`, `DefaultDestinationCard`, `deriveHandoff`, `holdingTarget`, `handoffApi`; test ids `trade-on-ibkr-button`, `trade-dialog`, `no-order-notice`, `listing-badge`, `quote-block`, `ibot-prompt`, `copy-prompt`, `documented-prompt`, `ticket-checklist`, `open-ibkr`, `estimate`, `prompt-gate`, `destination-note`, `listing-loading`, `listing-error`.

**Unverified or not executed (for the lead):** the two migrations and both pgTAP files (written without a database; the view guard, the audit-trigger generation and the order rewrite are the parts most likely to need a one-line adaptation); `tools/test-integration.ts` and the Playwright spec; every edit to P1 (`stages.ts`, `settings.ts`, `fixture-providers.ts`, `config.toml`, `local-stack.ts`), P4 (`discount-card.tsx` and its tests) and P5a (`broker-page.tsx`, `setup.ts`) files; the Portfolio wiring (P5b has no plan); whether iBot accepts `set destination IBIS2` (Q-08) and whether programmatic use of `/webrest/*` is permitted (Q-10); how the real Yahoo `search(isin)` and `quote()` behave for each candidate (only the spike's 15 pairs are verified, and Unilever's Yahoo line is not).
