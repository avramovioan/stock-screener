# On-demand AI research, home tickers, trade everywhere, portfolio polish — design (2026-10-19)

Owner: Ioan Avramov. Approved mockups: https://claude.ai/artifact/57VRLttSEFrXCopGUhLGMh (sources in
`.superpowers/sdd/2026-10-19-ui-mockups/project/`, six boards: Main, Phone, ScanStates, Holdings, TradeHistory, HowItWorks).
Owner approval 2026-10-19: "Designs are perfect. Do them." with the list of calls below confirmed. This document is what a
builder plans from; the mockups are the visual truth where the two overlap.

## 1. Intent

The free AI quota cannot research every company that lands on the list every day, and most visitors never read most
reports. Research becomes something a visitor asks for, per company, with a cooling-off period, and the daily scan goes
back to being a price screen. Around that, the owner wants the list to look like the real companies it contains (home
tickers, a listing-based US filter, a strict US$50 billion rule), the trade hand-off reachable from every card and every
holding, the portfolio tables free of explanatory small print, filters on the trade history, a plain "How it works" page,
and a way for a visitor to run the evaluation with their own assistant.

## 2. Goals, non-goals, anti-goals

Goals
- A visitor can start one AI research per company every 72 hours from the card; the result is shared with everyone.
- Nobody is researched automatically any more except the signed-in owner's monitored holdings.
- Notifications fire only for companies that are new on the list versus the previous published list.
- Every company shown has a market value of at least US$50 billion by one simple rule.
- The US filter means "listed on a US exchange".
- Trade on IBKR is reachable from every card (linked viewer) and from every holdings row.
- Portfolio tables show numbers; explanations live behind one info icon per column.
- Trade history can be filtered by instrument, type, side, currency and date.
- A visitor can copy a complete evaluation prompt for a company.
- A "How it works" page explains the list, the lines, the scan, the research, notifications and data sources.

Non-goals
- No change to the channel maths, the −3/−4 rules, the Strong buy tag or the ranking.
- No paid AI or search provider; the existing Gemini + Groq + Tavily setup stays.
- No order placement; the hand-off stays a redirect plus a copyable iBot prompt.
- No redesign beyond the approved boards.

Anti-goals (a failure even if it works)
- A visitor burning the day's AI budget on one company, or a bot starting hundreds of scans.
- A card whose research state and buttons disagree with the state the server knows.
- Explanatory text creeping back into table cells.

## 3. Constraints

- Free tiers only. Supabase (Postgres, pg_cron, Edge Functions), Cloudflare static hosting, Yahoo via the existing adapter,
  Gemini primary, Groq backup, Tavily search, Resend e-mail. Existing budgets stay in force (`research` settings:
  `tavily_daily_cap`, `llm_daily_request_cap`, `min_recheck_hours` = 72).
- Migrations forward-only and replay-safe; functions deployed after migrations; the web app built from this branch.
- Everything the public sees is readable by the anon role through views and RPCs with the existing RLS posture; a
  visitor-triggered action never needs a secret in the browser.
- Texts and layout follow the approved boards; the app's tokens and components (IBM Plex Sans, teal primary, shadcn
  primitives in `apps/web/src/components/ui`) are used, no new UI library.
- TDD and the repo's suites (lint, typecheck, core, tools, web, Deno, pgTAP, integration, e2e) stay green.

## 4. Decisions (the owner's, 2026-10-19)

1. Scan with AI is open to anyone visiting the site, rate-limited per network and per company.
2. The United States filter means listed on a US exchange, whatever the company's home country.
3. Trade on IBKR appears on every holdings row; unscreened holdings use the held instrument itself.
4. The market-cap rule stays at US$50 billion but must be one simple formula, no cross-checks between two Yahoo numbers.
   TradingView defines market capitalization as company-level outstanding shares × last close (all classes, treasury
   excluded), a vendor figure we cannot reproduce. The simple, comparable rule here: **market cap = last close × Yahoo's
   `sharesOutstanding` of the home listing**. Yahoo's own `marketCap` field is no longer used for membership. A company
   whose share count excludes other classes is undercounted and may drop out; the owner accepts losing such borderline
   companies (Lindt: 133,905 registered shares × CHF ~130,000 ≈ CHF 17 billion, out).
5. The other calls listed in section 6 were confirmed as proposed.

## 5. Behaviour

### 5.1 Scan with AI (visitor-triggered research)

- New Edge Function `research-request`, public like `quotes` (no JWT, `verify_jwt` false, CORS for the site), `POST
  {"security_id": "<uuid>"}`. Checks, in order, each answered with a JSON body `{ "ok": false, "reason": <code> }` and a
  4xx status:
  - `not_on_list` (404): the security has no row in `todays_discounts` of the latest **published** run (the run with the
    newest `results_published_at`; add a store method `latestPublishedRun()` next to `latestScanRun()`, which returns the
    newest run by date and may be an unpublished one).
  - `in_flight` (409): a report of this security is `running`, `queued` with a wait reason, or `quota_deferred`.
  - `cooldown` (429): the newest `complete` report of the security finished less than `min_recheck_hours` (72 h) ago;
    body carries `next_allowed_at`. A `failed` report never starts a cooldown; after a failed report a new scan is allowed
    once `research.visitor_retry_minutes` (60) have passed since it failed, else `retry_later` (429, with `next_allowed_at`).
  - `network_limit` (429): the hashed IP has already had `research.visitor_scans_per_hour_per_ip` (3) **accepted** requests
    in the current UTC hour. Rejected requests do not count. `_shared/adapters/rate-limit.ts` is generalised from a fixed
    per-minute window to a window parameter (minute | hour) and a key prefix; the existing per-minute use is unchanged. If
    the counter itself fails, the request is refused with `try_later` (fail closed: this action spends quota).
  - `budget_paused` (429): any of: `research.visitor_scans_per_day` (8) accepted today (ledger `ai_quota_usage`, provider
    `visitor`, resource `scans`, period day, reserved on acceptance); fewer than 8 Tavily credits left in today's
    `tavily_daily_cap`; fewer than 10 LLM requests left in `llm_daily_request_cap`; the research kill switch off.
  On success it enqueues one research job through a new `requestVisitorResearch` next to `researchNow`
  (`supabase/functions/scan-control/actions/research_now.ts`): same mechanics (store, job key, `app.kick_workers` picks it
  up within a minute) but run = latest published run, trigger `visitor`, idempotency key
  `<security_id>:visitor:<accepted-at ISO minute>` so a failed report never blocks the next request, payload
  `{ source: "visitor" }`. It answers `{ "ok": true, "report_id", "started_at" }`. The trigger `visitor` behaves like
  `manual` everywhere a trigger is consulted (priority, report class, exemption from the weekday and cadence gates, reuse
  rules); the cooldown is this endpoint's job. The owner's `research_now` keeps `force`.
- Settings (`app_settings.research`, replay-safe defaults, stored values win): `visitor_scans_per_hour_per_ip` 3,
  `visitor_scans_per_day` 8, `visitor_retry_minutes` 60; `tavily_daily_cap` raised from 32 to 60 (the monthly guard of 950
  stays). Each accepted request writes an `audit_events` row (`actor_id` null, `action` `research_request`, `target_type`
  `security`, `target_id` the security id, `details` `{ "source": "visitor", "ip_hash": <daily hash>, "report_id" }`).
- Reports expire for the card after `research.reuse_days` (30): a card whose newest complete report is older than that
  shows "No AI research yet" again (Scan with AI enabled, no cooldown), matching `classify_final`'s existing rule that a
  stale report does not clear a card.
- The daily scan stops seeding `new_discount`, `premium` and `refresh` research and the card change checks. It keeps:
  resuming deferred reports, `monitor_first` and `monitor_change` for monitored holdings (the signed-in owner's portfolio).
  `research_seed.ts` and `risk_check.ts` change accordingly; the `research.required`/`pending` coverage counters count
  only what was actually seeded.
- Card states (the ScanStates board). A card with no report keeps `operational_category = 'pending'` in the database but
  with the new `category_reason` `not_requested` (classify writes it when no report exists and none is in flight; the
  existing `research_pending` stays for a report that is queued or running). The feed `todays_discounts_feed` (extend the
  LATEST definition, `20261015008500_every_rank_minus3.sql`, not the 006000 one; keep its column guard in step) gains
  `research_started_at` (the in-flight report's `started_at`), `research_wait_reason` (its `wait_reason`),
  `research_requested_by` (`usage ->> 'source'`: `visitor` | `owner` | `system` | null) and `research_failed_at` (the
  newest failed report's `completed_at`/`updated_at`, for the retry rule), through a lateral join on the newest
  `research_reports` row per security with status in (`queued`, `running`, `quota_deferred`), and the newest `failed` one;
  `research_reports` is already readable by anon. The web derives: **not scanned** (no complete report within 30 days, no
  in-flight) → "No AI research yet" + Scan with AI (enabled) + Copy the prompt; **running** (in-flight) → progress bar,
  "Started N minutes ago by a visitor. Usually 15 to 40 minutes; the card updates by itself." + disabled "Scanning…" + Copy
  the prompt; a wait reason (`rate_limited`, `provider_unavailable`, `llm_quota`, `search_quota`) is shown as a second line
  "Provider busy, retrying" or "Paused until tomorrow"; **done** → the existing cleared/caution/flagged presentation plus
  "Researched by <model>, <time ago>" and "Next AI scan in N h" (from `research_completed_at` + 72 h) + Copy the prompt;
  **failed** → "The last scan failed" + Scan with AI (enabled once `visitor_retry_minutes` passed, else "Try again in N
  min") + Copy the prompt; **limits reached** → the server's reason rendered as "Scans are paused for now" + the board's
  explanation + disabled Scan with AI + Copy the prompt. The card polls the feed as today (visible poll) so a running scan
  completes without a reload. A `visitor` or `manual` report on a listed company is public (`hasDiscountCard` → public),
  so everyone sees the result.
- Clicking Scan with AI calls the endpoint, then refetches the feed; on a 4xx it shows the matching state without a toast.
- `research_reports.trigger` is `visitor` for these reports; `usage.source = "visitor"` records who asked. `REUSE_TRIGGERS`
  and `PRESERVE_TRIGGERS` in `research_steps.ts` are revisited once `new_discount`, `premium` and `refresh` are no longer
  seeded: `monitor_first` keeps its reuse rule; `visitor`/`manual` never reuse (the endpoint already enforced the cooldown).
- "Trading opens after research clears" is removed (`discount-card.tsx` ~line 209 and its tests in
  `todays-discounts.test.tsx`): the trade control shows for every card for a linked viewer; anonymous and no-broker viewers
  keep the two existing link texts.

### 5.2 Copy the prompt

A text button on every card state. It copies a self-contained prompt built client-side from the feed row, in English:
the role line of the pipeline's research prompt ("My strategy identifies stocks whose prices have fallen substantially
below their historical trend…"), the company name, home ticker, exchange, country, last close with date and the −3/−4
line levels, the two questions of the pipeline (has the business suffered material lasting damage; is the company at risk
of bankruptcy or strong enough to survive), the required output (short conclusion, bankruptcy risk Low/Moderate/High/
Unclear, the facts with sources, limitations), and a sources list: for a US-listed company the SEC EDGAR company search
link for its name and the instruction to read the latest 10-K, 10-Q and 8-K; for others the company's investor relations
site and latest annual and interim reports; for all, news of the last 90 days about the share-price fall. The exact text
is the builder's, kept in one module with a unit test; after copying, the button reads "Copied" for two seconds.

### 5.3 Market cap

`lib/quotes.ts`: `market_cap_native = regularMarketPrice × sharesOutstanding` when both are present; quality `missing`
when either is absent (as today for a missing cap), and a company with a missing value is simply not a member that day
(no carry-forward; Yahoo reports share counts for virtually every large company). `market_cap_snapshots` keeps the same
columns (`market_cap_native`, `shares_outstanding`, `market_cap_usd`). The universe sweep may keep Yahoo's screener
ordering for discovery. Lists, cards and the company table show the computed value. Nothing is rewritten for past runs;
the next scan applies the rule. The "How it works" page explains the rule in one sentence.

### 5.4 Listed-in filter

`public.company_list(p_mode, p_limit, p_after_rank, p_country)` and the discounts feed filter on the **exchange's**
country (`exchanges.country`), not the company's. The feed gains `listing_country`; the web filter and the counts in the
Overview sentence use it. UI copy: "Listed in" with "All exchanges" / "United States"; the deep link stays `?country=us`.
Flags and the identity line keep showing the company's home country.

### 5.5 Home tickers

A shared helper `displayTicker(yahooSymbol, exchangeCode)` returns the exchange-local symbol: strip the Yahoo exchange
suffix (the part after the last "." when the exchange is not a US exchange; `BRK-B` and other dash forms stay). Used on
cards (large ticker), the company table, the Quotes picker, digests and the research page header. The identity line reads
"<Country> · <Exchange name> · Yahoo <yahoo_symbol>" (the Yahoo symbol stays available for search and deep links).

### 5.6 Trade on IBKR everywhere

- Cards: as 5.1, no research gating.
- Holdings table: a last column "Trade" with the button on every row (positions-table and the phone layout). For a
  holding that maps to a screened company the target stays the company's canonical listing (today's logic). For an
  unscreened holding the target is the held instrument: IBKR symbol and listing exchange from the statement
  (`broker_positions.symbol`, `listing_exchange`, `conid`); the hand-off dialog gets a "held instrument" mode that shows
  these as the destination (no EUR lookup, no verification panel) and builds the iBot prompt with `set destination
  <listing exchange>`; where the statement's exchange code is not an IBKR destination the prompt uses `SMART`.
- The Valuation tag for an unscreened holding reads "Not screened" (grey), as on the board.

### 5.7 Holdings info boxes

The grey texts under Price, Value, Unrealized P&L and the tag basis move into a popover opened by an ⓘ button in the column
header (general explanation) and in each cell (that row's facts): source and time of the delayed quote or the statement
close, the FX basis, "Calculated by this app" versus "Broker-reported", the broker FIFO figure, whether it reconciles, and
the tag's meaning. One small box at a time; the table cells carry only numbers and the tag. A `Popover` primitive is added
to `components/ui` (shadcn, Radix) for this; the summary row's explanation uses the same box.

### 5.8 Trade history filters

A filter bar above the table: symbol or name (free text, matches `symbol` and `description`, case-insensitive), type (All,
Stocks and ETFs, Currency (FX), Bonds; derived from `asset_class` or the symbol pattern `AAA.BBB` for FX), side (All, Buy,
Sell), currency (All plus the distinct currencies seen), from and to dates. Filters are applied server-side in the paged
query (PostgREST `ilike`, `eq`, `gte`, `lte`) and mirrored in the URL search params; "Clear filters" resets. The results
line reads "N executions match".

### 5.9 Quotes picker

The Quotes page's stock selector lists every company on today's list in rank order (cards and withheld alike, since most
are unscanned now); the URL `?sid`/`?symbol` resolution is unchanged.

### 5.10 How it works

Route `/how-it-works`, static content exactly as the HowItWorks board (six sections), linked from the Overview sentence
("How it works") and from the footer. Numbers in the text that are settings (US$50 billion, 2,500 closes, ten years, 10:00
Sofia, 72 hours, 25 exchanges, "about 400 companies") are rendered from the public settings/scan status where available,
else written as on the board.

### 5.11 Flex statement entities

`flex-parse.ts` decodes the five predefined XML entities (`&amp; &lt; &gt; &quot; &apos;`) and numeric character references
in attribute values; no DOCTYPE-declared entities are ever expanded (strip a DOCTYPE if present). Fixture and test with
"VANG S&amp;P500 USDD" → "VANG S&P500 USDD".

### 5.12 Notifications

Digest candidates are the companies **new on the list** in the published run compared with the previous published run of
the same mode: a row of `todays_discounts` whose `is_new_episode` is true, or whose `security_id` has no row in the previous
published run's `todays_discounts` for that mode (a company that re-enters after leaving counts as new). Research state is
irrelevant: `notify_discount_candidates` drops its green/amber, `withheld` and `p_finished_only` conditions, and the digest
stage no longer waits for research to finish; digests are built when the list is published and sent at the existing
cut-off and through the existing channels. The digest entry shows the home ticker, name, close, the −3/−4 fact and, when
a complete report exists at build time, its outcome; otherwise "Not researched yet — open the card to start a scan".
Companies that remain on or leave the list send nothing. A-13 carry-over (no `digest_items` row yet) still applies.

## 6. Calls confirmed by the owner (from the mockup review)

Home ticker large with "Country · Exchange · Yahoo SYMBOL" underneath · "Listed in" filter wording · Scan with AI for any
visitor, 72 h per company, a few per hour per network, paused when the budget is spent · Copy the prompt in every state ·
daily scan researches nothing automatically except monitored holdings · notifications only for companies new on the list
· Trade on IBKR on every card (linked viewer) and every holdings row · Quotes picker lists every company on the list ·
holdings small print moves into ⓘ boxes · ampersand bug fixed · trade history filters in the URL · How it works page.

## 6a. Settlements after the builder check (lead's calls)

- Visitor budget: `visitor_scans_per_day` 8 and `tavily_daily_cap` 60 (8 scans × 6 queries fit; the 950 monthly guard
  protects the free tier). Cost if wrong: two settings.
- Failed scans: retry after 60 minutes; failures never start the 72-hour cooldown; accepted requests count toward the
  per-IP and daily limits whatever their outcome.
- Unresearched cards stay `pending` with reason `not_requested` (no new enum value); reports expire for cards after 30 days.
- Digests build at publish time and no longer wait for research.
- The rate limiter counts accepted requests only and fails closed.
- Missing share counts drop the company for the day; no carry-forward.

## 7. Left to the builder

The exact prompt text (5.2); the popover component and its placement details; the FX detection rule for trade history
types; the e2e cases to extend (overview cards, holdings, trade history, how-it-works route); migration file names after
`20261015008700`; the feed view columns' exact names beyond those given here; how the running-state progress bar
estimates progress (elapsed over 40 minutes, capped at 90%, is fine).

## 8. Rollout

Migrations first (`db push`), then all functions, then the web build. The first scan after deploy applies the market-cap
rule and stops auto research; reports already deferred resume on their own. Documentation: operator guide sections for the
new endpoint, the setting, and the changed digest rule; `localtest.md` troubleshooting line for "Scans are paused".
