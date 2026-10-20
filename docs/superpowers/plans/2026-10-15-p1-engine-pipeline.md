# P1 Engine and Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver Phase P1 of the personal stock screener: the pure domain core (units, calendar, Std Dev Channel port, bar cleaning, eligibility, ranking, identity, signal episodes, classification), the market-data adapters (Yahoo, Frankfurter, throttle, session), the database (schema, RLS, SQL pipeline functions, cron), the `worker-tick` pipeline (stages 1-7), `scan-control`, `health`, `retention-cleanup`, local tools, a fixture-mode integration test, and a first live scan whose results are recorded in `docs/discovery/first-live-scan.md`.

**Architecture:** A daily scan is a row in `scan_runs` (unique Sofia date). Stage jobs live in `scan_jobs` and are claimed with leases (`FOR UPDATE SKIP LOCKED`). `pg_cron` starts the scan (two UTC entries plus a Sofia-hour guard) and ticks `worker-tick` every minute through `pg_net` when work exists. `worker-tick` claims jobs, runs the stage handlers (`fx`, `universe_sweep`, `identity`, `fetch_bars`, `compute`, `rank_signals`, `classify`, `publish`), seeds the next stage when the previous one is terminal, and reports honestly (`complete`, `partial`, `failed`). All decisions (indicator, eligibility, ranking, episodes, classification) are pure functions in `supabase/functions/_shared/core`; handlers only move data. All market access goes through provider interfaces; Yahoo is reached only through one throttled fetch.

**Tech Stack:** TypeScript (core: ES2023, no environment globals), Vitest 5 (project `core`), Deno 2 + `deno test` (adapters, functions), Supabase Postgres 17 (pg_cron, pg_net, Vault, pgTAP), `npm:yahoo-finance2@4.0.3`, `@supabase/supabase-js@2.117.3`, Bun (tools).

**Spec:** docs/superpowers/specs/2026-10-15-stock-screener-design.md

## Execution map

| Group | Tasks | Notes |
|---|---|---|
| A core (pure TS, Vitest) | 1-7 | **Tasks 1, 2, 3, 4, 5, 6, 7 can run concurrently** (disjoint files). Task 4 imports `calendar.ts` and Task 5 imports `indicator.ts`, `thresholds.ts` and `units.ts` at type/compile level: when run concurrently, merge Tasks 2 and 3 first or let those agents stub the import. Task 6 imports `ranking.ts` (Task 5), Task 7 imports `thresholds.ts` (Task 5). Safest order inside Group A: (1, 2, 3, 5) then (4, 6, 7). |
| B adapters (Deno) | 8-11 | **Tasks 8, 10, 11 can run concurrently with Group A** (they import only `core/bars.ts` and `core/units.ts`, `core/indicator.ts` from Tasks 1, 3, 4: start them after those land). Task 9 needs Task 8. Task 10 needs Task 9's `QuoteRecord` only as a type (Task 8 `providers.ts`). |
| C database | 12-16 | Sequential. **Can run concurrently with Groups A and B** (SQL does not import TypeScript). |
| D pipeline and tools | 17-21 | After A-C. Task 17 first; Tasks 18 and 19 can run concurrently after 17; Task 20 needs 17-19; Task 21 last. |

## Pre-verified facts this plan relies on (2026-10-15)

- **Frankfurter** `GET https://api.frankfurter.dev/v1/latest?base=USD&symbols=EUR,JPY` returns `{"amount":1.0,"base":"USD","date":"2026-10-14","rates":{"EUR":0.89326,"JPY":158.45}}` (units of currency per USD). It supports 30 currencies (AUD BRL CAD CHF CNY CZK DKK EUR GBP HKD HUF IDR ILS INR ISK JPY KRW MXN MYR NOK NZD PHP PLN RON SEK SGD THB TRY USD ZAR). **SAR, TWD, AED, QAR, KWD are not covered** (silently omitted from a mixed request) and a request whose symbols are all unsupported returns HTTP 404 `{"message":"not found"}`. The Yahoo `XXXUSD=X` fallback is therefore mandatory (Task 10).
- **yahoo-finance2 4.0.3**: `new YahooFinance({ suppressNotices: ["yahooSurvey"], fetch, validation: { logErrors: false } })` accepts a custom `fetch` that sees EVERY request (crumb flow included). With `{ validateResult: false }` `quote()` returns ISO strings for times, `chart()` returns `Date` objects and omits `events` when the window has none; the raw screener returns epoch SECONDS for `regularMarketTime` and epoch MILLISECONDS for `firstTradeDateMilliseconds`. `averageDailyVolume3Month` is present in the recorded quote and screener samples (P1-06 resolved in favour of "present").
- The raw screener flow (`GET https://fc.yahoo.com` cookie `A3`, `GET query1.../v1/test/getcrumb`, `POST query1.../v1/finance/screener`) works from Deno (verified live; the Edge Runtime check is Task 20 / P1-01).
- Supabase local stack: `supabase start` already serves the functions (hot reload) and loads `supabase/functions/.env`; PostgREST returns at most 1,000 rows per request (`max_rows = 1000`); a function that calls `supabase.schema("app").rpc(...)` needs `app` in `[api] schemas` (access is restricted to `service_role` by grants); `static_files` in `config.toml` is required for a function to read a data file at runtime.
- Verified while drafting: all core tests (268), all adapter/lib/loop/validate Deno tests (115) and all pgTAP files (252 assertions) in Tasks 1-16 passed against the code below, and `deno check` passes for every function. **Not executed end to end:** the stage handlers against the local stack (Task 17 steps 14-15 and the integration test of Task 19 are the first real run; expect to debug them), `tools/run-local-scan.ts`, `tools/test-integration.ts`, and the migration edit that moved `is_admin()` to `public` (re-run Task 16 after applying it).

## Global Constraints

**Indicator (spec 4.2).** Defaults `length 2500`, `upper1 x1`, `upper2 x2`, `lower1 -3`, `lower2 -4` (magnitudes applied as -mag), all four modes `true`. `length` integer 3..5000 (warning below 30); multipliers finite and > 0; modes must be booleans (no coercion). Source is `close`; `upDev/dnDev` use `high/low`. Accumulation order of the Pine loops is preserved; `stdDev` divisor is L-1. `isRising(st, end) := end - st > 1e-9 * max(1, |end|, |st|)` (the raw slope sign is never the trend test). Fixture tolerance: `|actual - expected| <= max(1e-12 * |expected|, 1e-9)`. Set-2 lines start one bar later; threshold decisions use only `channel.end.*`. `assertSignalGradeSettings`: only `length` may differ (A-34).

**Eligibility (4.6).** Tier 1: EQUITY; market cap in USD >= 50e9 **inclusive**; canonical; first trade <= scan session day minus 10 years (exactly 10 years passes); valid bars >= `length` (2,500); data fresh and not suspect; channel computed and rising. Tier 2: applicable lower end > 0; finite close; fresh; signal-grade. Market cap stale after 5 calendar days (treated as missing); FX flagged stale after 4 days; carry-forward at most 3 consecutive scans. Rank 1-10 -> `-3`, 11+ or not in the universe -> `-4`. Ties by ascending `yahooSymbol` in UTF-16 code-unit order (never `localeCompare`). US-primary = US exchange (NMS NYQ NGM) AND `financialCurrency` USD AND no higher-volume home listing AND country United States when known; overrides win.

**Bars (4.3).** Convert bar time to the EXCHANGE-LOCAL day (never the UTC date); drop null/NaN/non-finite close, high or low; drop close <= 0; sort and de-duplicate by day keeping the last; drop the forming last bar (rule 4.3.1, 30-minute margin, `marketState` REGULAR only for a bar of today's local day); counts: jump > 50% and missing-session ratio > 0.15, 3 or more jumps -> `suspect`. `mergeIncremental` drift: any overlapping close differing by more than 1e-4 relative, a split newer than the last full refresh, or no overlap -> `adjustmentDrift` (never store a partially merged series; backfill). Stored: split-adjusted, NOT dividend-adjusted, latest 3,300 bars (`yahoo_split_adjusted_close_v1`). Freshness: gap <= 5 days fresh, 6-10 stale, beyond or none unavailable.

**Core purity.** Files in `supabase/functions/_shared/core` import only other core files with `.ts` extensions; no `Date.now()`, no `Math.random()`, no `Deno`/`process`/DOM globals; time is a parameter. `tools/check-core-purity.ts` (P0) and `tsc -p supabase/functions/_shared/core` enforce it. Every relative import inside `supabase/functions/**` carries the `.ts` extension.

**Limits.** Supabase Free: 150 s wall clock, 2 s CPU per request, 256 MB memory, 500 MB database (alarm at 400 MB). `worker-tick`: stop claiming at 85 s, hard deadline 120 s, lease 180 s, claim limit 3 jobs. Yahoo: **at most 3 requests per second from one invocation** (340 ms minimum spacing plus 0-100 ms jitter, concurrency 1), 20 s timeout, 4 attempts with `min(30 s, 1 s * 2^(n-1)) * U(0.5, 1.5)` backoff, `Retry-After` honoured, breaker opens after 5 consecutive 429/5xx for 10 minutes (state in `quote_cache` key `yahoo:breaker`, a breaker-open job is deferred WITHOUT consuming an attempt), 90 s request budget per invocation. Batch sizes: `quote()` 500 symbols, screener page 250, `fetch_bars` 12 securities per job, `compute` 25, `profile` 25, `volume_probe` 12. Tests never touch the network (fixture fetch or an injected client).

**Names.** Tables: `profiles exchanges fx_rates companies securities security_identity_overrides price_series market_cap_snapshots quote_cache app_settings audit_events scan_runs scan_jobs scan_events scan_security_results universe_snapshots universe_membership_events signal_episodes todays_discounts`. Enums: `universe_mode (worldwide, us)`, `signal_kind (discount, premium1, premium2)`, `threshold_line (-3, -4, +1, +2)`, `scan_status (queued, running, partial, complete, failed)`, `job_status (queued, leased, done, failed, dead)`, `job_stage`, `operational_category (green, amber, red, grey, pending)`, `bankruptcy_risk`, `episode_status`, `freshness_status (fresh, stale, unavailable)`, `venue_class (primary, secondary_only, otc)`.

**Idempotency keys.** Scan run `scan_date_local` UNIQUE; job `(scan_run_id, stage, key)`; snapshot and result `(scan_run_id, security_id)`; universe row `(scan_run_id, mode, security_id)` and `(scan_run_id, mode, rank)`; membership event `(scan_run_id, mode, company_id, event)`; episode partial unique `(security_id, kind, mode, threshold_line) WHERE status = 'active'` plus `(security_id, mode) WHERE kind = 'discount' AND status = 'active'`; card `(scan_run_id, mode, security_id)`. Same session re-evaluated = no state change.

**Secrets and logs.** No secret, token, e-mail, crumb or cookie in logs, events, fixtures or errors; `scan_events.data` is redacted (keys matching `/token|secret|key|email|authorization/i`, so event fields must not be NAMED `key`; use `job`), credentials inside URL strings are masked. `.ts` files that read `SUPABASE_SERVICE_ROLE_KEY` run only in Edge Functions or local tools.

### Decisions recorded (deviations from the brief and the spec; the lead must record them)

1. **Function names follow the spec, not the task brief:** `app.reap_expired_leases` (brief: `reap_leases`), `public.universe_summary` (brief: `short_summary`), `public.get_price_series` (brief: `price_series_for`), view `public.v_todays_discounts` (brief: `todays_discounts_public`), `company_list(p_mode, p_limit default 15, p_after_rank default null)` (spec parameter order), `claim_jobs(... p_stages job_stage[] ...)`.
2. **Vault names follow the spec** (`project_url` without the `/functions/v1` suffix, `worker_tick_secret`) and `net.http_post` uses `timeout_milliseconds := 145000` (spec 6.6.3) instead of 5000: the worker answers 202 at once, so a long client timeout costs nothing and guards against a platform that cancels on disconnect (Q-02).
3. **`public.company_list` is `SECURITY DEFINER`** (spec: invoker) because it reads `market_cap_snapshots`, which anon must not read.
4. **`is_admin()` lives in `public`** (spec: `app`) because P0's pgTAP smoke test pins that `authenticated` has no USAGE on schema `app`.
5. **`start_daily_scan` seeds only the `fx` job** (spec 6.6.1); later stages are seeded by `app.next_stage_to_seed` because the sweep needs the FX rows. It has a fourth parameter `p_snapshot_extra jsonb` (fixture runs carry `provider_mode` and `fixture_set`). `ensure_scan_today` takes `p_now` so it is testable.
6. **Additional SQL functions:** `app.defer_job` (reschedule without consuming an attempt), `app.heartbeat_job`, `app.next_stage_to_seed`, `app.purge_expired`, `app.database_size`, `app.apply_quote_rows`, `app.apply_identity_groups` (bulk, transactional data application). `seed_stage` takes `p_payloads jsonb` (a JSON array) because PostgREST passes arrays of objects as JSON. A job table column `scan_jobs.created_at` was added (spec 6.1 requires it).
7. **Fixture runs judge deadlines against `started_at + 1 hour`**, never the real clock, so a replayed past date is not killed by the 22:00 hard deadline.
8. **Provider interface file is `adapters/providers.ts`** (brief) but the interfaces are the spec 5.1 ones: `quote`, `chart`, `profile`, `news`, `screen`, `search` (the brief's `quoteBatch`, `screenerPage`, `quoteSummary` are these).
9. **Core signature additions (all additive):** `ChartMeta.sessionCloseLocal`, `mergeIncremental(stored, fresh, opts?: { newerSplit })`, `Observation.prevApplicableLine` (the spec pseudo-code reads it), `freshnessOf` in `calendar.ts`, `seriesStats` in `bars.ts`, `carryForwardEligible` in `eligibility.ts`, `applyForceCanonical` and an options object with `isHistoryEligible` on `chooseCanonical`, `MergedEntry` defined as `{ companyId, primary, alsoIn }`, `classifyHolding` in `thresholds.ts` (spec 8.6). `isFormingLastBar`: a REGULAR `marketState` only forces "forming" for a bar of today's exchange-local day (otherwise a completed bar would be dropped before Yahoo creates today's bar).
10. **Universe seeds:** `mic` is left null (not evidenced); secondary_only and otc venues are seeded with `screener_enabled = false` so the sweep covers only primary venues (about 28 exchanges).
11. **`quote-enrich` is kept** but only for securities whose snapshot is not `ok` or lacks shares/first-trade date (screener rows already carry the quote-family fields); `group` runs last in the `identity` stage (priority 200, defers while sibling jobs are open).
12. **Membership events** are written by `rank_signals` only when list coverage >= 95% and a previous list-published snapshot exists (the first run is a baseline); list coverage counts `processed + insufficient_data + skipped` (a short history is not a gap).
13. **`portfolio_scan`** is not part of the P1 pipeline (no holdings before P5); premium episodes are implemented and tested in core only.
14. **Adapters import map:** `yahoo-finance2` is loaded with `import("npm:yahoo-finance2@4.0.3")` so the per-function import maps stay identical (`tools/check-functions-config.ts`).

## Review Focus

Five failure modes most likely to bite, each pinned by tests in the owning task:

1. **A forming bar sneaking in as a completed close.** Task 4 (`isFormingLastBar` on the five observed states, the 30-minute margin, REGULAR with an earlier-day bar, weekend, no trading period; `cleanBars` SAP.DE null bar plus forming bar) and Task 9 (the same rule on the recorded SAP.DE, AAPL, 7203.T and 0700.HK samples).
2. **A split rewriting history and a partially merged series.** Task 4 (`mergeIncremental`: split-scaled overlap, newer split flag, no overlap, late correction below 1e-4) and Task 17 (`fetch_bars` never writes on drift and seeds `backfill:<id>`).
3. **The 07:00/08:00 UTC double start.** Task 2 (every day of 2026: exactly one of the two firings passes; 2026-03-29 and 2026-10-25) and Task 16 (pgTAP `start_daily_scan` on both change days, summer, winter, double call, catch-up).
4. **A rank change flipping thresholds mid-episode.** Task 7 (spec 8.4 and 8.8 vectors: close plus silent continuation, re-threshold open, idempotent replay) and Task 19 (day 2 moves 1299.HK from rank 10 to 11 and closes its episode with `threshold_changed`).
5. **GBp prices mixed with GBP market caps.** Task 1 (`toMajor`), Task 5 (SHEL.L: dividing the cap by 100 would wrongly eject the company), Task 9 (recorded SHEL.L keeps `GBp` and a GBP cap), Task 16 (pgTAP `apply_quote_rows` stores the native cap undivided).

---
### Task 1: units.ts

**Parallelism:** can run concurrently with Tasks 2, 3, 8, 11, 12.

**Files:**
- Create: `supabase/functions/_shared/core/units.ts`
- Test: `supabase/functions/_shared/core/units.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `CurrencyUnit`, `resolveCurrency(code)`, `toMajor(amount, code)`

- [ ] **Step 1: Write the failing test**

**`supabase/functions/_shared/core/units.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { resolveCurrency, toMajor } from "./units.ts";

describe("resolveCurrency", () => {
  it.each([
    ["GBp", "GBP", 100],
    ["ZAc", "ZAR", 100],
    ["ILA", "ILS", 100],
    ["KWF", "KWD", 1000],
  ])("maps minor unit %s to %s / %i", (code, major, divisor) => {
    expect(resolveCurrency(code)).toEqual({ major, divisor });
  });

  it("passes major currencies through with divisor 1", () => {
    expect(resolveCurrency("GBP")).toEqual({ major: "GBP", divisor: 1 });
    expect(resolveCurrency("USD")).toEqual({ major: "USD", divisor: 1 });
  });

  it("passes an unknown code through unchanged", () => {
    expect(resolveCurrency("XYZ")).toEqual({ major: "XYZ", divisor: 1 });
  });

  it("is case sensitive: GBP and GBp differ", () => {
    expect(resolveCurrency("GBP").divisor).toBe(1);
    expect(resolveCurrency("GBp").divisor).toBe(100);
  });

  it("does not resolve Object.prototype keys as currencies", () => {
    expect(resolveCurrency("constructor")).toEqual({ major: "constructor", divisor: 1 });
    expect(resolveCurrency("__proto__")).toEqual({ major: "__proto__", divisor: 1 });
  });

  it("returns a fresh object that callers cannot use to mutate the table", () => {
    const first = resolveCurrency("GBp");
    first.divisor = 1;
    expect(resolveCurrency("GBp").divisor).toBe(100);
  });
});

describe("toMajor", () => {
  it("divides a GBp price into GBP", () => {
    expect(toMajor(3950, "GBp")).toBe(39.5);
  });
  it("divides KWF by 1000", () => {
    expect(toMajor(2500, "KWF")).toBe(2.5);
  });
  it("leaves a major-unit price alone", () => {
    expect(toMajor(123.45, "EUR")).toBe(123.45);
  });
  it("leaves an unknown code alone", () => {
    expect(toMajor(10, "XYZ")).toBe(10);
  });
});
```

- [ ] **Step 2: Run it: `bun run test:core -- supabase/functions/_shared/core/units.test.ts`; Expected: FAIL (Failed to resolve import ./units.ts)**

- [ ] **Step 3: Implement**

**`supabase/functions/_shared/core/units.ts`**

```ts
export interface CurrencyUnit {
  major: string;
  divisor: number;
}

// Only GBp is verified in the data (spike 3.3); ZAc, ILA and KWF follow Yahoo conventions (assumption A-03, verified in P1-04).
const MINOR_UNITS: ReadonlyMap<string, CurrencyUnit> = new Map<string, CurrencyUnit>([
  ["GBp", { major: "GBP", divisor: 100 }],
  ["ZAc", { major: "ZAR", divisor: 100 }],
  ["ILA", { major: "ILS", divisor: 100 }],
  ["KWF", { major: "KWD", divisor: 1000 }],
]);

/** GBp -> { major: "GBP", divisor: 100 }. Unknown codes pass through as { major: code, divisor: 1 }. */
export function resolveCurrency(code: string): CurrencyUnit {
  const unit = MINOR_UNITS.get(code);
  return unit === undefined ? { major: code, divisor: 1 } : { major: unit.major, divisor: unit.divisor };
}

/**
 * Converts a PRICE quoted in `code` into the major unit. Market caps are already reported in the
 * major unit by Yahoo (SHEL.L: currency GBp, marketCap in GBP), so they must never go through this function.
 */
export function toMajor(amount: number, code: string): number {
  return amount / resolveCurrency(code).divisor;
}
```

- [ ] **Step 4: Run; Expected: PASS** `bun run test:core -- supabase/functions/_shared/core/units.test.ts` (13 tests).

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/core/units.ts supabase/functions/_shared/core/units.test.ts
git commit -m "feat(core): currency minor units"
```

---
### Task 2: calendar.ts

**Parallelism:** can run concurrently with Tasks 1, 3, 8, 11, 12.

**Files:**
- Create: `supabase/functions/_shared/core/calendar.ts`
- Test: `supabase/functions/_shared/core/calendar.test.ts`

**Interfaces:**
- Consumes: nothing (`Intl.DateTimeFormat` only)
- Produces: `SOFIA`, `LocalParts`, `localParts`, `dayNumber`, `fromDayNumber`, `isoDate`, `scanDateLocal`, `isScanStartHour`, `subtractYears`, `isFresh`, `expectedWeekdays` (spec 4.4) plus `isoWeekdayOf`, `localDayNumber`, `freshnessOf`, `STALE_LIMIT_DAYS`

- [ ] **Step 1: Write the failing test**

**`supabase/functions/_shared/core/calendar.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import {
  SOFIA,
  dayNumber,
  expectedWeekdays,
  freshnessOf,
  fromDayNumber,
  isFresh,
  isScanStartHour,
  isoDate,
  isoWeekdayOf,
  localDayNumber,
  localParts,
  scanDateLocal,
  subtractYears,
} from "./calendar.ts";

const utc = (iso: string) => Date.parse(iso);

describe("dayNumber / fromDayNumber", () => {
  it("anchors 1970-01-01 at 0", () => {
    expect(dayNumber(1970, 1, 1)).toBe(0);
    expect(dayNumber(1970, 1, 2)).toBe(1);
    expect(dayNumber(1969, 12, 31)).toBe(-1);
  });
  it("matches Date.UTC for sample dates over a century", () => {
    for (let y = 1990; y <= 2090; y += 3) {
      for (const [m, d] of [[1, 1], [2, 28], [3, 1], [7, 15], [12, 31]] as const) {
        expect(dayNumber(y, m, d)).toBe(Math.floor(Date.UTC(y, m - 1, d) / 86_400_000));
      }
    }
  });
  it("round-trips every day over 1900..2100", () => {
    const from = dayNumber(1900, 1, 1);
    const to = dayNumber(2100, 12, 31);
    for (let n = from; n <= to; n++) {
      const { year, month, day } = fromDayNumber(n);
      expect(dayNumber(year, month, day)).toBe(n);
    }
  });
  it("handles leap days (2000 is leap; 1900 and 2100 are not)", () => {
    expect(fromDayNumber(dayNumber(2000, 2, 29))).toEqual({ year: 2000, month: 2, day: 29 });
    expect(dayNumber(1900, 3, 1) - dayNumber(1900, 2, 28)).toBe(1);
    expect(dayNumber(2100, 3, 1) - dayNumber(2100, 2, 28)).toBe(1);
  });
  it("formats ISO dates with zero padding", () => {
    expect(isoDate(dayNumber(2026, 3, 5))).toBe("2026-03-05");
    expect(isoDate(dayNumber(2026, 10, 25))).toBe("2026-10-25");
  });
  it("derives ISO weekdays", () => {
    expect(isoWeekdayOf(0)).toBe(4); // Thursday
    expect(isoWeekdayOf(dayNumber(2026, 10, 15))).toBe(4);
    expect(isoWeekdayOf(dayNumber(2026, 10, 17))).toBe(6);
    expect(isoWeekdayOf(dayNumber(2026, 10, 18))).toBe(7);
    expect(isoWeekdayOf(-1)).toBe(3);
  });
});

describe("localParts", () => {
  it("returns Sofia wall-clock fields in summer (UTC+3)", () => {
    expect(localParts(utc("2026-07-15T07:00:00Z"), SOFIA)).toEqual({
      year: 2026, month: 7, day: 15, hour: 10, minute: 0, second: 0, isoWeekday: 3,
    });
  });
  it("uses a 24-hour clock at local midnight (no hour 24)", () => {
    const p = localParts(utc("2026-07-14T21:00:00Z"), SOFIA);
    expect(p.hour).toBe(0);
    expect(p.day).toBe(15);
  });
});

describe("Sofia scan start hour (DST guard)", () => {
  const cases: Array<[string, string, boolean]> = [
    ["ordinary summer day 07:00Z (10:00 EEST)", "2026-07-15T07:00:00Z", true],
    ["ordinary summer day 08:00Z (11:00 EEST)", "2026-07-15T08:00:00Z", false],
    ["ordinary winter day 07:00Z (09:00 EET)", "2026-01-15T07:00:00Z", false],
    ["ordinary winter day 08:00Z (10:00 EET)", "2026-01-15T08:00:00Z", true],
    ["spring change 2026-03-29 07:00Z (already EEST)", "2026-03-29T07:00:00Z", true],
    ["spring change 2026-03-29 08:00Z", "2026-03-29T08:00:00Z", false],
    ["autumn change 2026-10-25 07:00Z (already EET)", "2026-10-25T07:00:00Z", false],
    ["autumn change 2026-10-25 08:00Z", "2026-10-25T08:00:00Z", true],
  ];
  it.each(cases)("%s -> %s", (_label, iso, expected) => {
    expect(isScanStartHour(utc(iso))).toBe(expected);
  });

  it("exactly one of the two cron firings passes on every day of 2026", () => {
    for (let n = dayNumber(2026, 1, 1); n <= dayNumber(2026, 12, 31); n++) {
      const base = n * 86_400_000;
      const passes = [7, 8].filter((h) => isScanStartHour(base + h * 3_600_000));
      expect(passes).toHaveLength(1);
    }
  });

  it("derives the Sofia scan date", () => {
    expect(scanDateLocal(utc("2026-03-29T07:00:00Z"))).toBe("2026-03-29");
    expect(scanDateLocal(utc("2026-10-25T08:00:00Z"))).toBe("2026-10-25");
    expect(scanDateLocal(utc("2026-12-31T22:30:00Z"))).toBe("2027-01-01");
  });
});

describe("exchange session days from bar timestamps (never the UTC date)", () => {
  it("AAPL bar 2026-10-14T13:30Z is the 2026-10-14 New York session", () => {
    expect(isoDate(localDayNumber(utc("2026-10-14T13:30:00Z"), "America/New_York"))).toBe("2026-10-14");
  });
  it("0700.HK bar 2026-10-15T01:30Z is the 2026-10-15 Hong Kong session", () => {
    expect(isoDate(localDayNumber(utc("2026-10-15T01:30:00Z"), "Asia/Hong_Kong"))).toBe("2026-10-15");
  });
  it("7203.T bar 2026-10-15T00:00Z is the 2026-10-15 Tokyo session", () => {
    expect(isoDate(localDayNumber(utc("2026-10-15T00:00:00Z"), "Asia/Tokyo"))).toBe("2026-10-15");
  });
  it("ASX open 2026-10-14T23:00Z belongs to the 2026-10-15 session (the UTC date is a day early)", () => {
    expect(isoDate(localDayNumber(utc("2026-10-14T23:00:00Z"), "Australia/Sydney"))).toBe("2026-10-15");
  });
  it("New York bars either side of the March DST change keep their local date", () => {
    expect(isoDate(localDayNumber(utc("2026-03-06T14:30:00Z"), "America/New_York"))).toBe("2026-03-06");
    expect(isoDate(localDayNumber(utc("2026-03-09T13:30:00Z"), "America/New_York"))).toBe("2026-03-09");
  });
});

describe("subtractYears", () => {
  it("moves Feb 29 to Feb 28 in a non-leap target year", () => {
    expect(isoDate(subtractYears(dayNumber(2024, 2, 29), 10))).toBe("2014-02-28");
  });
  it("keeps Feb 29 when the target year is a leap year", () => {
    expect(isoDate(subtractYears(dayNumber(2024, 2, 29), 4))).toBe("2020-02-29");
  });
  it("is exact for ordinary dates", () => {
    expect(isoDate(subtractYears(dayNumber(2026, 10, 14), 10))).toBe("2016-10-14");
  });
});

describe("freshness", () => {
  const scan = dayNumber(2026, 10, 15);
  it("isFresh: a gap equal to the limit is fresh, one more is not", () => {
    expect(isFresh(scan - 5, scan, 5)).toBe(true);
    expect(isFresh(scan - 6, scan, 5)).toBe(false);
  });
  it("freshnessOf: fresh <= 5, stale 6..10, unavailable beyond 10 or without a bar", () => {
    expect(freshnessOf(scan - 5, scan, 5)).toBe("fresh");
    expect(freshnessOf(scan - 6, scan, 5)).toBe("stale");
    expect(freshnessOf(scan - 10, scan, 5)).toBe("stale");
    expect(freshnessOf(scan - 11, scan, 5)).toBe("unavailable");
    expect(freshnessOf(null, scan, 5)).toBe("unavailable");
  });
});

describe("expectedWeekdays", () => {
  const mon = dayNumber(2026, 10, 12);
  it("counts Monday..Friday over one week", () => {
    expect(expectedWeekdays(mon, mon + 6, [1, 2, 3, 4, 5])).toBe(5);
  });
  it("counts Sunday..Thursday for Saudi Arabia", () => {
    expect(expectedWeekdays(mon, mon + 6, [7, 1, 2, 3, 4])).toBe(5);
  });
  it("is inclusive on both ends and zero for an inverted span", () => {
    expect(expectedWeekdays(mon, mon, [1])).toBe(1);
    expect(expectedWeekdays(mon + 1, mon, [1, 2, 3, 4, 5])).toBe(0);
  });
});
```

- [ ] **Step 2: Run it: `bun run test:core -- supabase/functions/_shared/core/calendar.test.ts`; Expected: FAIL (Failed to resolve import ./calendar.ts)**

- [ ] **Step 3: Implement**

**`supabase/functions/_shared/core/calendar.ts`**

```ts
export const SOFIA = "Europe/Sofia";

export interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  isoWeekday: number;
}

/** Freshness classification limit (assumption A-10): `fresh` up to the exchange's max gap, `stale` up to 10 days, then `unavailable`. */
export const STALE_LIMIT_DAYS = 10;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (f === undefined) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formatters.set(tz, f);
  }
  return f;
}

/** Days since 1970-01-01 of a proleptic Gregorian date (days-from-civil algorithm). */
export function dayNumber(y: number, m: number, d: number): number {
  const yy = m <= 2 ? y - 1 : y;
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400;
  const mp = (m + 9) % 12; // March = 0 ... February = 11
  const doy = Math.floor((153 * mp + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

export function fromDayNumber(n: number): { year: number; month: number; day: number } {
  const z = n + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp < 10 ? mp + 3 : mp - 9;
  const year = yoe + era * 400 + (month <= 2 ? 1 : 0);
  return { year, month, day };
}

/** ISO weekday (Monday = 1 ... Sunday = 7) of a day number. 1970-01-01 was a Thursday (4). */
export function isoWeekdayOf(dayN: number): number {
  return ((((dayN + 3) % 7) + 7) % 7) + 1;
}

export function localParts(epochMs: number, tz: string): LocalParts {
  const parts = formatterFor(tz).formatToParts(new Date(epochMs));
  const get = (type: Intl.DateTimeFormatPartTypes): number => {
    const p = parts.find((x) => x.type === type);
    if (p === undefined) throw new Error(`Intl returned no ${type} part for ${tz}`);
    return Number(p.value);
  };
  const year = get("year");
  const month = get("month");
  const day = get("day");
  return {
    year,
    month,
    day,
    hour: get("hour"),
    minute: get("minute"),
    second: get("second"),
    isoWeekday: isoWeekdayOf(dayNumber(year, month, day)),
  };
}

export function isoDate(n: number): string {
  const { year, month, day } = fromDayNumber(n);
  const pad = (v: number, w: number) => String(v).padStart(w, "0");
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`;
}

/** Exchange-local calendar day of an instant, as a day number. Never use the UTC date of a bar timestamp. */
export function localDayNumber(epochMs: number, tz: string): number {
  const p = localParts(epochMs, tz);
  return dayNumber(p.year, p.month, p.day);
}

/** Europe/Sofia date of the instant, "YYYY-MM-DD". */
export function scanDateLocal(epochMs: number): string {
  return isoDate(localDayNumber(epochMs, SOFIA));
}

/** True when the Sofia hour is 10: the only mapping from UTC cron firings to 10:00 local (no DST table). */
export function isScanStartHour(epochMs: number): boolean {
  return localParts(epochMs, SOFIA).hour === 10;
}

/** Feb 29 minus N years lands on Feb 28 when the target year is not a leap year. */
export function subtractYears(dayN: number, years: number): number {
  const { year, month, day } = fromDayNumber(dayN);
  const target = year - years;
  const leap = (target % 4 === 0 && target % 100 !== 0) || target % 400 === 0;
  const d = month === 2 && day === 29 && !leap ? 28 : day;
  return dayNumber(target, month, d);
}

export function isFresh(lastSessionDay: number, scanDay: number, maxGapDays: number): boolean {
  return scanDay - lastSessionDay <= maxGapDays;
}

export type FreshnessClass = "fresh" | "stale" | "unavailable";

/** fresh: gap <= maxGapDays (5); stale: up to 10 days; unavailable: beyond that or when no bar exists (A-10). */
export function freshnessOf(lastSessionDay: number | null, scanDay: number, maxGapDays: number): FreshnessClass {
  if (lastSessionDay === null) return "unavailable";
  const gap = scanDay - lastSessionDay;
  if (gap <= maxGapDays) return "fresh";
  if (gap <= STALE_LIMIT_DAYS) return "stale";
  return "unavailable";
}

/** Count of days in [fromDay, toDay] (inclusive) whose ISO weekday is in tradingDays. Statistics only; never rejects a session. */
export function expectedWeekdays(fromDay: number, toDay: number, tradingDays: readonly number[]): number {
  const set = new Set(tradingDays);
  let count = 0;
  for (let n = fromDay; n <= toDay; n++) {
    if (set.has(isoWeekdayOf(n))) count++;
  }
  return count;
}
```

- [ ] **Step 4: Run; Expected: PASS** `bun run test:core -- supabase/functions/_shared/core/calendar.test.ts` (31 tests, including the 2026-03-29 and 2026-10-25 07:00Z/08:00Z cases and every day of 2026).

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/core/calendar.ts supabase/functions/_shared/core/calendar.test.ts
git commit -m "feat(core): calendar and Sofia scan-start guard"
```

---
### Task 3: indicator.ts (Std Dev Channel port)

**Parallelism:** can run concurrently with Tasks 1, 2, 8, 11, 12.

**Files:**
- Create: `supabase/functions/_shared/core/indicator.ts`
- Create: `supabase/functions/_shared/core/fixtures/stddevchn-synthetic.json` (copy of `docs/discovery/fixtures/stddevchn-synthetic.json`)
- Test: `supabase/functions/_shared/core/indicator.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `IndicatorSettings`, `DEFAULT_SETTINGS`, `SettingsIssue`, `validateSettings`, `assertSignalGradeSettings`, `OhlcSeries`, `Segment`, `Channel`, `ChannelOutcome`, `computeChannel`, `isRising`, `valueAt` exactly as spec 4.2

- [ ] **Step 1: Copy the parity fixtures (all nine, F1-F9, are used by the test)**

```bash
mkdir -p supabase/functions/_shared/core/fixtures
cp docs/discovery/fixtures/stddevchn-synthetic.json supabase/functions/_shared/core/fixtures/stddevchn-synthetic.json
```

- [ ] **Step 2: Write the failing test**

**`supabase/functions/_shared/core/indicator.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import fixtures from "./fixtures/stddevchn-synthetic.json";
import {
  DEFAULT_SETTINGS,
  assertSignalGradeSettings,
  computeChannel,
  isRising,
  validateSettings,
  valueAt,
  type Channel,
  type IndicatorSettings,
  type Segment,
} from "./indicator.ts";

interface LineExpect {
  start: number;
  end: number;
  startBarOffsetFromWindowStart?: number;
}
interface Fixture {
  id: string;
  length: number;
  inputs: { close: number[]; high: number[]; low: number[] };
  settings: Omit<IndicatorSettings, "length">;
  expected: null | {
    slope: number;
    average: number;
    intercept: number;
    stPrice: number;
    endPrice: number;
    stdDev: number;
    pearsonR: number;
    upDev: number;
    dnDev: number;
    lines: Record<"base" | "upper1" | "upper2" | "lower1" | "lower2", LineExpect>;
    risingChannel: boolean;
    lower2EndAboveZero: boolean;
  };
}

const all = fixtures as unknown as Fixture[];
const byId = (id: string): Fixture => {
  const f = all.find((x) => x.id === id);
  if (f === undefined) throw new Error(`fixture ${id} missing`);
  return f;
};

/** |actual - expected| <= max(1e-12 * |expected|, 1e-9)  (D10, pine 6) */
function near(actual: number, expected: number, label: string): void {
  const tol = Math.max(1e-12 * Math.abs(expected), 1e-9);
  expect(Math.abs(actual - expected), `${label}: ${actual} vs ${expected}`).toBeLessThanOrEqual(tol);
}

function run(f: Fixture): Channel {
  const out = computeChannel(f.inputs, { length: f.length, ...f.settings });
  if (!out.ok) throw new Error(`${f.id}: ${out.reason}`);
  return out.channel;
}

function checkFixture(f: Fixture): void {
  const e = f.expected;
  if (e === null) throw new Error("fixture has no expectation");
  const ch = run(f);
  near(ch.slope, e.slope, "slope");
  near(ch.average, e.average, "average");
  near(ch.intercept, e.intercept, "intercept");
  near(ch.stPrice, e.stPrice, "stPrice");
  near(ch.endPrice, e.endPrice, "endPrice");
  near(ch.stdDev, e.stdDev, "stdDev");
  near(ch.pearsonR, e.pearsonR, "pearsonR");
  near(ch.upDev, e.upDev, "upDev");
  near(ch.dnDev, e.dnDev, "dnDev");
  const segs: Array<["base" | "upper1" | "upper2" | "lower1" | "lower2", Segment]> = [
    ["base", ch.base],
    ["upper1", ch.upper1],
    ["upper2", ch.upper2],
    ["lower1", ch.lower1],
    ["lower2", ch.lower2],
  ];
  for (const [name, seg] of segs) {
    const line = e.lines[name];
    near(seg.y1, line.start, `${name}.start`);
    near(seg.y2, line.end, `${name}.end`);
    expect(seg.x1).toBe(ch.windowStartIndex + (line.startBarOffsetFromWindowStart ?? 0));
    expect(seg.x2).toBe(ch.lastIndex);
  }
  near(ch.end.base, e.lines.base.end, "end.base");
  near(ch.end.upper1, e.lines.upper1.end, "end.upper1");
  near(ch.end.upper2, e.lines.upper2.end, "end.upper2");
  near(ch.end.lower1, e.lines.lower1.end, "end.lower1");
  near(ch.end.lower2, e.lines.lower2.end, "end.lower2");
  expect(ch.rising).toBe(e.risingChannel);
  expect(ch.end.lower2 > 0).toBe(e.lower2EndAboveZero);
}

describe("indicator parity fixtures (stddevchn-synthetic.json)", () => {
  it("contains the nine fixtures F1..F9", () => {
    expect(all.map((f) => f.id)).toEqual(["F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9"]);
  });

  for (const id of ["F1", "F2", "F3", "F4", "F5", "F6", "F7", "F9"]) {
    it(`${id}: every level matches (relative 1e-12, absolute floor 1e-9)`, () => {
      checkFixture(byId(id));
    });
  }

  it("F1: rising channel has raw slope -1 and set-2 lines start one bar later", () => {
    const ch = run(byId("F1"));
    expect(ch.slope).toBe(-1);
    expect(ch.rising).toBe(true);
    expect(ch.upper2.x1).toBe(ch.upper1.x1 + 1);
    expect(ch.lower2.x1).toBe(ch.lower1.x1 + 1);
  });

  it("F2: falling channel has raw slope +1 and is not rising", () => {
    const ch = run(byId("F2"));
    expect(ch.slope).toBe(1);
    expect(ch.rising).toBe(false);
  });

  it("F3: a flat series is not rising", () => {
    const ch = run(byId("F3"));
    expect(ch.stdDev).toBe(0);
    expect(ch.pearsonR).toBe(0);
    expect(ch.rising).toBe(false);
  });

  it("F4: script-order slope differs from the exact rational by about 1.2e-14 relative", () => {
    const ch = run(byId("F4"));
    const exact = -0.7107142857142857;
    const rel = Math.abs(ch.slope - exact) / Math.abs(exact);
    expect(rel).toBeGreaterThan(1e-15);
    expect(rel).toBeLessThan(1e-13);
  });

  it("F5: mode false uses the maximum high/low deviation, so set 1 equals set 2", () => {
    const ch = run(byId("F5"));
    expect(ch.end.upper1).toBe(ch.end.upper2);
    expect(ch.end.lower1).toBe(ch.end.lower2);
    near(ch.end.upper1, ch.endPrice + ch.upDev, "upper end = end + upDev");
    near(ch.end.lower1, ch.endPrice - ch.dnDev, "lower end = end - dnDev");
  });

  it("F6: the lower -4 end is at or below zero", () => {
    const ch = run(byId("F6"));
    expect(ch.rising).toBe(true);
    expect(ch.end.lower2).toBeLessThan(0);
    near(ch.end.lower2, -1.699599499978905, "lower2 end");
  });

  it("F7: bars older than the window have no effect (window boundary)", () => {
    const f4 = run(byId("F4"));
    const f7 = run(byId("F7"));
    const strip = (c: Channel) => ({ ...c, barCount: 0, lastIndex: 0, windowStartIndex: 0, base: 0, upper1: 0, upper2: 0, lower1: 0, lower2: 0 });
    expect(strip(f7)).toEqual(strip(f4));
    expect(f7.barCount).toBe(12);
    expect(f7.windowStartIndex).toBe(4);
    expect(f7.lastIndex).toBe(11);
  });

  it("F7: non-finite values OUTSIDE the window are ignored", () => {
    const f = byId("F7");
    const close = [Number.NaN, ...f.inputs.close.slice(1)];
    const out = computeChannel({ ...f.inputs, close }, { length: f.length, ...f.settings });
    expect(out.ok).toBe(true);
  });

  it("F8: fewer bars than length is insufficient_bars, not an error", () => {
    const f = byId("F8");
    expect(f.expected).toBeNull();
    expect(computeChannel(f.inputs, { length: f.length, ...f.settings })).toEqual({ ok: false, reason: "insufficient_bars" });
  });

  it("F9: float-noise constant series records noisy raw values and is not rising", () => {
    const ch = run(byId("F9"));
    expect(ch.stdDev).toBeLessThan(1e-9);
    expect(ch.rising).toBe(false);
  });
});

describe("validateSettings", () => {
  const base = { ...DEFAULT_SETTINGS };
  const bad = (patch: Record<string, unknown>) => validateSettings({ ...base, ...patch });

  it("accepts the defaults without warnings", () => {
    const r = validateSettings(base);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.settings).toEqual(DEFAULT_SETTINGS);
      expect(r.warnings).toEqual([]);
    }
  });

  it.each([
    [3, true],
    [5000, true],
    [2, false],
    [5001, false],
    [2500.5, false],
    [Number.NaN, false],
    [Number.POSITIVE_INFINITY, false],
    [-5, false],
    ["2500", false],
    [null, false],
  ])("length %s -> accepted %s", (length, accepted) => {
    const r = bad({ length });
    expect(r.ok).toBe(accepted);
    if (!r.ok) expect(r.issues.some((i) => i.field === "length")).toBe(true);
  });

  it("warns (but accepts) a length below 30", () => {
    const r = bad({ length: 10 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.warnings.map((w) => w.code)).toEqual(["length_below_30"]);
  });

  it.each(["upper1Mult", "upper2Mult", "lower1Mag", "lower2Mag"])("rejects zero, negative, NaN and string for %s", (field) => {
    for (const v of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, "3", null]) {
      const r = bad({ [field]: v });
      expect(r.ok, `${field}=${String(v)}`).toBe(false);
    }
  });

  it.each(["upper1Mode", "upper2Mode", "lower1Mode", "lower2Mode"])("rejects non-boolean %s (no truthy coercion)", (field) => {
    for (const v of [1, 0, "true", null]) {
      const r = bad({ [field]: v });
      expect(r.ok, `${field}=${String(v)}`).toBe(false);
    }
  });

  it("reports every missing field when the input is not an object", () => {
    for (const input of [null, undefined, 5, "x", []]) {
      const r = validateSettings(input);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.issues).toHaveLength(9);
    }
  });

  it("collects all issues at once", () => {
    const r = bad({ length: 1, upper1Mult: 0, lower2Mode: "yes" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.map((i) => i.field).sort()).toEqual(["length", "lower2Mode", "upper1Mult"]);
  });
});

describe("assertSignalGradeSettings", () => {
  it("accepts the defaults and any length", () => {
    expect(() => assertSignalGradeSettings(DEFAULT_SETTINGS)).not.toThrow();
    expect(() => assertSignalGradeSettings({ ...DEFAULT_SETTINGS, length: 500 })).not.toThrow();
  });
  it("throws settings_not_signal_grade for a changed magnitude or a false mode", () => {
    expect(() => assertSignalGradeSettings({ ...DEFAULT_SETTINGS, lower1Mag: 2 })).toThrow("settings_not_signal_grade");
    expect(() => assertSignalGradeSettings({ ...DEFAULT_SETTINGS, upper2Mult: 3 })).toThrow("settings_not_signal_grade");
    expect(() => assertSignalGradeSettings({ ...DEFAULT_SETTINGS, lower2Mode: false })).toThrow("settings_not_signal_grade");
  });
});

describe("computeChannel edge cases", () => {
  it("returns invalid_settings for bad settings", () => {
    const f = byId("F4");
    expect(computeChannel(f.inputs, { ...DEFAULT_SETTINGS, length: 2 })).toEqual({ ok: false, reason: "invalid_settings" });
  });

  it("returns non_finite_input when a window value is NaN or Infinity", () => {
    const f = byId("F4");
    const nan = [...f.inputs.close];
    nan[6] = Number.NaN;
    expect(computeChannel({ ...f.inputs, close: nan }, { length: f.length, ...f.settings })).toEqual({ ok: false, reason: "non_finite_input" });
    const inf = [...f.inputs.high];
    inf[0] = Number.POSITIVE_INFINITY;
    expect(computeChannel({ ...f.inputs, high: inf }, { length: f.length, ...f.settings })).toEqual({ ok: false, reason: "non_finite_input" });
  });

  it("throws on mismatched array lengths (programming error)", () => {
    expect(() => computeChannel({ close: [1, 2, 3], high: [1, 2], low: [1, 2, 3] }, { ...DEFAULT_SETTINGS, length: 3 })).toThrow(RangeError);
  });

  it("exactly L bars computes and L-1 bars is insufficient", () => {
    const mk = (n: number) => Array.from({ length: n }, (_, i) => 100 + i * 0.01 + Math.sin(i) * 0.3);
    const settings = { ...DEFAULT_SETTINGS, length: 2500 };
    const at = (n: number) => {
      const close = mk(n);
      return computeChannel({ close, high: close.map((c) => c + 0.2), low: close.map((c) => c - 0.2) }, settings);
    };
    expect(at(2500).ok).toBe(true);
    expect(at(2499)).toEqual({ ok: false, reason: "insufficient_bars" });
  });

  it("2,500 bars of the constant 123.456 are NOT rising (float noise must not look like a trend)", () => {
    const close = Array.from({ length: 2500 }, () => 123.456);
    const out = computeChannel({ close, high: close.map((c) => c + 0.5), low: close.map((c) => c - 0.5) });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.channel.rising).toBe(false);
      expect(Math.abs(out.channel.endPrice - out.channel.stPrice)).toBeLessThan(1e-9);
    }
  });

  it("a clean 2,500-bar uptrend is rising with raw slope below zero", () => {
    const close = Array.from({ length: 2500 }, (_, i) => 50 + i * 0.05 + Math.sin(i / 7) * 0.4);
    const out = computeChannel({ close, high: close.map((c) => c + 0.3), low: close.map((c) => c - 0.3) });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.channel.rising).toBe(true);
      expect(out.channel.slope).toBeLessThan(0);
      expect(out.channel.lower1.y2).toBeLessThan(out.channel.base.y2);
      expect(out.channel.lower2.y2).toBeLessThan(out.channel.lower1.y2);
    }
  });

  it("a 5,000-bar window with length 5000 computes", () => {
    const close = Array.from({ length: 5000 }, (_, i) => 20 + i * 0.01 + Math.cos(i / 11));
    const out = computeChannel({ close, high: close.map((c) => c + 0.1), low: close.map((c) => c - 0.1) }, { ...DEFAULT_SETTINGS, length: 5000 });
    expect(out.ok).toBe(true);
  });

  it("length 3 gives a defined set-2 line (x2 - x1 = 1)", () => {
    const out = computeChannel({ close: [1, 2, 4], high: [1.5, 2.5, 4.5], low: [0.5, 1.5, 3.5] }, { ...DEFAULT_SETTINGS, length: 3 });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.channel.upper2.x2 - out.channel.upper2.x1).toBe(1);
      expect(Number.isFinite(out.channel.upper2.slopePerBar)).toBe(true);
    }
  });
});

describe("isRising", () => {
  it("is false for equal prices and for noise at 1e-14 relative", () => {
    expect(isRising(100, 100)).toBe(false);
    expect(isRising(123.456, 123.456 + 2.4e-11)).toBe(false);
  });
  it("is true just above the relative epsilon and false just below", () => {
    expect(isRising(1000, 1000 + 1.1e-6)).toBe(true);
    expect(isRising(1000, 1000 + 0.9e-6)).toBe(false);
  });
  it("uses an absolute floor of 1e-9 for tiny prices", () => {
    expect(isRising(0.001, 0.001 + 2e-9)).toBe(true);
    expect(isRising(0.001, 0.001 + 5e-10)).toBe(false);
  });
});

describe("valueAt (extend right)", () => {
  it("returns the right end at x2 and extends with the drawn slope", () => {
    const seg: Segment = { x1: 0, y1: 10, x2: 10, y2: 20, slopePerBar: 1 };
    expect(valueAt(seg, 10)).toBe(20);
    expect(valueAt(seg, 15)).toBe(25);
    expect(valueAt(seg, 4)).toBe(14);
  });
  it("F4 set-2 lines are drawn steeper than the true slope by (L-1)/(L-2)", () => {
    const f = byId("F4");
    const ch = run(f);
    const L = f.length;
    const trueSlope = (ch.endPrice - ch.stPrice) / (L - 1);
    expect(ch.base.slopePerBar).toBeCloseTo(trueSlope, 12);
    expect(ch.upper1.slopePerBar).toBeCloseTo(trueSlope, 12);
    expect(ch.upper2.slopePerBar / ch.upper1.slopePerBar).toBeCloseTo((L - 1) / (L - 2), 12);
    // five bars to the right: set 2 sits above the exact extension (F4 analysis: 0.592)
    const drawn = valueAt(ch.upper2, ch.lastIndex + 5);
    const exact = ch.end.upper2 + 5 * trueSlope;
    expect(drawn - exact).toBeCloseTo(0.592, 2);
  });
  it("at L = 2500 the factor is 1.00040032", () => {
    const close = Array.from({ length: 2500 }, (_, i) => 50 + i * 0.05 + Math.sin(i / 7) * 0.4);
    const out = computeChannel({ close, high: close.map((c) => c + 0.3), low: close.map((c) => c - 0.3) });
    if (!out.ok) throw new Error("expected channel");
    expect(out.channel.upper2.slopePerBar / out.channel.upper1.slopePerBar).toBeCloseTo(1.00040032, 8);
  });
});
```

- [ ] **Step 3: Run it: `bun run test:core -- supabase/functions/_shared/core/indicator.test.ts`; Expected: FAIL (Failed to resolve import ./indicator.ts)**

- [ ] **Step 4: Implement**

**`supabase/functions/_shared/core/indicator.ts`**

```ts
export interface IndicatorSettings {
  length: number; // integer, 3..5000, default 2500
  upper1Mode: boolean;
  upper1Mult: number; // default true, 1   (Pine upprinp / upprmltinp)
  upper2Mode: boolean;
  upper2Mult: number; // default true, 2   (upprinp2 / upprmltinp2)
  lower1Mode: boolean;
  lower1Mag: number; // default true, 3   (lwrinp / lwrMultInput), magnitude, applied as -mag
  lower2Mode: boolean;
  lower2Mag: number; // default true, 4   (lwrinp2 / lwrmultinp), magnitude, applied as -mag
}

export const DEFAULT_SETTINGS: Readonly<IndicatorSettings> = Object.freeze({
  length: 2500,
  upper1Mode: true,
  upper1Mult: 1,
  upper2Mode: true,
  upper2Mult: 2,
  lower1Mode: true,
  lower1Mag: 3,
  lower2Mode: true,
  lower2Mag: 4,
});

export const MIN_LENGTH = 3;
export const MAX_LENGTH = 5000;
export const WARN_LENGTH_BELOW = 30;
/** Relative epsilon of the flat-series noise guard (D10). */
export const RISING_EPSILON = 1e-9;

export interface SettingsIssue {
  field: keyof IndicatorSettings;
  code: string;
  message: string;
}

const BOOLEAN_FIELDS = ["upper1Mode", "upper2Mode", "lower1Mode", "lower2Mode"] as const;
const MAGNITUDE_FIELDS = ["upper1Mult", "upper2Mult", "lower1Mag", "lower2Mag"] as const;

export function validateSettings(
  input: unknown,
): { ok: true; settings: IndicatorSettings; warnings: SettingsIssue[] } | { ok: false; issues: SettingsIssue[] } {
  const record: Record<string, unknown> =
    typeof input === "object" && input !== null && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  const issues: SettingsIssue[] = [];
  const warnings: SettingsIssue[] = [];

  const length = record["length"];
  if (length === undefined) {
    issues.push({ field: "length", code: "missing", message: "length is required" });
  } else if (typeof length !== "number" || !Number.isFinite(length) || !Number.isInteger(length)) {
    issues.push({ field: "length", code: "length_not_integer", message: "length must be a finite integer" });
  } else if (length < MIN_LENGTH || length > MAX_LENGTH) {
    issues.push({
      field: "length",
      code: "length_out_of_range",
      message: `length must be between ${MIN_LENGTH} and ${MAX_LENGTH}`,
    });
  } else if (length < WARN_LENGTH_BELOW) {
    warnings.push({ field: "length", code: "length_below_30", message: "length below 30 gives a very noisy channel" });
  }

  for (const field of MAGNITUDE_FIELDS) {
    const v = record[field];
    if (v === undefined) {
      issues.push({ field, code: "missing", message: `${field} is required` });
    } else if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) {
      issues.push({ field, code: "not_finite_positive", message: `${field} must be a finite number greater than 0` });
    }
  }

  for (const field of BOOLEAN_FIELDS) {
    const v = record[field];
    if (v === undefined) {
      issues.push({ field, code: "missing", message: `${field} is required` });
    } else if (typeof v !== "boolean") {
      issues.push({ field, code: "not_boolean", message: `${field} must be a boolean (no truthy coercion)` });
    }
  }

  if (issues.length > 0) return { ok: false, issues };
  const settings: IndicatorSettings = {
    length: record["length"] as number,
    upper1Mode: record["upper1Mode"] as boolean,
    upper1Mult: record["upper1Mult"] as number,
    upper2Mode: record["upper2Mode"] as boolean,
    upper2Mult: record["upper2Mult"] as number,
    lower1Mode: record["lower1Mode"] as boolean,
    lower1Mag: record["lower1Mag"] as number,
    lower2Mode: record["lower2Mode"] as boolean,
    lower2Mag: record["lower2Mag"] as number,
  };
  return { ok: true, settings, warnings };
}

/** Throws unless the 3/4/1/2 magnitudes and all four modes are the signal-grade defaults. Only `length` may vary (A-34). */
export function assertSignalGradeSettings(s: IndicatorSettings): void {
  const ok =
    s.upper1Mode === true &&
    s.upper2Mode === true &&
    s.lower1Mode === true &&
    s.lower2Mode === true &&
    s.upper1Mult === DEFAULT_SETTINGS.upper1Mult &&
    s.upper2Mult === DEFAULT_SETTINGS.upper2Mult &&
    s.lower1Mag === DEFAULT_SETTINGS.lower1Mag &&
    s.lower2Mag === DEFAULT_SETTINGS.lower2Mag;
  if (!ok) throw new Error("settings_not_signal_grade");
}

export interface OhlcSeries {
  // chronological, oldest first, VALID bars only, completed bars only
  close: ArrayLike<number>; // source = close (D10)
  high: ArrayLike<number>;
  low: ArrayLike<number>;
}

export interface Segment {
  // a line in bar-index space (index 0 = oldest bar of the supplied series)
  x1: number;
  y1: number; // left end
  x2: number;
  y2: number; // right end (always lastIndex)
  slopePerBar: number; // (y2 - y1) / (x2 - x1): the DRAWN slope used for right extension
}

export interface Channel {
  length: number;
  barCount: number;
  lastIndex: number; // barCount - 1 (latest completed bar)
  windowStartIndex: number; // lastIndex - length + 1
  slope: number;
  average: number;
  intercept: number; // raw Pine values (slope is NEGATIVE for a rising channel)
  stPrice: number;
  endPrice: number; // base line left / right values
  stdDev: number;
  pearsonR: number;
  upDev: number;
  dnDev: number;
  base: Segment; // x1 = windowStartIndex, y1 = stPrice, x2 = lastIndex, y2 = endPrice
  upper1: Segment;
  lower1: Segment; // set 1: x1 = windowStartIndex
  upper2: Segment;
  lower2: Segment; // set 2: x1 = windowStartIndex + 1 (one bar later), y1 = the set-2 value computed from stPrice
  end: { base: number; upper1: number; upper2: number; lower1: number; lower2: number }; // exact right-end values at lastIndex
  rising: boolean; // isRising(stPrice, endPrice)
}

export type ChannelOutcome =
  | { ok: true; channel: Channel }
  | { ok: false; reason: "invalid_settings" | "insufficient_bars" | "non_finite_input" };

/** A visually rising channel has end > st. The sign of the raw slope is never the test (Pine x runs newest to oldest). */
export function isRising(stPrice: number, endPrice: number): boolean {
  return endPrice - stPrice > RISING_EPSILON * Math.max(1, Math.abs(endPrice), Math.abs(stPrice));
}

/** seg.y2 + (x - seg.x2) * seg.slopePerBar (Pine extend.right). */
export function valueAt(seg: Segment, x: number): number {
  return seg.y2 + (x - seg.x2) * seg.slopePerBar;
}

function segment(x1: number, y1: number, x2: number, y2: number): Segment {
  return { x1, y1, x2, y2, slopePerBar: (y2 - y1) / (x2 - x1) };
}

export function computeChannel(series: OhlcSeries, settings: IndicatorSettings = DEFAULT_SETTINGS): ChannelOutcome {
  const checked = validateSettings(settings);
  if (!checked.ok) return { ok: false, reason: "invalid_settings" };
  const s = checked.settings;
  const n = series.close.length;
  if (series.high.length !== n || series.low.length !== n) {
    throw new RangeError("close, high and low must have the same length");
  }
  const L = s.length;
  if (L > n) return { ok: false, reason: "insufficient_bars" };

  // newest-first accessors: i = 0 is the latest completed bar
  const src = (i: number): number => series.close[n - 1 - i] as number;
  const hi = (i: number): number => series.high[n - 1 - i] as number;
  const lo = (i: number): number => series.low[n - 1 - i] as number;

  for (let i = 0; i < L; i++) {
    if (!Number.isFinite(src(i)) || !Number.isFinite(hi(i)) || !Number.isFinite(lo(i))) {
      return { ok: false, reason: "non_finite_input" };
    }
  }

  let sumX = 0;
  let sumY = 0;
  let sumXSqr = 0;
  let sumXY = 0;
  for (let i = 0; i < L; i++) {
    const v = src(i);
    const per = i + 1;
    sumX += per;
    sumY += v;
    sumXSqr += per * per;
    sumXY += v * per;
  }
  const slope = (L * sumXY - sumX * sumY) / (L * sumXSqr - sumX * sumX);
  const average = sumY / L;
  const intercept = average - (slope * sumX) / L + slope; // left to right, as Pine evaluates it
  const stPrice = intercept + slope * (L - 1);
  const endPrice = intercept;

  const periods = L - 1;
  const daY = intercept + (slope * periods) / 2;
  let val = intercept;
  let upDev = 0;
  let dnDev = 0;
  let acc = 0;
  let dsxx = 0;
  let dsyy = 0;
  let dsxy = 0;
  for (let j = 0; j <= periods; j++) {
    let p = hi(j) - val;
    if (p > upDev) upDev = p;
    p = val - lo(j);
    if (p > dnDev) dnDev = p;
    p = src(j);
    const dxt = p - average;
    const dyt = val - daY;
    p = p - val;
    acc += p * p;
    dsxx += dxt * dxt;
    dsyy += dyt * dyt;
    dsxy += dxt * dyt;
    val += slope;
  }
  const stdDev = Math.sqrt(acc / (periods === 0 ? 1 : periods)); // divisor L-1, NOT L
  const pearsonR = dsxx === 0 || dsyy === 0 ? 0 : dsxy / Math.sqrt(dsxx * dsyy);

  const offUp1 = s.upper1Mode ? +s.upper1Mult * stdDev : +upDev;
  const offUp2 = s.upper2Mode ? +s.upper2Mult * stdDev : +upDev;
  const offLo1 = s.lower1Mode ? -s.lower1Mag * stdDev : -dnDev;
  const offLo2 = s.lower2Mode ? -s.lower2Mag * stdDev : -dnDev;

  const lastIndex = n - 1;
  const windowStartIndex = lastIndex - L + 1;
  const channel: Channel = {
    length: L,
    barCount: n,
    lastIndex,
    windowStartIndex,
    slope,
    average,
    intercept,
    stPrice,
    endPrice,
    stdDev,
    pearsonR,
    upDev,
    dnDev,
    base: segment(windowStartIndex, stPrice, lastIndex, endPrice),
    upper1: segment(windowStartIndex, stPrice + offUp1, lastIndex, endPrice + offUp1),
    lower1: segment(windowStartIndex, stPrice + offLo1, lastIndex, endPrice + offLo1),
    upper2: segment(windowStartIndex + 1, stPrice + offUp2, lastIndex, endPrice + offUp2),
    lower2: segment(windowStartIndex + 1, stPrice + offLo2, lastIndex, endPrice + offLo2),
    end: {
      base: endPrice,
      upper1: endPrice + offUp1,
      upper2: endPrice + offUp2,
      lower1: endPrice + offLo1,
      lower2: endPrice + offLo2,
    },
    rising: isRising(stPrice, endPrice),
  };
  return { ok: true, channel };
}
```

- [ ] **Step 5: Run; Expected: PASS** `bun run test:core -- supabase/functions/_shared/core/indicator.test.ts` (57 tests: F1-F7 and F9 field by field, F8 insufficient bars, validation table, signal-grade guard, constant 123.456 x 2500 not rising, set-2 slope factor 1.00040032).

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/_shared/core/indicator.ts supabase/functions/_shared/core/indicator.test.ts supabase/functions/_shared/core/fixtures/stddevchn-synthetic.json
git commit -m "feat(core): Std Dev Channel port with parity fixtures"
```

---
### Task 4: bars.ts (cleaning, forming-bar rule, incremental merge)

**Parallelism:** can run concurrently with Tasks 1, 3, 5, 6, 7, 8 once Task 2 (`calendar.ts`) has landed.

**Files:**
- Create: `supabase/functions/_shared/core/bars.ts`
- Test: `supabase/functions/_shared/core/bars.test.ts`

**Interfaces:**
- Consumes: `calendar.ts`: `expectedWeekdays`, `localDayNumber`, `localParts`
- Produces: `RawBar`, `ChartMeta`, `Series`, `CleanReport`, `SeriesStats`, `sessionDay`, `isFormingLastBar`, `cleanBars`, `seriesStats`, `takeLatest`, `mergeIncremental`

- [ ] **Step 1: Write the failing test**

**`supabase/functions/_shared/core/bars.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import {
  cleanBars,
  isFormingLastBar,
  mergeIncremental,
  seriesStats,
  sessionDay,
  takeLatest,
  type ChartMeta,
  type RawBar,
  type Series,
} from "./bars.ts";
import { dayNumber, isoDate } from "./calendar.ts";

const utc = (iso: string) => Date.parse(iso);
const day = (iso: string) => dayNumber(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)), Number(iso.slice(8, 10)));
const iso = (n: number) => isoDate(n);

function bar(time: string, close: number | null, extra: Partial<RawBar> = {}): RawBar {
  return {
    time: utc(time),
    open: close === null ? null : close - 0.5,
    high: close === null ? null : close + 1,
    low: close === null ? null : close - 1,
    close,
    volume: close === null ? null : 1000,
    ...extra,
  };
}

/** Weekday bars at a fixed session-open time, oldest first. */
function weekdayBars(fromIso: string, count: number, hhmm: string, start = 100): RawBar[] {
  const out: RawBar[] = [];
  let n = day(fromIso);
  let close = start;
  while (out.length < count) {
    const wd = ((n + 3) % 7) + 1;
    if (wd <= 5) {
      out.push(bar(`${iso(n)}T${hhmm}:00Z`, close));
      close += 0.1;
    }
    n++;
  }
  return out;
}

// Observed states of spike 3.2 (run at 2026-10-15 07:42Z)
const NOW_SPIKE = utc("2026-10-15T07:42:00Z");
const sapMeta: ChartMeta = {
  exchangeTimezoneName: "Europe/Berlin",
  regularMarketTime: utc("2026-10-15T07:27:36Z"),
  currentTradingPeriod: { start: utc("2026-10-15T07:00:00Z"), end: utc("2026-10-15T15:30:00Z") },
  marketState: "REGULAR",
};

describe("sessionDay", () => {
  it("uses the exchange-local date, not the UTC date", () => {
    expect(iso(sessionDay(utc("2026-10-14T13:30:00Z"), "America/New_York"))).toBe("2026-10-14");
    expect(iso(sessionDay(utc("2026-10-15T01:30:00Z"), "Asia/Hong_Kong"))).toBe("2026-10-15");
    expect(iso(sessionDay(utc("2026-10-14T23:00:00Z"), "Australia/Sydney"))).toBe("2026-10-15");
  });
});

describe("isFormingLastBar: the five observed states of spike 3.2", () => {
  it("SAP.DE (bar == period.start, regularMarketTime < end, REGULAR) is forming", () => {
    expect(isFormingLastBar(utc("2026-10-15T07:00:00Z"), sapMeta, NOW_SPIKE)).toBe(true);
  });

  it("2222.SR forming", () => {
    const meta: ChartMeta = {
      exchangeTimezoneName: "Asia/Riyadh",
      regularMarketTime: utc("2026-10-15T07:27:40Z"),
      currentTradingPeriod: { start: utc("2026-10-15T07:00:00Z"), end: utc("2026-10-15T12:00:00Z") },
      marketState: "REGULAR",
    };
    expect(isFormingLastBar(utc("2026-10-15T07:00:00Z"), meta, NOW_SPIKE)).toBe(true);
  });

  it("RELIANCE.NS forming even without a marketState", () => {
    const meta: ChartMeta = {
      exchangeTimezoneName: "Asia/Kolkata",
      regularMarketTime: utc("2026-10-15T07:42:40Z"),
      currentTradingPeriod: { start: utc("2026-10-15T03:45:00Z"), end: utc("2026-10-15T10:00:00Z") },
    };
    expect(isFormingLastBar(utc("2026-10-15T03:45:00Z"), meta, NOW_SPIKE)).toBe(true);
  });

  it("7203.T (regularMarketTime >= period.end, POSTPOST) is completed once the 30-minute margin has passed", () => {
    const meta: ChartMeta = {
      exchangeTimezoneName: "Asia/Tokyo",
      regularMarketTime: utc("2026-10-15T06:30:00Z"),
      currentTradingPeriod: { start: utc("2026-10-15T00:00:00Z"), end: utc("2026-10-15T06:30:00Z") },
      marketState: "POSTPOST",
    };
    expect(isFormingLastBar(utc("2026-10-15T00:00:00Z"), meta, NOW_SPIKE)).toBe(false);
  });

  it("AAPL / NVDA (bar older than the next session's start, PREPRE) is completed", () => {
    const meta: ChartMeta = {
      exchangeTimezoneName: "America/New_York",
      regularMarketTime: utc("2026-10-14T20:00:01Z"),
      currentTradingPeriod: { start: utc("2026-10-15T13:30:00Z"), end: utc("2026-10-15T20:00:00Z") },
      marketState: "PREPRE",
    };
    expect(isFormingLastBar(utc("2026-10-14T13:30:00Z"), meta, NOW_SPIKE)).toBe(false);
  });
});

describe("isFormingLastBar: margins, states and fallbacks", () => {
  const tokyo = (rmt: string): ChartMeta => ({
    exchangeTimezoneName: "Asia/Tokyo",
    regularMarketTime: utc(rmt),
    currentTradingPeriod: { start: utc("2026-10-15T00:00:00Z"), end: utc("2026-10-15T06:30:00Z") },
    marketState: "POST",
  });

  it("29 minutes after the session end the bar is still treated as forming (safety margin)", () => {
    expect(isFormingLastBar(utc("2026-10-15T00:00:00Z"), tokyo("2026-10-15T06:30:00Z"), utc("2026-10-15T06:59:00Z"))).toBe(true);
  });
  it("31 minutes after the session end the bar is completed", () => {
    expect(isFormingLastBar(utc("2026-10-15T00:00:00Z"), tokyo("2026-10-15T06:30:00Z"), utc("2026-10-15T07:01:00Z"))).toBe(false);
  });

  it("REGULAR with a bar of an earlier local day does not drop a completed bar", () => {
    const meta: ChartMeta = {
      exchangeTimezoneName: "America/New_York",
      regularMarketTime: utc("2026-10-15T13:45:00Z"),
      currentTradingPeriod: { start: utc("2026-10-15T13:30:00Z"), end: utc("2026-10-15T20:00:00Z") },
      marketState: "REGULAR",
    };
    // last bar is yesterday's completed session (today's bar not created yet)
    expect(isFormingLastBar(utc("2026-10-14T13:30:00Z"), meta, utc("2026-10-15T13:50:00Z"))).toBe(false);
    // last bar is today's in-progress session
    expect(isFormingLastBar(utc("2026-10-15T13:30:00Z"), meta, utc("2026-10-15T13:50:00Z"))).toBe(true);
  });

  it("weekend: Friday bar on a Saturday scan is completed", () => {
    const meta: ChartMeta = {
      exchangeTimezoneName: "America/New_York",
      regularMarketTime: utc("2026-10-16T20:00:00Z"),
      currentTradingPeriod: { start: utc("2026-10-19T13:30:00Z"), end: utc("2026-10-19T20:00:00Z") },
      marketState: "CLOSED",
    };
    expect(isFormingLastBar(utc("2026-10-16T13:30:00Z"), meta, utc("2026-10-17T07:00:00Z"))).toBe(false);
  });

  it("without currentTradingPeriod: today's bar before close + 30 min is forming, after it is not", () => {
    const meta: ChartMeta = {
      exchangeTimezoneName: "Europe/Berlin",
      regularMarketTime: null,
      currentTradingPeriod: null,
      sessionCloseLocal: "17:30",
    };
    const bar0 = utc("2026-10-15T07:00:00Z");
    expect(isFormingLastBar(bar0, meta, utc("2026-10-15T10:00:00Z"))).toBe(true); // 12:00 local
    expect(isFormingLastBar(bar0, meta, utc("2026-10-15T15:50:00Z"))).toBe(true); // 17:50 local, inside the margin
    expect(isFormingLastBar(bar0, meta, utc("2026-10-15T16:10:00Z"))).toBe(false); // 18:10 local
    expect(isFormingLastBar(utc("2026-10-14T07:00:00Z"), meta, utc("2026-10-15T10:00:00Z"))).toBe(false);
  });

  it("without currentTradingPeriod and without a known close: today's bar is conservatively forming", () => {
    const meta: ChartMeta = { exchangeTimezoneName: "Europe/Berlin", regularMarketTime: null, currentTradingPeriod: null };
    expect(isFormingLastBar(utc("2026-10-15T07:00:00Z"), meta, utc("2026-10-15T20:00:00Z"))).toBe(true);
  });
});

describe("cleanBars", () => {
  it("never lets a forming bar through as a completed close (SAP.DE: null 2026-10-14 plus forming 2026-10-15)", () => {
    const hist = weekdayBars("2026-10-05", 7, "07:00"); // 10-05 .. 10-13
    const raw = [...hist, bar("2026-10-14T07:00:00Z", null), bar("2026-10-15T07:00:00Z", 199.62)];
    const { series, report } = cleanBars(raw, sapMeta, NOW_SPIKE);
    expect(report.droppedForming).toBe(true);
    expect(report.droppedNullClose).toBe(1);
    expect(iso(series.dates[series.dates.length - 1] as number)).toBe("2026-10-13");
    expect(series.close).not.toContain(199.62);
    expect(report.inputBars).toBe(9);
    expect(report.keptBars).toBe(7);
  });

  it("keeps the last bar when it is completed (AAPL)", () => {
    const meta: ChartMeta = {
      exchangeTimezoneName: "America/New_York",
      regularMarketTime: utc("2026-10-14T20:00:01Z"),
      currentTradingPeriod: { start: utc("2026-10-15T13:30:00Z"), end: utc("2026-10-15T20:00:00Z") },
      marketState: "PREPRE",
    };
    const raw = weekdayBars("2026-10-07", 6, "13:30");
    const { series, report } = cleanBars(raw, meta, NOW_SPIKE);
    expect(report.droppedForming).toBe(false);
    expect(series.dates).toHaveLength(6);
    expect(iso(series.dates[5] as number)).toBe("2026-10-14");
  });

  it("converts NVDA bars across the 10:1 split days to session days and sees no jump (close is split-adjusted)", () => {
    const raw: RawBar[] = [
      bar("2024-06-03T13:30:00Z", 115),
      bar("2024-06-04T13:30:00Z", 116.43699645996094),
      bar("2024-06-05T13:30:00Z", 122.44000244140625),
      bar("2024-06-06T13:30:00Z", 120.99800109863281),
      bar("2024-06-07T13:30:00Z", 120.88800048828125),
      bar("2024-06-10T13:30:00Z", 121.79000091552734),
    ];
    const meta: ChartMeta = {
      exchangeTimezoneName: "America/New_York",
      regularMarketTime: utc("2024-06-10T20:00:00Z"),
      currentTradingPeriod: { start: utc("2024-06-11T13:30:00Z"), end: utc("2024-06-11T20:00:00Z") },
      marketState: "CLOSED",
    };
    const { series, report } = cleanBars(raw, meta, utc("2024-06-11T05:00:00Z"));
    expect(series.dates.map(iso)).toEqual(["2024-06-03", "2024-06-04", "2024-06-05", "2024-06-06", "2024-06-07", "2024-06-10"]);
    expect(report.jumpAnomalies).toBe(0);
    expect(report.suspect).toBe(false);
  });

  it("drops null, NaN, infinite and non-positive rows and counts each reason", () => {
    const meta: ChartMeta = { exchangeTimezoneName: "UTC", regularMarketTime: null, currentTradingPeriod: { start: utc("2026-10-20T00:00:00Z"), end: utc("2026-10-20T20:00:00Z") } };
    const raw: RawBar[] = [
      bar("2026-10-12T00:00:00Z", 10),
      bar("2026-10-13T00:00:00Z", null),
      bar("2026-10-14T00:00:00Z", Number.NaN),
      bar("2026-10-15T00:00:00Z", 12, { high: null }),
      bar("2026-10-16T00:00:00Z", 12, { low: Number.POSITIVE_INFINITY }),
      bar("2026-10-17T00:00:00Z", 0),
      bar("2026-10-18T00:00:00Z", -3),
      bar("2026-10-19T00:00:00Z", 11),
    ];
    const { series, report } = cleanBars(raw, meta, utc("2026-10-19T12:00:00Z"));
    expect(series.close).toEqual([10, 11]);
    expect(report.droppedNullClose).toBe(2);
    expect(report.droppedNullHighLow).toBe(2);
    expect(report.droppedNonPositive).toBe(2);
  });

  it("sorts by session day and keeps the LAST occurrence of a duplicate day", () => {
    const meta: ChartMeta = { exchangeTimezoneName: "UTC", regularMarketTime: null, currentTradingPeriod: { start: utc("2026-10-30T00:00:00Z"), end: utc("2026-10-30T20:00:00Z") } };
    const raw: RawBar[] = [
      bar("2026-10-14T00:00:00Z", 12),
      bar("2026-10-13T00:00:00Z", 10),
      bar("2026-10-13T00:00:00Z", 11), // later occurrence wins
    ];
    const { series, report } = cleanBars(raw, meta, utc("2026-10-20T00:00:00Z"));
    expect(series.dates.map(iso)).toEqual(["2026-10-13", "2026-10-14"]);
    expect(series.close).toEqual([11, 12]);
    expect(report.droppedDuplicates).toBe(1);
  });

  it("falls back to close for a null open and 0 for a null volume", () => {
    const meta: ChartMeta = { exchangeTimezoneName: "UTC", regularMarketTime: null, currentTradingPeriod: { start: utc("2026-10-30T00:00:00Z"), end: utc("2026-10-30T20:00:00Z") } };
    const { series } = cleanBars([bar("2026-10-13T00:00:00Z", 10, { open: null, volume: null })], meta, utc("2026-10-20T00:00:00Z"));
    expect(series.open).toEqual([10]);
    expect(series.volume).toEqual([0]);
  });

  it("counts inconsistent OHLC (close outside [low, high]) but keeps the bar", () => {
    const meta: ChartMeta = { exchangeTimezoneName: "UTC", regularMarketTime: null, currentTradingPeriod: { start: utc("2026-10-30T00:00:00Z"), end: utc("2026-10-30T20:00:00Z") } };
    const raw = [
      bar("2026-10-13T00:00:00Z", 10, { high: 9, low: 8 }),
      bar("2026-10-14T00:00:00Z", 10),
      bar("2026-10-15T00:00:00Z", 10, { high: 10 * (1 + 5e-7), low: 9 }), // within 1e-6 relative: consistent
    ];
    const { series, report } = cleanBars(raw, meta, utc("2026-10-20T00:00:00Z"));
    expect(series.dates).toHaveLength(3);
    expect(report.ohlcInconsistent).toBe(1);
  });

  it("flags a series with three 50%+ jumps as suspect and tolerates two", () => {
    const meta: ChartMeta = { exchangeTimezoneName: "UTC", regularMarketTime: null, currentTradingPeriod: { start: utc("2026-12-30T00:00:00Z"), end: utc("2026-12-30T20:00:00Z") } };
    const closes = (xs: number[]) => xs.map((c, i) => bar(`2026-10-${String(12 + i).padStart(2, "0")}T00:00:00Z`, c));
    const two = cleanBars(closes([100, 100, 200, 200, 400, 400, 400]), meta, utc("2026-11-30T00:00:00Z"));
    expect(two.report.jumpAnomalies).toBe(2);
    expect(two.report.suspect).toBe(false);
    const three = cleanBars(closes([100, 200, 80, 200, 200, 200, 200]), meta, utc("2026-11-30T00:00:00Z"));
    expect(three.report.jumpAnomalies).toBe(3);
    expect(three.report.suspect).toBe(true);
  });

  it("flags a series with more than 15% missing sessions as suspect", () => {
    const meta: ChartMeta = { exchangeTimezoneName: "UTC", regularMarketTime: null, currentTradingPeriod: { start: utc("2027-12-30T00:00:00Z"), end: utc("2027-12-30T20:00:00Z") } };
    const all = weekdayBars("2026-01-05", 100, "00:00");
    const gappy = all.filter((_, i) => i % 5 !== 0 && i % 5 !== 1); // drops 40%
    const { report } = cleanBars(gappy, meta, utc("2027-11-30T00:00:00Z"));
    expect(report.missingSessionRatio).toBeGreaterThan(0.15);
    expect(report.suspect).toBe(true);
    const full = cleanBars(all, meta, utc("2027-11-30T00:00:00Z"));
    expect(full.report.missingSessionRatio).toBe(0);
    expect(full.report.suspect).toBe(false);
  });

  it("handles empty input", () => {
    const { series, report } = cleanBars([], sapMeta, NOW_SPIKE);
    expect(series.dates).toEqual([]);
    expect(report.keptBars).toBe(0);
    expect(report.droppedForming).toBe(false);
    expect(report.suspect).toBe(false);
  });
});

describe("takeLatest", () => {
  const s: Series = { dates: [1, 2, 3, 4], open: [1, 2, 3, 4], high: [1, 2, 3, 4], low: [1, 2, 3, 4], close: [1, 2, 3, 4], volume: [1, 2, 3, 4] };
  it("returns the last n bars as a copy", () => {
    const t = takeLatest(s, 2);
    expect(t.dates).toEqual([3, 4]);
    t.close[0] = 99;
    expect(s.close[2]).toBe(3);
  });
  it("returns everything when n exceeds the length and nothing for n = 0", () => {
    expect(takeLatest(s, 10).dates).toEqual([1, 2, 3, 4]);
    expect(takeLatest(s, 0).dates).toEqual([]);
  });
});

describe("mergeIncremental", () => {
  const mk = (dates: number[], closes: number[]): Series => ({
    dates,
    open: closes.map((c) => c - 1),
    high: closes.map((c) => c + 1),
    low: closes.map((c) => c - 2),
    close: closes,
    volume: closes.map(() => 10),
  });

  it("appends new bars when the overlap agrees", () => {
    const stored = mk([1, 2, 3, 4, 5], [10, 11, 12, 13, 14]);
    const fresh = mk([4, 5, 6, 7], [13, 14, 15, 16]);
    const r = mergeIncremental(stored, fresh);
    expect(r.series.dates).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(r.series.close).toEqual([10, 11, 12, 13, 14, 15, 16]);
    expect(r.overlapBars).toBe(2);
    expect(r.maxRelDiff).toBe(0);
    expect(r.adjustmentDrift).toBe(false);
  });

  it("absorbs a late correction below 1e-4 relative without drift (fresh wins)", () => {
    const stored = mk([1, 2, 3], [100, 100, 100]);
    const fresh = mk([3, 4], [100.005, 101]);
    const r = mergeIncremental(stored, fresh);
    expect(r.adjustmentDrift).toBe(false);
    expect(r.series.close).toEqual([100, 100, 100.005, 101]);
    expect(r.maxRelDiff).toBeCloseTo(5e-5, 10);
  });

  it("detects a split rewriting history: stored pre-split scale vs fresh adjusted scale", () => {
    const stored = mk([1, 2, 3], [1208.88, 1217.9, 1220]);
    const fresh = mk([2, 3, 4], [121.79, 122, 123]); // 10:1 split adjusted
    const r = mergeIncremental(stored, fresh);
    expect(r.adjustmentDrift).toBe(true);
    expect(r.maxRelDiff).toBeGreaterThan(0.8);
  });

  it("flags drift when the response carries a split newer than the last full refresh, even if the overlap agrees", () => {
    const stored = mk([1, 2, 3], [10, 11, 12]);
    const fresh = mk([2, 3, 4], [11, 12, 13]);
    expect(mergeIncremental(stored, fresh, { newerSplit: true }).adjustmentDrift).toBe(true);
    expect(mergeIncremental(stored, fresh, { newerSplit: false }).adjustmentDrift).toBe(false);
  });

  it("flags drift when nothing overlaps (adjustment cannot be proven)", () => {
    const stored = mk([1, 2, 3], [10, 11, 12]);
    const fresh = mk([20, 21], [13, 14]);
    const r = mergeIncremental(stored, fresh);
    expect(r.overlapBars).toBe(0);
    expect(r.adjustmentDrift).toBe(true);
  });

  it("keeps a stored bar the fresh window lacks (union by day) and leaves stored untouched when fresh is empty", () => {
    const stored = mk([1, 2, 3], [10, 11, 12]);
    const fresh = mk([1, 3, 4], [10, 12, 13]);
    expect(mergeIncremental(stored, fresh).series.dates).toEqual([1, 2, 3, 4]);
    const empty = mergeIncremental(stored, mk([], []));
    expect(empty.series.close).toEqual([10, 11, 12]);
    expect(empty.adjustmentDrift).toBe(false);
  });

  it("an empty stored series merges to the fresh series without drift", () => {
    const r = mergeIncremental(mk([], []), mk([1, 2], [5, 6]));
    expect(r.series.dates).toEqual([1, 2]);
    expect(r.adjustmentDrift).toBe(false);
  });
});

describe("seriesStats", () => {
  it("matches the report of cleanBars and can be recomputed over a merged series", () => {
    const stored: Series = { dates: [1, 2, 3], open: [10, 10, 10], high: [11, 11, 11], low: [9, 9, 9], close: [10, 10, 10], volume: [1, 1, 1] };
    const fresh: Series = { dates: [3, 4], open: [10, 30], high: [11, 31], low: [9, 29], close: [10, 30], volume: [1, 1] };
    const merged = mergeIncremental(stored, fresh).series;
    const stats = seriesStats(merged);
    expect(stats.jumpAnomalies).toBe(1); // 10 -> 30
    expect(stats.ohlcInconsistent).toBe(0);
    expect(stats.suspect).toBe(false);
  });
});
```

- [ ] **Step 2: Run it: `bun run test:core -- supabase/functions/_shared/core/bars.test.ts`; Expected: FAIL (Failed to resolve import ./bars.ts)**

- [ ] **Step 3: Implement**

**`supabase/functions/_shared/core/bars.ts`**

```ts
import { expectedWeekdays, localDayNumber, localParts } from "./calendar.ts";

export interface RawBar {
  time: number;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  volume: number | null;
}

export interface ChartMeta {
  exchangeTimezoneName: string; // IANA, e.g. "Europe/Berlin"
  regularMarketTime: number | null; // epoch ms of the last regular-session trade
  currentTradingPeriod: { start: number; end: number } | null; // regular session of the current-or-next session, epoch ms
  marketState?: string; // from quote(): REGULAR | PRE | PREPRE | POST | POSTPOST | CLOSED
  /** Fallback close "HH:MM" (exchanges.session_close_local) used only when currentTradingPeriod is null. */
  sessionCloseLocal?: string | null;
}

export interface Series {
  dates: number[];
  open: number[];
  high: number[];
  low: number[];
  close: number[];
  volume: number[];
}

export interface CleanReport {
  inputBars: number;
  keptBars: number;
  droppedNullClose: number;
  droppedNullHighLow: number;
  droppedNonPositive: number;
  droppedDuplicates: number;
  droppedForming: boolean;
  ohlcInconsistent: number; // close outside [low, high] beyond 1e-6 relative: kept, counted
  jumpAnomalies: number; // |close/prev - 1| > 0.5: kept, counted (A-16)
  missingSessionRatio: number; // 1 - kept / expected weekdays in the span (A-16)
  suspect: boolean; // jumpAnomalies >= 3 || missingSessionRatio > 0.15 (A-16)
}

export const FORMING_MARGIN_MS = 30 * 60_000; // safety margin after the regular session end (A-10)
export const OHLC_TOLERANCE = 1e-6;
export const JUMP_THRESHOLD = 0.5;
export const SUSPECT_JUMPS = 3;
export const SUSPECT_MISSING_RATIO = 0.15;
export const ADJUSTMENT_DRIFT_TOLERANCE = 1e-4;
const WEEKDAYS = [1, 2, 3, 4, 5] as const;

/** Exchange-local date of a session-open instant as days since 1970-01-01. */
export function sessionDay(epochMs: number, tz: string): number {
  return localDayNumber(epochMs, tz);
}

function localMinutesOfDay(epochMs: number, tz: string): number {
  const p = localParts(epochMs, tz);
  return p.hour * 60 + p.minute;
}

/**
 * Forming-bar rule (spec 4.3.1). currentTradingPeriod always describes the current-or-next regular session.
 *   completed := last.time < period.start OR regularMarketTime >= period.end
 *   forming   := NOT completed OR (marketState == "REGULAR" AND the bar is of today's local day)
 *                OR (sessionDay(last) == today in the exchange zone AND now < end of that session + 30 min)
 * Without currentTradingPeriod: forming iff the bar's day is today and (when sessionCloseLocal is known) local time < close + 30 min.
 */
export function isFormingLastBar(lastBarMs: number, meta: ChartMeta, nowMs: number): boolean {
  const tz = meta.exchangeTimezoneName;
  const lastDay = sessionDay(lastBarMs, tz);
  const today = localDayNumber(nowMs, tz);
  // A REGULAR market state means today's session is in progress. A bar of an earlier local day is a completed session
  // (Yahoo may not have created today's bar yet), so it is never dropped on the state alone.
  if (meta.marketState === "REGULAR" && lastDay >= today) return true;
  const period = meta.currentTradingPeriod;

  if (period === null) {
    if (lastDay !== today) return false;
    const close = meta.sessionCloseLocal ?? null;
    if (close === null) return true; // cannot prove the session is over: stay conservative
    const [hh, mm] = close.split(":");
    const closeMinutes = Number(hh) * 60 + Number(mm);
    return localMinutesOfDay(nowMs, tz) < closeMinutes + FORMING_MARGIN_MS / 60_000;
  }

  const completed = lastBarMs < period.start || (meta.regularMarketTime !== null && meta.regularMarketTime >= period.end);
  if (!completed) return true;
  // The bar belongs to the session `period` describes only when it is not older than period.start.
  if (lastBarMs >= period.start && lastDay === today && nowMs < period.end + FORMING_MARGIN_MS) return true;
  return false;
}

interface Row {
  day: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  time: number;
}

function isNum(v: number | null): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

export interface SeriesStats {
  ohlcInconsistent: number;
  jumpAnomalies: number;
  missingSessionRatio: number;
  suspect: boolean;
}

/** Quality statistics of a cleaned series (also recomputed over the merged series after an incremental update). */
export function seriesStats(series: Series): SeriesStats {
  let ohlcInconsistent = 0;
  let jumpAnomalies = 0;
  for (let i = 0; i < series.close.length; i++) {
    const c = series.close[i] as number;
    const h = series.high[i] as number;
    const l = series.low[i] as number;
    if (c > h + OHLC_TOLERANCE * Math.abs(h) || c < l - OHLC_TOLERANCE * Math.abs(l) || l > h + OHLC_TOLERANCE * Math.abs(h)) {
      ohlcInconsistent++;
    }
    if (i > 0) {
      const prev = series.close[i - 1] as number;
      if (Math.abs(c / prev - 1) > JUMP_THRESHOLD) jumpAnomalies++;
    }
  }
  let missingSessionRatio = 0;
  if (series.dates.length > 0) {
    const first = series.dates[0] as number;
    const lastDay = series.dates[series.dates.length - 1] as number;
    const expected = expectedWeekdays(first, lastDay, WEEKDAYS);
    missingSessionRatio = expected > 0 ? Math.max(0, 1 - series.dates.length / expected) : 0;
  }
  return {
    ohlcInconsistent,
    jumpAnomalies,
    missingSessionRatio,
    suspect: jumpAnomalies >= SUSPECT_JUMPS || missingSessionRatio > SUSPECT_MISSING_RATIO,
  };
}

export function cleanBars(raw: RawBar[], meta: ChartMeta, nowMs: number): { series: Series; report: CleanReport } {
  const tz = meta.exchangeTimezoneName;
  let droppedNullClose = 0;
  let droppedNullHighLow = 0;
  let droppedNonPositive = 0;
  const rows: Row[] = [];

  for (const bar of raw) {
    // 2. null / NaN / non-finite close, high or low is missing data, never a trading day
    if (!isNum(bar.close)) {
      droppedNullClose++;
      continue;
    }
    if (!isNum(bar.high) || !isNum(bar.low)) {
      droppedNullHighLow++;
      continue;
    }
    // 3. non-positive close
    if (bar.close <= 0) {
      droppedNonPositive++;
      continue;
    }
    rows.push({
      day: sessionDay(bar.time, tz), // 1. exchange-local session day, never the UTC date
      open: isNum(bar.open) ? bar.open : bar.close, // open is not used by the indicator; fall back to close
      high: bar.high,
      low: bar.low,
      close: bar.close,
      volume: isNum(bar.volume) ? bar.volume : 0,
      time: bar.time,
    });
  }

  // 4. sort by session day (stable), de-duplicate by day keeping the last occurrence
  const indexed = rows.map((r, i) => ({ r, i }));
  indexed.sort((a, b) => a.r.day - b.r.day || a.i - b.i);
  const kept: Row[] = [];
  let droppedDuplicates = 0;
  for (const { r } of indexed) {
    const prev = kept[kept.length - 1];
    if (prev !== undefined && prev.day === r.day) {
      kept[kept.length - 1] = r;
      droppedDuplicates++;
    } else {
      kept.push(r);
    }
  }

  // 5. forming-bar rule on the last remaining bar
  let droppedForming = false;
  const last = kept[kept.length - 1];
  if (last !== undefined && isFormingLastBar(last.time, meta, nowMs)) {
    kept.pop();
    droppedForming = true;
  }

  const series: Series = { dates: [], open: [], high: [], low: [], close: [], volume: [] };
  for (const r of kept) {
    series.dates.push(r.day);
    series.open.push(r.open);
    series.high.push(r.high);
    series.low.push(r.low);
    series.close.push(r.close);
    series.volume.push(r.volume);
  }

  // 6. report
  const stats = seriesStats(series);
  const report: CleanReport = {
    inputBars: raw.length,
    keptBars: series.dates.length,
    droppedNullClose,
    droppedNullHighLow,
    droppedNonPositive,
    droppedDuplicates,
    droppedForming,
    ...stats,
  };
  return { series, report };
}

/** The last n bars (a copy). */
export function takeLatest(series: Series, n: number): Series {
  const start = Math.max(0, series.dates.length - Math.max(0, n));
  return {
    dates: series.dates.slice(start),
    open: series.open.slice(start),
    high: series.high.slice(start),
    low: series.low.slice(start),
    close: series.close.slice(start),
    volume: series.volume.slice(start),
  };
}

/**
 * Merges a freshly fetched tail into the stored series (union by session day, fresh wins).
 * adjustmentDrift is true when any overlapping close differs by more than 1e-4 relative, when the response carried a split newer
 * than the stored series' last full refresh (opts.newerSplit), or when nothing overlaps so adjustment cannot be proven.
 * On drift the caller MUST NOT persist `series`: it would combine pre- and post-split scales. It schedules a full backfill instead.
 */
export function mergeIncremental(
  stored: Series,
  fresh: Series,
  opts: { newerSplit?: boolean } = {},
): { series: Series; overlapBars: number; maxRelDiff: number; adjustmentDrift: boolean } {
  const storedIndex = new Map<number, number>();
  stored.dates.forEach((d, i) => storedIndex.set(d, i));
  let overlapBars = 0;
  let maxRelDiff = 0;
  fresh.dates.forEach((d, i) => {
    const j = storedIndex.get(d);
    if (j === undefined) return;
    overlapBars++;
    const a = stored.close[j] as number;
    const b = fresh.close[i] as number;
    const rel = Math.abs(b - a) / Math.abs(a);
    if (rel > maxRelDiff) maxRelDiff = rel;
  });

  const byDay = new Map<number, number[]>();
  const put = (s: Series, i: number) =>
    byDay.set(s.dates[i] as number, [s.open[i] as number, s.high[i] as number, s.low[i] as number, s.close[i] as number, s.volume[i] as number]);
  for (let i = 0; i < stored.dates.length; i++) put(stored, i);
  for (let i = 0; i < fresh.dates.length; i++) put(fresh, i);
  const days = [...byDay.keys()].sort((a, b) => a - b);
  const series: Series = { dates: [], open: [], high: [], low: [], close: [], volume: [] };
  for (const d of days) {
    const v = byDay.get(d) as number[];
    series.dates.push(d);
    series.open.push(v[0] as number);
    series.high.push(v[1] as number);
    series.low.push(v[2] as number);
    series.close.push(v[3] as number);
    series.volume.push(v[4] as number);
  }

  const cannotVerify = stored.dates.length > 0 && fresh.dates.length > 0 && overlapBars === 0;
  const adjustmentDrift = opts.newerSplit === true || cannotVerify || maxRelDiff > ADJUSTMENT_DRIFT_TOLERANCE;
  return { series, overlapBars, maxRelDiff, adjustmentDrift };
}
```

- [ ] **Step 4: Run; Expected: PASS** `bun run test:core -- supabase/functions/_shared/core/bars.test.ts` (32 tests: the five observed forming-bar states, 30-minute margin, SAP.DE null plus forming bar, NVDA split days, drift cases).

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/core/bars.ts supabase/functions/_shared/core/bars.test.ts
git commit -m "feat(core): bar cleaning, forming-bar rule and incremental merge"
```

---
### Task 5: thresholds.ts, eligibility.ts, ranking.ts

**Parallelism:** can run concurrently with Tasks 1-4, 6, 7, 8 once Tasks 1 (`units.ts`) and 3 (`indicator.ts`) have landed (type-only imports of `Channel` and `ChannelOutcome`, and `toMajor` in a test).

**Files:**
- Create: `supabase/functions/_shared/core/thresholds.ts`, `supabase/functions/_shared/core/eligibility.ts`, `supabase/functions/_shared/core/ranking.ts`
- Test: `supabase/functions/_shared/core/thresholds.test.ts`, `supabase/functions/_shared/core/eligibility.test.ts`, `supabase/functions/_shared/core/ranking.test.ts`

**Interfaces:**
- Consumes: `indicator.ts` (`Channel`, `ChannelOutcome`), `calendar.ts` (`subtractYears`), `units.ts`
- Produces: spec 4.5-4.7: `UniverseMode`, `ThresholdLine`, `SignalKind`, `applicableDiscountLine`, `lineEnd`, `isDiscount`, `isPremium`, `lowerLinePositive`, `classifyHolding`; `RuleCode`, `Tier1Input`, `Tier1Result`, `marketCapUsd`, `evaluateTier1`, `evaluateTier2`, `carryForwardEligible`; `RankCandidate`, `RankedRow`, `MergedEntry`, `rankUniverse`, `isUsExchange`, `isUsPrimary`, `mergeModesForNotification`

- [ ] **Step 1: Write the failing tests**

**`supabase/functions/_shared/core/thresholds.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import type { Channel } from "./indicator.ts";
import {
  applicableDiscountLine,
  classifyHolding,
  isDiscount,
  isPremium,
  lineEnd,
  lowerLinePositive,
} from "./thresholds.ts";

const end = { base: 100, upper1: 110, upper2: 120, lower1: 90, lower2: 80 };
const channel = { end } as unknown as Channel;

describe("applicableDiscountLine", () => {
  it.each([
    [1, "-3"],
    [7, "-3"],
    [10, "-3"],
    [11, "-4"],
    [40, "-4"],
    [null, "-4"],
  ] as const)("rank %s -> %s", (rank, line) => {
    expect(applicableDiscountLine(rank)).toBe(line);
  });
  it("treats a nonsensical rank (0, negative) as -4 rather than -3", () => {
    expect(applicableDiscountLine(0)).toBe("-4");
    expect(applicableDiscountLine(-1)).toBe("-4");
  });
});

describe("lineEnd", () => {
  it("maps lines to the exact right-end values", () => {
    expect(lineEnd(channel, "-3")).toBe(90);
    expect(lineEnd(channel, "-4")).toBe(80);
    expect(lineEnd(channel, "+1")).toBe(110);
    expect(lineEnd(channel, "+2")).toBe(120);
  });
});

describe("level tests have no epsilon", () => {
  it("isDiscount: equality qualifies, one ulp above does not", () => {
    expect(isDiscount(90, 90)).toBe(true);
    expect(isDiscount(90 + Number.EPSILON * 128, 90)).toBe(false);
    expect(isDiscount(89.99, 90)).toBe(true);
  });
  it("isPremium: equality qualifies, one ulp below does not", () => {
    expect(isPremium(110, 110)).toBe(true);
    expect(isPremium(110 - Number.EPSILON * 128, 110)).toBe(false);
  });
});

describe("lowerLinePositive (zero-line rule)", () => {
  it("is false for 0 and -0.01, true for +0.01", () => {
    expect(lowerLinePositive(0)).toBe(false);
    expect(lowerLinePositive(-0)).toBe(false);
    expect(lowerLinePositive(-0.01)).toBe(false);
    expect(lowerLinePositive(0.01)).toBe(true);
  });
});

describe("classifyHolding", () => {
  const base = { evaluable: true, quoteType: "EQUITY", end, worldwideRank: null as number | null };
  it("precedence: extra_premium > premium > discounted > none", () => {
    expect(classifyHolding({ ...base, close: 125 })).toBe("extra_premium");
    expect(classifyHolding({ ...base, close: 115 })).toBe("premium");
    expect(classifyHolding({ ...base, close: 70 })).toBe("discounted");
    expect(classifyHolding({ ...base, close: 100 })).toBe("none");
  });
  it("a holding outside the universe uses -4 (80), a rank-5 holding uses -3 (90)", () => {
    expect(classifyHolding({ ...base, close: 85, worldwideRank: null })).toBe("none");
    expect(classifyHolding({ ...base, close: 85, worldwideRank: 5 })).toBe("discounted");
  });
  it("is unavailable for non-equities, non-evaluable data and missing numbers", () => {
    expect(classifyHolding({ ...base, quoteType: "ETF", close: 70 })).toBe("unavailable");
    expect(classifyHolding({ ...base, evaluable: false, close: 70 })).toBe("unavailable");
    expect(classifyHolding({ ...base, close: null })).toBe("unavailable");
    expect(classifyHolding({ ...base, end: null, close: 70 })).toBe("unavailable");
  });
  it("never tags a discount when the applicable lower line is not positive", () => {
    const negative = { ...end, lower1: -1, lower2: -2 };
    expect(classifyHolding({ ...base, end: negative, close: -5, worldwideRank: 3 })).toBe("none");
  });
});
```

**`supabase/functions/_shared/core/eligibility.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { dayNumber } from "./calendar.ts";
import {
  MARKET_CAP_MIN_USD,
  carryForwardEligible,
  evaluateTier1,
  evaluateTier2,
  marketCapUsd,
  type RuleCode,
  type Tier1Input,
} from "./eligibility.ts";
import type { Channel, ChannelOutcome } from "./indicator.ts";
import { toMajor } from "./units.ts";

const risingChannel: ChannelOutcome = { ok: true, channel: { rising: true } as unknown as Channel };
const flatChannel: ChannelOutcome = { ok: true, channel: { rising: false } as unknown as Channel };
const sessionDay = dayNumber(2026, 10, 14);

/** A security that passes every Tier 1 rule. */
const passing: Tier1Input = {
  quoteType: "EQUITY",
  isCanonical: true,
  marketCapMajor: 60e9,
  marketCapAgeDays: 0,
  fxUsdPerUnit: 1,
  firstTradeDay: dayNumber(1999, 1, 22),
  dataSessionDay: sessionDay,
  validBars: 3200,
  freshness: "fresh",
  suspect: false,
  channel: risingChannel,
  settingsLength: 2500,
};
const failedOf = (patch: Partial<Tier1Input>): RuleCode[] => evaluateTier1({ ...passing, ...patch }).failed;

describe("evaluateTier1: market cap boundary", () => {
  it("passes a market cap of exactly 50e9 (inclusive)", () => {
    const r = evaluateTier1({ ...passing, marketCapMajor: 50e9 });
    expect(r.member).toBe(true);
    expect(r.marketCapUsd).toBe(50e9);
  });
  it("fails 49,999,999,999 with market_cap_below_threshold", () => {
    const r = evaluateTier1({ ...passing, marketCapMajor: 49_999_999_999 });
    expect(r.member).toBe(false);
    expect(r.failed).toEqual(["market_cap_below_threshold"]);
    expect(r.marketCapUsd).toBe(49_999_999_999);
  });
  it("converts through FX: 7.4e12 JPY at 0.00633 USD is about 46.8e9 and fails", () => {
    expect(failedOf({ marketCapMajor: 7.4e12, fxUsdPerUnit: 0.00633 })).toEqual(["market_cap_below_threshold"]);
    expect(failedOf({ marketCapMajor: 8e12, fxUsdPerUnit: 0.00633 })).toEqual([]);
  });
  it("GBp pitfall: SHEL.L has currency GBp but the market cap is already GBP, so only the price is divided", () => {
    const capGbp = 222.0e9; // spike 3.3
    const gbpUsd = 1.3249596;
    expect(marketCapUsd(capGbp, gbpUsd)).toBeCloseTo(294.1e9, -8);
    expect(failedOf({ marketCapMajor: capGbp, fxUsdPerUnit: gbpUsd })).toEqual([]);
    // dividing the cap by 100 (a minor-unit mix-up) would wrongly eject the company
    expect(failedOf({ marketCapMajor: toMajor(capGbp, "GBp"), fxUsdPerUnit: gbpUsd })).toEqual(["market_cap_below_threshold"]);
  });
  it("marketCapUsd multiplies the major-unit cap by usd-per-unit", () => {
    expect(marketCapUsd(100, 1.5)).toBe(150);
  });
});

describe("evaluateTier1: missing and stale inputs", () => {
  it("market_cap_missing when the cap is null or NaN, with no USD value", () => {
    for (const cap of [null, Number.NaN]) {
      const r = evaluateTier1({ ...passing, marketCapMajor: cap });
      expect(r.failed).toEqual(["market_cap_missing"]);
      expect(r.marketCapUsd).toBeNull();
    }
  });
  it("market_cap_stale when the quote is older than 5 days (5 passes, 6 fails) or its age is unknown", () => {
    expect(failedOf({ marketCapAgeDays: 5 })).toEqual([]);
    expect(failedOf({ marketCapAgeDays: 6 })).toEqual(["market_cap_stale"]);
    expect(failedOf({ marketCapAgeDays: null })).toEqual(["market_cap_stale"]);
    expect(evaluateTier1({ ...passing, marketCapAgeDays: 6 }).marketCapUsd).toBeNull();
  });
  it("fx_missing when no usable rate exists", () => {
    expect(failedOf({ fxUsdPerUnit: null })).toEqual(["fx_missing"]);
    expect(failedOf({ fxUsdPerUnit: 0 })).toEqual(["fx_missing"]);
  });
  it("a stale cap and a missing rate are both reported", () => {
    expect(failedOf({ marketCapAgeDays: 9, fxUsdPerUnit: null })).toEqual(["market_cap_stale", "fx_missing"]);
  });
});

describe("evaluateTier1: history, bars, data quality, channel", () => {
  it("passes a listing of exactly 10 years and fails one day less", () => {
    const exact = dayNumber(2016, 10, 14);
    expect(failedOf({ firstTradeDay: exact })).toEqual([]);
    expect(failedOf({ firstTradeDay: exact + 1 })).toEqual(["listing_too_new"]);
  });
  it("fails an unknown first trade date or session day", () => {
    expect(failedOf({ firstTradeDay: null })).toEqual(["listing_too_new"]);
    expect(failedOf({ dataSessionDay: null })).toEqual(["listing_too_new"]);
  });
  it("2,500 valid bars pass, 2,499 fail even when the listing is old enough", () => {
    expect(failedOf({ validBars: 2500 })).toEqual([]);
    expect(failedOf({ validBars: 2499 })).toEqual(["insufficient_bars"]);
  });
  it("the bar requirement follows settingsLength", () => {
    expect(failedOf({ validBars: 400, settingsLength: 400 })).toEqual([]);
    expect(failedOf({ validBars: 399, settingsLength: 400 })).toEqual(["insufficient_bars"]);
  });
  it("stale, unavailable and suspect data fail", () => {
    expect(failedOf({ freshness: "stale" })).toEqual(["stale_data"]);
    expect(failedOf({ freshness: "unavailable" })).toEqual(["stale_data"]);
    expect(failedOf({ suspect: true })).toEqual(["suspect_data"]);
  });
  it("channel outcomes map to codes", () => {
    expect(failedOf({ channel: flatChannel })).toEqual(["channel_not_rising"]);
    expect(failedOf({ channel: { ok: false, reason: "insufficient_bars" } })).toEqual(["insufficient_data_for_channel"]);
    expect(failedOf({ channel: { ok: false, reason: "non_finite_input" } })).toEqual(["insufficient_data_for_channel"]);
    expect(failedOf({ channel: { ok: false, reason: "invalid_settings" } })).toEqual(["unprocessed"]);
    expect(failedOf({ channel: null })).toEqual(["unprocessed"]);
  });
  it("not_equity and not_canonical fail", () => {
    expect(failedOf({ quoteType: "ETF" })).toEqual(["not_equity"]);
    expect(failedOf({ isCanonical: false })).toEqual(["not_canonical"]);
  });
  it("lists ALL failures in declaration order", () => {
    const r = evaluateTier1({
      quoteType: "ETF", isCanonical: false, marketCapMajor: 1e9, marketCapAgeDays: 0, fxUsdPerUnit: 1,
      firstTradeDay: dayNumber(2020, 1, 1), dataSessionDay: sessionDay, validBars: 100, freshness: "stale", suspect: true,
      channel: flatChannel, settingsLength: 2500,
    });
    expect(r.member).toBe(false);
    expect(r.failed).toEqual([
      "not_equity", "market_cap_below_threshold", "not_canonical", "listing_too_new", "insufficient_bars",
      "stale_data", "suspect_data", "channel_not_rising",
    ]);
  });
  it("a fully passing security is a member", () => {
    expect(evaluateTier1(passing)).toEqual({ member: true, marketCapUsd: 60e9, failed: [] });
  });
});

describe("evaluateTier2", () => {
  const ok = { applicableLowerEnd: 12.5, close: 10, freshness: "fresh", signalGrade: true };
  it("is valid for a positive lower line, finite close, fresh data and signal-grade settings", () => {
    expect(evaluateTier2(ok)).toEqual({ valid: true, failed: [] });
  });
  it("lower line 0 and -0.01 fail, +0.01 passes (zero-line rule)", () => {
    expect(evaluateTier2({ ...ok, applicableLowerEnd: 0 }).failed).toEqual(["lower_line_not_positive"]);
    expect(evaluateTier2({ ...ok, applicableLowerEnd: -0.01 }).failed).toEqual(["lower_line_not_positive"]);
    expect(evaluateTier2({ ...ok, applicableLowerEnd: 0.01 }).valid).toBe(true);
  });
  it("fails a non-finite close, stale data and non signal-grade settings, in order", () => {
    expect(evaluateTier2({ applicableLowerEnd: -1, close: Number.NaN, freshness: "stale", signalGrade: false }).failed).toEqual([
      "lower_line_not_positive", "close_not_finite", "stale_data", "not_signal_grade",
    ]);
    expect(evaluateTier2({ ...ok, close: null }).failed).toEqual(["close_not_finite"]);
  });
  it("a missing channel (no lower end) is unprocessed", () => {
    expect(evaluateTier2({ ...ok, applicableLowerEnd: null }).failed).toEqual(["unprocessed"]);
  });
});

describe("carryForwardEligible", () => {
  it("is true only when every failing rule is a missing, stale or unprocessed input", () => {
    expect(carryForwardEligible(["market_cap_stale"])).toBe(true);
    expect(carryForwardEligible(["market_cap_missing", "fx_missing", "stale_data", "unprocessed"])).toBe(true);
    expect(carryForwardEligible(["market_cap_below_threshold"])).toBe(false);
    expect(carryForwardEligible(["stale_data", "channel_not_rising"])).toBe(false);
    expect(carryForwardEligible([])).toBe(false);
  });
});

describe("constants", () => {
  it("the market cap floor is 50 billion USD", () => {
    expect(MARKET_CAP_MIN_USD).toBe(50_000_000_000);
  });
});
```

**`supabase/functions/_shared/core/ranking.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import {
  isUsExchange,
  isUsPrimary,
  mergeModesForNotification,
  rankUniverse,
  type RankCandidate,
} from "./ranking.ts";

const cand = (symbol: string, cap: number, us = false, company = symbol): RankCandidate => ({
  securityId: `sec-${symbol}`,
  companyId: `co-${company}`,
  yahooSymbol: symbol,
  marketCapUsd: cap,
  isUsPrimary: us,
});

describe("rankUniverse", () => {
  it("sorts descending by market cap with unique ranks 1..N", () => {
    const rows = rankUniverse([cand("B", 200e9), cand("A", 300e9), cand("C", 100e9)], "worldwide");
    expect(rows.map((r) => [r.yahooSymbol, r.rank])).toEqual([["A", 1], ["B", 2], ["C", 3]]);
    expect(new Set(rows.map((r) => r.rank)).size).toBe(3);
  });

  it("breaks ties ascending by yahooSymbol in code-unit order (uppercase before lowercase, digits before letters)", () => {
    const rows = rankUniverse([cand("b", 100e9), cand("B", 100e9), cand("0700.HK", 100e9), cand("A", 100e9)], "worldwide");
    expect(rows.map((r) => r.yahooSymbol)).toEqual(["0700.HK", "A", "B", "b"]);
  });

  it("is deterministic regardless of input order", () => {
    const input = [cand("X", 5e11), cand("Y", 5e11), cand("Z", 4e11), cand("W", 6e11)];
    const a = rankUniverse(input, "worldwide").map((r) => r.yahooSymbol);
    const b = rankUniverse([...input].reverse(), "worldwide").map((r) => r.yahooSymbol);
    expect(a).toEqual(b);
  });

  it("marks isTop10 for ranks 1..10 only (rank 10 true, rank 11 false)", () => {
    const members = Array.from({ length: 12 }, (_, i) => cand(`S${String(i).padStart(2, "0")}`, (100 - i) * 1e9));
    const rows = rankUniverse(members, "worldwide");
    expect(rows[9]?.rank).toBe(10);
    expect(rows[9]?.isTop10).toBe(true);
    expect(rows[10]?.rank).toBe(11);
    expect(rows[10]?.isTop10).toBe(false);
  });

  it("us mode ranks only US-primary members and renumbers from 1", () => {
    const members = [cand("TSM", 900e9, false), cand("AAPL", 800e9, true), cand("MSFT", 700e9, true)];
    expect(rankUniverse(members, "us").map((r) => [r.yahooSymbol, r.rank])).toEqual([["AAPL", 1], ["MSFT", 2]]);
    expect(rankUniverse(members, "worldwide").map((r) => [r.yahooSymbol, r.rank])).toEqual([["TSM", 1], ["AAPL", 2], ["MSFT", 3]]);
  });

  it("does not mutate its input and handles an empty universe", () => {
    const input = [cand("B", 1), cand("A", 2)];
    rankUniverse(input, "worldwide");
    expect(input.map((c) => c.yahooSymbol)).toEqual(["B", "A"]);
    expect(rankUniverse([], "us")).toEqual([]);
  });
});

describe("isUsExchange", () => {
  it.each([["NMS", true], ["NYQ", true], ["NGM", true], ["GER", false], ["PNK", false], ["TOR", false]] as const)("%s -> %s", (code, expected) => {
    expect(isUsExchange(code)).toBe(expected);
  });
});

describe("isUsPrimary", () => {
  const us = { canonicalExchange: "NMS", financialCurrency: "USD", homeCountry: "United States", hasHigherVolumeHomeListing: false, override: null } as const;
  it("is true for a plain US company", () => {
    expect(isUsPrimary(us)).toBe(true);
  });
  it("is true when the home country is unknown", () => {
    expect(isUsPrimary({ ...us, homeCountry: null })).toBe(true);
  });
  it("excludes an ADR through financialCurrency (TSM reports in TWD)", () => {
    expect(isUsPrimary({ ...us, canonicalExchange: "NYQ", financialCurrency: "TWD", homeCountry: "Taiwan" })).toBe(false);
  });
  it("excludes a Shopify-like US listing of a foreign company (USD reporter, non-US country)", () => {
    expect(isUsPrimary({ ...us, canonicalExchange: "NYQ", homeCountry: "Canada" })).toBe(false);
  });
  it("excludes a company whose home listing outside the US trades more", () => {
    expect(isUsPrimary({ ...us, hasHigherVolumeHomeListing: true })).toBe(false);
  });
  it("excludes non-US exchanges", () => {
    expect(isUsPrimary({ ...us, canonicalExchange: "GER" })).toBe(false);
    expect(isUsPrimary({ ...us, canonicalExchange: "PNK" })).toBe(false);
  });
  it("lets an override win in both directions", () => {
    expect(isUsPrimary({ ...us, canonicalExchange: "NYQ", financialCurrency: "TWD", homeCountry: "Taiwan", override: "force_us" })).toBe(true);
    expect(isUsPrimary({ ...us, override: "force_not_us" })).toBe(false);
  });
});

describe("mergeModesForNotification", () => {
  it("returns one entry per company with the first mode of modeOrder as primary", () => {
    const members = [cand("AAPL", 800e9, true), cand("MSFT", 700e9, true), cand("TSM", 900e9, false)];
    const rows = [...rankUniverse(members, "us"), ...rankUniverse(members, "worldwide")];
    const merged = mergeModesForNotification(rows, ["worldwide", "us"]);
    expect(merged).toHaveLength(3);
    const aapl = merged.find((m) => m.primary.yahooSymbol === "AAPL");
    expect(aapl?.primary.mode).toBe("worldwide");
    expect(aapl?.alsoIn).toEqual(["us"]);
    const tsm = merged.find((m) => m.primary.yahooSymbol === "TSM");
    expect(tsm?.alsoIn).toEqual([]);
  });

  it("picks us as primary when the company only has a us row or when us comes first", () => {
    const only = rankUniverse([cand("AAPL", 1e11, true)], "us");
    expect(mergeModesForNotification(only)[0]?.primary.mode).toBe("us");
    const both = [...rankUniverse([cand("AAPL", 1e11, true)], "worldwide"), ...rankUniverse([cand("AAPL", 1e11, true)], "us")];
    expect(mergeModesForNotification(both, ["us", "worldwide"])[0]?.alsoIn).toEqual(["worldwide"]);
  });

  it("orders entries by primary rank then symbol", () => {
    const rows = rankUniverse([cand("B", 2e11), cand("A", 3e11), cand("C", 1e11)], "worldwide");
    expect(mergeModesForNotification(rows).map((m) => m.primary.yahooSymbol)).toEqual(["A", "B", "C"]);
  });
});
```

- [ ] **Step 2: Run it: `bun run test:core -- supabase/functions/_shared/core/thresholds.test.ts supabase/functions/_shared/core/eligibility.test.ts supabase/functions/_shared/core/ranking.test.ts`; Expected: FAIL (Failed to resolve imports ./thresholds.ts, ./eligibility.ts, ./ranking.ts)**

- [ ] **Step 3: Implement (1/3)**

**`supabase/functions/_shared/core/thresholds.ts`**

```ts
import type { Channel } from "./indicator.ts";

export type UniverseMode = "worldwide" | "us";
export type ThresholdLine = "-3" | "-4" | "+1" | "+2";
export type SignalKind = "discount" | "premium1" | "premium2";

/** 1..10 -> "-3"; >= 11 or null (not in the universe) -> "-4". Rank 10 -> -3 and rank 11 -> -4 are pinned by tests. */
export function applicableDiscountLine(rank: number | null): "-3" | "-4" {
  return rank !== null && rank >= 1 && rank <= 10 ? "-3" : "-4";
}

/** "-3" -> end.lower1, "-4" -> end.lower2, "+1" -> end.upper1, "+2" -> end.upper2 (exact right-end values at the latest bar). */
export function lineEnd(ch: Channel, line: ThresholdLine): number {
  switch (line) {
    case "-3":
      return ch.end.lower1;
    case "-4":
      return ch.end.lower2;
    case "+1":
      return ch.end.upper1;
    case "+2":
      return ch.end.upper2;
  }
}

/** close <= lowerEnd; equality qualifies, no epsilon. */
export function isDiscount(close: number, lowerEnd: number): boolean {
  return close <= lowerEnd;
}

/** close >= upperEnd; equality qualifies, no epsilon. */
export function isPremium(close: number, upperEnd: number): boolean {
  return close >= upperEnd;
}

/** Zero-line rule (D10): the applicable lower line end must be strictly above zero. */
export function lowerLinePositive(lowerEnd: number): boolean {
  return lowerEnd > 0;
}

export type HoldingTag = "discounted" | "premium" | "extra_premium" | "unavailable" | "none";

/**
 * Tag of a held security (8.6). Precedence: extra_premium > premium > discounted > none.
 * Non-equities and non-evaluable data are "unavailable". Holdings outside the universe pass worldwideRank = null and use "-4".
 */
export function classifyHolding(i: {
  evaluable: boolean;
  quoteType: string;
  close: number | null;
  end: Channel["end"] | null;
  worldwideRank: number | null;
}): HoldingTag {
  if (!i.evaluable || i.quoteType !== "EQUITY" || i.close === null || !Number.isFinite(i.close) || i.end === null) return "unavailable";
  if (isPremium(i.close, i.end.upper2)) return "extra_premium";
  if (isPremium(i.close, i.end.upper1)) return "premium";
  const lower = applicableDiscountLine(i.worldwideRank) === "-3" ? i.end.lower1 : i.end.lower2;
  if (isDiscount(i.close, lower) && lowerLinePositive(lower)) return "discounted";
  return "none";
}
```

- [ ] **Step 4: Implement (2/3)**

**`supabase/functions/_shared/core/eligibility.ts`**

```ts
import { subtractYears } from "./calendar.ts";
import type { ChannelOutcome } from "./indicator.ts";

/** Inclusive market-cap floor in USD (D11). */
export const MARKET_CAP_MIN_USD = 50e9;
/** A quote older than this many calendar days gives a stale market cap, treated as missing (A-02). */
export const MARKET_CAP_MAX_AGE_DAYS = 5;
/** A listing needs this many years of history (D11). */
export const MIN_LISTING_YEARS = 10;
/** A security failing only on missing inputs stays in membership this many consecutive scans (A-02). */
export const MAX_CARRY_FORWARD_SCANS = 3;

export type RuleCode =
  | "not_equity"
  | "market_cap_missing"
  | "market_cap_stale"
  | "fx_missing"
  | "market_cap_below_threshold"
  | "not_canonical"
  | "listing_too_new"
  | "insufficient_bars"
  | "stale_data"
  | "suspect_data"
  | "insufficient_data_for_channel"
  | "channel_not_rising"
  | "lower_line_not_positive"
  | "close_not_finite"
  | "not_signal_grade"
  | "unprocessed";

export interface Tier1Input {
  quoteType: string;
  isCanonical: boolean;
  marketCapMajor: number | null;
  marketCapAgeDays: number | null;
  fxUsdPerUnit: number | null;
  firstTradeDay: number | null;
  dataSessionDay: number | null;
  validBars: number;
  freshness: "fresh" | "stale" | "unavailable";
  suspect: boolean;
  channel: ChannelOutcome | null;
  settingsLength: number;
}

export interface Tier1Result {
  member: boolean;
  marketCapUsd: number | null;
  failed: RuleCode[];
}

/** marketCapMajor * fxUsdPerUnit. The market cap is in the MAJOR unit already (GBP for a GBp listing); it is never divided. */
export function marketCapUsd(marketCapMajor: number, fxUsdPerUnit: number): number {
  return marketCapMajor * fxUsdPerUnit;
}

/** Tier 1 (membership, rank independent). `failed` lists ALL failing rules, in the declaration order of RuleCode. */
export function evaluateTier1(i: Tier1Input): Tier1Result {
  const failed: RuleCode[] = [];
  let usd: number | null = null;

  // (a)
  if (i.quoteType !== "EQUITY") failed.push("not_equity");

  // (b) market cap known, fresh, convertible and >= 50e9 USD (inclusive)
  const capKnown = i.marketCapMajor !== null && Number.isFinite(i.marketCapMajor);
  let capUsable = false;
  if (!capKnown) {
    failed.push("market_cap_missing");
  } else if (i.marketCapAgeDays === null || i.marketCapAgeDays > MARKET_CAP_MAX_AGE_DAYS) {
    failed.push("market_cap_stale"); // an unknown quote time cannot prove freshness
  } else {
    capUsable = true;
  }
  const fxKnown = i.fxUsdPerUnit !== null && Number.isFinite(i.fxUsdPerUnit) && i.fxUsdPerUnit > 0;
  if (capKnown && !fxKnown) failed.push("fx_missing");
  if (capUsable && fxKnown) {
    usd = marketCapUsd(i.marketCapMajor as number, i.fxUsdPerUnit as number);
    if (usd < MARKET_CAP_MIN_USD) failed.push("market_cap_below_threshold");
  }

  // (c)
  if (!i.isCanonical) failed.push("not_canonical");

  // (d) exactly ten years passes; one day less fails; unknown dates fail
  if (i.firstTradeDay === null || i.dataSessionDay === null || i.firstTradeDay > subtractYears(i.dataSessionDay, MIN_LISTING_YEARS)) {
    failed.push("listing_too_new");
  }

  // (e)
  if (i.validBars < i.settingsLength) failed.push("insufficient_bars");

  // (f)
  if (i.freshness !== "fresh") failed.push("stale_data");
  if (i.suspect) failed.push("suspect_data");

  // (g)
  if (i.channel !== null) {
    if (i.channel.ok) {
      if (!i.channel.channel.rising) failed.push("channel_not_rising");
    } else if (i.channel.reason === "invalid_settings") {
      failed.push("unprocessed");
    } else {
      failed.push("insufficient_data_for_channel");
    }
  } else {
    failed.push("unprocessed");
  }

  // keep the documented order even though "unprocessed" can be pushed from the channel branch
  const order: RuleCode[] = [
    "not_equity", "market_cap_missing", "market_cap_stale", "fx_missing", "market_cap_below_threshold", "not_canonical",
    "listing_too_new", "insufficient_bars", "stale_data", "suspect_data", "insufficient_data_for_channel", "channel_not_rising",
    "lower_line_not_positive", "close_not_finite", "not_signal_grade", "unprocessed",
  ];
  failed.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  return { member: failed.length === 0, marketCapUsd: usd, failed };
}

/** Tier 2 (signal validity, rank dependent). Order: (h) lower line, (i) close, (j) fresh, (k) signal grade. */
export function evaluateTier2(i: {
  applicableLowerEnd: number | null;
  close: number | null;
  freshness: string;
  signalGrade: boolean;
}): { valid: boolean; failed: RuleCode[] } {
  const failed: RuleCode[] = [];
  if (i.applicableLowerEnd === null) failed.push("unprocessed");
  else if (!(i.applicableLowerEnd > 0)) failed.push("lower_line_not_positive");
  if (i.close === null || !Number.isFinite(i.close)) failed.push("close_not_finite");
  if (i.freshness !== "fresh") failed.push("stale_data");
  if (!i.signalGrade) failed.push("not_signal_grade");
  return { valid: failed.length === 0, failed };
}

const CARRY_FORWARD_CODES: ReadonlySet<RuleCode> = new Set<RuleCode>([
  "market_cap_missing",
  "market_cap_stale",
  "fx_missing",
  "stale_data",
  "insufficient_data_for_channel",
  "unprocessed",
]);

/** True when every failing rule is a missing/stale/unprocessed INPUT (a data problem), never a genuine ineligibility. */
export function carryForwardEligible(failed: readonly RuleCode[]): boolean {
  return failed.length > 0 && failed.every((c) => CARRY_FORWARD_CODES.has(c));
}
```

- [ ] **Step 5: Implement (3/3)**

**`supabase/functions/_shared/core/ranking.ts`**

```ts
import type { UniverseMode } from "./thresholds.ts";

export interface RankCandidate {
  securityId: string;
  companyId: string;
  yahooSymbol: string;
  marketCapUsd: number;
  isUsPrimary: boolean;
}

export interface RankedRow extends RankCandidate {
  mode: UniverseMode;
  rank: number;
  isTop10: boolean;
}

/** One digest entry per company: the first mode of modeOrder with a row is primary, the others are listed in alsoIn (D12). */
export interface MergedEntry {
  companyId: string;
  primary: RankedRow;
  alsoIn: UniverseMode[];
}

const US_EXCHANGES: ReadonlySet<string> = new Set(["NMS", "NYQ", "NGM"]);

export function isUsExchange(code: string): boolean {
  return US_EXCHANGES.has(code);
}

/** UTF-16 code-unit comparison (never localeCompare). */
function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Sort descending by marketCapUsd, tie-break ascending yahooSymbol (code-unit order). Ranks 1..N are unique.
 * "us" ranks only isUsPrimary members. Changing the tie-break is a breaking change.
 */
export function rankUniverse(members: RankCandidate[], mode: UniverseMode): RankedRow[] {
  const pool = mode === "us" ? members.filter((m) => m.isUsPrimary) : [...members];
  pool.sort((a, b) => b.marketCapUsd - a.marketCapUsd || compareCodeUnits(a.yahooSymbol, b.yahooSymbol));
  return pool.map((m, i) => ({ ...m, mode, rank: i + 1, isTop10: i + 1 <= 10 }));
}

/**
 * US-primary (A-05): US exchange AND financialCurrency USD AND no higher-volume home listing AND home country the United States
 * (when known). An override from security_identity_overrides wins.
 */
export function isUsPrimary(input: {
  canonicalExchange: string;
  financialCurrency: string | null;
  homeCountry: string | null;
  hasHigherVolumeHomeListing: boolean;
  override: "force_us" | "force_not_us" | null;
}): boolean {
  if (input.override === "force_us") return true;
  if (input.override === "force_not_us") return false;
  return (
    isUsExchange(input.canonicalExchange) &&
    input.financialCurrency === "USD" &&
    !input.hasHigherVolumeHomeListing &&
    (input.homeCountry === null || input.homeCountry === "United States")
  );
}

export function mergeModesForNotification(rows: RankedRow[], modeOrder: UniverseMode[] = ["worldwide", "us"]): MergedEntry[] {
  const byCompany = new Map<string, RankedRow[]>();
  for (const r of rows) {
    const list = byCompany.get(r.companyId);
    if (list === undefined) byCompany.set(r.companyId, [r]);
    else list.push(r);
  }
  const out: MergedEntry[] = [];
  for (const [companyId, list] of byCompany) {
    const ordered = [...list].sort((a, b) => modeOrder.indexOf(a.mode) - modeOrder.indexOf(b.mode));
    const primary = ordered[0] as RankedRow;
    out.push({ companyId, primary, alsoIn: ordered.slice(1).map((r) => r.mode) });
  }
  out.sort((a, b) => a.primary.rank - b.primary.rank || compareCodeUnits(a.primary.yahooSymbol, b.primary.yahooSymbol));
  return out;
}
```

- [ ] **Step 6: Run; Expected: PASS** `bun run test:core -- supabase/functions/_shared/core/thresholds.test.ts supabase/functions/_shared/core/eligibility.test.ts supabase/functions/_shared/core/ranking.test.ts` (boundaries: cap 49,999,999,999 vs 50e9, rank 10/11, exactly 10 years, 2,499 vs 2,500 bars, lower line 0/-0.01/+0.01, US-primary exclusions, SHEL.L GBp pitfall).

- [ ] **Step 7: Commit**

```bash
git add supabase/functions/_shared/core/thresholds.ts supabase/functions/_shared/core/thresholds.test.ts supabase/functions/_shared/core/eligibility.ts supabase/functions/_shared/core/eligibility.test.ts supabase/functions/_shared/core/ranking.ts supabase/functions/_shared/core/ranking.test.ts
git commit -m "feat(core): thresholds, tiered eligibility and ranking"
```

---
### Task 6: identity.ts

**Parallelism:** can run concurrently with Tasks 1-5, 7, 8 once Task 5 (`ranking.ts`: `isUsExchange`) has landed.

**Files:**
- Create: `supabase/functions/_shared/core/identity.ts`
- Test: `supabase/functions/_shared/core/identity.test.ts`

**Interfaces:**
- Consumes: `ranking.ts` (`isUsExchange`)
- Produces: `ListingFact`, `ListingRole`, `Override`, `OverrideKind`, `normalizeName`, `groupListings`, `chooseCanonical`, `applyForceCanonical`, `CanonicalOptions`, `DEFAULT_SWITCH_RATIO`

- [ ] **Step 1: Write the failing test**

**`supabase/functions/_shared/core/identity.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import {
  applyForceCanonical,
  chooseCanonical,
  groupListings,
  normalizeName,
  type ListingFact,
  type Override,
} from "./identity.ts";

let seq = 0;
function listing(symbol: string, exchange: string, country: string, patch: Partial<ListingFact> = {}): ListingFact {
  seq++;
  return {
    securityId: `id-${String(seq).padStart(3, "0")}-${symbol}`,
    symbol,
    exchange,
    venueClass: "primary",
    exchangeCountry: country,
    longName: null,
    marketCapUsd: null,
    sharesOutstanding: null,
    avgUsdVolume30d: null,
    firstTradeDay: null,
    ...patch,
  };
}
const symbolsOf = (groups: ListingFact[][]) => groups.map((g) => g.map((l) => l.symbol));

describe("normalizeName", () => {
  it.each([
    ["Microsoft Corporation", "microsoft"],
    ["MICROSOFT CORP.", "microsoft"],
    ["Alphabet Inc.", "alphabet"],
    ["Nestlé S.A.", "nestle"],
    ["SAP SE", "sap"],
    ["AT&T Inc.", "at and t"],
    ["Taiwan Semiconductor Manufacturing Company Limited", "taiwan semiconductor manufacturing"],
    ["Royal Dutch Shell plc", "royal dutch shell"],
    ["Berkshire Hathaway Inc.", "berkshire hathaway"],
    ["Samsung Electronics Co., Ltd.", "samsung electronics"],
  ])("%s -> %s", (input, expected) => {
    expect(normalizeName(input)).toBe(expected);
  });
  it("keeps group and holding words so distinct companies never merge", () => {
    expect(normalizeName("Prosus Group N.V.")).toBe("prosus group");
    expect(normalizeName("Alibaba Group Holding Limited")).toBe("alibaba group holding");
  });
  it("never reduces a name to nothing and handles empty input", () => {
    expect(normalizeName("Inc")).toBe("inc");
    expect(normalizeName("")).toBe("");
  });
});

describe("groupListings", () => {
  it("groups MSFT with its German cross-listing MSF.DE by name and market cap, and keeps AAPL apart", () => {
    const msft = listing("MSFT", "NMS", "United States", { longName: "Microsoft Corporation", marketCapUsd: 3.96e12, sharesOutstanding: 7_425_545_491 });
    const msfde = listing("MSF.DE", "GER", "Germany", { longName: "Microsoft Corporation", marketCapUsd: 3.94e12, sharesOutstanding: 7_425_545_491 });
    const aapl = listing("AAPL", "NMS", "United States", { longName: "Apple Inc.", marketCapUsd: 3.4e12 });
    const { groups, needsReview } = groupListings([aapl, msfde, msft], []);
    expect(symbolsOf(groups)).toEqual([["AAPL"], ["MSF.DE", "MSFT"]]);
    expect(needsReview).toEqual([]);
  });

  it("groups TSMC's ordinary line with the ADR despite the company-suffix difference", () => {
    const tw = listing("2330.TW", "TAI", "Taiwan", { longName: "Taiwan Semiconductor Manufacturing Company Limited", marketCapUsd: 1.0e12 });
    const adr = listing("TSM", "NYQ", "United States", { longName: "Taiwan Semiconductor Manufacturing Co Ltd", marketCapUsd: 1.02e12 });
    expect(symbolsOf(groupListings([adr, tw], []).groups)).toEqual([["2330.TW", "TSM"]]);
  });

  it("a same-name pair whose caps differ by more than 40% is two companies (look-alike exclusion by cap mismatch)", () => {
    const a = listing("NES", "NYQ", "United States", { longName: "Nestle", marketCapUsd: 100e9 });
    const b = listing("NESTLEIND.NS", "NSI", "India", { longName: "Nestle", marketCapUsd: 20e9 });
    const r = groupListings([a, b], []);
    expect(symbolsOf(r.groups)).toEqual([["NES"], ["NESTLEIND.NS"]]);
    expect(r.needsReview).toEqual([]);
  });

  it("a same-name pair 15-40% apart goes to review and is not grouped", () => {
    const a = listing("AAA", "NYQ", "United States", { longName: "Acme Corp", marketCapUsd: 100e9 });
    const b = listing("AAA.L", "LSE", "United Kingdom", { longName: "Acme Corporation", marketCapUsd: 75e9 });
    const r = groupListings([a, b], []);
    expect(symbolsOf(r.groups)).toEqual([["AAA"], ["AAA.L"]]);
    expect(r.needsReview).toHaveLength(1);
    expect(r.needsReview[0]?.why).toBe("cap_mismatch");
  });

  it("equal share counts alone (different names, similar caps) go to review, not into one group", () => {
    const a = listing("ONE", "NYQ", "United States", { longName: "Alpha Industries", marketCapUsd: 100e9, sharesOutstanding: 1_000_000_000 });
    const b = listing("TWO", "NYQ", "United States", { longName: "Beta Holdings", marketCapUsd: 98e9, sharesOutstanding: 1_000_000_000 });
    const r = groupListings([a, b], []);
    expect(symbolsOf(r.groups)).toEqual([["ONE"], ["TWO"]]);
    expect(r.needsReview.map((p) => p.why)).toEqual(["shares_only"]);
  });

  it("ASM.F (different company, different shares) never joins ASML even with a similar prefix", () => {
    const asml = listing("ASML", "NMS", "Netherlands", { longName: "ASML Holding N.V.", marketCapUsd: 380e9, sharesOutstanding: 384_100_000 });
    const asm = listing("ASM.F", "FRA", "Germany", { longName: "ASM International NV", marketCapUsd: 30e9, sharesOutstanding: 17_500_431_702 });
    expect(symbolsOf(groupListings([asml, asm], []).groups)).toEqual([["ASM.F"], ["ASML"]]);
  });

  it("name match with an unknown cap still groups (secondary lines without data)", () => {
    const a = listing("MSFT", "NMS", "United States", { longName: "Microsoft Corporation", marketCapUsd: 3.9e12 });
    const b = listing("MSF.MU", "MUN", "Germany", { longName: "Microsoft Corp", venueClass: "secondary_only" });
    expect(symbolsOf(groupListings([a, b], []).groups)).toEqual([["MSF.MU", "MSFT"]]);
  });

  it("override exclude removes a listing, merge_into_company unions two listings", () => {
    const a = listing("AAA", "NYQ", "United States", { longName: "Acme Corp", marketCapUsd: 100e9 });
    const b = listing("BBB", "NYQ", "United States", { longName: "Totally Different", marketCapUsd: 10e9 });
    const c = listing("CCC", "NYQ", "United States", { longName: "Another One", marketCapUsd: 11e9 });
    const overrides: Override[] = [
      { kind: "exclude", yahooSymbol: "CCC" },
      { kind: "merge_into_company", yahooSymbol: "BBB", targetYahooSymbol: "AAA" },
    ];
    expect(symbolsOf(groupListings([a, b, c], overrides).groups)).toEqual([["AAA", "BBB"]]);
  });

  it("is deterministic regardless of input order", () => {
    const xs = [
      listing("MSFT", "NMS", "United States", { longName: "Microsoft Corporation", marketCapUsd: 3.9e12 }),
      listing("MSF.DE", "GER", "Germany", { longName: "Microsoft Corporation", marketCapUsd: 3.9e12 }),
      listing("AAPL", "NMS", "United States", { longName: "Apple Inc.", marketCapUsd: 3.4e12 }),
    ];
    expect(symbolsOf(groupListings(xs, []).groups)).toEqual(symbolsOf(groupListings([...xs].reverse(), []).groups));
  });
});

describe("chooseCanonical", () => {
  const opts = { switchRatio: 1.5 };

  it("Alphabet classes: the higher 30-day volume class is canonical, the other is a share_class", () => {
    const goog = listing("GOOG", "NMS", "United States", { avgUsdVolume30d: 3.0e9 });
    const googl = listing("GOOGL", "NMS", "United States", { avgUsdVolume30d: 4.1e9 });
    const r = chooseCanonical([goog, googl], "United States", null, opts);
    expect(r.canonicalId).toBe(googl.securityId);
    expect(r.roles[goog.securityId]).toBe("share_class");
    expect(r.roles[googl.securityId]).toBe("canonical");
    expect(r.flags).toEqual([]);
  });

  it("Berkshire: BRK-B (liquid) beats BRK-A", () => {
    const a = listing("BRK-A", "NYQ", "United States", { avgUsdVolume30d: 8e7 });
    const b = listing("BRK-B", "NYQ", "United States", { avgUsdVolume30d: 2.5e9 });
    expect(chooseCanonical([a, b], "United States", null, opts).canonicalId).toBe(b.securityId);
  });

  it("equal volume breaks ties by ascending symbol", () => {
    const x = listing("BBB", "NYQ", "United States", { avgUsdVolume30d: 1e9 });
    const y = listing("AAA", "NYQ", "United States", { avgUsdVolume30d: 1e9 });
    expect(chooseCanonical([x, y], "United States", null, opts).canonicalId).toBe(y.securityId);
  });

  it("TSMC: the Taiwan home line is canonical although the ADR trades more; the ADR is never canonical", () => {
    const tw = listing("2330.TW", "TAI", "Taiwan", { avgUsdVolume30d: 1.0e9 });
    const adr = listing("TSM", "NYQ", "United States", { avgUsdVolume30d: 2.0e9 });
    const r = chooseCanonical([adr, tw], "Taiwan", null, opts);
    expect(r.canonicalId).toBe(tw.securityId);
    expect(r.roles[adr.securityId]).toBe("adr");
  });

  it("Shell: SHEL.L (home UK) is canonical and the NYSE line is an adr", () => {
    const l = listing("SHEL.L", "LSE", "United Kingdom", { avgUsdVolume30d: 4e8 });
    const ny = listing("SHEL", "NYQ", "United States", { avgUsdVolume30d: 6e8 });
    const r = chooseCanonical([l, ny], "United Kingdom", null, opts);
    expect(r.canonicalId).toBe(l.securityId);
    expect(r.roles[ny.securityId]).toBe("adr");
  });

  it("MSFT vs German lines: Xetra cross-line is a foreign_listing, the Frankfurt line a secondary_venue, OTC is excluded", () => {
    const msft = listing("MSFT", "NMS", "United States", { avgUsdVolume30d: 1.4e10 });
    const msfde = listing("MSF.DE", "GER", "Germany", { avgUsdVolume30d: 3e7 });
    const msff = listing("MSF.F", "FRA", "Germany", { venueClass: "secondary_only", avgUsdVolume30d: 1e6 });
    const otc = listing("MSFTF", "PNK", "United States", { venueClass: "otc" });
    const r = chooseCanonical([msft, msfde, msff, otc], "United States", null, opts);
    expect(r.canonicalId).toBe(msft.securityId);
    expect(r.roles[msfde.securityId]).toBe("foreign_listing");
    expect(r.roles[msff.securityId]).toBe("secondary_venue");
    expect(r.roles[otc.securityId]).toBe("excluded");
  });

  it("without a known home country the primary-capable listings compete on volume", () => {
    const us = listing("ABC", "NYQ", "United States", { avgUsdVolume30d: 5e8 });
    const de = listing("ABC.DE", "GER", "Germany", { avgUsdVolume30d: 1e8 });
    const r = chooseCanonical([us, de], null, null, opts);
    expect(r.canonicalId).toBe(us.securityId);
    expect(r.roles[de.securityId]).toBe("share_class");
  });

  it("a company whose listings are all on secondary venues has no primary listing", () => {
    const f = listing("XYZ.F", "FRA", "Germany", { venueClass: "secondary_only" });
    const r = chooseCanonical([f], "Germany", null, opts);
    expect(r.canonicalId).toBeNull();
    expect(r.flags).toEqual(["no_primary_listing"]);
    expect(r.roles[f.securityId]).toBe("secondary_venue");
  });

  it("missing volume ranks last; all missing keeps the current canonical and flags canonical_unverified", () => {
    const a = listing("AAA", "NYQ", "United States", { avgUsdVolume30d: null });
    const b = listing("BBB", "NYQ", "United States", { avgUsdVolume30d: 1e6 });
    expect(chooseCanonical([a, b], "United States", null, opts).canonicalId).toBe(b.securityId);

    const c = listing("CCC", "NYQ", "United States");
    const d = listing("DDD", "NYQ", "United States");
    const kept = chooseCanonical([c, d], "United States", { securityId: d.securityId }, opts);
    expect(kept.canonicalId).toBe(d.securityId);
    expect(kept.flags).toEqual(["canonical_unverified"]);
    const fresh = chooseCanonical([c, d], "United States", null, opts);
    expect(fresh.canonicalId).toBe(c.securityId);
    expect(fresh.flags).toEqual(["canonical_unverified"]);
  });

  describe("hysteresis (1.5x)", () => {
    const old = listing("OLD", "NYQ", "United States", { avgUsdVolume30d: 1.0e9 });
    const mk = (volume: number) => listing("NEW", "NYQ", "United States", { avgUsdVolume30d: volume });

    it("keeps the current canonical when the challenger has only 1.2x the volume", () => {
      const challenger = mk(1.2e9);
      const r = chooseCanonical([old, challenger], "United States", { securityId: old.securityId }, opts);
      expect(r.canonicalId).toBe(old.securityId);
      expect(r.flags).toEqual(["canonical_switch_blocked"]);
      expect(r.roles[challenger.securityId]).toBe("share_class");
    });
    it("switches at exactly 1.5x", () => {
      const challenger = mk(1.5e9);
      const r = chooseCanonical([old, challenger], "United States", { securityId: old.securityId }, opts);
      expect(r.canonicalId).toBe(challenger.securityId);
      expect(r.flags).toEqual(["canonical_switched"]);
    });
    it("blocks a switch to a challenger that fails the history tests (a new share class never resets the history)", () => {
      const challenger = mk(5e9);
      const r = chooseCanonical([old, challenger], "United States", { securityId: old.securityId }, {
        switchRatio: 1.5,
        isHistoryEligible: (l) => l.securityId !== challenger.securityId,
      });
      expect(r.canonicalId).toBe(old.securityId);
      expect(r.flags).toEqual(["canonical_switch_blocked"]);
    });
    it("a current canonical that is no longer a candidate is replaced without hysteresis", () => {
      const challenger = mk(1e8);
      const r = chooseCanonical([challenger], "United States", { securityId: "gone" }, opts);
      expect(r.canonicalId).toBe(challenger.securityId);
    });
  });
});

describe("applyForceCanonical", () => {
  it("a force_canonical override beats volume and hysteresis", () => {
    const a = listing("AAA", "NYQ", "United States", { avgUsdVolume30d: 9e9 });
    const b = listing("BBB", "NYQ", "United States", { avgUsdVolume30d: 1e9 });
    const base = chooseCanonical([a, b], "United States", null, { switchRatio: 1.5 });
    expect(base.canonicalId).toBe(a.securityId);
    const forced = applyForceCanonical([a, b], base, [{ kind: "force_canonical", yahooSymbol: "BBB" }]);
    expect(forced.canonicalId).toBe(b.securityId);
    expect(forced.roles[a.securityId]).toBe("share_class");
    expect(forced.roles[b.securityId]).toBe("canonical");
    expect(forced.flags).toContain("canonical_forced");
  });
  it("is a no-op without a matching override", () => {
    const a = listing("AAA", "NYQ", "United States", { avgUsdVolume30d: 9e9 });
    const base = chooseCanonical([a], "United States", null, { switchRatio: 1.5 });
    expect(applyForceCanonical([a], base, [{ kind: "force_canonical", yahooSymbol: "ZZZ" }])).toBe(base);
  });
});
```

- [ ] **Step 2: Run it: `bun run test:core -- supabase/functions/_shared/core/identity.test.ts`; Expected: FAIL (Failed to resolve import ./identity.ts)**

- [ ] **Step 3: Implement**

**`supabase/functions/_shared/core/identity.ts`**

```ts
import { isUsExchange } from "./ranking.ts";

export interface ListingFact {
  securityId: string;
  symbol: string;
  exchange: string;
  venueClass: "primary" | "secondary_only" | "otc";
  exchangeCountry: string;
  longName: string | null;
  marketCapUsd: number | null;
  sharesOutstanding: number | null;
  avgUsdVolume30d: number | null;
  firstTradeDay: number | null;
}

export type ListingRole = "canonical" | "share_class" | "adr" | "foreign_listing" | "secondary_venue" | "excluded";

export type OverrideKind = "force_canonical" | "exclude" | "force_us" | "force_not_us" | "merge_into_company" | "predecessor_continuity";

/** An active row of security_identity_overrides. `targetYahooSymbol` is the canonical symbol of target_company_id (merge_into_company). */
export interface Override {
  kind: OverrideKind;
  yahooSymbol: string;
  targetYahooSymbol?: string | null;
}

/** Two listings whose USD caps are within this relative gap are the same company (secondary lines carry the company's cap). */
export const CAP_MATCH_TOLERANCE = 0.15;
/** Gaps between the match tolerance and this value go to manual review. */
export const CAP_REVIEW_TOLERANCE = 0.4;
/** A canonical switch needs at least this volume ratio (A-06). */
export const DEFAULT_SWITCH_RATIO = 1.5;

const LEGAL_FORMS: ReadonlySet<string> = new Set([
  "inc", "incorporated", "corp", "corporation", "co", "company", "ltd", "limited", "plc", "ag", "se", "sa", "nv", "bv", "spa", "ab", "asa", "oyj", "kk",
]);

/**
 * NFKD, strip diacritics, lower-case, "&" -> "and", drop punctuation, then drop a conservative trailing legal-form list.
 * Words such as "group" and "holding" are kept so distinct companies never merge.
 */
export function normalizeName(name: string): string {
  const base = name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[.'’]/g, "") // "S.A." -> "SA", "N.V." -> "NV", "Moody's" -> "Moodys"
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
  const tokens = base.length === 0 ? [] : base.split(" ");
  while (tokens.length > 1 && LEGAL_FORMS.has(tokens[tokens.length - 1] as string)) tokens.pop();
  return tokens.join(" ");
}

function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Relative gap of two caps in [0, 1]; null when either is unknown. */
function capGap(a: number | null, b: number | null): number | null {
  if (a === null || b === null || !(a > 0) || !(b > 0)) return null;
  return Math.abs(a - b) / Math.max(a, b);
}

class UnionFind {
  private readonly parent = new Map<string, string>();
  find(x: string): string {
    let p = this.parent.get(x) ?? x;
    if (p !== x) {
      p = this.find(p);
      this.parent.set(x, p);
    }
    return p;
  }
  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return;
    const [low, high] = compareCodeUnits(ra, rb) <= 0 ? [ra, rb] : [rb, ra];
    this.parent.set(high, low);
  }
}

/**
 * Groups listings into companies.
 *   same normalised name AND caps unknown or within 15%       -> same company
 *   same normalised name AND caps 15-40% apart                -> needsReview ("cap_mismatch")
 *   equal sharesOutstanding only AND caps within 15%          -> needsReview ("shares_only")
 *   anything else                                             -> unrelated (including a name match with caps > 40% apart)
 * Overrides: `exclude` removes a listing from every group; `merge_into_company` unions a listing with its target.
 * Output is deterministic: members sorted by symbol, groups by their first symbol, review pairs by security id.
 */
export function groupListings(
  listings: ListingFact[],
  overrides: Override[],
): { groups: ListingFact[][]; needsReview: { a: string; b: string; why: string }[] } {
  const excluded = new Set(overrides.filter((o) => o.kind === "exclude").map((o) => o.yahooSymbol));
  const pool = listings.filter((l) => !excluded.has(l.symbol)).sort((x, y) => compareCodeUnits(x.symbol, y.symbol));
  const names = new Map<string, string>(pool.map((l) => [l.securityId, l.longName === null ? "" : normalizeName(l.longName)]));
  const uf = new UnionFind();
  const review = new Map<string, { a: string; b: string; why: string }>();

  for (let i = 0; i < pool.length; i++) {
    for (let j = i + 1; j < pool.length; j++) {
      const x = pool[i] as ListingFact;
      const y = pool[j] as ListingFact;
      const nx = names.get(x.securityId) as string;
      const ny = names.get(y.securityId) as string;
      const nameEq = nx !== "" && nx === ny;
      const sharesEq = x.sharesOutstanding !== null && x.sharesOutstanding === y.sharesOutstanding;
      const gap = capGap(x.marketCapUsd, y.marketCapUsd);
      const [a, b] = compareCodeUnits(x.securityId, y.securityId) <= 0 ? [x.securityId, y.securityId] : [y.securityId, x.securityId];
      if (nameEq) {
        if (gap === null || gap <= CAP_MATCH_TOLERANCE) uf.union(x.securityId, y.securityId);
        else if (gap <= CAP_REVIEW_TOLERANCE) review.set(`${a}|${b}`, { a, b, why: "cap_mismatch" });
      } else if (sharesEq && gap !== null && gap <= CAP_MATCH_TOLERANCE) {
        review.set(`${a}|${b}`, { a, b, why: "shares_only" });
      }
    }
  }

  const bySymbol = new Map(pool.map((l) => [l.symbol, l]));
  for (const o of overrides) {
    if (o.kind !== "merge_into_company" || o.targetYahooSymbol === undefined || o.targetYahooSymbol === null) continue;
    const from = bySymbol.get(o.yahooSymbol);
    const to = bySymbol.get(o.targetYahooSymbol);
    if (from !== undefined && to !== undefined) {
      uf.union(from.securityId, to.securityId);
      review.delete(`${[from.securityId, to.securityId].sort(compareCodeUnits).join("|")}`);
    }
  }

  const buckets = new Map<string, ListingFact[]>();
  for (const l of pool) {
    const root = uf.find(l.securityId);
    const list = buckets.get(root);
    if (list === undefined) buckets.set(root, [l]);
    else list.push(l);
  }
  const groups = [...buckets.values()].sort((g1, g2) => compareCodeUnits((g1[0] as ListingFact).symbol, (g2[0] as ListingFact).symbol));
  const needsReview = [...review.values()].sort((p, q) => compareCodeUnits(p.a, q.a) || compareCodeUnits(p.b, q.b));
  return { groups, needsReview };
}

export interface CanonicalOptions {
  /** Volume ratio a challenger needs to replace the current canonical (default 1.5). */
  switchRatio: number;
  /** True when the listing passes the 10-year and 2,500-bar tests. Defaults to "always passes". */
  isHistoryEligible?: (l: ListingFact) => boolean;
}

/**
 * Canonical listing of one company (5.6).
 * 1. non-primary venues are secondary_venue (OTC: excluded); a listing on the home country's exchange is "home", others foreign-capable.
 * 2. candidates = home listings, else foreign-capable ones, else the company has no primary listing.
 * 3. highest avgUsdVolume30d wins, ties ascending symbol, missing volume last; all missing keeps `current` or the first symbol (flag canonical_unverified).
 * 4. hysteresis: a switch away from `current` needs switchRatio x its volume and a history-eligible challenger.
 * 5. an ADR is never canonical while a home listing exists.
 */
export function chooseCanonical(
  group: ListingFact[],
  homeCountry: string | null,
  current: { securityId: string } | null,
  opts: CanonicalOptions,
): { canonicalId: string | null; roles: Record<string, ListingRole>; flags: string[] } {
  const roles: Record<string, ListingRole> = {};
  const flags: string[] = [];
  const home: ListingFact[] = [];
  const foreign: ListingFact[] = [];
  for (const l of group) {
    if (l.venueClass === "otc") roles[l.securityId] = "excluded";
    else if (l.venueClass !== "primary") roles[l.securityId] = "secondary_venue";
    else if (homeCountry !== null && l.exchangeCountry === homeCountry) home.push(l);
    else foreign.push(l);
  }
  const candidates = home.length > 0 ? home : foreign;
  if (candidates.length === 0) {
    flags.push("no_primary_listing");
    return { canonicalId: null, roles, flags };
  }

  const volume = (l: ListingFact): number | null => (l.avgUsdVolume30d !== null && Number.isFinite(l.avgUsdVolume30d) ? l.avgUsdVolume30d : null);
  const ranked = [...candidates].sort((a, b) => {
    const va = volume(a);
    const vb = volume(b);
    if (va !== null && vb !== null && va !== vb) return vb - va;
    if (va !== null && vb === null) return -1;
    if (va === null && vb !== null) return 1;
    return compareCodeUnits(a.symbol, b.symbol);
  });
  const allMissing = candidates.every((c) => volume(c) === null);
  const currentListing = current === null ? undefined : candidates.find((c) => c.securityId === current.securityId);
  let chosen = ranked[0] as ListingFact;

  if (allMissing) {
    flags.push("canonical_unverified");
    if (currentListing !== undefined) chosen = currentListing;
  } else if (currentListing !== undefined && chosen.securityId !== currentListing.securityId) {
    const challenger = volume(chosen) ?? 0;
    const incumbent = volume(currentListing) ?? 0;
    const eligible = opts.isHistoryEligible === undefined ? true : opts.isHistoryEligible(chosen);
    if (challenger >= opts.switchRatio * incumbent && eligible) {
      flags.push("canonical_switched");
    } else {
      flags.push("canonical_switch_blocked");
      chosen = currentListing;
    }
  }

  for (const l of candidates) roles[l.securityId] = l.securityId === chosen.securityId ? "canonical" : "share_class";
  if (home.length > 0) {
    for (const l of foreign) roles[l.securityId] = isUsExchange(l.exchange) ? "adr" : "foreign_listing";
  }
  return { canonicalId: chosen.securityId, roles, flags };
}

/** Applies a `force_canonical` override (by yahoo symbol) after the algorithm; it wins over volume and hysteresis. */
export function applyForceCanonical(
  group: ListingFact[],
  result: { canonicalId: string | null; roles: Record<string, ListingRole>; flags: string[] },
  overrides: Override[],
): { canonicalId: string | null; roles: Record<string, ListingRole>; flags: string[] } {
  const forced = overrides.find((o) => o.kind === "force_canonical" && group.some((l) => l.symbol === o.yahooSymbol));
  if (forced === undefined) return result;
  const target = group.find((l) => l.symbol === forced.yahooSymbol) as ListingFact;
  const roles = { ...result.roles };
  for (const [id, role] of Object.entries(roles)) if (role === "canonical") roles[id] = "share_class";
  roles[target.securityId] = "canonical";
  return { canonicalId: target.securityId, roles, flags: [...result.flags, "canonical_forced"] };
}
```

- [ ] **Step 4: Run; Expected: PASS** `bun run test:core -- supabase/functions/_shared/core/identity.test.ts` (36 tests: Alphabet, Berkshire, TSMC, Shell, MSFT vs MSF.DE/MSF.F, look-alike exclusion by cap mismatch, hysteresis 1.5x).

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/core/identity.ts supabase/functions/_shared/core/identity.test.ts
git commit -m "feat(core): company grouping and canonical listing choice"
```

---
### Task 7: episodes.ts and classify.ts

**Parallelism:** can run concurrently with Tasks 1-6, 8 once Task 5 (`thresholds.ts` types) has landed.

**Files:**
- Create: `supabase/functions/_shared/core/episodes.ts`, `supabase/functions/_shared/core/classify.ts`
- Test: `supabase/functions/_shared/core/episodes.test.ts`, `supabase/functions/_shared/core/classify.test.ts`

**Interfaces:**
- Consumes: `thresholds.ts` (`ThresholdLine`, `UniverseMode`, `SignalKind`, `applicableDiscountLine` in the test)
- Produces: `ActiveEpisode`, `Observation`, `EpisodeAction`, `stepDiscount`, `stepPremium`; `ResearchStatus`, `Category`, `Conclusion`, `BankruptcyRisk`, `ResearchFacts`, `classifyOperational`

- [ ] **Step 1: Write the failing tests**

**`supabase/functions/_shared/core/episodes.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { stepDiscount, stepPremium, type ActiveEpisode, type EpisodeAction, type Observation } from "./episodes.ts";
import { applicableDiscountLine, type ThresholdLine } from "./thresholds.ts";

/** A minimal simulator of what rank_signals does with the actions: apply them and stamp last_evaluated_session_date. */
class Sim {
  active: ActiveEpisode | null = null;
  private seq = 0;
  log: string[] = [];
  prevLine: ThresholdLine | null = null;
  constructor(private readonly kind: ActiveEpisode["kind"] = "discount") {}

  discount(sessionDay: number, close: number, rank: number | null, lines: { "-3": number; "-4": number }, canOpen = true): EpisodeAction[] {
    const applicableLine = applicableDiscountLine(rank);
    const obs: Observation = { sessionDay, close, lineEnd: lines[applicableLine], canOpen, rank, applicableLine, prevApplicableLine: this.prevLine };
    const actions = stepDiscount(this.active, obs);
    this.apply(actions, sessionDay);
    this.prevLine = applicableLine;
    return actions;
  }

  premium(sessionDay: number, close: number, lineEnd: number | null, kind: "premium1" | "premium2", canOpen = true): EpisodeAction[] {
    const obs: Observation = { sessionDay, close, lineEnd, canOpen, rank: null, applicableLine: kind === "premium1" ? "+1" : "+2" };
    const actions = stepPremium(this.active, obs, kind);
    this.apply(actions, sessionDay);
    return actions;
  }

  private apply(actions: EpisodeAction[], sessionDay: number): void {
    for (const a of actions) {
      if (a.type === "close") {
        this.log.push(`close:${a.reason}`);
        this.active = null;
      } else if (a.type === "open") {
        this.seq++;
        this.active = { id: `E${this.seq}`, kind: this.kind, mode: "worldwide", line: a.line, openedSessionDay: sessionDay, lastEvaluatedSessionDay: sessionDay };
        this.log.push(`open:${a.line}:${a.reason}:${a.notify ? "notify" : "silent"}${a.continuesEpisodeId ? `:from ${a.continuesEpisodeId}` : ""}`);
      } else if (this.active !== null) {
        this.active = { ...this.active, lastEvaluatedSessionDay: sessionDay };
      }
    }
  }
}

describe("stepDiscount: spec 8.8 example 1 (rank 8, applicable -3): entry, persistence, reset, re-entry", () => {
  it("replays the whole table", () => {
    const sim = new Sim();
    const line = (v: number) => ({ "-3": v, "-4": v - 20 });
    // D1 Mon 105.0 vs 100.2: not met
    expect(sim.discount(1, 105.0, 8, line(100.2))).toEqual([{ type: "noop", reason: "idle" }]);
    // D2 Tue 99.5 vs 100.3: open E1, notify
    expect(sim.discount(2, 99.5, 8, line(100.3))).toEqual([{ type: "open", line: "-3", notify: true, reason: "new_entry" }]);
    // D3 Wed 98.0 vs 100.4: noop
    expect(sim.discount(3, 98.0, 8, line(100.4))).toEqual([{ type: "noop", reason: "still_below" }]);
    // D4 Fri 97.5 vs 100.4: noop
    expect(sim.discount(5, 97.5, 8, line(100.4))).toEqual([{ type: "noop", reason: "still_below" }]);
    // D5 Sat scan, session Friday reused: noop (unchanged session)
    expect(sim.discount(5, 97.5, 8, line(100.4))).toEqual([{ type: "noop", reason: "same_session" }]);
    // D6 Mon 100.9 vs 100.5: close above the line resets
    expect(sim.discount(8, 100.9, 8, line(100.5))).toEqual([{ type: "close", reason: "close_above_threshold" }]);
    // D7 Tue 100.5 vs 100.6: a new episode E2
    expect(sim.discount(9, 100.5, 8, line(100.6))).toEqual([{ type: "open", line: "-3", notify: true, reason: "new_entry" }]);
    expect(sim.active?.id).toBe("E2");
  });

  it("a close exactly on the line still qualifies (no epsilon), a close equal to the line does not reset", () => {
    const sim = new Sim();
    expect(sim.discount(1, 100, 8, { "-3": 100, "-4": 80 })[0]?.type).toBe("open");
    expect(sim.discount(2, 100, 8, { "-3": 100, "-4": 80 })).toEqual([{ type: "noop", reason: "still_below" }]);
  });
});

describe("stepDiscount: spec 8.8 example 2 (rank crosses 10/11 while discounted)", () => {
  it("replays S1..S4 with -3 = 100 and -4 = 90", () => {
    const sim = new Sim();
    const lines = { "-3": 100, "-4": 90 };
    expect(sim.discount(1, 95, 10, lines)).toEqual([{ type: "open", line: "-3", notify: true, reason: "new_entry" }]);
    // S2 rank 11 -> -4; 95 > 90: close E1 (threshold_changed), nothing opens
    expect(sim.discount(2, 95, 11, lines)).toEqual([{ type: "close", reason: "threshold_changed" }]);
    expect(sim.active).toBeNull();
    // S3 rank 11, close 88 <= 90: open E2 at -4 (idle, previous applicable already -4)
    expect(sim.discount(3, 88, 11, lines)).toEqual([{ type: "open", line: "-4", notify: true, reason: "new_entry" }]);
    // S4 rank 10 -> -3, 88 <= 100: close E2 and open E3 as a silent continuation of E2
    expect(sim.discount(4, 88, 10, lines)).toEqual([
      { type: "close", reason: "threshold_changed" },
      { type: "open", line: "-3", notify: false, reason: "continuation", continuesEpisodeId: "E2" },
    ]);
    expect(sim.active?.id).toBe("E3");
  });
});

describe("stepDiscount: spec 8.8 example 3 and the 8.4 table (rank improves)", () => {
  it("rank 12 -> 9 opens with rank_change_new_threshold and notifies", () => {
    const sim = new Sim();
    const lines = { "-3": 100, "-4": 90 };
    expect(sim.discount(1, 95, 12, lines)).toEqual([{ type: "noop", reason: "idle" }]);
    expect(sim.discount(2, 95, 9, lines)).toEqual([{ type: "open", line: "-3", notify: true, reason: "rank_change_new_threshold" }]);
  });

  it("Active -3, rank 11, condition still met under -4: close + silent continuation", () => {
    const sim = new Sim();
    const lines = { "-3": 100, "-4": 90 };
    sim.discount(1, 85, 10, lines); // opens -3
    const actions = sim.discount(2, 85, 11, lines); // 85 <= 90
    expect(actions.map((a) => a.type)).toEqual(["close", "open"]);
    expect(actions[1]).toMatchObject({ type: "open", line: "-4", notify: false, reason: "continuation" });
  });

  it("Active -4, rank 10: the -3 line is always above the -4 line, so the continuation always opens", () => {
    const sim = new Sim();
    const lines = { "-3": 100, "-4": 90 };
    sim.discount(1, 85, 11, lines); // opens -4
    const actions = sim.discount(2, 95, 10, lines); // 95 <= 100 under -3
    expect(actions.map((a) => a.type)).toEqual(["close", "open"]);
    expect(actions[1]).toMatchObject({ line: "-3", notify: false });
  });

  it("Idle, rank 10 -> 11 (-3 -> -4), condition not met: nothing", () => {
    const sim = new Sim();
    const lines = { "-3": 100, "-4": 90 };
    sim.discount(1, 105, 10, lines);
    expect(sim.discount(2, 95, 11, lines)).toEqual([{ type: "noop", reason: "idle" }]);
  });

  it("does not label an ordinary entry as a rank change when the applicable line did not change", () => {
    const sim = new Sim();
    sim.discount(1, 105, 12, { "-3": 100, "-4": 90 });
    expect(sim.discount(2, 85, 12, { "-3": 100, "-4": 90 })).toEqual([{ type: "open", line: "-4", notify: true, reason: "new_entry" }]);
  });
});

describe("stepDiscount: canOpen false path (can close, cannot open) and not-evaluable days", () => {
  it("meeting the condition but failing Tier 2 does not open", () => {
    const sim = new Sim();
    expect(sim.discount(1, 3.0, 40, { "-3": 5, "-4": -1.7 }, false)).toEqual([{ type: "noop", reason: "idle" }]);
  });

  it("example 5: rank 40, lower2 end -1.70, close 3.0: no discount and cannot open", () => {
    const sim = new Sim();
    expect(sim.discount(1, 3.0, 40, { "-3": 0.5, "-4": -1.7 }, false)).toEqual([{ type: "noop", reason: "idle" }]);
  });

  it("an active episode still closes when the close rises above the line even if canOpen is now false", () => {
    const sim = new Sim();
    sim.discount(1, 95, 8, { "-3": 100, "-4": 80 });
    expect(sim.discount(2, 101, 8, { "-3": 100, "-4": 80 }, false)).toEqual([{ type: "close", reason: "close_above_threshold" }]);
  });

  it("a threshold change with canOpen false only closes", () => {
    const sim = new Sim();
    sim.discount(1, 85, 10, { "-3": 100, "-4": 90 });
    expect(sim.discount(2, 85, 11, { "-3": 100, "-4": 90 }, false)).toEqual([{ type: "close", reason: "threshold_changed" }]);
  });

  it("example 7: a failed data day (lineEnd null) neither opens nor closes", () => {
    const sim = new Sim();
    sim.discount(1, 95, 8, { "-3": 100, "-4": 80 });
    const obs: Observation = { sessionDay: 2, close: 150, lineEnd: null, canOpen: false, rank: 8, applicableLine: "-3" };
    expect(stepDiscount(sim.active, obs)).toEqual([{ type: "noop", reason: "not_evaluable" }]);
    expect(stepDiscount(null, { ...obs, close: 1 })).toEqual([{ type: "noop", reason: "not_evaluable" }]);
  });

  it("a non-finite close is not evaluable", () => {
    const obs: Observation = { sessionDay: 2, close: Number.NaN, lineEnd: 100, canOpen: true, rank: 8, applicableLine: "-3" };
    expect(stepDiscount(null, obs)).toEqual([{ type: "noop", reason: "not_evaluable" }]);
  });
});

describe("stepDiscount: idempotent replays", () => {
  it("running the same scan twice yields no further actions at every step of example 1", () => {
    const sim = new Sim();
    const lines = (v: number) => ({ "-3": v, "-4": v - 20 });
    const steps: Array<[number, number, number]> = [[1, 105, 100.2], [2, 99.5, 100.3], [3, 98, 100.4], [4, 100.9, 100.5], [5, 100.5, 100.6]];
    for (const [d, c, l] of steps) {
      sim.discount(d, c, 8, lines(l));
      const again = sim.discount(d, c, 8, lines(l));
      expect(again.every((a) => a.type === "noop")).toBe(true);
    }
  });

  it("a closed episode is not reopened by a replay of the closing session", () => {
    const sim = new Sim();
    sim.discount(1, 95, 8, { "-3": 100, "-4": 80 });
    sim.discount(2, 101, 8, { "-3": 100, "-4": 80 }); // closes
    expect(sim.discount(2, 101, 8, { "-3": 100, "-4": 80 })).toEqual([{ type: "noop", reason: "idle" }]);
  });

  it("an older session than the last evaluation is a no-op (data never regresses an episode)", () => {
    const sim = new Sim();
    sim.discount(5, 95, 8, { "-3": 100, "-4": 80 });
    expect(sim.discount(4, 120, 8, { "-3": 100, "-4": 80 })).toEqual([{ type: "noop", reason: "same_session" }]);
    expect(sim.active).not.toBeNull();
  });
});

describe("stepPremium: spec 8.8 example 4 (+1 = 120, +2 = 140)", () => {
  it("replays P1..P7 with independent premium1 and premium2 episodes", () => {
    const p1 = new Sim("premium1");
    const p2 = new Sim("premium2");
    const run = (day: number, close: number) => ({
      a1: p1.premium(day, close, 120, "premium1"),
      a2: p2.premium(day, close, 140, "premium2"),
    });
    expect(run(1, 119)).toEqual({ a1: [{ type: "noop", reason: "idle" }], a2: [{ type: "noop", reason: "idle" }] });
    expect(run(2, 121)).toEqual({ a1: [{ type: "open", line: "+1", notify: true, reason: "new_entry" }], a2: [{ type: "noop", reason: "idle" }] });
    expect(run(3, 125)).toEqual({ a1: [{ type: "noop", reason: "still_above" }], a2: [{ type: "noop", reason: "idle" }] });
    expect(run(4, 141)).toEqual({ a1: [{ type: "noop", reason: "still_above" }], a2: [{ type: "open", line: "+2", notify: true, reason: "new_entry" }] });
    // P5 130: premium2 closes, premium1 stays active
    expect(run(5, 130)).toEqual({ a1: [{ type: "noop", reason: "still_above" }], a2: [{ type: "close", reason: "close_below_upper_line" }] });
    // P6 118: premium1 closes
    expect(run(6, 118)).toEqual({ a1: [{ type: "close", reason: "close_below_upper_line" }], a2: [{ type: "noop", reason: "idle" }] });
    // P7 121: a new premium1 episode
    expect(run(7, 121).a1).toEqual([{ type: "open", line: "+1", notify: true, reason: "new_entry" }]);
  });

  it("equality qualifies for opening and a close equal to the line does not reset", () => {
    const sim = new Sim("premium1");
    expect(sim.premium(1, 120, 120, "premium1")[0]?.type).toBe("open");
    expect(sim.premium(2, 120, 120, "premium1")).toEqual([{ type: "noop", reason: "still_above" }]);
  });

  it("canOpen false never opens; a not-evaluable day changes nothing; the same session is a no-op", () => {
    const sim = new Sim("premium1");
    expect(sim.premium(1, 130, 120, "premium1", false)).toEqual([{ type: "noop", reason: "idle" }]);
    sim.premium(2, 130, 120, "premium1");
    expect(sim.premium(3, 100, null, "premium1")).toEqual([{ type: "noop", reason: "not_evaluable" }]);
    expect(sim.premium(2, 100, 120, "premium1")).toEqual([{ type: "noop", reason: "same_session" }]);
    expect(sim.active).not.toBeNull();
  });
});
```

**`supabase/functions/_shared/core/classify.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { classifyOperational, type ResearchFacts } from "./classify.ts";

const MEETS = "Meets these two fundamental checks." as const;
const FAILS = "Does not meet one or both checks." as const;
const INSUFFICIENT = "Insufficient evidence to decide." as const;

const complete = (patch: Partial<ResearchFacts>): ResearchFacts => ({
  status: "complete",
  conclusion: MEETS,
  bankruptcyRisk: "Low",
  materialDamageEstablished: false,
  sufficientEvidence: true,
  ...patch,
});

describe("classifyOperational: one test per row of the 4.8 table", () => {
  it("row 1: no report -> pending research_pending", () => {
    expect(classifyOperational(null)).toEqual({ category: "pending", reasonCode: "research_pending" });
  });
  it.each(["queued", "running", "stale"] as const)("row 1: status %s -> pending research_pending", (status) => {
    expect(classifyOperational({ status, conclusion: null, bankruptcyRisk: null, materialDamageEstablished: null, sufficientEvidence: null })).toEqual({
      category: "pending",
      reasonCode: "research_pending",
    });
  });
  it("row 1: quota_deferred -> pending research_quota_deferred", () => {
    expect(classifyOperational({ status: "quota_deferred", conclusion: null, bankruptcyRisk: null, materialDamageEstablished: null, sufficientEvidence: null })).toEqual({
      category: "pending",
      reasonCode: "research_quota_deferred",
    });
  });
  it("row 2: failed -> grey research_failed", () => {
    expect(classifyOperational({ status: "failed", conclusion: null, bankruptcyRisk: null, materialDamageEstablished: null, sufficientEvidence: null })).toEqual({
      category: "grey",
      reasonCode: "research_failed",
    });
  });
  it("row 3: High bankruptcy risk -> red bankruptcy_high, even when the conclusion says Meets", () => {
    expect(classifyOperational(complete({ bankruptcyRisk: "High" }))).toEqual({ category: "red", reasonCode: "bankruptcy_high" });
  });
  it("row 4: material damage established -> red material_damage", () => {
    expect(classifyOperational(complete({ materialDamageEstablished: true }))).toEqual({ category: "red", reasonCode: "material_damage" });
  });
  it("row 5: Unclear risk, insufficient evidence flag or insufficient conclusion -> grey inconclusive", () => {
    expect(classifyOperational(complete({ bankruptcyRisk: "Unclear" }))).toEqual({ category: "grey", reasonCode: "inconclusive" });
    expect(classifyOperational(complete({ sufficientEvidence: false }))).toEqual({ category: "grey", reasonCode: "inconclusive" });
    expect(classifyOperational(complete({ conclusion: INSUFFICIENT }))).toEqual({ category: "grey", reasonCode: "inconclusive" });
  });
  it("row 6: conclusion Does not meet -> red does_not_meet", () => {
    expect(classifyOperational(complete({ conclusion: FAILS }))).toEqual({ category: "red", reasonCode: "does_not_meet" });
  });
  it("row 7: Moderate risk with clean checks -> amber moderate_risk", () => {
    expect(classifyOperational(complete({ bankruptcyRisk: "Moderate" }))).toEqual({ category: "amber", reasonCode: "moderate_risk" });
  });
  it("row 8: Low risk with clean checks -> green meets_checks", () => {
    expect(classifyOperational(complete({}))).toEqual({ category: "green", reasonCode: "meets_checks" });
  });
  it("row 9: null flags in a complete row -> grey unmapped", () => {
    expect(classifyOperational(complete({ bankruptcyRisk: null }))).toEqual({ category: "grey", reasonCode: "unmapped" });
    expect(classifyOperational(complete({ materialDamageEstablished: null }))).toEqual({ category: "grey", reasonCode: "unmapped" });
    expect(classifyOperational(complete({ sufficientEvidence: null }))).toEqual({ category: "grey", reasonCode: "unmapped" });
    expect(classifyOperational(complete({ conclusion: null }))).toEqual({ category: "grey", reasonCode: "unmapped" });
  });
});

describe("classifyOperational: ordering and properties", () => {
  it("first matching row wins: High risk beats insufficient evidence (3 before 5), damage beats Does not meet (4 before 6)", () => {
    expect(classifyOperational(complete({ bankruptcyRisk: "High", sufficientEvidence: false })).reasonCode).toBe("bankruptcy_high");
    expect(classifyOperational(complete({ materialDamageEstablished: true, conclusion: FAILS })).reasonCode).toBe("material_damage");
  });
  it("Amber is never Green: Moderate never maps to green", () => {
    expect(classifyOperational(complete({ bankruptcyRisk: "Moderate" })).category).not.toBe("green");
  });
  it("a Moderate risk with a Does not meet conclusion is red, never amber", () => {
    expect(classifyOperational(complete({ bankruptcyRisk: "Moderate", conclusion: FAILS })).category).toBe("red");
  });
  it("the wording of the conclusion alone never makes a candidate green", () => {
    expect(classifyOperational(complete({ bankruptcyRisk: "Unclear" })).category).toBe("grey");
    expect(classifyOperational(complete({ materialDamageEstablished: null })).category).toBe("grey");
  });
  it("only green and amber can be cleared; pending, grey and red are withheld", () => {
    const cleared = new Set(["green", "amber"]);
    expect(cleared.has(classifyOperational(null).category)).toBe(false);
    expect(cleared.has(classifyOperational(complete({})).category)).toBe(true);
  });
});
```

- [ ] **Step 2: Run it: `bun run test:core -- supabase/functions/_shared/core/episodes.test.ts supabase/functions/_shared/core/classify.test.ts`; Expected: FAIL (Failed to resolve imports ./episodes.ts, ./classify.ts)**

- [ ] **Step 3: Implement (1/2)**

**`supabase/functions/_shared/core/episodes.ts`**

```ts
import type { SignalKind, ThresholdLine, UniverseMode } from "./thresholds.ts";

export interface ActiveEpisode {
  id: string;
  kind: SignalKind;
  mode: UniverseMode;
  line: ThresholdLine;
  openedSessionDay: number;
  lastEvaluatedSessionDay: number;
}

export interface Observation {
  sessionDay: number;
  close: number;
  /** lineEnd null => the channel is not computable or the data is not evaluable (stale, suspect): the step is a no-op. */
  lineEnd: number | null;
  /** Tier 1 member (not carried forward) AND Tier 2 valid AND fresh AND not suspect. */
  canOpen: boolean;
  rank: number | null;
  applicableLine: ThresholdLine; // discount only
  /** Applicable line of the previous list-published snapshot; lets a rank change that opens an episode be labelled. */
  prevApplicableLine?: ThresholdLine | null;
}

export type EpisodeAction =
  | { type: "noop"; reason: string }
  | {
      type: "open";
      line: ThresholdLine;
      notify: boolean;
      reason: "new_entry" | "rank_change_new_threshold" | "continuation";
      continuesEpisodeId?: string;
    }
  | { type: "close"; reason: "close_above_threshold" | "threshold_changed" | "close_below_upper_line" };

/**
 * Discount state machine for one security in one mode (8.2, 8.3). Pure over (active episode, observation).
 *  - not evaluable (lineEnd null or a non-finite close): neither opens nor closes.
 *  - same session and same applicable line as the last evaluation: no-op (re-runs and weekend replays).
 *  - a rank change crossing 10/11 changes the applicable line: close the old episode, open a silent continuation if still below.
 */
export function stepDiscount(active: ActiveEpisode | null, obs: Observation): EpisodeAction[] {
  if (obs.lineEnd === null || !Number.isFinite(obs.close)) return [{ type: "noop", reason: "not_evaluable" }];
  if (active !== null && obs.sessionDay <= active.lastEvaluatedSessionDay && obs.applicableLine === active.line) {
    return [{ type: "noop", reason: "same_session" }];
  }
  const inDiscount = obs.close <= obs.lineEnd;

  if (active === null) {
    if (inDiscount && obs.canOpen) {
      const prev = obs.prevApplicableLine ?? null;
      const reason = prev !== null && prev !== obs.applicableLine ? "rank_change_new_threshold" : "new_entry";
      return [{ type: "open", line: obs.applicableLine, notify: true, reason }];
    }
    return [{ type: "noop", reason: "idle" }];
  }

  if (active.line === obs.applicableLine) {
    return inDiscount ? [{ type: "noop", reason: "still_below" }] : [{ type: "close", reason: "close_above_threshold" }];
  }

  // the applicable line changed because the rank crossed 10/11
  if (inDiscount && obs.canOpen) {
    return [
      { type: "close", reason: "threshold_changed" },
      { type: "open", line: obs.applicableLine, notify: false, reason: "continuation", continuesEpisodeId: active.id },
    ];
  }
  return [{ type: "close", reason: "threshold_changed" }];
}

/** Premium state machine (+1 uses end.upper1, +2 uses end.upper2: the caller passes the matching lineEnd). */
export function stepPremium(active: ActiveEpisode | null, obs: Observation, kind: "premium1" | "premium2"): EpisodeAction[] {
  if (obs.lineEnd === null || !Number.isFinite(obs.close)) return [{ type: "noop", reason: "not_evaluable" }];
  if (active !== null && obs.sessionDay <= active.lastEvaluatedSessionDay) return [{ type: "noop", reason: "same_session" }];
  const line: ThresholdLine = kind === "premium1" ? "+1" : "+2";
  const above = obs.close >= obs.lineEnd;
  if (active === null) {
    return above && obs.canOpen ? [{ type: "open", line, notify: true, reason: "new_entry" }] : [{ type: "noop", reason: "idle" }];
  }
  return above ? [{ type: "noop", reason: "still_above" }] : [{ type: "close", reason: "close_below_upper_line" }];
}
```

- [ ] **Step 4: Implement (2/2)**

**`supabase/functions/_shared/core/classify.ts`**

```ts
export type ResearchStatus = "queued" | "running" | "complete" | "failed" | "quota_deferred" | "stale";
export type Category = "green" | "amber" | "red" | "grey" | "pending";
export type Conclusion =
  | "Meets these two fundamental checks."
  | "Does not meet one or both checks."
  | "Insufficient evidence to decide.";
export type BankruptcyRisk = "Low" | "Moderate" | "High" | "Unclear";

export interface ResearchFacts {
  status: ResearchStatus;
  conclusion: Conclusion | null;
  bankruptcyRisk: BankruptcyRisk | null;
  materialDamageEstablished: boolean | null;
  sufficientEvidence: boolean | null;
}

/**
 * Operational classification (4.8). First matching row wins; the category never derives from the wording of the conclusion alone.
 */
export function classifyOperational(r: ResearchFacts | null): { category: Category; reasonCode: string } {
  // 1. no report, or no completed result yet
  if (r === null || r.status === "queued" || r.status === "running" || r.status === "quota_deferred" || r.status === "stale") {
    return { category: "pending", reasonCode: r !== null && r.status === "quota_deferred" ? "research_quota_deferred" : "research_pending" };
  }
  // 2. terminal failure after retries
  if (r.status === "failed") return { category: "grey", reasonCode: "research_failed" };
  // from here status = complete
  if (r.bankruptcyRisk === "High") return { category: "red", reasonCode: "bankruptcy_high" }; // 3
  if (r.materialDamageEstablished === true) return { category: "red", reasonCode: "material_damage" }; // 4
  if (r.bankruptcyRisk === "Unclear" || r.sufficientEvidence === false || r.conclusion === "Insufficient evidence to decide.") {
    return { category: "grey", reasonCode: "inconclusive" }; // 5
  }
  if (r.conclusion === "Does not meet one or both checks.") return { category: "red", reasonCode: "does_not_meet" }; // 6
  const cleanChecks = r.sufficientEvidence === true && r.materialDamageEstablished === false && r.conclusion === "Meets these two fundamental checks.";
  if (r.bankruptcyRisk === "Moderate" && cleanChecks) return { category: "amber", reasonCode: "moderate_risk" }; // 7
  if (r.bankruptcyRisk === "Low" && cleanChecks) return { category: "green", reasonCode: "meets_checks" }; // 8
  return { category: "grey", reasonCode: "unmapped" }; // 9: null flags in a "complete" row, unexpected combinations
}
```

- [ ] **Step 5: Run; Expected: PASS** `bun run test:core -- supabase/functions/_shared/core/episodes.test.ts supabase/functions/_shared/core/classify.test.ts` (spec 8.8 examples 1-4, the 8.4 table, canOpen=false, not-evaluable days, idempotent replays; one test per row of the 4.8 table).

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/_shared/core/episodes.ts supabase/functions/_shared/core/episodes.test.ts supabase/functions/_shared/core/classify.ts supabase/functions/_shared/core/classify.test.ts
git commit -m "feat(core): signal episode state machine and operational classification"
```

---
### Task 8: providers.ts, clock.ts, store.ts, throttle.ts

**Parallelism:** can run concurrently with Group A (needs only `core/bars.ts` for the `RawBar` type in `providers.ts`: start after Task 4) and with Tasks 11 and 12-16.

**Files:**
- Create: `supabase/functions/_shared/adapters/providers.ts`, `supabase/functions/_shared/adapters/clock.ts`, `supabase/functions/_shared/adapters/store.ts`, `supabase/functions/_shared/adapters/throttle.ts`
- Test: `supabase/functions/_shared/adapters/throttle.test.ts`

**Interfaces:**
- Consumes: `core/bars.ts` (`RawBar`)
- Produces: spec 5.1 interfaces verbatim; `Clock`, `systemClock`, `createFakeClock`; `KvStore`, `createMemoryKv`; `createThrottle({ fetchImpl, clock, breaker, rate?, rng?, ... })` returning `{ fetch, stats() }`, `BreakerStore`, `createKvBreakerStore`, `YahooUnavailableError`, `BudgetExceededError`, `parseRetryAfter`, `DEFAULT_RATE`

- [ ] **Step 1: Write the failing test**

**`supabase/functions/_shared/adapters/throttle.test.ts`**

```ts
import { assert, assertEquals, assertRejects } from "@std/assert";
import { createFakeClock } from "./clock.ts";
import { createMemoryKv } from "./store.ts";
import {
  BudgetExceededError,
  YahooUnavailableError,
  createKvBreakerStore,
  createThrottle,
  parseRetryAfter,
  type FetchLike,
} from "./throttle.ts";

const ok = () => new Response("{}", { status: 200 });
const status = (code: number, headers: Record<string, string> = {}) => new Response("x", { status: code, headers });

function harness(responses: Array<Response | Error>, extra: Record<string, unknown> = {}) {
  const clock = createFakeClock();
  const kv = createMemoryKv(clock);
  const calls: number[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  let i = 0;
  const fetchImpl: FetchLike = async () => {
    calls.push(clock.now());
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      await Promise.resolve();
      const r = responses[Math.min(i++, responses.length - 1)];
      if (r instanceof Error) throw r;
      return (r as Response).clone();
    } finally {
      inFlight--;
    }
  };
  const throttle = createThrottle({
    fetchImpl,
    clock,
    breaker: createKvBreakerStore(kv),
    rng: () => 0.5,
    ...extra,
  });
  return { clock, kv, calls, throttle, inFlight: () => maxInFlight };
}

Deno.test("spacing: starts are at least 340 ms apart and never more than 3 per rolling second", async () => {
  const h = harness([ok()], { rng: () => 0.99 });
  for (let n = 0; n < 24; n++) await h.throttle.fetch("https://query1.finance.yahoo.com/v7/finance/quote?symbols=A");
  for (let n = 1; n < h.calls.length; n++) assert(h.calls[n]! - h.calls[n - 1]! >= 340, `gap ${h.calls[n]! - h.calls[n - 1]!}`);
  for (let n = 3; n < h.calls.length; n++) assert(h.calls[n]! - h.calls[n - 3]! > 1000, "more than 3 requests inside one second");
});

Deno.test("concurrency 1: simultaneous callers are serialised", async () => {
  const h = harness([ok()]);
  await Promise.all(Array.from({ length: 6 }, () => h.throttle.fetch("https://example.test/a")));
  assertEquals(h.calls.length, 6);
  assertEquals(h.inFlight(), 1);
});

Deno.test("429 is retried with backoff and then succeeds; Retry-After is honoured; stats never hold the query string", async () => {
  const h = harness([status(429, { "retry-after": "7" }), status(429), ok()]);
  const res = await h.throttle.fetch("https://example.test/a?crumb=SECRET");
  assertEquals(res.status, 200);
  assertEquals(h.calls.length, 3);
  assert(h.clock.sleeps.includes(7000), "Retry-After of 7 s must be used as the delay");
  const stats = h.throttle.stats();
  assertEquals(stats.status429, 2);
  assertEquals(stats.retries, 2);
  assert(!JSON.stringify(stats).includes("SECRET"));
});

Deno.test("backoff delay is min(30 s, 1 s * 2^(attempt-1)) * U(0.5, 1.5)", async () => {
  const h = harness([status(500), status(500), status(500), ok()], { rng: () => 0.5 });
  await h.throttle.fetch("https://example.test/a");
  // rng 0.5 -> factor 1.0: delays of 1 s, 2 s and 4 s (the pacing sleeps are shorter than 1 s)
  assertEquals(h.clock.sleeps.filter((s) => s >= 1000), [1000, 2000, 4000]);
});

Deno.test("a network error is retried", async () => {
  const h = harness([new TypeError("connection reset"), ok()]);
  const res = await h.throttle.fetch("https://example.test/a");
  assertEquals(res.status, 200);
  assertEquals(h.throttle.stats().networkErrors, 1);
});

Deno.test("404 and 401 are returned immediately without retry", async () => {
  for (const code of [404, 401]) {
    const h = harness([status(code)]);
    const res = await h.throttle.fetch("https://example.test/a");
    assertEquals(res.status, code);
    assertEquals(h.calls.length, 1);
  }
});

Deno.test("5xx exhausts four attempts and returns the last response", async () => {
  const h = harness([status(503)]);
  const res = await h.throttle.fetch("https://example.test/a");
  assertEquals(res.status, 503);
  assertEquals(h.calls.length, 4);
  assertEquals((await h.kv.get<{ consecutiveFailures: number }>("yahoo:breaker"))?.consecutiveFailures, 4);
});

Deno.test("breaker: the 5th consecutive failure opens it for 10 minutes; later calls fail fast without touching the network", async () => {
  const h = harness([status(429)]);
  await h.throttle.fetch("https://example.test/a"); // attempts 1-4
  const err = await assertRejects(() => h.throttle.fetch("https://example.test/a"), YahooUnavailableError); // attempt 5 opens it
  assertEquals(h.calls.length, 5);
  assertEquals(err.untilMs, h.clock.now() + 10 * 60_000);
  await assertRejects(() => h.throttle.fetch("https://example.test/a"), YahooUnavailableError);
  assertEquals(h.calls.length, 5, "no request while open");
  const stored = await h.kv.get<{ openUntilMs: number | null }>("yahoo:breaker");
  assertEquals(stored?.openUntilMs, err.untilMs);
});

Deno.test("breaker half-opens after 10 minutes: a failing trial reopens it at once", async () => {
  const h = harness([status(429)], { budgetMs: 1e12 });
  await h.throttle.fetch("https://example.test/a");
  await assertRejects(() => h.throttle.fetch("https://example.test/a"), YahooUnavailableError);
  h.clock.advance(10 * 60_000 + 1);
  await assertRejects(() => h.throttle.fetch("https://example.test/a"), YahooUnavailableError);
  assertEquals(h.calls.length, 6, "exactly one trial request went out");
});

Deno.test("breaker half-opens after 10 minutes: a successful trial closes it", async () => {
  const h = harness([status(429), status(429), status(429), status(429), status(429), ok()], { budgetMs: 1e12 });
  await h.throttle.fetch("https://example.test/a");
  await assertRejects(() => h.throttle.fetch("https://example.test/a"), YahooUnavailableError);
  h.clock.advance(10 * 60_000 + 1);
  const res = await h.throttle.fetch("https://example.test/a");
  assertEquals(res.status, 200);
  assertEquals((await h.kv.get<{ openUntilMs: number | null }>("yahoo:breaker"))?.openUntilMs, null);
});

Deno.test("breaker state persisted in the store is honoured by a fresh throttle (a new isolate)", async () => {
  const h = harness([status(429)]);
  await h.throttle.fetch("https://example.test/a");
  await assertRejects(() => h.throttle.fetch("https://example.test/a"), YahooUnavailableError);

  let calls = 0;
  const second = createThrottle({
    fetchImpl: () => {
      calls++;
      return Promise.resolve(ok());
    },
    clock: h.clock,
    breaker: createKvBreakerStore(h.kv),
  });
  await assertRejects(() => second.fetch("https://example.test/a"), YahooUnavailableError);
  assertEquals(calls, 0);
});

Deno.test("budget: no new request starts after 90 s of wall time", async () => {
  const h = harness([ok()]);
  await h.throttle.fetch("https://example.test/a");
  h.clock.advance(91_000);
  await assertRejects(() => h.throttle.fetch("https://example.test/a"), BudgetExceededError);
});

Deno.test("timeout: a request that never answers is aborted and counted as a network error", async () => {
  const clock = createFakeClock();
  const kv = createMemoryKv(clock);
  const fetchImpl: FetchLike = (_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    });
  const throttle = createThrottle({ fetchImpl, clock, breaker: createKvBreakerStore(kv), timeoutMs: 20, maxAttempts: 2, rng: () => 0.5 });
  await assertRejects(() => throttle.fetch("https://example.test/slow"));
  assertEquals(throttle.stats().networkErrors, 2);
});

Deno.test("parseRetryAfter reads seconds and HTTP dates and caps at 60 s", () => {
  assertEquals(parseRetryAfter("7", 0), 7000);
  assertEquals(parseRetryAfter("500", 0), 60_000);
  assertEquals(parseRetryAfter(null, 0), null);
  assertEquals(parseRetryAfter("nonsense", 0), null);
  assertEquals(parseRetryAfter(new Date(10_000).toUTCString(), 4_000), 6000);
});
```

- [ ] **Step 2: Run it: `deno test -A --config supabase/functions/deno.json supabase/functions/_shared/adapters/throttle.test.ts`; Expected: FAIL (module not found ./throttle.ts)**

- [ ] **Step 3: Implement (1/4)**

**`supabase/functions/_shared/adapters/providers.ts`**

```ts
// supabase/functions/_shared/adapters/providers.ts  (Deno side; core never imports it)
// Spec 5.1 verbatim. Every record handed back by an adapter carries its provider through the owning interface (`id`).
import type { RawBar } from "../core/bars.ts";

export interface QuoteRecord {
  symbol: string;
  quoteType: string; // EQUITY | ETF | FUTURE | ...
  currency: string;
  financialCurrency: string | null; // trading currency (may be GBp/ZAc/ILA/KWF); reporting currency
  exchange: string;
  fullExchangeName: string | null; // NMS, NYQ, GER ...
  longName: string | null;
  shortName: string | null;
  marketCap: number | null; // MAJOR currency unit (spike 3.3)
  sharesOutstanding: number | null;
  regularMarketPrice: number | null;
  regularMarketTime: number | null; // epoch ms
  regularMarketPreviousClose: number | null;
  regularMarketChangePercent: number | null;
  marketState: string | null; // REGULAR | PRE | PREPRE | POST | POSTPOST | CLOSED
  firstTradeDateMs: number | null;
  exchangeTimezoneName: string | null;
  priceHint: number | null;
  averageDailyVolume3Month?: number | null; // present in the recorded quote and screener samples (P1-06)
}
export interface ChartRequest {
  period1: string;
  period2?: string;
  interval: "1d";
  events: "split" | "div|split";
}
export interface SplitEvent {
  dateMs: number;
  numerator: number;
  denominator: number;
}
export interface ChartResult {
  meta: {
    currency: string;
    exchange: string;
    exchangeTimezoneName: string;
    firstTradeDateMs: number | null;
    regularMarketTime: number | null;
    currentTradingPeriod: { start: number; end: number } | null;
    instrumentType: string | null;
    longName: string | null;
  };
  bars: RawBar[]; // core RawBar; OHLC split-adjusted, NOT dividend-adjusted
  splits: SplitEvent[];
}
export interface CompanyProfile {
  symbol: string;
  country: string | null;
  sector: string | null;
  industry: string | null;
  summary: string | null;
  employees: number | null;
}
export interface NewsItem {
  id: string;
  title: string;
  publisher: string | null;
  url: string;
  publishedMs: number;
  relatedTickers: string[];
}
export interface SearchHit {
  symbol: string;
  exchange: string;
  quoteType: string;
  longName: string | null;
  shortName: string | null;
  sector: string | null;
  industry: string | null;
}
export interface ScreenerRow extends QuoteRecord {} // quote-family fields; no sector/industry/country/ISIN/ADR flag (spike 3.7)
export interface ScreenerPage {
  total: number;
  offset: number;
  count: number;
  rows: ScreenerRow[];
}

export interface MarketDataProvider {
  readonly id: string; // "yahoo"
  search(q: string, o?: { quotesCount?: number; newsCount?: number }): Promise<{ hits: SearchHit[]; news: NewsItem[] }>;
  quote(symbols: string[], o?: { fields?: string[] }): Promise<QuoteRecord[]>; // unknown symbols are OMITTED, never errors (spike 3.3)
  chart(symbol: string, req: ChartRequest): Promise<ChartResult>;
  profile(symbol: string): Promise<CompanyProfile>; // quoteSummary assetProfile + quoteType
  news(symbol: string, count: number): Promise<NewsItem[]>;
  screen(req: { exchange: string; minMarketCapLocal: number; offset: number; size: number }): Promise<ScreenerPage>;
}
export interface FxQuote {
  ccy: string;
  usdPerUnit: number;
  rateDate: string;
  source: "frankfurter" | "yahoo";
  sourceSymbol: string | null;
}
export interface FxProvider {
  readonly id: string;
  usdPerUnit(ccys: string[]): Promise<{ rates: FxQuote[]; missing: string[] }>;
}
```

- [ ] **Step 4: Implement (2/4)**

**`supabase/functions/_shared/adapters/clock.ts`**

```ts
/** Injected time source so throttling, breakers and expiries are testable without real timers. */
export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, ms))),
};

/** Virtual clock: sleep advances time instantly. `sleeps` records every requested delay. */
export function createFakeClock(startMs = Date.UTC(2026, 9, 15, 7, 0, 0)): Clock & { advance(ms: number): void; sleeps: number[] } {
  let t = startMs;
  const sleeps: number[] = [];
  return {
    now: () => t,
    sleep: (ms) => {
      const d = Math.max(0, ms);
      sleeps.push(d);
      t += d;
      return Promise.resolve();
    },
    advance: (ms) => {
      t += ms;
    },
    sleeps,
  };
}
```

- [ ] **Step 5: Implement (3/4)**

**`supabase/functions/_shared/adapters/store.ts`**

```ts
import type { Clock } from "./clock.ts";

/** Small key/value store with expiry. Production: public.quote_cache (see db.ts). Tests: in-memory. */
export interface KvStore {
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: unknown, ttlMs: number): Promise<void>;
  delete(key: string): Promise<void>;
}

export function createMemoryKv(clock: Clock): KvStore & { size(): number } {
  const map = new Map<string, { value: unknown; expiresAt: number }>();
  return {
    get<T>(key: string): Promise<T | null> {
      const hit = map.get(key);
      if (hit === undefined || hit.expiresAt <= clock.now()) {
        map.delete(key);
        return Promise.resolve(null);
      }
      return Promise.resolve(structuredClone(hit.value) as T);
    },
    set(key, value, ttlMs) {
      map.set(key, { value: structuredClone(value), expiresAt: clock.now() + ttlMs });
      return Promise.resolve();
    },
    delete(key) {
      map.delete(key);
      return Promise.resolve();
    },
    size: () => map.size,
  };
}
```

- [ ] **Step 6: Implement (4/4)**

**`supabase/functions/_shared/adapters/throttle.ts`**

```ts
import type { Clock } from "./clock.ts";
import type { KvStore } from "./store.ts";

/** Spec 5.3: the single egress point to Yahoo. Pacing, retry with backoff, circuit breaker, budget, metrics. No globals. */

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface BreakerState {
  consecutiveFailures: number;
  openUntilMs: number | null;
}
export interface BreakerStore {
  load(): Promise<BreakerState>;
  save(state: BreakerState): Promise<void>;
}

export interface RateConfig {
  /** Minimum gap between two request starts. 340 ms keeps one invocation below 3 requests per second. */
  minSpacingMs: number;
  /** Extra random gap in [0, jitterMs). */
  jitterMs: number;
}
export const DEFAULT_RATE: Readonly<RateConfig> = Object.freeze({ minSpacingMs: 340, jitterMs: 100 });

export class YahooUnavailableError extends Error {
  constructor(readonly untilMs: number) {
    super(`yahoo_unavailable until ${new Date(untilMs).toISOString()}`);
    this.name = "YahooUnavailableError";
  }
}
export class BudgetExceededError extends Error {
  constructor() {
    super("yahoo_budget_exceeded");
    this.name = "BudgetExceededError";
  }
}

export interface ThrottleOptions {
  fetchImpl: FetchLike;
  clock: Clock;
  breaker: BreakerStore;
  rate?: RateConfig;
  rng?: () => number;
  timeoutMs?: number; // 20 s per request
  maxAttempts?: number; // 4
  breakerThreshold?: number; // 5 consecutive 429 or 5xx
  breakerOpenMs?: number; // 10 minutes
  budgetMs?: number; // 90 s of wall time per invocation: no new request after that
  onEvent?: (event: string, data: Record<string, unknown>) => void;
}

export interface ThrottleStats {
  requests: number; // attempts started
  retries: number;
  status429: number;
  status5xx: number;
  networkErrors: number;
  totalMs: number;
  byPath: Record<string, { n: number; ms: number }>; // host + path only: never a query string (crumb)
}

export interface Throttle {
  fetch: FetchLike;
  stats(): ThrottleStats;
}

export function createKvBreakerStore(kv: KvStore, key = "yahoo:breaker"): BreakerStore {
  return {
    async load() {
      const v = await kv.get<BreakerState>(key);
      return v ?? { consecutiveFailures: 0, openUntilMs: null };
    },
    save(state) {
      return kv.set(key, state, 60 * 60_000);
    },
  };
}

function urlOf(input: string | URL | Request): URL {
  if (input instanceof Request) return new URL(input.url);
  return new URL(String(input));
}

/** Retry-After as milliseconds (seconds or an HTTP date), capped at 60 s. */
export function parseRetryAfter(value: string | null, nowMs: number): number | null {
  if (value === null) return null;
  const secs = Number(value);
  if (Number.isFinite(secs) && secs >= 0) return Math.min(60_000, secs * 1000);
  const at = Date.parse(value);
  if (Number.isFinite(at)) return Math.min(60_000, Math.max(0, at - nowMs));
  return null;
}

export function createThrottle(opts: ThrottleOptions): Throttle {
  const rate = opts.rate ?? DEFAULT_RATE;
  const rng = opts.rng ?? Math.random;
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const maxAttempts = opts.maxAttempts ?? 4;
  const threshold = opts.breakerThreshold ?? 5;
  const openMs = opts.breakerOpenMs ?? 10 * 60_000;
  const budgetMs = opts.budgetMs ?? 90_000;
  const emit = opts.onEvent ?? (() => undefined);
  const { clock } = opts;

  const started = clock.now();
  let lastStart = Number.NEGATIVE_INFINITY;
  let state: BreakerState | null = null;
  let chain: Promise<unknown> = Promise.resolve();
  const stats: ThrottleStats = { requests: 0, retries: 0, status429: 0, status5xx: 0, networkErrors: 0, totalMs: 0, byPath: {} };

  async function breakerState(): Promise<BreakerState> {
    if (state === null) state = await opts.breaker.load();
    return state;
  }

  function record(url: URL, ms: number): void {
    const key = `${url.host}${url.pathname}`;
    const entry = stats.byPath[key] ?? { n: 0, ms: 0 };
    entry.n += 1;
    entry.ms += ms;
    stats.byPath[key] = entry;
    stats.totalMs += ms;
  }

  async function once(input: string | URL | Request, init: RequestInit | undefined): Promise<Response> {
    const st = await breakerState();
    const url = urlOf(input);
    let lastResponse: Response | null = null;
    let lastError: unknown = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (clock.now() - started >= budgetMs) throw new BudgetExceededError();
      if (st.openUntilMs !== null && clock.now() < st.openUntilMs) throw new YahooUnavailableError(st.openUntilMs);

      const gap = rate.minSpacingMs + rng() * rate.jitterMs;
      const wait = lastStart + gap - clock.now();
      if (wait > 0) await clock.sleep(wait);
      lastStart = clock.now();
      stats.requests += 1;
      if (attempt > 1) stats.retries += 1;

      let response: Response | null = null;
      let failure: "429" | "5xx" | "network" | null = null;
      const t0 = clock.now();
      try {
        const timeout = AbortSignal.timeout(timeoutMs);
        const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
        response = await opts.fetchImpl(input, { ...init, signal });
        if (response.status === 429) failure = "429";
        else if (response.status >= 500) failure = "5xx";
      } catch (e) {
        failure = "network";
        lastError = e;
        stats.networkErrors += 1;
      }
      record(url, clock.now() - t0);

      if (failure === null && response !== null) {
        if (st.consecutiveFailures > 0 || st.openUntilMs !== null) {
          const wasOpen = st.openUntilMs !== null;
          st.consecutiveFailures = 0;
          st.openUntilMs = null;
          await opts.breaker.save(st);
          if (wasOpen) emit("yahoo_breaker_closed", {});
        }
        return response;
      }

      if (failure === "429") stats.status429 += 1;
      if (failure === "5xx") stats.status5xx += 1;
      emit(failure === "429" ? "yahoo_429" : "yahoo_failure", { kind: failure, attempt, path: url.pathname });
      st.consecutiveFailures += 1;
      if (st.consecutiveFailures >= threshold) {
        st.openUntilMs = clock.now() + openMs;
        await opts.breaker.save(st);
        if (response !== null) await response.body?.cancel();
        emit("yahoo_breaker_open", { until: new Date(st.openUntilMs).toISOString() });
        throw new YahooUnavailableError(st.openUntilMs);
      }
      await opts.breaker.save(st);

      if (attempt < maxAttempts) {
        const base = Math.min(30_000, 1000 * 2 ** (attempt - 1)) * (0.5 + rng());
        const retryAfter = response === null ? null : parseRetryAfter(response.headers.get("retry-after"), clock.now());
        if (response !== null) await response.body?.cancel();
        lastResponse = null;
        await clock.sleep(retryAfter ?? base);
      } else {
        lastResponse = response;
      }
    }
    if (lastResponse !== null) return lastResponse; // exhausted on an HTTP error: the caller sees the status
    throw lastError instanceof Error ? lastError : new Error("yahoo_request_failed");
  }

  const throttled: FetchLike = (input, init) => {
    const run = () => once(input, init);
    const p = chain.then(run, run); // concurrency 1: requests are strictly serialised
    chain = p.catch(() => undefined);
    return p;
  };

  return { fetch: throttled, stats: () => ({ ...stats, byPath: { ...stats.byPath } }) };
}
```

- [ ] **Step 7: Run; Expected: PASS** `deno test -A --config supabase/functions/deno.json supabase/functions/_shared/adapters/throttle.test.ts` (14 tests: spacing <= 3 per rolling second, concurrency 1, backoff, Retry-After, breaker open/half-open/persisted, budget, timeout).

- [ ] **Step 8: Commit**

```bash
git add supabase/functions/_shared/adapters/providers.ts supabase/functions/_shared/adapters/clock.ts supabase/functions/_shared/adapters/store.ts supabase/functions/_shared/adapters/throttle.ts supabase/functions/_shared/adapters/throttle.test.ts
git commit -m "feat(adapters): provider interfaces and throttled egress with circuit breaker"
```

---
### Task 9: yahoo.ts, session.ts, fixtures.ts and the recorded Yahoo fixtures

**Parallelism:** needs Task 8; can run concurrently with Tasks 10, 11 and Group C.

**Files:**
- Create: `supabase/functions/_shared/adapters/yahoo.ts`, `supabase/functions/_shared/adapters/session.ts`, `supabase/functions/_shared/adapters/fixtures.ts`, `tools/build-yahoo-fixtures.ts`
- Create (generated): `supabase/functions/_shared/adapters/fixtures/yahoo/*.trim.json`
- Test: `supabase/functions/_shared/adapters/yahoo.test.ts`, `supabase/functions/_shared/adapters/yahoo.live.test.ts` (opt-in)

**Interfaces:**
- Consumes: Task 8 interfaces; `core/bars.ts`, `core/calendar.ts`
- Produces: `createYahooProvider({ fetchImpl, store, clock, rate?, rng?, budgetMs?, client?, onEvent?, recorder? })` implementing `MarketDataProvider` plus `stats()`; `mapQuote`, `mapChart`, `mapSearch`, `mapProfile`, `mapNews`, `toMs`, `chunk`, `collectScreenerPages`; `getSession`, `acquireSession`; `routeFetch`, `jsonResponse`, `readFixture`, `diskRecorder`

- [ ] **Step 1: Build the recorded fixtures from the spike samples**

The spike's raw samples live in `C:\Users\IOANAV~1\AppData\Local\Temp\claude\C--Data-git-repos--tests-nira-personal-stock-sreener\aa696ef1-a34b-4ef2-99b8-f428d2600088\scratchpad\yf2-spike\raw\` (call it `$RAW`; copy the directory to a stable place first if the temp path is gone). The tool trims these samples (it never edits values): `chart_SAP.DE.json` (last 40 bars: null bar 2026-10-14 and a FORMING bar 2026-10-15), `chart_AAPL.json`, `chart_7203.T.json` (completed session), `chart_0700.HK.json` (bars at 01:30Z), `chart_NVDA.json` (2024-06-03..12, 4:1 and 10:1 splits), `quote_50.json` (12 records incl. SHEL.L with currency GBp), `quoteSummary_SAP.DE.json`, `search_US5949181045.json`, `screener_gb_p1.json` and `screener_us_p1.json` (raw screener result objects, first 5 rows). Other raw samples (`fx.json`, `chart_NESN.SW.json`, `chart_2222.SR.json`, `chart_RELIANCE.NS.json`, `news_*.json`, `search_*.json`, the other `screener_*_p1.json`, `universe_*.json`, `world_10e9.json`) are not copied in P1 (`fx.json` is used by Task 19).

```bash
bun run tools/build-yahoo-fixtures.ts "$RAW"
ls supabase/functions/_shared/adapters/fixtures/yahoo
```

Expected: ten `*.trim.json` files (each under 11 KB): `chart_0700.HK`, `chart_7203.T`, `chart_AAPL`, `chart_NVDA`, `chart_SAP.DE`, `quoteSummary_SAP.DE`, `quote_12`, `screener_gb`, `screener_us`, `search_US5949181045`.

**`tools/build-yahoo-fixtures.ts`**

```ts
// Builds the small recorded Yahoo fixtures from the spike's raw JSON samples.
// Usage: bun run tools/build-yahoo-fixtures.ts <spike raw dir>
// The spike samples are library outputs (post-parse) or raw screener result objects; they are trimmed, never edited.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const rawDir = process.argv[2];
if (rawDir === undefined) {
  console.error("usage: bun run tools/build-yahoo-fixtures.ts <spike raw dir>");
  process.exit(1);
}
const outDir = join(import.meta.dir, "..", "supabase", "functions", "_shared", "adapters", "fixtures", "yahoo");
mkdirSync(outDir, { recursive: true });

const read = (name: string): any => JSON.parse(readFileSync(join(rawDir, name), "utf8"));
const write = (name: string, value: unknown): void => {
  writeFileSync(join(outDir, name), JSON.stringify(value, null, 1) + "\n");
  console.log("wrote", name);
};

const QUOTE_KEEP = [
  "language", "region", "market", "symbol", "quoteType", "currency", "financialCurrency", "exchange", "fullExchangeName", "longName",
  "shortName", "marketCap", "sharesOutstanding", "regularMarketPrice", "regularMarketTime", "regularMarketPreviousClose",
  "regularMarketChangePercent", "marketState", "firstTradeDateMilliseconds", "exchangeTimezoneName", "priceHint", "averageDailyVolume3Month",
];
const pick = (q: any): any => Object.fromEntries(QUOTE_KEEP.filter((k) => k in q).map((k) => [k, q[k]]));

// chart(): meta + the bars the tests need + events
const tail = (n: number) => (c: any) => ({ meta: c.meta, quotes: c.quotes.slice(-n), events: { splits: c.events?.splits ?? [] } });
write("chart_SAP.DE.trim.json", { ...tail(40)(read("chart_SAP.DE.json")), note: "last bar is FORMING and 2026-10-14 is a null bar (spike 3.2)" });
write("chart_AAPL.trim.json", tail(40)(read("chart_AAPL.json")));
write("chart_7203.T.trim.json", tail(40)(read("chart_7203.T.json")));
write("chart_0700.HK.trim.json", tail(40)(read("chart_0700.HK.json")));
const nvda = read("chart_NVDA.json");
write("chart_NVDA.trim.json", {
  meta: nvda.meta,
  quotes: nvda.quotes.filter((q: any) => q.date >= "2024-06-03" && q.date < "2024-06-13"),
  events: { splits: nvda.events.splits },
});

// quote(): twelve real records, including SHEL.L (currency GBp, marketCap in GBP)
const wanted = ["AAPL", "MSFT", "NVDA", "GOOGL", "SAP.DE", "SHEL.L", "7203.T", "0700.HK", "2222.SR", "2330.TW", "ASML.AS", "BRK-B"];
const q50: any[] = read("quote_50.json");
write("quote_12.trim.json", wanted.map((s) => pick(q50.find((q) => q.symbol === s))));

// quoteSummary() and search()
const qs = read("quoteSummary_SAP.DE.json");
write("quoteSummary_SAP.DE.trim.json", {
  assetProfile: { ...qs.assetProfile, longBusinessSummary: String(qs.assetProfile.longBusinessSummary).slice(0, 200) },
  quoteType: qs.quoteType,
});
const search = read("search_US5949181045.json");
write("search_US5949181045.trim.json", { quotes: search.quotes.slice(0, 1), news: search.news.slice(0, 2).map(({ thumbnail, ...rest }: any) => rest) });

// raw screener result objects (result[0] of the HTTP response)
for (const [file, out] of [["screener_gb_p1.json", "screener_gb.trim.json"], ["screener_us_p1.json", "screener_us.trim.json"]] as const) {
  const s = read(file);
  write(out, { start: 0, count: 5, total: s.total, quotes: s.quotes.slice(0, 5).map(pick), useRecords: false });
}
```


- [ ] **Step 2: Write the failing tests**

**`supabase/functions/_shared/adapters/yahoo.test.ts`**

```ts
import { assert, assertEquals, assertRejects } from "@std/assert";
import { cleanBars, sessionDay, type ChartMeta } from "../core/bars.ts";
import { isoDate } from "../core/calendar.ts";
import { createFakeClock } from "./clock.ts";
import { jsonResponse, readFixture, routeFetch } from "./fixtures.ts";
import { createMemoryKv } from "./store.ts";
import { YahooUnavailableError } from "./throttle.ts";
import {
  YahooHttpError,
  chunk,
  collectScreenerPages,
  createYahooProvider,
  mapChart,
  mapProfile,
  mapQuote,
  mapSearch,
  toMs,
  type YahooClientLike,
} from "./yahoo.ts";

const utc = (iso: string) => Date.parse(iso);

// ---------------------------------------------------------------------------- mapping against recorded samples

Deno.test("toMs reads Date, ISO strings, epoch seconds and epoch milliseconds", () => {
  const ms = Date.UTC(2026, 9, 15, 7, 27, 36);
  assertEquals(toMs(new Date(ms)), ms);
  assertEquals(toMs("2026-10-15T07:27:36.000Z"), ms);
  assertEquals(toMs(ms / 1000, "s"), ms);
  assertEquals(toMs(ms, "ms"), ms);
  assertEquals(toMs(Number.NaN), null);
  assertEquals(toMs("garbage"), null);
  assertEquals(toMs(null), null);
});

Deno.test("mapQuote: twelve recorded quote records, SHEL.L keeps currency GBp and a GBP market cap", async () => {
  const rows = await readFixture<unknown[]>("yahoo/quote_12.trim.json");
  const mapped = rows.map(mapQuote);
  assertEquals(mapped.filter((m) => m === null).length, 0);
  const shel = mapped.find((m) => m?.symbol === "SHEL.L");
  assertEquals(shel?.currency, "GBp");
  assertEquals(shel?.financialCurrency, "USD");
  assertEquals(shel?.marketCap, 222044831744); // already GBP: never divided by 100
  assertEquals(shel?.exchange, "LSE");
  const aapl = mapped.find((m) => m?.symbol === "AAPL");
  assertEquals(aapl?.quoteType, "EQUITY");
  assertEquals(aapl?.exchangeTimezoneName, "America/New_York");
  assertEquals(aapl?.firstTradeDateMs, utc("1980-12-12T14:30:00.000Z"));
  assertEquals(aapl?.regularMarketTime, utc("2026-10-14T20:00:01.000Z"));
  assertEquals(aapl?.averageDailyVolume3Month, 45112966);
});

Deno.test("mapQuote: raw screener rows carry epoch seconds and epoch milliseconds", async () => {
  const page = await readFixture<{ quotes: Array<Record<string, unknown>> }>("yahoo/screener_gb.trim.json");
  const first = page.quotes[0]!;
  const mapped = mapQuote(first);
  assert(mapped !== null);
  assertEquals(mapped.regularMarketTime, (first["regularMarketTime"] as number) * 1000);
  assertEquals(mapped.firstTradeDateMs, first["firstTradeDateMilliseconds"] as number);
});

Deno.test("mapQuote returns null (schema drift) when an identity field is missing", () => {
  assertEquals(mapQuote({ symbol: "X", currency: "USD", exchange: "NMS" }), null);
  assertEquals(mapQuote({ currency: "USD", exchange: "NMS", quoteType: "EQUITY" }), null);
  assertEquals(mapQuote("nope"), null);
});

Deno.test("mapChart: SAP.DE keeps the null bar and exposes the trading period in epoch ms", async () => {
  const chart = mapChart(await readFixture("yahoo/chart_SAP.DE.trim.json"));
  assertEquals(chart.meta.exchangeTimezoneName, "Europe/Berlin");
  assertEquals(chart.meta.currentTradingPeriod, { start: utc("2026-10-15T07:00:00Z"), end: utc("2026-10-15T15:30:00Z") });
  assertEquals(chart.meta.regularMarketTime, utc("2026-10-15T07:27:36Z"));
  assertEquals(chart.bars.length, 40);
  const nullBar = chart.bars.find((b) => b.time === utc("2026-10-14T07:00:00Z"));
  assertEquals(nullBar?.close, null);
  assertEquals(chart.splits, []);
});

Deno.test("mapChart + cleanBars on the recorded SAP.DE sample: the forming bar and the null bar never reach the series", async () => {
  const chart = mapChart(await readFixture("yahoo/chart_SAP.DE.trim.json"));
  const meta: ChartMeta = {
    exchangeTimezoneName: chart.meta.exchangeTimezoneName,
    regularMarketTime: chart.meta.regularMarketTime,
    currentTradingPeriod: chart.meta.currentTradingPeriod,
    marketState: "REGULAR",
  };
  const { series, report } = cleanBars(chart.bars, meta, utc("2026-10-15T07:42:00Z"));
  assertEquals(report.droppedForming, true);
  assertEquals(report.droppedNullClose, 1);
  assertEquals(isoDate(series.dates[series.dates.length - 1]!), "2026-10-13");
  assert(!series.close.includes(199.6199951171875), "the forming 2026-10-15 close must not be stored");
});

Deno.test("mapChart + cleanBars on AAPL and 7203.T: the last bar is a completed session", async () => {
  const aapl = mapChart(await readFixture("yahoo/chart_AAPL.trim.json"));
  const a = cleanBars(aapl.bars, { ...aapl.meta, marketState: "PREPRE" }, utc("2026-10-15T07:42:00Z"));
  assertEquals(a.report.droppedForming, false);
  assertEquals(isoDate(a.series.dates[a.series.dates.length - 1]!), "2026-10-14");

  const toyota = mapChart(await readFixture("yahoo/chart_7203.T.trim.json"));
  const t = cleanBars(toyota.bars, { ...toyota.meta, marketState: "POSTPOST" }, utc("2026-10-15T07:42:00Z"));
  assertEquals(t.report.droppedForming, false);
  assertEquals(isoDate(t.series.dates[t.series.dates.length - 1]!), "2026-10-15");
});

Deno.test("mapChart: NVDA 4:1 and 10:1 splits are reported and close is continuous across 2024-06-07/10 (no jump)", async () => {
  const chart = mapChart(await readFixture("yahoo/chart_NVDA.trim.json"));
  assertEquals(chart.splits, [
    { dateMs: utc("2021-07-20T13:30:00Z"), numerator: 4, denominator: 1 },
    { dateMs: utc("2024-06-10T13:30:00Z"), numerator: 10, denominator: 1 },
  ]);
  const { series, report } = cleanBars(
    chart.bars,
    { exchangeTimezoneName: "America/New_York", regularMarketTime: utc("2024-06-12T20:00:00Z"), currentTradingPeriod: { start: utc("2024-06-13T13:30:00Z"), end: utc("2024-06-13T20:00:00Z") }, marketState: "CLOSED" },
    utc("2024-06-13T05:00:00Z"),
  );
  assertEquals(report.jumpAnomalies, 0);
  const i7 = series.dates.indexOf(sessionDay(utc("2024-06-07T13:30:00Z"), "America/New_York"));
  const i10 = series.dates.indexOf(sessionDay(utc("2024-06-10T13:30:00Z"), "America/New_York"));
  assert(i7 >= 0 && i10 === i7 + 1, "2024-06-07 and 2024-06-10 are consecutive sessions");
  assert(Math.abs(series.close[i10]! / series.close[i7]! - 1) < 0.05);
});

Deno.test("mapChart: 0700.HK bars open at 01:30Z, map to the Hong Kong session day, and the in-progress session is dropped at 07:42Z", async () => {
  const chart = mapChart(await readFixture("yahoo/chart_0700.HK.trim.json"));
  const last = chart.bars[chart.bars.length - 1]!;
  assertEquals(new Date(last.time).toISOString().slice(11, 16), "01:30");
  assertEquals(isoDate(sessionDay(last.time, "Asia/Hong_Kong")), "2026-10-15");
  const { series, report } = cleanBars(chart.bars, { ...chart.meta, marketState: "REGULAR" }, utc("2026-10-15T07:42:00Z"));
  assertEquals(report.droppedForming, true); // the Hong Kong session runs until 08:00Z
  assertEquals(isoDate(series.dates[series.dates.length - 1]!), "2026-10-14");
});

Deno.test("mapChart rejects a payload without a timezone (session days could not be derived)", () => {
  let threw = false;
  try {
    mapChart({ meta: { currency: "USD" }, quotes: [] });
  } catch {
    threw = true;
  }
  assert(threw);
});

Deno.test("mapSearch and mapProfile on recorded samples", async () => {
  const s = mapSearch(await readFixture("yahoo/search_US5949181045.trim.json"));
  assertEquals(s.hits.map((h) => [h.symbol, h.exchange, h.quoteType, h.sector]), [["MSFT", "NMS", "EQUITY", "Technology"]]);
  assertEquals(s.news.length, 2);
  assert(s.news[0]!.relatedTickers.length > 0);
  assert(s.news[0]!.publishedMs > 0);

  const p = mapProfile("SAP.DE", await readFixture("yahoo/quoteSummary_SAP.DE.trim.json"));
  assertEquals([p.country, p.sector, p.industry], ["Germany", "Technology", "Software - Application"]);
  assert(p.summary !== null && p.summary.length <= 200);
});

Deno.test("chunk splits 1,200 symbols into 500 + 500 + 200", () => {
  assertEquals(chunk(Array.from({ length: 1200 }, (_, i) => i), 500).map((c) => c.length), [500, 500, 200]);
  assertEquals(chunk([], 500), []);
});

// ---------------------------------------------------------------------------- provider with an injected client

function fakeClient(over: Partial<YahooClientLike> = {}) {
  const calls = { quote: [] as Array<{ symbols: string[]; fields: string[] | undefined }>, chart: [] as Array<Record<string, unknown>> };
  const client: YahooClientLike = {
    quote: (symbols, query) => {
      calls.quote.push({ symbols, fields: query.fields });
      return Promise.resolve(symbols.filter((s) => s !== "UNKNOWN").map((symbol) => ({ symbol, currency: "USD", exchange: "NMS", quoteType: "EQUITY", marketCap: 1 })));
    },
    chart: (_symbol, query) => {
      calls.chart.push(query);
      return readFixture("yahoo/chart_AAPL.trim.json");
    },
    search: () => readFixture("yahoo/search_US5949181045.trim.json"),
    quoteSummary: () => readFixture("yahoo/quoteSummary_SAP.DE.trim.json"),
    ...over,
  };
  return { client, calls };
}

function providerWith(client: YahooClientLike, fetchImpl = routeFetch([]), extra: Record<string, unknown> = {}) {
  const clock = createFakeClock();
  const store = createMemoryKv(clock);
  const events: Array<[string, Record<string, unknown>]> = [];
  const provider = createYahooProvider({ fetchImpl, store, clock, client, rng: () => 0.5, onEvent: (e, d) => events.push([e, d]), ...extra });
  return { provider, clock, store, events };
}

Deno.test("quote: 1,200 unique symbols go out as 3 calls of 500, 500 and 200; duplicates are removed; unknown symbols are omitted", async () => {
  const { client, calls } = fakeClient();
  const { provider } = providerWith(client);
  const symbols = Array.from({ length: 1200 }, (_, i) => `S${i}`);
  const rows = await provider.quote([...symbols, ...symbols.slice(0, 10), "UNKNOWN"]);
  assertEquals(calls.quote.map((c) => c.symbols.length), [500, 500, 201]);
  assertEquals(rows.length, 1200);
  assert(!rows.some((r) => r.symbol === "UNKNOWN"));
  assert(calls.quote[0]!.fields!.includes("marketCap"));
});

Deno.test("quote: a row without identity fields is dropped and counted as schema drift", async () => {
  const { client } = fakeClient({ quote: () => Promise.resolve([{ symbol: "A", currency: "USD", exchange: "NMS", quoteType: "EQUITY" }, { currency: "USD" }]) });
  const { provider, events } = providerWith(client);
  const rows = await provider.quote(["A", "B"]);
  assertEquals(rows.length, 1);
  assertEquals(provider.stats().schemaDrift, 1);
  assertEquals(events[0]?.[0], "yahoo_schema_drift");
});

Deno.test("quote of no symbols makes no call", async () => {
  const { client, calls } = fakeClient();
  const { provider } = providerWith(client);
  assertEquals(await provider.quote([]), []);
  assertEquals(calls.quote.length, 0);
});

Deno.test("chart: requests daily bars with the given events and period1 and maps the result", async () => {
  const { client, calls } = fakeClient();
  const { provider } = providerWith(client);
  const res = await provider.chart("AAPL", { period1: "2013-10-15", interval: "1d", events: "split" });
  assertEquals(calls.chart[0], { period1: "2013-10-15", interval: "1d", events: "split" });
  assertEquals(res.bars.length, 40);
  assertEquals(res.meta.exchangeTimezoneName, "America/New_York");
});

Deno.test("profile, search and news go through the client", async () => {
  const { client } = fakeClient();
  const { provider } = providerWith(client);
  assertEquals((await provider.profile("SAP.DE")).country, "Germany");
  assertEquals((await provider.search("US5949181045")).hits[0]?.symbol, "MSFT");
  assertEquals((await provider.news("MSFT", 50)).length, 2);
});

// ---------------------------------------------------------------------------- raw screener

interface ScreenerWorld {
  fetchImpl: ReturnType<typeof routeFetch>;
  bodies: Array<Record<string, unknown>>;
  count: { cookie: number; crumb: number; screener: number };
}

function screenerWorld(rows: Array<Record<string, unknown>>, opts: { unauthorizedFirst?: number; status?: number } = {}): ScreenerWorld {
  const count = { cookie: 0, crumb: 0, screener: 0 };
  const bodies: Array<Record<string, unknown>> = [];
  let unauthorized = opts.unauthorizedFirst ?? 0;
  const fetchImpl = routeFetch([
    {
      match: (u) => u.host === "fc.yahoo.com",
      respond: () => {
        count.cookie++;
        return new Response("", { status: 404, headers: { "set-cookie": "A3=d=TESTCOOKIE; Expires=Wed, 15 Oct 2027 07:00:00 GMT; Domain=.yahoo.com; Path=/" } });
      },
    },
    {
      match: (u) => u.pathname === "/v1/test/getcrumb",
      respond: (_u, init) => {
        count.crumb++;
        const cookie = new Headers(init?.headers).get("cookie");
        return cookie === "A3=d=TESTCOOKIE" ? new Response("CRUMB123456", { status: 200 }) : new Response("no cookie", { status: 401 });
      },
    },
    {
      match: (u) => u.pathname === "/v1/finance/screener",
      respond: async (u, init) => {
        count.screener++;
        assertEquals(u.searchParams.get("crumb"), count.cookie > 1 && opts.unauthorizedFirst ? "CRUMB123456" : "CRUMB123456");
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        bodies.push(body);
        if (opts.status !== undefined) return new Response("limited", { status: opts.status });
        if (unauthorized > 0) {
          unauthorized--;
          return jsonResponse({ error: { code: "Unauthorized", description: "Invalid Crumb" } }, 401);
        }
        const offset = body["offset"] as number;
        const size = body["size"] as number;
        const slice = rows.slice(offset, offset + size);
        return jsonResponse({ finance: { result: [{ start: offset, count: slice.length, total: rows.length, quotes: slice, useRecords: false }], error: null } });
      },
    },
  ]);
  return { fetchImpl, bodies, count };
}

async function sampleRows(): Promise<Array<Record<string, unknown>>> {
  const gb = await readFixture<{ quotes: Array<Record<string, unknown>> }>("yahoo/screener_gb.trim.json");
  return gb.quotes;
}

Deno.test("screen: posts the per-exchange query with cookie and crumb and maps the page", async () => {
  const world = screenerWorld(await sampleRows());
  const { provider } = providerWith(fakeClient().client, world.fetchImpl);
  const page = await provider.screen({ exchange: "LSE", minMarketCapLocal: 35e9, offset: 0, size: 250 });
  assertEquals(page.total, 5);
  assertEquals(page.count, 5);
  assertEquals(page.rows.length, 5);
  assertEquals(world.bodies[0], {
    size: 250,
    offset: 0,
    sortField: "intradaymarketcap",
    sortType: "DESC",
    quoteType: "EQUITY",
    query: { operator: "and", operands: [{ operator: "gt", operands: ["intradaymarketcap", 35e9] }, { operator: "eq", operands: ["exchange", "LSE"] }] },
    userId: "",
    userIdType: "guid",
  });
});

Deno.test("collectScreenerPages: two pages are walked until offset >= total", async () => {
  const world = screenerWorld(await sampleRows());
  const { provider } = providerWith(fakeClient().client, world.fetchImpl);
  const res = await collectScreenerPages(provider, { exchange: "LSE", minMarketCapLocal: 35e9, size: 3, maxPages: 10 });
  assertEquals(res.pages, 2);
  assertEquals(res.rows.length, 5);
  assertEquals(res.total, 5);
  assertEquals(res.nextOffset, null);
  assertEquals(world.bodies.map((b) => b["offset"]), [0, 3]);
  assertEquals(world.count.cookie, 1, "the session is acquired once and cached for the second page");
});

Deno.test("collectScreenerPages: maxPages truncates and reports where to continue", async () => {
  const world = screenerWorld(await sampleRows());
  const { provider } = providerWith(fakeClient().client, world.fetchImpl);
  const res = await collectScreenerPages(provider, { exchange: "LSE", minMarketCapLocal: 35e9, size: 2, maxPages: 2 });
  assertEquals(res.pages, 2);
  assertEquals(res.rows.length, 4);
  assertEquals(res.nextOffset, 4);
});

Deno.test("screen: an empty page ends the walk", async () => {
  const world = screenerWorld([]);
  const { provider } = providerWith(fakeClient().client, world.fetchImpl);
  const res = await collectScreenerPages(provider, { exchange: "XXX", minMarketCapLocal: 1, maxPages: 5 });
  assertEquals(res.pages, 1);
  assertEquals(res.rows, []);
});

Deno.test("screen: HTTP 401 Invalid Crumb discards the session, reacquires once and retries", async () => {
  const world = screenerWorld(await sampleRows(), { unauthorizedFirst: 1 });
  const { provider } = providerWith(fakeClient().client, world.fetchImpl);
  const page = await provider.screen({ exchange: "LSE", minMarketCapLocal: 1, offset: 0, size: 250 });
  assertEquals(page.rows.length, 5);
  assertEquals(world.count.cookie, 2, "one reacquire");
  assertEquals(world.count.screener, 2);
});

Deno.test("screen: a second 401 is an error, not a loop", async () => {
  const world = screenerWorld(await sampleRows(), { unauthorizedFirst: 5 });
  const { provider } = providerWith(fakeClient().client, world.fetchImpl);
  const err = await assertRejects(() => provider.screen({ exchange: "LSE", minMarketCapLocal: 1, offset: 0, size: 250 }), YahooHttpError);
  assertEquals(err.status, 401);
  assertEquals(world.count.screener, 2);
});

Deno.test("screen: a cached session is restored by a new provider instance (no cookie request)", async () => {
  const world = screenerWorld(await sampleRows());
  const clock = createFakeClock();
  const store = createMemoryKv(clock);
  const make = () => createYahooProvider({ fetchImpl: world.fetchImpl, store, clock, client: fakeClient().client, rng: () => 0.5 });
  await make().screen({ exchange: "LSE", minMarketCapLocal: 1, offset: 0, size: 250 });
  await make().screen({ exchange: "LSE", minMarketCapLocal: 1, offset: 0, size: 250 });
  assertEquals(world.count.cookie, 1);
});

Deno.test("screen: size above 250 is rejected before any request", async () => {
  const world = screenerWorld([]);
  const { provider } = providerWith(fakeClient().client, world.fetchImpl);
  let threw = false;
  try {
    await provider.screen({ exchange: "LSE", minMarketCapLocal: 1, offset: 0, size: 500 });
  } catch (e) {
    threw = e instanceof RangeError;
  }
  assert(threw);
  assertEquals(world.fetchImpl.calls.length, 0);
});

Deno.test("429 storm: the call retries, then the breaker opens and the next call fails fast without a request", async () => {
  const world = screenerWorld(await sampleRows(), { status: 429 });
  const { provider, events } = providerWith(fakeClient().client, world.fetchImpl, { budgetMs: 1e12 });
  const err = await assertRejects(() => provider.screen({ exchange: "LSE", minMarketCapLocal: 1, offset: 0, size: 250 }), YahooHttpError);
  assertEquals(err.status, 429);
  assertEquals(world.count.screener, 4);
  await assertRejects(() => provider.screen({ exchange: "LSE", minMarketCapLocal: 1, offset: 0, size: 250 }), YahooUnavailableError);
  const before = world.fetchImpl.calls.length;
  await assertRejects(() => provider.screen({ exchange: "LSE", minMarketCapLocal: 1, offset: 0, size: 250 }), YahooUnavailableError);
  assertEquals(world.fetchImpl.calls.length, before);
  assert(events.some(([e]) => e === "yahoo_breaker_open"));
  assertEquals(provider.stats().status429, 5);
});

Deno.test("recorder: responses are recorded with the crumb stripped; without a recorder nothing is recorded", async () => {
  const world = screenerWorld(await sampleRows());
  const entries: Array<{ method: string; url: string; status: number; body: string }> = [];
  const { provider } = providerWith(fakeClient().client, world.fetchImpl, { recorder: (e: { method: string; url: string; status: number; body: string }) => {
    entries.push(e);
    return Promise.resolve();
  } });
  await provider.screen({ exchange: "LSE", minMarketCapLocal: 1, offset: 0, size: 250 });
  const screener = entries.find((e) => e.url.includes("/v1/finance/screener"));
  assert(screener !== undefined);
  assert(!screener.url.includes("CRUMB123456"));
  assert(screener.url.includes("crumb=REDACTED"));
  assertEquals(screener.method, "POST");
});
```

**`supabase/functions/_shared/adapters/yahoo.live.test.ts`**

```ts
// Opt-in live smoke test: YF_LIVE=1 deno test --config supabase/functions/deno.json --allow-net --allow-env <this file>
// Makes about ten requests to Yahoo through the throttle. Not part of the default test run.
import { assert, assertEquals } from "@std/assert";
import { systemClock } from "./clock.ts";
import { createMemoryKv } from "./store.ts";
import { createYahooProvider } from "./yahoo.ts";

const live = Deno.env.get("YF_LIVE") === "1";

Deno.test({ name: "live: quote, chart, profile and a screener page through the throttle", ignore: !live, sanitizeOps: false, sanitizeResources: false }, async () => {
  const provider = createYahooProvider({ fetchImpl: fetch, store: createMemoryKv(systemClock), clock: systemClock });

  const quotes = await provider.quote(["AAPL", "SHEL.L", "NOT-A-REAL-SYMBOL-XYZ"]);
  assertEquals(quotes.map((q) => q.symbol).sort(), ["AAPL", "SHEL.L"]);
  assertEquals(quotes.find((q) => q.symbol === "SHEL.L")?.currency, "GBp");
  assert((quotes.find((q) => q.symbol === "AAPL")?.marketCap ?? 0) > 1e12);

  const chart = await provider.chart("SAP.DE", { period1: new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10), interval: "1d", events: "split" });
  assertEquals(chart.meta.exchangeTimezoneName, "Europe/Berlin");
  assert(chart.bars.length > 10);
  assert(chart.meta.currentTradingPeriod !== null);

  const profile = await provider.profile("SAP.DE");
  assertEquals(profile.country, "Germany");

  const page = await provider.screen({ exchange: "GER", minMarketCapLocal: 35e9, offset: 0, size: 3 });
  assert(page.total > 0 && page.rows.length === 3);
  assert(page.rows.every((r) => r.exchange === "GER"));

  const stats = provider.stats();
  console.log("requests", stats.requests, "retries", stats.retries, "429s", stats.status429, "drift", stats.schemaDrift);
});
```

- [ ] **Step 3: Run it: `deno test --allow-env --allow-net=127.0.0.1,localhost --config supabase/functions/deno.json --allow-read=supabase/functions/_shared/adapters/fixtures supabase/functions/_shared/adapters/yahoo.test.ts`; Expected: FAIL (module not found ./yahoo.ts)**

- [ ] **Step 4: Implement (1/3)**

**`supabase/functions/_shared/adapters/session.ts`**

```ts
import type { Clock } from "./clock.ts";
import type { KvStore } from "./store.ts";
import type { FetchLike } from "./throttle.ts";

/**
 * Cookie + crumb for the raw screener endpoint (the library cannot run custom screener queries and keeps its own crumb
 * private). Flow verified live in the spike (3.7): GET fc.yahoo.com sets cookie A3 (HTTP 404), then GET getcrumb with it.
 */
export interface YahooSession {
  cookie: string;
  crumb: string;
  acquiredAtMs: number;
}

export const SESSION_KEY = "yahoo:session";
export const SESSION_TTL_MS = 6 * 60 * 60_000;
export const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

export class YahooSessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "YahooSessionError";
  }
}

function cookieHeaderFrom(res: Response): string {
  const raw = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [res.headers.get("set-cookie") ?? ""];
  return raw
    .map((c) => c.split(";")[0]?.trim() ?? "")
    .filter((c) => c.length > 0)
    .join("; ");
}

export async function acquireSession(fetchImpl: FetchLike, clock: Clock): Promise<YahooSession> {
  const first = await fetchImpl("https://fc.yahoo.com", { headers: { "User-Agent": BROWSER_UA }, redirect: "manual" });
  await first.body?.cancel();
  const cookie = cookieHeaderFrom(first);
  if (cookie === "") throw new YahooSessionError("yahoo_session_no_cookie");

  const second = await fetchImpl("https://query1.finance.yahoo.com/v1/test/getcrumb", {
    headers: { "User-Agent": BROWSER_UA, Cookie: cookie },
  });
  if (!second.ok) {
    await second.body?.cancel();
    throw new YahooSessionError(`yahoo_session_crumb_http_${second.status}`);
  }
  const crumb = (await second.text()).trim();
  if (crumb === "" || crumb.length > 64 || /[<>{}\s]/.test(crumb)) throw new YahooSessionError("yahoo_session_bad_crumb");
  return { cookie, crumb, acquiredAtMs: clock.now() };
}

/** Restores the cached session (6 h) or acquires a new one. `force` discards the cache first (HTTP 401 Invalid Crumb). */
export async function getSession(store: KvStore, fetchImpl: FetchLike, clock: Clock, force = false): Promise<YahooSession> {
  if (!force) {
    const cached = await store.get<YahooSession>(SESSION_KEY);
    if (cached !== null && typeof cached.crumb === "string" && typeof cached.cookie === "string") return cached;
  } else {
    await store.delete(SESSION_KEY);
  }
  const session = await acquireSession(fetchImpl, clock);
  await store.set(SESSION_KEY, session, SESSION_TTL_MS);
  return session;
}
```

- [ ] **Step 5: Implement (2/3)**

**`supabase/functions/_shared/adapters/yahoo.ts`**

```ts
import type { RawBar } from "../core/bars.ts";
import type { Clock } from "./clock.ts";
import type {
  ChartRequest,
  ChartResult,
  CompanyProfile,
  MarketDataProvider,
  NewsItem,
  QuoteRecord,
  ScreenerPage,
  SearchHit,
  SplitEvent,
} from "./providers.ts";
import { BROWSER_UA, getSession } from "./session.ts";
import type { KvStore } from "./store.ts";
import { createKvBreakerStore, createThrottle, type FetchLike, type RateConfig, type ThrottleStats } from "./throttle.ts";

export const QUOTE_CHUNK = 500; // 2,500 symbols worked and 4,000 failed with HTTP 414 in the spike; 500 is the contract (5.2)
export const SCREENER_MAX_SIZE = 250; // size 500 returns HTTP 400 "size is too large" (spike 3.7)

export const QUOTE_FIELDS: readonly string[] = [
  "symbol", "quoteType", "currency", "financialCurrency", "exchange", "fullExchangeName", "longName", "shortName",
  "marketCap", "sharesOutstanding", "regularMarketPrice", "regularMarketTime", "regularMarketPreviousClose",
  "regularMarketChangePercent", "marketState", "firstTradeDateMilliseconds", "exchangeTimezoneName", "priceHint",
  "averageDailyVolume3Month",
];

export class YahooSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "YahooSchemaError";
  }
}
export class YahooHttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "YahooHttpError";
  }
}

// ---------------------------------------------------------------- pure mapping (tested against recorded samples)

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof Date);
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * Instants arrive as Date, ISO string, epoch seconds (raw screener `regularMarketTime`) or epoch milliseconds
 * (raw `firstTradeDateMilliseconds`). `unit` says how to read a bare number.
 */
export function toMs(v: unknown, unit: "s" | "ms" = "ms"): number | null {
  if (v instanceof Date) {
    const t = v.getTime();
    return Number.isFinite(t) ? t : null;
  }
  if (typeof v === "number") return Number.isFinite(v) ? (unit === "s" ? v * 1000 : v) : null;
  if (typeof v === "string") {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

/** Maps a quote()/screener row. Returns null (schema drift) when an identity field is missing. */
export function mapQuote(raw: unknown): QuoteRecord | null {
  if (!isRec(raw)) return null;
  const symbol = str(raw["symbol"]);
  const currency = str(raw["currency"]);
  const exchange = str(raw["exchange"]);
  const quoteType = str(raw["quoteType"]);
  if (symbol === null || currency === null || exchange === null || quoteType === null) return null;
  return {
    symbol,
    quoteType,
    currency,
    financialCurrency: str(raw["financialCurrency"]),
    exchange,
    fullExchangeName: str(raw["fullExchangeName"]),
    longName: str(raw["longName"]),
    shortName: str(raw["shortName"]),
    marketCap: num(raw["marketCap"]),
    sharesOutstanding: num(raw["sharesOutstanding"]),
    regularMarketPrice: num(raw["regularMarketPrice"]),
    regularMarketTime: toMs(raw["regularMarketTime"], "s"),
    regularMarketPreviousClose: num(raw["regularMarketPreviousClose"]),
    regularMarketChangePercent: num(raw["regularMarketChangePercent"]),
    marketState: str(raw["marketState"]),
    firstTradeDateMs: toMs(raw["firstTradeDateMilliseconds"], "ms"),
    exchangeTimezoneName: str(raw["exchangeTimezoneName"]),
    priceHint: num(raw["priceHint"]),
    averageDailyVolume3Month: num(raw["averageDailyVolume3Month"]),
  };
}

/** Maps a chart() result (library shape: meta, quotes[], events?). Null OHLCV rows are kept: cleanBars drops them. */
export function mapChart(raw: unknown): ChartResult {
  if (!isRec(raw) || !isRec(raw["meta"]) || !Array.isArray(raw["quotes"])) throw new YahooSchemaError("chart_shape");
  const meta = raw["meta"];
  const tz = str(meta["exchangeTimezoneName"]);
  if (tz === null) throw new YahooSchemaError("chart_meta_timezone_missing");
  const tradingPeriod = isRec(meta["currentTradingPeriod"]) ? meta["currentTradingPeriod"] : null;
  const regular = tradingPeriod !== null && isRec(tradingPeriod["regular"]) ? tradingPeriod["regular"] : null;
  const start = regular === null ? null : toMs(regular["start"], "s");
  const end = regular === null ? null : toMs(regular["end"], "s");

  const bars: RawBar[] = [];
  for (const q of raw["quotes"]) {
    if (!isRec(q)) continue;
    const time = toMs(q["date"], "s");
    if (time === null) continue;
    bars.push({ time, open: num(q["open"]), high: num(q["high"]), low: num(q["low"]), close: num(q["close"]), volume: num(q["volume"]) });
  }

  const splits: SplitEvent[] = [];
  const events = isRec(raw["events"]) ? raw["events"] : null;
  if (events !== null && Array.isArray(events["splits"])) {
    for (const s of events["splits"]) {
      if (!isRec(s)) continue;
      const dateMs = toMs(s["date"], "s");
      const numerator = num(s["numerator"]);
      const denominator = num(s["denominator"]);
      if (dateMs !== null && numerator !== null && denominator !== null) splits.push({ dateMs, numerator, denominator });
    }
  }

  return {
    meta: {
      currency: str(meta["currency"]) ?? "",
      exchange: str(meta["exchangeName"]) ?? "",
      exchangeTimezoneName: tz,
      firstTradeDateMs: toMs(meta["firstTradeDate"], "s"),
      regularMarketTime: toMs(meta["regularMarketTime"], "s"),
      currentTradingPeriod: start !== null && end !== null ? { start, end } : null,
      instrumentType: str(meta["instrumentType"]),
      longName: str(meta["longName"]),
    },
    bars,
    splits,
  };
}

export function mapNews(raw: unknown): NewsItem[] {
  if (!Array.isArray(raw)) return [];
  const out: NewsItem[] = [];
  for (const n of raw) {
    if (!isRec(n)) continue;
    const id = str(n["uuid"]);
    const title = str(n["title"]);
    const url = str(n["link"]);
    const publishedMs = toMs(n["providerPublishTime"], "s");
    if (id === null || title === null || url === null || publishedMs === null) continue;
    const related = Array.isArray(n["relatedTickers"]) ? n["relatedTickers"].filter((t): t is string => typeof t === "string") : [];
    out.push({ id, title, publisher: str(n["publisher"]), url, publishedMs, relatedTickers: related });
  }
  return out;
}

export function mapSearch(raw: unknown): { hits: SearchHit[]; news: NewsItem[] } {
  if (!isRec(raw)) throw new YahooSchemaError("search_shape");
  const hits: SearchHit[] = [];
  if (Array.isArray(raw["quotes"])) {
    for (const q of raw["quotes"]) {
      if (!isRec(q) || q["isYahooFinance"] === false) continue;
      const symbol = str(q["symbol"]);
      const exchange = str(q["exchange"]);
      const quoteType = str(q["quoteType"]);
      if (symbol === null || exchange === null || quoteType === null) continue;
      hits.push({
        symbol,
        exchange,
        quoteType,
        longName: str(q["longname"]),
        shortName: str(q["shortname"]),
        sector: str(q["sector"]),
        industry: str(q["industry"]),
      });
    }
  }
  return { hits, news: mapNews(raw["news"]) };
}

export function mapProfile(symbol: string, raw: unknown): CompanyProfile {
  if (!isRec(raw)) throw new YahooSchemaError("profile_shape");
  const ap = isRec(raw["assetProfile"]) ? raw["assetProfile"] : isRec(raw["summaryProfile"]) ? raw["summaryProfile"] : null;
  if (ap === null) throw new YahooSchemaError("profile_missing_assetProfile");
  return {
    symbol,
    country: str(ap["country"]),
    sector: str(ap["sector"]),
    industry: str(ap["industry"]),
    summary: str(ap["longBusinessSummary"]),
    employees: num(ap["fullTimeEmployees"]),
  };
}

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// ---------------------------------------------------------------- provider

/** The four library calls the adapter uses. The real YahooFinance instance satisfies it; tests inject recorded results. */
export interface YahooClientLike {
  quote(symbols: string[], query: { fields?: string[] }, opts: { validateResult: false }): Promise<unknown>;
  chart(symbol: string, query: Record<string, unknown>, opts: { validateResult: false }): Promise<unknown>;
  search(q: string, query: Record<string, unknown>, opts: { validateResult: false }): Promise<unknown>;
  quoteSummary(symbol: string, query: { modules: string[] }, opts: { validateResult: false }): Promise<unknown>;
}

export type Recorder = (entry: { method: string; url: string; status: number; body: string }) => Promise<void>;

export interface YahooProviderOptions {
  fetchImpl: FetchLike;
  store: KvStore;
  clock: Clock;
  rate?: RateConfig;
  rng?: () => number;
  budgetMs?: number;
  client?: YahooClientLike;
  onEvent?: (event: string, data: Record<string, unknown>) => void;
  /** Dev switch: when set, every response is also passed to the recorder (see fixtures.ts). Never enabled in production. */
  recorder?: Recorder;
}

export type YahooProvider = MarketDataProvider & { stats(): ThrottleStats & { schemaDrift: number } };

function stripCrumb(url: string): string {
  return url.replace(/([?&])crumb=[^&]*/, "$1crumb=REDACTED");
}

export function createYahooProvider(o: YahooProviderOptions): YahooProvider {
  const emit = o.onEvent ?? (() => undefined);
  let drift = 0;
  const noteDrift = (where: string) => {
    drift += 1;
    emit("yahoo_schema_drift", { where });
  };

  const recordingFetch: FetchLike =
    o.recorder === undefined
      ? o.fetchImpl
      : async (input, init) => {
          const res = await o.fetchImpl(input, init);
          const body = await res.clone().text();
          const url = stripCrumb(input instanceof Request ? input.url : String(input));
          await o.recorder?.({ method: init?.method ?? "GET", url, status: res.status, body });
          return res;
        };

  const throttle = createThrottle({
    fetchImpl: recordingFetch,
    clock: o.clock,
    breaker: createKvBreakerStore(o.store),
    ...(o.rate === undefined ? {} : { rate: o.rate }),
    ...(o.rng === undefined ? {} : { rng: o.rng }),
    ...(o.budgetMs === undefined ? {} : { budgetMs: o.budgetMs }),
    onEvent: emit,
  });

  let clientPromise: Promise<YahooClientLike> | undefined;
  const getClient = (): Promise<YahooClientLike> => {
    if (o.client !== undefined) return Promise.resolve(o.client);
    clientPromise ??= import("npm:yahoo-finance2@4.0.3").then((mod) => {
      const YahooFinance = mod.default as unknown as new (opts: Record<string, unknown>) => unknown;
      return new YahooFinance({
        suppressNotices: ["yahooSurvey"],
        fetch: throttle.fetch, // crumb, cookie and data requests all pass through our pacing, retry and breaker
        validation: { logErrors: false },
      }) as YahooClientLike;
    });
    return clientPromise;
  };
  const NO_VALIDATION = { validateResult: false } as const;

  async function screenRaw(body: unknown, crumbRetry: boolean): Promise<Rec> {
    const session = await getSession(o.store, throttle.fetch, o.clock, !crumbRetry);
    const url = `https://query1.finance.yahoo.com/v1/finance/screener?crumb=${encodeURIComponent(session.crumb)}&lang=en-US&region=US&formatted=false`;
    const res = await throttle.fetch(url, {
      method: "POST",
      headers: { "User-Agent": BROWSER_UA, Cookie: session.cookie, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.status === 401 && crumbRetry) {
      await res.body?.cancel();
      return screenRaw(body, false); // discard the session, reacquire once
    }
    if (!res.ok) {
      await res.body?.cancel();
      throw new YahooHttpError(res.status, `screener_http_${res.status}`);
    }
    const json: unknown = await res.json();
    const finance = isRec(json) && isRec(json["finance"]) ? json["finance"] : null;
    if (finance === null) throw new YahooSchemaError("screener_shape");
    if (finance["error"] !== null && finance["error"] !== undefined) throw new YahooHttpError(200, "screener_error");
    const result = Array.isArray(finance["result"]) ? finance["result"][0] : undefined;
    if (!isRec(result) || !Array.isArray(result["quotes"])) throw new YahooSchemaError("screener_result_shape");
    return result;
  }

  return {
    id: "yahoo",

    async search(q, opts) {
      const client = await getClient();
      const raw = await client.search(q, { quotesCount: opts?.quotesCount ?? 15, newsCount: opts?.newsCount ?? 0 }, NO_VALIDATION);
      return mapSearch(raw);
    },

    async quote(symbols, opts) {
      const unique = [...new Set(symbols)];
      if (unique.length === 0) return [];
      const client = await getClient();
      const fields = opts?.fields ?? [...QUOTE_FIELDS];
      const out: QuoteRecord[] = [];
      for (const part of chunk(unique, QUOTE_CHUNK)) {
        const raw = await client.quote(part, { fields }, NO_VALIDATION);
        const rows = Array.isArray(raw) ? raw : [];
        for (const row of rows) {
          const mapped = mapQuote(row);
          if (mapped === null) noteDrift("quote.identity_field_missing");
          else out.push(mapped);
        }
      }
      return out; // unknown symbols are simply absent
    },

    async chart(symbol, req: ChartRequest) {
      const client = await getClient();
      const query: Record<string, unknown> = { period1: req.period1, interval: req.interval, events: req.events };
      if (req.period2 !== undefined) query["period2"] = req.period2;
      return mapChart(await client.chart(symbol, query, NO_VALIDATION));
    },

    async profile(symbol) {
      const client = await getClient();
      return mapProfile(symbol, await client.quoteSummary(symbol, { modules: ["assetProfile", "quoteType", "price"] }, NO_VALIDATION));
    },

    async news(symbol, count) {
      const client = await getClient();
      const raw = await client.search(symbol, { quotesCount: 0, newsCount: Math.min(50, count) }, NO_VALIDATION);
      return mapSearch(raw).news;
    },

    async screen(req): Promise<ScreenerPage> {
      if (req.size < 1 || req.size > SCREENER_MAX_SIZE) throw new RangeError(`screener size must be 1..${SCREENER_MAX_SIZE}`);
      const body = {
        size: req.size,
        offset: req.offset,
        sortField: "intradaymarketcap",
        sortType: "DESC",
        quoteType: "EQUITY",
        query: {
          operator: "and",
          operands: [
            { operator: "gt", operands: ["intradaymarketcap", req.minMarketCapLocal] },
            { operator: "eq", operands: ["exchange", req.exchange] },
          ],
        },
        userId: "",
        userIdType: "guid",
      };
      const result = await screenRaw(body, true);
      const rows: QuoteRecord[] = [];
      for (const q of result["quotes"] as unknown[]) {
        const mapped = mapQuote(q);
        if (mapped === null) noteDrift("screener.identity_field_missing");
        else rows.push(mapped);
      }
      return {
        total: num(result["total"]) ?? rows.length,
        offset: num(result["start"]) ?? req.offset,
        count: num(result["count"]) ?? rows.length,
        rows,
      };
    },

    stats() {
      return { ...throttle.stats(), schemaDrift: drift };
    },
  };
}

/**
 * Walks one exchange's screener pages (size 250). Stops at offset >= total, on an empty page, or after maxPages;
 * in the last case nextOffset says where a follow-up job continues.
 */
export async function collectScreenerPages(
  provider: Pick<MarketDataProvider, "screen">,
  req: { exchange: string; minMarketCapLocal: number; startOffset?: number; size?: number; maxPages: number },
): Promise<{ rows: QuoteRecord[]; pages: number; total: number; nextOffset: number | null }> {
  const size = req.size ?? SCREENER_MAX_SIZE;
  let offset = req.startOffset ?? 0;
  const rows: QuoteRecord[] = [];
  let pages = 0;
  let total = 0;
  while (pages < req.maxPages) {
    const page = await provider.screen({ exchange: req.exchange, minMarketCapLocal: req.minMarketCapLocal, offset, size });
    pages += 1;
    total = page.total;
    rows.push(...page.rows);
    offset += size;
    if (page.count === 0 || offset >= page.total) return { rows, pages, total, nextOffset: null };
  }
  return { rows, pages, total, nextOffset: offset };
}
```

- [ ] **Step 6: Implement (3/3)**

**`supabase/functions/_shared/adapters/fixtures.ts`**

```ts
import type { Recorder } from "./yahoo.ts";
import type { FetchLike } from "./throttle.ts";

/** Helpers for offline tests and for recording new fixtures in development. Nothing here touches the network. */

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

export interface FixtureRoute {
  match(url: URL, init?: RequestInit): boolean;
  respond(url: URL, init?: RequestInit): Response | Promise<Response>;
}

/** A fetch that answers from a route table and throws on anything unmatched, so a test can never reach the network. */
export function routeFetch(routes: FixtureRoute[]): FetchLike & { calls: Array<{ method: string; url: string }> } {
  const calls: Array<{ method: string; url: string }> = [];
  const impl: FetchLike = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    calls.push({ method: init?.method ?? "GET", url: url.toString() });
    const route = routes.find((r) => r.match(url, init));
    if (route === undefined) throw new Error(`fixtureFetch: no route for ${init?.method ?? "GET"} ${url.origin}${url.pathname}`);
    return await route.respond(url, init);
  };
  return Object.assign(impl, { calls });
}

/** Reads fixtures/<relative> next to this module (recorded Yahoo samples live in fixtures/yahoo). */
export async function readFixture<T = unknown>(relative: string): Promise<T> {
  const text = await Deno.readTextFile(new URL(`./fixtures/${relative}`, import.meta.url));
  return JSON.parse(text) as T;
}

/**
 * Development recorder: writes one file per response to fixtures/yahoo/recorded/. The crumb is already stripped from the URL by the
 * provider and cookies are never part of an entry. Requires --allow-write on that directory; never enabled in production.
 */
export function diskRecorder(dir = new URL("./fixtures/yahoo/recorded/", import.meta.url)): Recorder {
  return async (entry) => {
    const u = new URL(entry.url);
    const slug = `${entry.method}_${u.host}${u.pathname}`.replace(/[^A-Za-z0-9._-]+/g, "_");
    const hash = Array.from(new TextEncoder().encode(entry.url + entry.body.length))
      .reduce((h, b) => (h * 31 + b) >>> 0, 7)
      .toString(16);
    await Deno.mkdir(dir, { recursive: true });
    await Deno.writeTextFile(new URL(`${slug}_${hash}.json`, dir), entry.body);
  };
}
```

- [ ] **Step 7: (Optional, needs network) live smoke test through the throttle**

```bash
YF_LIVE=1 deno test -A --config supabase/functions/deno.json supabase/functions/_shared/adapters/yahoo.live.test.ts
```

Expected: `requests 8 retries 0 429s 0 drift 0` and `ok | 1 passed` (about 3 s). Verified on 2026-10-15.

- [ ] **Step 8: Run; Expected: PASS** `deno test --allow-env --allow-net=127.0.0.1,localhost --config supabase/functions/deno.json --allow-read=supabase/functions/_shared/adapters/fixtures supabase/functions/_shared/adapters/yahoo.test.ts` (27 tests; the live test is ignored unless `YF_LIVE=1`).

- [ ] **Step 9: Commit**

```bash
git add supabase/functions/_shared/adapters/yahoo.ts supabase/functions/_shared/adapters/session.ts supabase/functions/_shared/adapters/fixtures.ts supabase/functions/_shared/adapters/yahoo.test.ts supabase/functions/_shared/adapters/yahoo.live.test.ts supabase/functions/_shared/adapters/fixtures/yahoo tools/build-yahoo-fixtures.ts
git commit -m "feat(adapters): Yahoo provider with raw screener session and recorded fixtures"
```

---
### Task 10: fx.ts

**Parallelism:** needs only the Task 8 types; can run concurrently with Tasks 9, 11 and Group C.

**Files:**
- Create: `supabase/functions/_shared/adapters/fx.ts`
- Test: `supabase/functions/_shared/adapters/fx.test.ts`

**Interfaces:**
- Consumes: `FxProvider`, `FxQuote`, `QuoteRecord` (Task 8), `core/units.ts`
- Produces: `createFxProvider({ fetchImpl, clock, quote?, crossCheck?, onEvent? })` implementing `FxProvider`, `fxRowFor(ccy, fx)`, `FRANKFURTER_URL`

- [ ] **Step 1: Write the failing test**

**`supabase/functions/_shared/adapters/fx.test.ts`**

```ts
import { assert, assertEquals } from "@std/assert";
import { createFakeClock } from "./clock.ts";
import { createFxProvider, fxRowFor } from "./fx.ts";
import { jsonResponse, routeFetch } from "./fixtures.ts";
import type { QuoteRecord } from "./providers.ts";

// Recorded from https://api.frankfurter.dev/v1/latest?base=USD on 2026-10-15 (units of currency per USD)
const RECORDED = {
  amount: 1.0,
  base: "USD",
  date: "2026-10-14",
  rates: { AUD: 1.4266, BRL: 5.0242, CAD: 1.4219, CHF: 0.83341, CNY: 6.6927, EUR: 0.89326, GBP: 0.75377, HKD: 7.8481, ILS: 3.0766, INR: 95.16, JPY: 158.45, KRW: 1336.79, SEK: 9.9669, SGD: 1.2826, ZAR: 16.47 },
};

function frankfurterRoute(handler: (symbols: string[]) => Response | Promise<Response>) {
  return {
    match: (u: URL) => u.host === "api.frankfurter.dev" && u.pathname === "/v1/latest",
    respond: (u: URL) => {
      assertEquals(u.searchParams.get("base"), "USD");
      return handler((u.searchParams.get("symbols") ?? "").split(","));
    },
  };
}

/** Behaves like the live API: unsupported symbols are omitted; all unsupported -> 404. */
const realistic = (symbols: string[]) => {
  const rates = Object.fromEntries(symbols.filter((s) => s in RECORDED.rates).map((s) => [s, (RECORDED.rates as Record<string, number>)[s]]));
  return Object.keys(rates).length === 0 ? jsonResponse({ message: "not found" }, 404) : jsonResponse({ ...RECORDED, rates });
};

const yahooQuote = (symbol: string, price: number, timeIso = "2026-10-15T07:00:00Z"): QuoteRecord => ({
  symbol, quoteType: "CURRENCY", currency: "USD", financialCurrency: null, exchange: "CCY", fullExchangeName: "CCY", longName: null, shortName: null,
  marketCap: null, sharesOutstanding: null, regularMarketPrice: price, regularMarketTime: Date.parse(timeIso), regularMarketPreviousClose: null,
  regularMarketChangePercent: null, marketState: "REGULAR", firstTradeDateMs: null, exchangeTimezoneName: null, priceHint: 4,
});

Deno.test("Frankfurter: units per USD are inverted, USD is the identity, GBp is normalised to GBP, duplicates are removed", async () => {
  const fetchImpl = routeFetch([frankfurterRoute(realistic)]);
  const fx = createFxProvider({ fetchImpl, clock: createFakeClock() });
  const res = await fx.usdPerUnit(["EUR", "JPY", "GBP", "GBp", "USD", "EUR"]);
  assertEquals(res.missing, []);
  assertEquals(res.rates.map((r) => r.ccy), ["EUR", "GBP", "JPY", "USD"]);
  const eur = res.rates.find((r) => r.ccy === "EUR")!;
  assert(Math.abs(eur.usdPerUnit - 1 / 0.89326) < 1e-12);
  assertEquals([eur.rateDate, eur.source, eur.sourceSymbol], ["2026-10-14", "frankfurter", null]);
  assertEquals(res.rates.find((r) => r.ccy === "USD")?.usdPerUnit, 1);
  const url = new URL(fetchImpl.calls[0]!.url);
  assertEquals(url.searchParams.get("symbols"), "EUR,GBP,JPY"); // sorted, no USD
});

Deno.test("fallback: SAR and TWD (not covered by Frankfurter) come from Yahoo XXXUSD=X, with the UTC date of the quote", async () => {
  const fetchImpl = routeFetch([frankfurterRoute(realistic)]);
  const asked: string[][] = [];
  const fx = createFxProvider({
    fetchImpl,
    clock: createFakeClock(),
    quote: (symbols) => {
      asked.push(symbols);
      return Promise.resolve([yahooQuote("SARUSD=X", 0.266418), yahooQuote("TWDUSD=X", 0.030871822, "2026-10-14T21:59:00Z"), yahooQuote("EURUSD=X", 1.1216)]);
    },
  });
  const res = await fx.usdPerUnit(["EUR", "SAR", "TWD"]);
  assertEquals(res.missing, []);
  assertEquals(asked, [["SARUSD=X", "TWDUSD=X", "EURUSD=X"]]); // one Yahoo call: the fallbacks plus the EUR cross-check
  const sar = res.rates.find((r) => r.ccy === "SAR")!;
  assertEquals([sar.usdPerUnit, sar.source, sar.sourceSymbol, sar.rateDate], [0.266418, "yahoo", "SARUSD=X", "2026-10-15"]);
  assertEquals(res.rates.find((r) => r.ccy === "TWD")?.rateDate, "2026-10-14");
  assertEquals(res.rates.find((r) => r.ccy === "EUR")?.source, "frankfurter");
});

Deno.test("all requested symbols unsupported: Frankfurter answers 404 and everything falls back to Yahoo", async () => {
  const fx = createFxProvider({
    fetchImpl: routeFetch([frankfurterRoute(realistic)]),
    clock: createFakeClock(),
    quote: () => Promise.resolve([yahooQuote("KWDUSD=X", 3.2456996), yahooQuote("AEDUSD=X", 0.27229407), yahooQuote("QARUSD=X", 0.2749141)]),
  });
  const res = await fx.usdPerUnit(["KWD", "AED", "QAR"]);
  assertEquals(res.rates.map((r) => [r.ccy, r.source]), [["AED", "yahoo"], ["KWD", "yahoo"], ["QAR", "yahoo"]]);
  assertEquals(res.missing, []);
});

Deno.test("a currency known to neither source is reported missing", async () => {
  const fx = createFxProvider({
    fetchImpl: routeFetch([frankfurterRoute(realistic)]),
    clock: createFakeClock(),
    quote: () => Promise.resolve([yahooQuote("SARUSD=X", 0.266418)]),
  });
  const res = await fx.usdPerUnit(["SAR", "XXX"]);
  assertEquals(res.missing, ["XXX"]);
  assertEquals(res.rates.map((r) => r.ccy), ["SAR"]);
});

Deno.test("without a Yahoo quote function missing currencies stay missing", async () => {
  const fx = createFxProvider({ fetchImpl: routeFetch([frankfurterRoute(realistic)]), clock: createFakeClock() });
  assertEquals((await fx.usdPerUnit(["EUR", "SAR"])).missing, ["SAR"]);
});

Deno.test("Frankfurter outage (HTTP 500 or network error): everything is fetched from Yahoo and an event is emitted", async () => {
  for (const respond of [() => new Response("boom", { status: 500 }), () => { throw new TypeError("offline"); }]) {
    const events: string[] = [];
    const fx = createFxProvider({
      fetchImpl: routeFetch([frankfurterRoute(respond)]),
      clock: createFakeClock(),
      quote: () => Promise.resolve([yahooQuote("EURUSD=X", 1.1216)]),
      onEvent: (e) => events.push(e),
    });
    const res = await fx.usdPerUnit(["EUR"]);
    assertEquals(res.rates.map((r) => [r.ccy, r.source]), [["EUR", "yahoo"]]);
    assert(events.includes("fx_frankfurter_failed"));
  }
});

Deno.test("sanity: zero, null and absurd rates are rejected", async () => {
  const fx = createFxProvider({
    fetchImpl: routeFetch([frankfurterRoute(() => jsonResponse({ ...RECORDED, rates: { EUR: 0, GBP: null, JPY: 1e-12, CHF: 0.83341 } }))]),
    clock: createFakeClock(),
  });
  const res = await fx.usdPerUnit(["EUR", "GBP", "JPY", "CHF"]);
  assertEquals(res.rates.map((r) => r.ccy), ["CHF"]);
  assertEquals(res.missing, ["EUR", "GBP", "JPY"]);
});

Deno.test("sources disagreeing by more than 2% log fx_source_disagreement and keep Frankfurter", async () => {
  const events: Array<[string, Record<string, unknown>]> = [];
  const fx = createFxProvider({
    fetchImpl: routeFetch([frankfurterRoute(realistic)]),
    clock: createFakeClock(),
    quote: () => Promise.resolve([yahooQuote("EURUSD=X", 1.16)]), // Frankfurter says 1.1195 -> 3.6% apart
    onEvent: (e, d) => events.push([e, d]),
  });
  const res = await fx.usdPerUnit(["EUR"]);
  assertEquals(res.rates[0]?.source, "frankfurter");
  assertEquals(events.map((e) => e[0]), ["fx_source_disagreement"]);
  assertEquals(events[0]![1]["ccy"], "EUR");
});

Deno.test("agreeing sources log nothing", async () => {
  const events: string[] = [];
  const fx = createFxProvider({
    fetchImpl: routeFetch([frankfurterRoute(realistic)]),
    clock: createFakeClock(),
    quote: () => Promise.resolve([yahooQuote("EURUSD=X", 1.1213)]),
    onEvent: (e) => events.push(e),
  });
  await fx.usdPerUnit(["EUR"]);
  assertEquals(events, []);
});

Deno.test("fxRowFor maps an FxQuote to the fx_rates columns", () => {
  assertEquals(fxRowFor("SAR", { ccy: "SAR", usdPerUnit: 0.266418, rateDate: "2026-10-15", source: "yahoo", sourceSymbol: "SARUSD=X" }), {
    ccy: "SAR", usd_per_unit: 0.266418, rate_date: "2026-10-15", source: "yahoo", source_symbol: "SARUSD=X",
  });
});
```

- [ ] **Step 2: Run it: `deno test --config supabase/functions/deno.json --allow-read=supabase/functions/_shared/adapters/fixtures supabase/functions/_shared/adapters/fx.test.ts`; Expected: FAIL (module not found ./fx.ts)**

- [ ] **Step 3: Implement**

**`supabase/functions/_shared/adapters/fx.ts`**

```ts
import { resolveCurrency } from "../core/units.ts";
import type { Clock } from "./clock.ts";
import type { FxProvider, FxQuote, QuoteRecord } from "./providers.ts";
import type { FetchLike } from "./throttle.ts";

/**
 * FX adapter (5.4). Primary: Frankfurter, GET https://api.frankfurter.dev/v1/latest?base=USD&symbols=EUR,JPY,...
 * (verified 2026-10-15: response {amount, base, date, rates}; 30 currencies; unsupported symbols are silently omitted;
 * a request whose symbols are ALL unsupported returns HTTP 404 {"message":"not found"}).
 * The response is units of currency per USD; usdPerUnit = 1 / rate. Fallback: Yahoo "<CCY>USD=X" regularMarketPrice.
 */
export const FRANKFURTER_URL = "https://api.frankfurter.dev/v1/latest";
export const FX_SANE_MAX = 1e6;
export const FX_DISAGREEMENT_TOLERANCE = 0.02;

export interface FxProviderOptions {
  fetchImpl: FetchLike;
  clock: Clock;
  /** Yahoo quote() of the fallback symbols (the yahoo provider's quote). Without it, missing currencies stay missing. */
  quote?: (symbols: string[]) => Promise<QuoteRecord[]>;
  /** Currencies that Frankfurter returned and that are cross-checked against Yahoo (default EUR). */
  crossCheck?: string[];
  onEvent?: (event: string, data: Record<string, unknown>) => void;
}

const sane = (usdPerUnit: number): boolean => Number.isFinite(usdPerUnit) && usdPerUnit > 0 && usdPerUnit < FX_SANE_MAX;
const utcDate = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

export function fxRowFor(
  ccy: string,
  fx: FxQuote,
): { ccy: string; usd_per_unit: number; rate_date: string; source: string; source_symbol: string | null } {
  return { ccy, usd_per_unit: fx.usdPerUnit, rate_date: fx.rateDate, source: fx.source, source_symbol: fx.sourceSymbol };
}

export function createFxProvider(o: FxProviderOptions): FxProvider {
  const emit = o.onEvent ?? (() => undefined);
  const crossCheck = o.crossCheck ?? ["EUR"];

  async function frankfurter(ccys: string[]): Promise<{ date: string | null; usd: Map<string, number> }> {
    const usd = new Map<string, number>();
    if (ccys.length === 0) return { date: null, usd };
    let res: Response;
    try {
      res = await o.fetchImpl(`${FRANKFURTER_URL}?base=USD&symbols=${ccys.join(",")}`, { headers: { Accept: "application/json" } });
    } catch (e) {
      emit("fx_frankfurter_failed", { reason: e instanceof Error ? e.message : "network" });
      return { date: null, usd };
    }
    if (res.status === 404) {
      await res.body?.cancel();
      return { date: null, usd }; // every requested symbol is unsupported
    }
    if (!res.ok) {
      await res.body?.cancel();
      emit("fx_frankfurter_failed", { status: res.status });
      return { date: null, usd };
    }
    const body = (await res.json()) as { date?: unknown; rates?: Record<string, unknown> };
    const date = typeof body.date === "string" ? body.date : null;
    for (const [ccy, rate] of Object.entries(body.rates ?? {})) {
      if (typeof rate !== "number" || !(rate > 0)) continue;
      const perUnit = 1 / rate;
      if (sane(perUnit)) usd.set(ccy, perUnit);
    }
    return { date, usd };
  }

  return {
    id: "frankfurter+yahoo",

    async usdPerUnit(ccys) {
      const wanted = [...new Set(ccys.map((c) => resolveCurrency(c).major))].sort();
      const rates: FxQuote[] = [];
      const needsRate = wanted.filter((c) => c !== "USD");

      const { date, usd } = await frankfurter(needsRate);
      const today = utcDate(o.clock.now());
      if (wanted.includes("USD")) rates.push({ ccy: "USD", usdPerUnit: 1, rateDate: date ?? today, source: "frankfurter", sourceSymbol: null });
      for (const ccy of needsRate) {
        const v = usd.get(ccy);
        if (v !== undefined && date !== null) rates.push({ ccy, usdPerUnit: v, rateDate: date, source: "frankfurter", sourceSymbol: null });
      }

      const missingAfterFrankfurter = needsRate.filter((c) => !rates.some((r) => r.ccy === c));
      const checks = o.quote === undefined ? [] : crossCheck.filter((c) => rates.some((r) => r.ccy === c && r.source === "frankfurter"));
      const symbols = [...new Set([...missingAfterFrankfurter, ...checks].map((c) => `${c}USD=X`))];
      const yahoo = new Map<string, QuoteRecord>();
      if (o.quote !== undefined && symbols.length > 0) {
        try {
          for (const q of await o.quote(symbols)) yahoo.set(q.symbol, q);
        } catch (e) {
          emit("fx_yahoo_failed", { reason: e instanceof Error ? e.message : "error" });
        }
      }

      const missing: string[] = [];
      for (const ccy of missingAfterFrankfurter) {
        const q = yahoo.get(`${ccy}USD=X`);
        const price = q?.regularMarketPrice ?? null;
        if (q !== undefined && price !== null && sane(price)) {
          rates.push({
            ccy,
            usdPerUnit: price,
            rateDate: q.regularMarketTime !== null ? utcDate(q.regularMarketTime) : today,
            source: "yahoo",
            sourceSymbol: q.symbol,
          });
        } else {
          missing.push(ccy);
        }
      }

      for (const ccy of checks) {
        const f = rates.find((r) => r.ccy === ccy && r.source === "frankfurter");
        const y = yahoo.get(`${ccy}USD=X`)?.regularMarketPrice ?? null;
        if (f !== undefined && y !== null && sane(y)) {
          const rel = Math.abs(f.usdPerUnit - y) / f.usdPerUnit;
          if (rel > FX_DISAGREEMENT_TOLERANCE) emit("fx_source_disagreement", { ccy, frankfurter: f.usdPerUnit, yahoo: y, relDiff: rel });
        }
      }

      rates.sort((a, b) => (a.ccy < b.ccy ? -1 : a.ccy > b.ccy ? 1 : 0));
      return { rates, missing };
    },
  };
}
```

- [ ] **Step 4: Run; Expected: PASS** `deno test --config supabase/functions/deno.json --allow-read=supabase/functions/_shared/adapters/fixtures supabase/functions/_shared/adapters/fx.test.ts` (10 tests: recorded Frankfurter response, SAR/TWD Yahoo fallback, all-unsupported 404, outage, sanity, 2% disagreement event).

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/adapters/fx.ts supabase/functions/_shared/adapters/fx.test.ts
git commit -m "feat(adapters): Frankfurter FX with Yahoo fallback"
```

---
### Task 11: db.ts, log.ts, settings.ts (and P0 adapter contract)

**Parallelism:** can run concurrently with Tasks 8, 9, 10 and Group C; needs `core/indicator.ts` (Task 3) for `settings.ts`.

**Files:**
- Create: `supabase/functions/_shared/adapters/log.ts`, `supabase/functions/_shared/adapters/settings.ts`, `supabase/functions/_shared/adapters/db.ts`
- Test: `supabase/functions/_shared/adapters/log.test.ts`, `supabase/functions/_shared/adapters/settings.test.ts`, `supabase/functions/_shared/adapters/db.integration.test.ts` (opt-in, local stack)

**Interfaces:**
- Consumes: P0: `adapters/env.ts` (`requireEnv(name)`), `adapters/http.ts` (`json(data, init)`, `corsHeaders(origin)`, `requireCronSecret(req, secret): Promise<Response | null>`, `readJson(req)`); Task 3 (`validateSettings`, `DEFAULT_SETTINGS`); Task 8 (`KvStore`)
- Produces: `redact`, `redactString`, `scanEvent(sink, run, event, data?, extra?)`, `EventSink`, `JobStage`, `ScanEventRow`; `AppSettings`, `mergeSettings`, `loadSettings`, `SettingsError`, `DEFAULT_PIPELINE`, `DEFAULT_UNIVERSE`; `Db` (`sb`, `claimJobs`, `completeJob`, `failJob`, `deferJob`, `heartbeatJob`, `refreshScanStatus`, `seedStage`, `nextStageToSeed`, `startDailyScan`, `purgeExpired`, `recordEvent`), `createDb`, `createServiceClient` (`auth: { persistSession: false }`), `createServiceDb`, `createQuoteCacheKv`

- [ ] **Step 1: Write the failing tests**

**`supabase/functions/_shared/adapters/log.test.ts`**

```ts
import { assertEquals } from "@std/assert";
import { REDACTED, redact, redactString, scanEvent, type ScanEventRow } from "./log.ts";

Deno.test("redact replaces values of keys matching token|secret|key|email|authorization (case-insensitive, any depth)", () => {
  const input = {
    ok: 1,
    apiKey: "abc",
    Authorization: "Bearer xyz",
    nested: { userEmail: "a@b.c", cron_secret: "s", fine: "value", list: [{ accessToken: "t" }, { name: "n" }] },
    SUPABASE_SERVICE_ROLE_KEY: "k",
    tokenCount: 3,
  };
  assertEquals(redact(input), {
    ok: 1,
    apiKey: REDACTED,
    Authorization: REDACTED,
    nested: { userEmail: REDACTED, cron_secret: REDACTED, fine: "value", list: [{ accessToken: REDACTED }, { name: "n" }] },
    SUPABASE_SERVICE_ROLE_KEY: REDACTED,
    tokenCount: REDACTED, // the key pattern is deliberately broad: a false positive is harmless, a leak is not
  });
});

Deno.test("redact does not mutate its input", () => {
  const input = { secretThing: "s", inner: { key: "k" } };
  redact(input);
  assertEquals(input, { secretThing: "s", inner: { key: "k" } });
});

Deno.test("redact masks credentials inside URL-like strings and truncates very long strings", () => {
  assertEquals(
    redactString("https://query1.finance.yahoo.com/v1/finance/screener?crumb=AbC123&lang=en-US"),
    "https://query1.finance.yahoo.com/v1/finance/screener?crumb=[redacted]&lang=en-US",
  );
  assertEquals(redactString("x".repeat(5000)).length, 2000 + "...[truncated]".length);
});

Deno.test("redact survives cycles and dates", () => {
  const a: Record<string, unknown> = { name: "a" };
  a["self"] = a;
  const out = redact({ a, at: new Date(Date.UTC(2026, 9, 15)) }) as { a: { name: string }; at: string };
  assertEquals(out.a.name, "a");
  assertEquals(out.at, "2026-10-15T00:00:00.000Z");
});

Deno.test("scanEvent records a redacted row with run, job and stage context", async () => {
  const rows: ScanEventRow[] = [];
  await scanEvent(
    { recordEvent: (e) => (rows.push(e), Promise.resolve()) },
    { runId: "run-1", jobId: 42, stage: "fetch_bars" },
    "security_failed",
    { symbol: "SAP.DE", reason: "no_bars", apiKey: "SECRET", url: "https://x.test/?token=SECRET" },
    { level: "warn", securityId: "sec-1", message: "failed at https://x.test/?crumb=SECRET" },
  );
  assertEquals(rows.length, 1);
  const row = rows[0]!;
  assertEquals([row.runId, row.jobId, row.stage, row.level, row.event, row.securityId], ["run-1", 42, "fetch_bars", "warn", "security_failed", "sec-1"]);
  assertEquals(row.data, { symbol: "SAP.DE", reason: "no_bars", apiKey: REDACTED, url: "https://x.test/?token=[redacted]" });
  assertEquals(row.message, "failed at https://x.test/?crumb=[redacted]");
  assertEquals(JSON.stringify(row).includes("SECRET"), false);
});

Deno.test("scanEvent defaults: level info, null context and null data", async () => {
  const rows: ScanEventRow[] = [];
  await scanEvent({ recordEvent: (e) => (rows.push(e), Promise.resolve()) }, { runId: null }, "scan_started");
  assertEquals(rows[0], { runId: null, jobId: null, stage: null, level: "info", event: "scan_started", securityId: null, message: null, data: null });
});
```

**`supabase/functions/_shared/adapters/settings.test.ts`**

```ts
import { assertEquals, assertThrows } from "@std/assert";
import { DEFAULT_SETTINGS } from "../core/indicator.ts";
import { DEFAULT_PIPELINE, DEFAULT_UNIVERSE, SettingsError, loadSettings, mergeSettings } from "./settings.ts";

Deno.test("no rows: every setting is the documented default", () => {
  const { settings, warnings } = mergeSettings([]);
  assertEquals(settings.indicator, DEFAULT_SETTINGS);
  assertEquals(settings.universe, { thresholdUsd: 50e9, safetyMargin: 0.7, minHistoryYears: 10 });
  assertEquals(settings.pipeline.batch, { fetchBars: 12, compute: 25, quoteBatch: 500, profile: 25, volumeProbe: 12 });
  assertEquals(settings.pipeline.stageCaps, { fx: 1, universe_sweep: 1, identity: 1, fetch_bars: 1, compute: 2, rank_signals: 1, classify: 1, publish: 1 });
  assertEquals([settings.pipeline.maxStoredBars, settings.pipeline.leaseSeconds, settings.pipeline.stopClaimingMs, settings.pipeline.hardDeadlineMs], [3300, 180, 85_000, 120_000]);
  assertEquals(settings.pipeline.yahoo, { minSpacingMs: 340, jitterMs: 100 });
  assertEquals(warnings, []);
});

Deno.test("valid rows override the defaults (snake_case keys in the table, camelCase in code)", () => {
  const { settings } = mergeSettings([
    { key: "indicator", value: { ...DEFAULT_SETTINGS, length: 2000 } },
    { key: "universe", value: { threshold_usd: 40e9, safety_margin: 0.6, min_history_years: 8 } },
    { key: "pipeline", value: { batch_sizes: { fetch_bars: 6 }, stage_caps: { compute: 3 }, max_stored_bars: 3000 } },
  ]);
  assertEquals(settings.indicator.length, 2000);
  assertEquals(settings.universe, { thresholdUsd: 40e9, safetyMargin: 0.6, minHistoryYears: 8 });
  assertEquals(settings.pipeline.batch.fetchBars, 6);
  assertEquals(settings.pipeline.batch.compute, 25);
  assertEquals(settings.pipeline.stageCaps["compute"], 3);
  assertEquals(settings.pipeline.maxStoredBars, 3000);
});

Deno.test("an invalid universe or pipeline value keeps the default and warns; the pipeline never runs faster than 3 requests per second", () => {
  const { settings, warnings } = mergeSettings([
    { key: "universe", value: { threshold_usd: "lots", safety_margin: 1.5 } },
    { key: "pipeline", value: { batch_sizes: { fetch_bars: 0, compute: 1000 }, yahoo: { min_spacing_ms: 100 } } },
  ]);
  assertEquals(settings.universe.thresholdUsd, DEFAULT_UNIVERSE.thresholdUsd);
  assertEquals(settings.universe.safetyMargin, DEFAULT_UNIVERSE.safetyMargin);
  assertEquals(settings.pipeline.batch.fetchBars, DEFAULT_PIPELINE.batch.fetchBars);
  assertEquals(settings.pipeline.batch.compute, DEFAULT_PIPELINE.batch.compute);
  assertEquals(settings.pipeline.yahoo.minSpacingMs, 340);
  assertEquals(warnings.length, 5);
});

Deno.test("an invalid indicator row throws: a scan never runs on guessed settings", () => {
  assertThrows(() => mergeSettings([{ key: "indicator", value: { ...DEFAULT_SETTINGS, length: 2 } }]), SettingsError, "invalid_indicator_settings");
  assertThrows(() => mergeSettings([{ key: "indicator", value: "nope" }]), SettingsError);
});

Deno.test("indicator warnings (length below 30) are surfaced", () => {
  const { warnings } = mergeSettings([{ key: "indicator", value: { ...DEFAULT_SETTINGS, length: 10 } }]);
  assertEquals(warnings, ["indicator.length: length_below_30"]);
});

Deno.test("unknown keys and non-object rows are ignored", () => {
  const { settings } = mergeSettings([
    { key: "research", value: { anything: 1 } },
    { key: "universe", value: [1, 2, 3] },
  ]);
  assertEquals(settings.universe, { thresholdUsd: 50e9, safetyMargin: 0.7, minHistoryYears: 10 });
});

Deno.test("loadSettings reads through the source", async () => {
  const { settings } = await loadSettings({ fetchRows: () => Promise.resolve([{ key: "universe", value: { threshold_usd: 60e9 } }]) });
  assertEquals(settings.universe.thresholdUsd, 60e9);
});
```

- [ ] **Step 2: Run it: `deno test -A --config supabase/functions/deno.json supabase/functions/_shared/adapters/log.test.ts supabase/functions/_shared/adapters/settings.test.ts`; Expected: FAIL (module not found ./log.ts)**

- [ ] **Step 3: Implement (1/3)**

**`supabase/functions/_shared/adapters/log.ts`**

```ts
/**
 * Structured, redacted events for scan_events (7.9, 15.6). No secrets, tokens, e-mail addresses or portfolio contents may reach the table:
 * keys matching /token|secret|key|email|authorization/i are replaced, and credentials in URL-like strings are masked.
 */
export type EventLevel = "debug" | "info" | "warn" | "error";
export type JobStage =
  | "fx" | "universe_sweep" | "identity" | "volume_probe" | "fetch_bars" | "compute" | "rank_signals" | "portfolio_scan"
  | "news" | "research" | "classify" | "publish" | "digest" | "eur_catalogue" | "eur_resolve";

export interface ScanEventRow {
  runId: string | null;
  jobId: number | null;
  stage: JobStage | null;
  level: EventLevel;
  event: string;
  securityId: string | null;
  message: string | null;
  data: Record<string, unknown> | null;
}

export interface EventSink {
  recordEvent(e: ScanEventRow): Promise<void>;
}

export interface RunRef {
  runId: string | null;
  jobId?: number | null;
  stage?: JobStage | null;
}

export const REDACT_KEY = /token|secret|key|email|authorization/i;
export const REDACTED = "[redacted]";
const MAX_DEPTH = 6;
const MAX_STRING = 2000;
const URL_CREDENTIAL = /([?&](?:crumb|key|token|apikey|api_key|access_token|secret)=)[^&\s"']+/gi;

export function redactString(s: string): string {
  const masked = s.replace(URL_CREDENTIAL, `$1${REDACTED}`);
  return masked.length > MAX_STRING ? `${masked.slice(0, MAX_STRING)}...[truncated]` : masked;
}

/** Deep copy with sensitive keys replaced. Never mutates its input; deep or cyclic structures are cut at depth 6. */
export function redact(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return redactString(value);
  if (value === null || typeof value !== "object") return value;
  if (depth >= MAX_DEPTH) return "[depth]";
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = REDACT_KEY.test(k) ? REDACTED : redact(v, depth + 1);
  }
  return out;
}

export async function scanEvent(
  sink: EventSink,
  run: RunRef,
  event: string,
  data?: Record<string, unknown>,
  extra: { level?: EventLevel; securityId?: string | null; message?: string | null } = {},
): Promise<void> {
  await sink.recordEvent({
    runId: run.runId,
    jobId: run.jobId ?? null,
    stage: run.stage ?? null,
    level: extra.level ?? "info",
    event,
    securityId: extra.securityId ?? null,
    message: extra.message === undefined || extra.message === null ? null : redactString(extra.message).slice(0, 500),
    data: data === undefined ? null : (redact(data) as Record<string, unknown>),
  });
}
```

- [ ] **Step 4: Implement (2/3)**

**`supabase/functions/_shared/adapters/settings.ts`**

```ts
import { DEFAULT_SETTINGS, validateSettings, type IndicatorSettings } from "../core/indicator.ts";

/** app_settings keys read by the pipeline: `indicator`, `universe`, `pipeline` (6.3, 7.4). Missing keys fall back to the defaults. */

export interface UniverseSettings {
  thresholdUsd: number; // 50e9, inclusive
  safetyMargin: number; // 0.7: local screener threshold = thresholdUsd * safetyMargin / strongest currency
  minHistoryYears: number; // 10
}
export interface PipelineSettings {
  stageCaps: Record<string, number>; // concurrent leased jobs per stage (7.4)
  batch: { fetchBars: number; compute: number; quoteBatch: number; profile: number; volumeProbe: number };
  maxStoredBars: number; // 3,300 (A-08)
  leaseSeconds: number; // 180
  claimLimit: number; // jobs claimed per loop iteration
  stopClaimingMs: number; // 85,000
  hardDeadlineMs: number; // 120,000
  listPublishMinCoverage: number; // 0.95 (A-15)
  carryForwardMaxScans: number; // 3 (A-02)
  maxScreenerPagesPerJob: number; // 10
  yahoo: { minSpacingMs: number; jitterMs: number };
}
export interface AppSettings {
  indicator: IndicatorSettings;
  universe: UniverseSettings;
  pipeline: PipelineSettings;
}

export const DEFAULT_UNIVERSE: Readonly<UniverseSettings> = Object.freeze({ thresholdUsd: 50e9, safetyMargin: 0.7, minHistoryYears: 10 });
export const DEFAULT_PIPELINE: Readonly<PipelineSettings> = Object.freeze({
  stageCaps: Object.freeze({ fx: 1, universe_sweep: 1, identity: 1, fetch_bars: 1, compute: 2, rank_signals: 1, classify: 1, publish: 1 }) as Record<string, number>,
  batch: Object.freeze({ fetchBars: 12, compute: 25, quoteBatch: 500, profile: 25, volumeProbe: 12 }),
  maxStoredBars: 3300,
  leaseSeconds: 180,
  claimLimit: 3,
  stopClaimingMs: 85_000,
  hardDeadlineMs: 120_000,
  listPublishMinCoverage: 0.95,
  carryForwardMaxScans: 3,
  maxScreenerPagesPerJob: 10,
  yahoo: Object.freeze({ minSpacingMs: 340, jitterMs: 100 }),
});

export class SettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SettingsError";
  }
}

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);

/** A finite number within (min, max]; anything else keeps the default and records a warning. */
function pick(src: Rec | undefined, key: string, fallback: number, warnings: string[], where: string, opts: { min?: number; max?: number; integer?: boolean } = {}): number {
  if (src === undefined || src[key] === undefined) return fallback;
  const v = src[key];
  const okType = typeof v === "number" && Number.isFinite(v);
  const min = opts.min ?? 0;
  const max = opts.max ?? Number.POSITIVE_INFINITY;
  if (!okType || (v as number) <= min || (v as number) > max || (opts.integer === true && !Number.isInteger(v))) {
    warnings.push(`${where}.${key} invalid, default ${fallback} kept`);
    return fallback;
  }
  return v as number;
}

/** Pure: merges app_settings rows over the defaults. An invalid `indicator` row throws (a scan must never run on guessed settings). */
export function mergeSettings(rows: ReadonlyArray<{ key: string; value: unknown }>): { settings: AppSettings; warnings: string[] } {
  const byKey = new Map(rows.map((r) => [r.key, r.value]));
  const warnings: string[] = [];

  let indicator: IndicatorSettings = { ...DEFAULT_SETTINGS };
  if (byKey.has("indicator")) {
    const checked = validateSettings(byKey.get("indicator"));
    if (!checked.ok) throw new SettingsError(`invalid_indicator_settings: ${checked.issues.map((i) => `${i.field}:${i.code}`).join(",")}`);
    indicator = checked.settings;
    for (const w of checked.warnings) warnings.push(`indicator.${w.field}: ${w.code}`);
  }

  const u = isRec(byKey.get("universe")) ? (byKey.get("universe") as Rec) : undefined;
  const universe: UniverseSettings = {
    thresholdUsd: pick(u, "threshold_usd", DEFAULT_UNIVERSE.thresholdUsd, warnings, "universe"),
    safetyMargin: pick(u, "safety_margin", DEFAULT_UNIVERSE.safetyMargin, warnings, "universe", { max: 1 }),
    minHistoryYears: pick(u, "min_history_years", DEFAULT_UNIVERSE.minHistoryYears, warnings, "universe", { integer: true }),
  };

  const p = isRec(byKey.get("pipeline")) ? (byKey.get("pipeline") as Rec) : undefined;
  const batch = isRec(p?.["batch_sizes"]) ? (p?.["batch_sizes"] as Rec) : undefined;
  const yahoo = isRec(p?.["yahoo"]) ? (p?.["yahoo"] as Rec) : undefined;
  const caps = isRec(p?.["stage_caps"]) ? (p?.["stage_caps"] as Rec) : undefined;
  const stageCaps: Record<string, number> = { ...DEFAULT_PIPELINE.stageCaps };
  for (const stage of Object.keys(stageCaps)) stageCaps[stage] = pick(caps, stage, stageCaps[stage] as number, warnings, "pipeline.stage_caps", { integer: true });

  const pipeline: PipelineSettings = {
    stageCaps,
    batch: {
      fetchBars: pick(batch, "fetch_bars", DEFAULT_PIPELINE.batch.fetchBars, warnings, "pipeline.batch_sizes", { integer: true, max: 50 }),
      compute: pick(batch, "compute", DEFAULT_PIPELINE.batch.compute, warnings, "pipeline.batch_sizes", { integer: true, max: 100 }),
      quoteBatch: pick(batch, "quote_batch", DEFAULT_PIPELINE.batch.quoteBatch, warnings, "pipeline.batch_sizes", { integer: true, max: 500 }),
      profile: pick(batch, "profile", DEFAULT_PIPELINE.batch.profile, warnings, "pipeline.batch_sizes", { integer: true, max: 100 }),
      volumeProbe: pick(batch, "volume_probe", DEFAULT_PIPELINE.batch.volumeProbe, warnings, "pipeline.batch_sizes", { integer: true, max: 50 }),
    },
    maxStoredBars: pick(p, "max_stored_bars", DEFAULT_PIPELINE.maxStoredBars, warnings, "pipeline", { integer: true, min: 100 }),
    leaseSeconds: pick(p, "lease_seconds", DEFAULT_PIPELINE.leaseSeconds, warnings, "pipeline", { integer: true }),
    claimLimit: pick(p, "claim_limit", DEFAULT_PIPELINE.claimLimit, warnings, "pipeline", { integer: true, max: 10 }),
    stopClaimingMs: pick(p, "stop_claiming_ms", DEFAULT_PIPELINE.stopClaimingMs, warnings, "pipeline", { integer: true }),
    hardDeadlineMs: pick(p, "hard_deadline_ms", DEFAULT_PIPELINE.hardDeadlineMs, warnings, "pipeline", { integer: true }),
    listPublishMinCoverage: pick(p, "list_publish_min_coverage", DEFAULT_PIPELINE.listPublishMinCoverage, warnings, "pipeline", { max: 1 }),
    carryForwardMaxScans: pick(p, "carry_forward_max_scans", DEFAULT_PIPELINE.carryForwardMaxScans, warnings, "pipeline", { integer: true }),
    maxScreenerPagesPerJob: pick(p, "max_screener_pages_per_job", DEFAULT_PIPELINE.maxScreenerPagesPerJob, warnings, "pipeline", { integer: true }),
    yahoo: {
      minSpacingMs: pick(yahoo, "min_spacing_ms", DEFAULT_PIPELINE.yahoo.minSpacingMs, warnings, "pipeline.yahoo", { min: 339 }), // never faster than 3 req/s
      jitterMs: pick(yahoo, "jitter_ms", DEFAULT_PIPELINE.yahoo.jitterMs, warnings, "pipeline.yahoo", { integer: true }),
    },
  };
  return { settings: { indicator, universe, pipeline }, warnings };
}

export interface SettingsSource {
  fetchRows(): Promise<ReadonlyArray<{ key: string; value: unknown }>>;
}

export async function loadSettings(source: SettingsSource): Promise<{ settings: AppSettings; warnings: string[] }> {
  return mergeSettings(await source.fetchRows());
}
```

- [ ] **Step 5: Implement (3/3)**

**`supabase/functions/_shared/adapters/db.ts`**

```ts
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { KvStore } from "./store.ts";
import { requireEnv } from "./env.ts";
import type { EventSink, JobStage, ScanEventRow } from "./log.ts";

/** Service-role access. Edge Functions only: it bypasses RLS and must never reach a browser or a log line. */

export interface ScanJob {
  id: number;
  scan_run_id: string;
  stage: JobStage;
  key: string;
  status: "queued" | "leased" | "done" | "failed" | "dead";
  priority: number;
  payload: Record<string, unknown>;
  result: unknown;
  attempts: number;
  max_attempts: number;
  not_before: string;
  lease_until: string | null;
  leased_by: string | null;
  last_error: string | null;
}

export type ScanStatus = "queued" | "running" | "partial" | "complete" | "failed";

export class DbError extends Error {
  constructor(readonly op: string, message: string, readonly code: string | null = null) {
    super(`${op}: ${message}`);
    this.name = "DbError";
  }
}

/** The pipeline-facing surface. Handlers receive this; tests replace it with an in-memory fake. `sb` is raw table access. */
export interface Db extends EventSink {
  readonly sb: SupabaseClient;
  claimJobs(a: { worker: string; limit: number; leaseSeconds: number; stages: JobStage[]; stageLimits: Record<string, number> }): Promise<ScanJob[]>;
  completeJob(id: number, result: unknown): Promise<void>;
  failJob(a: { id: number; error: string; retryInSeconds?: number | null; fatal?: boolean }): Promise<"failed" | "dead" | null>;
  deferJob(id: number, delaySeconds: number, reason: string): Promise<void>;
  heartbeatJob(id: number, extendSeconds: number): Promise<void>;
  refreshScanStatus(run: string): Promise<ScanStatus | null>;
  seedStage(a: { run: string; stage: JobStage; keys: string[]; payloads?: unknown[]; priorities?: number[] }): Promise<number>;
  nextStageToSeed(run: string): Promise<JobStage | null>;
  startDailyScan(a: { now?: string; force?: boolean; trigger?: "cron" | "cron_catchup" | "manual"; snapshotExtra?: Record<string, unknown> }): Promise<string | null>;
  purgeExpired(): Promise<Record<string, number>>;
}

const secs = (n: number): string => `${Math.max(0, Math.round(n))} seconds`;

export function createDb(sb: SupabaseClient): Db {
  const app = () => sb.schema("app");
  async function call<T>(op: string, name: string, args: Record<string, unknown>): Promise<T> {
    const { data, error } = await app().rpc(name, args);
    if (error) throw new DbError(op, error.message, error.code ?? null);
    return data as T;
  }
  return {
    sb,

    async claimJobs(a) {
      const rows = await call<ScanJob[] | null>("claim_jobs", "claim_jobs", {
        p_worker: a.worker,
        p_limit: a.limit,
        p_lease: secs(a.leaseSeconds),
        p_stages: a.stages,
        p_stage_limits: a.stageLimits,
      });
      return rows ?? [];
    },
    async completeJob(id, result) {
      await call<null>("complete_job", "complete_job", { p_id: id, p_result: result ?? null });
    },
    async failJob(a) {
      const args: Record<string, unknown> = { p_id: a.id, p_error: a.error, p_fatal: a.fatal ?? false };
      if (a.retryInSeconds !== undefined && a.retryInSeconds !== null) args["p_retry_in"] = secs(a.retryInSeconds);
      return await call<"failed" | "dead" | null>("fail_job", "fail_job", args);
    },
    async deferJob(id, delaySeconds, reason) {
      await call<null>("defer_job", "defer_job", { p_id: id, p_delay: secs(delaySeconds), p_reason: reason });
    },
    async heartbeatJob(id, extendSeconds) {
      await call<null>("heartbeat_job", "heartbeat_job", { p_id: id, p_extend: secs(extendSeconds) });
    },
    async refreshScanStatus(run) {
      return await call<ScanStatus | null>("refresh_scan_status", "refresh_scan_status", { p_run: run });
    },
    async seedStage(a) {
      const args: Record<string, unknown> = { p_run: a.run, p_stage: a.stage, p_keys: a.keys };
      if (a.payloads !== undefined) args["p_payloads"] = a.payloads;
      if (a.priorities !== undefined) args["p_priorities"] = a.priorities;
      return await call<number>("seed_stage", "seed_stage", args);
    },
    async nextStageToSeed(run) {
      return await call<JobStage | null>("next_stage_to_seed", "next_stage_to_seed", { p_run: run });
    },
    async startDailyScan(a) {
      return await call<string | null>("start_daily_scan", "start_daily_scan", {
        p_now: a.now ?? new Date().toISOString(),
        p_force: a.force ?? false,
        p_trigger: a.trigger ?? "cron",
        p_snapshot_extra: a.snapshotExtra ?? {},
      });
    },
    async purgeExpired() {
      return await call<Record<string, number>>("purge_expired", "purge_expired", {});
    },
    async recordEvent(e: ScanEventRow) {
      await call<null>("record_event", "record_event", {
        p_run: e.runId,
        p_event: e.event,
        p_level: e.level,
        p_stage: e.stage,
        p_job: e.jobId,
        p_security: e.securityId,
        p_message: e.message,
        p_data: e.data,
      });
    },
  };
}

/** Service-role client with no session persistence (Edge Functions are stateless). */
export function createServiceClient(): SupabaseClient {
  return createClient(requireEnv("SUPABASE_URL"), requireEnv("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export function createServiceDb(): Db {
  return createDb(createServiceClient());
}

/** quote_cache-backed KvStore: Yahoo session and breaker state survive across isolates. */
export function createQuoteCacheKv(sb: SupabaseClient, now: () => number = Date.now): KvStore {
  return {
    async get<T>(key: string): Promise<T | null> {
      const { data, error } = await sb.from("quote_cache").select("payload, expires_at").eq("key", key).maybeSingle();
      if (error) throw new DbError("quote_cache.get", error.message, error.code ?? null);
      if (data === null || Date.parse(data.expires_at as string) <= now()) return null;
      return data.payload as T;
    },
    async set(key, value, ttlMs) {
      const { error } = await sb.from("quote_cache").upsert(
        { key, payload: value as Record<string, unknown>, provider: "yahoo", fetched_at: new Date(now()).toISOString(), expires_at: new Date(now() + ttlMs).toISOString() },
        { onConflict: "key" },
      );
      if (error) throw new DbError("quote_cache.set", error.message, error.code ?? null);
    },
    async delete(key) {
      const { error } = await sb.from("quote_cache").delete().eq("key", key);
      if (error) throw new DbError("quote_cache.delete", error.message, error.code ?? null);
    },
  };
}
```

- [ ] **Step 6: Add the opt-in database integration test (runs after Task 14 on the local stack)**

The test proves every RPC argument convention through PostgREST (`jsonb` payload arrays, `int[]`, `text[]`, `job_stage[]` enum arrays, intervals as `'N seconds'`). It is ignored unless `DB_INTEGRATION=1`.

**`supabase/functions/_shared/adapters/db.integration.test.ts`**

```ts
// Opt-in: talks to the LOCAL stack. DB_INTEGRATION=1 SUPABASE_URL=http://127.0.0.1:54321 SUPABASE_SERVICE_ROLE_KEY=<service key from `supabase status -o json`>
// deno test --config supabase/functions/deno.json --allow-net=127.0.0.1,localhost --allow-env <this file>
import { assert, assertEquals } from "@std/assert";
import { createDb, createQuoteCacheKv, createServiceClient } from "./db.ts";

const enabled = Deno.env.get("DB_INTEGRATION") === "1";

Deno.test({ name: "db helpers: every rpc argument convention works through PostgREST", ignore: !enabled }, async () => {
  const url = Deno.env.get("SUPABASE_URL") ?? "";
  assert(url.includes("127.0.0.1") || url.includes("localhost"), "refusing to run against a non-local stack");
  const sb = createServiceClient();
  const db = createDb(sb);
  const runIds: string[] = [];
  try {
    // a forced start on a far-future date so it cannot collide with real data
    const run = await db.startDailyScan({ now: "2031-05-05T05:00:00Z", force: true, trigger: "manual", snapshotExtra: { provider_mode: "fixture" } });
    assert(run !== null);
    runIds.push(run);
    assertEquals(await db.startDailyScan({ now: "2031-05-05T05:30:00Z", force: true, trigger: "manual" }), null, "a second start for the same Sofia date is null");

    const claimed = await db.claimJobs({ worker: "it-worker", limit: 3, leaseSeconds: 180, stages: ["fx"], stageLimits: { fx: 1 } });
    const mine = claimed.filter((j) => j.scan_run_id === run);
    assertEquals(mine.length, 1);
    assertEquals([mine[0]!.stage, mine[0]!.key, mine[0]!.attempts, mine[0]!.leased_by], ["fx", "all", 1, "it-worker"]);

    await db.completeJob(mine[0]!.id, { rates: 3 });
    assertEquals(await db.nextStageToSeed(run), "universe_sweep");
    assertEquals(await db.seedStage({ run, stage: "universe_sweep", keys: ["NMS", "GER"], payloads: [{ n: 1 }, { n: 2 }], priorities: [20, 10] }), 2);
    assertEquals(await db.seedStage({ run, stage: "universe_sweep", keys: ["NMS", "GER"] }), 0, "idempotent");

    const sweep = (await db.claimJobs({ worker: "it-worker", limit: 5, leaseSeconds: 60, stages: ["universe_sweep"], stageLimits: {} })).filter((j) => j.scan_run_id === run);
    assertEquals(sweep.map((j) => j.key), ["GER", "NMS"], "priority order, payloads aligned");
    assertEquals(sweep[0]!.payload, { n: 2 });

    assertEquals(await db.failJob({ id: sweep[0]!.id, error: "boom api_key=SECRET" }), "failed");
    await db.deferJob(sweep[1]!.id, 30, "breaker_open");
    assertEquals(await db.failJob({ id: sweep[0]!.id, error: "fatal", fatal: true }), "dead");
    await db.heartbeatJob(sweep[1]!.id, 60); // not leased any more: a no-op, not an error

    assertEquals(await db.refreshScanStatus(run), "running");
    await db.recordEvent({ runId: run, jobId: null, stage: "fx", level: "info", event: "it_event", securityId: null, message: "hello", data: { a: 1 } });
    const ev = await sb.from("scan_events").select("event, data, stage").eq("scan_run_id", run).eq("event", "it_event");
    assertEquals(ev.data?.length, 1);
    assertEquals(ev.data?.[0]?.stage, "fx");

    const kv = createQuoteCacheKv(sb);
    await kv.set("it:key", { crumb: "x" }, 60_000);
    assertEquals(await kv.get("it:key"), { crumb: "x" });
    await kv.set("it:expired", { a: 1 }, -1000);
    assertEquals(await kv.get("it:expired"), null);
    await kv.delete("it:key");
    assertEquals(await kv.get("it:key"), null);
    await kv.delete("it:expired");

    assert(typeof (await db.purgeExpired())["scan_events"] === "number");
  } finally {
    for (const id of runIds) await sb.from("scan_runs").delete().eq("id", id); // cascades to scan_jobs
  }
});
```


- [ ] **Step 7: Run; Expected: PASS** `deno test -A --config supabase/functions/deno.json supabase/functions/_shared/adapters/log.test.ts supabase/functions/_shared/adapters/settings.test.ts` (6 + 7 tests: redaction of nested keys and URL credentials, settings defaults, invalid indicator throws, pacing floor 340 ms).

- [ ] **Step 8: Commit**

```bash
git add supabase/functions/_shared/adapters/log.ts supabase/functions/_shared/adapters/log.test.ts supabase/functions/_shared/adapters/settings.ts supabase/functions/_shared/adapters/settings.test.ts supabase/functions/_shared/adapters/db.ts supabase/functions/_shared/adapters/db.integration.test.ts
git commit -m "feat(adapters): service-role db helpers, redacted scan events and settings"
```

---
### Task 12: Migration 20261015001000_core_schema.sql

**Parallelism:** Group C is sequential (12 -> 13 -> 14 -> 15 -> 16) but can run concurrently with Groups A and B.

**Files:**
- Create: `supabase/migrations/20261015001000_core_schema.sql`

**Interfaces:**
- Consumes: P0 migration `20261015000100_extensions.sql` (pg_cron, pg_net, pgcrypto, pgtap, schema `app`)
- Produces: enums, tables `profiles exchanges fx_rates companies securities security_identity_overrides price_series market_cap_snapshots quote_cache app_settings audit_events`, `app.touch_updated_at()`, seeded `exchanges` (38 rows) and `app_settings` (`indicator`, `universe`, `pipeline`)

- [ ] **Step 1: Implement**

**`supabase/migrations/20261015001000_core_schema.sql`**

```sql
-- P1 / migration 1 of 4: enums, reference + market-data tables, seeds. Spec sections 6.2, 6.3.1, 6.3.2, 5.5.
-- RLS, grants and functions follow in 20261015001200_pipeline_functions.sql; every table here is locked down there.

-- ------------------------------------------------------------------ enums (6.2); later phases add their own types
create type universe_mode        as enum ('worldwide', 'us');
create type signal_kind          as enum ('discount', 'premium1', 'premium2');
create type threshold_line       as enum ('-3', '-4', '+1', '+2');
create type scan_status          as enum ('queued', 'running', 'partial', 'complete', 'failed');
create type job_status           as enum ('queued', 'leased', 'done', 'failed', 'dead');      -- failed = attempt failed, retry scheduled
create type job_stage            as enum ('fx','universe_sweep','identity','volume_probe','fetch_bars','compute','rank_signals','portfolio_scan',
                                          'news','research','classify','publish','digest','eur_catalogue','eur_resolve');
create type operational_category as enum ('green', 'amber', 'red', 'grey', 'pending');
create type bankruptcy_risk      as enum ('Low', 'Moderate', 'High', 'Unclear');
create type episode_status       as enum ('active', 'closed');
create type freshness_status     as enum ('fresh', 'stale', 'unavailable');
create type venue_class          as enum ('primary', 'secondary_only', 'otc');

-- ------------------------------------------------------------------ helper trigger
create or replace function app.touch_updated_at() returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- ------------------------------------------------------------------ 6.3.1 reference and identity
create table profiles (
  user_id uuid primary key references auth.users on delete cascade,
  display_name text,
  is_admin boolean not null default false,                -- not user-writable (column privileges)
  timezone text not null default 'Europe/Sofia',
  default_destination text not null default 'IBIS2' check (default_destination in ('IBIS2','IBIS','AEB')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger profiles_touch before update on profiles for each row execute function app.touch_updated_at();

create table exchanges (
  code text primary key,                                  -- Yahoo exchange code: NMS, NYQ, GER ...
  name text not null,
  mic text,
  country text not null,                                  -- Yahoo assetProfile naming (5.5)
  timezone text not null,                                 -- IANA
  currencies text[] not null,                             -- major currencies seen on the venue
  venue_class venue_class not null default 'primary',
  screener_enabled boolean not null default true,
  trading_days int[] not null default '{1,2,3,4,5}',      -- ISO weekdays; completeness statistics only
  session_close_local time,                               -- fallback for the forming-bar rule
  max_gap_days int not null default 5,                    -- freshness (A-10)
  tradingview_prefix text,
  tradingview_verified boolean not null default false,
  ibkr_exchange_id text,
  yahoo_suffix text,                                      -- e.g. '.DE'
  us_primary boolean not null default false,              -- NMS, NYQ, NGM
  created_at timestamptz not null default now()
);

create table fx_rates (
  id bigint generated always as identity primary key,
  rate_date date not null,
  ccy char(3) not null,                                   -- MAJOR currency, never GBp
  usd_per_unit float8 not null check (usd_per_unit > 0),
  source text not null check (source in ('frankfurter','yahoo')),
  source_symbol text,
  retrieved_at timestamptz not null default now(),
  unique (rate_date, ccy)
);

create table companies (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  name_normalized text not null,
  canonical_security_id uuid,                             -- FK added after securities (deferrable)
  country text, sector text, industry text,
  profile_refreshed_at timestamptz,
  sec_cik text,
  ir_rss_urls text[] not null default '{}',
  news_symbol text,
  status text not null default 'active' check (status in ('active','inactive')),
  identity_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index companies_name_normalized_idx on companies (name_normalized);
create trigger companies_touch before update on companies for each row execute function app.touch_updated_at();

create table securities (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies,
  yahoo_symbol text not null unique,
  symbol_history jsonb not null default '[]',
  exchange_code text not null references exchanges,
  currency text not null,                                 -- trading currency as Yahoo reports it (GBp, ZAc, ...)
  currency_major text not null,
  minor_divisor int not null default 1,
  quote_type text not null,
  long_name text,
  financial_currency text,
  shares_outstanding bigint,
  first_trade_date date,
  role text not null default 'other' check (role in ('canonical','share_class','adr','foreign_listing','secondary_venue','excluded','other')),
  is_canonical boolean not null default false,
  isin text,                                              -- from the IBKR catalogue / Flex; Yahoo has none
  avg_usd_volume_30d float8,
  volume_probe_at timestamptz,
  status text not null default 'active' check (status in ('active','delisted','suspended')),
  missing_scans int not null default 0,                   -- consecutive scans without data (5.8)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index securities_one_canonical on securities (company_id) where is_canonical;
create index securities_company_idx on securities (company_id);
create index securities_exchange_idx on securities (exchange_code);
create index securities_isin_idx on securities (isin) where isin is not null;
create trigger securities_touch before update on securities for each row execute function app.touch_updated_at();
alter table companies add constraint companies_canonical_fk
  foreign key (canonical_security_id) references securities deferrable initially deferred;

create table security_identity_overrides (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('force_canonical','exclude','force_us','force_not_us','merge_into_company','predecessor_continuity')),
  yahoo_symbol text not null,
  target_company_id uuid references companies,
  payload jsonb not null default '{}',                    -- e.g. {"continuous_since":"2008-05-02"}
  reason text not null,
  active boolean not null default true,
  created_by uuid references auth.users,
  created_at timestamptz not null default now()
);
create index security_identity_overrides_symbol_idx on security_identity_overrides (yahoo_symbol) where active;

-- ------------------------------------------------------------------ 6.3.2 market data
create table price_series (
  security_id uuid primary key references securities on delete cascade,
  bar_dates int4[] not null,                              -- days since 1970-01-01, strictly ascending
  open float8[] not null, high float8[] not null, low float8[] not null, close float8[] not null, volume int8[] not null,
  adjustment_policy text not null default 'yahoo_split_adjusted_close_v1',
  provider text not null default 'yahoo',
  bar_count int not null,
  first_bar_date date not null,
  last_bar_date date not null,
  last_session_date date not null,                        -- last COMPLETED session (forming bar excluded)
  last_close float8 not null,
  prev_close float8,                                      -- denormalised so public lists need no array access (A-41)
  retrieved_at timestamptz not null,
  last_full_refresh_at timestamptz not null,
  completeness jsonb not null default '{}',
  freshness freshness_status not null default 'fresh',
  updated_at timestamptz not null default now(),
  check (bar_count = cardinality(bar_dates) and bar_count = cardinality(open) and bar_count = cardinality(high)
         and bar_count = cardinality(low) and bar_count = cardinality(close) and bar_count = cardinality(volume))
);
create trigger price_series_touch before update on price_series for each row execute function app.touch_updated_at();

create table market_cap_snapshots (
  id bigint generated always as identity primary key,
  scan_run_id uuid not null,                              -- FK to scan_runs added in the next migration
  security_id uuid not null references securities,
  market_cap_native float8,
  currency_major text not null,                           -- original value and currency (brief 4.3)
  fx_usd_per_unit float8, fx_rate_date date, fx_source text,
  market_cap_usd float8,
  shares_outstanding bigint,
  price_time timestamptz,
  source text not null check (source in ('yahoo_screener','yahoo_quote')),
  quality text not null check (quality in ('ok','stale','missing','fx_missing')),
  unique (scan_run_id, security_id)
);
create index market_cap_snapshots_security_idx on market_cap_snapshots (security_id, id desc);

create table quote_cache (
  key text primary key,
  payload jsonb not null,
  provider text not null default 'yahoo',
  fetched_at timestamptz not null default now(),
  expires_at timestamptz not null,
  hit_count int not null default 0
);
create index quote_cache_expires_idx on quote_cache (expires_at);

-- ------------------------------------------------------------------ settings and audit
create table app_settings (
  key text primary key,
  value jsonb not null,
  is_public boolean not null default false,
  description text,
  updated_by uuid references auth.users,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger app_settings_touch before update on app_settings for each row execute function app.touch_updated_at();

create table audit_events (                                -- never deleted (brief 32)
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  actor_id uuid references auth.users on delete set null,
  action text not null,                                   -- e.g. set_setting, override, manual_scan_start
  target_type text,
  target_id text,
  details jsonb not null default '{}'
);
create index audit_events_at_idx on audit_events (at desc);

-- ------------------------------------------------------------------ comments
comment on table profiles is 'One row per user; is_admin is server-controlled (column privileges, 6.8).';
comment on table exchanges is 'Yahoo exchange codes (mic is left null: not evidenced in the research) with timezone, currencies, venue class and deep-link prefixes (5.5, 14.5). Secondary and OTC venues are not swept.';
comment on table fx_rates is 'Daily USD-per-unit rates in MAJOR currency units; one row per (rate_date, ccy) (5.4).';
comment on table companies is 'One row per company; listings of the same company are securities (5.6). Never keyed by ticker.';
comment on table securities is 'One row per Yahoo listing. yahoo_symbol is an attribute with symbol_history, never a key (5.8).';
comment on table security_identity_overrides is 'Audited manual identity decisions applied after the algorithm (5.6).';
comment on table price_series is 'One row per security: split-adjusted, NOT dividend-adjusted daily bars of COMPLETED sessions only (5.11). Arrays are served by get_price_series().';
comment on table market_cap_snapshots is 'Market cap as reported (major unit) with the FX row used, per scan, for reproducibility (4.6).';
comment on table quote_cache is 'Short-lived provider cache and the Yahoo session/breaker state (5.9, 5.11). Purged daily.';
comment on table app_settings is 'Runtime settings: indicator, universe, pipeline. Copied into scan_runs.settings_snapshot at scan start.';
comment on table audit_events is 'Append-only audit trail of operator actions.';

-- ------------------------------------------------------------------ seeds: exchanges (5.5 table; deep links from spike 7)
-- secondary_only and otc venues are not swept (screener_enabled = false): their lines duplicate foreign primaries.
insert into exchanges (code, name, mic, country, timezone, currencies, venue_class, screener_enabled, trading_days, session_close_local,
                       tradingview_prefix, tradingview_verified, ibkr_exchange_id, yahoo_suffix, us_primary) values
 ('NMS', 'NasdaqGS',  null, 'United States',  'America/New_York',    '{USD}',                'primary',        true,  '{1,2,3,4,5}', '16:00', 'NASDAQ',     true,  null,   '',     true),
 ('NYQ', 'NYSE',      null, 'United States',  'America/New_York',    '{USD}',                'primary',        true,  '{1,2,3,4,5}', '16:00', 'NYSE',       true,  null,   '',     true),
 ('NGM', 'NasdaqGM',  null, 'United States',  'America/New_York',    '{USD}',                'primary',        true,  '{1,2,3,4,5}', '16:00', null,         false, null,   '',     true),
 ('GER', 'XETRA',     null, 'Germany',        'Europe/Berlin',       '{EUR,USD}',            'primary',        true,  '{1,2,3,4,5}', '17:30', 'XETR',       true,  'IBIS', '.DE',  false),
 ('FRA', 'Frankfurt', null, 'Germany',        'Europe/Berlin',       '{EUR}',                'secondary_only', false, '{1,2,3,4,5}', '20:00', 'FWB',        true,  null,   '.F',   false),
 ('STU', 'Stuttgart', null, 'Germany',        'Europe/Berlin',       '{EUR}',                'secondary_only', false, '{1,2,3,4,5}', '22:00', null,         false, null,   '.SG',  false),
 ('MUN', 'Munich',    null, 'Germany',        'Europe/Berlin',       '{EUR}',                'secondary_only', false, '{1,2,3,4,5}', '20:00', null,         false, null,   '.MU',  false),
 ('DUS', 'Duesseldorf',null,'Germany',        'Europe/Berlin',       '{EUR}',                'secondary_only', false, '{1,2,3,4,5}', '20:00', null,         false, null,   '.DU',  false),
 ('VIE', 'Vienna',    null, 'Austria',        'Europe/Vienna',       '{EUR}',                'secondary_only', false, '{1,2,3,4,5}', '17:30', null,         false, null,   '.VI',  false),
 ('LSE', 'LSE',       null, 'United Kingdom', 'Europe/London',       '{GBP,USD,SEK,EUR}',    'primary',        true,  '{1,2,3,4,5}', '16:30', 'LSE',        true,  null,   '.L',   false),
 ('IOB', 'International Order Book', null, 'United Kingdom', 'Europe/London', '{GBP,USD,EUR}',  'secondary_only', false, '{1,2,3,4,5}', null,    null,         false, null,   null,   false),
 ('CXE', 'Cboe UK',   null, 'United Kingdom', 'Europe/London',       '{GBP,USD,EUR}',        'secondary_only', false, '{1,2,3,4,5}', null,    null,         false, null,   null,   false),
 ('EBS', 'Swiss',     null, 'Switzerland',    'Europe/Zurich',       '{CHF}',                'primary',        true,  '{1,2,3,4,5}', '17:30', 'SIX',        true,  null,   '.SW',  false),
 ('TOR', 'Toronto',   null, 'Canada',         'America/Toronto',     '{CAD,USD}',            'primary',        true,  '{1,2,3,4,5}', '16:00', 'TSX',        true,  null,   '.TO',  false),
 ('NEO', 'Cboe CA',   null, 'Canada',         'America/Toronto',     '{CAD}',                'secondary_only', false, '{1,2,3,4,5}', null,    null,         false, null,   '.NE',  false),
 ('HKG', 'HKSE',      null, 'Hong Kong',      'Asia/Hong_Kong',      '{HKD}',                'primary',        true,  '{1,2,3,4,5}', '16:00', 'HKEX',       true,  null,   '.HK',  false),
 ('JPX', 'Tokyo',     null, 'Japan',          'Asia/Tokyo',          '{JPY}',                'primary',        true,  '{1,2,3,4,5}', '15:30', 'TSE',        true,  null,   '.T',   false),
 ('SHH', 'Shanghai',  null, 'China',          'Asia/Shanghai',       '{CNY}',                'primary',        true,  '{1,2,3,4,5}', '15:00', 'SSE',        true,  null,   '.SS',  false),
 ('SHZ', 'Shenzhen',  null, 'China',          'Asia/Shanghai',       '{CNY}',                'primary',        true,  '{1,2,3,4,5}', '15:00', 'SZSE',       true,  null,   '.SZ',  false),
 ('TAI', 'Taiwan',    null, 'Taiwan',         'Asia/Taipei',         '{TWD}',                'primary',        true,  '{1,2,3,4,5}', '13:30', 'TWSE',       true,  null,   '.TW',  false),
 ('TWO', 'Taipei Exchange', null, 'Taiwan',   'Asia/Taipei',         '{TWD}',                'primary',        true,  '{1,2,3,4,5}', '13:30', null,         false, null,   '.TWO', false),
 ('KSC', 'KSE',       null, 'South Korea',    'Asia/Seoul',          '{KRW}',                'primary',        true,  '{1,2,3,4,5}', '15:30', 'KRX',        true,  null,   '.KS',  false),
 ('KOE', 'KOSDAQ',    null, 'South Korea',    'Asia/Seoul',          '{KRW}',                'primary',        true,  '{1,2,3,4,5}', '15:30', null,         false, null,   '.KQ',  false),
 ('NSI', 'NSE',       null, 'India',          'Asia/Kolkata',        '{INR}',                'primary',        true,  '{1,2,3,4,5}', '15:30', 'NSE',        true,  null,   '.NS',  false),
 ('BSE', 'BSE',       null, 'India',          'Asia/Kolkata',        '{INR}',                'primary',        true,  '{1,2,3,4,5}', '15:30', null,         false, null,   '.BO',  false),
 ('SAU', 'Saudi',     null, 'Saudi Arabia',   'Asia/Riyadh',         '{SAR}',                'primary',        true,  '{7,1,2,3,4}', '15:00', 'TADAWUL',    true,  null,   '.SR',  false),  -- Sunday-Thursday: UNVERIFIED
 ('ASX', 'ASX',       null, 'Australia',      'Australia/Sydney',    '{AUD}',                'primary',        true,  '{1,2,3,4,5}', '16:00', 'ASX',        true,  null,   '.AX',  false),
 ('AMS', 'Amsterdam', null, 'Netherlands',    'Europe/Amsterdam',    '{EUR}',                'primary',        true,  '{1,2,3,4,5}', '17:30', 'EURONEXT',   true,  'AEB',  '.AS',  false),
 ('PAR', 'Paris',     null, 'France',         'Europe/Paris',        '{EUR}',                'primary',        true,  '{1,2,3,4,5}', '17:30', 'EURONEXT',   true,  null,   '.PA',  false),
 ('MIL', 'Milan',     null, 'Italy',          'Europe/Rome',         '{EUR}',                'primary',        true,  '{1,2,3,4,5}', '17:30', 'MIL',        true,  null,   '.MI',  false),
 ('SES', 'SES',       null, 'Singapore',      'Asia/Singapore',      '{SGD}',                'primary',        true,  '{1,2,3,4,5}', '17:00', 'SGX',        true,  null,   '.SI',  false),
 ('JNB', 'Johannesburg',null,'South Africa',  'Africa/Johannesburg', '{ZAR}',                'primary',        true,  '{1,2,3,4,5}', '17:00', 'JSE',        true,  null,   '.JO',  false),
 ('SAO', 'Sao Paulo', null, 'Brazil',         'America/Sao_Paulo',   '{BRL}',                'primary',        true,  '{1,2,3,4,5}', '17:55', 'BMFBOVESPA', true,  null,   '.SA',  false),
 ('MEX', 'Mexico',    null, 'Mexico',         'America/Mexico_City', '{MXN}',                'secondary_only', false, '{1,2,3,4,5}', null,    'BMV',        true,  null,   '.MX',  false),
 ('BUE', 'Buenos Aires',null,'Argentina',     'America/Argentina/Buenos_Aires', '{ARS}',     'secondary_only', false, '{1,2,3,4,5}', null,    null,         false, null,   '.BA',  false),
 ('PNK', 'OTC Pink',  null, 'United States',  'America/New_York',    '{USD}',                'otc',            false, '{1,2,3,4,5}', null,    null,         false, null,   null,   false),
 ('OQB', 'OTCQB',     null, 'United States',  'America/New_York',    '{USD}',                'otc',            false, '{1,2,3,4,5}', null,    null,         false, null,   null,   false),
 ('OQX', 'OTCQX',     null, 'United States',  'America/New_York',    '{USD}',                'otc',            false, '{1,2,3,4,5}', null,    null,         false, null,   null,   false);

-- ------------------------------------------------------------------ seeds: app_settings (4.2.1, 5.5, 7.4, 7.5)
insert into app_settings (key, value, is_public, description) values
 ('indicator',
  '{"length":2500,"upper1Mode":true,"upper1Mult":1,"upper2Mode":true,"upper2Mult":2,"lower1Mode":true,"lower1Mag":3,"lower2Mode":true,"lower2Mag":4}',
  true, 'Std Dev Channel settings (4.2.1). Changes go through scan-control with an audit row.'),
 ('universe',
  '{"threshold_usd":50000000000,"safety_margin":0.7,"min_history_years":10}',
  true, 'Market-cap floor in USD (inclusive), screener safety margin, listing history requirement.'),
 ('pipeline',
  '{"stage_caps":{"fx":1,"universe_sweep":1,"identity":1,"fetch_bars":1,"compute":2,"rank_signals":1,"classify":1,"publish":1},
    "batch_sizes":{"fetch_bars":12,"compute":25,"quote_batch":500,"profile":25,"volume_probe":12},
    "max_stored_bars":3300,"lease_seconds":180,"claim_limit":3,"stop_claiming_ms":85000,"hard_deadline_ms":120000,
    "list_publish_min_coverage":0.95,"carry_forward_max_scans":3,"max_screener_pages_per_job":10,
    "yahoo":{"min_spacing_ms":340,"jitter_ms":100}}',
  false, 'Worker batch sizes, stage caps, deadlines and Yahoo pacing (7.4, 7.5, 5.3).')
on conflict (key) do nothing;
```

- [ ] **Step 2: Apply it**

```bash
bunx supabase db reset
```

Expected: `Applying migration 20261015001000_core_schema.sql...` with no error (the next migration is not applied yet if you only keep this file; apply Tasks 12-15 together if you prefer, the files are independent of the tests).

- [ ] **Step 3: Run; Expected: PASS** `bunx supabase db reset` (`supabase db reset` ends with `Finished supabase db reset`).

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20261015001000_core_schema.sql
git commit -m "feat(db): core schema, exchange seeds and default settings"
```

---
### Task 13: Migration 20261015001100_scan_schema.sql


**Files:**
- Create: `supabase/migrations/20261015001100_scan_schema.sql`

**Interfaces:**
- Consumes: Task 12 tables
- Produces: `scan_runs scan_jobs scan_events scan_security_results universe_snapshots universe_membership_events signal_episodes todays_discounts` with the constraints and indexes of spec 6.3.3, 6.3.4, 7.11, 8.2 (both partial unique indexes), FK `market_cap_snapshots.scan_run_id -> scan_runs`, `scan_jobs.created_at`

- [ ] **Step 1: Implement**

**`supabase/migrations/20261015001100_scan_schema.sql`**

```sql
-- P1 / migration 2 of 4: scan execution, universe, signals, today's discounts. Spec sections 6.3.3, 6.3.4, 6.5, 7.11, 8.2.

create table scan_runs (
  id uuid primary key default gen_random_uuid(),
  scan_date_local date not null unique,                   -- Europe/Sofia date; the idempotency key of the daily start
  status scan_status not null default 'queued',
  trigger text not null default 'cron' check (trigger in ('cron','cron_catchup','manual')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  last_heartbeat_at timestamptz,
  settings_snapshot jsonb not null,                       -- indicator settings, thresholds, caps used (reproducibility)
  code_version text,
  coverage jsonb not null default '{}',                   -- 7.7
  universe_sizes jsonb not null default '{}',             -- {"worldwide":{"members":..},"us":{...}}
  session_dates jsonb not null default '{}',              -- per exchange last completed session date
  latest_session_date date,                               -- max over processed securities
  results_published_at timestamptz,                       -- per-security results and cards (also for partial scans)
  list_published_at timestamptz,                          -- company list / summary (coverage >= 95% or complete, A-15)
  digest_cutoff_at timestamptz,                           -- 13:00 Sofia of scan_date_local
  digests_created_at timestamptz,
  errors_summary jsonb not null default '{}',
  updated_at timestamptz not null default now()
);
create trigger scan_runs_touch before update on scan_runs for each row execute function app.touch_updated_at();
alter table market_cap_snapshots add constraint market_cap_snapshots_run_fk
  foreign key (scan_run_id) references scan_runs on delete cascade;

create table scan_jobs (
  id bigint generated always as identity primary key,
  scan_run_id uuid not null references scan_runs on delete cascade,
  stage job_stage not null,
  key text not null,                                      -- idempotency key within the stage (batch id, exchange code, security id...)
  status job_status not null default 'queued',
  priority int not null default 100,
  payload jsonb not null default '{}',
  result jsonb,
  attempts int not null default 0,
  max_attempts int not null default 5,
  not_before timestamptz not null default now(),
  lease_until timestamptz,
  leased_by text,
  last_error text,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  unique (scan_run_id, stage, key)
);
create index scan_jobs_runnable on scan_jobs (priority, id) where status in ('queued','failed');
create index scan_jobs_leased on scan_jobs (lease_until) where status = 'leased';
create index scan_jobs_created_idx on scan_jobs (created_at);

create table scan_events (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  scan_run_id uuid,
  job_id bigint,
  stage job_stage,
  level text not null check (level in ('debug','info','warn','error')),
  event text not null,                                    -- machine code, e.g. yahoo_429, security_failed
  security_id uuid,
  message text,
  data jsonb                                              -- redacted (15.6)
);
create index scan_events_run_at_idx on scan_events (scan_run_id, at);
create index scan_events_at_idx on scan_events (at);

create table scan_security_results (                      -- one row per processed security per scan, mode independent
  id bigint generated always as identity primary key,
  scan_run_id uuid not null references scan_runs on delete cascade,
  security_id uuid not null references securities,
  scope text not null check (scope in ('universe','holding_only')),
  status text not null check (status in ('processed','skipped','failed','insufficient_data','stale','unprocessed')),
  reason_codes text[] not null default '{}',              -- RuleCode values (4.6)
  session_date date,
  close float8,
  freshness freshness_status,
  valid_bars int,
  bars_hash text,                                         -- hash of the 2,500-bar window (reproducibility)
  channel jsonb,                                          -- {slope, average, intercept, stdDev, pearsonR, upDev, dnDev, st, end, base, upper1, ...}
  market_cap_usd float8,
  tier1_member boolean not null default false,
  computed_at timestamptz not null default now(),
  unique (scan_run_id, security_id)
);
create index scan_security_results_security_idx on scan_security_results (security_id);
create index scan_security_results_status_idx on scan_security_results (scan_run_id, status);

create table universe_snapshots (
  id bigint generated always as identity primary key,
  scan_run_id uuid not null references scan_runs on delete cascade,
  mode universe_mode not null,
  security_id uuid not null references securities,
  company_id uuid not null references companies,
  rank int not null,
  market_cap_usd float8 not null,
  is_top10 boolean not null,
  state text not null default 'member' check (state in ('member','carried_forward')),
  applicable_line threshold_line not null,                -- '-3' or '-4' from the rank
  lower_line_end float8,
  close float8,
  session_date date,
  lower_line_positive boolean,
  is_discount boolean not null default false,
  ranked_at timestamptz not null default now(),
  unique (scan_run_id, mode, security_id),
  unique (scan_run_id, mode, rank)
);
create index universe_snapshots_security_idx on universe_snapshots (security_id);

create table universe_membership_events (
  id bigint generated always as identity primary key,
  scan_run_id uuid not null references scan_runs on delete cascade,
  event_date date not null,
  mode universe_mode not null,
  company_id uuid not null references companies,
  security_id uuid references securities,
  event text not null check (event in ('added','removed')),
  from_rank int,
  to_rank int,
  reason text not null,                                   -- market_cap_below_threshold, channel_not_rising, delisted_or_missing, new_listing ...
  unique (scan_run_id, mode, company_id, event)
);
create index universe_membership_events_date_idx on universe_membership_events (event_date);

create table signal_episodes (
  id uuid primary key default gen_random_uuid(),
  security_id uuid not null references securities,
  company_id uuid not null references companies,
  kind signal_kind not null,
  mode universe_mode not null,                            -- premium kinds always use mode 'worldwide' (A-14)
  threshold_line threshold_line not null,
  status episode_status not null default 'active',
  opened_scan_run_id uuid not null references scan_runs,
  opened_session_date date not null,
  opened_close float8 not null,
  opened_line_value float8 not null,
  opened_rank int,
  open_reason text not null check (open_reason in ('new_entry','rank_change_new_threshold','continuation')),
  continues_episode_id uuid references signal_episodes,   -- threshold change without interruption (8.4)
  notify boolean not null default true,
  last_evaluated_session_date date not null,
  closed_scan_run_id uuid references scan_runs,
  closed_session_date date,
  close_reason text check (close_reason in ('close_above_threshold','threshold_changed','close_below_upper_line')),
  rank_history jsonb not null default '[]',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((status = 'closed') = (closed_session_date is not null))
);
create unique index signal_one_active on signal_episodes (security_id, kind, mode, threshold_line) where status = 'active';
-- a security has at most one active discount episode per mode even across threshold changes (8.2)
create unique index signal_one_active_discount on signal_episodes (security_id, mode) where kind = 'discount' and status = 'active';
create index signal_episodes_opened_run_idx on signal_episodes (opened_scan_run_id);
create index signal_episodes_company_idx on signal_episodes (company_id);
create trigger signal_episodes_touch before update on signal_episodes for each row execute function app.touch_updated_at();

create table todays_discounts (
  id bigint generated always as identity primary key,
  scan_run_id uuid not null references scan_runs on delete cascade,
  mode universe_mode not null,
  security_id uuid not null references securities,
  company_id uuid not null references companies,
  episode_id uuid not null references signal_episodes,
  is_new_episode boolean not null,
  rank int not null,
  market_cap_usd float8,
  market_cap_native float8,
  market_cap_ccy text,
  close float8 not null,
  currency text not null,
  session_date date not null,
  threshold_line threshold_line not null,
  lower_line_end float8 not null,
  channel jsonb not null,                                 -- endpoints and deviation levels at decision time
  trend_ok boolean not null,
  eligibility jsonb not null,
  operational_category operational_category not null,
  category_reason text not null,
  report_id uuid,                                         -- FK to research_reports arrives with P2
  conclusion text,
  bankruptcy_risk bankruptcy_risk,
  summary text,
  research_completed_at timestamptz,
  eur_equivalent_id uuid,                                 -- FK to eur_equivalents arrives with P2
  data_freshness freshness_status not null,
  display_order int not null,
  withheld boolean not null default false,                -- red / grey / pending
  created_at timestamptz not null default now(),
  unique (scan_run_id, mode, security_id)
);
create index todays_discounts_order_idx on todays_discounts (scan_run_id, mode, display_order);

comment on table scan_runs is 'One row per Sofia calendar day (scan_date_local UNIQUE = the idempotency key of the daily start, 7.2).';
comment on table scan_jobs is 'Leased job queue (FOR UPDATE SKIP LOCKED, 6.6.2). UNIQUE (scan_run_id, stage, key) makes seeding idempotent.';
comment on table scan_events is 'Durable structured log (platform logs live one day on Free). data is redacted before insert (15.6).';
comment on table scan_security_results is 'One row per processed security per scan; unprocessed securities never render as passing (7.7).';
comment on table universe_snapshots is 'Ranks per scan and mode; never rewritten after publication (4.7).';
comment on table universe_membership_events is 'Added/removed events written only for list-published snapshots (7.7). Retained 90 days.';
comment on table signal_episodes is 'One continuous run of a signal condition. Partial unique indexes enforce one active episode (8.2).';
comment on table todays_discounts is 'Technical part of the cards for every active discount episode; research fields are filled by classify (8.3.1).';
```

- [ ] **Step 2: Run; Expected: PASS** `bunx supabase db reset` (`supabase db reset` applies the migration).

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20261015001100_scan_schema.sql
git commit -m "feat(db): scan execution, universe, signal and card tables"
```

---
### Task 14: Migration 20261015001200_pipeline_functions.sql (functions, public reads, RLS) and config.toml


**Files:**
- Create: `supabase/migrations/20261015001200_pipeline_functions.sql`
- Modify: `supabase/config.toml`

**Interfaces:**
- Consumes: Tasks 12-13 tables; Vault (`supabase_vault` extension, created by the migration)
- Produces: `app.current_settings_snapshot, record_event, kick_workers, start_daily_scan, ensure_scan_today, reap_expired_leases, claim_jobs, complete_job, fail_job, defer_job, heartbeat_job, seed_stage, next_stage_to_seed, refresh_scan_status, purge_expired, database_size, apply_quote_rows, apply_identity_groups`; `public.is_admin, company_list, universe_summary, scan_status, get_price_series, v_todays_discounts, todays_discounts_feed`; RLS on every table, column grants, `app` locked to `service_role`

- [ ] **Step 1: Expose schema `app` to PostgREST (service role only) in `supabase/config.toml`**

The functions call `supabase.schema("app").rpc(...)` with the service key. Access stays restricted to `service_role` by the grants in the migration (anon and authenticated have no USAGE on `app`). On the hosted project the same setting is the dashboard's "Exposed schemas" (add `app` once; document it in the operator guide).

Change line 13:

```toml
schemas = ["public", "graphql_public", "app"]
```

- [ ] **Step 2: Implement**

**`supabase/migrations/20261015001200_pipeline_functions.sql`**

```sql
-- P1 / migration 3 of 4: pipeline SQL functions, public read functions, views, RLS, grants.
-- Spec sections 6.6, 6.7, 6.8, 6.9, 7.2, 7.3, 7.6. Deviations are noted inline and listed in the plan.

create extension if not exists supabase_vault;             -- Vault holds project_url and worker_tick_secret (6.7)

-- ------------------------------------------------------------------ schema app: callable by service_role only
revoke all on schema app from public, anon, authenticated;
grant usage on schema app to service_role;
alter default privileges in schema app grant execute on functions to service_role;
-- PUBLIC keeps EXECUTE on new functions by the global default, so the lock-down is an explicit statement at the END of this
-- migration (and of every later migration that adds app functions).

-- ------------------------------------------------------------------ helpers
-- Deviation: the spec places is_admin() in schema app, but P0's pgTAP smoke test pins that `authenticated` has no USAGE on app.
-- RLS policies run with the caller's privileges, so the helper lives in public (SECURITY DEFINER, pinned search_path, no arguments).
create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select p.is_admin from profiles p where p.user_id = auth.uid()), false)
$$;
revoke execute on function public.is_admin() from public;
grant execute on function public.is_admin() to authenticated;

create or replace function app.current_settings_snapshot() returns jsonb
language sql stable security definer set search_path = public, app as $$
  select coalesce(jsonb_object_agg(key, value), '{}'::jsonb) from app_settings where key in ('indicator', 'universe', 'pipeline')
$$;

create or replace function app.record_event(
  p_run uuid, p_event text, p_level text default 'info', p_stage text default null, p_job bigint default null,
  p_security uuid default null, p_message text default null, p_data jsonb default null
) returns void language sql security definer set search_path = public, app as $$
  insert into scan_events (scan_run_id, job_id, stage, level, event, security_id, message, data)
  values (p_run, p_job, p_stage::job_stage, p_level, p_event, p_security, p_message, p_data)
$$;

-- ------------------------------------------------------------------ 6.6.3 minute tick (P1 part: worker-tick only)
-- Later phases extend this function with notify-dispatch and broker-sync (CREATE OR REPLACE).
-- Deviation: timeout_milliseconds 145000 as in the spec (worker-tick answers 202 at once via EdgeRuntime.waitUntil, so the
-- long timeout costs nothing and protects against a platform that cancels on client disconnect, which is UNVERIFIED, Q-02).
create or replace function app.kick_workers() returns void
language plpgsql security definer set search_path = public, app, vault, net as $$
declare v_url text; v_secret text; v_hdr jsonb;
begin
  select decrypted_secret into v_url    from vault.decrypted_secrets where name = 'project_url';
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'worker_tick_secret';
  if v_url is null or v_secret is null then return; end if;
  v_hdr := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', v_secret);
  perform app.reap_expired_leases();
  if exists (select 1 from scan_jobs where status in ('queued', 'failed') and not_before <= now())
     and (select count(distinct leased_by) from scan_jobs where status = 'leased' and lease_until > now()) < 2 then
    perform net.http_post(url := v_url || '/functions/v1/worker-tick', headers := v_hdr, body := '{}'::jsonb, timeout_milliseconds := 145000);
  end if;
end $$;

-- ------------------------------------------------------------------ 6.6.1 daily start
-- Extra parameter p_snapshot_extra is merged into settings_snapshot (fixture runs carry provider_mode = 'fixture', 7.12).
-- Only the fx job is seeded here; every later stage is seeded by app.next_stage_to_seed (7.4), because the universe sweep needs the FX rows.
create or replace function app.start_daily_scan(
  p_now timestamptz default now(), p_force boolean default false, p_trigger text default 'cron', p_snapshot_extra jsonb default '{}'::jsonb
) returns uuid language plpgsql security definer set search_path = public, app as $$
declare v_date date := (p_now at time zone 'Europe/Sofia')::date; v_id uuid;
begin
  -- DST-safe guard: only the 07:00 UTC entry (summer, UTC+3) or the 08:00 UTC entry (winter, UTC+2) passes (7.2)
  if not p_force and extract(hour from (p_now at time zone 'Europe/Sofia')) <> 10 then
    return null;
  end if;
  insert into scan_runs (scan_date_local, status, trigger, started_at, settings_snapshot, digest_cutoff_at)
  values (v_date, 'queued', p_trigger, p_now, app.current_settings_snapshot() || coalesce(p_snapshot_extra, '{}'::jsonb),
          ((v_date + time '13:00') at time zone 'Europe/Sofia'))
  on conflict (scan_date_local) do nothing
  returning id into v_id;
  if v_id is null then return null; end if;                 -- already started today: idempotent no-op
  insert into scan_jobs (scan_run_id, stage, key, priority) values (v_id, 'fx', 'all', 10) on conflict do nothing;
  insert into scan_events (scan_run_id, level, event, data)
  values (v_id, 'info', 'scan_started', jsonb_build_object('scan_date_local', v_date, 'trigger', p_trigger));
  perform app.kick_workers();
  return v_id;
end $$;

-- Catch-up: if the Sofia hour is 10-12 and no run exists for today, start one. p_now makes it replayable in pgTAP.
create or replace function app.ensure_scan_today(p_now timestamptz default now()) returns uuid
language plpgsql security definer set search_path = public, app as $$
declare v_hour int := extract(hour from (p_now at time zone 'Europe/Sofia'));
begin
  if v_hour between 10 and 12
     and not exists (select 1 from scan_runs where scan_date_local = (p_now at time zone 'Europe/Sofia')::date) then
    return app.start_daily_scan(p_now, true, 'cron_catchup');
  end if;
  return null;
end $$;

-- ------------------------------------------------------------------ 6.6.2 job claim with leases
create or replace function app.reap_expired_leases() returns int
language plpgsql security definer set search_path = public, app as $$
declare n int;
begin
  with x as (
    update scan_jobs
       set status = case when attempts >= max_attempts then 'dead'::job_status else 'queued'::job_status end,
           lease_until = null, leased_by = null,
           not_before = now() + interval '30 seconds',
           last_error = coalesce(last_error, 'lease_expired'),
           finished_at = case when attempts >= max_attempts then now() else finished_at end
     where status = 'leased' and lease_until < now()
    returning 1)
  select count(*) into n from x;
  return n;
end $$;

create or replace function app.claim_jobs(
  p_worker text, p_limit int, p_lease interval, p_stages job_stage[], p_stage_limits jsonb default '{}'::jsonb
) returns setof scan_jobs language plpgsql security definer set search_path = public, app as $$
declare r scan_jobs; n int := 0; lim int;
begin
  perform app.reap_expired_leases();
  for r in
    select j.* from scan_jobs j
     where j.status in ('queued', 'failed') and j.not_before <= now() and j.stage = any (p_stages)
     order by j.priority, j.id
     for update skip locked
  loop
    exit when n >= p_limit;
    perform pg_advisory_xact_lock(hashtext('stage:' || r.stage::text));            -- serialise the per-stage cap check
    lim := coalesce((p_stage_limits ->> r.stage::text)::int, 1000);
    continue when (select count(*) from scan_jobs x where x.stage = r.stage and x.status = 'leased' and x.lease_until > now()) >= lim;
    update scan_jobs
       set status = 'leased', leased_by = p_worker, lease_until = now() + p_lease,
           attempts = attempts + 1, started_at = coalesce(started_at, now())
     where id = r.id
    returning * into r;
    update scan_runs
       set status = case when status = 'queued' then 'running'::scan_status else status end, last_heartbeat_at = now()
     where id = r.scan_run_id;
    return next r;
    n := n + 1;
  end loop;
end $$;

create or replace function app.complete_job(p_id bigint, p_result jsonb default null) returns void
language sql security definer set search_path = public, app as $$
  update scan_jobs set status = 'done', result = p_result, finished_at = now(), lease_until = null
   where id = p_id and status = 'leased'
$$;

-- Failed attempt: retry with backoff 1m, 2m, 4m, 8m (+ up to 25% jitter) and dead at max_attempts, or dead at once when fatal.
create or replace function app.fail_job(p_id bigint, p_error text, p_retry_in interval default null, p_fatal boolean default false)
returns job_status language plpgsql security definer set search_path = public, app as $$
declare r scan_jobs; v_status job_status; v_delay interval;
begin
  select * into r from scan_jobs where id = p_id for update;
  if not found then return null; end if;
  if p_fatal or r.attempts >= r.max_attempts then
    v_status := 'dead';
  else
    v_status := 'failed';
    v_delay := coalesce(p_retry_in, make_interval(secs => 60 * power(2, greatest(r.attempts - 1, 0)) * (1 + random() * 0.25)));
  end if;
  update scan_jobs
     set status = v_status, last_error = left(p_error, 2000), lease_until = null, leased_by = null,
         finished_at = case when v_status = 'dead' then now() else finished_at end,
         not_before = case when v_status = 'failed' then now() + v_delay else not_before end
   where id = p_id;
  return v_status;
end $$;

-- Reschedules a leased job WITHOUT consuming an attempt (breaker open, waiting for sibling jobs; 7.9).
create or replace function app.defer_job(p_id bigint, p_delay interval, p_reason text default null) returns void
language sql security definer set search_path = public, app as $$
  update scan_jobs
     set status = 'queued', not_before = now() + p_delay, lease_until = null, leased_by = null,
         attempts = greatest(attempts - 1, 0), last_error = p_reason
   where id = p_id and status = 'leased'
$$;

create or replace function app.heartbeat_job(p_id bigint, p_extend interval) returns void
language sql security definer set search_path = public, app as $$
  update scan_jobs set lease_until = now() + p_extend where id = p_id and status = 'leased'
$$;

-- Stage seeding. p_payloads is a JSON array aligned with p_keys (PostgREST passes it as jsonb), p_priorities likewise.
-- Zero keys inserts a done marker (_empty) so the pipeline can move on. Idempotent: ON CONFLICT DO NOTHING.
create or replace function app.seed_stage(
  p_run uuid, p_stage text, p_keys text[], p_payloads jsonb default null, p_priorities int[] default null
) returns int language plpgsql security definer set search_path = public, app as $$
declare v_n int;
begin
  if coalesce(array_length(p_keys, 1), 0) = 0 then
    insert into scan_jobs (scan_run_id, stage, key, status, finished_at, result)
    values (p_run, p_stage::job_stage, '_empty', 'done', now(), '{"skipped":true}')
    on conflict (scan_run_id, stage, key) do nothing;
    return 0;
  end if;
  with ins as (
    insert into scan_jobs (scan_run_id, stage, key, payload, priority)
    select p_run, p_stage::job_stage, k.key,
           coalesce(case when p_payloads is not null and jsonb_typeof(p_payloads) = 'array' then p_payloads -> (k.ord::int - 1) end, '{}'::jsonb),
           coalesce(p_priorities[k.ord::int], 100)
      from unnest(p_keys) with ordinality as k(key, ord)
    on conflict (scan_run_id, stage, key) do nothing
    returning 1)
  select count(*) into v_n from ins;
  return v_n;
end $$;

-- First stage in pipeline order that has no jobs yet and whose predecessor is fully terminal; null when nothing can be seeded now.
-- A dead job in a critical stage (fx, rank_signals) stops the pipeline. Later phases CREATE OR REPLACE this function with more stages.
create or replace function app.next_stage_to_seed(p_run uuid) returns job_stage
language plpgsql stable security definer set search_path = public, app as $$
declare
  v_order job_stage[] := array['fx','universe_sweep','identity','fetch_bars','compute','rank_signals','classify','publish']::job_stage[];
  i int; v_stage job_stage; v_prev job_stage; v_cnt int; v_open int; v_dead int;
begin
  for i in 1 .. array_length(v_order, 1) loop
    v_stage := v_order[i];
    select count(*) into v_cnt from scan_jobs where scan_run_id = p_run and stage = v_stage;
    if v_cnt = 0 then
      if i = 1 then return v_stage; end if;
      v_prev := v_order[i - 1];
      select count(*) filter (where status in ('queued', 'leased', 'failed')), count(*) filter (where status = 'dead')
        into v_open, v_dead from scan_jobs where scan_run_id = p_run and stage = v_prev;
      if v_open > 0 then return null; end if;
      if v_prev in ('fx', 'rank_signals') and v_dead > 0 then return null; end if;
      return v_stage;
    end if;
  end loop;
  return null;
end $$;

-- ------------------------------------------------------------------ 7.6 status model
create or replace function app.refresh_scan_status(p_run uuid) returns scan_status
language plpgsql security definer set search_path = public, app as $$
declare
  r scan_runs; v_total int; v_open int; v_dead int; v_crit_dead int; v_started boolean; v_more boolean; v_rank_done boolean;
  v_gap int; v_status scan_status; v_hard timestamptz; v_terminal boolean; v_now timestamptz;
begin
  select * into r from scan_runs where id = p_run for update;
  if not found then return null; end if;
  v_hard := (r.scan_date_local + time '22:00') at time zone 'Europe/Sofia';        -- hard deadline (A-15)
  -- a fixture run replays a simulated date: its deadlines are judged one hour after its own start, never against the real clock (7.12)
  v_now := case when r.settings_snapshot ->> 'provider_mode' = 'fixture' then r.started_at + interval '1 hour' else now() end;
  if v_now >= v_hard then
    update scan_jobs set status = 'dead', last_error = 'deadline', lease_until = null, leased_by = null, finished_at = now()
     where scan_run_id = p_run and status in ('queued', 'leased', 'failed');
  end if;
  select count(*),
         count(*) filter (where status in ('queued', 'leased', 'failed')),
         count(*) filter (where status = 'dead'),
         count(*) filter (where status = 'dead' and stage in ('fx', 'rank_signals')),
         coalesce(bool_or(attempts > 0 or status in ('done', 'dead')), false)
    into v_total, v_open, v_dead, v_crit_dead, v_started
    from scan_jobs where scan_run_id = p_run;
  v_more := app.next_stage_to_seed(p_run) is not null;
  v_rank_done := exists (select 1 from scan_jobs where scan_run_id = p_run and stage = 'rank_signals' and status = 'done');
  v_gap := coalesce((r.coverage -> 'candidates' ->> 'failed')::int, 0) + coalesce((r.coverage -> 'candidates' ->> 'unprocessed')::int, 0)
         + coalesce((r.coverage -> 'candidates' ->> 'stale')::int, 0) + coalesce((r.coverage -> 'candidates' ->> 'carried_forward')::int, 0);
  v_terminal := v_total > 0 and v_open = 0 and not v_more;

  if v_crit_dead > 0 or (v_now >= v_hard and not v_rank_done) then
    v_status := 'failed';
  elsif not v_terminal then
    if r.digest_cutoff_at is not null and v_now >= r.digest_cutoff_at then v_status := 'partial';       -- soft deadline (13:00 Sofia)
    elsif v_started then v_status := 'running';
    else v_status := 'queued';
    end if;
  elsif v_dead > 0 or v_gap > 0 then
    v_status := 'partial';
  else
    v_status := 'complete';
  end if;

  update scan_runs
     set status = v_status,
         finished_at = case when v_status = 'failed' or (v_terminal and v_status in ('complete', 'partial')) then coalesce(finished_at, now()) else null end,
         last_heartbeat_at = now()
   where id = p_run;
  if v_status is distinct from r.status then
    insert into scan_events (scan_run_id, level, event, data)
    values (p_run, case when v_status in ('failed', 'partial') then 'warn' else 'info' end, 'scan_status_changed',
            jsonb_build_object('from', r.status, 'to', v_status));
  end if;
  return v_status;
end $$;

-- ------------------------------------------------------------------ 6.4 retention (P1 tables), batched and idempotent
create or replace function app.purge_expired(p_now timestamptz default now()) returns jsonb
language plpgsql security definer set search_path = public, app as $$
declare v_jobs int := 0; v_events int := 0; v_cache int := 0; v_membership int := 0; n int;
begin
  loop
    delete from scan_events where id in (select id from scan_events where at < p_now - interval '30 days' limit 5000);
    get diagnostics n = row_count; v_events := v_events + n; exit when n = 0;
  end loop;
  loop   -- only terminal jobs: a queued or leased job is never purged
    delete from scan_jobs where id in (select id from scan_jobs where created_at < p_now - interval '30 days' and status in ('done', 'dead') limit 5000);
    get diagnostics n = row_count; v_jobs := v_jobs + n; exit when n = 0;
  end loop;
  loop
    delete from quote_cache where key in (select key from quote_cache where expires_at < p_now or fetched_at < p_now - interval '1 day' limit 5000);
    get diagnostics n = row_count; v_cache := v_cache + n; exit when n = 0;
  end loop;
  loop
    delete from universe_membership_events where id in (
      select id from universe_membership_events where event_date < (p_now at time zone 'Europe/Sofia')::date - 90 limit 5000);
    get diagnostics n = row_count; v_membership := v_membership + n; exit when n = 0;
  end loop;
  return jsonb_build_object('scan_events', v_events, 'scan_jobs', v_jobs, 'quote_cache', v_cache, 'universe_membership_events', v_membership);
end $$;

-- ------------------------------------------------------------------ data-application functions used by the stage handlers
-- Bulk, transactional and idempotent: one round trip per batch instead of one per security.

-- Securities seen by the universe sweep / recheck / quote enrichment: creates companies and securities that do not exist yet
-- (every new security starts in its own provisional company; identity:group merges them), refreshes the mutable fields of the
-- known ones (never nulling a known value), and upserts the market-cap snapshot of the run.
-- Each element of p_rows: yahoo_symbol, new_company_id, name, name_normalized, exchange_code, currency, currency_major, minor_divisor,
-- quote_type, long_name, financial_currency, shares_outstanding, first_trade_date, market_cap_native, fx_usd_per_unit, fx_rate_date,
-- fx_source, market_cap_usd, price_time, source ('yahoo_screener' | 'yahoo_quote'), quality ('ok' | 'stale' | 'missing' | 'fx_missing').
create or replace function app.apply_quote_rows(p_run uuid, p_rows jsonb) returns jsonb
language plpgsql security definer set search_path = public, app as $$
declare v_created int; v_updated int; v_snapshots int; v_skipped int;
begin
  create temp table _rows on commit drop as
  select * from jsonb_to_recordset(p_rows) as r(
    yahoo_symbol text, new_company_id uuid, name text, name_normalized text, exchange_code text, currency text, currency_major text,
    minor_divisor int, quote_type text, long_name text, financial_currency text, shares_outstanding bigint, first_trade_date date,
    market_cap_native float8, fx_usd_per_unit float8, fx_rate_date date, fx_source text, market_cap_usd float8, price_time timestamptz,
    source text, quality text);
  select count(*) into v_skipped from _rows r where not exists (select 1 from exchanges e where e.code = r.exchange_code);
  delete from _rows r where not exists (select 1 from exchanges e where e.code = r.exchange_code);

  -- new securities (and their provisional companies)
  insert into companies (id, name, name_normalized)
  select r.new_company_id, r.name, r.name_normalized from _rows r
   where not exists (select 1 from securities s where s.yahoo_symbol = r.yahoo_symbol);
  insert into securities (company_id, yahoo_symbol, exchange_code, currency, currency_major, minor_divisor, quote_type, long_name,
                          financial_currency, shares_outstanding, first_trade_date)
  select r.new_company_id, r.yahoo_symbol, r.exchange_code, r.currency, r.currency_major, r.minor_divisor, r.quote_type, r.long_name,
         r.financial_currency, r.shares_outstanding, r.first_trade_date
    from _rows r where not exists (select 1 from securities s where s.yahoo_symbol = r.yahoo_symbol);
  get diagnostics v_created = row_count;

  -- known securities: refresh mutable fields (a missing value never overwrites a known one); the rows just created are untouched
  update securities s
     set exchange_code = r.exchange_code, currency = r.currency, currency_major = r.currency_major, minor_divisor = r.minor_divisor,
         quote_type = r.quote_type, long_name = coalesce(r.long_name, s.long_name), financial_currency = coalesce(r.financial_currency, s.financial_currency),
         shares_outstanding = coalesce(r.shares_outstanding, s.shares_outstanding), first_trade_date = coalesce(r.first_trade_date, s.first_trade_date),
         status = 'active', missing_scans = 0
    from _rows r
   where s.yahoo_symbol = r.yahoo_symbol and s.company_id is distinct from r.new_company_id;
  get diagnostics v_updated = row_count;

  insert into market_cap_snapshots (scan_run_id, security_id, market_cap_native, currency_major, fx_usd_per_unit, fx_rate_date, fx_source,
                                    market_cap_usd, shares_outstanding, price_time, source, quality)
  select p_run, s.id, r.market_cap_native, r.currency_major, r.fx_usd_per_unit, r.fx_rate_date, r.fx_source, r.market_cap_usd,
         r.shares_outstanding, r.price_time, r.source, r.quality
    from _rows r join securities s on s.yahoo_symbol = r.yahoo_symbol
  on conflict (scan_run_id, security_id) do update
     set market_cap_native = excluded.market_cap_native, currency_major = excluded.currency_major, fx_usd_per_unit = excluded.fx_usd_per_unit,
         fx_rate_date = excluded.fx_rate_date, fx_source = excluded.fx_source, market_cap_usd = excluded.market_cap_usd,
         shares_outstanding = excluded.shares_outstanding, price_time = excluded.price_time, source = excluded.source, quality = excluded.quality;
  get diagnostics v_snapshots = row_count;
  drop table _rows;
  return jsonb_build_object('created', v_created, 'updated', v_updated, 'snapshots', v_snapshots, 'skipped_unknown_exchange', v_skipped);
end $$;

-- Identity grouping result. Each element of p_groups: company_id (the surviving company), member_ids (uuid[]), canonical_id (uuid or null),
-- roles ({security_id: role}), country, name, name_normalized. Members move into the surviving company, roles and the canonical flag are
-- set (previous canonical flags are cleared first because of the one-canonical-per-company index), and companies left without securities
-- are deleted, or marked inactive when an old snapshot, episode or card still references them.
create or replace function app.apply_identity_groups(p_groups jsonb) returns jsonb
language plpgsql security definer set search_path = public, app as $$
declare g jsonb; v_members uuid[]; v_canonical uuid; v_groups int := 0; v_deleted int := 0; v_deactivated int := 0; o record;
begin
  for g in select * from jsonb_array_elements(p_groups) loop
    select array_agg(x::uuid) into v_members from jsonb_array_elements_text(g -> 'member_ids') x;
    v_canonical := nullif(g ->> 'canonical_id', '')::uuid;
    insert into companies (id, name, name_normalized)
    values ((g ->> 'company_id')::uuid, coalesce(g ->> 'name', 'unknown'), coalesce(g ->> 'name_normalized', 'unknown'))
    on conflict (id) do nothing;
    update securities set is_canonical = false where id = any (v_members) and is_canonical;
    update securities s
       set company_id = (g ->> 'company_id')::uuid, role = coalesce(g -> 'roles' ->> s.id::text, 'other'), is_canonical = false
     where s.id = any (v_members);
    if v_canonical is not null then
      update securities set is_canonical = true, role = 'canonical' where id = v_canonical;
    end if;
    update companies
       set canonical_security_id = v_canonical, country = coalesce(g ->> 'country', country), name = coalesce(g ->> 'name', name),
           name_normalized = coalesce(g ->> 'name_normalized', name_normalized), status = 'active'
     where id = (g ->> 'company_id')::uuid;
    v_groups := v_groups + 1;
  end loop;

  for o in select c.id from companies c where c.status = 'active' and not exists (select 1 from securities s where s.company_id = c.id) loop
    begin
      delete from companies where id = o.id;
      v_deleted := v_deleted + 1;
    exception when foreign_key_violation then
      update companies set status = 'inactive', canonical_security_id = null where id = o.id;
      v_deactivated := v_deactivated + 1;
    end;
  end loop;
  return jsonb_build_object('groups', v_groups, 'orphans_deleted', v_deleted, 'orphans_deactivated', v_deactivated);
end $$;

-- Database size for the health function (alarm at 400 MB of the 500 MB Free limit, 16.5).
create or replace function app.database_size() returns bigint language sql stable security definer set search_path = public, app as $$
  select pg_database_size(current_database())
$$;

-- ------------------------------------------------------------------ 6.6.4 public read functions
-- Company List: first page 15 rows; stable keyset pagination on rank.
-- Deviation: SECURITY DEFINER (spec: invoker), because it reads market_cap_snapshots, which anon must not read directly (6.9).
create or replace function public.company_list(p_mode universe_mode, p_limit int default 15, p_after_rank int default null)
returns table (rank int, company_id uuid, security_id uuid, yahoo_symbol text, name text, currency text,
               last_close float8, prev_close float8, change_pct float8, session_date date, price_freshness freshness_status,
               market_cap_usd float8, market_cap_native float8, market_cap_ccy text,
               is_top10 boolean, applicable_line threshold_line, lower_line_positive boolean, is_discount boolean,
               state text, total_count bigint)
language sql stable security definer set search_path = public as $$
  with run as (select id from scan_runs where list_published_at is not null order by scan_date_local desc limit 1),
  base as (
    select u.*, count(*) over () as total_count
      from universe_snapshots u join run on u.scan_run_id = run.id
     where u.mode = p_mode and u.rank > coalesce(p_after_rank, 0)
     order by u.rank limit least(greatest(p_limit, 1), 100))
  select b.rank, b.company_id, b.security_id, s.yahoo_symbol, c.name, s.currency,
         ps.last_close, ps.prev_close,
         case when ps.prev_close > 0 then (ps.last_close / ps.prev_close - 1) * 100 end,
         ps.last_session_date, ps.freshness, b.market_cap_usd,
         mc.market_cap_native, mc.currency_major, b.is_top10, b.applicable_line, b.lower_line_positive, b.is_discount, b.state, b.total_count
    from base b
    join securities s on s.id = b.security_id
    join companies c on c.id = b.company_id
    left join price_series ps on ps.security_id = b.security_id
    left join lateral (select m.market_cap_native, m.currency_major from market_cap_snapshots m
                        where m.security_id = b.security_id order by m.id desc limit 1) mc on true
   order by b.rank
$$;

-- The short summary: added/removed today and over the trailing seven days (distinct companies, most recent event date).
create or replace function public.universe_summary(p_mode universe_mode) returns jsonb
language sql stable security invoker set search_path = public as $$
  with latest as (select id, scan_date_local from scan_runs where list_published_at is not null order by scan_date_local desc limit 1),
  ev as (
    select e.event, e.company_id, c.name, max(e.event_date) as last_date, bool_or(e.scan_run_id = (select id from latest)) as today
      from universe_membership_events e join companies c on c.id = e.company_id, latest
     where e.mode = p_mode and e.event_date >= latest.scan_date_local - 6
     group by e.event, e.company_id, c.name)
  select jsonb_build_object(
    'as_of', (select scan_date_local from latest),
    'added_today',   coalesce((select jsonb_agg(jsonb_build_object('company_id', company_id, 'name', name) order by name) from ev where event = 'added'   and today), '[]'),
    'removed_today', coalesce((select jsonb_agg(jsonb_build_object('company_id', company_id, 'name', name) order by name) from ev where event = 'removed' and today), '[]'),
    'added_7d',      coalesce((select jsonb_agg(jsonb_build_object('company_id', company_id, 'name', name, 'date', last_date) order by last_date desc, name) from ev where event = 'added'), '[]'),
    'removed_7d',    coalesce((select jsonb_agg(jsonb_build_object('company_id', company_id, 'name', name, 'date', last_date) order by last_date desc, name) from ev where event = 'removed'), '[]'))
$$;

-- Scan status for the public header: three separate timestamps, never inferred from an attempt.
create or replace function public.scan_status() returns jsonb language sql stable security invoker set search_path = public as $$
  select jsonb_build_object(
    'last_attempted', (select to_jsonb(r) from (select scan_date_local, started_at, status from scan_runs order by started_at desc limit 1) r),
    'last_successful', (select to_jsonb(r) from (select scan_date_local, finished_at from scan_runs where status = 'complete' order by finished_at desc limit 1) r),
    'latest_published', (select to_jsonb(r) from (select scan_date_local, status, latest_session_date, coverage, results_published_at, list_published_at
                                                     from scan_runs where results_published_at is not null order by scan_date_local desc limit 1) r))
$$;

-- ONE security per call; the arrays are not selectable directly (A-41).
create or replace function public.get_price_series(p_security_id uuid) returns price_series
language sql stable security definer set search_path = public as $$ select * from price_series where security_id = p_security_id $$;

-- The public overview view (cards and withheld panel). P1 has no eur_equivalents table yet: the EUR columns are typed nulls
-- and are replaced by the real join in P2 (CREATE OR REPLACE VIEW keeps the column list).
create or replace view public.v_todays_discounts with (security_invoker = true) as
select t.scan_run_id, t.mode, t.rank, t.display_order, t.withheld, s.id as security_id, s.yahoo_symbol, c.name, ex.code as exchange_code, ex.name as exchange_name,
       t.close, t.currency, t.session_date, t.threshold_line, t.lower_line_end, t.data_freshness, t.is_new_episode, e.opened_session_date as since_date,
       t.operational_category, t.category_reason, t.conclusion, t.bankruptcy_risk, t.summary, t.research_completed_at, t.report_id,
       null::text as eur_symbol_yahoo, null::text as ibkr_local_symbol, null::text as ibkr_exchange_id, null::text as eur_status, null::timestamptz as eur_verified_at
  from todays_discounts t
  join securities s on s.id = t.security_id
  join companies c on c.id = t.company_id
  join exchanges ex on ex.code = s.exchange_code
  join signal_episodes e on e.id = t.episode_id
 where t.scan_run_id = (select id from scan_runs where results_published_at is not null order by scan_date_local desc limit 1);

create or replace function public.todays_discounts_feed(p_mode universe_mode) returns setof public.v_todays_discounts
language sql stable security invoker set search_path = public as $$
  select * from public.v_todays_discounts where mode = p_mode
   order by withheld, case operational_category when 'green' then 0 when 'amber' then 1 else 2 end, display_order
$$;

-- ------------------------------------------------------------------ 6.8 / 6.9 grants and RLS (every table is locked down first)
revoke all on profiles, exchanges, fx_rates, companies, securities, security_identity_overrides, price_series, market_cap_snapshots,
              quote_cache, app_settings, audit_events, scan_runs, scan_jobs, scan_events, scan_security_results, universe_snapshots,
              universe_membership_events, signal_episodes, todays_discounts
  from anon, authenticated;

alter table profiles                   enable row level security;
alter table exchanges                  enable row level security;
alter table fx_rates                   enable row level security;
alter table companies                  enable row level security;
alter table securities                 enable row level security;
alter table security_identity_overrides enable row level security;
alter table price_series               enable row level security;
alter table market_cap_snapshots       enable row level security;
alter table quote_cache                enable row level security;
alter table app_settings               enable row level security;
alter table audit_events               enable row level security;
alter table scan_runs                  enable row level security;
alter table scan_jobs                  enable row level security;
alter table scan_events                enable row level security;
alter table scan_security_results      enable row level security;
alter table universe_snapshots         enable row level security;
alter table universe_membership_events enable row level security;
alter table signal_episodes            enable row level security;
alter table todays_discounts           enable row level security;

-- public reference and result tables: using (true)
grant select on exchanges, fx_rates, companies, securities, universe_snapshots, universe_membership_events, todays_discounts to anon, authenticated;
create policy exchanges_select                   on exchanges                   for select to anon, authenticated using (true);
create policy fx_rates_select                    on fx_rates                    for select to anon, authenticated using (true);
create policy companies_select                   on companies                   for select to anon, authenticated using (true);
create policy securities_select                  on securities                  for select to anon, authenticated using (true);
create policy universe_snapshots_select          on universe_snapshots          for select to anon, authenticated using (true);
create policy universe_membership_events_select  on universe_membership_events for select to anon, authenticated using (true);
create policy todays_discounts_select            on todays_discounts            for select to anon, authenticated using (true);

-- price_series: non-array columns only; the arrays are served by get_price_series() (A-41)
grant select (security_id, last_session_date, last_close, prev_close, bar_count, first_bar_date, last_bar_date, freshness, completeness)
  on price_series to anon, authenticated;
create policy price_series_select on price_series for select to anon, authenticated using (true);

-- scan_runs: settings_snapshot, errors_summary, code_version, trigger and heartbeat stay hidden
grant select (id, scan_date_local, status, started_at, finished_at, latest_session_date, coverage, session_dates,
              results_published_at, list_published_at, universe_sizes)
  on scan_runs to anon, authenticated;
create policy scan_runs_select on scan_runs for select to anon, authenticated using (true);

-- scan_security_results: universe scope, public columns (bars_hash is internal)
grant select (id, scan_run_id, security_id, scope, status, reason_codes, session_date, close, freshness, valid_bars, channel, market_cap_usd, tier1_member, computed_at)
  on scan_security_results to anon, authenticated;
create policy scan_security_results_select on scan_security_results for select to anon, authenticated using (scope = 'universe');

-- signal_episodes: discount kind is public; premium episodes arrive with P5 (holders only)
grant select on signal_episodes to anon, authenticated;
create policy signal_episodes_discount_select on signal_episodes for select to anon, authenticated using (kind = 'discount');

-- app_settings: only rows flagged is_public
grant select on app_settings to anon, authenticated;
create policy app_settings_public_select on app_settings for select to anon, authenticated using (is_public);

-- profiles: own row, safe columns (is_admin is not selectable or writable by the user)
grant select (user_id, display_name, timezone, default_destination, created_at) on profiles to authenticated;
grant update (display_name, timezone, default_destination) on profiles to authenticated;
create policy profiles_select_own on profiles for select to authenticated using (user_id = auth.uid());
create policy profiles_update_own on profiles for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

-- operational tables: admin read only (optional admin page); everything else is service role
grant select on scan_jobs, scan_events, audit_events to authenticated;
create policy scan_jobs_admin_select    on scan_jobs    for select to authenticated using (public.is_admin());
create policy scan_events_admin_select  on scan_events  for select to authenticated using (public.is_admin());
create policy audit_events_admin_select on audit_events for select to authenticated using (public.is_admin());
-- no grants and no policies: market_cap_snapshots, quote_cache, security_identity_overrides

-- views and public functions
revoke all on public.v_todays_discounts from anon, authenticated;
grant select on public.v_todays_discounts to anon, authenticated;
revoke execute on function public.company_list(universe_mode, int, int), public.universe_summary(universe_mode), public.scan_status(),
                           public.get_price_series(uuid), public.todays_discounts_feed(universe_mode) from public;
grant execute on function public.company_list(universe_mode, int, int), public.universe_summary(universe_mode), public.scan_status(),
                          public.get_price_series(uuid), public.todays_discounts_feed(universe_mode) to anon, authenticated;

-- ------------------------------------------------------------------ lock down schema app: service_role only
revoke execute on all functions in schema app from public, anon, authenticated;
grant execute on all functions in schema app to service_role;
```

- [ ] **Step 3: Run; Expected: PASS** `bunx supabase db reset && bun run test:db` (`supabase db reset` applies all four migrations; then `bun run test:db` still passes P0's `0001_smoke.test.sql`: `authenticated` has no USAGE on `app`).

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20261015001200_pipeline_functions.sql supabase/config.toml
git commit -m "feat(db): pipeline functions, public reads and RLS"
```

---
### Task 15: Migration 20261015001300_cron_jobs.sql


**Files:**
- Create: `supabase/migrations/20261015001300_cron_jobs.sql`

**Interfaces:**
- Consumes: Task 14 functions
- Produces: pg_cron jobs `scan-start-0700`, `scan-start-0800`, `scan-catchup`, `tick-minute`, `purge-cron-history` (digest, broker and retention entries arrive with later phases)

- [ ] **Step 1: Implement**

**`supabase/migrations/20261015001300_cron_jobs.sql`**

```sql
-- P1 / migration 4 of 4: pg_cron entries (spec 7.1). All schedules are UTC. Each job is re-created by name, so the migration is idempotent.
-- The digest, broker and retention entries arrive with the phases that own those functions.
do $$
declare j text;
begin
  foreach j in array array['scan-start-0700', 'scan-start-0800', 'scan-catchup', 'tick-minute', 'purge-cron-history'] loop
    if exists (select 1 from cron.job where jobname = j) then
      perform cron.unschedule(j);
    end if;
  end loop;
end $$;

select cron.schedule('scan-start-0700',    '0 7 * * *',       $$select app.start_daily_scan();$$);       -- 10:00 Sofia in summer time (UTC+3)
select cron.schedule('scan-start-0800',    '0 8 * * *',       $$select app.start_daily_scan();$$);       -- 10:00 Sofia in winter time (UTC+2)
select cron.schedule('scan-catchup',       '*/15 7-11 * * *', $$select app.ensure_scan_today();$$);      -- only acts when the Sofia hour is 10-12
select cron.schedule('tick-minute',        '* * * * *',       $$select app.kick_workers();$$);           -- no-op until Vault holds project_url and worker_tick_secret
select cron.schedule('purge-cron-history', '45 1 * * *',      $$delete from cron.job_run_details where end_time < now() - interval '7 days';$$);
```

- [ ] **Step 2: Verify the jobs and idempotency**

```bash
bunx supabase db reset
docker exec supabase_db_<project> psql -U postgres -c "select jobname, schedule from cron.job order by jobname"
```

Expected five rows: `purge-cron-history 45 1 * * *`, `scan-catchup */15 7-11 * * *`, `scan-start-0700 0 7 * * *`, `scan-start-0800 0 8 * * *`, `tick-minute * * * * *`. Re-running the migration body twice leaves five rows (unschedule by name first).

- [ ] **Step 3: Run; Expected: PASS** `bunx supabase db reset` (five cron rows).

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20261015001300_cron_jobs.sql
git commit -m "feat(db): daily scan, catch-up, tick and history purge cron jobs"
```

---
### Task 16: pgTAP suites


**Files:**
- Create: `supabase/tests/0100_schema.test.sql`, `0110_rls.test.sql`, `0120_pipeline.test.sql`, `0130_public_reads.test.sql`, `0140_data_functions.test.sql`

**Interfaces:**
- Consumes: Tasks 12-15
- Produces: 251 assertions (51 + 29 + 95 + 45 + 32) covering tables, enums, seeds, unique and partial indexes, RLS (anon, authenticated, admin), DST start on 2026-03-29 and 2026-10-25, catch-up, claim/lease/stage caps, `fail_job` dead at 5, status rules, `company_list` keyset pagination, `universe_summary`, `scan_status`, retention, bulk data functions

- [ ] **Step 1: Write the failing tests**

**`supabase/tests/0100_schema.test.sql`**

```sql
begin;
select plan(51);

-- tables ---------------------------------------------------------------------------------------------
select has_table('public', t, 'table ' || t || ' exists')
  from unnest(array['profiles','exchanges','fx_rates','companies','securities','security_identity_overrides','price_series',
                    'market_cap_snapshots','quote_cache','app_settings','audit_events','scan_runs','scan_jobs','scan_events',
                    'scan_security_results','universe_snapshots','universe_membership_events','signal_episodes','todays_discounts']) as t;

-- enums ----------------------------------------------------------------------------------------------
select enum_has_labels('public', 'universe_mode', array['worldwide','us']);
select enum_has_labels('public', 'signal_kind', array['discount','premium1','premium2']);
select enum_has_labels('public', 'threshold_line', array['-3','-4','+1','+2']);
select enum_has_labels('public', 'scan_status', array['queued','running','partial','complete','failed']);
select enum_has_labels('public', 'job_status', array['queued','leased','done','failed','dead']);
select enum_has_labels('public', 'operational_category', array['green','amber','red','grey','pending']);
select enum_has_labels('public', 'freshness_status', array['fresh','stale','unavailable']);
select enum_has_labels('public', 'venue_class', array['primary','secondary_only','otc']);

-- seeds ----------------------------------------------------------------------------------------------
select cmp_ok((select count(*)::int from exchanges), '>=', 35, 'exchanges seeded');
select is((select count(*)::int from exchanges where us_primary), 3, 'NMS, NYQ and NGM are the US-primary exchanges');
select is((select array_agg(code order by code) from exchanges where us_primary), array['NGM','NMS','NYQ'], 'US-primary codes');
select is((select trading_days from exchanges where code = 'SAU'), '{7,1,2,3,4}'::int[], 'Saudi trading days are Sunday-Thursday');
select is((select count(*)::int from exchanges where venue_class <> 'primary' and screener_enabled), 0, 'secondary and OTC venues are never swept');
select is((select (value ->> 'length')::int from app_settings where key = 'indicator'), 2500, 'indicator length 2500');
select is((select (value ->> 'threshold_usd')::numeric from app_settings where key = 'universe'), 50000000000::numeric, 'threshold 50e9');
select is((select array_agg(key order by key) from app_settings), array['indicator','pipeline','universe'], 'settings keys');

-- fixtures for the constraint checks -------------------------------------------------------------------
insert into companies (id, name, name_normalized) values ('00000000-0000-0000-0000-0000000000c1', 'Acme Corp', 'acme');
insert into securities (id, company_id, yahoo_symbol, exchange_code, currency, currency_major, quote_type)
values ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000c1', 'ACME', 'NMS', 'USD', 'USD', 'EQUITY'),
       ('00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000c1', 'ACME.DE', 'GER', 'EUR', 'EUR', 'EQUITY');

-- uniqueness -----------------------------------------------------------------------------------------
select throws_ok($$insert into securities (company_id, yahoo_symbol, exchange_code, currency, currency_major, quote_type)
                   values ('00000000-0000-0000-0000-0000000000c1', 'ACME', 'NMS', 'USD', 'USD', 'EQUITY')$$, '23505', null, 'yahoo_symbol is unique');
update securities set is_canonical = true where id = '00000000-0000-0000-0000-0000000000a1';
select throws_ok($$update securities set is_canonical = true where id = '00000000-0000-0000-0000-0000000000a2'$$, '23505', null, 'one canonical security per company');
select throws_ok($$insert into fx_rates (rate_date, ccy, usd_per_unit, source) values ('2026-10-14', 'EUR', 1.1, 'frankfurter'), ('2026-10-14', 'EUR', 1.2, 'frankfurter')$$,
                 '23505', null, 'one fx row per (rate_date, ccy)');
select throws_ok($$insert into fx_rates (rate_date, ccy, usd_per_unit, source) values ('2026-10-14', 'XXX', 0, 'frankfurter')$$, '23514', null, 'fx rate must be positive');

-- price_series: equal-length arrays ----------------------------------------------------------------------
select lives_ok($$insert into price_series (security_id, bar_dates, open, high, low, close, volume, bar_count, first_bar_date, last_bar_date,
                                            last_session_date, last_close, retrieved_at, last_full_refresh_at)
                  values ('00000000-0000-0000-0000-0000000000a1', '{1,2}', '{1,1}', '{2,2}', '{0,0}', '{1,2}', '{5,5}', 2, '1970-01-02', '1970-01-03', '1970-01-03', 2, now(), now())$$,
                'a consistent price_series row is accepted');
select throws_ok($$insert into price_series (security_id, bar_dates, open, high, low, close, volume, bar_count, first_bar_date, last_bar_date,
                                             last_session_date, last_close, retrieved_at, last_full_refresh_at)
                   values ('00000000-0000-0000-0000-0000000000a2', '{1,2}', '{1,1}', '{2,2}', '{0,0}', '{1}', '{5,5}', 2, '1970-01-02', '1970-01-03', '1970-01-03', 2, now(), now())$$,
                 '23514', null, 'arrays of different length are rejected');
select throws_ok($$update price_series set bar_count = 3 where security_id = '00000000-0000-0000-0000-0000000000a1'$$, '23514', null, 'bar_count must match cardinality');

-- scan_jobs idempotency -------------------------------------------------------------------------------
insert into scan_runs (id, scan_date_local, settings_snapshot) values ('00000000-0000-0000-0000-0000000000f1', '2026-10-15', '{}');
insert into scan_jobs (scan_run_id, stage, key) values ('00000000-0000-0000-0000-0000000000f1', 'fx', 'all');
select throws_ok($$insert into scan_jobs (scan_run_id, stage, key) values ('00000000-0000-0000-0000-0000000000f1', 'fx', 'all')$$, '23505', null, 'UNIQUE (scan_run_id, stage, key)');
select throws_ok($$insert into scan_runs (scan_date_local, settings_snapshot) values ('2026-10-15', '{}')$$, '23505', null, 'scan_date_local is unique');
select throws_ok($$insert into scan_runs (scan_date_local, settings_snapshot, trigger) values ('2026-10-16', '{}', 'bogus')$$, '23514', null, 'trigger values are checked');

-- episodes: partial unique indexes and the closed check -------------------------------------------------
insert into signal_episodes (id, security_id, company_id, kind, mode, threshold_line, opened_scan_run_id, opened_session_date, opened_close, opened_line_value,
                             open_reason, last_evaluated_session_date)
values ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000c1', 'discount', 'worldwide', '-3',
        '00000000-0000-0000-0000-0000000000f1', '2026-10-14', 99, 100, 'new_entry', '2026-10-14');
select throws_ok($$insert into signal_episodes (security_id, company_id, kind, mode, threshold_line, opened_scan_run_id, opened_session_date, opened_close, opened_line_value, open_reason, last_evaluated_session_date)
                   values ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000c1', 'discount', 'worldwide', '-3', '00000000-0000-0000-0000-0000000000f1', '2026-10-14', 99, 100, 'new_entry', '2026-10-14')$$,
                 '23505', 'duplicate key value violates unique constraint "signal_one_active"', 'one active episode per (security, kind, mode, line)');
select throws_ok($$insert into signal_episodes (security_id, company_id, kind, mode, threshold_line, opened_scan_run_id, opened_session_date, opened_close, opened_line_value, open_reason, last_evaluated_session_date)
                   values ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000c1', 'discount', 'worldwide', '-4', '00000000-0000-0000-0000-0000000000f1', '2026-10-14', 85, 90, 'new_entry', '2026-10-14')$$,
                 '23505', 'duplicate key value violates unique constraint "signal_one_active_discount"', 'one active DISCOUNT per security and mode even across threshold lines');
select lives_ok($$insert into signal_episodes (security_id, company_id, kind, mode, threshold_line, opened_scan_run_id, opened_session_date, opened_close, opened_line_value, open_reason, last_evaluated_session_date)
                  values ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000c1', 'discount', 'us', '-3', '00000000-0000-0000-0000-0000000000f1', '2026-10-14', 99, 100, 'new_entry', '2026-10-14')$$,
                'the same security may have an active discount in the other mode');
select throws_ok($$update signal_episodes set status = 'closed' where id = '00000000-0000-0000-0000-0000000000e1'$$, '23514', null, 'a closed episode needs closed_session_date');
select lives_ok($$update signal_episodes set status = 'closed', closed_session_date = '2026-10-15', close_reason = 'close_above_threshold' where id = '00000000-0000-0000-0000-0000000000e1'$$,
                'closing with a date is accepted');
select lives_ok($$insert into signal_episodes (security_id, company_id, kind, mode, threshold_line, opened_scan_run_id, opened_session_date, opened_close, opened_line_value, open_reason, last_evaluated_session_date)
                  values ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000c1', 'discount', 'worldwide', '-3', '00000000-0000-0000-0000-0000000000f1', '2026-10-16', 98, 100, 'new_entry', '2026-10-16')$$,
                're-entry after a close opens a new episode');

select * from finish();
rollback;
```

**`supabase/tests/0110_rls.test.sql`**

```sql
begin;
select plan(29);

-- fixtures (inserted as the postgres role) ---------------------------------------------------------------
insert into auth.users (id, email) values ('00000000-0000-0000-0000-00000000aa01', 'user-a@example.test'),
                                           ('00000000-0000-0000-0000-00000000aa02', 'user-b@example.test'),
                                           ('00000000-0000-0000-0000-00000000aa03', 'admin@example.test');
insert into profiles (user_id, display_name, is_admin) values ('00000000-0000-0000-0000-00000000aa01', 'A', false),
                                                              ('00000000-0000-0000-0000-00000000aa02', 'B', false),
                                                              ('00000000-0000-0000-0000-00000000aa03', 'Root', true);
insert into companies (id, name, name_normalized) values ('00000000-0000-0000-0000-0000000000c1', 'Acme Corp', 'acme');
insert into securities (id, company_id, yahoo_symbol, exchange_code, currency, currency_major, quote_type, is_canonical)
values ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000c1', 'ACME', 'NMS', 'USD', 'USD', 'EQUITY', true);
insert into price_series (security_id, bar_dates, open, high, low, close, volume, bar_count, first_bar_date, last_bar_date, last_session_date, last_close, retrieved_at, last_full_refresh_at)
values ('00000000-0000-0000-0000-0000000000a1', '{1,2}', '{1,1}', '{2,2}', '{0,0}', '{1,2}', '{5,5}', 2, '1970-01-02', '1970-01-03', '1970-01-03', 2, now(), now());
insert into scan_runs (id, scan_date_local, settings_snapshot, errors_summary, code_version, results_published_at, list_published_at)
values ('00000000-0000-0000-0000-0000000000f1', '2026-10-15', '{"secret":"x"}', '{"e":1}', 'abc', now(), now());
insert into scan_jobs (scan_run_id, stage, key) values ('00000000-0000-0000-0000-0000000000f1', 'fx', 'all');
insert into scan_events (scan_run_id, level, event) values ('00000000-0000-0000-0000-0000000000f1', 'info', 'scan_started');
insert into quote_cache (key, payload, expires_at) values ('yahoo:session', '{"crumb":"x"}', now() + interval '1 hour');
insert into market_cap_snapshots (scan_run_id, security_id, currency_major, source, quality) values ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000a1', 'USD', 'yahoo_screener', 'ok');
insert into security_identity_overrides (kind, yahoo_symbol, reason) values ('exclude', 'ACME', 'test');
insert into audit_events (action) values ('test');
insert into scan_security_results (scan_run_id, security_id, scope, status, bars_hash) values ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000a1', 'universe', 'processed', 'h'),
  ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000a1', 'holding_only', 'processed', 'h2') on conflict do nothing;
insert into signal_episodes (id, security_id, company_id, kind, mode, threshold_line, opened_scan_run_id, opened_session_date, opened_close, opened_line_value, open_reason, last_evaluated_session_date)
values ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000c1', 'discount', 'worldwide', '-3', '00000000-0000-0000-0000-0000000000f1', '2026-10-14', 99, 100, 'new_entry', '2026-10-14'),
       ('00000000-0000-0000-0000-0000000000e2', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000c1', 'premium1', 'worldwide', '+1', '00000000-0000-0000-0000-0000000000f1', '2026-10-14', 121, 120, 'new_entry', '2026-10-14');
insert into todays_discounts (scan_run_id, mode, security_id, company_id, episode_id, is_new_episode, rank, close, currency, session_date, threshold_line, lower_line_end, channel, trend_ok,
                              eligibility, operational_category, category_reason, data_freshness, display_order, withheld)
values ('00000000-0000-0000-0000-0000000000f1', 'worldwide', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000e1', true, 1, 99, 'USD',
        '2026-10-14', '-3', 100, '{}', true, '{}', 'pending', 'research_pending', 'fresh', 1, true);

-- anonymous visitor --------------------------------------------------------------------------------------
set local role anon;
select throws_ok('select * from price_series', '42501', null, 'anon cannot select price_series as a whole');
select throws_ok('select bar_dates from price_series', '42501', null, 'anon cannot read the bar arrays');
select throws_ok('select close from price_series', '42501', null, 'anon cannot read the close array');
select is((select last_close from price_series), 2::float8, 'anon can read the denormalised last_close');
select throws_ok('select * from scan_jobs', '42501', null, 'anon cannot read scan_jobs');
select throws_ok('select * from scan_events', '42501', null, 'anon cannot read scan_events');
select throws_ok('select * from quote_cache', '42501', null, 'anon cannot read quote_cache (session and breaker state)');
select throws_ok('select * from market_cap_snapshots', '42501', null, 'anon cannot read market_cap_snapshots');
select throws_ok('select * from security_identity_overrides', '42501', null, 'anon cannot read identity overrides');
select throws_ok('select * from audit_events', '42501', null, 'anon cannot read audit_events');
select throws_ok('select * from profiles', '42501', null, 'anon cannot read profiles');
select throws_ok('select settings_snapshot from scan_runs', '42501', null, 'anon cannot read scan_runs.settings_snapshot');
select is((select count(*)::int from scan_runs), 1, 'anon can read the public scan_runs columns');
select is((select count(*)::int from app_settings where key = 'pipeline'), 0, 'anon cannot see the non-public pipeline setting');
select is((select count(*)::int from app_settings where key = 'indicator'), 1, 'anon can see the public indicator setting');
select is((select count(*)::int from scan_security_results), 1, 'anon sees universe-scope results only');
select throws_ok('select bars_hash from scan_security_results', '42501', null, 'anon cannot read bars_hash');
select is((select count(*)::int from signal_episodes), 1, 'anon sees discount episodes only (premium episodes would reveal holdings)');
select lives_ok('select * from v_todays_discounts', 'anon can read the public overview view');
select is((select count(*)::int from v_todays_discounts), 1, 'the view returns the published card');
select throws_ok($$update exchanges set name = 'x'$$, '42501', null, 'anon cannot update exchanges');
select throws_ok($$insert into fx_rates (rate_date, ccy, usd_per_unit, source) values ('2026-10-14', 'EUR', 1, 'yahoo')$$, '42501', null, 'anon cannot insert');
select throws_ok('select * from app.claim_jobs(''w'', 1, interval ''1 minute'', array[''fx'']::job_stage[])', '42501', null, 'anon cannot call app functions');
reset role;

-- authenticated, not an admin ------------------------------------------------------------------------------
select set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-00000000aa01', 'role', 'authenticated')::text, true);
set local role authenticated;
select is((select count(*)::int from profiles), 1, 'user A sees only the own profile row');
select throws_ok($$update profiles set is_admin = true where user_id = '00000000-0000-0000-0000-00000000aa01'$$, '42501', null, 'is_admin is not user-writable');
select throws_ok('select is_admin from profiles', '42501', null, 'is_admin is not selectable');
select is((select count(*)::int from scan_jobs), 0, 'a non-admin sees no scan_jobs rows');
select throws_ok($$update app_settings set value = '{}' where key = 'indicator'$$, '42501', null, 'a non-admin cannot update app_settings');
reset role;

-- admin ---------------------------------------------------------------------------------------------------
select set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-00000000aa03', 'role', 'authenticated')::text, true);
set local role authenticated;
select is((select count(*)::int from scan_jobs), 1, 'an admin reads scan_jobs');

select * from finish();
rollback;
```

**`supabase/tests/0120_pipeline.test.sql`**

```sql
begin;
select plan(95);

-- =====================================================================================================
-- app.start_daily_scan: DST-safe 10:00 Europe/Sofia start (7.2)
-- =====================================================================================================
select isnt(app.start_daily_scan('2026-03-29 07:00:00+00'), null, '2026-03-29 07:00Z (already EEST, 10:00 local) starts a scan');
select is((select count(*)::int from scan_runs where scan_date_local = '2026-03-29'), 1, 'one run for the spring change day');
select is(app.start_daily_scan('2026-03-29 08:00:00+00'), null, '2026-03-29 08:00Z (11:00 local) does nothing');
select is((select count(*)::int from scan_runs where scan_date_local = '2026-03-29'), 1, 'still exactly one run on 2026-03-29');

select is(app.start_daily_scan('2026-10-25 07:00:00+00'), null, '2026-10-25 07:00Z (09:00 EET) does nothing');
select is((select count(*)::int from scan_runs where scan_date_local = '2026-10-25'), 0, 'no run yet on the autumn change day');
select isnt(app.start_daily_scan('2026-10-25 08:00:00+00'), null, '2026-10-25 08:00Z (10:00 EET) starts a scan');
select is((select count(*)::int from scan_runs where scan_date_local = '2026-10-25'), 1, 'one run for the autumn change day');

select isnt(app.start_daily_scan('2026-07-15 07:00:00+00'), null, 'ordinary summer day: the 07:00Z entry starts');
select is(app.start_daily_scan('2026-07-15 08:00:00+00'), null, 'ordinary summer day: the 08:00Z entry returns null');
select is(app.start_daily_scan('2026-01-15 07:00:00+00'), null, 'ordinary winter day: the 07:00Z entry returns null');
select isnt(app.start_daily_scan('2026-01-15 08:00:00+00'), null, 'ordinary winter day: the 08:00Z entry starts');

select is(app.start_daily_scan('2026-07-15 07:00:00+00'), null, 'a second call for the same instant is an idempotent no-op');
select is((select count(*)::int from scan_runs where scan_date_local = '2026-07-15'), 1, 'still one run for 2026-07-15');
select is((select digest_cutoff_at from scan_runs where scan_date_local = '2026-07-15'), '2026-07-15 10:00:00+00'::timestamptz, 'summer cut-off is 13:00 EEST = 10:00Z');
select is((select digest_cutoff_at from scan_runs where scan_date_local = '2026-01-15'), '2026-01-15 11:00:00+00'::timestamptz, 'winter cut-off is 13:00 EET = 11:00Z');
select is((select scan_date_local from scan_runs where started_at = '2026-10-25 08:00:00+00'), '2026-10-25'::date, 'scan_date_local is the Sofia date');

select is((select count(*)::int from scan_jobs j join scan_runs r on r.id = j.scan_run_id where r.scan_date_local = '2026-07-15'), 1, 'only the fx job is seeded');
select is((select j.stage::text || ':' || j.key || ':' || j.priority from scan_jobs j join scan_runs r on r.id = j.scan_run_id where r.scan_date_local = '2026-07-15'), 'fx:all:10', 'fx job key and priority');
select is((select settings_snapshot -> 'indicator' ->> 'length' from scan_runs where scan_date_local = '2026-07-15'), '2500', 'settings are snapshotted');
select ok((select settings_snapshot ? 'pipeline' and settings_snapshot ? 'universe' from scan_runs where scan_date_local = '2026-07-15'), 'universe and pipeline settings are snapshotted too');
select is((select count(*)::int from scan_events e join scan_runs r on r.id = e.scan_run_id where r.scan_date_local = '2026-07-15' and e.event = 'scan_started'), 1, 'scan_started event');

select isnt(app.start_daily_scan('2026-11-02 05:00:00+00', true, 'manual', '{"provider_mode":"fixture","fixture_set":"day1"}'), null, 'a forced start works outside the Sofia hour');
select is((select settings_snapshot ->> 'provider_mode' from scan_runs where scan_date_local = '2026-11-02'), 'fixture', 'snapshot extra is merged (fixture mode marker)');
select is((select trigger from scan_runs where scan_date_local = '2026-11-02'), 'manual', 'manual trigger recorded');
select is(app.start_daily_scan('2026-11-02 05:30:00+00', true, 'manual'), null, 'a second forced start for the same date creates nothing');

select isnt(app.ensure_scan_today('2026-11-10 08:30:00+00'), null, 'catch-up at 10:30 local starts the missing scan');
select is((select trigger from scan_runs where scan_date_local = '2026-11-10'), 'cron_catchup', 'catch-up trigger recorded');
select is(app.ensure_scan_today('2026-11-10 09:30:00+00'), null, 'catch-up does nothing when the run exists');
select is(app.ensure_scan_today('2026-11-11 07:00:00+00'), null, 'catch-up does nothing at 09:00 local (too early)');
select is(app.ensure_scan_today('2026-11-11 11:30:00+00'), null, 'catch-up does nothing at 13:30 local (too late)');
select isnt(app.ensure_scan_today('2026-11-11 10:30:00+00'), null, 'catch-up works at 12:30 local');

-- =====================================================================================================
-- seed_stage and next_stage_to_seed
-- =====================================================================================================
insert into scan_runs (id, scan_date_local, settings_snapshot) values ('00000000-0000-0000-0000-0000000000a1', date '2030-01-01' + 20, '{}');
select is(app.next_stage_to_seed('00000000-0000-0000-0000-0000000000a1'), 'fx'::job_stage, 'a run without jobs starts with fx');
select is(app.seed_stage('00000000-0000-0000-0000-0000000000a1', 'fx', array['all']), 1, 'seed_stage inserts one job');
select is(app.next_stage_to_seed('00000000-0000-0000-0000-0000000000a1'), null, 'nothing is seeded while fx is open');
update scan_jobs set status = 'done' where scan_run_id = '00000000-0000-0000-0000-0000000000a1';
select is(app.next_stage_to_seed('00000000-0000-0000-0000-0000000000a1'), 'universe_sweep'::job_stage, 'universe_sweep follows a finished fx');
select is(app.seed_stage('00000000-0000-0000-0000-0000000000a1', 'universe_sweep', array['NMS','GER','HKG'], '[{"n":1},{"n":2},{"n":3}]'::jsonb, array[30,10,20]), 3, 'three sweep jobs seeded');
select is(app.seed_stage('00000000-0000-0000-0000-0000000000a1', 'universe_sweep', array['NMS','GER','HKG']), 0, 'seeding the same keys again creates nothing (idempotent)');
select is((select payload ->> 'n' from scan_jobs where scan_run_id = '00000000-0000-0000-0000-0000000000a1' and key = 'GER'), '2', 'payloads are aligned with keys');
select is((select priority from scan_jobs where scan_run_id = '00000000-0000-0000-0000-0000000000a1' and key = 'HKG'), 20, 'priorities are aligned with keys');
update scan_jobs set status = 'done' where scan_run_id = '00000000-0000-0000-0000-0000000000a1' and key <> 'GER';
select is(app.next_stage_to_seed('00000000-0000-0000-0000-0000000000a1'), null, 'one open sweep job blocks the next stage');
update scan_jobs set status = 'dead' where scan_run_id = '00000000-0000-0000-0000-0000000000a1' and key = 'GER';
select is(app.next_stage_to_seed('00000000-0000-0000-0000-0000000000a1'), 'identity'::job_stage, 'a dead non-critical job does not block the pipeline');
select is(app.seed_stage('00000000-0000-0000-0000-0000000000a1', 'identity', array[]::text[]), 0, 'an empty stage inserts a done marker');
select is((select status::text from scan_jobs where scan_run_id = '00000000-0000-0000-0000-0000000000a1' and stage = 'identity' and key = '_empty'), 'done', 'the _empty marker is done');
select is(app.next_stage_to_seed('00000000-0000-0000-0000-0000000000a1'), 'fetch_bars'::job_stage, 'the pipeline moves past an empty stage');

insert into scan_runs (id, scan_date_local, settings_snapshot) values ('00000000-0000-0000-0000-0000000000a2', date '2030-01-01' + 21, '{}');
insert into scan_jobs (scan_run_id, stage, key, status) values ('00000000-0000-0000-0000-0000000000a2', 'fx', 'all', 'dead');
select is(app.next_stage_to_seed('00000000-0000-0000-0000-0000000000a2'), null, 'a dead fx stops the pipeline');

-- =====================================================================================================
-- claim_jobs: stage caps, priorities, not_before, stage filter, leases
-- =====================================================================================================
-- claims are global across runs: neutralise the fx jobs that the start_daily_scan tests above created
update scan_jobs set status = 'done', lease_until = null where status in ('queued', 'leased', 'failed');
insert into scan_runs (id, scan_date_local, settings_snapshot) values ('00000000-0000-0000-0000-0000000000b1', date '2030-01-01' + 22, '{}');
select app.seed_stage('00000000-0000-0000-0000-0000000000b1', 'fetch_bars', array['bars:0','bars:1','bars:2','bars:3','bars:4']);
select app.seed_stage('00000000-0000-0000-0000-0000000000b1', 'compute', array['compute:0']);

select is((select count(*)::int from app.claim_jobs('worker-1', 5, interval '180 seconds', array['fetch_bars']::job_stage[], '{"fetch_bars":2}')), 2, 'the stage cap of 2 limits one claim');
select is((select count(*)::int from scan_jobs where scan_run_id = '00000000-0000-0000-0000-0000000000b1' and status = 'leased' and leased_by = 'worker-1' and attempts = 1), 2, 'claimed jobs are leased to the worker with attempts = 1');
select is((select count(*)::int from app.claim_jobs('worker-2', 5, interval '180 seconds', array['fetch_bars']::job_stage[], '{"fetch_bars":2}')), 0, 'a second worker cannot exceed the stage cap');
select is((select status::text from scan_runs where id = '00000000-0000-0000-0000-0000000000b1'), 'running', 'the first claim moves the run to running');
select is((select count(*)::int from app.claim_jobs('worker-2', 5, interval '180 seconds', array['compute']::job_stage[], '{"fetch_bars":2}')), 1, 'another stage is not blocked by the fetch_bars cap');
update scan_jobs set status = 'done', lease_until = null where scan_run_id = '00000000-0000-0000-0000-0000000000b1' and key = 'bars:0';
select is((select count(*)::int from app.claim_jobs('worker-2', 5, interval '180 seconds', array['fetch_bars']::job_stage[], '{"fetch_bars":2}')), 1, 'a finished job frees one slot');
select is((select count(*)::int from app.claim_jobs('worker-3', 5, interval '180 seconds', array['fetch_bars']::job_stage[])), 2, 'without a cap the remaining queued jobs are claimed, never one already leased');
select is((select count(distinct id)::int from scan_jobs where scan_run_id = '00000000-0000-0000-0000-0000000000b1' and status = 'leased'), 6 - 1 - 0, 'every job is leased to exactly one worker (no double claim)');

insert into scan_runs (id, scan_date_local, settings_snapshot) values ('00000000-0000-0000-0000-0000000000b2', date '2030-01-01' + 23, '{}');
select app.seed_stage('00000000-0000-0000-0000-0000000000b2', 'fetch_bars', array['a','b','c'], null, array[50,10,30]);
select is((select array_agg(key) from app.claim_jobs('w', 3, interval '1 minute', array['fetch_bars']::job_stage[])), array['b','c','a'], 'jobs are claimed in priority order');
update scan_jobs set status = 'queued', lease_until = null, leased_by = null, not_before = now() + interval '1 hour' where scan_run_id = '00000000-0000-0000-0000-0000000000b2' and key = 'a';
select is((select count(*)::int from app.claim_jobs('w', 3, interval '1 minute', array['fetch_bars']::job_stage[]) where key = 'a'), 0, 'not_before in the future is not claimable');

insert into scan_runs (id, scan_date_local, settings_snapshot) values ('00000000-0000-0000-0000-0000000000b3', date '2030-01-01' + 24, '{}');
select app.seed_stage('00000000-0000-0000-0000-0000000000b3', 'fx', array['all']);
select app.seed_stage('00000000-0000-0000-0000-0000000000b3', 'compute', array['c0']);
select is((select array_agg(stage::text) from app.claim_jobs('w', 5, interval '1 minute', array['fx']::job_stage[])), array['fx'], 'p_stages filters the claim to the listed stages');
update scan_jobs set status = 'done', lease_until = null where status in ('queued', 'leased', 'failed');

-- lease expiry and the reaper
insert into scan_runs (id, scan_date_local, settings_snapshot) values ('00000000-0000-0000-0000-0000000000b4', date '2030-01-01' + 25, '{}');
select app.seed_stage('00000000-0000-0000-0000-0000000000b4', 'compute', array['x']);
select app.claim_jobs('w-dead', 1, interval '180 seconds', array['compute']::job_stage[]) is not null;
update scan_jobs set lease_until = now() - interval '1 second' where scan_run_id = '00000000-0000-0000-0000-0000000000b4';
select is(app.reap_expired_leases(), 1, 'an expired lease is reaped');
select is((select status::text from scan_jobs where scan_run_id = '00000000-0000-0000-0000-0000000000b4'), 'queued', 'the reaped job is queued again');
select is((select count(*)::int from app.claim_jobs('w2', 1, interval '1 minute', array['compute']::job_stage[]) where scan_run_id = '00000000-0000-0000-0000-0000000000b4'), 0, 'the reaped job waits 30 seconds (not_before)');
update scan_jobs set not_before = now() - interval '1 second' where scan_run_id = '00000000-0000-0000-0000-0000000000b4';
select is((select attempts from app.claim_jobs('w2', 1, interval '1 minute', array['compute']::job_stage[]) where scan_run_id = '00000000-0000-0000-0000-0000000000b4'), 2, 'a recovered job is claimed again with attempts = 2');
update scan_jobs set lease_until = now() - interval '1 second', attempts = max_attempts where scan_run_id = '00000000-0000-0000-0000-0000000000b4';
select app.reap_expired_leases();
select is((select status::text from scan_jobs where scan_run_id = '00000000-0000-0000-0000-0000000000b4'), 'dead', 'a job whose lease expires at max_attempts becomes dead');

-- =====================================================================================================
-- fail_job, complete_job, defer_job
-- =====================================================================================================
insert into scan_runs (id, scan_date_local, settings_snapshot) values ('00000000-0000-0000-0000-0000000000c1', date '2030-01-01' + 26, '{}');
select app.seed_stage('00000000-0000-0000-0000-0000000000c1', 'compute', array['flaky']);
do $$
declare i int; v_id bigint;
begin
  select id into v_id from scan_jobs where scan_run_id = '00000000-0000-0000-0000-0000000000c1';
  for i in 1 .. 4 loop
    perform app.claim_jobs('w', 1, interval '1 minute', array['compute']::job_stage[]);
    perform app.fail_job(v_id, 'boom ' || i);
    update scan_jobs set not_before = now() - interval '1 second' where id = v_id;
    if i = 1 then
      perform set_config('test.after_first', (select extract(epoch from (not_before - now()))::text from scan_jobs where id = v_id), true);
    end if;
  end loop;
end $$;
select is((select status::text || ':' || attempts from scan_jobs where scan_run_id = '00000000-0000-0000-0000-0000000000c1'), 'failed:4', 'four failures leave the job retryable');
select app.claim_jobs('w', 1, interval '1 minute', array['compute']::job_stage[]);
select is(app.fail_job((select id from scan_jobs where scan_run_id = '00000000-0000-0000-0000-0000000000c1'), 'boom 5'), 'dead'::job_status, 'the fifth failure (max_attempts = 5) is dead');
select is((select last_error from scan_jobs where scan_run_id = '00000000-0000-0000-0000-0000000000c1'), 'boom 5', 'the error is recorded');

insert into scan_runs (id, scan_date_local, settings_snapshot) values ('00000000-0000-0000-0000-0000000000c2', date '2030-01-01' + 27, '{}');
select app.seed_stage('00000000-0000-0000-0000-0000000000c2', 'compute', array['a','b','c']);
select app.claim_jobs('w', 3, interval '1 minute', array['compute']::job_stage[]);
select is(app.fail_job((select id from scan_jobs where scan_run_id = '00000000-0000-0000-0000-0000000000c2' and key = 'a'), 'e'), 'failed'::job_status, 'a first failure schedules a retry');
select ok((select not_before between now() + interval '59 seconds' and now() + interval '76 seconds' from scan_jobs where scan_run_id = '00000000-0000-0000-0000-0000000000c2' and key = 'a'), 'the first backoff is 1 minute plus up to 25% jitter');
select is(app.fail_job((select id from scan_jobs where scan_run_id = '00000000-0000-0000-0000-0000000000c2' and key = 'b'), 'fatal config', null, true), 'dead'::job_status, 'a fatal failure is dead at once');
select is(app.fail_job((select id from scan_jobs where scan_run_id = '00000000-0000-0000-0000-0000000000c2' and key = 'c'), 'e', interval '10 seconds'), 'failed'::job_status, 'an explicit retry interval is accepted');
select ok((select not_before between now() + interval '9 seconds' and now() + interval '11 seconds' from scan_jobs where scan_run_id = '00000000-0000-0000-0000-0000000000c2' and key = 'c'), 'the explicit interval is used');

insert into scan_runs (id, scan_date_local, settings_snapshot) values ('00000000-0000-0000-0000-0000000000c3', date '2030-01-01' + 28, '{}');
select app.seed_stage('00000000-0000-0000-0000-0000000000c3', 'compute', array['x','y']);
select app.claim_jobs('w', 2, interval '1 minute', array['compute']::job_stage[]);
select app.complete_job((select id from scan_jobs where scan_run_id = '00000000-0000-0000-0000-0000000000c3' and key = 'x'), '{"ok":true}');
select is((select status::text || ':' || (result ->> 'ok') from scan_jobs where scan_run_id = '00000000-0000-0000-0000-0000000000c3' and key = 'x'), 'done:true', 'complete_job stores the result');
update scan_jobs set status = 'queued', lease_until = null where scan_run_id = '00000000-0000-0000-0000-0000000000c3' and key = 'y';
select app.complete_job((select id from scan_jobs where scan_run_id = '00000000-0000-0000-0000-0000000000c3' and key = 'y'), '{}');
select is((select status::text from scan_jobs where scan_run_id = '00000000-0000-0000-0000-0000000000c3' and key = 'y'), 'queued', 'a job that lost its lease cannot be completed by the old worker');
select app.claim_jobs('w', 1, interval '1 minute', array['compute']::job_stage[]);
select app.defer_job((select id from scan_jobs where scan_run_id = '00000000-0000-0000-0000-0000000000c3' and key = 'y'), interval '90 seconds', 'breaker_open');
select is((select status::text || ':' || attempts || ':' || last_error from scan_jobs where scan_run_id = '00000000-0000-0000-0000-0000000000c3' and key = 'y'), 'queued:1:breaker_open', 'defer_job requeues without consuming an attempt');
select ok((select not_before > now() + interval '80 seconds' from scan_jobs where scan_run_id = '00000000-0000-0000-0000-0000000000c3' and key = 'y'), 'defer_job sets not_before');

-- =====================================================================================================
-- refresh_scan_status (7.6)
-- =====================================================================================================
create temp table stages(stage job_stage, ord int);
insert into stages values ('fx',1),('universe_sweep',2),('identity',3),('fetch_bars',4),('compute',5),('rank_signals',6),('classify',7),('publish',8);

create function pg_temp.mk_run(p_id uuid, p_offset int, p_coverage jsonb default '{}', p_cutoff timestamptz default null, p_date date default null) returns void language sql as $$
  insert into scan_runs (id, scan_date_local, settings_snapshot, coverage, digest_cutoff_at) values (p_id, coalesce(p_date, date '2030-01-01' + p_offset), '{}', p_coverage, p_cutoff)
$$;
create function pg_temp.mk_all_done(p_id uuid) returns void language sql as $$
  insert into scan_jobs (scan_run_id, stage, key, status, attempts, finished_at) select p_id, stage, 'k', 'done', 1, now() from stages
$$;

select pg_temp.mk_run('00000000-0000-0000-0000-0000000000d1', 30);
select pg_temp.mk_all_done('00000000-0000-0000-0000-0000000000d1');
select is(app.refresh_scan_status('00000000-0000-0000-0000-0000000000d1'), 'complete'::scan_status, 'every job done, none dead, no coverage gap: complete');
select ok((select finished_at is not null from scan_runs where id = '00000000-0000-0000-0000-0000000000d1'), 'complete sets finished_at');
select ok((select count(*) = 1 from scan_events where scan_run_id = '00000000-0000-0000-0000-0000000000d1' and event = 'scan_status_changed'), 'a status change is logged once');
select app.refresh_scan_status('00000000-0000-0000-0000-0000000000d1');
select ok((select count(*) = 1 from scan_events where scan_run_id = '00000000-0000-0000-0000-0000000000d1' and event = 'scan_status_changed'), 'refreshing again logs nothing');

select pg_temp.mk_run('00000000-0000-0000-0000-0000000000d2', 31);
select pg_temp.mk_all_done('00000000-0000-0000-0000-0000000000d2');
insert into scan_jobs (scan_run_id, stage, key, status, attempts) values ('00000000-0000-0000-0000-0000000000d2', 'universe_sweep', 'SAU', 'dead', 5);
select is(app.refresh_scan_status('00000000-0000-0000-0000-0000000000d2'), 'partial'::scan_status, 'a dead non-critical job makes a terminal run partial');
select ok((select finished_at is not null from scan_runs where id = '00000000-0000-0000-0000-0000000000d2'), 'a terminal partial run has finished_at');

select pg_temp.mk_run('00000000-0000-0000-0000-0000000000d3', 32);
select pg_temp.mk_all_done('00000000-0000-0000-0000-0000000000d3');
update scan_jobs set status = 'dead' where scan_run_id = '00000000-0000-0000-0000-0000000000d3' and stage = 'rank_signals';
select is(app.refresh_scan_status('00000000-0000-0000-0000-0000000000d3'), 'failed'::scan_status, 'a dead rank_signals job fails the run');

select pg_temp.mk_run('00000000-0000-0000-0000-0000000000d4', 33);
insert into scan_jobs (scan_run_id, stage, key, status, attempts) values ('00000000-0000-0000-0000-0000000000d4', 'fx', 'all', 'done', 1), ('00000000-0000-0000-0000-0000000000d4', 'universe_sweep', 'NMS', 'leased', 1);
select is(app.refresh_scan_status('00000000-0000-0000-0000-0000000000d4'), 'running'::scan_status, 'open jobs before the soft deadline: running');
select ok((select finished_at is null from scan_runs where id = '00000000-0000-0000-0000-0000000000d4'), 'a running scan has no finished_at');

select pg_temp.mk_run('00000000-0000-0000-0000-0000000000d5', 34);
insert into scan_jobs (scan_run_id, stage, key) values ('00000000-0000-0000-0000-0000000000d5', 'fx', 'all');
select is(app.refresh_scan_status('00000000-0000-0000-0000-0000000000d5'), 'queued'::scan_status, 'nothing leased yet: queued');

select pg_temp.mk_run('00000000-0000-0000-0000-0000000000d6', 35);
insert into scan_jobs (scan_run_id, stage, key, status, attempts) values ('00000000-0000-0000-0000-0000000000d6', 'fx', 'all', 'done', 1);
select is(app.refresh_scan_status('00000000-0000-0000-0000-0000000000d6'), 'running'::scan_status, 'between stages (later stages not seeded yet) the run is still running, never complete');

select pg_temp.mk_run('00000000-0000-0000-0000-0000000000d7', 36, '{}', now() - interval '1 hour');
insert into scan_jobs (scan_run_id, stage, key, status, attempts) values ('00000000-0000-0000-0000-0000000000d7', 'fx', 'all', 'done', 1), ('00000000-0000-0000-0000-0000000000d7', 'universe_sweep', 'NMS', 'queued', 0);
select is(app.refresh_scan_status('00000000-0000-0000-0000-0000000000d7'), 'partial'::scan_status, 'the soft deadline passed with open jobs: partial');
select ok((select finished_at is null from scan_runs where id = '00000000-0000-0000-0000-0000000000d7'), 'a partial run with open jobs is not finished');
update scan_jobs set status = 'done' where scan_run_id = '00000000-0000-0000-0000-0000000000d7';
insert into scan_jobs (scan_run_id, stage, key, status, attempts) select '00000000-0000-0000-0000-0000000000d7', stage, 'k', 'done', 1 from stages where stage not in ('fx', 'universe_sweep');
select is(app.refresh_scan_status('00000000-0000-0000-0000-0000000000d7'), 'complete'::scan_status, 'a partial run becomes complete when the remaining jobs finish with no dead job');

select pg_temp.mk_run('00000000-0000-0000-0000-0000000000d8', 0, '{}', null, '2020-01-01');
insert into scan_jobs (scan_run_id, stage, key, status, attempts) values ('00000000-0000-0000-0000-0000000000d8', 'fx', 'all', 'done', 1), ('00000000-0000-0000-0000-0000000000d8', 'universe_sweep', 'NMS', 'leased', 1), ('00000000-0000-0000-0000-0000000000d8', 'universe_sweep', 'GER', 'queued', 0);
select is(app.refresh_scan_status('00000000-0000-0000-0000-0000000000d8'), 'failed'::scan_status, 'the hard deadline passed before rank_signals finished: failed');
select is((select count(*)::int from scan_jobs where scan_run_id = '00000000-0000-0000-0000-0000000000d8' and status = 'dead' and last_error = 'deadline'), 2, 'remaining jobs are set dead with last_error = deadline');

select pg_temp.mk_run('00000000-0000-0000-0000-0000000000d9', 37, '{"candidates":{"total":10,"processed":9,"failed":1,"unprocessed":0,"stale":0,"carried_forward":0,"insufficient_data":0}}');
select pg_temp.mk_all_done('00000000-0000-0000-0000-0000000000d9');
select is(app.refresh_scan_status('00000000-0000-0000-0000-0000000000d9'), 'partial'::scan_status, 'a failed security is a coverage gap: partial');

select pg_temp.mk_run('00000000-0000-0000-0000-0000000000da', 38, '{"candidates":{"total":10,"processed":7,"failed":0,"unprocessed":0,"stale":0,"carried_forward":0,"insufficient_data":3}}');
select pg_temp.mk_all_done('00000000-0000-0000-0000-0000000000da');
select is(app.refresh_scan_status('00000000-0000-0000-0000-0000000000da'), 'complete'::scan_status, 'insufficient_data is legitimate (short history), not a gap: complete');

select pg_temp.mk_run('00000000-0000-0000-0000-0000000000db', 39, '{"candidates":{"unprocessed":2}}');
select pg_temp.mk_all_done('00000000-0000-0000-0000-0000000000db');
select is(app.refresh_scan_status('00000000-0000-0000-0000-0000000000db'), 'partial'::scan_status, 'unprocessed candidates are a gap: partial');

-- a fixture run replays an old date: its deadlines are judged against its own start, so it is neither failed nor partial because of the real clock
insert into scan_runs (id, scan_date_local, settings_snapshot, started_at, digest_cutoff_at) values ('00000000-0000-0000-0000-0000000000dc', '2020-01-02', '{"provider_mode":"fixture"}', '2020-01-02 08:00+00', '2020-01-02 10:00+00');
insert into scan_jobs (scan_run_id, stage, key, status, attempts) values ('00000000-0000-0000-0000-0000000000dc', 'fx', 'all', 'done', 1), ('00000000-0000-0000-0000-0000000000dc', 'universe_sweep', 'NMS', 'leased', 1);
select is(app.refresh_scan_status('00000000-0000-0000-0000-0000000000dc'), 'running'::scan_status, 'a fixture run on a past date is still running (deadlines use its own clock)');
select is((select count(*)::int from scan_jobs where scan_run_id = '00000000-0000-0000-0000-0000000000dc' and status = 'dead'), 0, 'and none of its jobs is killed by the real hard deadline');

select * from finish();
rollback;
```

**`supabase/tests/0130_public_reads.test.sql`**

```sql
begin;
select plan(45);

-- fixtures: 40 companies ranked 1..40 in a list-published run ---------------------------------------------------
create function pg_temp.uid(p_kind int, p_i int) returns uuid language sql immutable as $$
  select ('00000000-0000-0000-' || lpad(p_kind::text, 4, '0') || '-' || lpad(p_i::text, 12, '0'))::uuid
$$;

insert into companies (id, name, name_normalized) select pg_temp.uid(1, i), 'Company ' || lpad(i::text, 2, '0'), 'company ' || lpad(i::text, 2, '0') from generate_series(1, 45) i;
insert into securities (id, company_id, yahoo_symbol, exchange_code, currency, currency_major, quote_type, is_canonical)
select pg_temp.uid(2, i), pg_temp.uid(1, i), 'S' || lpad(i::text, 2, '0'), 'NMS', 'USD', 'USD', 'EQUITY', true from generate_series(1, 45) i;

insert into scan_runs (id, scan_date_local, status, settings_snapshot, started_at, finished_at, results_published_at, list_published_at, latest_session_date)
values (pg_temp.uid(3, 1), '2026-10-13', 'complete', '{}', '2026-10-13 07:00+00', '2026-10-13 07:40+00', '2026-10-13 07:40+00', '2026-10-13 07:40+00', '2026-10-12'),
       (pg_temp.uid(3, 2), '2026-10-14', 'partial',  '{}', '2026-10-14 07:00+00', '2026-10-14 07:50+00', '2026-10-14 07:50+00', '2026-10-14 07:50+00', '2026-10-13');

insert into universe_snapshots (scan_run_id, mode, security_id, company_id, rank, market_cap_usd, is_top10, applicable_line, lower_line_end, close, session_date, lower_line_positive, is_discount)
select pg_temp.uid(3, 2), 'worldwide', pg_temp.uid(2, i), pg_temp.uid(1, i), i, (100 - i) * 1e9, i <= 10, case when i <= 10 then '-3' else '-4' end::threshold_line, 10, 12, '2026-10-13', true, false
  from generate_series(1, 40) i;

insert into price_series (security_id, bar_dates, open, high, low, close, volume, bar_count, first_bar_date, last_bar_date, last_session_date, last_close, prev_close, retrieved_at, last_full_refresh_at, freshness)
values (pg_temp.uid(2, 1), '{1,2}', '{1,1}', '{2,2}', '{0,0}', '{1,2}', '{5,5}', 2, '1970-01-02', '1970-01-03', '2026-10-13', 110, 100, now(), now(), 'fresh');
insert into market_cap_snapshots (scan_run_id, security_id, market_cap_native, currency_major, source, quality)
values (pg_temp.uid(3, 2), pg_temp.uid(2, 1), 9.9e10, 'USD', 'yahoo_screener', 'ok');

-- company_list as an anonymous visitor ------------------------------------------------------------------------
set local role anon;
select is((select count(*)::int from company_list('worldwide')), 15, 'the first page has 15 rows');
select is((select array_agg(rank order by rank) from company_list('worldwide')), (select array_agg(i order by i) from generate_series(1, 15) i), 'the first page is ranks 1..15 in order');
select is((select min(total_count) from company_list('worldwide')), 40::bigint, 'total_count is the list size on the first page');
select is((select array_agg(rank order by rank) from company_list('worldwide', 25, 15)), (select array_agg(i order by i) from generate_series(16, 40) i), 'Load more after rank 15 with 25 rows gives ranks 16..40');
select is((select count(*)::int from company_list('worldwide', 25, 40)), 0, 'nothing after the last rank');
select is((select min(total_count) from company_list('worldwide', 25, 15)), 25::bigint, 'total_count counts the rows after the cursor');
select is((select count(*)::int from company_list('worldwide', 1000)), 40, 'a page is clamped to 100 rows, so 40 rows come back');
select is((select count(*)::int from company_list('worldwide', 0)), 1, 'a limit of 0 is raised to 1');
select is((select count(*)::int from (select rank from company_list('worldwide') union select rank from company_list('worldwide', 25, 15)) u), 40, 'two pages are complete and disjoint');
select is((select count(*)::int from company_list('us')), 0, 'the us mode has no rows here');
select is((select is_top10::text || ':' || applicable_line::text from company_list('worldwide', 1, 9)), 'true:-3', 'rank 10 is top 10 with the -3 line');
select is((select is_top10::text || ':' || applicable_line::text from company_list('worldwide', 1, 10)), 'false:-4', 'rank 11 is not top 10 and uses the -4 line');
select is((select round(change_pct::numeric, 6) from company_list('worldwide', 1)), 10.000000, 'change_pct is last close vs previous close');
select is((select market_cap_native::text || ' ' || market_cap_ccy from company_list('worldwide', 1)), '99000000000 USD', 'native market cap and currency come from the latest snapshot');
select is((select yahoo_symbol || ' ' || name from company_list('worldwide', 1)), 'S01 Company 01', 'symbol and name are joined');
select is((select count(*)::int from company_list('worldwide', 1) where last_close is not null), 1, 'last_close is read without array access');
reset role;

-- the latest LIST-PUBLISHED run wins; an unpublished newer run is ignored
insert into scan_runs (id, scan_date_local, status, settings_snapshot, started_at, results_published_at, list_published_at)
values (pg_temp.uid(3, 3), '2026-10-15', 'running', '{}', '2026-10-15 07:00+00', null, null);
insert into universe_snapshots (scan_run_id, mode, security_id, company_id, rank, market_cap_usd, is_top10, applicable_line)
select pg_temp.uid(3, 3), 'worldwide', pg_temp.uid(2, i), pg_temp.uid(1, i), i, 1, true, '-3' from generate_series(41, 43) i;
set local role anon;
select is((select count(*)::int from company_list('worldwide', 100)), 40, 'an unpublished newer run does not replace the published list');
reset role;
update scan_runs set list_published_at = now(), results_published_at = now() where id = pg_temp.uid(3, 3);
set local role anon;
select is((select count(*)::int from company_list('worldwide', 100)), 3, 'once published, the newest run is the list');
reset role;
update scan_runs set list_published_at = null, results_published_at = null where id = pg_temp.uid(3, 3);

-- universe_summary ----------------------------------------------------------------------------------------
insert into universe_membership_events (scan_run_id, event_date, mode, company_id, security_id, event, reason) values
  (pg_temp.uid(3, 2), '2026-10-14', 'worldwide', pg_temp.uid(1, 41), pg_temp.uid(2, 41), 'added',   'new_listing'),
  (pg_temp.uid(3, 2), '2026-10-14', 'worldwide', pg_temp.uid(1, 42), pg_temp.uid(2, 42), 'removed', 'market_cap_below_threshold'),
  (pg_temp.uid(3, 1), '2026-10-13', 'worldwide', pg_temp.uid(1, 43), pg_temp.uid(2, 43), 'added',   'new_listing'),
  (pg_temp.uid(3, 1), '2026-10-05', 'worldwide', pg_temp.uid(1, 44), pg_temp.uid(2, 44), 'added',   'new_listing'),
  (pg_temp.uid(3, 1), '2026-10-13', 'us',        pg_temp.uid(1, 45), pg_temp.uid(2, 45), 'added',   'new_listing');
set local role anon;
select is(public.universe_summary('worldwide') ->> 'as_of', '2026-10-14', 'the summary is as of the latest list-published run');
select is(public.universe_summary('worldwide') -> 'added_today' -> 0 ->> 'name', 'Company 41', 'added today');
select is(jsonb_array_length(public.universe_summary('worldwide') -> 'added_today'), 1, 'exactly one company added today');
select is(public.universe_summary('worldwide') -> 'removed_today' -> 0 ->> 'name', 'Company 42', 'removed today');
select is((select array_agg(e ->> 'name' order by e ->> 'name') from jsonb_array_elements(public.universe_summary('worldwide') -> 'added_7d') e), array['Company 41', 'Company 43'], 'the trailing 7 days include yesterday and exclude events older than 7 days');
select is(public.universe_summary('worldwide') -> 'added_7d' -> 0 ->> 'date', '2026-10-14', 'added_7d is ordered by most recent date first');
select is(jsonb_array_length(public.universe_summary('us') -> 'added_today'), 0, 'the us summary does not see worldwide events');
select is(public.universe_summary('us') -> 'added_7d' -> 0 ->> 'name', 'Company 45', 'the us summary has its own events');
reset role;

-- scan_status: three separate timestamps ----------------------------------------------------------------------
set local role anon;
select is(public.scan_status() -> 'last_attempted' ->> 'scan_date_local', '2026-10-15', 'last attempted is the newest run even though it is unpublished and running');
select is(public.scan_status() -> 'last_attempted' ->> 'status', 'running', 'and its status is reported honestly');
select is(public.scan_status() -> 'last_successful' ->> 'scan_date_local', '2026-10-13', 'last successful is the newest COMPLETE run (the partial 10-14 run does not count)');
select is(public.scan_status() -> 'latest_published' ->> 'scan_date_local', '2026-10-14', 'latest published is the newest run with published results');
select is(public.scan_status() -> 'latest_published' ->> 'latest_session_date', '2026-10-13', 'with the latest trading session date it represents');
reset role;

-- get_price_series: arrays only through the function ------------------------------------------------------------
set local role anon;
select throws_ok('select bar_dates from price_series', '42501', null, 'the arrays are not directly selectable');
select is((select bar_dates from public.get_price_series(pg_temp.uid(2, 1))), '{1,2}'::int4[], 'get_price_series returns the arrays of one security');
select is((select security_id from public.get_price_series(pg_temp.uid(2, 9))), null, 'an unknown security returns an empty (all-null) row');
reset role;

-- todays_discounts_feed ordering --------------------------------------------------------------------------------
insert into signal_episodes (id, security_id, company_id, kind, mode, threshold_line, opened_scan_run_id, opened_session_date, opened_close, opened_line_value, open_reason, last_evaluated_session_date)
select pg_temp.uid(4, i), pg_temp.uid(2, i), pg_temp.uid(1, i), 'discount', 'worldwide', '-3', pg_temp.uid(3, 2), '2026-10-13', 9, 10, 'new_entry', '2026-10-13' from generate_series(1, 5) i;
insert into todays_discounts (scan_run_id, mode, security_id, company_id, episode_id, is_new_episode, rank, close, currency, session_date, threshold_line, lower_line_end, channel, trend_ok, eligibility,
                              operational_category, category_reason, data_freshness, display_order, withheld) values
  (pg_temp.uid(3, 2), 'worldwide', pg_temp.uid(2, 1), pg_temp.uid(1, 1), pg_temp.uid(4, 1), true, 1, 9, 'USD', '2026-10-13', '-3', 10, '{}', true, '{}', 'grey',  'inconclusive',  'fresh', 1, true),
  (pg_temp.uid(3, 2), 'worldwide', pg_temp.uid(2, 2), pg_temp.uid(1, 2), pg_temp.uid(4, 2), true, 2, 9, 'USD', '2026-10-13', '-3', 10, '{}', true, '{}', 'green', 'meets_checks', 'fresh', 5, false),
  (pg_temp.uid(3, 2), 'worldwide', pg_temp.uid(2, 3), pg_temp.uid(1, 3), pg_temp.uid(4, 3), true, 3, 9, 'USD', '2026-10-13', '-3', 10, '{}', true, '{}', 'amber', 'moderate_risk', 'fresh', 1, false),
  (pg_temp.uid(3, 2), 'worldwide', pg_temp.uid(2, 4), pg_temp.uid(1, 4), pg_temp.uid(4, 4), true, 4, 9, 'USD', '2026-10-13', '-3', 10, '{}', true, '{}', 'green', 'meets_checks', 'fresh', 2, false),
  (pg_temp.uid(3, 2), 'us',        pg_temp.uid(2, 5), pg_temp.uid(1, 5), pg_temp.uid(4, 5), true, 1, 9, 'USD', '2026-10-13', '-3', 10, '{}', true, '{}', 'pending', 'research_pending', 'fresh', 1, true);
set local role anon;
select is((select array_agg(rank order by ord) from (select rank, row_number() over () as ord from public.todays_discounts_feed('worldwide')) f), array[4, 2, 3, 1], 'the feed lists cleared green, then amber, then withheld, by display_order');
select is((select count(*)::int from public.todays_discounts_feed('us')), 1, 'the feed is per mode');
select is((select since_date from public.v_todays_discounts where rank = 2 and mode = 'worldwide'), '2026-10-13'::date, 'since_date comes from the episode');
reset role;

-- purge_expired ------------------------------------------------------------------------------------------------
insert into scan_events (at, level, event) values (now() - interval '31 days', 'info', 'old'), (now() - interval '29 days', 'info', 'recent');
insert into scan_jobs (scan_run_id, stage, key, status, created_at) values
  (pg_temp.uid(3, 1), 'fx', 'old-done', 'done', now() - interval '31 days'),
  (pg_temp.uid(3, 1), 'fx', 'old-dead', 'dead', now() - interval '40 days'),
  (pg_temp.uid(3, 1), 'fx', 'old-queued', 'queued', now() - interval '40 days'),
  (pg_temp.uid(3, 1), 'fx', 'new-done', 'done', now() - interval '2 days');
insert into quote_cache (key, payload, fetched_at, expires_at) values
  ('expired', '{}', now() - interval '2 hours', now() - interval '1 hour'),
  ('stale-but-unexpired', '{}', now() - interval '2 days', now() + interval '1 day'),
  ('fresh', '{}', now(), now() + interval '1 hour');
insert into universe_membership_events (scan_run_id, event_date, mode, company_id, event, reason) values
  (pg_temp.uid(3, 1), (now() at time zone 'Europe/Sofia')::date - 91, 'us', pg_temp.uid(1, 10), 'added', 'new_listing'),
  (pg_temp.uid(3, 1), (now() at time zone 'Europe/Sofia')::date - 5,  'us', pg_temp.uid(1, 11), 'added', 'new_listing');
select is(app.purge_expired(), '{"scan_events":1,"scan_jobs":2,"quote_cache":2,"universe_membership_events":1}'::jsonb, 'purge_expired reports what it deleted');
select is((select count(*)::int from scan_events where event in ('old', 'recent')), 1, 'only the recent event survives');
select is((select array_agg(key order by key) from scan_jobs where key like 'old-%' or key like 'new-%'), array['new-done', 'old-queued'], 'old terminal jobs are purged; a queued job is never purged');
select is((select array_agg(key order by key) from quote_cache), array['fresh'], 'expired and day-old cache rows are purged');
select is((select count(*)::int from universe_membership_events where event_date < (now() at time zone 'Europe/Sofia')::date - 30), 0, 'membership events older than 90 days are gone');
select is(app.purge_expired(), '{"scan_events":0,"scan_jobs":0,"quote_cache":0,"universe_membership_events":0}'::jsonb, 'a second purge is a no-op (idempotent)');
select is((select count(*)::int from signal_episodes), 5, 'purging never touches signal episodes');
select is((select count(*)::int from todays_discounts), 5, 'purging never touches todays_discounts');

select * from finish();
rollback;
```

**`supabase/tests/0140_data_functions.test.sql`**

```sql
begin;
select plan(32);

insert into scan_runs (id, scan_date_local, settings_snapshot) values ('00000000-0000-0000-0000-0000000000f1', '2030-02-01', '{}');

create function pg_temp.row(p_symbol text, p_exchange text, p_cap float8, p_extra jsonb default '{}') returns jsonb language sql as $$
  select jsonb_build_object('yahoo_symbol', p_symbol, 'new_company_id', gen_random_uuid(), 'name', p_symbol || ' Corp', 'name_normalized', lower(p_symbol),
         'exchange_code', p_exchange, 'currency', 'USD', 'currency_major', 'USD', 'minor_divisor', 1, 'quote_type', 'EQUITY', 'long_name', p_symbol || ' Corp',
         'financial_currency', 'USD', 'shares_outstanding', 1000, 'first_trade_date', '1999-01-22', 'market_cap_native', p_cap, 'fx_usd_per_unit', 1,
         'fx_rate_date', '2030-01-31', 'fx_source', 'frankfurter', 'market_cap_usd', p_cap, 'price_time', '2030-01-31T21:00:00Z', 'source', 'yahoo_screener',
         'quality', 'ok') || p_extra
$$;

-- apply_quote_rows -------------------------------------------------------------------------------------------
select is(app.apply_quote_rows('00000000-0000-0000-0000-0000000000f1', jsonb_build_array(pg_temp.row('AAA', 'NMS', 6e10), pg_temp.row('BBB', 'GER', 5e10))),
          '{"created":2,"updated":0,"snapshots":2,"skipped_unknown_exchange":0}'::jsonb, 'two new securities are created with their snapshots');
select is((select count(*)::int from securities where yahoo_symbol in ('AAA', 'BBB')), 2, 'securities exist');
select is((select count(*)::int from companies c join securities s on s.company_id = c.id where s.yahoo_symbol = 'AAA' and c.name = 'AAA Corp'), 1, 'a provisional company was created for AAA');
select is((select (select count(*)::int from securities s2 where s2.company_id = s.company_id) from securities s where s.yahoo_symbol = 'AAA'), 1, 'every new security starts alone in its company');
select is((select market_cap_usd from market_cap_snapshots m join securities s on s.id = m.security_id where s.yahoo_symbol = 'AAA'), 6e10::float8, 'the snapshot carries the USD market cap');
select is((select first_trade_date from securities where yahoo_symbol = 'AAA'), '1999-01-22'::date, 'first_trade_date stored');

select is(app.apply_quote_rows('00000000-0000-0000-0000-0000000000f1', jsonb_build_array(pg_temp.row('AAA', 'NMS', 7e10, '{"source":"yahoo_quote","long_name":null,"shares_outstanding":null}'))),
          '{"created":0,"updated":1,"snapshots":1,"skipped_unknown_exchange":0}'::jsonb, 'a second call updates instead of duplicating (idempotent)');
select is((select count(*)::int from securities where yahoo_symbol = 'AAA'), 1, 'still one AAA security');
select is((select count(*)::int from companies where name = 'AAA Corp'), 1, 'no second company for a known security');
select is((select market_cap_usd from market_cap_snapshots m join securities s on s.id = m.security_id where s.yahoo_symbol = 'AAA'), 7e10::float8, 'the snapshot of the run is replaced');
select is((select source from market_cap_snapshots m join securities s on s.id = m.security_id where s.yahoo_symbol = 'AAA'), 'yahoo_quote', 'with its new source');
select is((select long_name || ' ' || shares_outstanding from securities where yahoo_symbol = 'AAA'), 'AAA Corp 1000', 'a missing value never nulls a known one');

select is(app.apply_quote_rows('00000000-0000-0000-0000-0000000000f1', jsonb_build_array(pg_temp.row('ZZZ', 'NOPE', 1e10))),
          '{"created":0,"updated":0,"snapshots":0,"skipped_unknown_exchange":1}'::jsonb, 'an unknown exchange code is skipped, not an error');
select is((select count(*)::int from securities where yahoo_symbol = 'ZZZ'), 0, 'nothing is created for it');

select is(app.apply_quote_rows('00000000-0000-0000-0000-0000000000f1', jsonb_build_array(pg_temp.row('SHEL.L', 'LSE', 2.2e11, '{"currency":"GBp","currency_major":"GBP","minor_divisor":100,"fx_usd_per_unit":1.325,"market_cap_usd":2.9e11}'))) ->> 'created', '1', 'a GBp listing is created');
select is((select currency || '/' || currency_major || '/' || minor_divisor from securities where yahoo_symbol = 'SHEL.L'), 'GBp/GBP/100', 'minor unit, major unit and divisor are stored');
select is((select market_cap_native from market_cap_snapshots m join securities s on s.id = m.security_id where s.yahoo_symbol = 'SHEL.L'), 2.2e11::float8, 'the native market cap is stored as reported (GBP, not divided)');

update securities set status = 'delisted', missing_scans = 3 where yahoo_symbol = 'BBB';
select app.apply_quote_rows('00000000-0000-0000-0000-0000000000f1', jsonb_build_array(pg_temp.row('BBB', 'GER', 5e10)));
select is((select status || ':' || missing_scans from securities where yahoo_symbol = 'BBB'), 'active:0', 'seeing a security again reactivates it and resets missing_scans');

-- apply_identity_groups --------------------------------------------------------------------------------------
select app.apply_quote_rows('00000000-0000-0000-0000-0000000000f1', jsonb_build_array(pg_temp.row('MSFT', 'NMS', 4e12), pg_temp.row('MSF.DE', 'GER', 3.9e12), pg_temp.row('MSF.F', 'GER', 3.9e12)));
create temp table ids as select yahoo_symbol, id, company_id from securities where yahoo_symbol in ('MSFT', 'MSF.DE', 'MSF.F');
create temp table g as select jsonb_build_array(jsonb_build_object(
  'company_id', (select company_id from ids where yahoo_symbol = 'MSFT'),
  'member_ids', (select jsonb_agg(id) from ids),
  'canonical_id', (select id from ids where yahoo_symbol = 'MSFT'),
  'roles', (select jsonb_object_agg(id::text, case yahoo_symbol when 'MSFT' then 'canonical' when 'MSF.DE' then 'foreign_listing' else 'secondary_venue' end) from ids),
  'country', 'United States', 'name', 'Microsoft Corporation', 'name_normalized', 'microsoft')) as j;
select is(app.apply_identity_groups((select j from g)) ->> 'groups', '1', 'one group applied');
select is((select count(distinct company_id)::int from securities where yahoo_symbol in ('MSFT', 'MSF.DE', 'MSF.F')), 1, 'the three listings share one company');
select is((select role from securities where yahoo_symbol = 'MSF.DE'), 'foreign_listing', 'roles are applied');
select is((select is_canonical from securities where yahoo_symbol = 'MSFT'), true, 'the canonical flag is set');
select is((select count(*)::int from securities where yahoo_symbol in ('MSFT', 'MSF.DE', 'MSF.F') and is_canonical), 1, 'exactly one canonical security');
select is((select c.canonical_security_id from companies c join securities s on s.company_id = c.id where s.yahoo_symbol = 'MSFT'), (select id from ids where yahoo_symbol = 'MSFT'), 'the company points at its canonical security');
select is((select c.country || ' / ' || c.name from companies c join securities s on s.company_id = c.id where s.yahoo_symbol = 'MSFT'), 'United States / Microsoft Corporation', 'company country and name are set');
select is((select count(*)::int from companies where id in (select company_id from ids where yahoo_symbol in ('MSF.DE', 'MSF.F'))), 0, 'the provisional companies of the merged listings were deleted');

-- re-applying with a different canonical switches the flag without violating the one-canonical index
create temp table g2 as select jsonb_build_array(jsonb_build_object(
  'company_id', (select company_id from ids where yahoo_symbol = 'MSFT'),
  'member_ids', (select jsonb_agg(id) from ids),
  'canonical_id', (select id from ids where yahoo_symbol = 'MSF.DE'),
  'roles', (select jsonb_object_agg(id::text, case yahoo_symbol when 'MSF.DE' then 'canonical' when 'MSFT' then 'share_class' else 'secondary_venue' end) from ids))) as j;
select lives_ok($$select app.apply_identity_groups((select j from g2))$$, 'switching the canonical listing is accepted');
select is((select yahoo_symbol from securities where is_canonical and yahoo_symbol in ('MSFT', 'MSF.DE', 'MSF.F')), 'MSF.DE', 'the new canonical is MSF.DE');
select is((select count(*)::int from securities where yahoo_symbol in ('MSFT', 'MSF.DE', 'MSF.F') and is_canonical), 1, 'still exactly one canonical security');

-- an orphaned company that an old snapshot still references is deactivated, not deleted
select app.apply_quote_rows('00000000-0000-0000-0000-0000000000f1', jsonb_build_array(pg_temp.row('OLD1', 'NMS', 6e10)));
insert into scan_runs (id, scan_date_local, settings_snapshot) values ('00000000-0000-0000-0000-0000000000f2', '2030-02-02', '{}');
insert into universe_snapshots (scan_run_id, mode, security_id, company_id, rank, market_cap_usd, is_top10, applicable_line)
select '00000000-0000-0000-0000-0000000000f2', 'worldwide', id, company_id, 1, 6e10, true, '-3' from securities where yahoo_symbol = 'OLD1';
create temp table old as select id, company_id from securities where yahoo_symbol = 'OLD1';
select app.apply_identity_groups(jsonb_build_array(jsonb_build_object(
  'company_id', (select company_id from ids where yahoo_symbol = 'MSFT'), 'member_ids', (select jsonb_agg(id) from (select id from ids union all select id from old) x),
  'canonical_id', (select id from ids where yahoo_symbol = 'MSF.DE'), 'roles', '{}'::jsonb)));
select is((select status from companies where id = (select company_id from old)), 'inactive', 'a referenced orphan company is kept but marked inactive');
select is((select count(*)::int from universe_snapshots), 1, 'the old snapshot row is untouched');
select is(app.apply_identity_groups('[]'::jsonb) ->> 'groups', '0', 'an empty group list is a no-op');

select * from finish();
rollback;
```

- [ ] **Step 2: Run it: `bun run test:db`; Expected: FAIL if you run it before Tasks 12-15 (missing relations); with the migrations applied the expected result is PASS on the first run**

- [ ] **Step 3: Note on concurrency tests**

pgTAP runs in one session, so the SKIP LOCKED guarantee is proven by sequential claims with different worker names (disjoint sets, stage caps, leases). A true two-connection race is not covered here; the fixture integration test (Task 19) runs two `worker-tick` calls against the same run.

- [ ] **Step 4: Run; Expected: PASS** `bun run test:db` (`All tests successful. Files=6, Tests=252` including P0's smoke test).

- [ ] **Step 5: Commit**

```bash
git add supabase/tests
git commit -m "test(db): pgTAP suites for schema, RLS, pipeline functions and public reads"
```

---
### Task 17: worker-tick: loop, seeding, handlers (stages 1-7), fixture providers

**Parallelism:** needs Tasks 3-11 and 14; first task of Group D (Tasks 18 and 19 can start after it).

**Files:**
- Modify: `supabase/functions/worker-tick/index.ts` (replaces the P0 placeholder), `supabase/config.toml`
- Create: `supabase/functions/worker-tick/types.ts`, `stages.ts`, `loop.ts`, `providers.ts`, `lib/*.ts`, `handlers/*.ts`, `testing/fake-db.ts`
- Create: `supabase/functions/_shared/adapters/fixture-providers.ts`
- Test: `supabase/functions/worker-tick/lib/lib.test.ts`, `supabase/functions/worker-tick/loop.test.ts`

**Interfaces:**
- Consumes: everything above; SQL functions of Task 14 (`apply_quote_rows`, `apply_identity_groups`, `seed_stage`, ...)
- Produces: `runLoop(deps)` (spec 7.5), `classifyError`, `PIPELINE_ORDER`, `HANDLERS`, `SEEDERS`; handlers `handleFx, handleUniverseSweep, handleIdentity, handleFetchBars, handleCompute, handleRankSignals, handleClassify, handlePublish` with their `seed*` functions; pure helpers `batchPlan, computeCoverage, planCarryForward, membershipEvents, membershipReason, observationFor, rowFromSeries, hashWindow, sameSeries, averageUsdVolume`

- [ ] **Step 1: Configure the function: `supabase/config.toml` and the local secrets**

P0 already declares `[functions.worker-tick] verify_jwt = false`. Add `static_files` so the fixture world can be read at runtime (local fixture mode only; the file is never read in production):

```toml
[functions.worker-tick]
verify_jwt = false
static_files = ["./functions/_shared/adapters/fixtures/integration/world.json"]
```

Create `supabase/functions/.env.example` (committed; copy it to `supabase/functions/.env`, which is git-ignored and loaded automatically by `supabase start`):

```bash
CRON_SHARED_SECRET=local-dev-cron-secret
ALLOW_FIXTURE_PROVIDERS=1
```

`ALLOW_FIXTURE_PROVIDERS=1` must never be set as a hosted secret.

- [ ] **Step 2: Write the failing tests**

**`supabase/functions/worker-tick/lib/lib.test.ts`**

```ts
import { assert, assertEquals, assertThrows } from "@std/assert";
import { dayNumber } from "../../_shared/core/calendar.ts";
import type { Channel } from "../../_shared/core/indicator.ts";
import type { RuleCode } from "../../_shared/core/eligibility.ts";
import { batchPlan, chunk, exchangeOfSweepKey, parseSweepKey, sweepKey } from "./batching.ts";
import { computeCoverage, listCoverage, type CoverageInput, type ResultStatus } from "./coverage.ts";
import { leadingCarried, membershipEvents, membershipReason, observationFor, planCarryForward, type SnapshotRow } from "./rank-helpers.ts";
import { hashWindow, rowFromSeries, seriesFromRow } from "./series.ts";

// ------------------------------------------------------------------------------------------------ batching

Deno.test("batchPlan: 25 securities per compute job and 12 per fetch job, stable keys and payloads", () => {
  const ids = Array.from({ length: 53 }, (_, i) => `s${i}`);
  const compute = batchPlan("compute", ids, 25);
  assertEquals(compute.keys, ["compute:0", "compute:1", "compute:2"]);
  assertEquals((compute.payloads as Array<{ securityIds: string[] }>).map((p) => p.securityIds.length), [25, 25, 3]);
  const bars = batchPlan("bars", ids, 12);
  assertEquals(bars.keys.length, 5);
  assertEquals(batchPlan("bars", [], 12), { keys: [], payloads: [], priorities: [] });
});

Deno.test("chunk rejects a non-positive size", () => {
  assertThrows(() => chunk([1], 0), RangeError);
});

Deno.test("sweep keys: the first page uses the bare code, follow-ups carry the offset, recheck is its own job", () => {
  assertEquals(sweepKey("NMS", 0), "NMS");
  assertEquals(sweepKey("NMS", 2500), "NMS@2500");
  assertEquals(parseSweepKey("NMS@2500"), { kind: "exchange", code: "NMS", offset: 2500 });
  assertEquals(parseSweepKey("GER"), { kind: "exchange", code: "GER", offset: 0 });
  assertEquals(parseSweepKey("recheck:0"), { kind: "recheck" });
  assertEquals(exchangeOfSweepKey("SAU@250"), "SAU");
  assertEquals(exchangeOfSweepKey("recheck:0"), null);
});

// ------------------------------------------------------------------------------------------------ coverage

const base = (over: Partial<CoverageInput> = {}): CoverageInput => ({
  exchangesTotal: 28,
  failedExchanges: [],
  rawRows: 700,
  companies: 480,
  candidates: [],
  carriedForward: 0,
  prices: [],
  fx: { rateDate: "2026-10-14", scanDay: dayNumber(2026, 10, 15), rateDay: dayNumber(2026, 10, 14), missing: [] },
  research: { required: 0 },
  minListCoverage: 0.95,
  ...over,
});
const cands = (spec: Partial<Record<ResultStatus, number>>) =>
  (Object.entries(spec) as Array<[ResultStatus, number]>).flatMap(([status, n]) => Array.from({ length: n }, () => ({ status })));

Deno.test("computeCoverage: counts every status and publishes the list at >= 95%", () => {
  const c = computeCoverage(base({ candidates: cands({ processed: 590, skipped: 4, failed: 8, insufficient_data: 3, stale: 4, unprocessed: 3 }), carriedForward: 4 }));
  assertEquals(c.candidates, { total: 612, processed: 590, skipped: 4, failed: 8, insufficient_data: 3, stale: 4, unprocessed: 3, carried_forward: 4 });
  assertEquals(c.publish.list_coverage, Math.round(((590 + 3 + 4) / 612) * 1000) / 1000);
  assertEquals(c.publish.list, true);
  assertEquals(c.publish.results, true);
});

Deno.test("computeCoverage: the list is withheld below 95% (unprocessed securities are gaps, never passes)", () => {
  const c = computeCoverage(base({ candidates: cands({ processed: 90, failed: 6, unprocessed: 4 }) }));
  assertEquals(c.publish.list, false);
  assertEquals(c.publish.list_coverage, 0.9);
});

Deno.test("computeCoverage: exactly 95% publishes, 94.9% does not", () => {
  assertEquals(computeCoverage(base({ candidates: cands({ processed: 95, failed: 5 }) })).publish.list, true);
  assertEquals(computeCoverage(base({ candidates: cands({ processed: 949, failed: 51 }) })).publish.list, false);
});

Deno.test("listCoverage of an empty candidate set is 1 (nothing to process)", () => {
  assertEquals(listCoverage(computeCoverage(base()).candidates), 1);
});

Deno.test("computeCoverage: failed exchanges are listed once, sorted, and reduce exchanges_ok", () => {
  const c = computeCoverage(base({ failedExchanges: ["SAU", "GER", "SAU"] }));
  assertEquals(c.universe, { exchanges_total: 28, exchanges_ok: 26, failed_exchanges: ["GER", "SAU"], raw_rows: 700, companies: 480 });
});

Deno.test("computeCoverage: price freshness, suspect count and FX staleness", () => {
  const c = computeCoverage(base({
    prices: [{ freshness: "fresh", suspect: false }, { freshness: "fresh", suspect: true }, { freshness: "stale", suspect: false }, { freshness: "unavailable", suspect: false }],
    fx: { rateDate: "2026-10-10", scanDay: dayNumber(2026, 10, 15), rateDay: dayNumber(2026, 10, 10), missing: ["TWD", "SAR"] },
  }));
  assertEquals(c.prices, { fresh: 2, stale: 1, unavailable: 1, suspect: 1 });
  assertEquals(c.fx, { rate_date: "2026-10-10", stale: true, missing: ["SAR", "TWD"] });
  assertEquals(computeCoverage(base({ fx: { rateDate: "2026-10-11", scanDay: dayNumber(2026, 10, 15), rateDay: dayNumber(2026, 10, 11), missing: [] } })).fx.stale, false);
  assertEquals(computeCoverage(base({ fx: { rateDate: null, scanDay: 1, rateDay: null, missing: [] } })).fx.stale, true);
});

Deno.test("computeCoverage: research is reported as pending in P1", () => {
  assertEquals(computeCoverage(base({ research: { required: 3 } })).research, { required: 3, complete: 0, pending: 3, quota_deferred: 0, failed: 0 });
});

// ------------------------------------------------------------------------------------------------ series

Deno.test("rowFromSeries: dates, denormalised closes and integer volumes; empty series is refused", () => {
  const series = { dates: [dayNumber(2026, 10, 13), dayNumber(2026, 10, 14)], open: [1, 2], high: [2, 3], low: [0.5, 1.5], close: [1.5, 2.5], volume: [10.4, 20] };
  const row = rowFromSeries({ securityId: "s1", series, completeness: { validBars: 2 }, freshness: "fresh", nowIso: "2026-10-15T07:00:00.000Z", lastFullRefreshIso: "2026-10-15T07:00:00.000Z" });
  assertEquals([row["bar_count"], row["first_bar_date"], row["last_bar_date"], row["last_session_date"], row["last_close"], row["prev_close"]], [2, "2026-10-13", "2026-10-14", "2026-10-14", 2.5, 1.5]);
  assertEquals(row["volume"], [10, 20]);
  assertThrows(() => rowFromSeries({ securityId: "s1", series: { dates: [], open: [], high: [], low: [], close: [], volume: [] }, completeness: {}, freshness: "fresh", nowIso: "", lastFullRefreshIso: "" }), RangeError);
});

Deno.test("seriesFromRow copies the arrays", () => {
  const row = { bar_dates: [1], open: [1], high: [1], low: [1], close: [1], volume: [1] };
  const s = seriesFromRow(row);
  s.close[0] = 9;
  assertEquals(row.close[0], 1);
});

Deno.test("hashWindow: stable, sensitive to the window, insensitive to bars before it", async () => {
  const a = { close: [1, 2, 3, 4], high: [2, 3, 4, 5], low: [0, 1, 2, 3] };
  const h = await hashWindow(a, 3);
  assertEquals(h.length, 64);
  assertEquals(await hashWindow({ close: [9, 2, 3, 4], high: [9, 3, 4, 5], low: [9, 1, 2, 3] }, 3), h);
  assert((await hashWindow({ close: [1, 2, 3, 4.0001], high: a.high, low: a.low }, 3)) !== h);
});

// ------------------------------------------------------------------------------------------------ carry forward

const snap = (mode: "worldwide" | "us", id: string, state: "member" | "carried_forward" = "member", rank = 1): SnapshotRow => ({
  mode, securityId: id, companyId: `c-${id}`, rank, marketCapUsd: 100e9, state, applicableLine: "-3",
});

Deno.test("planCarryForward: a missing result carries for 3 consecutive scans and is dropped on the 4th", () => {
  const maxScans = 3;
  const plan = (history: SnapshotRow[][]) =>
    planCarryForward({ previous: history[0] as SnapshotRow[], history, memberIds: new Set(), failedBySecurity: new Map(), maxScans });
  // scan 1 without data: previous row is a plain member -> carried (count becomes 1)
  assertEquals(plan([[snap("worldwide", "a")]]).carry.map((c) => c.securityId), ["a"]);
  // scan 2: previous carried once -> carried again
  assertEquals(plan([[snap("worldwide", "a", "carried_forward")], [snap("worldwide", "a")]]).carry.length, 1);
  // scan 3: carried twice -> carried a third time
  assertEquals(plan([[snap("worldwide", "a", "carried_forward")], [snap("worldwide", "a", "carried_forward")], [snap("worldwide", "a")]]).carry.length, 1);
  // scan 4: carried three times already -> dropped
  const fourth = plan([[snap("worldwide", "a", "carried_forward")], [snap("worldwide", "a", "carried_forward")], [snap("worldwide", "a", "carried_forward")]]);
  assertEquals(fourth.carry, []);
  assertEquals(fourth.dropped.map((d) => [d.securityId, d.reason]), [["a", "carry_limit"]]);
});

Deno.test("planCarryForward: only data problems carry; genuine ineligibility and current members do not", () => {
  const previous = [snap("worldwide", "stale"), snap("worldwide", "small"), snap("worldwide", "member"), snap("us", "us-only")];
  const failedBySecurity = new Map<string, RuleCode[]>([
    ["stale", ["market_cap_stale", "stale_data"]],
    ["small", ["market_cap_below_threshold"]],
    ["us-only", ["fx_missing"]],
  ]);
  const plan = planCarryForward({ previous, history: [previous], memberIds: new Set(["member"]), failedBySecurity, maxScans: 3 });
  assertEquals(plan.carry.map((c) => `${c.mode}:${c.securityId}`), ["worldwide:stale", "us:us-only"]);
  assertEquals(plan.dropped, []);
});

Deno.test("leadingCarried counts only the unbroken newest run of carried states", () => {
  const h = [[snap("worldwide", "a", "carried_forward")], [snap("worldwide", "a", "member")], [snap("worldwide", "a", "carried_forward")]];
  assertEquals(leadingCarried(h, "worldwide", "a"), 1);
  assertEquals(leadingCarried(h, "us", "a"), 0);
  assertEquals(leadingCarried([], "worldwide", "a"), 0);
});

// ------------------------------------------------------------------------------------------------ membership events

Deno.test("membershipEvents: added and removed per mode; carried rows are present but silent", () => {
  const previous = [snap("worldwide", "keep", "member", 1), snap("worldwide", "gone", "member", 2), snap("worldwide", "was-carried", "carried_forward", 3), snap("worldwide", "expired", "carried_forward", 4)];
  const today = [snap("worldwide", "keep", "member", 1), snap("worldwide", "new", "member", 2), snap("worldwide", "was-carried", "member", 3), snap("worldwide", "now-carried", "carried_forward", 5)];
  const events = membershipEvents({ previous, today, reasonFor: (event, id, expired) => `${event}:${id}:${expired}` });
  assertEquals(events.map((e) => `${e.mode}:${e.event}:${e.securityId}:${e.reason}`), [
    "worldwide:removed:expired:removed:expired:true",
    "worldwide:removed:gone:removed:gone:false",
    "worldwide:added:new:added:new:false",
  ]); // ordered by mode, company id, event
  const removed = events.find((e) => e.securityId === "gone");
  assertEquals([removed?.fromRank, removed?.toRank], [2, null]);
  const added = events.find((e) => e.securityId === "new");
  assertEquals([added?.fromRank, added?.toRank], [null, 2]);
});

Deno.test("membershipEvents: modes are independent", () => {
  const previous = [snap("worldwide", "a"), snap("us", "a")];
  const today = [snap("worldwide", "a")];
  const events = membershipEvents({ previous, today, reasonFor: () => "x" });
  assertEquals(events.map((e) => `${e.mode}:${e.event}`), ["us:removed"]);
});

Deno.test("membershipEvents: no previous snapshot means every member is added, so callers skip the baseline run", () => {
  assertEquals(membershipEvents({ previous: [], today: [snap("worldwide", "a")], reasonFor: () => "x" }).length, 1);
});

Deno.test("membershipReason maps rule failures to readable reasons", () => {
  assertEquals(membershipReason({ event: "removed", failedNow: ["market_cap_below_threshold"], failedBefore: [], carryExpired: false }), "market_cap_below_threshold");
  assertEquals(membershipReason({ event: "removed", failedNow: ["channel_not_rising"], failedBefore: [], carryExpired: false }), "channel_not_rising");
  assertEquals(membershipReason({ event: "removed", failedNow: null, failedBefore: [], carryExpired: false }), "delisted_or_missing");
  assertEquals(membershipReason({ event: "removed", failedNow: ["stale_data"], failedBefore: [], carryExpired: true }), "data_unavailable");
  assertEquals(membershipReason({ event: "removed", failedNow: ["suspect_data"], failedBefore: [], carryExpired: false }), "suspect_data");
  assertEquals(membershipReason({ event: "added", failedNow: [], failedBefore: null, carryExpired: false }), "new_listing");
  assertEquals(membershipReason({ event: "added", failedNow: [], failedBefore: ["market_cap_below_threshold"], carryExpired: false }), "market_cap_above_threshold");
  assertEquals(membershipReason({ event: "added", failedNow: [], failedBefore: ["channel_not_rising"], carryExpired: false }), "channel_rising");
  assertEquals(membershipReason({ event: "added", failedNow: [], failedBefore: ["insufficient_bars"], carryExpired: false }), "requirements_met");
});

// ------------------------------------------------------------------------------------------------ observations

const end: Channel["end"] = { base: 100, upper1: 110, upper2: 120, lower1: 90, lower2: 80 };
const today = (over: Record<string, unknown> = {}) => ({
  sessionDay: dayNumber(2026, 10, 14), close: 85, evaluable: true, channelEnd: end, freshness: "fresh", tier1Member: true, carriedForward: false, ...over,
}) as Parameters<typeof observationFor>[0]["today"];

Deno.test("observationFor: rank 5 uses the -3 line (90), rank 11 and null use the -4 line (80)", () => {
  const r5 = observationFor({ today: today(), rank: 5, prevApplicableLine: null, signalGrade: true })!;
  assertEquals([r5.obs.applicableLine, r5.obs.lineEnd, r5.obs.canOpen], ["-3", 90, true]);
  const r11 = observationFor({ today: today(), rank: 11, prevApplicableLine: "-3", signalGrade: true })!;
  assertEquals([r11.obs.applicableLine, r11.obs.lineEnd, r11.obs.prevApplicableLine], ["-4", 80, "-3"]);
  assertEquals(observationFor({ today: today(), rank: null, prevApplicableLine: null, signalGrade: true })!.obs.applicableLine, "-4");
});

Deno.test("observationFor: a lower line at or below zero cannot open (Tier 2), but the observation stays evaluable", () => {
  const r = observationFor({ today: today({ channelEnd: { ...end, lower1: -0.5 } }), rank: 5, prevApplicableLine: null, signalGrade: true })!;
  assertEquals(r.obs.canOpen, false);
  assertEquals(r.obs.lineEnd, -0.5);
  assertEquals(r.tier2Failed, ["lower_line_not_positive"]);
});

Deno.test("observationFor: stale or suspect data has no line end (a data failure is never a reset)", () => {
  const r = observationFor({ today: today({ evaluable: false, freshness: "stale" }), rank: 5, prevApplicableLine: null, signalGrade: true })!;
  assertEquals([r.obs.lineEnd, r.obs.canOpen], [null, false]);
});

Deno.test("observationFor: carried-forward, non-member and non-signal-grade securities cannot open", () => {
  assertEquals(observationFor({ today: today({ carriedForward: true }), rank: 5, prevApplicableLine: null, signalGrade: true })!.obs.canOpen, false);
  assertEquals(observationFor({ today: today({ tier1Member: false }), rank: null, prevApplicableLine: null, signalGrade: true })!.obs.canOpen, false);
  assertEquals(observationFor({ today: today(), rank: 5, prevApplicableLine: null, signalGrade: false })!.obs.canOpen, false);
});

Deno.test("observationFor: no completed close means no observation", () => {
  assertEquals(observationFor({ today: today({ close: null }), rank: 5, prevApplicableLine: null, signalGrade: true }), null);
  assertEquals(observationFor({ today: today({ sessionDay: null }), rank: 5, prevApplicableLine: null, signalGrade: true }), null);
});
```

**`supabase/functions/worker-tick/loop.test.ts`**

```ts
import { assert, assertEquals } from "@std/assert";
import { DEFAULT_SETTINGS } from "../_shared/core/indicator.ts";
import { dayNumber } from "../_shared/core/calendar.ts";
import { DEFAULT_PIPELINE, DEFAULT_UNIVERSE, SettingsError, type AppSettings } from "../_shared/adapters/settings.ts";
import { BudgetExceededError, YahooUnavailableError } from "../_shared/adapters/throttle.ts";
import type { JobStage } from "../_shared/adapters/log.ts";
import { classifyError, runLoop, type LoopDeps } from "./loop.ts";
import { PIPELINE_ORDER } from "./stages.ts";
import { createFakeDb } from "./testing/fake-db.ts";
import { DeferError, FatalJobError, type Handler, type RunInfo, type Seeder } from "./types.ts";

const settings: AppSettings = { indicator: { ...DEFAULT_SETTINGS }, universe: { ...DEFAULT_UNIVERSE }, pipeline: { ...DEFAULT_PIPELINE } };
const run = (over: Partial<RunInfo> = {}): RunInfo => ({
  id: "run-1", scanDateLocal: "2026-10-15", scanDay: dayNumber(2026, 10, 15), startedAtMs: Date.UTC(2026, 9, 15, 7), settings,
  providerMode: "live", fixtureSet: null, ...over,
});

function deps(db: ReturnType<typeof createFakeDb>, over: Partial<LoopDeps> = {}): { deps: LoopDeps; clock: { t: number } } {
  const clock = { t: 0 };
  return {
    clock,
    deps: {
      db, worker: "w1", now: () => clock.t, t0: 0, settings: settings.pipeline, stages: PIPELINE_ORDER, handlers: {}, seeders: {},
      loadRun: () => Promise.resolve(run()), providersFor: () => ({ market: undefined as never, fx: undefined as never }),
      activeRunIds: () => Promise.resolve(["run-1"]), ...over,
    },
  };
}

// ---------------------------------------------------------------------------------------------------- error classification

Deno.test("classifyError: one row per failure class of spec 7.9", () => {
  const now = 1_000_000;
  assertEquals(classifyError(new DeferError(30, "waiting"), now), { kind: "defer", delaySeconds: 30, reason: "waiting" });
  assertEquals(classifyError(new YahooUnavailableError(now + 600_000), now), { kind: "defer", delaySeconds: 600, reason: "yahoo_breaker_open" });
  assertEquals(classifyError(new YahooUnavailableError(now + 1000), now), { kind: "defer", delaySeconds: 30, reason: "yahoo_breaker_open" }); // never sooner than 30 s
  assertEquals(classifyError(new BudgetExceededError(), now), { kind: "defer", delaySeconds: 10, reason: "yahoo_budget_exceeded" });
  assertEquals(classifyError(new FatalJobError("unknown_exchange:XXX"), now), { kind: "fatal", message: "unknown_exchange:XXX" });
  assertEquals(classifyError(new SettingsError("invalid_indicator_settings"), now).kind, "fatal");
  assertEquals(classifyError(new Error("settings_not_signal_grade"), now), { kind: "fatal", message: "settings_not_signal_grade" });
  assertEquals(classifyError(new DOMException("t", "TimeoutError"), now), { kind: "fail", message: "job_timeout", retryInSeconds: 30 });
  const generic = classifyError(new TypeError("x".repeat(500)), now);
  assertEquals(generic.kind, "fail");
  assert((generic as { message: string }).message.startsWith("TypeError: xxx") && (generic as { message: string }).message.length <= 300, "error text is bounded, no payload dump");
  assertEquals(classifyError("boom", now), { kind: "fail", message: "Error: boom" });
});

// ---------------------------------------------------------------------------------------------------- the loop

Deno.test("runLoop claims jobs in priority order, runs their handlers, completes them and refreshes the run status", async () => {
  const db = createFakeDb();
  db.addJob({ stage: "fx", key: "all", priority: 10 });
  db.addJob({ stage: "compute", key: "compute:0", priority: 100 });
  const order: string[] = [];
  const h: Handler = (ctx) => {
    order.push(`${ctx.job.stage}:${ctx.job.key}`);
    return Promise.resolve({ ok: true });
  };
  const { deps: d } = deps(db, { handlers: { fx: h, compute: h } });
  const summary = await runLoop(d);
  assertEquals(order, ["fx:all", "compute:compute:0"]);
  assertEquals([summary.jobsRun, summary.jobsDone, summary.jobsFailed, summary.stoppedBecause], [2, 2, 0, "idle"]);
  assertEquals(db.jobs.map((j) => j.status), ["done", "done"]);
  assertEquals(db.jobs[0]?.result, { ok: true });
  assert(db.refreshes.includes("run-1"));
  assertEquals(db.events.filter((e) => e.event === "job_started").length, 2);
  assertEquals(db.events.filter((e) => e.event === "job_done").length, 2);
});

Deno.test("runLoop passes the stage caps and the lease to claim_jobs", async () => {
  const db = createFakeDb();
  const { deps: d } = deps(db);
  await runLoop(d);
  assertEquals(db.claims[0]?.stageLimits, DEFAULT_PIPELINE.stageCaps);
  assertEquals(db.claims[0]?.limit, 3);
  assertEquals(db.claims[0]?.stages, PIPELINE_ORDER);
});

Deno.test("stage seeding transitions: the loop walks fx -> universe_sweep -> ... -> publish, seeding each stage only after the previous one finished", async () => {
  const db = createFakeDb();
  db.addJob({ stage: "fx", key: "all", priority: 10 });
  const seen: JobStage[] = [];
  const handler: Handler = (ctx) => {
    seen.push(ctx.job.stage);
    return Promise.resolve({});
  };
  const seeder = (stage: JobStage): Seeder => () => Promise.resolve({ keys: stage === "identity" ? [] : [`${stage}:0`, `${stage}:1`], priorities: [100, 100] });
  const handlers = Object.fromEntries(PIPELINE_ORDER.map((s) => [s, handler]));
  const seeders = Object.fromEntries(PIPELINE_ORDER.map((s) => [s, seeder(s)]));
  const { deps: d } = deps(db, { handlers, seeders });
  const summary = await runLoop(d);
  assertEquals(seen[0], "fx");
  const stageOrder = seen.filter((s, i) => seen.indexOf(s) === i);
  assertEquals(stageOrder, PIPELINE_ORDER.filter((s) => s !== "identity")); // an empty stage only leaves a done marker
  assertEquals(db.jobs.filter((j) => j.stage === "identity").map((j) => [j.key, j.status]), [["_empty", "done"]]);
  assertEquals(db.jobs.filter((j) => j.status !== "done").length, 0);
  assertEquals(summary.seeded.length, PIPELINE_ORDER.length - 1);
  assertEquals(summary.stoppedBecause, "idle");
  // each stage's jobs started only after every job of the previous stage was done: no interleaving
  for (let i = 1; i < stageOrder.length; i++) assert(seen.lastIndexOf(stageOrder[i - 1] as JobStage) < seen.indexOf(stageOrder[i] as JobStage));
  assertEquals(db.events.filter((e) => e.event === "stage_seeded").length, PIPELINE_ORDER.length - 1);
});

Deno.test("seeding is idempotent: a second worker seeding the same stage creates no duplicates", async () => {
  const db = createFakeDb();
  db.addJob({ stage: "fx", key: "all", status: "done" });
  assertEquals(await db.seedStage({ run: "run-1", stage: "universe_sweep", keys: ["NMS", "GER"] }), 2);
  assertEquals(await db.seedStage({ run: "run-1", stage: "universe_sweep", keys: ["NMS", "GER"] }), 0);
  assertEquals(db.jobs.filter((j) => j.stage === "universe_sweep").length, 2);
});

Deno.test("a handler error fails the job with backoff, a fatal error kills it at once, a deferral does not consume an attempt", async () => {
  const db = createFakeDb();
  db.addJob({ stage: "fx", key: "boom" });
  db.addJob({ stage: "compute", key: "fatal" });
  db.addJob({ stage: "fetch_bars", key: "defer" });
  const handlers: Partial<Record<JobStage, Handler>> = {
    fx: () => Promise.reject(new TypeError("kaput")),
    compute: () => Promise.reject(new FatalJobError("unknown_exchange:XXX")),
    fetch_bars: () => Promise.reject(new YahooUnavailableError(Date.now() + 120_000)),
  };
  const { deps: d } = deps(db, { handlers, activeRunIds: () => Promise.resolve([]) });
  const summary = await runLoop(d);
  assertEquals([summary.jobsFailed, summary.jobsDeferred], [2, 1]);
  assertEquals(db.jobs.find((j) => j.key === "boom")?.status, "failed");
  assertEquals(db.jobs.find((j) => j.key === "fatal")?.status, "dead");
  assertEquals(db.failures.find((f) => f.error === "unknown_exchange:XXX")?.fatal, true);
  const deferred = db.jobs.find((j) => j.key === "defer");
  assertEquals([deferred?.status, deferred?.attempts], ["queued", 0]);
  assert(db.events.some((e) => e.event === "job_retry" && e.level === "warn"));
  assert(db.events.some((e) => e.event === "job_dead" && e.level === "error"));
  const ev = db.events.find((e) => e.event === "job_dead");
  assert(!JSON.stringify(ev).includes("kaput"), "a dead job logs the error class of the fatal error only");
});

Deno.test("a job that fails five times is dead (max_attempts)", async () => {
  const db = createFakeDb();
  db.addJob({ stage: "fx", key: "flaky" });
  const { deps: d } = deps(db, { handlers: { fx: () => Promise.reject(new Error("again")) }, activeRunIds: () => Promise.resolve([]) });
  for (let i = 0; i < 5; i++) {
    db.releaseAll(); // time passes: not_before is reached
    await runLoop(d);
  }
  assertEquals(db.jobs[0]?.status, "dead");
  assertEquals(db.jobs[0]?.attempts, 5);
});

Deno.test("a stage without a handler is fatal for its job", async () => {
  const db = createFakeDb();
  db.addJob({ stage: "fx", key: "all" });
  const { deps: d } = deps(db, { activeRunIds: () => Promise.resolve([]) });
  await runLoop(d);
  assertEquals(db.jobs[0]?.status, "dead");
  assertEquals(db.failures[0]?.error, "no_handler:fx");
});

Deno.test("signal-grade guard: a run whose indicator settings are not the 3/4/1/2 defaults fails every job with settings_not_signal_grade", async () => {
  const db = createFakeDb();
  db.addJob({ stage: "fx", key: "all" });
  const custom = run({ settings: { ...settings, indicator: { ...DEFAULT_SETTINGS, lower1Mag: 2 } } });
  let called = false;
  const { deps: d } = deps(db, { loadRun: () => Promise.resolve(custom), handlers: { fx: () => ((called = true), Promise.resolve({})) }, activeRunIds: () => Promise.resolve([]) });
  await runLoop(d);
  assertEquals(called, false);
  assertEquals(db.jobs[0]?.status, "dead");
  assertEquals(db.failures[0], { id: 1, error: "settings_not_signal_grade", fatal: true, retryInSeconds: null });
});

Deno.test("a length-only change is still signal-grade", async () => {
  const db = createFakeDb();
  db.addJob({ stage: "fx", key: "all" });
  const ok = run({ settings: { ...settings, indicator: { ...DEFAULT_SETTINGS, length: 2000 } } });
  const { deps: d } = deps(db, { loadRun: () => Promise.resolve(ok), handlers: { fx: () => Promise.resolve({}) }, activeRunIds: () => Promise.resolve([]) });
  await runLoop(d);
  assertEquals(db.jobs[0]?.status, "done");
});

Deno.test("the loop stops claiming after 85 s of wall time", async () => {
  const db = createFakeDb();
  for (let i = 0; i < 10; i++) db.addJob({ stage: "compute", key: `c${i}` });
  const { deps: d, clock } = deps(db, { activeRunIds: () => Promise.resolve([]) });
  d.handlers = { compute: () => ((clock.t += 40_000), Promise.resolve({})) }; // each job takes 40 s
  const summary = await runLoop(d);
  assertEquals(summary.stoppedBecause, "time");
  // compute is capped at 2 concurrent jobs: claim 1 (t = 0) runs 2 jobs until t = 80 s, which is still < 85 s, so claim 2 runs 2 more until t = 160 s;
  // from then on the loop no longer claims. Jobs already claimed are always finished (their lease outlives the hard deadline).
  assertEquals(summary.jobsRun, 4);
  assertEquals(db.jobs.filter((j) => j.status === "queued").length, 6);
});

Deno.test("an idle loop with nothing to claim or seed returns at once", async () => {
  const db = createFakeDb();
  const { deps: d } = deps(db, { activeRunIds: () => Promise.resolve([]) });
  const summary = await runLoop(d);
  assertEquals(summary, { jobsRun: 0, jobsDone: 0, jobsFailed: 0, jobsDeferred: 0, seeded: [], stoppedBecause: "idle" });
});

Deno.test("a seeder that throws is logged and does not crash the worker", async () => {
  const db = createFakeDb();
  const { deps: d } = deps(db, { seeders: { fx: () => Promise.reject(new Error("db down")) } });
  const summary = await runLoop(d);
  assertEquals(summary.stoppedBecause, "idle");
  assert(db.events.some((e) => e.event === "stage_seed_failed" && e.level === "error"));
});

Deno.test("provider events recorded by the throttle are flushed as scan_events after the job", async () => {
  const db = createFakeDb();
  db.addJob({ stage: "fx", key: "all" });
  const { deps: d } = deps(db, {
    activeRunIds: () => Promise.resolve([]),
    providersFor: (_run, onEvent) => {
      onEvent("yahoo_429", { attempt: 1, apiKey: "SECRET" });
      return { market: undefined as never, fx: undefined as never };
    },
    handlers: { fx: () => Promise.resolve({}) },
  });
  await runLoop(d);
  const e = db.events.find((x) => x.event === "yahoo_429");
  assertEquals(e?.level, "warn");
  assertEquals(e?.jobId, 1);
  assert(!JSON.stringify(e).includes("SECRET"));
});
```

**`supabase/functions/worker-tick/testing/fake-db.ts`**

```ts
import type { Db, ScanJob, ScanStatus } from "../../_shared/adapters/db.ts";
import type { JobStage, ScanEventRow } from "../../_shared/adapters/log.ts";
import { PIPELINE_ORDER } from "../stages.ts";

/** In-memory Db for loop and seeding tests. It mirrors the SQL semantics that matter: priority order, stage caps, attempts, idempotent seeding. */
export interface FakeDb extends Db {
  jobs: ScanJob[];
  events: ScanEventRow[];
  refreshes: string[];
  failures: Array<{ id: number; error: string; fatal: boolean; retryInSeconds: number | null }>;
  deferrals: Array<{ id: number; delaySeconds: number; reason: string }>;
  claims: Array<{ limit: number; stages: JobStage[]; stageLimits: Record<string, number> }>;
  addJob(job: Partial<ScanJob> & { stage: JobStage; key: string }): ScanJob;
  /** Retries and deferrals respect not_before in SQL; the fake keeps them blocked until the test releases them. */
  releaseAll(): void;
}

export function createFakeDb(runId = "run-1"): FakeDb {
  let seq = 0;
  const jobs: ScanJob[] = [];
  const blocked = new Set<number>();
  const db: FakeDb = {
    sb: undefined as never,
    jobs,
    events: [],
    refreshes: [],
    failures: [],
    deferrals: [],
    claims: [],
    addJob(job) {
      const j: ScanJob = {
        id: ++seq, scan_run_id: runId, status: "queued", priority: 100, payload: {}, result: null, attempts: 0, max_attempts: 5,
        not_before: "1970-01-01T00:00:00Z", lease_until: null, leased_by: null, last_error: null, ...job,
      };
      jobs.push(j);
      return j;
    },
    releaseAll() {
      blocked.clear();
    },
    claimJobs(a) {
      db.claims.push({ limit: a.limit, stages: a.stages, stageLimits: a.stageLimits });
      const out: ScanJob[] = [];
      const runnable = jobs.filter((j) => (j.status === "queued" || j.status === "failed") && !blocked.has(j.id) && a.stages.includes(j.stage)).sort((x, y) => x.priority - y.priority || x.id - y.id);
      for (const j of runnable) {
        if (out.length >= a.limit) break;
        const cap = a.stageLimits[j.stage] ?? 1000;
        if (jobs.filter((x) => x.stage === j.stage && x.status === "leased").length >= cap) continue;
        j.status = "leased";
        j.leased_by = a.worker;
        j.attempts += 1;
        out.push({ ...j });
      }
      return Promise.resolve(out);
    },
    completeJob(id, result) {
      const j = jobs.find((x) => x.id === id);
      if (j !== undefined && j.status === "leased") Object.assign(j, { status: "done", result, leased_by: null });
      return Promise.resolve();
    },
    failJob(a) {
      db.failures.push({ id: a.id, error: a.error, fatal: a.fatal ?? false, retryInSeconds: a.retryInSeconds ?? null });
      const j = jobs.find((x) => x.id === a.id);
      if (j === undefined) return Promise.resolve(null);
      const dead = (a.fatal ?? false) || j.attempts >= j.max_attempts;
      Object.assign(j, { status: dead ? "dead" : "failed", last_error: a.error, leased_by: null });
      if (!dead) blocked.add(j.id);
      return Promise.resolve(dead ? "dead" : "failed");
    },
    deferJob(id, delaySeconds, reason) {
      db.deferrals.push({ id, delaySeconds, reason });
      const j = jobs.find((x) => x.id === id);
      if (j !== undefined && j.status === "leased") {
        Object.assign(j, { status: "queued", attempts: Math.max(0, j.attempts - 1), last_error: reason, leased_by: null });
        blocked.add(j.id);
      }
      return Promise.resolve();
    },
    heartbeatJob: () => Promise.resolve(),
    refreshScanStatus(run) {
      db.refreshes.push(run);
      return Promise.resolve("running" as ScanStatus);
    },
    seedStage(a) {
      let n = 0;
      if (a.keys.length === 0) {
        if (!jobs.some((j) => j.stage === a.stage && j.key === "_empty")) db.addJob({ stage: a.stage, key: "_empty", status: "done" });
        return Promise.resolve(0);
      }
      a.keys.forEach((key, i) => {
        if (jobs.some((j) => j.scan_run_id === a.run && j.stage === a.stage && j.key === key)) return;
        db.addJob({ scan_run_id: a.run, stage: a.stage, key, payload: (a.payloads?.[i] as Record<string, unknown>) ?? {}, priority: a.priorities?.[i] ?? 100 });
        n += 1;
      });
      return Promise.resolve(n);
    },
    nextStageToSeed(run) {
      for (let i = 0; i < PIPELINE_ORDER.length; i++) {
        const stage = PIPELINE_ORDER[i] as JobStage;
        const have = jobs.filter((j) => j.scan_run_id === run && j.stage === stage);
        if (have.length > 0) continue;
        if (i === 0) return Promise.resolve(stage);
        const prev = jobs.filter((j) => j.scan_run_id === run && j.stage === PIPELINE_ORDER[i - 1]);
        if (prev.some((j) => ["queued", "leased", "failed"].includes(j.status))) return Promise.resolve(null);
        if ((PIPELINE_ORDER[i - 1] === "fx" || PIPELINE_ORDER[i - 1] === "rank_signals") && prev.some((j) => j.status === "dead")) return Promise.resolve(null);
        return Promise.resolve(stage);
      }
      return Promise.resolve(null);
    },
    startDailyScan: () => Promise.resolve(null),
    purgeExpired: () => Promise.resolve({}),
    recordEvent(e) {
      db.events.push(e);
      return Promise.resolve();
    },
  };
  return db;
}
```

- [ ] **Step 3: Run it: `deno test -A --config supabase/functions/deno.json supabase/functions/worker-tick/`; Expected: FAIL (module not found ./loop.ts, ./lib/batching.ts)**

- [ ] **Step 4: Implement (1/22)**

**`supabase/functions/worker-tick/types.ts`**

```ts
import type { Db, ScanJob } from "../_shared/adapters/db.ts";
import type { EventLevel } from "../_shared/adapters/log.ts";
import type { FxProvider, MarketDataProvider } from "../_shared/adapters/providers.ts";
import type { AppSettings } from "../_shared/adapters/settings.ts";

/** Everything a handler needs to know about the run, loaded once per worker invocation. */
export interface RunInfo {
  id: string;
  scanDateLocal: string; // Europe/Sofia date "YYYY-MM-DD"
  scanDay: number; // the same date as days since 1970-01-01
  startedAtMs: number; // the data reference time: forming-bar and freshness rules are evaluated at the scan start, so recomputes replay
  settings: AppSettings; // from scan_runs.settings_snapshot, never from the live app_settings
  providerMode: "live" | "fixture";
  fixtureSet: string | null;
}

export interface Providers {
  market: MarketDataProvider;
  fx: FxProvider;
}

export interface EventExtra {
  level?: EventLevel;
  securityId?: string | null;
  message?: string | null;
}

export interface HandlerContext {
  db: Db;
  job: ScanJob;
  run: RunInfo;
  providers: Providers;
  signal: AbortSignal;
  /** Epoch ms after which a handler must stop starting work (hard deadline of the invocation). */
  deadlineMs: number;
  log(event: string, data?: Record<string, unknown>, extra?: EventExtra): Promise<void>;
}

export type Handler = (ctx: HandlerContext) => Promise<Record<string, unknown>>;

export interface SeedContext {
  db: Db;
  run: RunInfo;
  providers: Providers;
  log(event: string, data?: Record<string, unknown>, extra?: EventExtra): Promise<void>;
}

export interface SeedPlan {
  keys: string[];
  payloads?: unknown[];
  priorities?: number[];
}

export type Seeder = (ctx: SeedContext) => Promise<SeedPlan>;

/** Reschedule the job without consuming an attempt (breaker open, waiting for sibling jobs). */
export class DeferError extends Error {
  constructor(readonly delaySeconds: number, readonly reason: string) {
    super(`deferred: ${reason}`);
    this.name = "DeferError";
  }
}

/** Fatal configuration problem: the job goes dead at once and the scan fails (signal-grade guard, missing secret). */
export class FatalJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FatalJobError";
  }
}
```

- [ ] **Step 5: Implement (2/22)**

**`supabase/functions/worker-tick/lib/batching.ts`**

```ts
import type { SeedPlan } from "../types.ts";

export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (!(size >= 1)) throw new RangeError("chunk size must be >= 1");
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** `<prefix>:<n>` jobs of `size` ids each; the payload carries the ids so a retry always processes the same batch. */
export function batchPlan(prefix: string, ids: readonly string[], size: number, priority = 100): SeedPlan {
  const batches = chunk(ids, size);
  return {
    keys: batches.map((_, n) => `${prefix}:${n}`),
    payloads: batches.map((securityIds) => ({ securityIds })),
    priorities: batches.map(() => priority),
  };
}

/** Exchange job key: the plain code for the first pages, `<code>@<offset>` for a follow-up job (spec 7.5 rule 3). */
export function sweepKey(code: string, offset: number): string {
  return offset === 0 ? code : `${code}@${offset}`;
}

export type SweepKey = { kind: "recheck" } | { kind: "exchange"; code: string; offset: number };

export function parseSweepKey(key: string): SweepKey {
  if (key.startsWith("recheck:")) return { kind: "recheck" };
  const at = key.indexOf("@");
  if (at < 0) return { kind: "exchange", code: key, offset: 0 };
  return { kind: "exchange", code: key.slice(0, at), offset: Number(key.slice(at + 1)) };
}

/** Exchange code a sweep job belongs to (null for the recheck job); used by the coverage object. */
export function exchangeOfSweepKey(key: string): string | null {
  const parsed = parseSweepKey(key);
  return parsed.kind === "exchange" ? parsed.code : null;
}
```

- [ ] **Step 6: Implement (3/22)**

**`supabase/functions/worker-tick/lib/coverage.ts`**

```ts
/** Coverage object of scan_runs.coverage (spec 7.7), computed from stored facts only. Pure. */

export type ResultStatus = "processed" | "skipped" | "failed" | "insufficient_data" | "stale" | "unprocessed";

export interface CoverageInput {
  exchangesTotal: number;
  failedExchanges: string[];
  rawRows: number;
  companies: number;
  /** Candidate securities of the scan; each has exactly one entry (status "unprocessed" when no result row exists). */
  candidates: Array<{ status: ResultStatus }>;
  carriedForward: number;
  /** One entry per candidate; a candidate without a price series is { freshness: "unavailable", suspect: false }. */
  prices: Array<{ freshness: "fresh" | "stale" | "unavailable"; suspect: boolean }>;
  fx: { rateDate: string | null; scanDay: number; rateDay: number | null; missing: string[] };
  research: { required: number };
  minListCoverage: number;
}

export interface Coverage {
  universe: { exchanges_total: number; exchanges_ok: number; failed_exchanges: string[]; raw_rows: number; companies: number };
  candidates: { total: number; processed: number; skipped: number; failed: number; insufficient_data: number; stale: number; unprocessed: number; carried_forward: number };
  prices: { fresh: number; stale: number; unavailable: number; suspect: number };
  fx: { rate_date: string | null; stale: boolean; missing: string[] };
  research: { required: number; complete: number; pending: number; quota_deferred: number; failed: number };
  monitoring: { holdings_monitored: number; checked: number; failed: number };
  publish: { results: boolean; list: boolean; list_coverage: number };
}

export const FX_STALE_DAYS = 4; // A-22

/**
 * list_coverage = (processed + insufficient_data + skipped) / total: a security whose history is too short was evaluated
 * correctly, while failed, stale and unprocessed securities are the gaps (they also make a finished scan "partial").
 */
export function listCoverage(c: Coverage["candidates"]): number {
  return c.total === 0 ? 1 : (c.processed + c.insufficient_data + c.skipped) / c.total;
}

export function computeCoverage(i: CoverageInput): Coverage {
  const count = (status: ResultStatus) => i.candidates.filter((c) => c.status === status).length;
  const candidates: Coverage["candidates"] = {
    total: i.candidates.length,
    processed: count("processed"),
    skipped: count("skipped"),
    failed: count("failed"),
    insufficient_data: count("insufficient_data"),
    stale: count("stale"),
    unprocessed: count("unprocessed"),
    carried_forward: i.carriedForward,
  };
  const ratio = listCoverage(candidates);
  const failedExchanges = [...new Set(i.failedExchanges)].sort();
  return {
    universe: {
      exchanges_total: i.exchangesTotal,
      exchanges_ok: Math.max(0, i.exchangesTotal - failedExchanges.length),
      failed_exchanges: failedExchanges,
      raw_rows: i.rawRows,
      companies: i.companies,
    },
    candidates,
    prices: {
      fresh: i.prices.filter((p) => p.freshness === "fresh").length,
      stale: i.prices.filter((p) => p.freshness === "stale").length,
      unavailable: i.prices.filter((p) => p.freshness === "unavailable").length,
      suspect: i.prices.filter((p) => p.suspect).length,
    },
    fx: {
      rate_date: i.fx.rateDate,
      stale: i.fx.rateDay === null || i.fx.scanDay - i.fx.rateDay > FX_STALE_DAYS,
      missing: [...i.fx.missing].sort(),
    },
    research: { required: i.research.required, complete: 0, pending: i.research.required, quota_deferred: 0, failed: 0 },
    monitoring: { holdings_monitored: 0, checked: 0, failed: 0 },
    publish: { results: true, list: ratio >= i.minListCoverage, list_coverage: Math.round(ratio * 1000) / 1000 },
  };
}
```

- [ ] **Step 7: Implement (4/22)**

**`supabase/functions/worker-tick/lib/series.ts`**

```ts
import { isoDate } from "../../_shared/core/calendar.ts";
import type { Series } from "../../_shared/core/bars.ts";

/** Columns of price_series that the pipeline reads. Arrays come back from PostgREST as JSON arrays of numbers. */
export interface PriceSeriesRow {
  security_id: string;
  bar_dates: number[];
  open: number[];
  high: number[];
  low: number[];
  close: number[];
  volume: number[];
  bar_count: number;
  last_session_date: string;
  last_full_refresh_at: string;
  completeness: Record<string, unknown>;
}

export function seriesFromRow(row: Pick<PriceSeriesRow, "bar_dates" | "open" | "high" | "low" | "close" | "volume">): Series {
  return { dates: [...row.bar_dates], open: [...row.open], high: [...row.high], low: [...row.low], close: [...row.close], volume: [...row.volume] };
}

/** The upsert payload for price_series. Dates must be strictly ascending (the cleaner guarantees it). */
export function rowFromSeries(a: {
  securityId: string;
  series: Series;
  completeness: Record<string, unknown>;
  freshness: "fresh" | "stale" | "unavailable";
  nowIso: string;
  lastFullRefreshIso: string;
}): Record<string, unknown> {
  const s = a.series;
  const n = s.dates.length;
  if (n === 0) throw new RangeError("an empty series is never stored");
  return {
    security_id: a.securityId,
    bar_dates: s.dates,
    open: s.open,
    high: s.high,
    low: s.low,
    close: s.close,
    volume: s.volume.map((v) => Math.round(v)),
    adjustment_policy: "yahoo_split_adjusted_close_v1",
    provider: "yahoo",
    bar_count: n,
    first_bar_date: isoDate(s.dates[0] as number),
    last_bar_date: isoDate(s.dates[n - 1] as number),
    last_session_date: isoDate(s.dates[n - 1] as number),
    last_close: s.close[n - 1],
    prev_close: n > 1 ? s.close[n - 2] : null,
    retrieved_at: a.nowIso,
    last_full_refresh_at: a.lastFullRefreshIso,
    completeness: a.completeness,
    freshness: a.freshness,
  };
}

/** SHA-256 (hex) of the window the indicator used: reproducibility evidence stored as scan_security_results.bars_hash. */
export async function hashWindow(series: { close: ArrayLike<number>; high: ArrayLike<number>; low: ArrayLike<number> }, length: number): Promise<string> {
  const n = series.close.length;
  const from = Math.max(0, n - length);
  const parts: string[] = [];
  for (let i = from; i < n; i++) parts.push(`${series.close[i]},${series.high[i]},${series.low[i]}`);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(parts.join(";")));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** True when two series hold exactly the same bars (dates and every OHLCV value). */
export function sameSeries(a: Series, b: Series): boolean {
  if (a.dates.length !== b.dates.length) return false;
  const eq = (x: number[], y: number[]) => x.every((v, i) => v === y[i]);
  return eq(a.dates, b.dates) && eq(a.close, b.close) && eq(a.open, b.open) && eq(a.high, b.high) && eq(a.low, b.low) && eq(a.volume, b.volume);
}
```

- [ ] **Step 8: Implement (5/22)**

**`supabase/functions/worker-tick/lib/rank-helpers.ts`**

```ts
import { carryForwardEligible, evaluateTier2, type RuleCode } from "../../_shared/core/eligibility.ts";
import type { Observation } from "../../_shared/core/episodes.ts";
import type { Channel } from "../../_shared/core/indicator.ts";
import { applicableDiscountLine, type ThresholdLine, type UniverseMode } from "../../_shared/core/thresholds.ts";

/** One row of a stored universe_snapshots set. */
export interface SnapshotRow {
  mode: UniverseMode;
  securityId: string;
  companyId: string;
  rank: number;
  marketCapUsd: number;
  state: "member" | "carried_forward";
  applicableLine: ThresholdLine;
}

/** Consecutive most-recent snapshots (newest first) in which the security was carried forward in this mode. */
export function leadingCarried(history: ReadonlyArray<ReadonlyArray<SnapshotRow>>, mode: UniverseMode, securityId: string): number {
  let n = 0;
  for (const snap of history) {
    const row = snap.find((r) => r.mode === mode && r.securityId === securityId);
    if (row === undefined || row.state !== "carried_forward") break;
    n++;
  }
  return n;
}

export interface CarryPlan {
  carry: Array<{ mode: UniverseMode; securityId: string; companyId: string; marketCapUsd: number; previousRank: number }>;
  dropped: Array<{ mode: UniverseMode; securityId: string; companyId: string; reason: "data_unavailable" | "carry_limit" }>;
}

/**
 * A previous member that cannot be processed today keeps its place for at most `maxScans` consecutive scans (A-02, 7.7).
 * Only data problems carry (missing/stale/unprocessed inputs); a genuine ineligibility is a real removal, and a security that is a
 * member today is never carried (it left a mode legitimately, e.g. it stopped being US-primary).
 * `failedBySecurity`: undefined = no result row today (unprocessed), otherwise the Tier 1 failures.
 */
export function planCarryForward(a: {
  previous: ReadonlyArray<SnapshotRow>;
  history: ReadonlyArray<ReadonlyArray<SnapshotRow>>; // newest first, history[0] is `previous`
  memberIds: ReadonlySet<string>;
  failedBySecurity: ReadonlyMap<string, readonly RuleCode[]>;
  maxScans: number;
}): CarryPlan {
  const plan: CarryPlan = { carry: [], dropped: [] };
  for (const row of a.previous) {
    if (a.memberIds.has(row.securityId)) continue;
    const failed = a.failedBySecurity.get(row.securityId);
    const dataProblem = failed === undefined || carryForwardEligible(failed);
    if (!dataProblem) continue;
    const already = leadingCarried(a.history, row.mode, row.securityId);
    if (already >= a.maxScans) {
      plan.dropped.push({ mode: row.mode, securityId: row.securityId, companyId: row.companyId, reason: "carry_limit" });
    } else {
      plan.carry.push({ mode: row.mode, securityId: row.securityId, companyId: row.companyId, marketCapUsd: row.marketCapUsd, previousRank: row.rank });
    }
  }
  return plan;
}

export interface MembershipEvent {
  mode: UniverseMode;
  companyId: string;
  securityId: string;
  event: "added" | "removed";
  fromRank: number | null;
  toRank: number | null;
  reason: string;
}

/**
 * Diff of the previous list-published snapshot against today's (per mode, per company). Carried-forward rows count as still present
 * and never generate events; a carry that expired shows up as a removal with reason data_unavailable (7.7).
 */
export function membershipEvents(a: {
  previous: ReadonlyArray<SnapshotRow>;
  today: ReadonlyArray<SnapshotRow>;
  reasonFor(event: "added" | "removed", securityId: string, carryExpired: boolean): string;
}): MembershipEvent[] {
  const out: MembershipEvent[] = [];
  for (const mode of ["worldwide", "us"] as const) {
    const prev = new Map(a.previous.filter((r) => r.mode === mode).map((r) => [r.companyId, r]));
    const now = new Map(a.today.filter((r) => r.mode === mode).map((r) => [r.companyId, r]));
    for (const [companyId, row] of now) {
      if (row.state === "member" && !prev.has(companyId)) {
        out.push({ mode, companyId, securityId: row.securityId, event: "added", fromRank: null, toRank: row.rank, reason: a.reasonFor("added", row.securityId, false) });
      }
    }
    for (const [companyId, row] of prev) {
      if (!now.has(companyId)) {
        out.push({
          mode, companyId, securityId: row.securityId, event: "removed", fromRank: row.rank, toRank: null,
          reason: a.reasonFor("removed", row.securityId, row.state === "carried_forward"),
        });
      }
    }
  }
  return out.sort((x, y) => (x.mode < y.mode ? -1 : x.mode > y.mode ? 1 : x.companyId < y.companyId ? -1 : x.companyId > y.companyId ? 1 : x.event < y.event ? -1 : 1));
}

/** Human-meaningful reason code for a membership change (spec 6.3.4 examples). */
export function membershipReason(a: {
  event: "added" | "removed";
  failedNow: readonly RuleCode[] | null; // null = no result row today
  failedBefore: readonly RuleCode[] | null; // null = no result row in the previous scan
  carryExpired: boolean;
}): string {
  const has = (list: readonly RuleCode[] | null, code: RuleCode) => list !== null && list.includes(code);
  if (a.event === "removed") {
    if (a.carryExpired) return "data_unavailable";
    if (a.failedNow === null) return "delisted_or_missing";
    if (has(a.failedNow, "market_cap_below_threshold")) return "market_cap_below_threshold";
    if (has(a.failedNow, "channel_not_rising")) return "channel_not_rising";
    if (has(a.failedNow, "listing_too_new")) return "listing_too_new";
    if (has(a.failedNow, "not_canonical")) return "canonical_changed";
    return a.failedNow[0] ?? "data_unavailable";
  }
  if (a.failedBefore === null) return "new_listing";
  if (has(a.failedBefore, "market_cap_below_threshold")) return "market_cap_above_threshold";
  if (has(a.failedBefore, "channel_not_rising")) return "channel_rising";
  if (has(a.failedBefore, "not_canonical")) return "became_canonical";
  return "requirements_met";
}

export interface SecurityToday {
  sessionDay: number | null;
  close: number | null;
  /** Fresh data, not suspect, channel computed. */
  evaluable: boolean;
  channelEnd: Channel["end"] | null;
  freshness: string;
  tier1Member: boolean;
  carriedForward: boolean;
}

/**
 * Observation of one security in one mode (8.1). lineEnd is null whenever the data is not evaluable, which makes the state machine
 * a no-op: a data failure is never a reset. Returns null when there is no completed close at all.
 */
export function observationFor(a: {
  today: SecurityToday;
  rank: number | null;
  prevApplicableLine: ThresholdLine | null;
  signalGrade: boolean;
}): { obs: Observation; tier2Failed: RuleCode[] } | null {
  const t = a.today;
  if (t.sessionDay === null || t.close === null) return null;
  const applicableLine = applicableDiscountLine(a.rank);
  const lineEnd = t.evaluable && t.channelEnd !== null ? (applicableLine === "-3" ? t.channelEnd.lower1 : t.channelEnd.lower2) : null;
  const tier2 = evaluateTier2({ applicableLowerEnd: lineEnd, close: t.close, freshness: t.freshness, signalGrade: a.signalGrade });
  const canOpen = t.evaluable && t.tier1Member && !t.carriedForward && tier2.valid;
  return {
    obs: { sessionDay: t.sessionDay, close: t.close, lineEnd, canOpen, rank: a.rank, applicableLine, prevApplicableLine: a.prevApplicableLine },
    tier2Failed: tier2.failed,
  };
}
```

- [ ] **Step 9: Implement (6/22)**

**`supabase/functions/worker-tick/lib/volume.ts`**

```ts
import type { Series } from "../../_shared/core/bars.ts";

/**
 * Mean traded value in USD over the last `window` completed bars: (close / minorDivisor) * volume * usdPerUnit.
 * The price is in the quote unit (GBp), so it is converted to the major unit before FX. Null when there are no bars.
 */
export function averageUsdVolume(series: Series, minorDivisor: number, usdPerUnit: number, window = 30): number | null {
  const n = series.close.length;
  if (n === 0) return null;
  const from = Math.max(0, n - window);
  let sum = 0;
  for (let i = from; i < n; i++) sum += ((series.close[i] as number) / minorDivisor) * (series.volume[i] as number) * usdPerUnit;
  return sum / (n - from);
}
```

- [ ] **Step 10: Implement (7/22)**

**`supabase/functions/worker-tick/lib/data.ts`**

```ts
import type { SupabaseClient } from "@supabase/supabase-js";
import { dayNumber } from "../../_shared/core/calendar.ts";
import { mergeSettings } from "../../_shared/adapters/settings.ts";
import { chunk } from "./batching.ts";
import type { RunInfo } from "../types.ts";

/** Table access helpers shared by the stage handlers. PostgREST returns at most 1,000 rows per request, so reads are paged. */

export class DbQueryError extends Error {
  constructor(readonly op: string, message: string) {
    super(`${op}: ${message}`);
    this.name = "DbQueryError";
  }
}

type PageResult<T> = PromiseLike<{ data: T[] | null; error: { message: string } | null }>;

export async function fetchAll<T = Record<string, unknown>>(op: string, page: (from: number, to: number) => PageResult<T>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await page(from, from + 999);
    if (error) throw new DbQueryError(op, error.message);
    const rows = data ?? [];
    out.push(...rows);
    if (rows.length < 1000) return out;
  }
}

// deno-lint-ignore no-explicit-any
export type Query = any;

/** All rows of a table (paged), optionally narrowed by `apply`, e.g. (q) => q.eq("scan_run_id", id). */
export async function selectAll<T = Record<string, unknown>>(sb: SupabaseClient, table: string, columns: string, apply: (q: Query) => Query = (q) => q): Promise<T[]> {
  return await fetchAll<T>(`${table}.select`, (a, b) => apply(sb.from(table).select(columns)).range(a, b) as PageResult<T>);
}

/** Reads rows whose `idColumn` is in `ids`, 100 ids per request (URL length). */
export async function fetchByIds<T = Record<string, unknown>>(sb: SupabaseClient, table: string, columns: string, idColumn: string, ids: readonly string[]): Promise<T[]> {
  const out: T[] = [];
  for (const part of chunk([...new Set(ids)], 100)) {
    const rows = await fetchAll<T>(`${table}.by_ids`, (a, b) => sb.from(table).select(columns).in(idColumn, part).range(a, b) as unknown as PageResult<T>);
    out.push(...rows);
  }
  return out;
}

export async function upsertChunks(sb: SupabaseClient, table: string, rows: Array<Record<string, unknown>>, onConflict: string, size = 300): Promise<void> {
  for (const part of chunk(rows, size)) {
    const { error } = await sb.from(table).upsert(part, { onConflict });
    if (error) throw new DbQueryError(`${table}.upsert`, error.message);
  }
}

export async function insertChunks(sb: SupabaseClient, table: string, rows: Array<Record<string, unknown>>, size = 300): Promise<void> {
  for (const part of chunk(rows, size)) {
    const { error } = await sb.from(table).insert(part);
    if (error) throw new DbQueryError(`${table}.insert`, error.message);
  }
}

export async function deleteWhereRun(sb: SupabaseClient, table: string, runId: string): Promise<void> {
  const { error } = await sb.from(table).delete().eq("scan_run_id", runId);
  if (error) throw new DbQueryError(`${table}.delete`, error.message);
}

export function dayOfDate(iso: string): number {
  return dayNumber(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)), Number(iso.slice(8, 10)));
}

// ------------------------------------------------------------------------------------------------ run

export async function loadRun(sb: SupabaseClient, runId: string): Promise<RunInfo> {
  const { data, error } = await sb.from("scan_runs").select("id, scan_date_local, started_at, settings_snapshot").eq("id", runId).single();
  if (error) throw new DbQueryError("scan_runs.load", error.message);
  const snapshot = (data.settings_snapshot ?? {}) as Record<string, unknown>;
  const rows = ["indicator", "universe", "pipeline"].filter((k) => k in snapshot).map((key) => ({ key, value: snapshot[key] }));
  const { settings } = mergeSettings(rows);
  return {
    id: data.id as string,
    scanDateLocal: data.scan_date_local as string,
    scanDay: dayOfDate(data.scan_date_local as string),
    startedAtMs: Date.parse(data.started_at as string),
    settings,
    providerMode: snapshot["provider_mode"] === "fixture" ? "fixture" : "live",
    fixtureSet: typeof snapshot["fixture_set"] === "string" ? (snapshot["fixture_set"] as string) : null,
  };
}

/** The runs a worker may still advance: not yet terminal by status, newest first. */
export async function activeRunIds(sb: SupabaseClient): Promise<string[]> {
  const { data, error } = await sb.from("scan_runs").select("id").in("status", ["queued", "running", "partial"]).order("scan_date_local", { ascending: false }).limit(5);
  if (error) throw new DbQueryError("scan_runs.active", error.message);
  return (data ?? []).map((r: { id: string }) => r.id);
}

// ------------------------------------------------------------------------------------------------ fx

export interface FxEntry {
  ccy: string;
  usdPerUnit: number;
  rateDate: string;
  source: string;
}

/** Newest rate per currency. Input order does not matter. */
export function pickLatestRates(rows: ReadonlyArray<{ ccy: string; usd_per_unit: number; rate_date: string; source: string }>): Map<string, FxEntry> {
  const out = new Map<string, FxEntry>();
  for (const r of rows) {
    const ccy = r.ccy.trim();
    const have = out.get(ccy);
    if (have === undefined || r.rate_date > have.rateDate) out.set(ccy, { ccy, usdPerUnit: r.usd_per_unit, rateDate: r.rate_date, source: r.source });
  }
  return out;
}

/** Latest rate_date <= the scan date for every currency, looking back 10 days. */
export async function loadFxMap(sb: SupabaseClient, scanDateIso: string): Promise<Map<string, FxEntry>> {
  const from = new Date(Date.parse(`${scanDateIso}T00:00:00Z`) - 10 * 86_400_000).toISOString().slice(0, 10);
  const rows = await fetchAll<{ ccy: string; usd_per_unit: number; rate_date: string; source: string }>("fx_rates.load", (a, b) =>
    sb.from("fx_rates").select("ccy, usd_per_unit, rate_date, source").gte("rate_date", from).lte("rate_date", scanDateIso).range(a, b) as unknown as PageResult<{ ccy: string; usd_per_unit: number; rate_date: string; source: string }>,
  );
  return pickLatestRates(rows);
}

// ------------------------------------------------------------------------------------------------ exchanges and candidates

export interface ExchangeRow {
  code: string;
  country: string;
  timezone: string;
  currencies: string[];
  venue_class: "primary" | "secondary_only" | "otc";
  screener_enabled: boolean;
  trading_days: number[];
  session_close_local: string | null;
  max_gap_days: number;
  us_primary: boolean;
}

export async function loadExchanges(sb: SupabaseClient): Promise<Map<string, ExchangeRow>> {
  const rows = await fetchAll<ExchangeRow>("exchanges.load", (a, b) =>
    sb.from("exchanges").select("code, country, timezone, currencies, venue_class, screener_enabled, trading_days, session_close_local, max_gap_days, us_primary").range(a, b) as unknown as PageResult<ExchangeRow>,
  );
  return new Map(rows.map((r) => [r.code, r]));
}

export interface Candidate {
  securityId: string;
  companyId: string;
  yahooSymbol: string;
}

/** A canonical security is a scan candidate when its market cap is unknown (data problem) or at least the threshold. */
export function isCandidateCap(marketCapUsd: number | null, thresholdUsd: number): boolean {
  return marketCapUsd === null || marketCapUsd >= thresholdUsd;
}

/**
 * Candidates of a scan: canonical, active equities with a market-cap snapshot in this run whose cap is unknown or >= the threshold.
 * Sorted by symbol so batches are stable across retries.
 */
export async function selectCandidates(sb: SupabaseClient, runId: string, thresholdUsd: number): Promise<Candidate[]> {
  const securities = await fetchAll<{ id: string; company_id: string; yahoo_symbol: string }>("securities.canonical", (a, b) =>
    sb.from("securities").select("id, company_id, yahoo_symbol").eq("is_canonical", true).eq("status", "active").eq("quote_type", "EQUITY").range(a, b) as unknown as PageResult<{ id: string; company_id: string; yahoo_symbol: string }>,
  );
  const snaps = await fetchAll<{ security_id: string; market_cap_usd: number | null }>("market_cap_snapshots.run", (a, b) =>
    sb.from("market_cap_snapshots").select("security_id, market_cap_usd").eq("scan_run_id", runId).range(a, b) as unknown as PageResult<{ security_id: string; market_cap_usd: number | null }>,
  );
  const cap = new Map(snaps.map((s) => [s.security_id, s.market_cap_usd]));
  return securities
    .filter((s) => cap.has(s.id) && isCandidateCap(cap.get(s.id) ?? null, thresholdUsd))
    .map((s) => ({ securityId: s.id, companyId: s.company_id, yahooSymbol: s.yahoo_symbol }))
    .sort((a, b) => (a.yahooSymbol < b.yahooSymbol ? -1 : a.yahooSymbol > b.yahooSymbol ? 1 : 0));
}

export function isoOfMs(ms: number): string {
  return new Date(ms).toISOString();
}

export function dateOfMs(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString().slice(0, 10);
}
```

- [ ] **Step 11: Implement (8/22)**

**`supabase/functions/worker-tick/lib/quotes.ts`**

```ts
import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveCurrency } from "../../_shared/core/units.ts";
import { marketCapUsd as toUsd, MARKET_CAP_MAX_AGE_DAYS } from "../../_shared/core/eligibility.ts";
import { normalizeName } from "../../_shared/core/identity.ts";
import type { QuoteRecord } from "../../_shared/adapters/providers.ts";
import { chunk } from "./batching.ts";
import { DbQueryError, dateOfMs, isoOfMs, type FxEntry } from "./data.ts";

export type QuoteQuality = "ok" | "stale" | "missing" | "fx_missing";

export interface SnapshotInput {
  quality: QuoteQuality;
  marketCapUsd: number | null;
  fx: FxEntry | null;
  currencyMajor: string;
  minorDivisor: number;
}

/**
 * Market-cap facts of one quote row (4.1, 4.6). The market cap is already in the MAJOR unit (SHEL.L: currency GBp, cap in GBP), so only the
 * FX of the major currency applies and the cap is never divided by the minor-unit divisor.
 */
export function snapshotInput(row: Pick<QuoteRecord, "currency" | "marketCap" | "regularMarketTime">, fx: ReadonlyMap<string, FxEntry>, scanDay: number): SnapshotInput {
  const unit = resolveCurrency(row.currency);
  const entry = fx.get(unit.major) ?? null;
  let quality: QuoteQuality = "ok";
  let usd: number | null = null;
  if (row.marketCap === null) quality = "missing";
  else if (entry === null) quality = "fx_missing";
  else {
    usd = toUsd(row.marketCap, entry.usdPerUnit);
    const ageDays = row.regularMarketTime === null ? null : scanDay - Math.floor(row.regularMarketTime / 86_400_000);
    if (ageDays === null || ageDays > MARKET_CAP_MAX_AGE_DAYS) quality = "stale";
  }
  return { quality, marketCapUsd: usd, fx: entry, currencyMajor: unit.major, minorDivisor: unit.divisor };
}

export interface ApplyOutcome {
  seen: number;
  kept: number;
  belowThreshold: number;
  created: number;
  updated: number;
  skippedUnknownExchange: number;
}

/**
 * Writes quote-family rows (screener rows or quote() records) through app.apply_quote_rows.
 * keepBelowThreshold = false (sweep): rows under the USD floor are dropped, rows with unknown cap or FX are kept and flagged.
 * keepBelowThreshold = true (recheck): every known security is recorded so a removal is explained by a number.
 */
export async function applyQuoteRows(a: {
  sb: SupabaseClient;
  runId: string;
  scanDay: number;
  rows: QuoteRecord[];
  source: "yahoo_screener" | "yahoo_quote";
  fx: ReadonlyMap<string, FxEntry>;
  thresholdUsd: number;
  keepBelowThreshold: boolean;
  knownExchanges: ReadonlySet<string>;
}): Promise<ApplyOutcome> {
  const out: ApplyOutcome = { seen: a.rows.length, kept: 0, belowThreshold: 0, created: 0, updated: 0, skippedUnknownExchange: 0 };
  const payload: Array<Record<string, unknown>> = [];
  for (const row of a.rows) {
    if (!a.knownExchanges.has(row.exchange)) {
      out.skippedUnknownExchange += 1;
      continue;
    }
    const s = snapshotInput(row, a.fx, a.scanDay);
    if (!a.keepBelowThreshold && s.marketCapUsd !== null && s.marketCapUsd < a.thresholdUsd) {
      out.belowThreshold += 1;
      continue;
    }
    const name = row.longName ?? row.shortName ?? row.symbol;
    payload.push({
      yahoo_symbol: row.symbol,
      new_company_id: crypto.randomUUID(),
      name,
      name_normalized: normalizeName(name),
      exchange_code: row.exchange,
      currency: row.currency,
      currency_major: s.currencyMajor,
      minor_divisor: s.minorDivisor,
      quote_type: row.quoteType,
      long_name: row.longName,
      financial_currency: row.financialCurrency,
      shares_outstanding: row.sharesOutstanding === null ? null : Math.round(row.sharesOutstanding),
      first_trade_date: dateOfMs(row.firstTradeDateMs),
      market_cap_native: row.marketCap,
      fx_usd_per_unit: s.fx?.usdPerUnit ?? null,
      fx_rate_date: s.fx?.rateDate ?? null,
      fx_source: s.fx?.source ?? null,
      market_cap_usd: s.marketCapUsd,
      price_time: row.regularMarketTime === null ? null : isoOfMs(row.regularMarketTime),
      source: a.source,
      quality: s.quality,
    });
  }
  out.kept = payload.length;
  for (const part of chunk(payload, 250)) {
    const { data, error } = await a.sb.schema("app").rpc("apply_quote_rows", { p_run: a.runId, p_rows: part });
    if (error) throw new DbQueryError("apply_quote_rows", error.message);
    const r = data as { created: number; updated: number; skipped_unknown_exchange: number };
    out.created += r.created;
    out.updated += r.updated;
    out.skippedUnknownExchange += r.skipped_unknown_exchange;
  }
  return out;
}
```

- [ ] **Step 12: Implement (9/22)**

**`supabase/functions/worker-tick/lib/identity-data.ts`**

```ts
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ListingFact, Override } from "../../_shared/core/identity.ts";
import { fetchAll, fetchByIds, loadExchanges, dayOfDate, type ExchangeRow } from "./data.ts";

export interface SecRow {
  id: string;
  company_id: string;
  yahoo_symbol: string;
  exchange_code: string;
  long_name: string | null;
  shares_outstanding: number | null;
  avg_usd_volume_30d: number | null;
  first_trade_date: string | null;
  is_canonical: boolean;
  role: string;
  volume_probe_at: string | null;
  currency: string;
  currency_major: string;
  minor_divisor: number;
  financial_currency: string | null;
}
export interface CompanyRow {
  id: string;
  name: string;
  country: string | null;
  profile_refreshed_at: string | null;
}
export interface OverrideRow {
  kind: Override["kind"];
  yahoo_symbol: string;
  target_company_id: string | null;
}

export interface IdentityData {
  securities: Map<string, SecRow>;
  companies: Map<string, CompanyRow>;
  exchanges: Map<string, ExchangeRow>;
  capUsd: Map<string, number | null>;
  quality: Map<string, string>;
  barCounts: Map<string, number>;
  overrideRows: OverrideRow[];
  listings: ListingFact[];
  overrides: Override[];
}

const SEC_COLUMNS =
  "id, company_id, yahoo_symbol, exchange_code, long_name, shares_outstanding, avg_usd_volume_30d, first_trade_date, is_canonical, role, volume_probe_at, currency, currency_major, minor_divisor, financial_currency";

type Page<T> = PromiseLike<{ data: T[] | null; error: { message: string } | null }>;

/**
 * Everything identity needs: the securities seen in this run's snapshots plus the known canonical ones, their companies, venues,
 * USD caps, stored bar counts and the active manual overrides, already shaped as core ListingFacts.
 */
export async function loadIdentityData(sb: SupabaseClient, runId: string): Promise<IdentityData> {
  const snaps = await fetchAll<{ security_id: string; market_cap_usd: number | null; quality: string }>("market_cap_snapshots.run", (a, b) =>
    sb.from("market_cap_snapshots").select("security_id, market_cap_usd, quality").eq("scan_run_id", runId).range(a, b) as unknown as Page<{ security_id: string; market_cap_usd: number | null; quality: string }>,
  );
  const canonical = await fetchAll<SecRow>("securities.canonical", (a, b) =>
    sb.from("securities").select(SEC_COLUMNS).eq("is_canonical", true).eq("status", "active").range(a, b) as unknown as Page<SecRow>,
  );
  const ids = [...new Set([...snaps.map((s) => s.security_id), ...canonical.map((s) => s.id)])];
  const rows = await fetchByIds<SecRow>(sb, "securities", SEC_COLUMNS, "id", ids);
  const securities = new Map(rows.map((r) => [r.id, r]));
  const companies = new Map(
    (await fetchByIds<CompanyRow>(sb, "companies", "id, name, country, profile_refreshed_at", "id", [...new Set(rows.map((r) => r.company_id))])).map((c) => [c.id, c]),
  );
  const exchanges = await loadExchanges(sb);
  const bars = await fetchByIds<{ security_id: string; bar_count: number }>(sb, "price_series", "security_id, bar_count", "security_id", ids);
  const overrideRows = await fetchAll<OverrideRow>("overrides.active", (a, b) =>
    sb.from("security_identity_overrides").select("kind, yahoo_symbol, target_company_id").eq("active", true).range(a, b) as unknown as Page<OverrideRow>,
  );

  // merge_into_company names a company; the pure grouping needs a symbol of that company
  const targets = [...new Set(overrideRows.map((o) => o.target_company_id).filter((v): v is string => v !== null))];
  const targetSymbol = new Map<string, string>();
  if (targets.length > 0) {
    const targetSecs = await fetchByIds<{ company_id: string; yahoo_symbol: string; is_canonical: boolean }>(sb, "securities", "company_id, yahoo_symbol, is_canonical", "company_id", targets);
    for (const t of targetSecs.sort((a, b) => Number(b.is_canonical) - Number(a.is_canonical))) if (!targetSymbol.has(t.company_id)) targetSymbol.set(t.company_id, t.yahoo_symbol);
  }
  const overrides: Override[] = overrideRows.map((o) => ({
    kind: o.kind,
    yahooSymbol: o.yahoo_symbol,
    targetYahooSymbol: o.target_company_id === null ? null : (targetSymbol.get(o.target_company_id) ?? null),
  }));

  const capUsd = new Map(snaps.map((s) => [s.security_id, s.market_cap_usd]));
  const listings: ListingFact[] = rows.map((r) => {
    const ex = exchanges.get(r.exchange_code);
    return {
      securityId: r.id,
      symbol: r.yahoo_symbol,
      exchange: r.exchange_code,
      venueClass: ex?.venue_class ?? "secondary_only",
      exchangeCountry: ex?.country ?? "",
      longName: r.long_name,
      marketCapUsd: capUsd.get(r.id) ?? null,
      sharesOutstanding: r.shares_outstanding,
      avgUsdVolume30d: r.avg_usd_volume_30d,
      firstTradeDay: r.first_trade_date === null ? null : dayOfDate(r.first_trade_date),
    };
  });
  return {
    securities,
    companies,
    exchanges,
    capUsd,
    quality: new Map(snaps.map((s) => [s.security_id, s.quality])),
    barCounts: new Map(bars.map((b) => [b.security_id, b.bar_count])),
    overrideRows,
    listings,
    overrides,
  };
}
```

- [ ] **Step 13: Implement (10/22)**

**`supabase/functions/worker-tick/handlers/fx.ts`**

```ts
import { fxRowFor } from "../../_shared/adapters/fx.ts";
import { FatalJobError, type Handler, type Seeder } from "../types.ts";
import { fetchAll, upsertChunks } from "../lib/data.ts";

/** Stage 1 `fx` (key `all`): USD-per-unit rates for every currency the scan can meet. Frankfurter first, Yahoo for the gaps (5.4). */
export const handleFx: Handler = async (ctx) => {
  const sb = ctx.db.sb;
  const exchanges = await fetchAll<{ currencies: string[] }>("exchanges.currencies", (a, b) =>
    sb.from("exchanges").select("currencies").eq("screener_enabled", true).range(a, b) as unknown as PromiseLike<{ data: { currencies: string[] }[] | null; error: { message: string } | null }>,
  );
  const securities = await fetchAll<{ currency_major: string }>("securities.currencies", (a, b) =>
    sb.from("securities").select("currency_major").eq("status", "active").range(a, b) as unknown as PromiseLike<{ data: { currency_major: string }[] | null; error: { message: string } | null }>,
  );
  const wanted = [...new Set(["USD", ...exchanges.flatMap((e) => e.currencies), ...securities.map((s) => s.currency_major)])].sort();

  const { rates, missing } = await ctx.providers.fx.usdPerUnit(wanted);
  if (rates.length === 0) throw new Error("fx_unavailable: no provider returned a rate");
  if (!rates.some((r) => r.ccy === "USD")) throw new FatalJobError("fx_invalid: USD identity row missing");

  await upsertChunks(sb, "fx_rates", rates.map((r) => fxRowFor(r.ccy, r)), "rate_date,ccy");
  const newest = rates.map((r) => r.rateDate).sort().at(-1) ?? null;
  if (missing.length > 0) await ctx.log("fx_missing", { currencies: missing }, { level: "warn" });
  const sources: Record<string, number> = {};
  for (const r of rates) sources[r.source] = (sources[r.source] ?? 0) + 1;
  return { rate_date: newest, rates: rates.length, sources, missing };
};

/** `fx` is seeded by app.start_daily_scan; this seeder only exists so a manual re-seed of a wiped stage works. */
export const seedFx: Seeder = () => Promise.resolve({ keys: ["all"], priorities: [10] });
```

- [ ] **Step 14: Implement (11/22)**

**`supabase/functions/worker-tick/handlers/universe_sweep.ts`**

```ts
import { collectScreenerPages } from "../../_shared/adapters/yahoo.ts";
import { DeferError, FatalJobError, type Handler, type HandlerContext, type Seeder } from "../types.ts";
import { parseSweepKey, sweepKey } from "../lib/batching.ts";
import { fetchAll, loadExchanges, loadFxMap } from "../lib/data.ts";
import { applyQuoteRows } from "../lib/quotes.ts";

const MAX_RECHECK_SYMBOLS = 2500; // five quote() calls of 500: about 5 s, well inside one job

/**
 * Stage 2 `universe_sweep` (5.5). One job per screener-enabled exchange (key = exchange code, `<code>@<offset>` for follow-ups) plus one
 * `recheck:0` job that quotes the known canonical securities the sweep did not return, so a removal is explained by a number.
 */
export const seedUniverseSweep: Seeder = async (ctx) => {
  const exchanges = await loadExchanges(ctx.db.sb);
  const codes = [...exchanges.values()].filter((e) => e.screener_enabled).map((e) => e.code).sort();
  return { keys: [...codes, "recheck:0"], priorities: [...codes.map(() => 100), 200] };
};

export const handleUniverseSweep: Handler = (ctx) => {
  const key = parseSweepKey(ctx.job.key);
  if (key.kind === "recheck") return recheck(ctx);
  const payloadOffset = typeof ctx.job.payload["offset"] === "number" ? (ctx.job.payload["offset"] as number) : key.offset;
  return sweepExchange(ctx, key.code, payloadOffset);
};

async function sweepExchange(ctx: HandlerContext, code: string, offset: number): Promise<Record<string, unknown>> {
  const sb = ctx.db.sb;
  const exchanges = await loadExchanges(sb);
  const exchange = exchanges.get(code);
  if (exchange === undefined) throw new FatalJobError(`unknown_exchange:${code}`);
  const fx = await loadFxMap(sb, ctx.run.scanDateLocal);

  // The screener applies the market-cap operand in each row's OWN currency (spike 3.7). The strongest currency seen on the venue gives the
  // smallest numeric threshold and so the most inclusive query (A-17); the exact USD filter below removes the surplus.
  const rates = exchange.currencies.map((c) => fx.get(c)?.usdPerUnit).filter((v): v is number => v !== undefined);
  if (rates.length === 0) throw new Error(`fx_missing_for_exchange:${code}`);
  const { thresholdUsd, safetyMargin } = ctx.run.settings.universe;
  const localMin = (thresholdUsd * safetyMargin) / Math.max(...rates);

  const swept = await collectScreenerPages(ctx.providers.market, {
    exchange: code,
    minMarketCapLocal: localMin,
    startOffset: offset,
    maxPages: ctx.run.settings.pipeline.maxScreenerPagesPerJob,
  });
  const applied = await applyQuoteRows({
    sb,
    runId: ctx.run.id,
    scanDay: ctx.run.scanDay,
    rows: swept.rows,
    source: "yahoo_screener",
    fx,
    thresholdUsd,
    keepBelowThreshold: false,
    knownExchanges: new Set(exchanges.keys()),
  });
  if (applied.skippedUnknownExchange > 0) await ctx.log("unknown_exchange_rows", { exchange: code, rows: applied.skippedUnknownExchange }, { level: "warn" });

  if (swept.nextOffset !== null) {
    await ctx.db.seedStage({ run: ctx.run.id, stage: "universe_sweep", keys: [sweepKey(code, swept.nextOffset)], payloads: [{ offset: swept.nextOffset }], priorities: [100] });
  }
  return { exchange: code, offset, localMin, pages: swept.pages, total: swept.total, rawRows: swept.rows.length, ...applied, nextOffset: swept.nextOffset };
}

async function recheck(ctx: HandlerContext): Promise<Record<string, unknown>> {
  const sb = ctx.db.sb;
  const open = await sb
    .from("scan_jobs")
    .select("id", { count: "exact", head: true })
    .eq("scan_run_id", ctx.run.id)
    .eq("stage", "universe_sweep")
    .neq("key", ctx.job.key)
    .in("status", ["queued", "leased", "failed"]);
  if (open.error) throw new Error(`scan_jobs.count: ${open.error.message}`);
  if ((open.count ?? 0) > 0) throw new DeferError(30, "waiting_for_exchange_jobs");

  const known = await fetchAll<{ id: string; yahoo_symbol: string; missing_scans: number }>("securities.known", (a, b) =>
    sb.from("securities").select("id, yahoo_symbol, missing_scans").eq("is_canonical", true).eq("status", "active").range(a, b) as unknown as PromiseLike<{ data: { id: string; yahoo_symbol: string; missing_scans: number }[] | null; error: { message: string } | null }>,
  );
  const snaps = await fetchAll<{ security_id: string }>("market_cap_snapshots.run", (a, b) =>
    sb.from("market_cap_snapshots").select("security_id").eq("scan_run_id", ctx.run.id).range(a, b) as unknown as PromiseLike<{ data: { security_id: string }[] | null; error: { message: string } | null }>,
  );
  const seen = new Set(snaps.map((s) => s.security_id));
  const unseen = known.filter((k) => !seen.has(k.id)).slice(0, MAX_RECHECK_SYMBOLS);
  if (unseen.length === 0) return { known: known.length, unseen: 0, returned: 0, missing: 0, delisted: 0 };

  const exchanges = await loadExchanges(sb);
  const fx = await loadFxMap(sb, ctx.run.scanDateLocal);
  const rows = await ctx.providers.market.quote(unseen.map((u) => u.yahoo_symbol));
  const applied = await applyQuoteRows({
    sb,
    runId: ctx.run.id,
    scanDay: ctx.run.scanDay,
    rows,
    source: "yahoo_quote",
    fx,
    thresholdUsd: ctx.run.settings.universe.thresholdUsd,
    keepBelowThreshold: true,
    knownExchanges: new Set(exchanges.keys()),
  });

  // 5.8: three scans without data make a security delisted; its stored series stays
  const returned = new Set(rows.map((r) => r.symbol));
  let delisted = 0;
  let missing = 0;
  for (const u of unseen.filter((x) => !returned.has(x.yahoo_symbol))) {
    missing += 1;
    const next = u.missing_scans + 1;
    const status = next >= 3 ? "delisted" : "active";
    if (status === "delisted") delisted += 1;
    const { error } = await sb.from("securities").update({ missing_scans: next, status }).eq("id", u.id);
    if (error) throw new Error(`securities.update: ${error.message}`);
    await ctx.log("security_missing", { symbol: u.yahoo_symbol, missing_scans: next, status }, { level: "warn", securityId: u.id });
  }
  return { known: known.length, unseen: unseen.length, returned: rows.length, missing, delisted, ...applied };
}
```

- [ ] **Step 15: Implement (12/22)**

**`supabase/functions/worker-tick/handlers/identity.ts`**

```ts
import { cleanBars, type ChartMeta } from "../../_shared/core/bars.ts";
import { isoDate, subtractYears } from "../../_shared/core/calendar.ts";
import { applyForceCanonical, chooseCanonical, DEFAULT_SWITCH_RATIO, groupListings, normalizeName, type ListingFact } from "../../_shared/core/identity.ts";
import { DeferError, type Handler, type HandlerContext, type SeedPlan, type Seeder } from "../types.ts";
import { batchPlan, chunk } from "../lib/batching.ts";
import { fetchByIds, loadFxMap, DbQueryError } from "../lib/data.ts";
import { loadIdentityData, type IdentityData } from "../lib/identity-data.ts";
import { applyQuoteRows } from "../lib/quotes.ts";
import { averageUsdVolume } from "../lib/volume.ts";

const PROFILE_MAX_AGE_MS = 30 * 86_400_000; // A-35
const PROBE_MAX_AGE_MS = 7 * 86_400_000; // A-35
const OPEN = ["queued", "leased", "failed"];

/**
 * Stage 3 `identity`. Jobs (all in this stage): `quote-enrich:<n>` (500 symbols), `profile:<n>` (25 companies), `volume_probe:<n>`
 * (12 securities), and `group:0`, which runs last and applies the pure grouping and canonical choice of core/identity.ts (5.6).
 */
export const seedIdentity: Seeder = async (ctx) => {
  const data = await loadIdentityData(ctx.db.sb, ctx.run.id);
  const pipeline = ctx.run.settings.pipeline;
  const { groups } = groupListings(data.listings, data.overrides);

  const enrich = [...data.securities.values()]
    .filter((s) => (data.quality.get(s.id) ?? "ok") !== "ok" || s.shares_outstanding === null || s.first_trade_date === null)
    .map((s) => s.id)
    .sort();

  const profile: string[] = [];
  const probe: string[] = [];
  for (const group of groups) {
    const primaries = group.filter((l) => l.venueClass === "primary");
    const pool = primaries.length > 0 ? primaries : group;
    const rep = [...pool].sort((a, b) => (b.marketCapUsd ?? -1) - (a.marketCapUsd ?? -1) || (a.symbol < b.symbol ? -1 : 1))[0] as ListingFact;
    const company = data.companies.get((data.securities.get(rep.securityId) as { company_id: string }).company_id);
    const refreshed = company?.profile_refreshed_at === null || company?.profile_refreshed_at === undefined ? null : Date.parse(company.profile_refreshed_at);
    if (company !== undefined && (refreshed === null || ctx.run.startedAtMs - refreshed > PROFILE_MAX_AGE_MS)) profile.push(rep.securityId);

    const hasCanonical = group.some((l) => data.securities.get(l.securityId)?.is_canonical === true);
    if (primaries.length >= 2 || (!hasCanonical && primaries.length > 0)) {
      for (const l of primaries) {
        const probedAt = data.securities.get(l.securityId)?.volume_probe_at ?? null;
        if (probedAt === null || ctx.run.startedAtMs - Date.parse(probedAt) > PROBE_MAX_AGE_MS) probe.push(l.securityId);
      }
    }
  }

  const plans: SeedPlan[] = [
    batchPlan("quote-enrich", enrich, pipeline.batch.quoteBatch, 100),
    batchPlan("profile", profile.sort(), pipeline.batch.profile, 110),
    batchPlan("volume_probe", probe.sort(), pipeline.batch.volumeProbe, 120),
    { keys: ["group:0"], payloads: [{}], priorities: [200] },
  ];
  return {
    keys: plans.flatMap((p) => p.keys),
    payloads: plans.flatMap((p) => p.payloads ?? p.keys.map(() => ({}))),
    priorities: plans.flatMap((p) => p.priorities ?? p.keys.map(() => 100)),
  };
};

export const handleIdentity: Handler = (ctx) => {
  const kind = ctx.job.key.split(":")[0];
  switch (kind) {
    case "quote-enrich":
      return quoteEnrich(ctx);
    case "profile":
      return profileJob(ctx);
    case "volume_probe":
      return volumeProbe(ctx);
    case "group":
      return groupJob(ctx);
    default:
      throw new Error(`unknown identity job ${ctx.job.key}`);
  }
};

const idsOf = (ctx: HandlerContext): string[] => (Array.isArray(ctx.job.payload["securityIds"]) ? (ctx.job.payload["securityIds"] as string[]) : []);

async function quoteEnrich(ctx: HandlerContext): Promise<Record<string, unknown>> {
  const sb = ctx.db.sb;
  const secs = await fetchByIds<{ yahoo_symbol: string }>(sb, "securities", "yahoo_symbol", "id", idsOf(ctx));
  const exchanges = (await loadIdentityData(sb, ctx.run.id)).exchanges;
  const rows = await ctx.providers.market.quote(secs.map((s) => s.yahoo_symbol));
  const applied = await applyQuoteRows({
    sb, runId: ctx.run.id, scanDay: ctx.run.scanDay, rows, source: "yahoo_quote", fx: await loadFxMap(sb, ctx.run.scanDateLocal),
    thresholdUsd: ctx.run.settings.universe.thresholdUsd, keepBelowThreshold: true, knownExchanges: new Set(exchanges.keys()),
  });
  return { requested: secs.length, returned: rows.length, ...applied };
}

async function profileJob(ctx: HandlerContext): Promise<Record<string, unknown>> {
  const sb = ctx.db.sb;
  const secs = await fetchByIds<{ id: string; company_id: string; yahoo_symbol: string }>(sb, "securities", "id, company_id, yahoo_symbol", "id", idsOf(ctx));
  let updated = 0;
  let failed = 0;
  for (const s of secs) {
    ctx.signal.throwIfAborted();
    try {
      const p = await ctx.providers.market.profile(s.yahoo_symbol);
      const { error } = await sb
        .from("companies")
        .update({ country: p.country, sector: p.sector, industry: p.industry, profile_refreshed_at: new Date(ctx.run.startedAtMs).toISOString() })
        .eq("id", s.company_id);
      if (error) throw new DbQueryError("companies.update", error.message);
      updated += 1;
    } catch (e) {
      if (e instanceof DbQueryError || (e instanceof Error && e.name === "YahooUnavailableError")) throw e;
      failed += 1;
      await ctx.log("security_failed", { stage: "profile", reason: e instanceof Error ? e.name : "error" }, { level: "warn", securityId: s.id });
    }
  }
  return { requested: secs.length, updated, failed };
}

async function volumeProbe(ctx: HandlerContext): Promise<Record<string, unknown>> {
  const sb = ctx.db.sb;
  const secs = await fetchByIds<{ id: string; yahoo_symbol: string; currency_major: string; minor_divisor: number }>(sb, "securities", "id, yahoo_symbol, currency_major, minor_divisor", "id", idsOf(ctx));
  const fx = await loadFxMap(sb, ctx.run.scanDateLocal);
  let probed = 0;
  let failed = 0;
  for (const s of secs) {
    ctx.signal.throwIfAborted();
    const rate = fx.get(s.currency_major);
    if (rate === undefined) {
      failed += 1;
      await ctx.log("security_failed", { stage: "volume_probe", reason: "fx_missing", currency: s.currency_major }, { level: "warn", securityId: s.id });
      continue;
    }
    try {
      const chart = await ctx.providers.market.chart(s.yahoo_symbol, { period1: isoDate(ctx.run.scanDay - 60), interval: "1d", events: "split" });
      const meta: ChartMeta = { exchangeTimezoneName: chart.meta.exchangeTimezoneName, regularMarketTime: chart.meta.regularMarketTime, currentTradingPeriod: chart.meta.currentTradingPeriod };
      const { series } = cleanBars(chart.bars, meta, ctx.run.startedAtMs);
      const avg = averageUsdVolume(series, s.minor_divisor, rate.usdPerUnit);
      if (avg === null) throw new Error("no_bars");
      const { error } = await sb.from("securities").update({ avg_usd_volume_30d: avg, volume_probe_at: new Date(ctx.run.startedAtMs).toISOString() }).eq("id", s.id);
      if (error) throw new DbQueryError("securities.update", error.message);
      probed += 1;
    } catch (e) {
      if (e instanceof DbQueryError || (e instanceof Error && e.name === "YahooUnavailableError")) throw e;
      failed += 1;
      await ctx.log("security_failed", { stage: "volume_probe", reason: e instanceof Error ? e.message : "error" }, { level: "warn", securityId: s.id });
    }
  }
  return { requested: secs.length, probed, failed };
}

/** Applies grouping, canonical choice and roles. Runs after every other identity job of the run. */
async function groupJob(ctx: HandlerContext): Promise<Record<string, unknown>> {
  const sb = ctx.db.sb;
  const siblings = await sb
    .from("scan_jobs")
    .select("id", { count: "exact", head: true })
    .eq("scan_run_id", ctx.run.id)
    .eq("stage", "identity")
    .neq("key", ctx.job.key)
    .in("status", OPEN);
  if (siblings.error) throw new Error(`scan_jobs.count: ${siblings.error.message}`);
  if ((siblings.count ?? 0) > 0) throw new DeferError(20, "waiting_for_identity_jobs");

  const data = await loadIdentityData(sb, ctx.run.id);
  const { groups, needsReview } = groupListings(data.listings, data.overrides);
  const { indicator, universe } = ctx.run.settings;
  const cutoff = subtractYears(ctx.run.scanDay, universe.minHistoryYears);
  const eligible = (l: ListingFact) => l.firstTradeDay !== null && l.firstTradeDay <= cutoff && (data.barCounts.get(l.securityId) ?? 0) >= indicator.length;

  const payload: Array<Record<string, unknown>> = [];
  let switched = 0;
  let blocked = 0;
  let unverified = 0;
  let noPrimary = 0;
  for (const group of groups) {
    const members = group.map((l) => data.securities.get(l.securityId)).filter((s): s is NonNullable<typeof s> => s !== undefined);
    const current = members.find((s) => s.is_canonical);
    // the surviving company: the one that already holds the canonical listing, else the smallest id
    const companyIds = [...new Set(members.map((m) => m.company_id))].sort();
    const target = current?.company_id ?? (companyIds[0] as string);
    const country = [target, ...companyIds].map((id) => data.companies.get(id)?.country ?? null).find((c) => c !== null) ?? null;

    let result = chooseCanonical(group, country, current === undefined ? null : { securityId: current.id }, { switchRatio: DEFAULT_SWITCH_RATIO, isHistoryEligible: eligible });
    result = applyForceCanonical(group, result, data.overrides);
    if (result.flags.includes("canonical_switched")) switched += 1;
    if (result.flags.includes("canonical_switch_blocked")) blocked += 1;
    if (result.flags.includes("canonical_unverified")) unverified += 1;
    if (result.flags.includes("no_primary_listing")) noPrimary += 1;

    const canonicalListing = group.find((l) => l.securityId === result.canonicalId);
    const name = canonicalListing?.longName ?? group.find((l) => l.longName !== null)?.longName ?? (group[0] as ListingFact).symbol;
    payload.push({
      company_id: target,
      member_ids: group.map((l) => l.securityId),
      canonical_id: result.canonicalId,
      roles: result.roles,
      country,
      name,
      name_normalized: normalizeName(name),
    });
    if (result.canonicalId !== null && current !== undefined && result.canonicalId !== current.id) {
      await ctx.log("canonical_changed", { symbol: canonicalListing?.symbol, from: current.yahoo_symbol, flags: result.flags }, { securityId: result.canonicalId });
    }
  }

  let merged = 0;
  let deleted = 0;
  let deactivated = 0;
  for (const part of chunk(payload, 100)) {
    const { data: res, error } = await sb.schema("app").rpc("apply_identity_groups", { p_groups: part });
    if (error) throw new DbQueryError("apply_identity_groups", error.message);
    const r = res as { orphans_deleted: number; orphans_deactivated: number };
    deleted += r.orphans_deleted;
    deactivated += r.orphans_deactivated;
  }
  merged = groups.filter((g) => g.length > 1).length;
  if (needsReview.length > 0) await ctx.log("identity_needs_review", { pairs: needsReview.slice(0, 50), total: needsReview.length }, { level: "warn" });
  return { groups: groups.length, merged, switched, blocked, unverified, noPrimary, needsReview: needsReview.length, orphansDeleted: deleted, orphansDeactivated: deactivated };
}

export type { IdentityData };
```

- [ ] **Step 16: Implement (13/22)**

**`supabase/functions/worker-tick/handlers/fetch_bars.ts`**

```ts
import { cleanBars, mergeIncremental, seriesStats, takeLatest, type ChartMeta, type Series } from "../../_shared/core/bars.ts";
import { freshnessOf, isoDate, subtractYears } from "../../_shared/core/calendar.ts";
import { BudgetExceededError, YahooUnavailableError } from "../../_shared/adapters/throttle.ts";
import type { Handler, HandlerContext, Seeder } from "../types.ts";
import { batchPlan } from "../lib/batching.ts";
import { DbQueryError, dayOfDate, fetchByIds, isoOfMs, loadExchanges, selectCandidates } from "../lib/data.ts";
import { rowFromSeries, sameSeries, seriesFromRow, type PriceSeriesRow } from "../lib/series.ts";

const BACKFILL_YEARS = 13; // 5.2: scanDate - 13 years
const INCREMENTAL_OVERLAP_DAYS = 10; // refetch the last ten calendar days; mergeIncremental compares the overlap

/** Stage 4 `fetch_bars`: one job per 12 candidate securities (A-09), key `bars:<n>`; drift follow-ups are `backfill:<security id>`. */
export const seedFetchBars: Seeder = async (ctx) => {
  const candidates = await selectCandidates(ctx.db.sb, ctx.run.id, ctx.run.settings.universe.thresholdUsd);
  return batchPlan("bars", candidates.map((c) => c.securityId), ctx.run.settings.pipeline.batch.fetchBars, 100);
};

interface SecRow {
  id: string;
  yahoo_symbol: string;
  exchange_code: string;
  missing_scans: number;
}

/** Errors that end the whole job (retry / defer) instead of failing a single security. */
const isJobLevel = (e: unknown): boolean =>
  e instanceof YahooUnavailableError || e instanceof BudgetExceededError || e instanceof DbQueryError || (e instanceof DOMException && e.name === "AbortError");

export const handleFetchBars: Handler = async (ctx: HandlerContext) => {
  const sb = ctx.db.sb;
  const ids = Array.isArray(ctx.job.payload["securityIds"]) ? (ctx.job.payload["securityIds"] as string[]) : [];
  const forceBackfill = ctx.job.payload["mode"] === "backfill";
  const nowIso = isoOfMs(ctx.run.startedAtMs);

  const secs = await fetchByIds<SecRow>(sb, "securities", "id, yahoo_symbol, exchange_code, missing_scans", "id", ids);
  const exchanges = await loadExchanges(sb);
  const stored = new Map(
    (await fetchByIds<PriceSeriesRow>(sb, "price_series", "security_id, bar_dates, open, high, low, close, volume, bar_count, last_session_date, last_full_refresh_at, completeness", "security_id", ids)).map((r) => [r.security_id, r]),
  );

  // marketState cross-check (4.3.1): one quote() per job of 12
  const states = new Map<string, string>();
  try {
    for (const q of await ctx.providers.market.quote(secs.map((s) => s.yahoo_symbol))) if (q.marketState !== null) states.set(q.symbol, q.marketState);
  } catch (e) {
    if (isJobLevel(e)) throw e;
  }

  const result = { requested: secs.length, written: 0, unchanged: 0, drift: 0, failed: 0 };
  for (const sec of secs) {
    ctx.signal.throwIfAborted();
    const ex = exchanges.get(sec.exchange_code);
    if (ex === undefined) {
      result.failed += 1;
      await ctx.log("security_failed", { stage: "fetch_bars", reason: "unknown_exchange" }, { level: "warn", securityId: sec.id });
      continue;
    }
    const row = stored.get(sec.id);
    const mode: "backfill" | "incremental" = forceBackfill || row === undefined ? "backfill" : "incremental";
    try {
      const period1 = mode === "backfill" ? isoDate(subtractYears(ctx.run.scanDay, BACKFILL_YEARS)) : isoDate(dayOfDate((row as PriceSeriesRow).last_session_date) - INCREMENTAL_OVERLAP_DAYS);
      const chart = await ctx.providers.market.chart(sec.yahoo_symbol, { period1, interval: "1d", events: "split" });
      const state = states.get(sec.yahoo_symbol);
      const meta: ChartMeta = {
        exchangeTimezoneName: chart.meta.exchangeTimezoneName,
        regularMarketTime: chart.meta.regularMarketTime,
        currentTradingPeriod: chart.meta.currentTradingPeriod,
        sessionCloseLocal: ex.session_close_local === null ? null : ex.session_close_local.slice(0, 5),
        ...(state === undefined ? {} : { marketState: state }),
      };
      const { series: fetched, report } = cleanBars(chart.bars, meta, ctx.run.startedAtMs);
      if (fetched.dates.length === 0) throw new Error("no_bars");

      let final: Series = fetched;
      let lastFullRefresh = nowIso;
      if (mode === "incremental" && row !== undefined) {
        const newerSplit = chart.splits.some((s) => s.dateMs > Date.parse(row.last_full_refresh_at));
        const merged = mergeIncremental(seriesFromRow(row), fetched, { newerSplit });
        if (merged.adjustmentDrift) {
          // a split rewrote history (or adjustment cannot be proven): never store a partially merged series
          result.drift += 1;
          await ctx.log("bars_adjustment_drift", { maxRelDiff: merged.maxRelDiff, overlapBars: merged.overlapBars, newerSplit }, { level: "warn", securityId: sec.id });
          await ctx.db.seedStage({ run: ctx.run.id, stage: "fetch_bars", keys: [`backfill:${sec.id}`], payloads: [{ securityIds: [sec.id], mode: "backfill" }], priorities: [90] });
          continue;
        }
        final = merged.series;
        lastFullRefresh = row.last_full_refresh_at;
      }
      final = takeLatest(final, ctx.run.settings.pipeline.maxStoredBars);

      const stats = seriesStats(final);
      const freshness = freshnessOf(final.dates[final.dates.length - 1] ?? null, ctx.run.scanDay, ex.max_gap_days);
      const completeness = {
        validBars: final.dates.length,
        droppedNullClose: report.droppedNullClose,
        droppedNullHighLow: report.droppedNullHighLow,
        droppedNonPositive: report.droppedNonPositive,
        droppedDuplicates: report.droppedDuplicates,
        droppedForming: report.droppedForming,
        ohlcInconsistent: stats.ohlcInconsistent,
        jumpAnomalies: stats.jumpAnomalies,
        missingSessionRatio: stats.missingSessionRatio,
        suspect: stats.suspect,
        lastFetchMode: mode,
      };

      if (mode === "incremental" && row !== undefined && sameSeries(seriesFromRow(row), final)) {
        // nothing new (weekend, holiday): do not rewrite the TOASTed arrays, only refresh the cheap columns
        const { error } = await sb.from("price_series").update({ retrieved_at: nowIso, freshness, completeness }).eq("security_id", sec.id);
        if (error) throw new DbQueryError("price_series.update", error.message);
        result.unchanged += 1;
      } else {
        const { error } = await sb
          .from("price_series")
          .upsert(rowFromSeries({ securityId: sec.id, series: final, completeness, freshness, nowIso, lastFullRefreshIso: lastFullRefresh }), { onConflict: "security_id" });
        if (error) throw new DbQueryError("price_series.upsert", error.message);
        result.written += 1;
      }
      if (sec.missing_scans > 0) await sb.from("securities").update({ missing_scans: 0 }).eq("id", sec.id);
    } catch (e) {
      if (isJobLevel(e)) throw e;
      result.failed += 1;
      await ctx.log("security_failed", { stage: "fetch_bars", reason: e instanceof Error ? e.message.slice(0, 120) : "error", mode }, { level: "warn", securityId: sec.id });
      await sb.from("securities").update({ missing_scans: sec.missing_scans + 1 }).eq("id", sec.id);
    }
  }
  return result;
};
```

- [ ] **Step 17: Implement (14/22)**

**`supabase/functions/worker-tick/handlers/compute.ts`**

```ts
import { freshnessOf } from "../../_shared/core/calendar.ts";
import { evaluateTier1, type Tier1Input } from "../../_shared/core/eligibility.ts";
import { computeChannel } from "../../_shared/core/indicator.ts";
import type { Handler, HandlerContext, Seeder } from "../types.ts";
import { batchPlan } from "../lib/batching.ts";
import { dayOfDate, fetchByIds, loadExchanges, selectCandidates, upsertChunks } from "../lib/data.ts";
import { hashWindow } from "../lib/series.ts";

/** Stage 5 `compute`: one job per 25 candidate securities (A-09), key `compute:<n>`. */
export const seedCompute: Seeder = async (ctx) => {
  const candidates = await selectCandidates(ctx.db.sb, ctx.run.id, ctx.run.settings.universe.thresholdUsd);
  return batchPlan("compute", candidates.map((c) => c.securityId), ctx.run.settings.pipeline.batch.compute, 100);
};

interface SecRow {
  id: string;
  yahoo_symbol: string;
  quote_type: string;
  is_canonical: boolean;
  exchange_code: string;
  first_trade_date: string | null;
}
interface BarsRow {
  security_id: string;
  close: number[];
  high: number[];
  low: number[];
  bar_count: number;
  last_session_date: string;
  completeness: { suspect?: boolean };
}
interface SnapRow {
  security_id: string;
  market_cap_native: number | null;
  fx_usd_per_unit: number | null;
  price_time: string | null;
}

/**
 * Reads the stored series, computes the channel with the run's indicator settings, evaluates Tier 1 and writes one
 * scan_security_results row per security (status, reason codes, channel, window hash). A failure of one security never fails the job.
 */
export const handleCompute: Handler = async (ctx: HandlerContext) => {
  const sb = ctx.db.sb;
  const ids = Array.isArray(ctx.job.payload["securityIds"]) ? (ctx.job.payload["securityIds"] as string[]) : [];
  const { indicator } = ctx.run.settings;
  const secs = new Map((await fetchByIds<SecRow>(sb, "securities", "id, yahoo_symbol, quote_type, is_canonical, exchange_code, first_trade_date", "id", ids)).map((r) => [r.id, r]));
  const bars = new Map((await fetchByIds<BarsRow>(sb, "price_series", "security_id, close, high, low, bar_count, last_session_date, completeness", "security_id", ids)).map((r) => [r.security_id, r]));
  const snaps = new Map(
    (await fetchByIds<SnapRow>(sb, "market_cap_snapshots", "security_id, market_cap_native, fx_usd_per_unit, price_time", "security_id", ids)).map((r) => [r.security_id, r]),
  );
  const exchanges = await loadExchanges(sb);

  const rows: Array<Record<string, unknown>> = [];
  const counts: Record<string, number> = { processed: 0, insufficient_data: 0, stale: 0, failed: 0 };
  for (const id of ids) {
    ctx.signal.throwIfAborted();
    const sec = secs.get(id);
    if (sec === undefined) continue;
    const series = bars.get(id);
    const base = { scan_run_id: ctx.run.id, security_id: id, scope: "universe", computed_at: new Date().toISOString() };
    if (series === undefined) {
      rows.push({ ...base, status: "failed", reason_codes: ["unprocessed"], tier1_member: false });
      counts["failed"] = (counts["failed"] ?? 0) + 1;
      await ctx.log("security_failed", { stage: "compute", reason: "no_price_series" }, { level: "warn", securityId: id });
      continue;
    }

    const lastDay = dayOfDate(series.last_session_date);
    const maxGap = exchanges.get(sec.exchange_code)?.max_gap_days ?? 5;
    const freshness = freshnessOf(lastDay, ctx.run.scanDay, maxGap);
    const outcome = computeChannel({ close: series.close, high: series.high, low: series.low }, indicator);
    const snap = snaps.get(id);
    const priceMs = snap?.price_time == null ? null : Date.parse(snap.price_time);
    const input: Tier1Input = {
      quoteType: sec.quote_type,
      isCanonical: sec.is_canonical,
      marketCapMajor: snap?.market_cap_native ?? null,
      marketCapAgeDays: priceMs === null ? null : ctx.run.scanDay - Math.floor(priceMs / 86_400_000),
      fxUsdPerUnit: snap?.fx_usd_per_unit ?? null,
      firstTradeDay: sec.first_trade_date === null ? null : dayOfDate(sec.first_trade_date),
      dataSessionDay: lastDay,
      validBars: series.bar_count,
      freshness,
      suspect: series.completeness.suspect === true,
      channel: outcome,
      settingsLength: indicator.length,
    };
    const tier1 = evaluateTier1(input);
    const status = series.bar_count < indicator.length ? "insufficient_data" : freshness !== "fresh" ? "stale" : "processed";
    counts[status] = (counts[status] ?? 0) + 1;
    rows.push({
      ...base,
      status,
      reason_codes: tier1.failed,
      session_date: series.last_session_date,
      close: series.close[series.close.length - 1] ?? null,
      freshness,
      valid_bars: series.bar_count,
      bars_hash: await hashWindow(series, indicator.length),
      channel: outcome.ok ? outcome.channel : null,
      market_cap_usd: tier1.marketCapUsd,
      tier1_member: tier1.member,
    });
  }
  await upsertChunks(sb, "scan_security_results", rows, "scan_run_id,security_id", 100);
  return { requested: ids.length, written: rows.length, ...counts };
};
```

- [ ] **Step 18: Implement (15/22)**

**`supabase/functions/worker-tick/handlers/rank_signals.ts`**

```ts
import { assertSignalGradeSettings, type Channel } from "../../_shared/core/indicator.ts";
import { evaluateTier2, type RuleCode } from "../../_shared/core/eligibility.ts";
import { stepDiscount, type ActiveEpisode, type EpisodeAction } from "../../_shared/core/episodes.ts";
import { isUsPrimary, rankUniverse, type RankCandidate, type RankedRow } from "../../_shared/core/ranking.ts";
import { applicableDiscountLine, lineEnd as lineEndOf, type ThresholdLine, type UniverseMode } from "../../_shared/core/thresholds.ts";
import type { Handler, HandlerContext, Seeder } from "../types.ts";
import { computeCoverage, type ResultStatus } from "../lib/coverage.ts";
import { DbQueryError, dayOfDate, deleteWhereRun, fetchByIds, insertChunks, loadExchanges, selectAll, selectCandidates } from "../lib/data.ts";
import { membershipEvents, membershipReason, observationFor, planCarryForward, type SnapshotRow } from "../lib/rank-helpers.ts";

const MODES: UniverseMode[] = ["worldwide", "us"];

/** Stage 6 `rank_signals` (key `rank`): ranks both modes, evaluates discount episodes, writes snapshots and the technical cards. */
export const seedRankSignals: Seeder = () => Promise.resolve({ keys: ["rank"], priorities: [100] });

interface ResultRow {
  security_id: string;
  status: ResultStatus;
  reason_codes: RuleCode[];
  session_date: string | null;
  close: number | null;
  freshness: "fresh" | "stale" | "unavailable" | null;
  channel: Channel | null;
  market_cap_usd: number | null;
  tier1_member: boolean;
}
interface SecRow {
  id: string;
  company_id: string;
  yahoo_symbol: string;
  exchange_code: string;
  currency: string;
  currency_major: string;
  financial_currency: string | null;
  avg_usd_volume_30d: number | null;
}
interface EpisodeRow {
  id: string;
  security_id: string;
  company_id: string;
  mode: UniverseMode;
  threshold_line: ThresholdLine;
  opened_session_date: string;
  opened_scan_run_id: string;
  last_evaluated_session_date: string;
  rank_history: Array<{ rank: number | null }>;
}
interface PrevSnapshotDb {
  scan_run_id: string;
  mode: UniverseMode;
  security_id: string;
  company_id: string;
  rank: number;
  market_cap_usd: number;
  state: "member" | "carried_forward";
  applicable_line: ThresholdLine;
}

const lowerKey = (line: ThresholdLine): "lower1" | "lower2" | "upper1" | "upper2" =>
  line === "-3" ? "lower1" : line === "-4" ? "lower2" : line === "+1" ? "upper1" : "upper2";

export const handleRankSignals: Handler = async (ctx: HandlerContext) => {
  const sb = ctx.db.sb;
  const { run } = ctx;
  const { settings } = run;
  assertSignalGradeSettings(settings.indicator); // also checked at scan start; a production scan never runs on custom magnitudes (A-34)

  // ---------------------------------------------------------------- load
  const results = await selectAll<ResultRow>(sb, "scan_security_results", "security_id, status, reason_codes, session_date, close, freshness, channel, market_cap_usd, tier1_member", (q) => q.eq("scan_run_id", run.id));
  const resultOf = new Map(results.map((r) => [r.security_id, r]));
  const snaps = await selectAll<{ security_id: string; market_cap_usd: number | null; market_cap_native: number | null; currency_major: string }>(
    sb, "market_cap_snapshots", "security_id, market_cap_usd, market_cap_native, currency_major", (q) => q.eq("scan_run_id", run.id));
  const snapOf = new Map(snaps.map((s) => [s.security_id, s]));

  const historyRuns = (await sb.from("scan_runs").select("id").not("list_published_at", "is", null).lt("scan_date_local", run.scanDateLocal).order("scan_date_local", { ascending: false }).limit(settings.pipeline.carryForwardMaxScans)).data as Array<{ id: string }> | null ?? [];
  const historyRaw = historyRuns.length === 0 ? [] : await fetchByIds<PrevSnapshotDb>(sb, "universe_snapshots", "scan_run_id, mode, security_id, company_id, rank, market_cap_usd, state, applicable_line", "scan_run_id", historyRuns.map((r) => r.id));
  const toSnapshot = (r: PrevSnapshotDb): SnapshotRow => ({ mode: r.mode, securityId: r.security_id, companyId: r.company_id, rank: r.rank, marketCapUsd: r.market_cap_usd, state: r.state, applicableLine: r.applicable_line });
  const history: SnapshotRow[][] = historyRuns.map((h) => historyRaw.filter((r) => r.scan_run_id === h.id).map(toSnapshot));
  const previous = history[0] ?? [];
  const priorResults = new Map<string, RuleCode[]>();
  if (historyRuns[0] !== undefined) {
    for (const r of await fetchByIds<{ security_id: string; reason_codes: RuleCode[] }>(sb, "scan_security_results", "security_id, reason_codes", "scan_run_id", [historyRuns[0].id])) priorResults.set(r.security_id, r.reason_codes);
  }

  const episodes = await selectAll<EpisodeRow>(sb, "signal_episodes", "id, security_id, company_id, mode, threshold_line, opened_session_date, opened_scan_run_id, last_evaluated_session_date, rank_history",
    (q) => q.eq("kind", "discount").eq("status", "active"));

  const members = results.filter((r) => r.tier1_member);
  const memberIds = new Set(members.map((m) => m.security_id));
  const failedBySecurity = new Map(results.map((r) => [r.security_id, r.reason_codes]));
  const carry = planCarryForward({ previous, history, memberIds, failedBySecurity, maxScans: settings.pipeline.carryForwardMaxScans });
  const carriedIds = new Set(carry.carry.map((c) => c.securityId));

  const allIds = [...new Set([...results.map((r) => r.security_id), ...carry.carry.map((c) => c.securityId), ...episodes.map((e) => e.security_id)])];
  const secs = new Map((await fetchByIds<SecRow>(sb, "securities", "id, company_id, yahoo_symbol, exchange_code, currency, currency_major, financial_currency, avg_usd_volume_30d", "id", allIds)).map((s) => [s.id, s]));
  const companyIds = [...new Set([...secs.values()].map((s) => s.company_id))];
  const companyCountry = new Map((await fetchByIds<{ id: string; country: string | null }>(sb, "companies", "id, country", "id", companyIds)).map((c) => [c.id, c.country]));
  const siblings = await fetchByIds<{ id: string; company_id: string; exchange_code: string; avg_usd_volume_30d: number | null }>(sb, "securities", "id, company_id, exchange_code, avg_usd_volume_30d", "company_id", companyIds);
  const exchanges = await loadExchanges(sb);
  const overrides = new Map(
    (await selectAll<{ kind: string; yahoo_symbol: string }>(sb, "security_identity_overrides", "kind, yahoo_symbol", (q) => q.eq("active", true)))
      .filter((o) => o.kind === "force_us" || o.kind === "force_not_us")
      .map((o) => [o.yahoo_symbol, o.kind as "force_us" | "force_not_us"]),
  );

  // ---------------------------------------------------------------- rank both modes
  const usPrimary = (sec: SecRow): boolean => {
    const home = companyCountry.get(sec.company_id) ?? null;
    const own = sec.avg_usd_volume_30d ?? 0;
    const higher = home !== null && siblings.some((o) => o.company_id === sec.company_id && o.id !== sec.id && exchanges.get(o.exchange_code)?.country === home
      && exchanges.get(o.exchange_code)?.venue_class === "primary" && (o.avg_usd_volume_30d ?? -1) > own);
    return isUsPrimary({ canonicalExchange: sec.exchange_code, financialCurrency: sec.financial_currency, homeCountry: home, hasHigherVolumeHomeListing: higher, override: overrides.get(sec.yahoo_symbol) ?? null });
  };
  const candidateFor = (id: string, capUsd: number): RankCandidate | null => {
    const sec = secs.get(id);
    return sec === undefined ? null : { securityId: id, companyId: sec.company_id, yahooSymbol: sec.yahoo_symbol, marketCapUsd: capUsd, isUsPrimary: usPrimary(sec) };
  };
  const pool: RankCandidate[] = [];
  for (const m of members) {
    const c = candidateFor(m.security_id, m.market_cap_usd ?? 0);
    if (c !== null) pool.push(c);
  }
  for (const c of carry.carry) {
    const cap = resultOf.get(c.securityId)?.market_cap_usd ?? c.marketCapUsd;
    const cand = candidateFor(c.securityId, cap);
    if (cand !== null) pool.push(cand);
  }
  // carried rows are only carried in the modes they were previously ranked in
  const carriedModes = new Set(carry.carry.map((c) => `${c.mode}:${c.securityId}`));
  const rankedByMode = new Map<UniverseMode, RankedRow[]>();
  for (const mode of MODES) {
    const modePool = pool.filter((c) => !carriedIds.has(c.securityId) || carriedModes.has(`${mode}:${c.securityId}`));
    rankedByMode.set(mode, rankUniverse(modePool, mode));
  }
  const rankOf = (mode: UniverseMode, id: string): number | null => rankedByMode.get(mode)?.find((r) => r.securityId === id)?.rank ?? null;

  // ---------------------------------------------------------------- snapshots (idempotent: delete + insert)
  const prevLine = new Map(previous.map((r) => [`${r.mode}:${r.securityId}`, r.applicableLine]));
  const snapshotRows: Array<Record<string, unknown>> = [];
  const todayRows: SnapshotRow[] = [];
  for (const mode of MODES) {
    for (const r of rankedByMode.get(mode) ?? []) {
      const res = resultOf.get(r.securityId);
      const line = applicableDiscountLine(r.rank);
      const carried = carriedIds.has(r.securityId);
      const end = !carried && res?.channel ? lineEndOf(res.channel, line) : null;
      const closeV = res?.close ?? null;
      snapshotRows.push({
        scan_run_id: run.id, mode, security_id: r.securityId, company_id: r.companyId, rank: r.rank, market_cap_usd: r.marketCapUsd, is_top10: r.isTop10,
        state: carried ? "carried_forward" : "member", applicable_line: line, lower_line_end: end, close: closeV, session_date: res?.session_date ?? null,
        lower_line_positive: end === null ? null : end > 0, is_discount: end !== null && closeV !== null && closeV <= end,
      });
      todayRows.push({ mode, securityId: r.securityId, companyId: r.companyId, rank: r.rank, marketCapUsd: r.marketCapUsd, state: carried ? "carried_forward" : "member", applicableLine: line });
    }
  }
  await deleteWhereRun(sb, "universe_snapshots", run.id);
  await insertChunks(sb, "universe_snapshots", snapshotRows, 500);

  // ---------------------------------------------------------------- episodes
  const active = new Map<string, EpisodeRow>(episodes.map((e) => [`${e.mode}:${e.security_id}`, e]));
  let opened = 0;
  let closed = 0;
  let continued = 0;
  for (const mode of MODES) {
    const evalIds = new Set<string>([...(rankedByMode.get(mode) ?? []).filter((r) => !carriedIds.has(r.securityId)).map((r) => r.securityId), ...episodes.filter((e) => e.mode === mode).map((e) => e.security_id)]);
    for (const id of [...evalIds].sort()) {
      ctx.signal.throwIfAborted();
      const res = resultOf.get(id);
      const sec = secs.get(id);
      if (res === undefined || sec === undefined || res.session_date === null) continue;
      const evaluable = res.freshness === "fresh" && res.status === "processed" && !res.reason_codes.includes("suspect_data") && res.channel !== null;
      const observed = observationFor({
        today: { sessionDay: dayOfDate(res.session_date), close: res.close, evaluable, channelEnd: res.channel?.end ?? null, freshness: res.freshness ?? "unavailable", tier1Member: res.tier1_member, carriedForward: carriedIds.has(id) },
        rank: rankOf(mode, id),
        prevApplicableLine: prevLine.get(`${mode}:${id}`) ?? null,
        signalGrade: true,
      });
      if (observed === null) continue;
      const row = active.get(`${mode}:${id}`);
      const activeEpisode: ActiveEpisode | null = row === undefined ? null : {
        id: row.id, kind: "discount", mode, line: row.threshold_line,
        openedSessionDay: dayOfDate(row.opened_session_date), lastEvaluatedSessionDay: dayOfDate(row.last_evaluated_session_date),
      };
      const actions: EpisodeAction[] = stepDiscount(activeEpisode, observed.obs);
      for (const action of actions) {
        if (action.type === "close" && row !== undefined) {
          const { error } = await sb.from("signal_episodes").update({
            status: "closed", closed_scan_run_id: run.id, closed_session_date: res.session_date, close_reason: action.reason, last_evaluated_session_date: res.session_date,
          }).eq("id", row.id).eq("status", "active");
          if (error) throw new DbQueryError("signal_episodes.close", error.message);
          active.delete(`${mode}:${id}`);
          closed += 1;
          await ctx.log("episode_closed", { symbol: sec.yahoo_symbol, mode, reason: action.reason, line: row.threshold_line }, { securityId: id });
        } else if (action.type === "open") {
          const rank = rankOf(mode, id);
          const insert = {
            security_id: id, company_id: sec.company_id, kind: "discount", mode, threshold_line: action.line, opened_scan_run_id: run.id,
            opened_session_date: res.session_date, opened_close: res.close, opened_line_value: observed.obs.lineEnd, opened_rank: rank,
            open_reason: action.reason, continues_episode_id: action.continuesEpisodeId ?? null, notify: action.notify,
            last_evaluated_session_date: res.session_date, rank_history: [{ scan_run_id: run.id, session_date: res.session_date, rank, line: action.line }],
          };
          const { data, error } = await sb.from("signal_episodes").insert(insert).select("id, security_id, company_id, mode, threshold_line, opened_session_date, opened_scan_run_id, last_evaluated_session_date, rank_history").single();
          if (error) throw new DbQueryError("signal_episodes.open", error.message);
          active.set(`${mode}:${id}`, data as EpisodeRow);
          opened += 1;
          if (action.reason === "continuation") continued += 1;
          await ctx.log("episode_opened", { symbol: sec.yahoo_symbol, mode, line: action.line, reason: action.reason, notify: action.notify, rank }, { securityId: id });
        } else if (action.type === "noop" && row !== undefined && observed.obs.lineEnd !== null && res.session_date > row.last_evaluated_session_date) {
          const rank = rankOf(mode, id);
          const last = row.rank_history[row.rank_history.length - 1];
          const patch: Record<string, unknown> = { last_evaluated_session_date: res.session_date };
          if (last === undefined || last.rank !== rank) patch["rank_history"] = [...row.rank_history, { scan_run_id: run.id, session_date: res.session_date, rank, line: row.threshold_line }];
          const { error } = await sb.from("signal_episodes").update(patch).eq("id", row.id);
          if (error) throw new DbQueryError("signal_episodes.touch", error.message);
        }
      }
    }
  }

  // ---------------------------------------------------------------- today's discounts (technical part; research is pending until P2)
  const cards: Array<Record<string, unknown>> = [];
  for (const [key, ep] of active) {
    const [mode, id] = [key.slice(0, key.indexOf(":")) as UniverseMode, key.slice(key.indexOf(":") + 1)];
    const res = resultOf.get(id);
    const sec = secs.get(id);
    const rank = rankOf(mode, id);
    if (res === undefined || sec === undefined || res.channel === null || res.close === null || res.session_date === null || rank === null || carriedIds.has(id) || !res.tier1_member) continue;
    if (res.freshness !== "fresh" || res.reason_codes.includes("suspect_data")) continue;
    const lowerEnd = res.channel.end[lowerKey(ep.threshold_line) as "lower1" | "lower2"];
    const tier2 = evaluateTier2({ applicableLowerEnd: lowerEnd, close: res.close, freshness: res.freshness, signalGrade: true });
    const snap = snapOf.get(id);
    cards.push({
      scan_run_id: run.id, mode, security_id: id, company_id: ep.company_id, episode_id: ep.id, is_new_episode: ep.opened_scan_run_id === run.id, rank,
      market_cap_usd: res.market_cap_usd, market_cap_native: snap?.market_cap_native ?? null, market_cap_ccy: snap?.currency_major ?? sec.currency_major,
      close: res.close, currency: sec.currency, session_date: res.session_date, threshold_line: ep.threshold_line, lower_line_end: lowerEnd,
      channel: res.channel, trend_ok: res.channel.rising,
      eligibility: { tier1: { member: res.tier1_member, failed: res.reason_codes }, tier2: { valid: tier2.valid, failed: tier2.failed } },
      operational_category: "pending", category_reason: "research_pending", data_freshness: res.freshness, display_order: rank, withheld: true,
    });
  }
  await deleteWhereRun(sb, "todays_discounts", run.id);
  await insertChunks(sb, "todays_discounts", cards, 100);

  // ---------------------------------------------------------------- run-level facts
  const bySession = new Map<string, string>();
  for (const r of results) {
    const ex = secs.get(r.security_id)?.exchange_code;
    if (ex !== undefined && r.session_date !== null && (bySession.get(ex) ?? "") < r.session_date) bySession.set(ex, r.session_date);
  }
  const latest = [...bySession.values()].sort().at(-1) ?? null;
  const sizes = Object.fromEntries(MODES.map((m) => [m, { members: (rankedByMode.get(m) ?? []).filter((r) => !carriedIds.has(r.securityId)).length, carried_forward: (rankedByMode.get(m) ?? []).filter((r) => carriedIds.has(r.securityId)).length }]));
  const { error: runErr } = await sb.from("scan_runs").update({ universe_sizes: sizes, session_dates: Object.fromEntries(bySession), latest_session_date: latest }).eq("id", run.id);
  if (runErr) throw new DbQueryError("scan_runs.update", runErr.message);

  // ---------------------------------------------------------------- membership events (list-published snapshots only, 7.7)
  const candidates = await selectCandidates(sb, run.id, settings.universe.thresholdUsd);
  const statuses = candidates.map((c) => ({ status: (resultOf.get(c.securityId)?.status ?? "unprocessed") as ResultStatus }));
  const coverage = computeCoverage({
    exchangesTotal: 0, failedExchanges: [], rawRows: 0, companies: 0, candidates: statuses, carriedForward: carriedIds.size, prices: [],
    fx: { rateDate: null, scanDay: run.scanDay, rateDay: null, missing: [] }, research: { required: 0 }, minListCoverage: settings.pipeline.listPublishMinCoverage,
  });
  let events = 0;
  await deleteWhereRun(sb, "universe_membership_events", run.id);
  if (coverage.publish.list && historyRuns.length > 0) {
    const diff = membershipEvents({
      previous, today: todayRows,
      reasonFor: (event, id, expired) => membershipReason({ event, failedNow: resultOf.get(id)?.reason_codes ?? null, failedBefore: priorResults.get(id) ?? null, carryExpired: expired }),
    });
    await insertChunks(sb, "universe_membership_events", diff.map((e) => ({
      scan_run_id: run.id, event_date: run.scanDateLocal, mode: e.mode, company_id: e.companyId, security_id: e.securityId, event: e.event, from_rank: e.fromRank, to_rank: e.toRank, reason: e.reason,
    })), 300);
    events = diff.length;
  }
  return {
    members: members.length, carried: carry.carry.length, dropped: carry.dropped.length,
    ranked: Object.fromEntries(MODES.map((m) => [m, rankedByMode.get(m)?.length ?? 0])),
    episodes: { opened, closed, continued, active: active.size }, cards: cards.length, membershipEvents: events, listCoverage: coverage.publish.list_coverage,
  };
};
```

- [ ] **Step 19: Implement (16/22)**

**`supabase/functions/worker-tick/handlers/classify.ts`**

```ts
import { classifyOperational, type Category, type ResearchFacts } from "../../_shared/core/classify.ts";
import type { Handler, HandlerContext, Seeder } from "../types.ts";
import { DbQueryError, fetchByIds, selectAll } from "../lib/data.ts";

/** Stage 7 `classify` (initial): operational category, withheld flag and display order of today's cards (4.8, 6.6.4). */
export const seedClassify: Seeder = () => Promise.resolve({ keys: ["classify:initial"], priorities: [100] });

/** P1 has no research: every card is "pending". P2 replaces this function with the stored report of the security. */
export function researchFactsFor(_ctx: HandlerContext, _securityId: string): Promise<ResearchFacts | null> {
  return Promise.resolve(null);
}

const CLEARED: ReadonlySet<Category> = new Set(["green", "amber"]);
const ORDER: Record<Category, number> = { green: 0, amber: 1, red: 2, grey: 3, pending: 4 };

export const handleClassify: Handler = async (ctx: HandlerContext) => {
  const sb = ctx.db.sb;
  const rows = await selectAll<{ id: number; mode: string; rank: number; security_id: string }>(sb, "todays_discounts", "id, mode, rank, security_id", (q) => q.eq("scan_run_id", ctx.run.id));
  const symbols = new Map((await fetchByIds<{ id: string; yahoo_symbol: string }>(sb, "securities", "id, yahoo_symbol", "id", rows.map((r) => r.security_id))).map((s) => [s.id, s.yahoo_symbol]));

  const classified = [];
  for (const row of rows) {
    const c = classifyOperational(await researchFactsFor(ctx, row.security_id));
    classified.push({ ...row, symbol: symbols.get(row.security_id) ?? "", ...c });
  }
  // cleared candidates (green, then amber) first, then the withheld ones; within a category ascending rank, then symbol (4.11)
  const counts: Record<string, number> = {};
  for (const mode of ["worldwide", "us"]) {
    const ordered = classified
      .filter((r) => r.mode === mode)
      .sort((a, b) => ORDER[a.category] - ORDER[b.category] || a.rank - b.rank || (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0));
    for (const [i, r] of ordered.entries()) {
      const { error } = await sb
        .from("todays_discounts")
        .update({ operational_category: r.category, category_reason: r.reasonCode, withheld: !CLEARED.has(r.category), display_order: i + 1 })
        .eq("id", r.id);
      if (error) throw new DbQueryError("todays_discounts.update", error.message);
      counts[r.category] = (counts[r.category] ?? 0) + 1;
    }
  }
  return { cards: rows.length, ...counts };
};
```

- [ ] **Step 20: Implement (17/22)**

**`supabase/functions/worker-tick/handlers/publish.ts`**

```ts
import type { Handler, HandlerContext, Seeder } from "../types.ts";
import { exchangeOfSweepKey } from "../lib/batching.ts";
import { computeCoverage, type ResultStatus } from "../lib/coverage.ts";
import { DbQueryError, dayOfDate, fetchByIds, selectAll, selectCandidates } from "../lib/data.ts";

/**
 * Stage 8 `publish` (initial): builds the coverage object, makes sure every candidate has a result row (unprocessed securities are never
 * rendered as passing, 7.7) and sets results_published_at and, at >= 95% coverage, list_published_at.
 */
export const seedPublish: Seeder = () => Promise.resolve({ keys: ["publish:initial"], priorities: [100] });

export const handlePublish: Handler = async (ctx: HandlerContext) => {
  const sb = ctx.db.sb;
  const { run } = ctx;
  const candidates = await selectCandidates(sb, run.id, run.settings.universe.thresholdUsd);
  const results = await selectAll<{ security_id: string; status: ResultStatus }>(sb, "scan_security_results", "security_id, status", (q) => q.eq("scan_run_id", run.id));
  const statusOf = new Map(results.map((r) => [r.security_id, r.status]));

  const missing = candidates.filter((c) => !statusOf.has(c.securityId));
  if (missing.length > 0) {
    const { error } = await sb.from("scan_security_results").upsert(
      missing.map((c) => ({ scan_run_id: run.id, security_id: c.securityId, scope: "universe", status: "unprocessed", reason_codes: ["unprocessed"], tier1_member: false })),
      { onConflict: "scan_run_id,security_id", ignoreDuplicates: true },
    );
    if (error) throw new DbQueryError("scan_security_results.unprocessed", error.message);
    for (const c of missing) await ctx.log("security_skipped", { reason: "unprocessed", symbol: c.yahooSymbol }, { level: "warn", securityId: c.securityId });
  }

  const ids = candidates.map((c) => c.securityId);
  const prices = await fetchByIds<{ security_id: string; freshness: "fresh" | "stale" | "unavailable"; completeness: { suspect?: boolean } }>(sb, "price_series", "security_id, freshness, completeness", "security_id", ids);
  const priceOf = new Map(prices.map((p) => [p.security_id, p]));

  const sweepJobs = await selectAll<{ key: string; status: string; result: { rawRows?: number } | null }>(sb, "scan_jobs", "key, status, result", (q) => q.eq("scan_run_id", run.id).eq("stage", "universe_sweep"));
  const failedExchanges = sweepJobs.filter((j) => j.status === "dead").map((j) => exchangeOfSweepKey(j.key)).filter((c): c is string => c !== null);
  const rawRows = sweepJobs.reduce((sum, j) => sum + (j.status === "done" ? (j.result?.rawRows ?? 0) : 0), 0);
  const enabled = await selectAll<{ code: string }>(sb, "exchanges", "code", (q) => q.eq("screener_enabled", true));

  const snapshots = await selectAll<{ state: string }>(sb, "universe_snapshots", "state", (q) => q.eq("scan_run_id", run.id).eq("mode", "worldwide"));
  const cards = await selectAll<{ security_id: string }>(sb, "todays_discounts", "security_id", (q) => q.eq("scan_run_id", run.id));
  const fxJob = (await selectAll<{ result: { rate_date?: string | null; missing?: string[] } | null }>(sb, "scan_jobs", "result", (q) => q.eq("scan_run_id", run.id).eq("stage", "fx").eq("status", "done")))[0];
  const rateDate = fxJob?.result?.rate_date ?? null;

  const coverage = computeCoverage({
    exchangesTotal: enabled.length,
    failedExchanges,
    rawRows,
    companies: snapshots.filter((s) => s.state === "member").length,
    candidates: candidates.map((c) => ({ status: statusOf.get(c.securityId) ?? "unprocessed" })),
    carriedForward: snapshots.filter((s) => s.state === "carried_forward").length,
    prices: candidates.map((c) => ({ freshness: priceOf.get(c.securityId)?.freshness ?? "unavailable", suspect: priceOf.get(c.securityId)?.completeness.suspect === true })),
    fx: { rateDate, scanDay: run.scanDay, rateDay: rateDate === null ? null : dayOfDate(rateDate), missing: fxJob?.result?.missing ?? [] },
    research: { required: new Set(cards.map((c) => c.security_id)).size },
    minListCoverage: run.settings.pipeline.listPublishMinCoverage,
  });

  const now = new Date().toISOString();
  const { error } = await sb
    .from("scan_runs")
    .update({ coverage, results_published_at: now, list_published_at: coverage.publish.list ? now : null })
    .eq("id", run.id);
  if (error) throw new DbQueryError("scan_runs.update", error.message);
  if (coverage.fx.stale) await ctx.log("fx_stale", { rate_date: coverage.fx.rate_date }, { level: "warn" });
  await ctx.log("scan_published", { list: coverage.publish.list, list_coverage: coverage.publish.list_coverage, candidates: coverage.candidates });
  return { list: coverage.publish.list, list_coverage: coverage.publish.list_coverage, candidates: coverage.candidates.total, failed_exchanges: coverage.universe.failed_exchanges };
};
```

- [ ] **Step 21: Implement (18/22)**

**`supabase/functions/worker-tick/stages.ts`**

```ts
import type { JobStage } from "../_shared/adapters/log.ts";
import { handleClassify, seedClassify } from "./handlers/classify.ts";
import { handleCompute, seedCompute } from "./handlers/compute.ts";
import { handleFetchBars, seedFetchBars } from "./handlers/fetch_bars.ts";
import { handleFx, seedFx } from "./handlers/fx.ts";
import { handleIdentity, seedIdentity } from "./handlers/identity.ts";
import { handlePublish, seedPublish } from "./handlers/publish.ts";
import { handleRankSignals, seedRankSignals } from "./handlers/rank_signals.ts";
import { handleUniverseSweep, seedUniverseSweep } from "./handlers/universe_sweep.ts";
import type { Handler, Seeder } from "./types.ts";

/** Pipeline order of P1 (7.4 stages 1-7). Mirrors app.next_stage_to_seed; later phases insert research, news, digest, ... */
export const PIPELINE_ORDER: JobStage[] = ["fx", "universe_sweep", "identity", "fetch_bars", "compute", "rank_signals", "classify", "publish"];

export const HANDLERS: Partial<Record<JobStage, Handler>> = {
  fx: handleFx,
  universe_sweep: handleUniverseSweep,
  identity: handleIdentity,
  fetch_bars: handleFetchBars,
  compute: handleCompute,
  rank_signals: handleRankSignals,
  classify: handleClassify,
  publish: handlePublish,
};

export const SEEDERS: Partial<Record<JobStage, Seeder>> = {
  fx: seedFx,
  universe_sweep: seedUniverseSweep,
  identity: seedIdentity,
  fetch_bars: seedFetchBars,
  compute: seedCompute,
  rank_signals: seedRankSignals,
  classify: seedClassify,
  publish: seedPublish,
};
```

- [ ] **Step 22: Implement (19/22)**

**`supabase/functions/worker-tick/loop.ts`**

```ts
import type { Db, ScanJob } from "../_shared/adapters/db.ts";
import type { JobStage, ScanEventRow } from "../_shared/adapters/log.ts";
import { scanEvent } from "../_shared/adapters/log.ts";
import { SettingsError, type PipelineSettings } from "../_shared/adapters/settings.ts";
import { BudgetExceededError, YahooUnavailableError } from "../_shared/adapters/throttle.ts";
import { assertSignalGradeSettings } from "../_shared/core/indicator.ts";
import {
  DeferError, FatalJobError,
  type EventExtra, type Handler, type HandlerContext, type Providers, type RunInfo, type SeedContext, type Seeder,
} from "./types.ts";

/** The worker loop of spec 7.5, with its dependencies injected so it can be tested with an in-memory Db. */

export interface LoopDeps {
  db: Db;
  worker: string;
  now(): number; // wall clock, epoch ms
  t0: number; // invocation start, epoch ms
  settings: PipelineSettings;
  stages: readonly JobStage[]; // the stages this worker may claim
  handlers: Partial<Record<JobStage, Handler>>;
  seeders: Partial<Record<JobStage, Seeder>>;
  loadRun(id: string): Promise<RunInfo>;
  providersFor(run: RunInfo, onEvent: (event: string, data: Record<string, unknown>) => void): Providers;
  activeRunIds(): Promise<string[]>;
}

export interface LoopSummary {
  jobsRun: number;
  jobsDone: number;
  jobsFailed: number;
  jobsDeferred: number;
  seeded: string[];
  stoppedBecause: "idle" | "time";
}

export type JobOutcome =
  | { kind: "defer"; delaySeconds: number; reason: string }
  | { kind: "fatal"; message: string }
  | { kind: "fail"; message: string; retryInSeconds?: number };

/** How a thrown error is handled (7.9): defer without an attempt, fatal at once, or fail with backoff. */
export function classifyError(e: unknown, nowMs: number): JobOutcome {
  if (e instanceof DeferError) return { kind: "defer", delaySeconds: e.delaySeconds, reason: e.reason };
  if (e instanceof YahooUnavailableError) return { kind: "defer", delaySeconds: Math.max(30, Math.ceil((e.untilMs - nowMs) / 1000)), reason: "yahoo_breaker_open" };
  if (e instanceof BudgetExceededError) return { kind: "defer", delaySeconds: 10, reason: "yahoo_budget_exceeded" };
  if (e instanceof FatalJobError || e instanceof SettingsError) return { kind: "fatal", message: e.message };
  if (e instanceof Error && e.message === "settings_not_signal_grade") return { kind: "fatal", message: e.message };
  if (e instanceof DOMException && (e.name === "AbortError" || e.name === "TimeoutError")) return { kind: "fail", message: "job_timeout", retryInSeconds: 30 };
  const name = e instanceof Error ? e.name : "Error";
  const message = e instanceof Error ? e.message : String(e);
  return { kind: "fail", message: `${name}: ${message}`.slice(0, 300) };
}

export async function runLoop(deps: LoopDeps): Promise<LoopSummary> {
  const { db, settings } = deps;
  const summary: LoopSummary = { jobsRun: 0, jobsDone: 0, jobsFailed: 0, jobsDeferred: 0, seeded: [], stoppedBecause: "idle" };
  const runs = new Map<string, RunInfo>();
  const providers = new Map<string, Providers>();
  const pendingEvents: Array<{ event: string; data: Record<string, unknown> }> = [];
  const hardDeadline = deps.t0 + settings.hardDeadlineMs;
  const getRun = async (id: string): Promise<RunInfo> => {
    let run = runs.get(id);
    if (run === undefined) {
      run = await deps.loadRun(id);
      runs.set(id, run);
    }
    return run;
  };
  const getProviders = (run: RunInfo): Providers => {
    let p = providers.get(run.id);
    if (p === undefined) {
      p = deps.providersFor(run, (event, data) => pendingEvents.push({ event, data }));
      providers.set(run.id, p);
    }
    return p;
  };
  const flush = async (run: string, job: ScanJob | null): Promise<void> => {
    while (pendingEvents.length > 0) {
      const e = pendingEvents.shift() as { event: string; data: Record<string, unknown> };
      const level = e.event.endsWith("_open") || e.event === "yahoo_429" ? "warn" : "info";
      await scanEvent(db, { runId: run, jobId: job?.id ?? null, stage: job?.stage ?? null }, e.event, e.data, { level });
    }
  };

  const refreshActive = async (): Promise<void> => {
    for (const id of await deps.activeRunIds()) await db.refreshScanStatus(id);
  };

  const seedNext = async (): Promise<boolean> => {
    let any = false;
    for (const id of await deps.activeRunIds()) {
      const stage = await db.nextStageToSeed(id);
      if (stage === null) continue;
      const seeder = deps.seeders[stage];
      const run = await getRun(id);
      if (seeder === undefined) {
        await scanEvent(db, { runId: id, stage }, "job_dead", { reason: "no_seeder" }, { level: "error" });
        continue;
      }
      const ctx: SeedContext = {
        db, run, providers: getProviders(run),
        log: (event: string, data?: Record<string, unknown>, extra?: EventExtra) => scanEvent(db, { runId: id, stage }, event, data, extra),
      };
      let plan;
      try {
        plan = await seeder(ctx);
      } catch (e) {
        await scanEvent(db, { runId: id, stage }, "stage_seed_failed", { error: e instanceof Error ? `${e.name}: ${e.message}`.slice(0, 300) : "error" }, { level: "error" });
        continue;
      }
      const n = await db.seedStage({
        run: id, stage, keys: plan.keys,
        ...(plan.payloads === undefined ? {} : { payloads: plan.payloads }),
        ...(plan.priorities === undefined ? {} : { priorities: plan.priorities }),
      });
      summary.seeded.push(`${id}:${stage}:${n}`);
      await scanEvent(db, { runId: id, stage }, "stage_seeded", { stage, jobs: plan.keys.length, inserted: n });
      await flush(id, null);
      any = true;
    }
    return any;
  };

  const execute = async (job: ScanJob): Promise<void> => {
    summary.jobsRun += 1;
    const started = deps.now();
    const ctxLog = (event: string, data?: Record<string, unknown>, extra?: EventExtra) => scanEvent(db, { runId: job.scan_run_id, jobId: job.id, stage: job.stage }, event, data, extra);
    await ctxLog("job_started", { job: job.key, attempt: job.attempts });
    try {
      const run = await getRun(job.scan_run_id);
      assertSignalGradeSettings(run.settings.indicator); // fails the scan with settings_not_signal_grade (A-34)
      const handler = deps.handlers[job.stage];
      if (handler === undefined) throw new FatalJobError(`no_handler:${job.stage}`);
      const ctx: HandlerContext = {
        db, job, run, providers: getProviders(run),
        signal: AbortSignal.timeout(Math.max(1000, hardDeadline - started)),
        deadlineMs: hardDeadline,
        log: ctxLog,
      };
      const result = await handler(ctx);
      await db.completeJob(job.id, result);
      summary.jobsDone += 1;
      await ctxLog("job_done", { job: job.key, ms: deps.now() - started });
    } catch (e) {
      const outcome = classifyError(e, deps.now());
      if (outcome.kind === "defer") {
        summary.jobsDeferred += 1;
        await db.deferJob(job.id, outcome.delaySeconds, outcome.reason);
        await ctxLog("job_retry", { job: job.key, reason: outcome.reason, deferred_seconds: outcome.delaySeconds, attempt_consumed: false }, { level: "info" });
      } else {
        summary.jobsFailed += 1;
        const status = await db.failJob({ id: job.id, error: outcome.message, fatal: outcome.kind === "fatal", ...(outcome.kind === "fail" && outcome.retryInSeconds !== undefined ? { retryInSeconds: outcome.retryInSeconds } : {}) });
        await ctxLog(status === "dead" ? "job_dead" : "job_retry", { job: job.key, error: outcome.message, attempt: job.attempts }, { level: status === "dead" ? "error" : "warn" });
      }
    }
    await flush(job.scan_run_id, job);
  };

  await refreshActive(); // applies the soft and hard deadlines even when no job is runnable
  while (deps.now() - deps.t0 < settings.stopClaimingMs) {
    const jobs = await db.claimJobs({ worker: deps.worker, limit: settings.claimLimit, leaseSeconds: settings.leaseSeconds, stages: [...deps.stages], stageLimits: settings.stageCaps });
    if (jobs.length === 0) {
      if (await seedNext()) continue;
      summary.stoppedBecause = "idle";
      await refreshActive();
      return summary;
    }
    for (const job of jobs) await execute(job);
    for (const id of new Set(jobs.map((j) => j.scan_run_id))) await db.refreshScanStatus(id);
  }
  summary.stoppedBecause = "time";
  await refreshActive();
  return summary;
}

export type { ScanEventRow };
```

- [ ] **Step 23: Implement (20/22)**

**`supabase/functions/_shared/adapters/fixture-providers.ts`**

```ts
import type { RawBar } from "../core/bars.ts";
import type {
  ChartRequest, ChartResult, CompanyProfile, FxProvider, FxQuote, MarketDataProvider, QuoteRecord, ScreenerPage,
} from "./providers.ts";
import { mapQuote } from "./yahoo.ts";

/**
 * Offline providers for `tools/run-local-scan.ts --mode fixture` and the integration test. They answer from fixtures/integration/world.json,
 * a compact world built from the recorded Yahoo samples by tools/gen-integration-fixtures.ts. Refused unless the function environment
 * sets ALLOW_FIXTURE_PROVIDERS=1 (local only), so mock data can never be mistaken for production data (7.12).
 */

export interface WorldDonor {
  meta: {
    exchangeTimezoneName: string;
    regularMarketTime: string | null;
    currentTradingPeriod: { start: string; end: string } | null;
    firstTradeDate: string | null;
    instrumentType: string | null;
  };
  t: number[]; // session-open instants, epoch ms
  o: Array<number | null>;
  h: Array<number | null>;
  l: Array<number | null>;
  c: Array<number | null>;
  v: Array<number | null>;
}
export interface WorldSecurity {
  quote: Record<string, unknown>; // a recorded quote()/screener record
  profile: { country: string | null; sector: string | null; industry: string | null };
  bars: { donor: string; scale: number; overrides?: Record<string, [number, number, number, number]> };
}
export interface World {
  fxDate: string;
  fx: Record<string, number>; // USD per unit of the major currency
  donors: Record<string, WorldDonor>;
  securities: Record<string, WorldSecurity>;
  sets: Record<string, string[]>; // fixture sets ("day1", "day2") -> the symbols that exist in that world
}

export async function loadWorld(): Promise<World> {
  const text = await Deno.readTextFile(new URL("./fixtures/integration/world.json", import.meta.url));
  return JSON.parse(text) as World;
}

const msOf = (v: string | null): number | null => (v === null ? null : Date.parse(v));

export function createFixtureProviders(world: World, setName: string): { market: MarketDataProvider; fx: FxProvider } {
  const symbols = world.sets[setName];
  if (symbols === undefined) throw new Error(`unknown fixture set ${setName}`);
  const inSet = new Set(symbols);
  const quoteOf = (symbol: string): QuoteRecord | null => {
    const sec = world.securities[symbol];
    return sec === undefined || !inSet.has(symbol) ? null : mapQuote(sec.quote);
  };

  const market: MarketDataProvider = {
    id: "fixture",
    search: () => Promise.resolve({ hits: [], news: [] }),
    quote(requested) {
      return Promise.resolve([...new Set(requested)].map(quoteOf).filter((q): q is QuoteRecord => q !== null));
    },
    chart(symbol, _req: ChartRequest): Promise<ChartResult> {
      const sec = world.securities[symbol];
      const quote = quoteOf(symbol);
      if (sec === undefined || quote === null) return Promise.reject(new Error(`No data found, symbol may be delisted: ${symbol}`));
      const donor = world.donors[sec.bars.donor];
      if (donor === undefined) return Promise.reject(new Error(`fixture donor ${sec.bars.donor} missing`));
      const from = Date.parse(_req.period1);
      const bars: RawBar[] = [];
      donor.t.forEach((time, i) => {
        if (time < from) return;
        const override = sec.bars.overrides?.[String(time)];
        const scale = (v: number | null) => (v === null ? null : v * sec.bars.scale);
        bars.push({
          time,
          open: override ? override[0] : scale(donor.o[i] ?? null),
          high: override ? override[1] : scale(donor.h[i] ?? null),
          low: override ? override[2] : scale(donor.l[i] ?? null),
          close: override ? override[3] : scale(donor.c[i] ?? null),
          volume: donor.v[i] ?? null,
        });
      });
      const period = donor.meta.currentTradingPeriod;
      return Promise.resolve({
        meta: {
          currency: quote.currency,
          exchange: quote.exchange,
          exchangeTimezoneName: quote.exchangeTimezoneName ?? donor.meta.exchangeTimezoneName,
          firstTradeDateMs: quote.firstTradeDateMs,
          regularMarketTime: msOf(donor.meta.regularMarketTime),
          currentTradingPeriod: period === null ? null : { start: Date.parse(period.start), end: Date.parse(period.end) },
          instrumentType: donor.meta.instrumentType,
          longName: quote.longName,
        },
        bars,
        splits: [],
      });
    },
    profile(symbol): Promise<CompanyProfile> {
      const sec = world.securities[symbol];
      if (sec === undefined || !inSet.has(symbol)) return Promise.reject(new Error(`No fundamentals data for ${symbol}`));
      return Promise.resolve({ symbol, ...sec.profile, summary: null, employees: null });
    },
    news: () => Promise.resolve([]),
    screen(req): Promise<ScreenerPage> {
      const rows = symbols
        .map(quoteOf)
        .filter((q): q is QuoteRecord => q !== null && q.exchange === req.exchange && (q.marketCap ?? 0) > req.minMarketCapLocal)
        .sort((a, b) => (b.marketCap ?? 0) - (a.marketCap ?? 0) || (a.symbol < b.symbol ? -1 : 1));
      const page = rows.slice(req.offset, req.offset + req.size);
      return Promise.resolve({ total: rows.length, offset: req.offset, count: page.length, rows: page });
    },
  };

  const fx: FxProvider = {
    id: "fixture",
    usdPerUnit(ccys) {
      const rates: FxQuote[] = [];
      const missing: string[] = [];
      for (const ccy of [...new Set(ccys)].sort()) {
        const v = world.fx[ccy];
        if (v === undefined) missing.push(ccy);
        else rates.push({ ccy, usdPerUnit: v, rateDate: world.fxDate, source: "frankfurter", sourceSymbol: null });
      }
      return Promise.resolve({ rates, missing });
    },
  };
  return { market, fx };
}
```

- [ ] **Step 24: Implement (21/22)**

**`supabase/functions/worker-tick/providers.ts`**

```ts
import { systemClock } from "../_shared/adapters/clock.ts";
import { createQuoteCacheKv, type Db } from "../_shared/adapters/db.ts";
import { createFixtureProviders, loadWorld, type World } from "../_shared/adapters/fixture-providers.ts";
import { createFxProvider } from "../_shared/adapters/fx.ts";
import { createYahooProvider } from "../_shared/adapters/yahoo.ts";
import { FatalJobError, type Providers, type RunInfo } from "./types.ts";

/** Providers for one run. Fixture mode needs ALLOW_FIXTURE_PROVIDERS=1, which only the local function environment sets (7.12). */
export function createProviders(a: { run: RunInfo; db: Db; onEvent: (event: string, data: Record<string, unknown>) => void; world?: World }): Providers {
  if (a.run.providerMode === "fixture") {
    if (Deno.env.get("ALLOW_FIXTURE_PROVIDERS") !== "1") throw new FatalJobError("fixture_providers_not_allowed");
    if (a.world === undefined) throw new FatalJobError("fixture_world_not_loaded");
    return createFixtureProviders(a.world, a.run.fixtureSet ?? "day1");
  }
  const market = createYahooProvider({
    fetchImpl: fetch,
    store: createQuoteCacheKv(a.db.sb),
    clock: systemClock,
    rate: a.run.settings.pipeline.yahoo,
    onEvent: a.onEvent,
  });
  const fx = createFxProvider({ fetchImpl: fetch, clock: systemClock, quote: (symbols) => market.quote(symbols), onEvent: a.onEvent });
  return { market, fx };
}

export { loadWorld };
```

- [ ] **Step 25: Implement (22/22)**

**`supabase/functions/worker-tick/index.ts`**

```ts
import { createServiceDb, type Db } from "@adapters/db.ts";
import type { World } from "@adapters/fixture-providers.ts";
import { json, requireCronSecret } from "@adapters/http.ts";
import { mergeSettings } from "@adapters/settings.ts";
import { activeRunIds, loadRun } from "./lib/data.ts";
import { runLoop, type LoopSummary } from "./loop.ts";
import { createProviders, loadWorld } from "./providers.ts";
import { HANDLERS, PIPELINE_ORDER, SEEDERS } from "./stages.ts";

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined;

async function runWorker(worker: string, t0: number, db: Db): Promise<LoopSummary> {
  const rows = await db.sb.from("app_settings").select("key, value").in("key", ["pipeline"]);
  const { settings } = mergeSettings(rows.data ?? []);
  let world: World | undefined;
  return await runLoop({
    db,
    worker,
    now: () => Date.now(),
    t0,
    settings: settings.pipeline,
    stages: PIPELINE_ORDER,
    handlers: HANDLERS,
    seeders: SEEDERS,
    loadRun: async (id) => {
      const run = await loadRun(db.sb, id);
      if (run.providerMode === "fixture" && world === undefined && Deno.env.get("ALLOW_FIXTURE_PROVIDERS") === "1") world = await loadWorld();
      return run;
    },
    providersFor: (run, onEvent) => createProviders({ run, db, onEvent, ...(world === undefined ? {} : { world }) }),
    activeRunIds: () => activeRunIds(db.sb),
  });
}

/**
 * Worker invocation (7.5). Authenticated by the shared secret (verify_jwt = false, A-07). It answers 202 at once and keeps working through
 * EdgeRuntime.waitUntil, bounded by the 150 s wall clock: stop claiming at 85 s, hard deadline at 120 s, 180 s leases recover a killed worker.
 * `{"wait": true}` (local tools and tests) runs the loop before answering and returns its summary.
 */
Deno.serve(async (req) => {
  const denied = await requireCronSecret(req, Deno.env.get("CRON_SHARED_SECRET") ?? "");
  if (denied !== null) return denied;
  const body = req.method === "POST" ? ((await req.json().catch(() => ({}))) as { wait?: boolean }) : {};
  const t0 = Date.now();
  const worker = crypto.randomUUID();
  const work = runWorker(worker, t0, createServiceDb()).catch((e: unknown) => {
    console.error("worker-tick failed", e instanceof Error ? e.message : String(e));
    return null;
  });
  if (body.wait === true) return json({ worker, summary: await work });
  if (typeof EdgeRuntime !== "undefined") EdgeRuntime.waitUntil(work);
  return json({ worker }, { status: 202 });
});
```

- [ ] **Step 26: Type-check every function**

```bash
bun run functions:check
```

Expected: no errors (the P0 script checks `supabase/functions/**/*.ts` except the core Vitest files).

- [ ] **Step 27: Notes for the implementer (behaviour that is easy to get wrong)**

- **Never name an event field `key`** (the redaction pattern would replace its value): handlers and the loop log `job: job.key`.
- `fetch_bars` never writes a merged series on drift; it seeds `backfill:<security id>` with `{ securityIds: [id], mode: "backfill" }` at priority 90, and writes only the cheap columns when nothing changed (no rewrite of the TOASTed arrays).
- `rank_signals` deletes and re-inserts the run's `universe_snapshots`, `todays_discounts` and `universe_membership_events` (idempotent re-run); episodes are never deleted, the state machine guards re-runs through `last_evaluated_session_date`.
- `recheck:0` and `group:0` call `DeferError` while sibling jobs of their stage are open (they do not consume attempts).
- PostgREST caps reads at 1,000 rows: every list read goes through `fetchAll`/`selectAll`/`fetchByIds` (100 ids per request).
- All data timestamps derive from `scan_runs.started_at` (`run.startedAtMs`), not from the wall clock, so a recompute replays.

- [ ] **Step 28: Run the pure tests and the stack-free checks once more, then smoke the stack (first real run of the handlers)**

```bash
bun run functions:test
bunx supabase start
cp supabase/functions/.env.example supabase/functions/.env
bun run tools/build-yahoo-fixtures.ts "$RAW"   # already done in Task 9
```

The handlers are exercised end to end by Task 19; if the first fixture scan stops in a stage, read `bun run tools/run-local-scan.ts failures` (events carry the stage, the job and the error class) and fix the handler, not the test.

- [ ] **Step 29: Run; Expected: PASS** `deno test -A --config supabase/functions/deno.json supabase/functions/worker-tick/` (39 tests: 25 pure helper tests, 14 loop tests including stage seeding transitions with the in-memory fake Db, deferral without consuming an attempt, fatal and signal-grade failures, the 85 s claim stop).

- [ ] **Step 30: Commit**

```bash
git add supabase/functions/worker-tick/ supabase/functions/_shared/adapters/fixture-providers.ts supabase/config.toml supabase/functions/.env.example
git commit -m "feat(worker-tick): worker loop, stage seeding and handlers for stages 1-7"
```

---
### Task 18: scan-control, health and retention-cleanup

**Parallelism:** can run concurrently with Task 19 after Task 17.

**Files:**
- Modify: `supabase/functions/scan-control/index.ts`, `supabase/functions/health/index.ts`, `supabase/functions/retention-cleanup/index.ts` (P0 placeholders)
- Create: `supabase/functions/scan-control/validate.ts`, `actions.ts`, `supabase/functions/health/status.ts`
- Test: `supabase/functions/scan-control/validate.test.ts`, `supabase/functions/health/status.test.ts`

**Interfaces:**
- Consumes: P0 `health/handler.ts` (kept unchanged with its tests), `http.ts`; Task 11 `Db`; Task 14 functions
- Produces: `scan-control` actions `start, status, requeue, recompute, list_failures, set_setting, override` (shared secret or admin JWT verified with `getClaims`, every change audited); `health` now also returns `scan` (`public.scan_status()`) and `db.size_mb` with a 400 MB warning; `retention-cleanup` calling `app.purge_expired` and writing a `cleanup_result` event

- [ ] **Step 1: Write the failing tests**

**`supabase/functions/scan-control/validate.test.ts`**

```ts
import { assertEquals } from "@std/assert";
import { DEFAULT_SETTINGS } from "../_shared/core/indicator.ts";
import { parseRequest } from "./validate.ts";

const err = (body: unknown) => {
  const p = parseRequest(body);
  return p.ok ? null : p.error;
};
const RUN = "11111111-2222-3333-4444-555555555555";

Deno.test("rejects missing and unknown actions", () => {
  assertEquals(err(null), "action_required");
  assertEquals(err({}), "action_required");
  assertEquals(err({ action: "drop_database" }), "unknown_action");
});

Deno.test("start: live by default, fixture needs no real clock, now only in fixture mode", () => {
  assertEquals(parseRequest({ action: "start" }), { ok: true, action: "start", now: null, providerMode: "live", fixtureSet: null });
  assertEquals(parseRequest({ action: "start", provider_mode: "fixture", fixture_set: "day2", now: "2026-10-16T07:00:00Z" }), {
    ok: true, action: "start", now: "2026-10-16T07:00:00Z", providerMode: "fixture", fixtureSet: "day2",
  });
  assertEquals(err({ action: "start", now: "2026-10-16T07:00:00Z" }), "now_is_only_allowed_in_fixture_mode");
  assertEquals(err({ action: "start", provider_mode: "mock" }), "provider_mode_must_be_live_or_fixture");
  assertEquals(err({ action: "start", provider_mode: "fixture", now: "yesterday" }), "now_must_be_an_iso_timestamp");
  assertEquals(err({ action: "start", provider_mode: "fixture", fixture_set: "../etc" }), "fixture_set_invalid");
});

Deno.test("status, requeue, recompute and list_failures take a run id or a date; requeue and recompute require it", () => {
  assertEquals(parseRequest({ action: "status" }), { ok: true, action: "status", run: null });
  assertEquals(parseRequest({ action: "list_failures", run: "2026-10-15" }), { ok: true, action: "list_failures", run: "2026-10-15" });
  assertEquals(parseRequest({ action: "requeue", run: RUN }), { ok: true, action: "requeue", run: RUN });
  assertEquals(err({ action: "requeue" }), "run_required");
  assertEquals(err({ action: "recompute" }), "run_required");
  assertEquals(err({ action: "status", run: "latest; drop table scan_runs" }), "run_must_be_a_uuid_or_a_date");
});

Deno.test("set_setting: explicit confirmation, a reason and a valid, signal-grade value are mandatory", () => {
  const ok = { action: "set_setting", key: "indicator", value: { ...DEFAULT_SETTINGS, length: 2000 }, confirm: true, reason: "shorter window for a test" };
  assertEquals(parseRequest(ok).ok, true);
  assertEquals(err({ ...ok, confirm: undefined }), "confirm_true_required: settings never change silently");
  assertEquals(err({ ...ok, confirm: "yes" }), "confirm_true_required: settings never change silently");
  assertEquals(err({ ...ok, reason: "" }), "reason_required");
  assertEquals(err({ ...ok, key: "secrets" }), "key_must_be_indicator_universe_or_pipeline");
  assertEquals(err({ ...ok, value: { ...DEFAULT_SETTINGS, length: 2 } }), "invalid_indicator: length:length_out_of_range");
  assertEquals(err({ ...ok, value: { ...DEFAULT_SETTINGS, lower1Mag: 2 } })?.startsWith("settings_not_signal_grade"), true);
  assertEquals(err({ ...ok, value: { ...DEFAULT_SETTINGS, lower1Mode: "true" } })?.startsWith("invalid_indicator"), true);
});

Deno.test("set_setting for universe and pipeline validates the values through the settings merge", () => {
  assertEquals(parseRequest({ action: "set_setting", key: "universe", value: { threshold_usd: 60e9 }, confirm: true, reason: "raise the floor" }).ok, true);
  assertEquals(err({ action: "set_setting", key: "universe", value: { threshold_usd: "lots" }, confirm: true, reason: "raise the floor" })?.startsWith("invalid_value"), true);
  assertEquals(err({ action: "set_setting", key: "pipeline", value: { yahoo: { min_spacing_ms: 50 } }, confirm: true, reason: "go faster" })?.startsWith("invalid_value"), true);
  assertEquals(err({ action: "set_setting", key: "pipeline", value: [1], confirm: true, reason: "nope nope" }), "value_must_be_an_object");
});

Deno.test("override: kind, symbol and reason are required; merge_into_company needs a target company", () => {
  assertEquals(parseRequest({ action: "override", kind: "exclude", yahoo_symbol: "MSFT.AS", reason: "leveraged tracker ETP" }), {
    ok: true, action: "override", kind: "exclude", yahooSymbol: "MSFT.AS", reason: "leveraged tracker ETP", targetCompanyId: null, payload: {},
  });
  assertEquals(err({ action: "override", kind: "burn", yahoo_symbol: "X", reason: "because" }), "kind_invalid");
  assertEquals(err({ action: "override", kind: "exclude", yahoo_symbol: "", reason: "because" }), "yahoo_symbol_required");
  assertEquals(err({ action: "override", kind: "exclude", yahoo_symbol: "X", reason: "" }), "reason_required");
  assertEquals(err({ action: "override", kind: "merge_into_company", yahoo_symbol: "X", reason: "same company" }), "target_company_id_required");
  assertEquals(parseRequest({ action: "override", kind: "merge_into_company", yahoo_symbol: "X", reason: "same company", target_company_id: RUN }).ok, true);
});
```

**`supabase/functions/health/status.test.ts`**

```ts
import { assertEquals } from "@std/assert";
import { DB_SIZE_WARN_BYTES, shapeHealth } from "./status.ts";

Deno.test("shapeHealth reports the scan status and the size in MB", () => {
  const h = shapeHealth({ data: { last_attempted: null }, error: null }, { data: 50 * 1024 * 1024, error: null });
  assertEquals(h, { ok: true, scan: { last_attempted: null }, db: { size_bytes: 52428800, size_mb: 50, warn: false } });
});

Deno.test("the size alarm triggers above 400 MB", () => {
  assertEquals(shapeHealth({ data: null, error: null }, { data: DB_SIZE_WARN_BYTES + 1, error: null }).db.warn, true);
  assertEquals(shapeHealth({ data: null, error: null }, { data: DB_SIZE_WARN_BYTES, error: null }).db.warn, false);
});

Deno.test("an RPC error makes ok false and never throws", () => {
  const h = shapeHealth({ data: null, error: { message: "x" } }, { data: null, error: null });
  assertEquals([h.ok, h.db.size_bytes], [false, null]);
});
```

- [ ] **Step 2: Run it: `deno test -A --config supabase/functions/deno.json supabase/functions/scan-control supabase/functions/health`; Expected: FAIL (module not found ./validate.ts, ./status.ts)**

- [ ] **Step 3: Implement (1/6)**

**`supabase/functions/scan-control/validate.ts`**

```ts
import { validateSettings, assertSignalGradeSettings } from "../_shared/core/indicator.ts";
import { mergeSettings } from "../_shared/adapters/settings.ts";

/** Request validation of scan-control (pure). Every action is explicit; unknown actions and malformed arguments are rejected. */

export const ACTIONS = ["start", "status", "requeue", "recompute", "list_failures", "set_setting", "override"] as const;
export type Action = (typeof ACTIONS)[number];

export const SETTING_KEYS = ["indicator", "universe", "pipeline"] as const;
export const OVERRIDE_KINDS = ["force_canonical", "exclude", "force_us", "force_not_us", "merge_into_company", "predecessor_continuity"] as const;

export type Parsed =
  | { ok: true; action: "start"; now: string | null; providerMode: "live" | "fixture"; fixtureSet: string | null }
  | { ok: true; action: "status" | "requeue" | "recompute" | "list_failures"; run: string | null }
  | { ok: true; action: "set_setting"; key: (typeof SETTING_KEYS)[number]; value: unknown; reason: string }
  | { ok: true; action: "override"; kind: (typeof OVERRIDE_KINDS)[number]; yahooSymbol: string; reason: string; targetCompanyId: string | null; payload: Record<string, unknown> }
  | { ok: false; error: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isRec = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const fail = (error: string): Parsed => ({ ok: false, error });

export function parseRequest(body: unknown): Parsed {
  if (!isRec(body) || typeof body["action"] !== "string") return fail("action_required");
  const action = body["action"] as string;
  if (!(ACTIONS as readonly string[]).includes(action)) return fail("unknown_action");

  const run = body["run"] === undefined || body["run"] === null ? null : String(body["run"]);
  if (run !== null && !UUID.test(run) && !/^\d{4}-\d{2}-\d{2}$/.test(run)) return fail("run_must_be_a_uuid_or_a_date");

  switch (action as Action) {
    case "start": {
      const mode = body["provider_mode"] === "fixture" ? "fixture" : body["provider_mode"] === undefined || body["provider_mode"] === "live" ? "live" : null;
      if (mode === null) return fail("provider_mode_must_be_live_or_fixture");
      const now = body["now"] === undefined || body["now"] === null ? null : String(body["now"]);
      if (now !== null && !Number.isFinite(Date.parse(now))) return fail("now_must_be_an_iso_timestamp");
      if (now !== null && mode !== "fixture") return fail("now_is_only_allowed_in_fixture_mode");
      const set = body["fixture_set"] === undefined || body["fixture_set"] === null ? null : String(body["fixture_set"]);
      if (set !== null && !/^[a-z0-9_-]{1,32}$/.test(set)) return fail("fixture_set_invalid");
      return { ok: true, action: "start", now, providerMode: mode, fixtureSet: set };
    }
    case "status":
    case "requeue":
    case "recompute":
    case "list_failures":
      if ((action === "requeue" || action === "recompute") && run === null) return fail("run_required");
      return { ok: true, action: action as "status" | "requeue" | "recompute" | "list_failures", run };
    case "set_setting": {
      const key = body["key"];
      if (!(SETTING_KEYS as readonly unknown[]).includes(key)) return fail("key_must_be_indicator_universe_or_pipeline");
      if (body["confirm"] !== true) return fail("confirm_true_required: settings never change silently");
      const reason = typeof body["reason"] === "string" ? body["reason"].trim() : "";
      if (reason.length < 3) return fail("reason_required");
      const value = body["value"];
      if (key === "indicator") {
        const checked = validateSettings(value);
        if (!checked.ok) return fail(`invalid_indicator: ${checked.issues.map((i) => `${i.field}:${i.code}`).join(",")}`);
        try {
          assertSignalGradeSettings(checked.settings);
        } catch {
          return fail("settings_not_signal_grade: only length may differ from 3/4/1/2 with all modes true");
        }
        return { ok: true, action: "set_setting", key, value: checked.settings, reason };
      }
      if (!isRec(value)) return fail("value_must_be_an_object");
      const probe = mergeSettings([{ key: key as string, value }]);
      if (probe.warnings.length > 0) return fail(`invalid_value: ${probe.warnings.join("; ")}`);
      return { ok: true, action: "set_setting", key: key as "universe" | "pipeline", value, reason };
    }
    case "override": {
      const kind = body["kind"];
      if (!(OVERRIDE_KINDS as readonly unknown[]).includes(kind)) return fail("kind_invalid");
      const symbol = typeof body["yahoo_symbol"] === "string" ? body["yahoo_symbol"].trim() : "";
      if (symbol.length === 0 || symbol.length > 24) return fail("yahoo_symbol_required");
      const reason = typeof body["reason"] === "string" ? body["reason"].trim() : "";
      if (reason.length < 3) return fail("reason_required");
      const target = body["target_company_id"] === undefined || body["target_company_id"] === null ? null : String(body["target_company_id"]);
      if (kind === "merge_into_company" && (target === null || !UUID.test(target))) return fail("target_company_id_required");
      return { ok: true, action: "override", kind: kind as (typeof OVERRIDE_KINDS)[number], yahooSymbol: symbol, reason, targetCompanyId: target, payload: isRec(body["payload"]) ? body["payload"] : {} };
    }
  }
}
```

- [ ] **Step 4: Implement (2/6)**

**`supabase/functions/scan-control/actions.ts`**

```ts
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Db } from "../_shared/adapters/db.ts";
import { scanEvent } from "../_shared/adapters/log.ts";
import { scanDateLocal } from "../_shared/core/calendar.ts";
import type { Parsed } from "./validate.ts";

export interface Actor {
  via: "secret" | "jwt";
  userId: string | null;
}

export class ControlError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "ControlError";
  }
}

async function audit(sb: SupabaseClient, actor: Actor, action: string, targetType: string, targetId: string, details: Record<string, unknown>): Promise<void> {
  const { error } = await sb.from("audit_events").insert({ actor_id: actor.userId, action, target_type: targetType, target_id: targetId, details: { via: actor.via, ...details } });
  if (error) throw new ControlError(500, `audit_failed: ${error.message}`);
}

async function resolveRun(sb: SupabaseClient, run: string | null): Promise<{ id: string; scan_date_local: string; status: string } | null> {
  let q = sb.from("scan_runs").select("id, scan_date_local, status");
  if (run === null) q = q.order("scan_date_local", { ascending: false }).limit(1);
  else if (/^\d{4}-\d{2}-\d{2}$/.test(run)) q = q.eq("scan_date_local", run);
  else q = q.eq("id", run);
  const { data, error } = await q.maybeSingle();
  if (error) throw new ControlError(500, error.message);
  return data as { id: string; scan_date_local: string; status: string } | null;
}

export async function execute(p: Extract<Parsed, { ok: true }>, deps: { db: Db; actor: Actor; allowFixtures: boolean }): Promise<Record<string, unknown>> {
  const { db, actor } = deps;
  const sb = db.sb;

  switch (p.action) {
    case "start": {
      if (p.providerMode === "fixture" && !deps.allowFixtures) throw new ControlError(403, "fixture_mode_not_allowed_here");
      const now = p.now ?? new Date().toISOString();
      const extra: Record<string, unknown> = p.providerMode === "fixture" ? { provider_mode: "fixture", fixture_set: p.fixtureSet ?? "day1" } : {};
      const id = await db.startDailyScan({ now, force: true, trigger: "manual", snapshotExtra: extra });
      if (id !== null) {
        await audit(sb, actor, "manual_scan_start", "scan_run", id, { provider_mode: p.providerMode, now });
        return { created: true, run: id, scan_date_local: scanDateLocal(Date.parse(now)) };
      }
      const existing = await resolveRun(sb, scanDateLocal(Date.parse(now)));
      return { created: false, run: existing?.id ?? null, scan_date_local: scanDateLocal(Date.parse(now)), note: "a run already exists for this Sofia date; use requeue to retry its failed jobs" };
    }

    case "status": {
      const run = await resolveRun(sb, p.run);
      if (run === null) return { run: null };
      const { data: full } = await sb.from("scan_runs").select("id, scan_date_local, status, trigger, started_at, finished_at, coverage, universe_sizes, latest_session_date, results_published_at, list_published_at, settings_snapshot").eq("id", run.id).single();
      const { data: jobs } = await sb.from("scan_jobs").select("stage, status").eq("scan_run_id", run.id).limit(5000);
      const counts: Record<string, Record<string, number>> = {};
      for (const j of (jobs ?? []) as Array<{ stage: string; status: string }>) {
        const stage = (counts[j.stage] ??= {});
        stage[j.status] = (stage[j.status] ?? 0) + 1;
      }
      const snapshot = ((full as { settings_snapshot: Record<string, unknown> } | null)?.settings_snapshot ?? {}) as Record<string, unknown>;
      return { run: { ...(full as object), settings_snapshot: { provider_mode: snapshot["provider_mode"] ?? "live", fixture_set: snapshot["fixture_set"] ?? null } }, jobs: counts };
    }

    case "requeue": {
      const run = await resolveRun(sb, p.run);
      if (run === null) throw new ControlError(404, "run_not_found");
      const { data, error } = await sb
        .from("scan_jobs")
        .update({ status: "queued", attempts: 0, not_before: new Date().toISOString(), lease_until: null, leased_by: null, last_error: null, finished_at: null })
        .eq("scan_run_id", run.id)
        .in("status", ["dead", "failed"])
        .select("id");
      if (error) throw new ControlError(500, error.message);
      await db.refreshScanStatus(run.id);
      await audit(sb, actor, "requeue", "scan_run", run.id, { jobs: data?.length ?? 0 });
      return { run: run.id, requeued: data?.length ?? 0 };
    }

    case "recompute": {
      const run = await resolveRun(sb, p.run);
      if (run === null) throw new ControlError(404, "run_not_found");
      // dropping the jobs of the derived stages makes app.next_stage_to_seed seed compute, rank_signals, classify and publish again
      const { data, error } = await sb.from("scan_jobs").delete().eq("scan_run_id", run.id).in("stage", ["compute", "rank_signals", "classify", "publish"]).select("id");
      if (error) throw new ControlError(500, error.message);
      await sb.from("scan_runs").update({ finished_at: null }).eq("id", run.id);
      await db.refreshScanStatus(run.id);
      await audit(sb, actor, "recompute", "scan_run", run.id, { jobs_removed: data?.length ?? 0 });
      return { run: run.id, jobs_removed: data?.length ?? 0 };
    }

    case "list_failures": {
      const run = await resolveRun(sb, p.run);
      if (run === null) return { run: null, failures: [] };
      const { data: events } = await sb.from("scan_events").select("at, stage, level, event, security_id, message, data").eq("scan_run_id", run.id).in("level", ["warn", "error"]).order("at", { ascending: false }).limit(200);
      const { data: dead } = await sb.from("scan_jobs").select("stage, key, attempts, last_error, status").eq("scan_run_id", run.id).in("status", ["dead", "failed"]);
      return { run: run.id, dead_or_failed_jobs: dead ?? [], events: events ?? [] };
    }

    case "set_setting": {
      const { data: old } = await sb.from("app_settings").select("value").eq("key", p.key).maybeSingle();
      const { error } = await sb.from("app_settings").upsert({ key: p.key, value: p.value as Record<string, unknown>, updated_by: actor.userId, is_public: p.key !== "pipeline" }, { onConflict: "key" });
      if (error) throw new ControlError(500, error.message);
      await audit(sb, actor, "set_setting", "app_setting", p.key, { old: old?.value ?? null, new: p.value, reason: p.reason });
      return { key: p.key, updated: true };
    }

    case "override": {
      const { data, error } = await sb
        .from("security_identity_overrides")
        .insert({ kind: p.kind, yahoo_symbol: p.yahooSymbol, target_company_id: p.targetCompanyId, payload: p.payload, reason: p.reason, created_by: actor.userId })
        .select("id")
        .single();
      if (error) throw new ControlError(500, error.message);
      await audit(sb, actor, "override", "security_identity_override", (data as { id: string }).id, { kind: p.kind, yahoo_symbol: p.yahooSymbol, reason: p.reason });
      await scanEvent(db, { runId: null }, "identity_override_added", { kind: p.kind, symbol: p.yahooSymbol });
      return { id: (data as { id: string }).id };
    }
  }
}
```

- [ ] **Step 5: Implement (3/6)**

**`supabase/functions/scan-control/index.ts`**

```ts
import { createServiceDb } from "@adapters/db.ts";
import { corsHeaders, json, requireCronSecret } from "@adapters/http.ts";
import { ControlError, execute, type Actor } from "./actions.ts";
import { parseRequest } from "./validate.ts";

/**
 * Operator endpoint (7.12). Authenticated by the shared secret header (scripts, tools) or by the JWT of an admin user (interactive use,
 * verified in code with getClaims because verify_jwt = false, A-07). Every state change writes an audit_events row.
 */
async function authenticate(req: Request, db: ReturnType<typeof createServiceDb>): Promise<Actor | Response> {
  const secret = Deno.env.get("CRON_SHARED_SECRET") ?? "";
  if (req.headers.get("x-cron-secret") !== null && (await requireCronSecret(req, secret)) === null) return { via: "secret", userId: null };
  const header = req.headers.get("authorization") ?? "";
  const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
  if (token === "") return json({ error: "unauthorized" }, { status: 401 });
  const { data, error } = await db.sb.auth.getClaims(token);
  const sub = data?.claims?.sub;
  if (error || typeof sub !== "string") return json({ error: "unauthorized" }, { status: 401 });
  const { data: profile } = await db.sb.from("profiles").select("is_admin").eq("user_id", sub).maybeSingle();
  if (profile?.is_admin !== true) return json({ error: "forbidden" }, { status: 403 });
  return { via: "jwt", userId: sub };
}

Deno.serve(async (req) => {
  const cors = corsHeaders(req.headers.get("origin"));
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, { status: 405, headers: cors });
  const db = createServiceDb();
  const actor = await authenticate(req, db);
  if (actor instanceof Response) return actor;

  const parsed = parseRequest(await req.json().catch(() => null));
  if (!parsed.ok) return json({ error: parsed.error }, { status: 400, headers: cors });
  try {
    const result = await execute(parsed, { db, actor, allowFixtures: Deno.env.get("ALLOW_FIXTURE_PROVIDERS") === "1" });
    return json({ ok: true, ...result }, { headers: cors });
  } catch (e) {
    if (e instanceof ControlError) return json({ error: e.message }, { status: e.status, headers: cors });
    console.error("scan-control failed", e instanceof Error ? e.message : String(e));
    return json({ error: "internal_error" }, { status: 500, headers: cors });
  }
});
```

- [ ] **Step 6: Implement (4/6)** (`handler.ts` and its tests from P0 stay as they are)

**`supabase/functions/health/status.ts`**

```ts
import type { SupabaseClient } from "@supabase/supabase-js";

export const DB_SIZE_WARN_BYTES = 400 * 1024 * 1024; // alarm at 400 MB of the 500 MB Free limit (16.5)

export interface HealthDetail {
  ok: boolean;
  scan: unknown;
  db: { size_bytes: number | null; size_mb: number | null; warn: boolean };
}

/** Pure shaping of the two RPC results; `ok` is false when either could not be read. */
export function shapeHealth(status: { data: unknown; error: unknown }, size: { data: unknown; error: unknown }): HealthDetail {
  const bytes = typeof size.data === "number" ? size.data : null;
  return {
    ok: status.error === null && size.error === null,
    scan: status.data ?? null,
    db: { size_bytes: bytes, size_mb: bytes === null ? null : Math.round(bytes / 1024 / 1024), warn: bytes !== null && bytes > DB_SIZE_WARN_BYTES },
  };
}

/** public.scan_status() (what the site already shows) plus the database size; never a secret. */
export async function healthDetail(sb: SupabaseClient): Promise<HealthDetail> {
  const [status, size] = await Promise.all([sb.rpc("scan_status"), sb.schema("app").rpc("database_size")]);
  return shapeHealth(status, size);
}
```

- [ ] **Step 7: Implement (5/6)**

**`supabase/functions/health/index.ts`**

```ts
import { createServiceClient } from "@adapters/db.ts";
import { json } from "@adapters/http.ts";
import { handleHealth } from "./handler.ts";
import { healthDetail } from "./status.ts";

/** P0 liveness answer, extended in P1 with public.scan_status() and the database size. */
Deno.serve(async (req) => {
  const base = handleHealth(req);
  if (req.method !== "GET") return base;
  const detail = await healthDetail(createServiceClient());
  const body = (await base.json()) as Record<string, unknown>;
  return json({ ...body, ...detail, ok: body["ok"] === true && detail.ok }, { status: detail.ok ? 200 : 503, headers: base.headers });
});
```

- [ ] **Step 8: Implement (6/6)**

**`supabase/functions/retention-cleanup/index.ts`**

```ts
import { createServiceDb } from "@adapters/db.ts";
import { json, requireCronSecret } from "@adapters/http.ts";
import { scanEvent } from "@adapters/log.ts";

/**
 * Retention for the P1 tables (6.4): scan_events and terminal scan_jobs after 30 days, quote_cache after 1 day or expiry,
 * universe_membership_events after 90 days. Batched and idempotent (app.purge_expired); signal episodes, cards, scan runs and audit
 * events are never touched. Later phases extend app.purge_expired for their own tables.
 */
Deno.serve(async (req) => {
  const denied = await requireCronSecret(req, Deno.env.get("CRON_SHARED_SECRET") ?? "");
  if (denied !== null) return denied;
  const db = createServiceDb();
  const result = await db.purgeExpired();
  await scanEvent(db, { runId: null }, "cleanup_result", result);
  return json({ ok: true, deleted: result });
});
```

- [ ] **Step 9: Check against the local stack**

```bash
bun run functions:check
curl -s -X POST http://127.0.0.1:54321/functions/v1/scan-control -H 'content-type: application/json' -d '{"action":"status"}'
curl -s -X POST http://127.0.0.1:54321/functions/v1/scan-control -H 'content-type: application/json' -H 'x-cron-secret: local-dev-cron-secret' -d '{"action":"status"}'
curl -s http://127.0.0.1:54321/functions/v1/health
curl -s -X POST http://127.0.0.1:54321/functions/v1/retention-cleanup -H 'x-cron-secret: local-dev-cron-secret'
```

Expected: `{"error":"unauthorized"}` (401), `{"ok":true,"run":null}`, a health body with `"ok":true`, `"scan"` and `"db":{"size_mb":...}`, and `{"ok":true,"deleted":{...zeros...}}` (verified on the local stack while drafting).

- [ ] **Step 10: Run; Expected: PASS** `deno test -A --config supabase/functions/deno.json supabase/functions/scan-control supabase/functions/health` (6 + 3 + P0's 3 health tests).

- [ ] **Step 11: Commit**

```bash
git add supabase/functions/scan-control supabase/functions/health supabase/functions/retention-cleanup
git commit -m "feat(functions): scan-control, health detail and retention-cleanup"
```

---
### Task 19: tools: run-local-scan, fixture world and the integration test

**Parallelism:** can run concurrently with Task 18 after Task 17.

**Files:**
- Create: `tools/lib/local-stack.ts`, `tools/run-local-scan.ts`, `tools/gen-integration-fixtures.ts`, `tools/test-integration.ts`
- Create (generated, committed): `supabase/functions/_shared/adapters/fixtures/integration/world.json` (about 590 KB)
- Modify: `package.json` (scripts)

**Interfaces:**
- Consumes: Tasks 17-18; the spike samples `chart_AAPL, chart_NVDA, chart_SAP.DE, chart_0700.HK, quote_50, fx` (see Task 9 for `$RAW`)
- Produces: `bun run tools/run-local-scan.ts start|tick|status|failures [--mode live|fixture]`, `bun run test:integration`

- [ ] **Step 1: Add the scripts to `package.json`**

```json
"test:integration": "bun run tools/test-integration.ts",
"scan:local": "bun run tools/run-local-scan.ts",
"gen:fixtures:yahoo": "bun run tools/build-yahoo-fixtures.ts",
"gen:fixtures:world": "bun run tools/gen-integration-fixtures.ts"
```

- [ ] **Step 2: Generate the fixture world**

The world has four real 11-year series (AAPL, NVDA, SAP.DE, 0700.HK) as donors, 12 real or derived quote records (GOOG and MSF.DE are derived cross-listings) and real FX. `9988.HK` and `1299.HK` get an engineered last completed close (fixed-point iteration against the core indicator): 9988.HK below its -4 line, 1299.HK between its -4 and -3 lines. Day 2 adds `SHEL.L` (GBp, cap in GBP), which moves 1299.HK from rank 10 to 11.

```bash
bun run tools/gen-integration-fixtures.ts "$RAW"
```

Expected (verified): thirteen lines such as `9988.HK   bars 2899 rising true  close 28.695 lower1 54.716 lower2 28.985 suspect false` and `wrote world.json (588 KB)`. The tool throws if any security is not rising, is suspect, or has a non-positive lower line.

**`tools/gen-integration-fixtures.ts`**

```ts
// Builds supabase/functions/_shared/adapters/fixtures/integration/world.json for the fixture-mode scan (7.12, 17.4).
// Usage: bun run tools/gen-integration-fixtures.ts <spike raw dir>
//
// The world is built from recorded Yahoo samples: four real 11-year daily series (AAPL, NVDA, SAP.DE, 0700.HK) as "donors", twelve real quote
// records (plus derived cross-listings), real FX. Two securities get their last completed close engineered (fixed-point iteration against the
// core indicator) so the scan has a deterministic discount: 9988.HK closes below its -4 line, 1299.HK between its -4 and -3 lines.
// Day 2 adds SHEL.L (currency GBp, cap in GBP) above 1299.HK in cap, which moves 1299.HK from rank 10 to 11 and so re-thresholds it.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanBars, type ChartMeta, type RawBar } from "../supabase/functions/_shared/core/bars.ts";
import { computeChannel, DEFAULT_SETTINGS } from "../supabase/functions/_shared/core/indicator.ts";

const rawDir = process.argv[2];
if (rawDir === undefined) {
  console.error("usage: bun run tools/gen-integration-fixtures.ts <spike raw dir>");
  process.exit(1);
}
const NOW = Date.parse("2026-10-15T07:00:00Z"); // the scan start of fixture day 1 (10:00 Sofia in summer time)
const KEEP_BARS = 2900;
const read = (name: string): any => JSON.parse(readFileSync(join(rawDir, name), "utf8"));
const r4 = (v: number | null): number | null => (v === null ? null : Math.round(v * 1e4) / 1e4);

// ---------------------------------------------------------------- donors
const donors: Record<string, any> = {};
for (const name of ["AAPL", "NVDA", "SAP.DE", "0700.HK"]) {
  const c = read(`chart_${name}.json`);
  const q = c.quotes.slice(-KEEP_BARS);
  donors[name] = {
    meta: {
      exchangeTimezoneName: c.meta.exchangeTimezoneName,
      regularMarketTime: c.meta.regularMarketTime,
      currentTradingPeriod: c.meta.currentTradingPeriod?.regular ? { start: c.meta.currentTradingPeriod.regular.start, end: c.meta.currentTradingPeriod.regular.end } : null,
      firstTradeDate: c.meta.firstTradeDate ?? null,
      instrumentType: c.meta.instrumentType ?? null,
    },
    t: q.map((b: any) => Date.parse(b.date)),
    o: q.map((b: any) => r4(b.open)),
    h: q.map((b: any) => r4(b.high)),
    l: q.map((b: any) => r4(b.low)),
    c: q.map((b: any) => r4(b.close)),
    v: q.map((b: any) => b.volume),
  };
}

// ---------------------------------------------------------------- quotes
const KEEP = [
  "language", "region", "market", "symbol", "quoteType", "currency", "financialCurrency", "exchange", "fullExchangeName", "longName", "shortName",
  "marketCap", "sharesOutstanding", "regularMarketPrice", "regularMarketTime", "regularMarketPreviousClose", "regularMarketChangePercent",
  "marketState", "firstTradeDateMilliseconds", "exchangeTimezoneName", "priceHint", "averageDailyVolume3Month",
];
const quote50: any[] = read("quote_50.json");
const pick = (symbol: string): any => {
  const q = quote50.find((x) => x.symbol === symbol);
  if (q === undefined) throw new Error(`quote_50.json has no ${symbol}`);
  return Object.fromEntries(KEEP.filter((k) => k in q).map((k) => [k, q[k]]));
};
const fx = read("fx.json") as Record<string, number>;

const goog = { ...pick("GOOGL"), symbol: "GOOG", marketCap: 4203e9, averageDailyVolume3Month: 20_000_000 };
const msft = pick("MSFT");
const msfde = {
  ...msft, symbol: "MSF.DE", currency: "EUR", financialCurrency: "USD", exchange: "GER", fullExchangeName: "XETRA", exchangeTimezoneName: "Europe/Berlin",
  marketCap: Math.round((msft.marketCap / fx["EUR"]!) * 0.995), regularMarketPrice: Math.round((msft.regularMarketPrice / fx["EUR"]!) * 100) / 100,
  averageDailyVolume3Month: 15_000,
};

type Spec = { quote: any; country: string | null; sector: string | null; industry: string | null; donor: string; scale: number };
const specs: Record<string, Spec> = {
  "AAPL":    { quote: pick("AAPL"),    country: "United States", sector: "Technology", industry: "Consumer Electronics", donor: "AAPL", scale: 1 },
  "MSFT":    { quote: msft,            country: "United States", sector: "Technology", industry: "Software - Infrastructure", donor: "AAPL", scale: 1.55 },
  "NVDA":    { quote: pick("NVDA"),    country: "United States", sector: "Technology", industry: "Semiconductors", donor: "NVDA", scale: 1 },
  "GOOGL":   { quote: pick("GOOGL"),   country: "United States", sector: "Communication Services", industry: "Internet Content & Information", donor: "NVDA", scale: 1.7 },
  "GOOG":    { quote: goog,            country: "United States", sector: "Communication Services", industry: "Internet Content & Information", donor: "NVDA", scale: 1.68 },
  "JPM":     { quote: pick("JPM"),     country: "United States", sector: "Financial Services", industry: "Banks - Diversified", donor: "AAPL", scale: 0.9 },
  "LLY":     { quote: pick("LLY"),     country: "United States", sector: "Healthcare", industry: "Drug Manufacturers - General", donor: "NVDA", scale: 5 },
  "SAP.DE":  { quote: pick("SAP.DE"),  country: "Germany", sector: "Technology", industry: "Software - Application", donor: "SAP.DE", scale: 1 },
  "MSF.DE":  { quote: msfde,           country: "United States", sector: "Technology", industry: "Software - Infrastructure", donor: "AAPL", scale: 1.55 * 0.89 },
  "0700.HK": { quote: pick("0700.HK"), country: "China", sector: "Communication Services", industry: "Internet Content & Information", donor: "0700.HK", scale: 1 },
  "9988.HK": { quote: pick("9988.HK"), country: "China", sector: "Consumer Cyclical", industry: "Internet Retail", donor: "0700.HK", scale: 0.27 },
  "1299.HK": { quote: pick("1299.HK"), country: "Hong Kong", sector: "Financial Services", industry: "Insurance - Life", donor: "0700.HK", scale: 0.12 },
  "SHEL.L":  { quote: pick("SHEL.L"),  country: "United Kingdom", sector: "Energy", industry: "Oil & Gas Integrated", donor: "SAP.DE", scale: 22 },
};
const day1 = Object.keys(specs).filter((s) => s !== "SHEL.L");
const day2 = Object.keys(specs);

// ---------------------------------------------------------------- engineering the two discount candidates
function cleaned(symbol: string, overrides: Record<string, [number, number, number, number]>) {
  const s = specs[symbol]!;
  const d = donors[s.donor];
  const period = d.meta.currentTradingPeriod;
  const meta: ChartMeta = {
    exchangeTimezoneName: s.quote.exchangeTimezoneName ?? d.meta.exchangeTimezoneName,
    regularMarketTime: d.meta.regularMarketTime === null ? null : Date.parse(d.meta.regularMarketTime),
    currentTradingPeriod: period === null ? null : { start: Date.parse(period.start), end: Date.parse(period.end) },
    marketState: s.quote.marketState,
  };
  const raw: RawBar[] = d.t.map((time: number, i: number) => {
    const ov = overrides[String(time)];
    const sc = (v: number | null) => (v === null ? null : v * s.scale);
    return ov
      ? { time, open: ov[0], high: ov[1], low: ov[2], close: ov[3], volume: d.v[i] }
      : { time, open: sc(d.o[i]), high: sc(d.h[i]), low: sc(d.l[i]), close: sc(d.c[i]), volume: d.v[i] };
  });
  return { raw, ...cleanBars(raw, meta, NOW) };
}

const overridesBySymbol: Record<string, Record<string, [number, number, number, number]>> = {};
function engineer(symbol: string, target: (lower1: number, lower2: number) => number): void {
  const ov: Record<string, [number, number, number, number]> = {};
  const first = cleaned(symbol, ov);
  // the last COMPLETED bar is the one the handler will retain: find its raw timestamp
  const lastDay = first.series.dates[first.series.dates.length - 1]!;
  const lastRaw = [...first.raw].reverse().find((b: RawBar) => b.close !== null && b.high !== null && cleanBars([b], { exchangeTimezoneName: specs[symbol]!.quote.exchangeTimezoneName ?? donors[specs[symbol]!.donor].meta.exchangeTimezoneName, regularMarketTime: null, currentTradingPeriod: { start: b.time + 1, end: b.time + 2 } }, NOW).series.dates[0] === lastDay)!;
  let close = first.series.close[first.series.close.length - 1]!;
  for (let i = 0; i < 60; i++) {
    ov[String(lastRaw.time)] = [close * 0.995, close * 1.012, close * 0.985, close];
    const out = computeChannel(cleaned(symbol, ov).series, DEFAULT_SETTINGS);
    if (!out.ok) throw new Error(`${symbol}: ${out.reason}`);
    const next = target(out.channel.end.lower1, out.channel.end.lower2);
    if (Math.abs(next - close) < 1e-9 * Math.abs(close)) break;
    close = next;
  }
  overridesBySymbol[symbol] = ov;
}
engineer("9988.HK", (_l1, l2) => l2 * 0.99); // deep discount: below the -4 line, so it qualifies under either line
engineer("1299.HK", (l1, l2) => l2 + (l1 - l2) * 0.5); // between the lines: a -3 discount that stops qualifying when the rank crosses 11

// ---------------------------------------------------------------- report
const rows: string[] = [];
for (const [symbol, s] of Object.entries(specs)) {
  const c = cleaned(symbol, overridesBySymbol[symbol] ?? {});
  const out = computeChannel(c.series, DEFAULT_SETTINGS);
  if (!out.ok) throw new Error(`${symbol}: ${out.reason} (${c.series.dates.length} bars)`);
  const ch = out.channel;
  const close = c.series.close[c.series.close.length - 1]!;
  rows.push(`${symbol.padEnd(8)} bars ${String(c.series.dates.length).padStart(4)} rising ${String(ch.rising).padEnd(5)} close ${close.toFixed(3).padStart(10)} lower1 ${ch.end.lower1.toFixed(3).padStart(10)} lower2 ${ch.end.lower2.toFixed(3).padStart(10)} suspect ${c.report.suspect}`);
  if (!ch.rising) throw new Error(`${symbol} is not rising: choose another donor or scale`);
  if (c.report.suspect) throw new Error(`${symbol} is suspect`);
  if (!(ch.end.lower2 > 0)) throw new Error(`${symbol} lower line not positive`);
  void s;
}
console.log(rows.join("\n"));

// ---------------------------------------------------------------- write
const world = {
  fxDate: "2026-10-14",
  fx,
  donors,
  securities: Object.fromEntries(
    Object.entries(specs).map(([symbol, s]) => [
      symbol,
      {
        quote: s.quote,
        profile: { country: s.country, sector: s.sector, industry: s.industry },
        bars: { donor: s.donor, scale: s.scale, ...(overridesBySymbol[symbol] ? { overrides: overridesBySymbol[symbol] } : {}) },
      },
    ]),
  ),
  sets: { day1, day2 },
};
const outDir = join(import.meta.dir, "..", "supabase", "functions", "_shared", "adapters", "fixtures", "integration");
mkdirSync(outDir, { recursive: true });
const text = JSON.stringify(world);
writeFileSync(join(outDir, "world.json"), text);
console.log(`wrote world.json (${(text.length / 1024).toFixed(0)} KB)`);
```


- [ ] **Step 3: Implement (1/3)**

**`tools/lib/local-stack.ts`**

```ts
// Shared helpers for tools/run-local-scan.ts and tools/test-integration.ts: talk to the LOCAL stack with plain fetch.
import { spawnSync } from "node:child_process";

export interface Stack {
  url: string;
  serviceKey: string;
  cronSecret: string;
}

export function assertLocalUrl(url: string): void {
  const host = new URL(url).hostname;
  if (host !== "127.0.0.1" && host !== "localhost") throw new Error(`refusing fixture mode against a non-local URL: ${url}`);
}

/** URL and service key from the environment, else from `bunx supabase status -o json` (legacy JWT service key). */
export function resolveStack(): Stack {
  let url = process.env["SUPABASE_URL"];
  let serviceKey = process.env["SUPABASE_SERVICE_ROLE_KEY"];
  if (url === undefined || serviceKey === undefined) {
    const out = spawnSync("bunx", ["supabase", "status", "-o", "json"], { encoding: "utf8", shell: true });
    if (out.status !== 0) throw new Error(`supabase status failed: ${out.stderr}`);
    const status = JSON.parse(out.stdout) as { API_URL: string; SERVICE_ROLE_KEY: string };
    url ??= status.API_URL;
    serviceKey ??= status.SERVICE_ROLE_KEY;
  }
  return { url, serviceKey, cronSecret: process.env["CRON_SHARED_SECRET"] ?? "local-dev-cron-secret" };
}

export async function callFunction(stack: Stack, name: string, body: unknown, timeoutMs = 170_000): Promise<any> {
  const res = await fetch(`${stack.url}/functions/v1/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-cron-secret": stack.cronSecret },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  if (!res.ok && res.status !== 202) throw new Error(`${name} -> HTTP ${res.status}: ${text.slice(0, 300)}`);
  return json;
}

/** PostgREST read with the service key. `path` is e.g. "scan_runs?select=id&order=started_at.desc". */
export async function rest(stack: Stack, path: string): Promise<any[]> {
  const res = await fetch(`${stack.url}/rest/v1/${path}`, { headers: { apikey: stack.serviceKey, authorization: `Bearer ${stack.serviceKey}` } });
  if (!res.ok) throw new Error(`rest ${path} -> HTTP ${res.status}: ${await res.text()}`);
  return (await res.json()) as any[];
}

export async function rpc(stack: Stack, name: string, args: unknown, schema = "public"): Promise<any> {
  const res = await fetch(`${stack.url}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: { apikey: stack.serviceKey, authorization: `Bearer ${stack.serviceKey}`, "content-type": "application/json", "content-profile": schema, "accept-profile": schema },
    body: JSON.stringify(args),
  });
  if (!res.ok) throw new Error(`rpc ${name} -> HTTP ${res.status}: ${await res.text()}`);
  return await res.json();
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Terminal = complete or failed, or partial with finished_at set (all jobs terminal). */
export function isTerminal(run: { status: string; finished_at: string | null }): boolean {
  return run.status === "complete" || run.status === "failed" || (run.status === "partial" && run.finished_at !== null);
}
```

- [ ] **Step 4: Implement (2/3)**

**`tools/run-local-scan.ts`**

```ts
// Drives a scan against the local stack (spec 7.12).
//   bun run tools/run-local-scan.ts start    [--mode live|fixture] [--set day1] [--now 2026-10-15T07:00:00Z]
//   bun run tools/run-local-scan.ts tick     [--run <id|date>] [--max-minutes 60]
//   bun run tools/run-local-scan.ts status   [--run <id|date>]
//   bun run tools/run-local-scan.ts failures [--run <id|date>]
// Fixture mode reads recorded data and is refused unless SUPABASE_URL is 127.0.0.1 or localhost.
import { assertLocalUrl, callFunction, isTerminal, resolveStack, rest, sleep } from "./lib/local-stack.ts";

const [command, ...rest_] = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = rest_.indexOf(`--${name}`);
  return i >= 0 ? rest_[i + 1] : undefined;
};
const stack = resolveStack();

async function latestRun(run?: string): Promise<any> {
  const q = run === undefined ? "order=scan_date_local.desc&limit=1" : /^\d{4}-/.test(run) ? `scan_date_local=eq.${run}` : `id=eq.${run}`;
  return (await rest(stack, `scan_runs?select=id,scan_date_local,status,finished_at,coverage,universe_sizes&${q}`))[0];
}

switch (command) {
  case "start": {
    const mode = flag("mode") ?? "live";
    if (mode !== "live" && mode !== "fixture") throw new Error("--mode must be live or fixture");
    if (mode === "fixture") assertLocalUrl(stack.url);
    const body: Record<string, unknown> = { action: "start", provider_mode: mode };
    if (mode === "fixture") {
      body["fixture_set"] = flag("set") ?? "day1";
      body["now"] = flag("now") ?? "2026-10-15T07:00:00Z";
    }
    console.log(JSON.stringify(await callFunction(stack, "scan-control", body)));
    break;
  }
  case "tick": {
    const deadline = Date.now() + Number(flag("max-minutes") ?? "60") * 60_000;
    for (let n = 1; Date.now() < deadline; n++) {
      const res = await callFunction(stack, "worker-tick", { wait: true });
      const run = await latestRun(flag("run"));
      console.log(`tick ${n}: ${JSON.stringify(res.summary)} -> ${run?.status ?? "no run"}`);
      if (run !== undefined && isTerminal(run)) {
        console.log(JSON.stringify({ status: run.status, universe_sizes: run.universe_sizes, coverage: run.coverage }, null, 2));
        process.exit(run.status === "failed" ? 2 : 0);
      }
      if (res.summary?.stoppedBecause === "idle") await sleep(15_000); // deferred jobs wait for not_before (breaker, siblings)
    }
    console.error("tick: max duration reached before the run became terminal");
    process.exit(3);
    break;
  }
  case "status": {
    const run = await latestRun(flag("run"));
    console.log(JSON.stringify(await callFunction(stack, "scan-control", { action: "status", ...(run ? { run: run.id } : {}) }), null, 2));
    break;
  }
  case "failures": {
    const run = await latestRun(flag("run"));
    console.log(JSON.stringify(await callFunction(stack, "scan-control", { action: "list_failures", ...(run ? { run: run.id } : {}) }), null, 2));
    break;
  }
  default:
    console.error("usage: run-local-scan.ts start|tick|status|failures [--mode live|fixture] [--set day1|day2] [--now ISO] [--run id|date]");
    process.exit(1);
}
```

- [ ] **Step 5: Implement (3/3)**

**`tools/test-integration.ts`**

```ts
// Fixture-mode integration test of the whole pipeline against the LOCAL stack (spec 17.4). `bun run test:integration`.
// Prerequisites: `supabase start` (serves the functions), supabase/functions/.env with CRON_SHARED_SECRET and ALLOW_FIXTURE_PROVIDERS=1.
// It resets the database first (`--no-reset` skips that).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { assertLocalUrl, callFunction, isTerminal, resolveStack, rest, rpc, sleep } from "./lib/local-stack.ts";

const stack = resolveStack();
assertLocalUrl(stack.url);
if (!process.argv.includes("--no-reset")) {
  const r = spawnSync("bunx", ["supabase", "db", "reset"], { stdio: "inherit", shell: true });
  assert.equal(r.status, 0, "supabase db reset failed");
  await sleep(8_000); // the edge runtime restarts with the database
}

async function runScan(set: string, now: string): Promise<{ id: string; status: string; created: boolean }> {
  const start = await callFunction(stack, "scan-control", { action: "start", provider_mode: "fixture", fixture_set: set, now });
  assert.equal(start.ok, true, JSON.stringify(start));
  for (let i = 0; i < 40; i++) {
    await callFunction(stack, "worker-tick", { wait: true });
    const run = (await rest(stack, `scan_runs?select=id,status,finished_at&id=eq.${start.run}`))[0];
    if (isTerminal(run)) return { id: run.id, status: run.status, created: start.created };
    await sleep(2_000);
  }
  throw new Error("scan did not finish");
}
const count = async (table: string, filter = ""): Promise<number> => (await rest(stack, `${table}?select=id${filter}`)).length;

// ---------------------------------------------------------------- day 1: a full fixture scan
const day1 = await runScan("day1", "2026-10-15T07:00:00Z");
assert.equal(day1.status, "complete", "day 1 scan is complete");
assert.equal(await count("scan_runs"), 1, "exactly one scan_runs row");
const snaps = await rest(stack, `universe_snapshots?select=rank,mode,security_id&scan_run_id=eq.${day1.id}&mode=eq.worldwide&order=rank`);
assert.deepEqual(snaps.map((s) => s.rank), snaps.map((_, i) => i + 1), "ranks are 1..N and unique");
assert.equal(snaps.length, 10, "12 listings form 10 companies (GOOG and MSF.DE merge into their companies)");
const cards = await rest(stack, `v_todays_discounts?select=yahoo_symbol,threshold_line,operational_category,withheld&mode=eq.worldwide`);
assert.deepEqual(cards.map((c) => c.yahoo_symbol).sort(), ["1299.HK", "9988.HK"], "the two engineered securities are today's discounts");
assert.ok(cards.every((c) => c.operational_category === "pending" && c.withheld === true && c.threshold_line === "-3"), "pending, withheld, rank <= 10 uses the -3 line");
const canon = await rest(stack, `securities?select=yahoo_symbol,role&is_canonical=eq.true`);
assert.ok(!canon.some((c) => c.yahoo_symbol === "GOOG" || c.yahoo_symbol === "MSF.DE"), "share classes and cross-listings are not canonical");

// ---------------------------------------------------------------- idempotency: start + tick again creates nothing
const before = { runs: await count("scan_runs"), results: await count("scan_security_results"), snaps: await count("universe_snapshots"), episodes: await count("signal_episodes"), cards: await count("todays_discounts") };
const again = await callFunction(stack, "scan-control", { action: "start", provider_mode: "fixture", fixture_set: "day1", now: "2026-10-15T07:30:00Z" });
assert.equal(again.created, false, "a second start for the same Sofia date creates no run");
await callFunction(stack, "worker-tick", { wait: true });
const after = { runs: await count("scan_runs"), results: await count("scan_security_results"), snaps: await count("universe_snapshots"), episodes: await count("signal_episodes"), cards: await count("todays_discounts") };
assert.deepEqual(after, before, "row counts are unchanged after start + tick");

// ---------------------------------------------------------------- public reads
const page1 = await rpc(stack, "company_list", { p_mode: "worldwide" });
assert.ok(page1.length <= 15 && page1.length === 10, "company_list returns at most 15 rows");
const page2 = await rpc(stack, "company_list", { p_mode: "worldwide", p_limit: 25, p_after_rank: 5 });
assert.deepEqual(page2.map((r: any) => r.rank), [6, 7, 8, 9, 10], "keyset pagination is stable");
const summary1 = await rpc(stack, "universe_summary", { p_mode: "worldwide" });
assert.deepEqual(summary1.added_today, [], "the baseline run has no membership events");

// ---------------------------------------------------------------- day 2: SHEL.L joins, 1299.HK moves from rank 10 to 11
const day2 = await runScan("day2", "2026-10-16T07:00:00Z");
assert.equal(day2.status, "complete", "day 2 scan is complete");
const summary2 = await rpc(stack, "universe_summary", { p_mode: "worldwide" });
assert.equal(summary2.added_today.length, 1, "short summary detects the added company");
const shell = await rest(stack, `securities?select=currency,currency_major&yahoo_symbol=eq.SHEL.L`);
assert.deepEqual(shell[0], { currency: "GBp", currency_major: "GBP" }, "the minor-unit listing keeps GBp prices and GBP market cap");
const episodes = await rest(stack, `signal_episodes?select=status,threshold_line,close_reason,security_id&order=created_at`);
assert.ok(episodes.some((e) => e.status === "closed" && e.close_reason === "threshold_changed"), "1299.HK's -3 episode closed when its rank crossed 10/11");
assert.ok(episodes.some((e) => e.status === "active" && e.threshold_line === "-3"), "9988.HK's episode continues");
assert.equal(await count("scan_runs"), 2, "one run per local date");
console.log("integration test passed");
```

- [ ] **Step 6: Run the integration test**

Prerequisites: `bunx supabase start` (it serves the functions) and `supabase/functions/.env` (Task 17).

```bash
bun run test:integration
```

The test resets the database (`--no-reset` skips), runs a fixture scan for 2026-10-15 (`day1`) and asserts: one `scan_runs` row, status `complete`, ranks 1..10 unique (12 listings form 10 companies), `v_todays_discounts` lists exactly `1299.HK` and `9988.HK` (pending, withheld, `-3`), GOOG and MSF.DE are not canonical; a second `start` creates no run and a `tick` leaves every row count unchanged; `company_list` returns at most 15 rows and stable keyset pages; then a `day2` scan for 2026-10-16 adds SHEL.L (`GBp` currency, `GBP` major), `universe_summary` reports exactly one added company, and 1299.HK's episode closes with `threshold_changed`. Expected final line: `integration test passed`.

This is the first end-to-end execution of the handlers: budget time to debug them (read `bun run tools/run-local-scan.ts failures`).

- [ ] **Step 7: Run; Expected: PASS** `bun run test:integration` (`integration test passed`).

- [ ] **Step 8: Commit**

```bash
git add tools/lib/local-stack.ts tools/run-local-scan.ts tools/gen-integration-fixtures.ts tools/test-integration.ts supabase/functions/_shared/adapters/fixtures/integration/world.json package.json
git commit -m "test(integration): fixture-mode scan, idempotency and rank-change scenarios"
```

---
### Task 20: Live verification scan (P1 exit evidence)

**Files:**
- Create: `docs/discovery/first-live-scan.md`

**Interfaces:**
- Consumes: Tasks 12-19, a Docker stack, network access to Yahoo and Frankfurter, the Vault secrets below.
- Produces: recorded evidence (coverage JSON, universe sizes, top 15 per mode, discount candidates, failures, per-stage wall clock) and the verified numbers P1-01...P1-10 ask for.

- [ ] **Step 1: Start the stack and set the Vault secrets locally**

The minute tick (`app.kick_workers`) reads two Vault secrets, named as in the spec. They must be set once per local database (they are lost on `db reset`):

```sql
select vault.create_secret('http://host.docker.internal:54321', 'project_url');
select vault.create_secret('local-dev-cron-secret', 'worker_tick_secret');
```

Run it with `bunx supabase db query` or `docker exec supabase_db_<project> psql -U postgres`. **Verify which host reaches the functions from Postgres:** `host.docker.internal` works on Docker Desktop for Windows; if `select status_code, error_msg from net._http_response order by id desc limit 3` shows a connection error, try `http://172.17.0.1:54321` or the in-network `http://kong:8000` and record the working value in the findings file. The `worker_tick_secret` must equal `CRON_SHARED_SECRET` in `supabase/functions/.env`.

- [ ] **Step 2: Verify the cron-to-function path**

```sql
select app.start_daily_scan(now(), true, 'manual');   -- creates today's run and calls app.kick_workers()
select id, status, started_at, left(error_msg, 120) from net._http_response order by id desc limit 3;
```

Expected: a `net._http_response` row with `status_code 202` and `scan_jobs` progressing within a minute (the `tick-minute` job continues the work). Also call `worker-tick` without the header: expected HTTP 401.

- [ ] **Step 3: Verify the raw screener inside the Edge Runtime (P1-01)**

```bash
bun run tools/run-local-scan.ts tick --max-minutes 5
bun run tools/run-local-scan.ts failures
```

If `universe_sweep` jobs die with `yahoo_session_*` errors the cookie/crumb flow does not work in the Edge Runtime: switch to the contingency of spec 5.5 (sweep from a GitHub Actions job with Bun posting rows to `scan-control`) and record it; otherwise record "works in edge-runtime 1.77.4".

- [ ] **Step 3b: Reset and run the live scan**

```bash
bun run tools/run-local-scan.ts start --mode live
bun run tools/run-local-scan.ts tick --max-minutes 90
```

Expected: the run finishes in 20-40 minutes at the 3 requests per second ceiling and ends `complete` or `partial` with a coverage object. `run-local-scan.ts tick` prints each tick's summary and, at the end, `universe_sizes` and `coverage`.

- [ ] **Step 4: Record the findings in `docs/discovery/first-live-scan.md`**

Create the file with these sections, filled from the database (queries in the comments) and the tool output:

```markdown
# First live scan (P1 exit evidence)

Date, machine, commit, Supabase CLI and Deno versions.

## Result
Run status, started_at, finished_at, wall clock total.

## Coverage JSON
(select coverage from scan_runs order by started_at desc limit 1)

## Universe sizes
worldwide and us member counts, carried_forward counts, companies, raw rows, failed exchanges.

## Top 15 per mode
(select * from company_list('worldwide', 15) ; select * from company_list('us', 15))

## Discount candidates
(select * from v_todays_discounts) with the rank, line and close of each.

## Failures
Failed securities and reasons (bun run tools/run-local-scan.ts failures), dead jobs, schema-drift events.

## Wall clock per stage
(select stage, count(*), min(started_at), max(finished_at), sum(finished_at - started_at) from scan_jobs where scan_run_id = ... group by stage)

## Spot checks
Last close of three securities (for example AAPL, SAP.DE, 7203.T) against the spike samples or finance.yahoo.com; session dates.

## Idempotency
Result of start again (no new run: created false), then tick (row counts unchanged).

## Findings for the open questions
P1-01 (screener in the Edge Runtime), P1-02 (distinct exchange codes seen vs the seeds: select distinct exchange_code from securities), P1-03 (Frankfurter coverage: missing currencies in coverage.fx.missing), P1-04 (ZAc/ILA/KWF listings seen?), P1-05 (assetProfile.country values vs exchanges.country: select distinct country from companies), P1-06 (averageDailyVolume3Month present: yes in the samples), P1-08 (pg_total_relation_size of price_series, scan_security_results, market_cap_snapshots, scan_events after the run), P1-10 (per-class market caps of GOOGL/GOOG and BRK-A/BRK-B).
```

- [ ] **Step 5: Verify idempotency and replay**

```bash
bun run tools/run-local-scan.ts start --mode live     # expected: created false (no new run)
bun run tools/run-local-scan.ts tick --max-minutes 5  # expected: nothing runnable, no row count change
```

Then `recompute` (`POST scan-control {"action":"recompute","run":"<id>"}`) and confirm `universe_snapshots` ranks and `todays_discounts` are identical to before (the spec's exit criterion: recompute gives identical results).

- [ ] **Step 6: Commit**

```bash
git add docs/discovery/first-live-scan.md
git commit -m "docs(discovery): first live scan results and open-question findings"
```

---
### Task 21: Phase exit checklist

**Files:**
- Modify: `docs/superpowers/specs/2026-10-15-stock-screener-design.md` (append the P1 answers to the open-question table 19.2: Q-15, Q-16, Q-17 and the P1-xx findings)

**Interfaces:**
- Consumes: everything above.
- Produces: a green phase.

- [ ] **Step 1: Run every check**

```bash
bun run typecheck
bun run lint
bun run test:core
bun run test:tools
bun run functions:check
bun run functions:test
bun run check:functions-config
bun run test:db
bun run test:integration
```

Expected: all green. `test:core` runs the nine parity fixtures F1-F9 (268 core tests); `test:db` runs the DST replay, RLS and pipeline suites; `functions:test` runs 115+ Deno tests (the two opt-in tests stay ignored).

- [ ] **Step 2: Mechanical guards**

```bash
bun run tools/check-core-purity.ts
rg -n "Date\.now|Math\.random|\.localeCompare" supabase/functions/_shared/core --glob '!*.test.ts'
rg -n "yahoo-finance2\"|from \"yahoo-finance2" supabase/functions
```

Expected: purity check passes and the two `rg` searches print nothing (no environment time or randomness in core, no `localeCompare`, and `yahoo-finance2` only through `import("npm:yahoo-finance2@4.0.3")`).

- [ ] **Step 3: Confirm the exit criteria of spec section 18 (P1)**

- A live manual scan over the real universe completed with a coverage report (Task 20).
- Ranks and signals reproducible from stored data (`recompute` identical, Task 20 step 5).
- F1-F9 pass (Task 3); RLS and DST tests pass (Task 16).
- Measured CPU and wall numbers recorded: on the HOSTED project run one scan and record the wall time and CPU warnings of `fetch_bars` (12) and `compute` (25) jobs (P1-07), then freeze the batch sizes in `app_settings.pipeline` through `scan-control set_setting`.
- Database size projection below 60% of the limit (P1-08: `select pg_size_pretty(pg_total_relation_size('price_series'))` and friends, extrapolated to about 600 securities).

- [ ] **Step 4: Commit**

```bash
git add docs
git commit -m "docs(spec): record P1 findings in the open-question table"
```
