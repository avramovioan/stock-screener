# Hosted fixes after the first worldwide scans (2026-10-19)

Spec: the owner's rulings in this plan (section "Decisions") and `.superpowers/sdd/2026-10-16-us-default/requirements.md` for the
A-50/A-51 context. No separate spec file: the four defects were observed on the hosted project on 2026-10-19 and the owner approved
the recommendations as written here ("do your recommendations").

## Decisions (owner, 2026-10-19)

1. The identity `group:0` job must not die on `securities_one_canonical`; the primary-listing rule (A-50) must take effect.
2. A per-minute 429 from an LLM provider is a short wait, never a day-long quota deferral. Only a per-day limit is a quota.
3. A listing that Yahoo returns in the universe but serves no price bars for (three scans in a row) is `skipped`, not `failed`.
   Coverage treats skipped as evaluated, so such a listing no longer makes every run `partial`.
4. The Overview's top-right line shows the time of the last PUBLISHED list, not only of a fully `complete` run.
5. Coverage texts count only screenable securities: companies with a price history shorter than the channel are reported on a
   separate line, not in the "N of M processed" denominator. Screening itself does not change (they were never members).

## Global Constraints

- TDD for every behaviour change: write the failing test first, show RED, then GREEN, in the report.
- Touch only the files your task lists. No documentation edits (the lead updates docs). Do not edit
  `apps/web/src/lib/database.types.ts` (generated; the lead regenerates it).
- Migrations are forward-only and replay-safe (`create or replace`, `if not exists`), with a header comment in the style of
  `supabase/migrations/20261015008000_research_cadence.sql`, and sort after `20261015008500`.
- Commits: conventional subject `fix(<scope>): <what>`, body explains why, last line exactly
  `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. Stage only your own files with `git add <path>...`; never stage
  `docs/discovery/**`. Other agents commit in the same working tree concurrently: on an `index.lock` error wait 10 seconds and retry.
- Run focused tests while iterating; before committing run the suites your task names. Never run `supabase db reset`,
  `bun run test:db`, `bun run test:integration` or any e2e suite unless your task says so (the lead runs the full suites at the end).
- Commands: Deno tests `deno test -A --config supabase/functions/deno.json <file>`; core tests `bun run test:core`;
  web tests `bun run test:web`; tools tests `bun run test:tools`; lint `bun run lint` (biome ci .); typecheck `bun run typecheck`.
- Current hosted facts (for context, not to be hard-coded): 491 candidates, 396 members, 58 insufficient_data, 1 failed (ACALG.PA,
  no Yahoo profile and no bars), runs end `partial` because of that one failure.

### Task 1: identity canonical collision (backend)

**Defect.** On 2026-10-19 the hosted identity job `group:0` failed five times with
`apply_identity_groups: duplicate key value violates unique constraint "securities_one_canonical"` (unique index on
`securities (company_id) where is_canonical`, `supabase/migrations/20261015001000_core_schema.sql:110`). Saturday's and Sunday's runs
(worker before the A-50 primary-listing deploy) passed. The function `app.apply_identity_groups` (latest definition in
`supabase/migrations/20261015008400_primary_listing_rule.sql`) clears `is_canonical` only for the group's own `member_ids`, then sets
the group's `canonical_id`. Two ways to collide:

- (a) the target company still has a canonical security that is NOT a member of this group (it was grouped elsewhere or dropped
  from the listing set), and
- (b) two groups in the same run resolve to the same target company (`supabase/functions/worker-tick/handlers/identity.ts`, groupJob:
  `target = current?.company_id ?? companyIds[0]`), which happens when the grouper keeps two listings of one company apart (a
  `cap_mismatch` or `shares_only` review pair). Case (b) also lets a later group with `canonical_id = null` overwrite
  `companies.canonical_security_id` of a company that just received a canonical.

**Fix, SQL** (new migration `supabase/migrations/20261015008600_identity_canonical_clear.sql`, `create or replace` of
`app.apply_identity_groups(jsonb)` based on the 008400 definition):
- Inside the loop, when `v_canonical is not null`, before setting it: clear every other canonical of the target company:
  `update securities set is_canonical = false, role = case when role = 'canonical' then 'other' else role end
   where company_id = (g ->> 'company_id')::uuid and is_canonical and id <> v_canonical;` and add the row count to a new counter
  `canonical_displaced` returned in the result jsonb (alongside `groups`, `orphans_deleted`, `orphans_deactivated`).
- Keep everything else of the 008400 definition unchanged (exclusion_reason handling, orphan cleanup, grants). Check that `role` has
  no check constraint that rejects `'other'` (look at `20261015001000_core_schema.sql`).
- pgTAP: new `supabase/tests/0980_identity_canonical_clear.test.sql` in the style of `supabase/tests/0970_primary_listing.test.sql`.
  Scenario: company C with securities S_old (is_canonical true) and S_new (false); call `app.apply_identity_groups` with ONE group
  `{company_id: C, member_ids: [S_new], canonical_id: S_new, roles: {...}}` (S_old not a member). Assert: no exception, S_new is
  canonical with role `canonical`, S_old is not canonical with role `other`, `companies.canonical_security_id = S_new`, and the result's
  `canonical_displaced = 1`. A second test: the same call with S_old as a member behaves as before and `canonical_displaced = 0`.
  Run it with `bun run supabase:reset` then `bun run test:db` (you are the only task allowed to; if the reset fails on a migration you
  do not own, such as 20261015008700, wait a minute and retry).

**Fix, TypeScript** (`supabase/functions/worker-tick/handlers/identity.ts`, groupJob only):
- After all groups have their `target`, detect targets claimed by more than one group. The group that contains the company's current
  canonical (`current !== undefined`) keeps the company id; without one, the first group in iteration order keeps it. Every other group
  with that target gets a fresh company id (`crypto.randomUUID()`) as `company_id` in its payload (the SQL `insert into companies ...
  on conflict do nothing` creates the row). Log one `company_split` event (level `warn`, data: `{ company_id, kept: [symbols],
  split: [symbols] }`) per split group so the owner can see which listings were separated.
- After the RPC, when the returned `canonical_displaced > 0`, log a `canonical_displaced` event (level `warn`,
  data `{ count }`) and include the count in the job result.
- Deno test in `supabase/functions/worker-tick/handlers/identity.test.ts` (fake `sb` already stubs `apply_identity_groups`): two groups
  whose members share company C where only the first holds the current canonical -> the payload has two distinct `company_id`
  values, the first is C, the second is a valid UUID that is not C, and a `company_split` log entry exists. A second test: with no
  duplicate targets nothing changes and no `company_split` is logged.
- Run: the identity Deno test file, `bun run functions:check`, `bun run lint`, `bun run typecheck`.

**Done when** both tests are green, the pgTAP suite passes, functions:check/lint/typecheck pass, one commit per logical unit
(`fix(identity): ...`).

### Task 2: LLM 429 classifier (backend, single file)

**Defect.** `classifyHttpFailure` in `supabase/functions/_shared/adapters/llm/util.ts` maps a 429 to `"quota"` when the body matches
`/PerDay|per day|daily|insufficient_quota|billing/i`. Every Groq rate-limit message ends with "Need more tokens? Upgrade to Dev Tier
today at https://console.groq.com/settings/billing", and every Gemini 429 says "please check your plan and billing details", so a
per-minute limit is treated as a daily quota and the report is parked until the next UTC day (`research_steps.ts` `defer`). On
2026-10-19 both MCD reports were parked that way while Groq answered normally minutes later.

**Fix.** Quota only on per-day markers. Replace the regex with one that matches `PerDay`, `per day`, `per-day`, `daily`, `(TPD)`,
`(RPD)`, `insufficient_quota` (case-insensitive) and does NOT match `billing` or `exceeded your current quota`. Everything else that is
exhausted stays `rate_limited`. Update the doc comment on the function.

**Tests** (`supabase/functions/_shared/adapters/llm/util.test.ts`, extend the existing style with `kindOf`):
1. Groq TPM body -> `rate_limited`:
   `{"error":{"message":"Rate limit reached for model \`openai/gpt-oss-120b\` in organization \`org_x\` service tier \`on_demand\` on tokens per minute (TPM): Limit 8000, Used 7000, Requested 900. Please try again in 22.5s. Need more tokens? Upgrade to Dev Tier today at https://console.groq.com/settings/billing","type":"tokens","code":"rate_limit_exceeded"}}`
2. Groq TPD body (same shape, "on tokens per day (TPD): Limit 200000, Used 199500, Requested 900. Please try again in 1h2m3s. Need
   more tokens? Upgrade ... /settings/billing") -> `quota`.
3. Groq RPD body ("on requests per day (RPD): Limit 1000, Used 1000, Requested 1.") -> `quota`.
4. Gemini per-minute body -> `rate_limited`:
   `{"error":{"code":429,"message":"You exceeded your current quota, please check your plan and billing details.","status":"RESOURCE_EXHAUSTED","details":[{"@type":"type.googleapis.com/google.rpc.QuotaFailure","violations":[{"quotaMetric":"generativelanguage.googleapis.com/generate_content_free_tier_requests","quotaId":"GenerateRequestsPerMinutePerProjectPerModel-FreeTier"}]}]}}`
5. The same Gemini body with `quotaId` `GenerateRequestsPerDayPerProjectPerModel-FreeTier` -> `quota`.
6. OpenAI-style `{"error":{"message":"You exceeded your current quota","type":"insufficient_quota","code":"insufficient_quota"}}`
   -> `quota`.
Existing tests must keep passing (including "429 stays quota or rate_limited, even with an overload word").

**Run** the util test file, `bun run functions:check`, `bun run lint`. One commit `fix(research): a per-minute 429 is a rate limit, not
a daily quota`.

### Task 3: skip listings with no price data (backend)

**Defect.** `ACALG.PA` is returned by the universe sweep but Yahoo serves no profile and no chart bars. `fetch_bars` throws `no_bars`
every day, `compute` then writes `status = 'failed'` (reason `unprocessed`, `compute.ts` ~line 119, event `no_price_series`), and that
one failure makes every run `partial` (`app.refresh_scan_status`: gap = failed + unprocessed + stale + carried_forward). The existing
`securities.missing_scans` counter cannot be reused: `app.apply_quote_rows` (`20261015001200_pipeline_functions.sql` ~line 347)
resets it to 0 and status to `active` for every symbol the sweep returns, so fetch failures never accumulate.

**Fix.**
- Migration `supabase/migrations/20261015008700_no_bars_scans.sql`: `alter table public.securities add column if not exists
  no_bars_scans int not null default 0;` with a column comment: consecutive scans whose price fetch returned no bars; reset on a
  successful fetch; unlike `missing_scans` it is not touched by the universe sweep.
- `supabase/functions/worker-tick/handlers/fetch_bars.ts`: select `no_bars_scans`; on success reset it to 0 together with the existing
  `missing_scans` reset (one update when either is > 0); on failure increment it together with `missing_scans` (one update). Add
  `no_bars_scans` (the new value) to the `security_failed` event data.
- `supabase/functions/worker-tick/handlers/compute.ts`: select `no_bars_scans`; in the no-price-series branch, when
  `sec.no_bars_scans >= NO_DATA_SKIP_AFTER` (a named constant = 3, mirroring the sweep's 5.8 rule) write `status: "skipped"`,
  `reason_codes: ["no_price_data"]`, `tier1_member: false`, count it under `skipped`, and log `security_skipped` (level `info`,
  data `{ stage: "compute", reason: "no_price_data", no_bars_scans }`) instead of the `failed` row and the `no_price_series` warning.
  Below the threshold the existing `failed` path is unchanged.
- `supabase/functions/_shared/core/eligibility.ts`: add `"no_price_data"` to the `RuleCode` union and to the documented `order`
  list (after `unprocessed` or wherever the list keeps non-rule outcomes). Keep the core package pure (`bun run tools/check-core-purity.ts`
  runs inside `bun run typecheck`).
- Confirm with an existing or new test that `computeCoverage` (`supabase/functions/worker-tick/lib/coverage.ts`) counts `skipped` as
  evaluated for `list_coverage` and that the run status gap excludes it (the SQL gap formula does; no SQL change needed).

**Tests.** Deno tests next to the handlers (`fetch_bars.test.ts`, `compute.test.ts`; follow the existing fake-db patterns):
fetch success resets `no_bars_scans`; fetch failure increments it; compute with no series and streak 2 -> `failed`; streak 3 -> `skipped`
with `no_price_data`, `tier1_member` false, `security_skipped` logged, counts.skipped = 1. Core test for the `RuleCode` order if one
exists. Run the touched Deno test files, `bun run test:core`, `bun run functions:check`, `bun run lint`, `bun run typecheck`.
Do NOT run `supabase db reset` or `test:db` (Task 1 owns the local database during this change set).

**Done when** tests are green and the commit `fix(scan): skip a listing after three scans without price bars` is in place.

### Task 4: status line and coverage texts (web + tools)

**Defects.** (a) `apps/web/src/features/overview/scan-status-bar.tsx` prints "No completed scan yet" unless `last_successful`
(status `complete`) exists; hosted runs are all `partial`, so the line never shows a time although a list is published every day.
(b) `apps/web/src/components/status/status-banner.tsx` and `apps/web/src/features/overview/scan-banner.ts` print
"432 of 491 securities processed", counting the 58 `insufficient_data` candidates (price history shorter than the channel, never
members) in the denominator. (c) `tools/lib/alerts.ts` alerts when `processed / total < MIN_COVERAGE (0.9)`; 432/491 = 0.88 fires
every day for a healthy run.

**Fix.**
- (a) The line uses `latest_published.results_published_at` when present, else `last_successful.finished_at`:
  `Last scan <formatSofiaShort(at)> Sofia time`. Empty state text becomes `No scan published yet`. Update the component's doc comment
  and `scan-status-bar.test.tsx`; search `apps/web/src` and `apps/web/e2e` for the old text ("No completed scan yet") and update every
  expectation (`overview-page.test.tsx`, `status.test.tsx`, `apps/web/e2e/local/10-overview.local.spec.ts` as applicable). Do not run
  the e2e suites (the lead runs them); unit tests only.
- (b) `BannerProps` gains `insufficientData?: number`. `coverageText` prints `<processed> of <screenable> securities processed` where
  `screenable = total - (insufficientData ?? 0)`, followed, when `insufficientData > 0`, by ` <insufficientData> excluded for short price
  history.` (a plain sentence, no number formatting beyond the integer). Partial example: `Latest update incomplete: 432 of 433
  securities processed. 58 excluded for short price history. Results may be missing; nothing unprocessed is shown as passing.`
  `deriveScanBanner` passes `insufficientData: cand.insufficient_data` through (`ScanBanner` type gains the optional field; `Coverage`
  in `apps/web/src/features/screening/types.ts` already has `insufficient_data?: number`). `ScanBanner` component forwards it.
  Update `scan-banner.test.ts`, `status.test.tsx`, and any snapshot of the banner text.
- (c) `tools/lib/alerts.ts`: ratio = `(processed + skipped + insufficient_data) / total`, the server's `list_coverage` definition
  (`supabase/functions/worker-tick/lib/coverage.ts` line 66). Read `skipped` and `insufficient_data` with the same `pick` helper,
  default 0. Keep `MIN_COVERAGE`. Update the message to say `list coverage X% is below 90%` and the alerts test in `tools/`.
- No layout or styling change: texts only. Load the `frontend-design` skill before editing the components (project rule for agents
  touching visual components) and keep the existing classes.

**Tests.** `bun run test:web`, `bun run test:tools`, `bun run lint`, `bun run typecheck`. Commit(s) `fix(overview): ...` and
`fix(tools): ...`.

### Task 5: Flex "Financial Instrument Information" section is never recognised (backend, small)

**Defect.** The owner's IBKR Flex query selects every field of "Financial Instrument Information", yet the link check reports
`Financial Instrument Information: missing`. `supabase/functions/_shared/adapters/flex-parse.ts` maps that section to the container
element alias `financialinstrumentinformation` (`CONTAINERS.financialInstruments`, ~line 349). IBKR's Activity Flex XML emits this
section as `<SecuritiesInfo>` with one `<SecurityInfo .../>` row per instrument (the element names used by the ibflex and ib-flex
parsers); the hand-written fixture `supabase/functions/_shared/adapters/fixtures/flex/activity-sample.xml` (~line 32) uses the invented
`<FinancialInstrumentInformation>` name, so the tests pass against data IBKR never sends.

**Fix.**
- `CONTAINERS.financialInstruments` becomes `["securitiesinfo", "financialinstrumentinformation"]` (the real name first; keep the old
  alias so the existing fixture and any synthetic data still parse). Update the comment, if any, next to it.
- Fixture: rename the section in `activity-sample.xml` to `<SecuritiesInfo>` with `<SecurityInfo .../>` rows, keeping every attribute
  as it is (attribute names stay `conid`, `symbol`, `subCategory`, `listingExchange`, `isin`, `description`, `assetCategory`).
- Tests (`supabase/functions/_shared/adapters/flex-parse.test.ts` or the file that exercises the fixture): add one test that a
  statement whose section is named `SecuritiesInfo` reports `Financial Instrument Information` as present with no missing fields in
  `requiredSectionReport`, and one that positions get `listingExchange`/`subCategory` filled from a `SecurityInfo` row by `conid`.
  Existing tests must keep passing. TDD: write the tests first (RED with the old alias list), then change the alias (GREEN).

**Run** the flex-parse Deno test file, `bun run functions:check`, `bun run lint`. One commit
`fix(broker): recognise IBKR's SecuritiesInfo element as Financial Instrument Information`.
