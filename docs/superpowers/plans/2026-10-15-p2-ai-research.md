# P2 - Zero-Cost AI Research Pipeline and Classification: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Tests are written and seen failing before the code that makes them pass. Every task ends with a commit.

**Goal:** Turn a pending discount card (or a held security) into a cited, validated, two-stage AI research report using only free tiers (Gemini free tier as a text synthesizer, Tavily free search, SEC EDGAR, Jina Reader, direct fetch), classify it into Green / Amber / Red / Grey / pending with the already-implemented `classifyOperational`, run the daily material-change monitor for monitored holdings, and show the result on a research report page and on the Overview cards. Nothing in P2 may ever clear a candidate that was not actually researched.

**Architecture:** Deterministic code owns the evidence. A research report is a chain of 13 bounded `research` jobs (spec 9.10) inside the P1 `worker-tick`; each step writes its output (ledger rows in `research_sources`, transient texts in `research_work_texts`, `step` and `usage` on `research_reports`) before inserting the next step as a follow-up job, so a killed invocation repeats at most one step. The LLM only synthesizes text from the numbered evidence ledger and cites by `evidence_id`; our code renders URLs, runs every code check of spec 9.6.1, swaps `is_current` atomically in SQL, classifies, and writes the card. Pure logic (prompts, query templates, ranking, validation, delta detection) lives in `supabase/functions/_shared/core/` and is tested with Vitest; adapters (`llm/`, `search/`, `fetchers/`) take an injectable `fetchImpl` and are tested with Deno fixtures; step handlers receive a `ResearchDeps` bundle (store port, providers, clock) so Deno tests run the whole chain against an in-memory fake store with no network.

**Tech Stack:** Supabase (Postgres, pgTAP, Edge Functions on Deno), TypeScript 6.0.3 strict (`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`), Bun 1.3.14 root scripts, Vitest 5 (`core` and `web` projects), Deno 2.9.6 (`deno test`), `npm:fast-xml-parser@5.11.2`, `@supabase/supabase-js` 2.117.3 (import-map entry), React 19 + TanStack Router (code-based) / Query + `react-markdown@10.1.0` + `rehype-sanitize@6.0.0` (web), Gemini REST (`generateContent`, free tier), Tavily REST, Jina Reader, SEC EDGAR.

**Spec:** `docs/superpowers/specs/2026-10-15-stock-screener-design.md` sections 9 (all), 4.8, 6.3.5, 6.6.5, 6.9, 7.4 (stages 9-11), 7.9, 14.3, 17, 18 (P2), 19 (A-11, A-12, A-27, A-29); brief `prompt.txt` lines 546-683; research notes `docs/discovery/research/{free-ai-and-search-tiers,ai-research-providers,yahoo-finance2-spike}.md`.

**Conventions inherited from the P0 plan (`2026-10-15-p0-foundations.md`):** root scripts `test:core` (`vitest run --project core`), `test:web` (`vitest run --project web`), `test:db` (`supabase test db`), `functions:test` (`deno test -A --config supabase/functions/deno.json --ignore=supabase/functions/_shared/core supabase/functions`), `functions:check` (`deno check` with the same config), `typecheck`, `lint` (`biome ci .`), `lint:fix`; run one Deno test file with `deno test -A --config supabase/functions/deno.json <path>`; import-map prefixes `@core/`, `@adapters/`, `@supabase/supabase-js` for code inside functions; relative imports inside `_shared` always carry the `.ts` extension; core files import nothing but other core files by relative path and use no `Date.now()`, `new Date()` without arguments, `Math.random()`, `URL`, `console`, `fetch`, `setTimeout` (the purity guard rejects them; time and randomness are parameters); Biome style (double quotes, semicolons, trailing commas, width 100, no `any`, `import type`). Run `bun run lint:fix` before every commit.

---

## Global Constraints

These are exact values. A reviewer rejects a change that loosens any of them.

| Constraint | Value |
|---|---|
| Tavily queries per full report | **<= 6** (3 in `search:1`, 3 in `search:2`), `search_depth: "basic"`, `max_results: 5`, `include_answer: false`, 1 credit each |
| Documents fetched per full report | **<= 8**; EDGAR filings occupy **<= 3** of the 8 slots; at most 3 fetched per `fetch:n` step |
| Text per document | **~12k tokens = 48,000 characters** (`capText(text, 48000)`; `estimateTokens` = chars / 4) |
| Stage 1 (extraction) calls per report | **<= 8** (one per fetched document), at most 2 per `extract:n` step, `temperature` 0.1 |
| Stage 2 (synthesis) | **one call per attempt**, at most **one retry** (attempt 2) after a code-check failure |
| Stage 2 evidence budget | <= 12,000 tokens (48,000 characters) of evidence block |
| Change check | **<= 1 Tavily query + 1 small LLM call**, only when a delta exists; no delta means no search and no model call |
| Daily caps (`app_settings.research`, spec 9.8, seeded verbatim) | `{ "max_full_reports_per_day": 4, "tavily_daily_cap": 32, "tavily_monthly_budget": 950, "llm_daily_request_cap": 300, "max_change_checks_per_day": 40, "reuse_days": 30, "tavily_reserved_for_reports": 24 }` |
| Reuse window | **30 days** (`reuse_days`, A-12): a current **public** report <= 30 days old with no newer open finding is linked, not regenerated. Staleness is derived from `completed_at`; `status` is never flipped to `stale` on a current report (A-27) |
| Deferral | `quota_deferred` is **never cleared**: category `pending`, reason `research_quota_deferred`; `not_before` = next 00:00 UTC + 5 minutes; a missing provider key is a `quota_deferred` row with `error = 'provider_not_configured'` |
| Failure | `failed` after one retry on invalid output; category `grey`, reason `research_failed`; never a pass |
| Citations | only `evidence_id`s present in the ledger shown to the model; URLs typed by the model are stripped; a cited source must be `verification = 'ok'` (fetched 2xx this run) or pass a liveness GET in `validate` (**<= 4 GETs**, 8 s timeout) |
| Quote check | every Stage-1 fact carries a verbatim `quote` of **<= 300 characters** that occurs in the fetched text after whitespace normalisation; failing facts are dropped |
| Report length | `report_md` word count **350-1,100** (target 500-800); out of range after the retry is stored with a limitation |
| Consistency rule | `conclusion = "Meets these two fundamental checks."` requires `sufficient_evidence = true`, `material_damage_established = false`, `bankruptcy_risk` in `Low` or `Moderate`; still inconsistent after one retry is stored as returned with limitation `inconsistent_output` and `classifyOperational` maps it to Red/Grey, never Green |
| Independence | `conclusion` and `bankruptcy_risk` are stored independently and never derived from each other |
| SEC access | `SEC_USER_AGENT` is mandatory for every `sec.gov` request (no UA means no request); module-level token bucket **<= 4 req/s** (project ceiling 5, SEC maximum 10) |
| Privacy | only public identifiers and public text leave the system: company name, ticker, exchange name, reporting currency, research date, public URLs, public document text; never a user id, email, quantity, cost basis or portfolio fact; identical prompts for a candidate and a held security |
| Provenance | `provider`, `model`, `prompt_version`, `schema_version` persisted on every report; a report never switches provider mid-report |
| Wall clock | **<= 150 s** per invocation (platform); steps budgeted at <= 100 s; `ctx.deadline` is checked between documents and the step re-enqueues itself (`:<n>`) when short of time |
| Money | **no paid fallback, ever**: no billing enabled on any account, no paid provider configured, no OpenRouter `:online` plugin |
| Idempotency | report `idempotency_key = {security_id}:{trigger}:{scan_date_local}` (`UNIQUE`); at most one `is_current` per security (partial unique index); quota reserved at most once per report and flag (`usage.reserved`) |
| Tests | no network in any test; Deno tests use injected `fetchImpl` and fakes; Vitest for `_shared/core`; prompts asserted free of user ids and quantities |

## Review Focus

The five failure modes this phase must never exhibit. Each is pinned by named tests; a reviewer reads those tests first.

1. **A fabricated or unverified citation reaches a stored report.** Pinned by `core/research.test.ts` (`rejects unknown evidence ids`, `rejects [E9] in report_md`, `strips URLs typed by the model`, `renders sources only from the ledger`) and `worker-tick/handlers/research.test.ts` (`unknown evidence id -> retry -> failed`, `unverified cited source -> citation_verification_failed`, `validate performs at most 4 liveness GETs`).
2. **A candidate is treated as cleared when research could not run or was inconsistent.** Pinned by `handlers/research.test.ts` (`quota exhausted -> quota_deferred -> pending`, `not configured -> pending with provider_not_configured`, `inconsistent Meets never maps to green`), `handlers/classify_final.test.ts` (`pending, grey and red are withheld`) and `core/research.test.ts` (`consistency rule`).
3. **Quota or budget overrun, or non-atomic accounting.** Pinned by `supabase/tests/research_quota.sql` (`limit reached returns false and does not increment`), `handlers/research.test.ts` (`quota is consumed before every external call`, `plan re-run does not double-reserve`, `Tavily exhausted with >= 2 primary documents continues with limited_sources`, `no primary documents -> quota_deferred`, `never exceeds 6 queries, 8 documents, 8 Stage-1 calls`).
4. **Duplicate reports, two current reports, or a non-resumable step.** Pinned by `supabase/tests/research_constraints.sql` (`research_one_current`, `idempotency_key unique`, `promote swaps is_current atomically`), `handlers/research.test.ts` (`re-running plan creates one report`, `fetch re-run does not refetch ok documents`, `reuse links a current report and creates no row`, `holders-only report is not reused for a public candidate`) and the Task 8 scenario `re-run creates no duplicate reports`.
5. **Private data leaks to a provider, or the research prompt drifts from the brief.** Pinned by `handlers/research.test.ts` (`prompts contain no user ids or quantities`) and `core/research.test.ts` (`template equals prompt.txt lines 554-589`, `template equals the spec text`, `preamble and Stage 1 prompt equal the spec`, `schema equals the spec JSON`); adapter tests assert that error messages never contain keys.

## Contracts assumed from P1

The P1 plan (`docs/superpowers/plans/2026-10-15-p1-engine-pipeline.md`) was not present when this plan was written. If it exists and a name differs, change only the seam named in the last column, never the P2 logic. Task 5 step 1 and Task 8 step 1 re-check these.

| P1 artifact | Assumed shape | P2 seam |
|---|---|---|
| `_shared/core/classify.ts` | `classifyOperational(r: ResearchFacts \| null): { category: Category; reasonCode: string }` plus exported types `ResearchFacts`, `Category`, `ResearchStatus`, `Conclusion`, `BankruptcyRisk` (spec 4.8) | imported unchanged by `research_steps.ts`, `classify_final.ts` |
| `_shared/adapters/yahoo.ts` | `news(symbol)` returning `{ uuid, title, publisher?, link, providerPublishTime: Date \| string, relatedTickers?: string[] }[]` | `yahooNews` in `providers.ts` |
| `_shared/adapters/log.ts` | `scanEvent(db, { scan_run_id?, stage?, level, event, security_id?, message?, data? })` with redaction | `log` in `providers.ts` |
| `_shared/adapters/db.ts` | service-role client factory `serviceClient()` | `providers.ts` |
| `worker-tick` | handler type `(job: Job, ctx: { signal: AbortSignal; deadline: number }) => Promise<unknown>`; a `HANDLERS` record keyed by `job_stage`; a seeder registry used by `seedNextStage` | `handlers/p2_register.ts` exports `P2_HANDLERS`, `P2_SEEDERS`; one-line merge edits in the P1 registry files |
| `scan_jobs` | `id, scan_run_id, stage, key, status, priority (lower runs first), payload, not_before`, `UNIQUE (scan_run_id, stage, key)` (spec 6.3.3) | `store.enqueueJob` upserts with `ignoreDuplicates` |
| `scan-control` | action dispatch by name, admin-verified | `scan-control/actions/research_now.ts`; one-line registration |
| `companies`, `securities`, `exchanges` | spec 6.3.1: `companies.sec_cik, ir_rss_urls, news_symbol, sector, name`; `securities.yahoo_symbol, financial_currency`; `exchanges.name` | `store.loadSecurity` |
| `todays_discounts` | spec 6.3.4 columns, `operational_category` default `pending`; P2 adds `research_report_id` and `research_summary` (Task 1) | `store.applyReportToCards` |

Decisions to record (differences from the spec or the task brief, all intentional):

- `research_trigger` uses the spec value `new_discount` (the brief abbreviated it to `discount`); idempotency keys therefore read `{security_id}:new_discount:{date}`.
- `app.consume_quota` takes `p_limit int` (spec 6.6.5 has no limit parameter); callers read the limit from `app_settings.research`. A `public.*_rpc` wrapper (service role only) exists because PostgREST exposes `public` only.
- `research_work_texts` (new, transient, service role only) carries fetched document text between `fetch:n` and `extract:n` because the spec stores only an excerpt and a hash (9.5); rows are deleted when a report reaches `complete` or `failed`.
- `research_sources` gains `meta jsonb` (form, accession, query, date source) and a unique `(report_id, canonical_url)`.
- `risk_monitor_state` and `risk_findings` are per user (`user_id`) as in the brief; the daily check job is per security and fans findings out to every monitoring user, so the LLM is called once per security. `last_seen_items` has two keys: `seen` (acknowledged by the check) and `latest` (written by the `news` stage); the delta is `latest` minus `seen`.
- `app.holder(security_id)` (holder test used by RLS) is defined over `risk_monitor_state` in P2; P5 replaces it with a `broker_positions`-based body using `create or replace`.
- `LlmProvider` gains `readonly configured: boolean` so `plan` can choose a provider without spending a call.
- Gemini `responseSchema` accepts an OpenAPI subset; `toGeminiSchema` strips `additionalProperties` and `$schema`. The exact accepted subset is verified in P2-01 (spec 18) and the converter is the only place to change. `GEMINI_MODEL` is a required function secret (no model id is hard-coded, A-11).
- Material-change checks are scheduled by the stage 10 (`research`) seeder, after the stage 9 `news` jobs filled `last_seen_items.latest`; stage 8 `portfolio_scan:risk_set` only maintains `risk_monitor_state` rows.
- `manual` research is idempotent per Sofia day: a second `research_now` the same day returns the existing report unless the first one `failed`.
- The first job of a chain is keyed `research:<security_id>:<trigger>:plan` (the report row does not exist yet); every follow-up is keyed `research:<report_id>:<step>[:<n>]` (spec 9.10).

## File Map

```text
supabase/migrations/20261015002000_research_schema.sql                                (Task 1)
supabase/tests/research_quota.sql, research_constraints.sql, research_rls.sql          (Task 1)
supabase/functions/_shared/adapters/llm/{types,gemini,openai-compatible,index}.ts + tests   (Task 2)
supabase/functions/_shared/adapters/search/tavily.ts + test                            (Task 3)
supabase/functions/_shared/adapters/fetchers/{limiter,extract,direct,jina,edgar,rss}.ts + tests   (Task 3)
supabase/functions/_shared/core/research.ts + research.test.ts                         (Task 4)
supabase/functions/_shared/core/risk.ts + risk.test.ts                                 (Task 6)
supabase/functions/_shared/adapters/{research_types,research_store,providers}.ts                   (Task 5)
supabase/functions/_shared/adapters/monitor_store.ts                                   (Task 6)
supabase/functions/worker-tick/handlers/{research_steps,research,research_seed,news,classify_final,p2_register}.ts   (Task 5)
supabase/functions/worker-tick/handlers/risk_check.ts                                  (Task 6)
supabase/functions/worker-tick/handlers/testing/{fake_store,fakes}.ts + *.test.ts      (Tasks 5, 6)
supabase/functions/scan-control/actions/research_now.ts + test                         (Task 5)
apps/web/src/features/research/*, apps/web/src/router.tsx (route)                      (Task 7)
supabase/functions/_shared/adapters/fixtures/**, tools/self-test/research.ts           (Task 8)
docs/operator-guide.md (sections 1, 2 additions, 9)                                    (Task 9)
```

## Concurrency Map

Tasks inside a wave touch disjoint files and may run in parallel. A wave starts when the previous wave is merged.

| Wave | Tasks (parallel) | Why safe |
|---|---|---|
| A | **1** (SQL), **2** (LLM adapters), **3** (retrieval adapters), **4** (core research), **7** (web), **9** (operator guide) | disjoint directories. Task 7 needs only the column names fixed in Task 1 and defines its own small pure helpers, so it does not import Task 4 |
| B | **5** (store, handlers, seeds, news, classify_final, research_now) | needs 1-4 merged |
| C | **6** (risk core, monitor store and handler) | edits `p2_register.ts` and `providers.ts` created by 5 |
| D | **8** (fixtures and integration scenario) | needs 1-7 merged; edits `providers.ts` and root `package.json` |
| E | **10** (exit checklist) | verification only |

Tasks 1-4 and 7 and 9 may also run in the order listed on one machine; no task of wave A reads a file another task of wave A writes.

---

### Task 1: Migration `20261015002000_research_schema.sql` and pgTAP suites

**Files:**
- Create: `supabase/migrations/20261015002000_research_schema.sql`
- Create: `supabase/tests/research_quota.sql`, `supabase/tests/research_constraints.sql`, `supabase/tests/research_rls.sql`

**Interfaces:**
- Consumes: P1 tables `securities`, `companies`, `scan_runs`, `todays_discounts`, `app_settings`, enums `bankruptcy_risk` and `operational_category` (guarded re-creation keeps a replay safe), schema `app`, extension `pgtap` (P0).
- Produces: enums `research_status`, `research_kind`, `research_trigger`, `report_visibility`; tables `research_reports`, `research_sources`, `research_work_texts`, `ai_quota_usage`, `risk_monitor_state`, `risk_findings`; columns `todays_discounts.research_report_id` and `research_summary`; functions `app.consume_quota(text, text, int, text, int)`, `app.promote_research_report(uuid)`, `app.holder(uuid)` and service-role wrappers `public.consume_quota_rpc(...)`, `public.promote_research_report_rpc(uuid)`; view `public.v_card_research`; `app_settings` row `research`.

- [ ] **Step 1: Preflight, confirm P1 did not already create these objects**

Run: `git grep -l "research_reports" -- supabase/migrations`
Expected: no output (or only this task's file after step 4). If another migration already creates `research_reports`, `research_sources`, `ai_quota_usage`, `risk_monitor_state` or `risk_findings`, stop: reconcile column names with that migration first (the guarded `create ... if not exists` below would silently skip a table whose columns differ).

- [ ] **Step 2: Write the pgTAP quota suite `supabase/tests/research_quota.sql`**

```sql
begin;
select plan(9);

select is(app.consume_quota('t', 'r', 1, 'day', 2), true, 'first consume is allowed');
select is(app.consume_quota('t', 'r', 1, 'day', 2), true, 'second consume reaches the limit');
select is(app.consume_quota('t', 'r', 1, 'day', 2), false, 'limit reached returns false');
select is(
  (select used from public.ai_quota_usage where provider = 't' and resource = 'r' and period_kind = 'day'),
  2,
  'a denied call does not increment the counter'
);
select is(app.consume_quota('t', 'big', 3, 'day', 2), false, 'an amount larger than the limit is denied');
select is(
  (select used from public.ai_quota_usage where provider = 't' and resource = 'big'),
  0,
  'a denied first call leaves used at 0'
);
select is(app.consume_quota('t', 'm', 5, 'month', 10), true, 'month counters work');
select is(
  (select period_start from public.ai_quota_usage where provider = 't' and resource = 'm'),
  date_trunc('month', now() at time zone 'utc')::date,
  'a month counter starts on the first day of the UTC month'
);
select throws_ok(
  $$select app.consume_quota('t', 'x', 1, 'week', 5)$$,
  'P0001',
  null,
  'an unknown period kind is rejected'
);

select * from finish();
rollback;
```

- [ ] **Step 3: Write the constraint suite `supabase/tests/research_constraints.sql`**

```sql
begin;
select plan(13);
set local session_replication_role = replica;   -- fixture rows skip FKs to securities/companies/scan_runs

insert into public.research_reports (id, security_id, company_id, trigger, status, idempotency_key, is_current)
values ('00000000-0000-0000-0000-0000000000b1', '10000000-0000-0000-0000-000000000001',
        '20000000-0000-0000-0000-000000000001', 'new_discount', 'complete',
        '10000000-0000-0000-0000-000000000001:new_discount:2026-10-15', true);

select throws_ok(
  $$insert into public.research_reports (security_id, company_id, trigger, idempotency_key, is_current)
    values ('10000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', 'refresh', 'k-second-current', true)$$,
  '23505', null, 'research_one_current: a second current report for one security is rejected');

select lives_ok(
  $$insert into public.research_reports (id, security_id, company_id, trigger, status, idempotency_key)
    values ('00000000-0000-0000-0000-0000000000b2', '10000000-0000-0000-0000-000000000001',
            '20000000-0000-0000-0000-000000000001', 'refresh', 'complete', 'k-refresh')$$,
  'a non-current report for the same security is allowed');

select throws_ok(
  $$insert into public.research_reports (security_id, company_id, trigger, idempotency_key)
    values ('10000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000002', 'refresh', 'k-refresh')$$,
  '23505', null, 'idempotency_key is unique');

select is(app.promote_research_report('00000000-0000-0000-0000-0000000000b2'),
          '00000000-0000-0000-0000-0000000000b1'::uuid, 'promote returns the superseded report id');
select is((select is_current from public.research_reports where id = '00000000-0000-0000-0000-0000000000b1'),
          false, 'the previous report is no longer current');
select is((select is_current from public.research_reports where id = '00000000-0000-0000-0000-0000000000b2'),
          true, 'the promoted report is current');
select is((select supersedes_id from public.research_reports where id = '00000000-0000-0000-0000-0000000000b2'),
          '00000000-0000-0000-0000-0000000000b1'::uuid, 'supersedes_id points at the previous report');

insert into public.research_reports (id, security_id, company_id, trigger, status, idempotency_key)
values ('00000000-0000-0000-0000-0000000000b3', '10000000-0000-0000-0000-000000000001',
        '20000000-0000-0000-0000-000000000001', 'manual', 'running', 'k-running');
select throws_ok($$select app.promote_research_report('00000000-0000-0000-0000-0000000000b3')$$,
                 'P0001', null, 'only a complete report can become current');

insert into public.research_sources (report_id, evidence_id, url, canonical_url, kind)
values ('00000000-0000-0000-0000-0000000000b2', 1, 'https://a.example/x', 'https://a.example/x', 'other');
select throws_ok(
  $$insert into public.research_sources (report_id, evidence_id, url, canonical_url, kind)
    values ('00000000-0000-0000-0000-0000000000b2', 1, 'https://a.example/y', 'https://a.example/y', 'other')$$,
  '23505', null, 'evidence_id is unique per report');
select throws_ok(
  $$insert into public.research_sources (report_id, evidence_id, url, canonical_url, kind)
    values ('00000000-0000-0000-0000-0000000000b2', 2, 'https://a.example/x?utm_source=z', 'https://a.example/x', 'other')$$,
  '23505', null, 'canonical_url is unique per report (ledger dedupe)');
select throws_ok(
  $$insert into public.research_sources (report_id, evidence_id, url, canonical_url, kind, excerpt)
    values ('00000000-0000-0000-0000-0000000000b2', 3, 'https://a.example/z', 'https://a.example/z', 'other', repeat('x', 2001))$$,
  '23514', null, 'excerpt is capped at 2,000 characters');

insert into public.risk_findings (user_id, security_id, fingerprint, category, severity, summary)
values ('aaaaaaaa-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-000000000001', 'fp1', 'liquidity_debt', 'material', 's');
select throws_ok(
  $$insert into public.risk_findings (user_id, security_id, fingerprint, category, severity, summary)
    values ('aaaaaaaa-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-000000000001', 'fp1', 'liquidity_debt', 'material', 's2')$$,
  '23505', null, 'a finding fingerprint is unique per user and security');

select throws_ok(
  $$insert into public.research_reports (security_id, company_id, trigger, idempotency_key, conclusion)
    values ('10000000-0000-0000-0000-000000000003', '20000000-0000-0000-0000-000000000003', 'manual', 'k-bad', 'Meets the checks')$$,
  '23514', null, 'conclusion must be one of the three exact strings');

select * from finish();
rollback;
```

- [ ] **Step 4: Write the RLS suite `supabase/tests/research_rls.sql`**

Two users: A monitors security S1, B monitors S2. Report `a1` is public (S1), `a2` is holders-only on S1, `a3` is holders-only on S2. Results are collected into a temp table while the role is switched, because the pgTAP functions may not be executable by `anon`.

```sql
begin;
select plan(16);
set local session_replication_role = replica;

insert into public.research_reports (id, security_id, company_id, trigger, status, visibility, idempotency_key) values
  ('00000000-0000-0000-0000-0000000000a1', '10000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', 'new_discount', 'complete', 'public',  'rls-a1'),
  ('00000000-0000-0000-0000-0000000000a2', '10000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', 'monitor_first', 'complete', 'holders', 'rls-a2'),
  ('00000000-0000-0000-0000-0000000000a3', '10000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000002', 'monitor_first', 'complete', 'holders', 'rls-a3');
insert into public.research_sources (report_id, evidence_id, url, canonical_url, kind) values
  ('00000000-0000-0000-0000-0000000000a1', 1, 'https://x.example/1', 'https://x.example/1', 'other'),
  ('00000000-0000-0000-0000-0000000000a2', 1, 'https://x.example/2', 'https://x.example/2', 'other'),
  ('00000000-0000-0000-0000-0000000000a3', 1, 'https://x.example/3', 'https://x.example/3', 'other');
insert into public.risk_monitor_state (user_id, security_id, reasons) values
  ('aaaaaaaa-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-000000000001', '{outside_top50}'),
  ('bbbbbbbb-0000-0000-0000-00000000000b', '10000000-0000-0000-0000-000000000002', '{below_50b}');
insert into public.risk_findings (user_id, security_id, fingerprint, category, severity, summary) values
  ('aaaaaaaa-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-000000000001', 'fa', 'liquidity_debt', 'material', 'A finding'),
  ('bbbbbbbb-0000-0000-0000-00000000000b', '10000000-0000-0000-0000-000000000002', 'fb', 'guidance', 'watch', 'B finding');
insert into public.ai_quota_usage (provider, resource, period_kind, period_start, used) values ('t', 'r', 'day', current_date, 1);

create temp table seen (label text primary key, n int not null);
grant all on seen to anon, authenticated;

-- anonymous visitor
set local role anon;
insert into seen select 'anon_reports', count(*) from public.research_reports;
insert into seen select 'anon_sources', count(*) from public.research_sources;
do $$ begin
  perform 1 from public.risk_monitor_state;
  insert into seen values ('anon_risk_state_denied', 0);
exception when insufficient_privilege then insert into seen values ('anon_risk_state_denied', 1); end $$;
do $$ begin
  update public.research_sources set title = 'x';
  insert into seen values ('anon_write_denied', 0);
exception when insufficient_privilege then insert into seen values ('anon_write_denied', 1); end $$;
reset role;

-- user A
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-00000000000a","role":"authenticated"}', true);
set local role authenticated;
insert into seen select 'a_reports', count(*) from public.research_reports;
insert into seen select 'a_sources', count(*) from public.research_sources;
insert into seen select 'a_reports_s2', count(*) from public.research_reports where id = '00000000-0000-0000-0000-0000000000a3';
insert into seen select 'a_state', count(*) from public.risk_monitor_state;
insert into seen select 'a_findings', count(*) from public.risk_findings;
do $$ begin
  insert into public.research_reports (security_id, company_id, trigger, idempotency_key)
    values ('10000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', 'manual', 'rls-write');
  insert into seen values ('auth_write_denied', 0);
exception when insufficient_privilege then insert into seen values ('auth_write_denied', 1); end $$;
do $$ begin
  perform 1 from public.ai_quota_usage;
  insert into seen values ('auth_quota_denied', 0);
exception when insufficient_privilege then insert into seen values ('auth_quota_denied', 1); end $$;
reset role;

-- user B
select set_config('request.jwt.claims', '{"sub":"bbbbbbbb-0000-0000-0000-00000000000b","role":"authenticated"}', true);
set local role authenticated;
insert into seen select 'b_reports', count(*) from public.research_reports;
insert into seen select 'b_reports_s1_holders', count(*) from public.research_reports where id = '00000000-0000-0000-0000-0000000000a2';
insert into seen select 'b_findings', count(*) from public.risk_findings;
reset role;

select is((select n from seen where label = 'anon_reports'), 1, 'anon sees only the public report');
select is((select n from seen where label = 'anon_sources'), 1, 'anon sees only sources of public reports');
select is((select n from seen where label = 'anon_risk_state_denied'), 1, 'anon cannot read risk_monitor_state');
select is((select n from seen where label = 'anon_write_denied'), 1, 'anon cannot write research_sources');
select is((select n from seen where label = 'a_reports'), 2, 'holder A sees the public report and the holders report of S1');
select is((select n from seen where label = 'a_sources'), 2, 'holder A sees the sources of those two reports');
select is((select n from seen where label = 'a_reports_s2'), 0, 'holder A does not see the holders report of S2');
select is((select n from seen where label = 'a_state'), 1, 'A sees only A''s monitor row');
select is((select n from seen where label = 'a_findings'), 1, 'A sees only A''s finding');
select is((select n from seen where label = 'auth_write_denied'), 1, 'authenticated users cannot insert reports');
select is((select n from seen where label = 'auth_quota_denied'), 1, 'authenticated users cannot read ai_quota_usage');
select is((select n from seen where label = 'b_reports'), 2, 'holder B sees the public report and the holders report of S2');
select is((select n from seen where label = 'b_reports_s1_holders'), 0, 'holder B does not see the holders report of S1');
select is((select n from seen where label = 'b_findings'), 1, 'B sees only B''s finding');
select is(app.holder('10000000-0000-0000-0000-000000000001'), false, 'app.holder is false without a JWT subject');
select is((select count(*)::int from public.v_card_research), 0, 'the card research view exists and is empty without cards');

select * from finish();
rollback;
```

- [ ] **Step 5: Run the suites to see them fail**

Run: `bun run supabase:start` (first time only), then `bun run test:db`
Expected: the three new files FAIL with `relation "public.research_reports" does not exist` (and `function app.consume_quota(...) does not exist`); the P0/P1 files still pass.

- [ ] **Step 6: Write the migration `supabase/migrations/20261015002000_research_schema.sql`**

```sql
-- P2 research schema (spec 6.3.5, 6.6.5, 6.9, 9.8, 9.12). Forward-only; every object is guarded so a replay is safe.
create schema if not exists app;

do $$
begin
  if not exists (select 1 from pg_type where typnamespace = 'public'::regnamespace and typname = 'research_status') then
    create type public.research_status as enum ('queued', 'running', 'complete', 'failed', 'quota_deferred', 'stale');
  end if;
  if not exists (select 1 from pg_type where typnamespace = 'public'::regnamespace and typname = 'research_kind') then
    create type public.research_kind as enum ('full', 'change_check');
  end if;
  if not exists (select 1 from pg_type where typnamespace = 'public'::regnamespace and typname = 'research_trigger') then
    create type public.research_trigger as enum ('new_discount', 'premium', 'monitor_first', 'monitor_change', 'refresh', 'manual');
  end if;
  if not exists (select 1 from pg_type where typnamespace = 'public'::regnamespace and typname = 'report_visibility') then
    create type public.report_visibility as enum ('public', 'holders');
  end if;
  if not exists (select 1 from pg_type where typnamespace = 'public'::regnamespace and typname = 'bankruptcy_risk') then
    create type public.bankruptcy_risk as enum ('Low', 'Moderate', 'High', 'Unclear');
  end if;
  if not exists (select 1 from pg_type where typnamespace = 'public'::regnamespace and typname = 'operational_category') then
    create type public.operational_category as enum ('green', 'amber', 'red', 'grey', 'pending');
  end if;
end $$;

create or replace function app.touch_updated_at() returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

create table if not exists public.research_reports (
  id uuid primary key default gen_random_uuid(),
  security_id uuid not null references public.securities (id),
  company_id uuid not null references public.companies (id),
  scan_run_id uuid references public.scan_runs (id),
  kind public.research_kind not null default 'full',
  trigger public.research_trigger not null,
  status public.research_status not null default 'queued',
  step text,
  not_before timestamptz,
  is_current boolean not null default false,
  visibility public.report_visibility not null default 'public',
  report_md text,
  summary text,
  news_summary text,
  conclusion text check (conclusion in ('Meets these two fundamental checks.', 'Does not meet one or both checks.', 'Insufficient evidence to decide.')),
  bankruptcy_risk public.bankruptcy_risk,
  material_damage_established boolean,
  sufficient_evidence boolean,
  cited_evidence_ids int[] not null default '{}',
  claims jsonb not null default '[]',
  missing_documents jsonb not null default '[]',
  limitations jsonb not null default '[]',
  research_cutoff_date date,
  started_at timestamptz,
  completed_at timestamptz,
  provider text,
  model text,
  prompt_version text,
  schema_version text,
  usage jsonb not null default '{}',
  queries_used int not null default 0,
  docs_fetched int not null default 0,
  error text,
  supersedes_id uuid references public.research_reports (id),
  idempotency_key text not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists research_one_current on public.research_reports (security_id) where is_current;
create index if not exists research_reports_security_idx on public.research_reports (security_id, created_at desc);
create index if not exists research_reports_deferred_idx on public.research_reports (status, not_before) where status = 'quota_deferred';
drop trigger if exists research_reports_touch on public.research_reports;
create trigger research_reports_touch before update on public.research_reports
  for each row execute function app.touch_updated_at();

create table if not exists public.research_sources (
  id bigint generated always as identity primary key,
  report_id uuid not null references public.research_reports (id) on delete cascade,
  evidence_id int not null,
  url text not null,
  canonical_url text not null,
  title text,
  publisher text,
  kind text not null check (kind in ('edgar_filing', 'ir_page', 'rss', 'yahoo_news', 'search_result', 'other')),
  published_at timestamptz,
  filing_date date,
  retrieved_at timestamptz,
  http_status int,
  content_type text,
  content_hash text,
  excerpt text check (excerpt is null or char_length(excerpt) <= 2000),
  extracted jsonb not null default '[]',
  liveness_verified_at timestamptz,
  verification text not null default 'pending' check (verification in ('pending', 'ok', 'failed', 'skipped')),
  used_in_report boolean not null default false,
  meta jsonb not null default '{}',
  unique (report_id, evidence_id),
  unique (report_id, canonical_url)
);

-- Transient: fetched text carried from fetch:n to extract:n. Deleted when a report completes or fails.
create table if not exists public.research_work_texts (
  report_id uuid not null references public.research_reports (id) on delete cascade,
  evidence_id int not null,
  text text not null check (char_length(text) <= 60000),
  created_at timestamptz not null default now(),
  primary key (report_id, evidence_id)
);

create table if not exists public.ai_quota_usage (
  id bigint generated always as identity primary key,
  provider text not null,
  resource text not null,
  period_kind text not null check (period_kind in ('day', 'month')),
  period_start date not null,
  used int not null default 0,
  limit_value int,
  unique (provider, resource, period_kind, period_start)
);

create table if not exists public.risk_monitor_state (
  user_id uuid not null references auth.users (id) on delete cascade,
  security_id uuid not null references public.securities (id),
  reasons text[] not null,
  first_monitored_at timestamptz not null default now(),
  last_check_at timestamptz,
  last_report_id uuid references public.research_reports (id),
  last_category public.operational_category,
  last_seen_items jsonb not null default '{}',
  next_due_at timestamptz,
  status text not null default 'active' check (status in ('active', 'paused')),
  primary key (user_id, security_id)
);
create index if not exists risk_monitor_state_security_idx on public.risk_monitor_state (security_id);
create index if not exists risk_monitor_state_due_idx on public.risk_monitor_state (next_due_at) where status = 'active';

create table if not exists public.risk_findings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  security_id uuid not null references public.securities (id),
  report_id uuid references public.research_reports (id),
  fingerprint text not null,
  category text not null check (category in ('liquidity_debt', 'guidance', 'accounting_audit', 'regulatory_legal', 'credit_rating', 'governance', 'other')),
  severity text not null check (severity in ('material', 'watch')),
  summary text not null,
  evidence jsonb not null default '[]',
  detected_at timestamptz not null default now(),
  resolved_at timestamptz,
  notified_at timestamptz,
  unique (user_id, security_id, fingerprint)
);
create index if not exists risk_findings_open_idx on public.risk_findings (user_id, security_id) where resolved_at is null;

-- Cards link to their report as soon as the report row exists (status drives the "pending/deferred" labels).
alter table public.todays_discounts add column if not exists research_report_id uuid references public.research_reports (id);
alter table public.todays_discounts add column if not exists research_summary text;
alter table public.todays_discounts add column if not exists conclusion text;
alter table public.todays_discounts add column if not exists bankruptcy_risk public.bankruptcy_risk;
alter table public.todays_discounts add column if not exists research_completed_at timestamptz;
create index if not exists todays_discounts_report_idx on public.todays_discounts (research_report_id);

-- Holder test used by RLS. P5 replaces the body with a broker_positions lookup (create or replace).
create or replace function app.holder(p_security_id uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from public.risk_monitor_state m
     where m.security_id = p_security_id and m.user_id = auth.uid()
  )
$$;

-- Atomic quota consumption (spec 9.8): one UPDATE with the cap in the WHERE clause is the lock and the check.
create or replace function app.consume_quota(p_provider text, p_resource text, p_amount int, p_period_kind text, p_limit int)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_start date;
begin
  if p_amount is null or p_amount <= 0 then
    raise exception 'consume_quota: amount must be positive';
  end if;
  if p_period_kind not in ('day', 'month') then
    raise exception 'consume_quota: unknown period kind %', p_period_kind;
  end if;
  v_start := case p_period_kind
    when 'day' then (now() at time zone 'utc')::date
    else date_trunc('month', now() at time zone 'utc')::date
  end;
  insert into ai_quota_usage (provider, resource, period_kind, period_start, used, limit_value)
  values (p_provider, p_resource, p_period_kind, v_start, 0, p_limit)
  on conflict (provider, resource, period_kind, period_start) do nothing;
  update ai_quota_usage
     set used = used + p_amount, limit_value = p_limit
   where provider = p_provider and resource = p_resource
     and period_kind = p_period_kind and period_start = v_start
     and used + p_amount <= p_limit;
  return found;
end $$;

-- Makes a complete report the single current one for its security and records the one it supersedes.
create or replace function app.promote_research_report(p_report_id uuid) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_security uuid;
  v_status public.research_status;
  v_prev uuid;
begin
  select security_id, status into v_security, v_status from research_reports where id = p_report_id for update;
  if not found then
    raise exception 'promote_research_report: report % not found', p_report_id;
  end if;
  if v_status <> 'complete' then
    raise exception 'promote_research_report: only a complete report can become current';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(v_security::text, 0));
  select id into v_prev from research_reports
   where security_id = v_security and is_current and id <> p_report_id;
  update research_reports set is_current = false where security_id = v_security and is_current and id <> p_report_id;
  update research_reports set is_current = true, supersedes_id = coalesce(v_prev, supersedes_id) where id = p_report_id;
  return v_prev;
end $$;

create or replace function public.consume_quota_rpc(p_provider text, p_resource text, p_amount int, p_period_kind text, p_limit int)
returns boolean language sql security definer set search_path = public, pg_temp as $$
  select app.consume_quota(p_provider, p_resource, p_amount, p_period_kind, p_limit)
$$;

create or replace function public.promote_research_report_rpc(p_report_id uuid) returns uuid
language sql security definer set search_path = public, pg_temp as $$
  select app.promote_research_report(p_report_id)
$$;

grant usage on schema app to service_role;
revoke all on function app.consume_quota(text, text, int, text, int) from public, anon, authenticated;
revoke all on function app.promote_research_report(uuid) from public, anon, authenticated;
revoke all on function public.consume_quota_rpc(text, text, int, text, int) from public, anon, authenticated;
revoke all on function public.promote_research_report_rpc(uuid) from public, anon, authenticated;
grant execute on function app.consume_quota(text, text, int, text, int) to service_role;
grant execute on function app.promote_research_report(uuid) to service_role;
grant execute on function public.consume_quota_rpc(text, text, int, text, int) to service_role;
grant execute on function public.promote_research_report_rpc(uuid) to service_role;
grant execute on function app.holder(uuid) to anon, authenticated, service_role;

-- Public, security_invoker view the Overview merges with todays_discounts_feed (report status drives the labels).
create or replace view public.v_card_research with (security_invoker = true) as
select t.scan_run_id, t.mode, t.security_id, t.operational_category, t.category_reason, t.withheld,
       t.research_report_id, t.research_summary, t.conclusion, t.bankruptcy_risk, t.research_completed_at,
       r.status as report_status, r.error as report_error, r.step as report_step,
       r.provider, r.model, r.prompt_version
  from public.todays_discounts t
  left join public.research_reports r on r.id = t.research_report_id;
grant select on public.v_card_research to anon, authenticated;

-- Settings seed (spec 9.8, verbatim).
insert into public.app_settings (key, value, description, is_public)
values ('research',
        '{"max_full_reports_per_day": 4, "tavily_daily_cap": 32, "tavily_monthly_budget": 950, "llm_daily_request_cap": 300, "max_change_checks_per_day": 40, "reuse_days": 30, "tavily_reserved_for_reports": 24}'::jsonb,
        'Research caps and reuse window (spec 9.8); counters live in ai_quota_usage (UTC periods)',
        false)
on conflict (key) do nothing;

-- RLS (spec 6.9). Writes are service role only: no write policies and no write grants.
alter table public.research_reports enable row level security;
alter table public.research_sources enable row level security;
alter table public.research_work_texts enable row level security;
alter table public.ai_quota_usage enable row level security;
alter table public.risk_monitor_state enable row level security;
alter table public.risk_findings enable row level security;

revoke all on public.research_reports, public.research_sources, public.research_work_texts,
  public.ai_quota_usage, public.risk_monitor_state, public.risk_findings from anon, authenticated;
grant select on public.research_reports, public.research_sources to anon, authenticated;
grant select on public.risk_monitor_state, public.risk_findings to authenticated;

drop policy if exists research_reports_public on public.research_reports;
create policy research_reports_public on public.research_reports
  for select to anon, authenticated using (visibility = 'public');
drop policy if exists research_reports_holders on public.research_reports;
create policy research_reports_holders on public.research_reports
  for select to authenticated using (visibility = 'holders' and app.holder(security_id));

drop policy if exists research_sources_public on public.research_sources;
create policy research_sources_public on public.research_sources
  for select to anon, authenticated using (
    exists (select 1 from public.research_reports r where r.id = report_id and r.visibility = 'public'));
drop policy if exists research_sources_holders on public.research_sources;
create policy research_sources_holders on public.research_sources
  for select to authenticated using (
    exists (select 1 from public.research_reports r
             where r.id = report_id and r.visibility = 'holders' and app.holder(r.security_id)));

drop policy if exists risk_monitor_state_owner on public.risk_monitor_state;
create policy risk_monitor_state_owner on public.risk_monitor_state
  for select to authenticated using (user_id = auth.uid());
drop policy if exists risk_findings_owner on public.risk_findings;
create policy risk_findings_owner on public.risk_findings
  for select to authenticated using (user_id = auth.uid());
-- ai_quota_usage and research_work_texts: no policies, deny by default (service role bypasses RLS).
```

- [ ] **Step 7: Apply and run the suites**

Run: `bun run supabase:reset` then `bun run test:db`
Expected: all files PASS, including `research_quota.sql` (9 tests), `research_constraints.sql` (13), `research_rls.sql` (16). If `research_rls.sql` fails on `set local session_replication_role`, the local `postgres` role lacks the privilege: run the suite with `supabase test db --debug` and replace the fixture inserts' FKs by inserting minimal `companies`/`securities` rows instead (record the change in the commit message).

- [ ] **Step 8: Commit**

```text
git add supabase/migrations/20261015002000_research_schema.sql supabase/tests/research_quota.sql supabase/tests/research_constraints.sql supabase/tests/research_rls.sql
git commit -m "feat(db): add research schema, quota function, promote function and RLS for P2"
```

---

### Task 2: LLM adapters (`supabase/functions/_shared/adapters/llm/`)

**Files:**
- Create: `types.ts`, `util.ts`, `testing.ts`, `gemini.ts`, `openai-compatible.ts`, `index.ts`
- Create (tests): `gemini.test.ts`, `openai-compatible.test.ts`, `index.test.ts`

**Interfaces:**
- Consumes: nothing (global `fetch` only through an injectable `fetchImpl`).
- Produces: `LlmProvider { name; model; configured; generateJson<T>(req) }`, `GenerateJsonRequest`, `GenerateJsonResult<T>`, `LlmFailureKind`, `JsonSchema`, `FetchLike` (all in `types.ts`); `createGeminiProvider(opts)`, `toGeminiSchema(schema)`; `createOpenAiCompatibleProvider(opts)`; `createLlmProviders(env, fetchImpl?)` returning `{ primary, alternate, byName, order }`.
- Failure semantics (the handlers rely on them): `rate_limited` and `quota` both defer the report; `invalid_json` (unparseable or truncated text) and `schema` (parsed value is not an object, blocked or empty candidates) get one retry; `http` and `network` make the job fail and retry with the worker backoff; `not_configured` defers with `error = 'provider_not_configured'`.

- [ ] **Step 1: Write the shared types `types.ts`**

```ts
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** The only JSON-Schema shape the pipeline sends: an object with every property required. */
export interface JsonSchema {
  type: "object";
  properties: Record<string, unknown>;
  required: string[];
  additionalProperties: false;
}

export interface GenerateJsonRequest {
  system: string;
  user: string;
  schema: JsonSchema;
  schemaName?: string | undefined;
  maxOutputTokens: number;
  temperature: number;
  signal?: AbortSignal | undefined;
}

export type LlmFailureKind =
  | "rate_limited"
  | "quota"
  | "invalid_json"
  | "schema"
  | "http"
  | "network"
  | "not_configured";

export type GenerateJsonResult<T> =
  | { ok: true; json: T; usage: { input: number; output: number }; model: string }
  | { ok: false; kind: LlmFailureKind; status?: number | undefined; message: string };

export interface LlmProvider {
  readonly name: string;
  readonly model: string;
  /** False for a stub whose key or model is missing; `plan` uses it to avoid spending a call. */
  readonly configured: boolean;
  generateJson<T>(req: GenerateJsonRequest): Promise<GenerateJsonResult<T>>;
}
```

- [ ] **Step 2: Write the helpers `util.ts` and the test helper `testing.ts`**

```ts
import type { LlmFailureKind } from "./types.ts";

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function stripCodeFences(text: string): string {
  const trimmed = text.trim();
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return match?.[1] ?? trimmed;
}

export type ParsedJson = { ok: true; json: unknown } | { ok: false; message: string };

export function parseModelJson(text: string): ParsedJson {
  try {
    return { ok: true, json: JSON.parse(stripCodeFences(text)) };
  } catch (e) {
    return { ok: false, message: `model output is not valid JSON: ${(e as Error).message}`.slice(0, 200) };
  }
}

/** Removes secrets from a message and caps its length; error messages never carry a key. */
export function redact(message: string, secrets: readonly string[]): string {
  let out = message;
  for (const secret of secrets) {
    if (secret.length >= 4) out = out.split(secret).join("[redacted]");
  }
  return out.slice(0, 300);
}

export function errorMessage(e: unknown, secrets: readonly string[] = []): string {
  return redact(e instanceof Error ? e.message : String(e), secrets);
}

/** Maps an HTTP error body to a failure kind: 429 and exhausted-quota codes become quota or rate_limited. */
export function classifyHttpFailure(
  status: number,
  bodyText: string,
  secrets: readonly string[],
): { kind: LlmFailureKind; status: number; message: string } {
  let message = bodyText.slice(0, 300);
  try {
    const parsed: unknown = JSON.parse(bodyText);
    if (isPlainObject(parsed) && isPlainObject(parsed.error) && typeof parsed.error.message === "string") {
      message = parsed.error.message;
    }
  } catch {
    // keep the raw (truncated) body
  }
  const exhausted =
    status === 429 || /RESOURCE_EXHAUSTED|insufficient_quota|rate_limit_exceeded/i.test(bodyText);
  let kind: LlmFailureKind = "http";
  if (exhausted) {
    kind = /PerDay|per day|daily|insufficient_quota|billing/i.test(bodyText) ? "quota" : "rate_limited";
  }
  return { kind, status, message: redact(message, secrets) };
}
```

`testing.ts` (imported by tests only):

```ts
import type { FetchLike } from "./types.ts";

export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** A fetch fake that records every call and answers with `respond`. No network is ever touched. */
export function fakeFetch(respond: (call: RecordedCall) => Response | Promise<Response>): {
  fetchImpl: FetchLike;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    const raw = typeof init?.body === "string" ? init.body : undefined;
    const call: RecordedCall = {
      url: typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      method: init?.method ?? "GET",
      headers,
      body: raw === undefined ? undefined : JSON.parse(raw),
    };
    calls.push(call);
    return await respond(call);
  };
  return { fetchImpl, calls };
}
```

- [ ] **Step 3: Write the failing Gemini tests `gemini.test.ts`**

```ts
import { assert, assertEquals, assertFalse } from "jsr:@std/assert@1";
import { createGeminiProvider, toGeminiSchema } from "./gemini.ts";
import { fakeFetch, jsonResponse } from "./testing.ts";
import type { GenerateJsonRequest, JsonSchema } from "./types.ts";

const SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["facts"],
  properties: {
    facts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["claim"],
        properties: { claim: { type: "string" }, title: { type: "string" } },
      },
    },
  },
};

const REQ: GenerateJsonRequest = {
  system: "SYSTEM TEXT",
  user: "USER TEXT",
  schema: SCHEMA,
  maxOutputTokens: 512,
  temperature: 0.1,
};

const OK_BODY = {
  candidates: [{ content: { parts: [{ text: '{"facts":[]}' }] }, finishReason: "STOP" }],
  usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 7 },
};

function provider(fetchImpl: ReturnType<typeof fakeFetch>["fetchImpl"], key = "KEY-123456") {
  return createGeminiProvider({ apiKey: key, model: "gemini-test-model", fetchImpl });
}

Deno.test("gemini: builds the generateContent request and parses usage", async () => {
  const { fetchImpl, calls } = fakeFetch(() => jsonResponse(OK_BODY));
  const res = await provider(fetchImpl).generateJson<{ facts: unknown[] }>(REQ);
  assert(res.ok);
  assertEquals(res.json, { facts: [] });
  assertEquals(res.usage, { input: 120, output: 7 });
  assertEquals(res.model, "gemini-test-model");
  const call = calls[0];
  assert(call);
  assertEquals(
    call.url,
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-test-model:generateContent",
  );
  assertEquals(call.method, "POST");
  assertEquals(call.headers["x-goog-api-key"], "KEY-123456");
  const body = call.body as Record<string, any>;
  assertEquals(body.systemInstruction.parts[0].text, "SYSTEM TEXT");
  assertEquals(body.contents[0].parts[0].text, "USER TEXT");
  assertEquals(body.generationConfig.responseMimeType, "application/json");
  assertEquals(body.generationConfig.temperature, 0.1);
  assertEquals(body.generationConfig.maxOutputTokens, 512);
  assertFalse(JSON.stringify(body.generationConfig.responseSchema).includes("additionalProperties"));
  assertFalse(JSON.stringify(body).includes("googleSearch"), "no grounding tools, ever");
});

Deno.test("gemini: toGeminiSchema strips unsupported keywords but keeps property names", () => {
  const out = toGeminiSchema(SCHEMA) as Record<string, any>;
  assertFalse("additionalProperties" in out);
  assert("title" in out.properties.facts.items.properties, "a property called title survives");
  assertEquals(out.required, ["facts"]);
});

Deno.test("gemini: 429 RESOURCE_EXHAUSTED per day maps to quota, per minute to rate_limited", async () => {
  const day = fakeFetch(() =>
    jsonResponse({ error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "quota", details: [{ violations: [{ quotaId: "GenerateRequestsPerDayPerProjectPerModel" }] }] } }, 429));
  const a = await provider(day.fetchImpl).generateJson(REQ);
  assert(!a.ok);
  assertEquals(a.kind, "quota");
  assertEquals(a.status, 429);
  const minute = fakeFetch(() =>
    jsonResponse({ error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "slow down", details: [{ violations: [{ quotaId: "GenerateRequestsPerMinutePerProjectPerModel" }] }] } }, 429));
  const b = await provider(minute.fetchImpl).generateJson(REQ);
  assert(!b.ok);
  assertEquals(b.kind, "rate_limited");
});

Deno.test("gemini: unparseable text is invalid_json, a truncated reply too", async () => {
  const bad = fakeFetch(() => jsonResponse({ candidates: [{ content: { parts: [{ text: "not json" }] }, finishReason: "STOP" }] }));
  const a = await provider(bad.fetchImpl).generateJson(REQ);
  assert(!a.ok);
  assertEquals(a.kind, "invalid_json");
  const cut = fakeFetch(() => jsonResponse({ candidates: [{ content: { parts: [{ text: '{"facts":[' }] }, finishReason: "MAX_TOKENS" }] }));
  const b = await provider(cut.fetchImpl).generateJson(REQ);
  assert(!b.ok);
  assertEquals(b.kind, "invalid_json");
  assert(b.message.includes("truncated"));
});

Deno.test("gemini: a fenced JSON reply is accepted", async () => {
  const f = fakeFetch(() => jsonResponse({ candidates: [{ content: { parts: [{ text: '```json\n{"facts":[]}\n```' }] }, finishReason: "STOP" }] }));
  const res = await provider(f.fetchImpl).generateJson(REQ);
  assert(res.ok);
});

Deno.test("gemini: blocked prompt or no candidates is a schema failure; a JSON array is too", async () => {
  const blocked = fakeFetch(() => jsonResponse({ promptFeedback: { blockReason: "SAFETY" } }));
  const a = await provider(blocked.fetchImpl).generateJson(REQ);
  assert(!a.ok);
  assertEquals(a.kind, "schema");
  const arr = fakeFetch(() => jsonResponse({ candidates: [{ content: { parts: [{ text: "[1,2]" }] }, finishReason: "STOP" }] }));
  const b = await provider(arr.fetchImpl).generateJson(REQ);
  assert(!b.ok);
  assertEquals(b.kind, "schema");
});

Deno.test("gemini: a missing key or model is not_configured and never calls fetch", async () => {
  const f = fakeFetch(() => jsonResponse(OK_BODY));
  const noKey = createGeminiProvider({ apiKey: "", model: "m", fetchImpl: f.fetchImpl });
  assertEquals(noKey.configured, false);
  const a = await noKey.generateJson(REQ);
  assert(!a.ok);
  assertEquals(a.kind, "not_configured");
  const noModel = createGeminiProvider({ apiKey: "KEY-123456", fetchImpl: f.fetchImpl });
  const b = await noModel.generateJson(REQ);
  assert(!b.ok);
  assertEquals(b.kind, "not_configured");
  assertEquals(f.calls.length, 0);
});

Deno.test("gemini: network errors never echo the key; 5xx is http", async () => {
  const net = fakeFetch(() => {
    throw new Error("connect failed for https://x?key=KEY-123456");
  });
  const a = await provider(net.fetchImpl).generateJson(REQ);
  assert(!a.ok);
  assertEquals(a.kind, "network");
  assertFalse(a.message.includes("KEY-123456"));
  const five = fakeFetch(() => jsonResponse({ error: { message: "boom" } }, 503));
  const b = await provider(five.fetchImpl).generateJson(REQ);
  assert(!b.ok);
  assertEquals(b.kind, "http");
  assertEquals(b.status, 503);
});
```

- [ ] **Step 4: Write the failing OpenAI-compatible and factory tests**

`openai-compatible.test.ts`:

```ts
import { assert, assertEquals } from "jsr:@std/assert@1";
import { createOpenAiCompatibleProvider } from "./openai-compatible.ts";
import { fakeFetch, jsonResponse } from "./testing.ts";
import type { GenerateJsonRequest } from "./types.ts";

const REQ: GenerateJsonRequest = {
  system: "S",
  user: "U",
  schemaName: "change_check",
  schema: { type: "object", additionalProperties: false, required: ["material"], properties: { material: { type: "boolean" } } },
  maxOutputTokens: 256,
  temperature: 0,
};

const OK = {
  choices: [{ message: { content: '{"material":false}' }, finish_reason: "stop" }],
  usage: { prompt_tokens: 50, completion_tokens: 4 },
};

function make(fetchImpl: ReturnType<typeof fakeFetch>["fetchImpl"]) {
  return createOpenAiCompatibleProvider({
    label: "groq",
    baseUrl: "https://api.groq.com/openai/v1/",
    apiKey: "ALT-KEY-1234",
    model: "alt-model",
    fetchImpl,
  });
}

Deno.test("openai-compatible: posts chat/completions with a strict json_schema response_format", async () => {
  const { fetchImpl, calls } = fakeFetch(() => jsonResponse(OK));
  const p = make(fetchImpl);
  assertEquals(p.name, "openai_compatible:groq");
  const res = await p.generateJson<{ material: boolean }>(REQ);
  assert(res.ok);
  assertEquals(res.json, { material: false });
  assertEquals(res.usage, { input: 50, output: 4 });
  const call = calls[0];
  assert(call);
  assertEquals(call.url, "https://api.groq.com/openai/v1/chat/completions");
  assertEquals(call.headers.authorization, "Bearer ALT-KEY-1234");
  const body = call.body as Record<string, any>;
  assertEquals(body.model, "alt-model");
  assertEquals(body.messages, [{ role: "system", content: "S" }, { role: "user", content: "U" }]);
  assertEquals(body.response_format.type, "json_schema");
  assertEquals(body.response_format.json_schema.name, "change_check");
  assertEquals(body.response_format.json_schema.strict, true);
  assertEquals(body.max_tokens, 256);
});

Deno.test("openai-compatible: maps failures", async () => {
  const quota = fakeFetch(() => jsonResponse({ error: { code: "insufficient_quota", message: "no credit" } }, 429));
  const a = await make(quota.fetchImpl).generateJson(REQ);
  assert(!a.ok);
  assertEquals(a.kind, "quota");
  const rate = fakeFetch(() => jsonResponse({ error: { message: "slow" } }, 429));
  const b = await make(rate.fetchImpl).generateJson(REQ);
  assert(!b.ok);
  assertEquals(b.kind, "rate_limited");
  const bad = fakeFetch(() => jsonResponse({ choices: [{ message: { content: "nope" }, finish_reason: "stop" }] }));
  const c = await make(bad.fetchImpl).generateJson(REQ);
  assert(!c.ok);
  assertEquals(c.kind, "invalid_json");
  const cut = fakeFetch(() => jsonResponse({ choices: [{ message: { content: '{"mat' }, finish_reason: "length" }] }));
  const d = await make(cut.fetchImpl).generateJson(REQ);
  assert(!d.ok);
  assertEquals(d.kind, "invalid_json");
});

Deno.test("openai-compatible: missing configuration is not_configured", async () => {
  const f = fakeFetch(() => jsonResponse(OK));
  const p = createOpenAiCompatibleProvider({ baseUrl: "", apiKey: "", model: "", fetchImpl: f.fetchImpl });
  assertEquals(p.configured, false);
  const res = await p.generateJson(REQ);
  assert(!res.ok);
  assertEquals(res.kind, "not_configured");
  assertEquals(f.calls.length, 0);
});
```

`index.test.ts`:

```ts
import { assertEquals } from "jsr:@std/assert@1";
import { createLlmProviders } from "./index.ts";

const GEMINI = { GEMINI_API_KEY: "g-key-1234", GEMINI_MODEL: "gm" };
const ALT = { LLM_ALT_BASE_URL: "https://alt.example/v1", LLM_ALT_API_KEY: "a-key-1234", LLM_ALT_MODEL: "am", LLM_ALT_PROVIDER: "groq" };

Deno.test("factory: gemini is the default primary, the alt is the alternate", () => {
  const p = createLlmProviders({ ...GEMINI, ...ALT });
  assertEquals(p.primary.name, "gemini");
  assertEquals(p.alternate.name, "openai_compatible:groq");
  assertEquals(p.order, ["gemini", "openai_compatible:groq"]);
  assertEquals(Object.keys(p.byName).sort(), ["gemini", "openai_compatible:groq"]);
});

Deno.test("factory: LLM_PRIMARY=openai_compatible swaps the roles", () => {
  const p = createLlmProviders({ LLM_PRIMARY: "openai_compatible", ...GEMINI, ...ALT });
  assertEquals(p.primary.name, "openai_compatible:groq");
  assertEquals(p.alternate.name, "gemini");
});

Deno.test("factory: missing keys give not_configured stubs, never an exception", async () => {
  const p = createLlmProviders({});
  assertEquals(p.primary.configured, false);
  assertEquals(p.alternate.configured, false);
  const res = await p.primary.generateJson({
    system: "s", user: "u", maxOutputTokens: 1, temperature: 0,
    schema: { type: "object", properties: {}, required: [], additionalProperties: false },
  });
  assertEquals(res.ok, false);
  if (!res.ok) assertEquals(res.kind, "not_configured");
});
```

- [ ] **Step 5: Run to see the tests fail**

Run: `deno test -A --config supabase/functions/deno.json supabase/functions/_shared/adapters/llm`
Expected: FAIL with `Module not found "file:///.../gemini.ts"` (and the other two modules).

- [ ] **Step 6: Implement `gemini.ts`**

```ts
import type { FetchLike, GenerateJsonRequest, GenerateJsonResult, LlmProvider } from "./types.ts";
import { classifyHttpFailure, errorMessage, isPlainObject, parseModelJson } from "./util.ts";

const BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models";

/**
 * Gemini `responseSchema` is an OpenAPI subset. `additionalProperties`, `$schema`, `title` and `default`
 * are removed at the keyword level; names inside a `properties` map are never filtered.
 * The accepted subset is verified in P2-01; this is the only place to change if it differs.
 */
export function toGeminiSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(toGeminiSchema);
  if (!isPlainObject(schema)) return schema;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === "additionalProperties" || key === "$schema" || key === "title" || key === "default") continue;
    if (key === "properties" && isPlainObject(value)) {
      out[key] = Object.fromEntries(Object.entries(value).map(([name, sub]) => [name, toGeminiSchema(sub)]));
    } else {
      out[key] = toGeminiSchema(value);
    }
  }
  return out;
}

export interface GeminiOptions {
  apiKey?: string | undefined;
  model?: string | undefined;
  fetchImpl?: FetchLike | undefined;
}

interface GeminiResponse {
  candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
}

export function createGeminiProvider(opts: GeminiOptions): LlmProvider {
  const apiKey = opts.apiKey?.trim() ?? "";
  const model = opts.model?.trim() ?? "";
  const doFetch: FetchLike = opts.fetchImpl ?? ((input, init) => fetch(input, init));
  const configured = apiKey !== "" && model !== "";

  return {
    name: "gemini",
    model,
    configured,
    async generateJson<T>(req: GenerateJsonRequest): Promise<GenerateJsonResult<T>> {
      if (!configured) {
        return {
          ok: false,
          kind: "not_configured",
          message: apiKey === "" ? "GEMINI_API_KEY is not set" : "GEMINI_MODEL is not set",
        };
      }
      const body = {
        systemInstruction: { parts: [{ text: req.system }] },
        contents: [{ role: "user", parts: [{ text: req.user }] }],
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: toGeminiSchema(req.schema),
          temperature: req.temperature,
          maxOutputTokens: req.maxOutputTokens,
        },
      };
      let res: Response;
      try {
        res = await doFetch(`${BASE_URL}/${encodeURIComponent(model)}:generateContent`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
          body: JSON.stringify(body),
          ...(req.signal ? { signal: req.signal } : {}),
        });
      } catch (e) {
        return { ok: false, kind: "network", message: errorMessage(e, [apiKey]) };
      }
      let text: string;
      try {
        text = await res.text();
      } catch (e) {
        return { ok: false, kind: "network", message: errorMessage(e, [apiKey]) };
      }
      if (!res.ok) {
        const failure = classifyHttpFailure(res.status, text, [apiKey]);
        return { ok: false, kind: failure.kind, status: failure.status, message: failure.message };
      }
      let payload: GeminiResponse;
      try {
        payload = JSON.parse(text) as GeminiResponse;
      } catch {
        return { ok: false, kind: "invalid_json", message: "response body is not JSON" };
      }
      const candidate = payload.candidates?.[0];
      if (!candidate) {
        const reason = payload.promptFeedback?.blockReason;
        return { ok: false, kind: "schema", message: reason ? `prompt blocked: ${reason}` : "no candidates in the response" };
      }
      if (candidate.finishReason === "MAX_TOKENS") {
        return { ok: false, kind: "invalid_json", message: "output truncated at maxOutputTokens" };
      }
      const output = (candidate.content?.parts ?? []).map((p) => p.text ?? "").join("");
      const parsed = parseModelJson(output);
      if (!parsed.ok) return { ok: false, kind: "invalid_json", message: parsed.message };
      if (!isPlainObject(parsed.json)) {
        return { ok: false, kind: "schema", message: "model output is not a JSON object" };
      }
      return {
        ok: true,
        json: parsed.json as T,
        usage: {
          input: payload.usageMetadata?.promptTokenCount ?? 0,
          output: payload.usageMetadata?.candidatesTokenCount ?? 0,
        },
        model,
      };
    },
  };
}
```

- [ ] **Step 7: Implement `openai-compatible.ts`**

```ts
import type { FetchLike, GenerateJsonRequest, GenerateJsonResult, LlmProvider } from "./types.ts";
import { classifyHttpFailure, errorMessage, isPlainObject, parseModelJson } from "./util.ts";

export interface OpenAiCompatibleOptions {
  label?: string | undefined;
  baseUrl?: string | undefined;
  apiKey?: string | undefined;
  model?: string | undefined;
  fetchImpl?: FetchLike | undefined;
}

interface ChatResponse {
  choices?: { message?: { content?: string | null }; finish_reason?: string }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/** Any chat-completions endpoint with `response_format: json_schema` (Groq, OpenRouter, Mistral, Gemini-compat). */
export function createOpenAiCompatibleProvider(opts: OpenAiCompatibleOptions): LlmProvider {
  const baseUrl = (opts.baseUrl ?? "").trim().replace(/\/+$/, "");
  const apiKey = opts.apiKey?.trim() ?? "";
  const model = opts.model?.trim() ?? "";
  const label = opts.label?.trim() ?? "";
  const doFetch: FetchLike = opts.fetchImpl ?? ((input, init) => fetch(input, init));
  const configured = baseUrl !== "" && apiKey !== "" && model !== "";
  const name = label === "" ? "openai_compatible" : `openai_compatible:${label}`;

  return {
    name,
    model,
    configured,
    async generateJson<T>(req: GenerateJsonRequest): Promise<GenerateJsonResult<T>> {
      if (!configured) {
        return { ok: false, kind: "not_configured", message: "LLM_ALT_BASE_URL, LLM_ALT_API_KEY or LLM_ALT_MODEL is not set" };
      }
      const body = {
        model,
        messages: [
          { role: "system", content: req.system },
          { role: "user", content: req.user },
        ],
        temperature: req.temperature,
        max_tokens: req.maxOutputTokens,
        response_format: {
          type: "json_schema",
          json_schema: { name: req.schemaName ?? "output", schema: req.schema, strict: true },
        },
      };
      let res: Response;
      try {
        res = await doFetch(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
          body: JSON.stringify(body),
          ...(req.signal ? { signal: req.signal } : {}),
        });
      } catch (e) {
        return { ok: false, kind: "network", message: errorMessage(e, [apiKey]) };
      }
      let text: string;
      try {
        text = await res.text();
      } catch (e) {
        return { ok: false, kind: "network", message: errorMessage(e, [apiKey]) };
      }
      if (!res.ok) {
        const failure = classifyHttpFailure(res.status, text, [apiKey]);
        return { ok: false, kind: failure.kind, status: failure.status, message: failure.message };
      }
      let payload: ChatResponse;
      try {
        payload = JSON.parse(text) as ChatResponse;
      } catch {
        return { ok: false, kind: "invalid_json", message: "response body is not JSON" };
      }
      const choice = payload.choices?.[0];
      if (!choice) return { ok: false, kind: "schema", message: "no choices in the response" };
      if (choice.finish_reason === "length") {
        return { ok: false, kind: "invalid_json", message: "output truncated at max_tokens" };
      }
      const parsed = parseModelJson(choice.message?.content ?? "");
      if (!parsed.ok) return { ok: false, kind: "invalid_json", message: parsed.message };
      if (!isPlainObject(parsed.json)) {
        return { ok: false, kind: "schema", message: "model output is not a JSON object" };
      }
      return {
        ok: true,
        json: parsed.json as T,
        usage: { input: payload.usage?.prompt_tokens ?? 0, output: payload.usage?.completion_tokens ?? 0 },
        model,
      };
    },
  };
}
```

- [ ] **Step 8: Implement the factory `index.ts`**

```ts
import { createGeminiProvider } from "./gemini.ts";
import { createOpenAiCompatibleProvider } from "./openai-compatible.ts";
import type { FetchLike, LlmProvider } from "./types.ts";

export type { GenerateJsonRequest, GenerateJsonResult, JsonSchema, LlmFailureKind, LlmProvider, FetchLike } from "./types.ts";

export interface LlmEnv {
  LLM_PRIMARY?: string | undefined;
  GEMINI_API_KEY?: string | undefined;
  GEMINI_MODEL?: string | undefined;
  LLM_ALT_PROVIDER?: string | undefined;
  LLM_ALT_BASE_URL?: string | undefined;
  LLM_ALT_API_KEY?: string | undefined;
  LLM_ALT_MODEL?: string | undefined;
}

export interface LlmProviders {
  primary: LlmProvider;
  alternate: LlmProvider;
  /** Keyed by `provider.name`; a report stores the name and later steps look the provider up here. */
  byName: Record<string, LlmProvider>;
  /** Primary first, then alternate. */
  order: string[];
}

/** Missing keys never throw: the provider is a `configured = false` stub that answers `not_configured`. */
export function createLlmProviders(env: LlmEnv, fetchImpl?: FetchLike): LlmProviders {
  const gemini = createGeminiProvider({
    apiKey: env.GEMINI_API_KEY,
    model: env.GEMINI_MODEL,
    fetchImpl,
  });
  const alt = createOpenAiCompatibleProvider({
    label: env.LLM_ALT_PROVIDER,
    baseUrl: env.LLM_ALT_BASE_URL,
    apiKey: env.LLM_ALT_API_KEY,
    model: env.LLM_ALT_MODEL,
    fetchImpl,
  });
  const swapped = env.LLM_PRIMARY?.trim() === "openai_compatible";
  const primary = swapped ? alt : gemini;
  const alternate = swapped ? gemini : alt;
  return {
    primary,
    alternate,
    byName: { [primary.name]: primary, [alternate.name]: alternate },
    order: [primary.name, alternate.name],
  };
}
```

- [ ] **Step 9: Run the tests, check types, lint**

Run: `deno test -A --config supabase/functions/deno.json supabase/functions/_shared/adapters/llm`
Expected: all tests PASS (gemini 8, openai-compatible 3, factory 3).

Run: `bun run functions:check` then `bun run lint:fix` then `bun run lint`
Expected: exit 0. (If Biome flags `any` in the tests' `as Record<string, any>` casts, replace them with `as Record<string, unknown>` plus narrowing helpers, or add a `// biome-ignore lint/suspicious/noExplicitAny: test fixture access` line.)

- [ ] **Step 10: Commit**

```text
git add supabase/functions/_shared/adapters/llm
git commit -m "feat(research): add Gemini and OpenAI-compatible LLM adapters with injectable fetch"
```

---

### Task 3: Retrieval adapters (`adapters/search/tavily.ts`, `adapters/fetchers/*`)

**Files:**
- Create: `supabase/functions/_shared/adapters/search/tavily.ts`, `tavily.test.ts`
- Create: `supabase/functions/_shared/adapters/fetchers/{limiter,extract,direct,jina,edgar,rss}.ts` and `{limiter,extract,direct,jina,edgar,rss}.test.ts`

**Interfaces:**
- Consumes: global `fetch` through injectable `fetchImpl`; `npm:fast-xml-parser@5.11.2` (inline specifier, so the canonical per-function import map is untouched).
- Produces (all result types are discriminated unions, adapters never throw for expected failures):
  - `createTavilyClient({ apiKey, fetchImpl }): TavilyClient` with `search(query, signal?) -> { ok: true; results: SearchHit[] } | { ok: false; kind: "quota" | "rate_limited" | "http" | "network" | "not_configured"; ... }`; `SearchHit { url; title; snippet; publishedDate? }`.
  - `fetchDocument(url, opts) -> DocFetchOk | DocFetchFail` (`text` is plain text, or `null` for a PDF which the caller routes to Jina), `publicUrlProblem(url)`, `isSecHost(host)`.
  - `readerUrl(url)`, `readViaJina(url, opts) -> { ok: true; status; text } | { ok: false; kind: "rate_limited" | "http" | "timeout" | "network" | "blocked"; ... }`.
  - `createEdgarClient({ userAgent, fetchImpl, limiter }): EdgarClient` with `resolveCik(ticker)`, `submissions(cik)`, `filingUrl(cik, accession, primaryDocument)`; `Filing { form; accession; filingDate; primaryDocument; reportDate }`; `resetTickerCache()`.
  - `parseFeed(xml): FeedItem[]`, `fetchFeed(url, opts)`; `FeedItem { guid; title; link; published }`.
  - `htmlToText`, `capText(text, 48000)`, `estimateTokens`, `canonicalUrl`; `TokenBucket`, `secLimiter` (4 req/s), `noLimiter`.

- [ ] **Step 1: Write the failing tests for the pure helpers (`limiter.test.ts`, `extract.test.ts`)**

`limiter.test.ts`:

```ts
import { assert, assertEquals } from "jsr:@std/assert@1";
import { TokenBucket } from "./limiter.ts";

Deno.test("TokenBucket(4/s, burst 1) spaces calls at least 250 ms apart", async () => {
  let clock = 0;
  const stamps: number[] = [];
  const bucket = new TokenBucket(4, 1, () => clock, async (ms) => {
    clock += ms;
  });
  for (let i = 0; i < 5; i++) {
    await bucket.take();
    stamps.push(clock);
  }
  assertEquals(stamps[0], 0);
  for (let i = 1; i < stamps.length; i++) {
    assert((stamps[i] ?? 0) - (stamps[i - 1] ?? 0) >= 250, `gap ${i}`);
  }
  assert((stamps.at(-1) ?? 0) >= 1000);
});
```

`extract.test.ts`:

```ts
import { assert, assertEquals, assertFalse } from "jsr:@std/assert@1";
import { canonicalUrl, capText, estimateTokens, htmlToText } from "./extract.ts";

Deno.test("htmlToText strips scripts, styles and tags, decodes entities, collapses whitespace", () => {
  const html = `<html><head><title>T</title><style>p{color:red}</style></head><body>
    <script>alert('x')</script><h1>Annual   Report</h1><p>Revenue &amp; profit rose&nbsp;5&#37;.</p>
    <!-- hidden --><ul><li>One</li><li>Two</li></ul><noscript>nojs</noscript></body></html>`;
  const text = htmlToText(html);
  assertFalse(text.includes("alert"));
  assertFalse(text.includes("color:red"));
  assertFalse(text.includes("hidden"));
  assertFalse(text.includes("nojs"));
  assert(text.includes("Annual Report"));
  assert(text.includes("Revenue & profit rose 5%."));
  assert(!/ {2,}/.test(text), "no double spaces");
  assert(!/\n{3,}/.test(text), "no triple newlines");
});

Deno.test("capText caps at the limit and never ends on half a surrogate pair", () => {
  assertEquals(capText("abc", 10), "abc");
  assertEquals(capText("abcdef", 3), "abc");
  const emoji = "a\u{1F600}b";
  assertEquals(capText(emoji, 2), "a");
  assertEquals(capText("x".repeat(60000)).length, 48000);
});

Deno.test("estimateTokens is chars / 4 rounded up", () => {
  assertEquals(estimateTokens(""), 0);
  assertEquals(estimateTokens("abcd"), 1);
  assertEquals(estimateTokens("abcde"), 2);
});

Deno.test("canonicalUrl lower-cases the host, strips fragment and tracking, sorts the rest", () => {
  assertEquals(
    canonicalUrl("HTTPS://Investors.Example.COM/Reports/Q3?utm_source=x&b=2&a=1&fbclid=z&gclid=y#section"),
    "https://investors.example.com/Reports/Q3?a=1&b=2",
  );
  assertEquals(canonicalUrl("https://example.com"), "https://example.com/");
  assertEquals(canonicalUrl(" https://example.com/x?UTM_Medium=m "), "https://example.com/x");
  assertEquals(canonicalUrl("not a url"), "not a url");
  assertEquals(canonicalUrl("https://a.com/x?utm_campaign=1"), canonicalUrl("https://A.com/x#frag"));
});
```

- [ ] **Step 2: Implement `limiter.ts` and `extract.ts`**

`limiter.ts`:

```ts
export interface Limiter {
  take(): Promise<void>;
}

/** Token bucket: `ratePerSec` tokens per second, at most `burst` stored. Time and sleep are injectable. */
export class TokenBucket implements Limiter {
  private tokens: number;
  private last: number;

  constructor(
    private readonly ratePerSec: number,
    private readonly burst = 1,
    private readonly now: () => number = () => performance.now(),
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  ) {
    this.tokens = burst;
    this.last = now();
  }

  async take(): Promise<void> {
    for (;;) {
      const t = this.now();
      this.tokens = Math.min(this.burst, this.tokens + ((t - this.last) / 1000) * this.ratePerSec);
      this.last = t;
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      await this.sleep(Math.ceil(((1 - this.tokens) / this.ratePerSec) * 1000));
    }
  }
}

/** All sec.gov traffic of one isolate: 4 req/s (spec 9.4: at most 5 req/s project-wide with 2 workers). */
export const secLimiter: Limiter = new TokenBucket(4, 1);

/** Keyless Jina Reader allows 20 requests per minute. */
export const jinaKeylessLimiter: Limiter = new TokenBucket(1 / 3, 1);

export const noLimiter: Limiter = { take: () => Promise.resolve() };
```

`extract.ts`:

```ts
const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "-", mdash: "-", rsquo: "'", lsquo: "'", ldquo: '"', rdquo: '"',
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      const cp = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : whole;
    }
    if (body.startsWith("#")) {
      const cp = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : whole;
    }
    return ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/** Regex-based HTML to text: drops scripts, styles, comments and tags, keeps block structure as newlines. */
export function htmlToText(html: string): string {
  const withoutTags = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|head)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article|table|ul|ol|blockquote)\s*>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  return decodeEntities(withoutTags)
    .replace(/[ \t\f\v ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** About 12k tokens (48,000 characters) per document. */
export function capText(text: string, maxChars = 48_000): string {
  if (text.length <= maxChars) return text;
  let cut = text.slice(0, maxChars);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return cut;
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Lower-case host (the URL parser does it), no fragment, no `utm_*`, `fbclid`, `gclid`, remaining params sorted. */
export function canonicalUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return raw.trim();
  }
  url.hash = "";
  const kept: [string, string][] = [];
  for (const [key, value] of url.searchParams) {
    const lower = key.toLowerCase();
    if (lower.startsWith("utm_") || lower === "fbclid" || lower === "gclid") continue;
    kept.push([key, value]);
  }
  kept.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  url.search = "";
  for (const [key, value] of kept) url.searchParams.append(key, value);
  return url.href;
}
```

- [ ] **Step 3: Run the helper tests**

Run: `deno test -A --config supabase/functions/deno.json supabase/functions/_shared/adapters/fetchers/limiter.test.ts supabase/functions/_shared/adapters/fetchers/extract.test.ts`
Expected: first run before Step 2 fails with `Module not found`; after Step 2, 5 tests PASS.

- [ ] **Step 4: Write the failing tests for the direct fetcher (`direct.test.ts`)**

```ts
import { assert, assertEquals } from "jsr:@std/assert@1";
import { fetchDocument, isSecHost, publicUrlProblem } from "./direct.ts";
import { noLimiter } from "./limiter.ts";
import type { FetchLike } from "../llm/types.ts";

function stub(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const seen: { url: string; headers: Record<string, string> }[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => {
      headers[k.toLowerCase()] = v;
    });
    seen.push({ url, headers });
    return await handler(url, init ?? {});
  };
  return { fetchImpl, seen };
}

const html = (body: string, type = "text/html; charset=utf-8", status = 200) =>
  new Response(body, { status, headers: { "content-type": type } });

Deno.test("direct: extracts plain text from HTML", async () => {
  const { fetchImpl } = stub(() => html("<html><script>x()</script><p>Hello &amp; welcome</p></html>"));
  const res = await fetchDocument("https://investors.example.com/q3", { fetchImpl });
  assert(res.ok);
  assertEquals(res.text, "Hello & welcome");
  assertEquals(res.contentType, "text/html");
  assertEquals(res.truncated, false);
});

Deno.test("direct: a PDF is reported without text so the caller can route it to Jina", async () => {
  const { fetchImpl } = stub(() => new Response("%PDF-1.7", { headers: { "content-type": "application/pdf" } }));
  const res = await fetchDocument("https://example.com/report.pdf", { fetchImpl });
  assert(res.ok);
  assertEquals(res.text, null);
  assertEquals(res.contentType, "application/pdf");
});

Deno.test("direct: content types outside the allow-list are refused", async () => {
  const { fetchImpl } = stub(() => new Response("x", { headers: { "content-type": "image/png" } }));
  const res = await fetchDocument("https://example.com/a.png", { fetchImpl });
  assert(!res.ok);
  assertEquals(res.kind, "content_type");
});

Deno.test("direct: the body read is capped (default 2 MB, here 50 bytes)", async () => {
  const { fetchImpl } = stub(() => html("a".repeat(500), "text/plain"));
  const res = await fetchDocument("https://example.com/big.txt", { fetchImpl, maxBytes: 50 });
  assert(res.ok);
  assertEquals(res.text?.length, 50);
  assertEquals(res.truncated, true);
});

Deno.test("direct: SEC hosts require and send SEC_USER_AGENT and use the SEC limiter", async () => {
  let taken = 0;
  const limiter = { take: () => { taken++; return Promise.resolve(); } };
  const { fetchImpl, seen } = stub(() => html("<p>filing</p>"));
  const refused = await fetchDocument("https://www.sec.gov/Archives/edgar/data/1/x.htm", { fetchImpl, limiter });
  assert(!refused.ok);
  assertEquals(refused.kind, "blocked");
  assertEquals(seen.length, 0, "no request without a declared User-Agent");
  const res = await fetchDocument("https://www.sec.gov/Archives/edgar/data/1/x.htm", {
    fetchImpl, secUserAgent: "Screener admin@example.com", limiter,
  });
  assert(res.ok);
  assertEquals(seen[0]?.headers["user-agent"], "Screener admin@example.com");
  assertEquals(taken, 1);
  assert(isSecHost("data.sec.gov") && isSecHost("sec.gov") && !isSecHost("notsec.gov"));
});

Deno.test("direct: private and local targets are never requested, including via redirect", async () => {
  for (const bad of ["http://127.0.0.1/", "http://localhost/x", "http://169.254.169.254/latest", "http://10.0.0.5/", "http://[::1]/", "ftp://example.com/x", "http://intranet/x"]) {
    assert(publicUrlProblem(bad) !== null, bad);
  }
  assertEquals(publicUrlProblem("https://investors.example.com/x"), null);
  const { fetchImpl, seen } = stub((url) =>
    url === "https://example.com/start"
      ? new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data" } })
      : html("secret"));
  const res = await fetchDocument("https://example.com/start", { fetchImpl, limiter: noLimiter });
  assert(!res.ok);
  assertEquals(res.kind, "blocked");
  assertEquals(seen.length, 1);
});

Deno.test("direct: follows a public redirect and reports the final URL", async () => {
  const { fetchImpl } = stub((url) =>
    url === "https://example.com/old"
      ? new Response(null, { status: 301, headers: { location: "/new" } })
      : html("<p>moved</p>"));
  const res = await fetchDocument("https://example.com/old", { fetchImpl });
  assert(res.ok);
  assertEquals(res.finalUrl, "https://example.com/new");
});

Deno.test("direct: 404 is http with the status; a hung server is a timeout", async () => {
  const notFound = stub(() => html("nope", "text/html", 404));
  const a = await fetchDocument("https://example.com/missing", { fetchImpl: notFound.fetchImpl });
  assert(!a.ok);
  assertEquals(a.kind, "http");
  assertEquals(a.status, 404);
  const hung = stub((_url, init) =>
    new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
    }));
  const b = await fetchDocument("https://example.com/slow", { fetchImpl: hung.fetchImpl, timeoutMs: 20 });
  assert(!b.ok);
  assertEquals(b.kind, "timeout");
});
```

- [ ] **Step 5: Implement `direct.ts`**

```ts
import type { FetchLike } from "../llm/types.ts";
import { htmlToText } from "./extract.ts";
import { type Limiter, secLimiter } from "./limiter.ts";

const ALLOWED_TYPES = new Set(["text/html", "application/xhtml+xml", "text/plain", "application/pdf"]);
const DEFAULT_UA = "personal-stock-screener/1.0 (public research fetcher)";
const ACCEPT = "text/html,application/xhtml+xml,application/pdf,text/plain;q=0.9,*/*;q=0.1";
const MAX_REDIRECTS = 4;

export interface DocFetchOk {
  ok: true;
  status: number;
  contentType: string;
  /** Plain text; null for a PDF (route it to Jina Reader). */
  text: string | null;
  truncated: boolean;
  finalUrl: string;
  bytes: number;
}

export interface DocFetchFail {
  ok: false;
  kind: "blocked" | "http" | "content_type" | "timeout" | "network";
  status?: number | undefined;
  message: string;
}

export type DocFetchResult = DocFetchOk | DocFetchFail;

export interface DirectOptions {
  signal?: AbortSignal | undefined;
  fetchImpl?: FetchLike | undefined;
  secUserAgent?: string | undefined;
  userAgent?: string | undefined;
  timeoutMs?: number | undefined;
  maxBytes?: number | undefined;
  limiter?: Limiter | undefined;
}

export function isSecHost(host: string): boolean {
  const h = host.toLowerCase();
  return h === "sec.gov" || h.endsWith(".sec.gov");
}

const PRIVATE_V4 = [
  /^10\./, /^127\./, /^0\./, /^169\.254\./, /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
];

/** SSRF guard for URLs that come from search results: returns the reason a URL must not be requested, or null. */
export function publicUrlProblem(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "invalid URL";
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return `unsupported protocol ${url.protocol}`;
  if (url.username !== "" || url.password !== "") return "credentials in URL";
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    return "local host";
  }
  if (host.startsWith("[")) return "IPv6 literal";
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) && PRIVATE_V4.some((re) => re.test(host))) return "private address";
  if (!host.includes(".")) return "single-label host";
  return null;
}

async function readCapped(res: Response, maxBytes: number): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  const reader = res.body?.getReader();
  if (!reader) return { bytes: new Uint8Array(0), truncated: false };
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (total + value.length > maxBytes) {
      chunks.push(value.subarray(0, maxBytes - total));
      total = maxBytes;
      truncated = true;
      await reader.cancel();
      break;
    }
    chunks.push(value);
    total += value.length;
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return { bytes, truncated };
}

function failure(e: unknown, signal: AbortSignal): DocFetchFail {
  const timedOut = signal.aborted && signal.reason instanceof DOMException && signal.reason.name === "TimeoutError";
  return timedOut
    ? { ok: false, kind: "timeout", message: "request timed out" }
    : { ok: false, kind: "network", message: (e instanceof Error ? e.message : String(e)).slice(0, 200) };
}

/** GET with a 15 s timeout, a 2 MB read cap, a content-type allow-list and manual (re-checked) redirects. */
export async function fetchDocument(url: string, opts: DirectOptions = {}): Promise<DocFetchResult> {
  const doFetch: FetchLike = opts.fetchImpl ?? ((input, init) => fetch(input, init));
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? 15_000);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
  const maxBytes = opts.maxBytes ?? 2 * 1024 * 1024;
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const problem = publicUrlProblem(current);
    if (problem) return { ok: false, kind: "blocked", message: problem };
    const host = new URL(current).hostname;
    const headers: Record<string, string> = { accept: ACCEPT, "user-agent": opts.userAgent ?? DEFAULT_UA };
    if (isSecHost(host)) {
      const ua = opts.secUserAgent?.trim() ?? "";
      if (ua === "") return { ok: false, kind: "blocked", message: "SEC_USER_AGENT is not configured" };
      headers["user-agent"] = ua;
      await (opts.limiter ?? secLimiter).take();
    }
    let res: Response;
    try {
      res = await doFetch(current, { method: "GET", headers, redirect: "manual", signal });
    } catch (e) {
      return failure(e, signal);
    }
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      await res.body?.cancel();
      if (!location) return { ok: false, kind: "http", status: res.status, message: "redirect without location" };
      current = new URL(location, current).href;
      continue;
    }
    if (!res.ok) {
      await res.body?.cancel();
      return { ok: false, kind: "http", status: res.status, message: `HTTP ${res.status}` };
    }
    const contentType = (res.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
    if (!ALLOWED_TYPES.has(contentType)) {
      await res.body?.cancel();
      return { ok: false, kind: "content_type", status: res.status, message: `content type ${contentType || "(none)"} not allowed` };
    }
    if (contentType === "application/pdf") {
      await res.body?.cancel();
      return { ok: true, status: res.status, contentType, text: null, truncated: false, finalUrl: current, bytes: 0 };
    }
    try {
      const { bytes, truncated } = await readCapped(res, maxBytes);
      const raw = new TextDecoder("utf-8").decode(bytes);
      const text = contentType === "text/plain" ? raw.trim() : htmlToText(raw);
      return { ok: true, status: res.status, contentType, text, truncated, finalUrl: current, bytes: bytes.length };
    } catch (e) {
      return failure(e, signal);
    }
  }
  return { ok: false, kind: "http", message: "too many redirects" };
}
```

- [ ] **Step 6: Write the failing tests for Jina, EDGAR, RSS and Tavily**

`jina.test.ts`:

```ts
import { assert, assertEquals } from "jsr:@std/assert@1";
import { readViaJina, readerUrl } from "./jina.ts";
import { noLimiter } from "./limiter.ts";
import type { FetchLike } from "../llm/types.ts";

function stub(res: () => Response) {
  const seen: { url: string; headers: Record<string, string> }[] = [];
  const fetchImpl: FetchLike = (input, init) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => {
      headers[k.toLowerCase()] = v;
    });
    seen.push({ url: typeof input === "string" ? input : String(input), headers });
    return Promise.resolve(res());
  };
  return { fetchImpl, seen };
}

Deno.test("jina: readerUrl prefixes the target", () => {
  assertEquals(readerUrl("https://www.sec.gov/a.htm"), "https://r.jina.ai/https://www.sec.gov/a.htm");
});

Deno.test("jina: returns text, sends a bearer only when a key exists", async () => {
  const keyed = stub(() => new Response("Title: X\n\nMarkdown Content:\nHello"));
  const a = await readViaJina("https://example.com/r.pdf", { apiKey: "JINA-KEY-1", fetchImpl: keyed.fetchImpl, limiter: noLimiter });
  assert(a.ok);
  assert(a.text.includes("Hello"));
  assertEquals(keyed.seen[0]?.url, "https://r.jina.ai/https://example.com/r.pdf");
  assertEquals(keyed.seen[0]?.headers.authorization, "Bearer JINA-KEY-1");
  const keyless = stub(() => new Response("ok"));
  await readViaJina("https://example.com/r", { fetchImpl: keyless.fetchImpl, limiter: noLimiter });
  assertEquals(keyless.seen[0]?.headers.authorization, undefined);
});

Deno.test("jina: 429 is rate_limited, other errors http, private targets blocked without a request", async () => {
  const limited = stub(() => new Response("slow", { status: 429 }));
  const a = await readViaJina("https://example.com/r", { fetchImpl: limited.fetchImpl, limiter: noLimiter });
  assert(!a.ok);
  assertEquals(a.kind, "rate_limited");
  const broken = stub(() => new Response("boom", { status: 502 }));
  const b = await readViaJina("https://example.com/r", { fetchImpl: broken.fetchImpl, limiter: noLimiter });
  assert(!b.ok);
  assertEquals(b.kind, "http");
  const blocked = stub(() => new Response("never"));
  const c = await readViaJina("http://127.0.0.1/secret", { fetchImpl: blocked.fetchImpl, limiter: noLimiter });
  assert(!c.ok);
  assertEquals(c.kind, "blocked");
  assertEquals(blocked.seen.length, 0);
});
```

`edgar.test.ts`:

```ts
import { assert, assertEquals } from "jsr:@std/assert@1";
import { createEdgarClient, resetTickerCache } from "./edgar.ts";
import type { FetchLike } from "../llm/types.ts";

const TICKERS = {
  "0": { cik_str: 320193, ticker: "AAPL", title: "Apple Inc." },
  "1": { cik_str: 1067983, ticker: "BRK-B", title: "BERKSHIRE HATHAWAY INC" },
};

const SUBMISSIONS = {
  cik: "0000320193",
  filings: {
    recent: {
      accessionNumber: ["0000320193-26-000100", "0000320193-26-000090", "0000320193-25-000123"],
      filingDate: ["2026-10-02", "2026-08-01", "2025-11-01"],
      reportDate: ["2026-09-30", "2026-06-27", "2025-09-27"],
      form: ["8-K", "10-Q", "10-K"],
      primaryDocument: ["a8k.htm", "a10q.htm", "a10k.htm"],
    },
  },
};

function stub() {
  const seen: { url: string; ua: string | undefined }[] = [];
  const fetchImpl: FetchLike = (input, init) => {
    const url = typeof input === "string" ? input : String(input);
    seen.push({ url, ua: new Headers(init?.headers).get("user-agent") ?? undefined });
    if (url.endsWith("company_tickers.json")) return Promise.resolve(Response.json(TICKERS));
    if (url.includes("/submissions/CIK0000320193.json")) return Promise.resolve(Response.json(SUBMISSIONS));
    return Promise.resolve(new Response("nf", { status: 404 }));
  };
  return { fetchImpl, seen };
}

const UA = "Screener admin@example.com";
const limiter = { take: () => Promise.resolve() };

Deno.test("edgar: resolveCik maps a ticker to a zero-padded CIK, caches the file, and sends the User-Agent", async () => {
  resetTickerCache();
  const { fetchImpl, seen } = stub();
  const edgar = createEdgarClient({ userAgent: UA, fetchImpl, limiter });
  const aapl = await edgar.resolveCik("aapl");
  assert(aapl.ok);
  assertEquals(aapl.value, "0000320193");
  const brk = await edgar.resolveCik("BRK-B");
  assert(brk.ok);
  assertEquals(brk.value, "0001067983");
  const none = await edgar.resolveCik("ZZZZ");
  assert(none.ok);
  assertEquals(none.value, null);
  assertEquals(seen.filter((s) => s.url.endsWith("company_tickers.json")).length, 1, "tickers file fetched once");
  assertEquals(seen[0]?.ua, UA);
});

Deno.test("edgar: submissions returns recent filings and filingUrl builds the archive URL", async () => {
  const { fetchImpl } = stub();
  const edgar = createEdgarClient({ userAgent: UA, fetchImpl, limiter });
  const res = await edgar.submissions("0000320193");
  assert(res.ok);
  assertEquals(res.value.length, 3);
  assertEquals(res.value[0], {
    form: "8-K", accession: "0000320193-26-000100", filingDate: "2026-10-02",
    primaryDocument: "a8k.htm", reportDate: "2026-09-30",
  });
  assertEquals(
    edgar.filingUrl("0000320193", "0000320193-26-000090", "a10q.htm"),
    "https://www.sec.gov/Archives/edgar/data/320193/000032019326000090/a10q.htm",
  );
});

Deno.test("edgar: no User-Agent means no request", async () => {
  resetTickerCache();
  const { fetchImpl, seen } = stub();
  const edgar = createEdgarClient({ userAgent: "  ", fetchImpl, limiter });
  const a = await edgar.resolveCik("AAPL");
  assert(!a.ok);
  assertEquals(a.kind, "not_configured");
  const b = await edgar.submissions("0000320193");
  assert(!b.ok);
  assertEquals(b.kind, "not_configured");
  assertEquals(seen.length, 0);
});

Deno.test("edgar: every request passes through the limiter; HTTP errors are reported", async () => {
  resetTickerCache();
  let taken = 0;
  const counting = { take: () => { taken++; return Promise.resolve(); } };
  const { fetchImpl } = stub();
  const edgar = createEdgarClient({ userAgent: UA, fetchImpl, limiter: counting });
  await edgar.submissions("0000320193");
  const missing = await edgar.submissions("0000000001");
  assertEquals(taken, 2);
  assert(!missing.ok);
  assertEquals(missing.kind, "http");
  assertEquals(missing.status, 404);
});
```

`rss.test.ts`:

```ts
import { assertEquals } from "jsr:@std/assert@1";
import { parseFeed } from "./rss.ts";

const RSS2 = `<?xml version="1.0"?><rss version="2.0"><channel><title>IR</title>
<item><title><![CDATA[Q3 results & outlook]]></title><link>https://ir.example.com/q3</link>
<guid isPermaLink="false">ir-2026-q3</guid><pubDate>Thu, 15 Oct 2026 06:00:00 GMT</pubDate></item>
<item><title>No guid here</title><link>https://ir.example.com/nogu</link><pubDate>garbage</pubDate></item>
</channel></rss>`;

const ATOM = `<?xml version="1.0" encoding="utf-8"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Filings</title>
<entry><title>8-K filing</title><id>urn:tag:1</id>
<link rel="self" href="https://x.example/self"/><link rel="alternate" href="https://x.example/8k"/>
<updated>2026-10-14T10:00:00Z</updated></entry>
<entry><title>Single entry no id</title><link href="https://x.example/only"/><published>2026-10-01T00:00:00Z</published></entry>
</feed>`;

Deno.test("rss: parses RSS 2.0 items, CDATA titles and guid objects, falls back to the link", () => {
  const items = parseFeed(RSS2);
  assertEquals(items.length, 2);
  assertEquals(items[0], {
    guid: "ir-2026-q3", title: "Q3 results & outlook", link: "https://ir.example.com/q3",
    published: "2026-10-15T06:00:00.000Z",
  });
  assertEquals(items[1]?.guid, "https://ir.example.com/nogu");
  assertEquals(items[1]?.published, null);
});

Deno.test("rss: parses Atom entries and prefers the alternate link", () => {
  const items = parseFeed(ATOM);
  assertEquals(items.length, 2);
  assertEquals(items[0], { guid: "urn:tag:1", title: "8-K filing", link: "https://x.example/8k", published: "2026-10-14T10:00:00.000Z" });
  assertEquals(items[1]?.link, "https://x.example/only");
  assertEquals(items[1]?.guid, "https://x.example/only");
});

Deno.test("rss: malformed or unrelated XML yields no items instead of throwing", () => {
  assertEquals(parseFeed("<html><body>not a feed</body></html>"), []);
  assertEquals(parseFeed("not xml at all"), []);
  assertEquals(parseFeed(""), []);
});
```

`search/tavily.test.ts`:

```ts
import { assert, assertEquals } from "jsr:@std/assert@1";
import { createTavilyClient } from "./tavily.ts";
import type { FetchLike } from "../llm/types.ts";

function stub(respond: () => Response) {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const fetchImpl: FetchLike = (input, init) => {
    calls.push({ url: String(input), body: JSON.parse(String(init?.body)) });
    return Promise.resolve(respond());
  };
  return { fetchImpl, calls };
}

Deno.test("tavily: posts a basic search with the documented parameters and maps results", async () => {
  const { fetchImpl, calls } = stub(() =>
    Response.json({
      results: [
        { title: "Annual report", url: "https://ir.example.com/ar", content: "Revenue grew.", published_date: "2026-03-01" },
        { title: "No date", url: "https://news.example.com/x", content: "Shares fell." },
        { title: "Broken", content: "no url" },
      ],
    }));
  const client = createTavilyClient({ apiKey: "TVLY-KEY-1", fetchImpl });
  const res = await client.search("Acme ACME annual report 2025 investor relations");
  assert(res.ok);
  assertEquals(res.results, [
    { url: "https://ir.example.com/ar", title: "Annual report", snippet: "Revenue grew.", publishedDate: "2026-03-01" },
    { url: "https://news.example.com/x", title: "No date", snippet: "Shares fell." },
  ]);
  assertEquals(calls[0]?.url, "https://api.tavily.com/search");
  assertEquals(calls[0]?.body, {
    api_key: "TVLY-KEY-1",
    query: "Acme ACME annual report 2025 investor relations",
    search_depth: "basic",
    max_results: 5,
    include_answer: false,
  });
});

Deno.test("tavily: 429 is rate_limited, 432/433 are quota, a missing key is not_configured", async () => {
  const k = (status: number) => createTavilyClient({ apiKey: "TVLY-KEY-1", fetchImpl: stub(() => new Response("x", { status })).fetchImpl });
  const a = await k(429).search("q");
  assert(!a.ok);
  assertEquals(a.kind, "rate_limited");
  const b = await k(432).search("q");
  assert(!b.ok);
  assertEquals(b.kind, "quota");
  const c = await k(433).search("q");
  assert(!c.ok);
  assertEquals(c.kind, "quota");
  const d = await k(500).search("q");
  assert(!d.ok);
  assertEquals(d.kind, "http");
  const s = stub(() => Response.json({ results: [] }));
  const none = await createTavilyClient({ fetchImpl: s.fetchImpl }).search("q");
  assert(!none.ok);
  assertEquals(none.kind, "not_configured");
  assertEquals(s.calls.length, 0);
});

Deno.test("tavily: a network failure never echoes the key", async () => {
  const fetchImpl: FetchLike = () => Promise.reject(new Error("dns failure for TVLY-KEY-1"));
  const res = await createTavilyClient({ apiKey: "TVLY-KEY-1", fetchImpl }).search("q");
  assert(!res.ok);
  assertEquals(res.kind, "network");
  assert(!res.message.includes("TVLY-KEY-1"));
});
```

- [ ] **Step 7: Run to see them fail**

Run: `deno test -A --config supabase/functions/deno.json supabase/functions/_shared/adapters/fetchers supabase/functions/_shared/adapters/search`
Expected: FAIL with `Module not found` for `jina.ts`, `edgar.ts`, `rss.ts`, `tavily.ts` (limiter, extract and direct pass).

- [ ] **Step 8: Implement `jina.ts`, `edgar.ts`, `rss.ts`, `tavily.ts`**

`fetchers/jina.ts`:

```ts
import type { FetchLike } from "../llm/types.ts";
import { publicUrlProblem } from "./direct.ts";
import { type Limiter, jinaKeylessLimiter } from "./limiter.ts";

export function readerUrl(url: string): string {
  return `https://r.jina.ai/${url}`;
}

export interface JinaOptions {
  apiKey?: string | undefined;
  fetchImpl?: FetchLike | undefined;
  signal?: AbortSignal | undefined;
  timeoutMs?: number | undefined;
  /** Upper bound on the returned text; callers apply `capText` afterwards. */
  maxChars?: number | undefined;
  limiter?: Limiter | undefined;
}

export type JinaResult =
  | { ok: true; status: number; text: string }
  | { ok: false; kind: "rate_limited" | "http" | "timeout" | "network" | "blocked"; status?: number | undefined; message: string };

/** Public URL in, markdown or text out. Header options beyond the optional bearer are UNVERIFIED and not used. */
export async function readViaJina(url: string, opts: JinaOptions = {}): Promise<JinaResult> {
  const problem = publicUrlProblem(url);
  if (problem) return { ok: false, kind: "blocked", message: problem };
  const doFetch: FetchLike = opts.fetchImpl ?? ((input, init) => fetch(input, init));
  const apiKey = opts.apiKey?.trim() ?? "";
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? 25_000);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
  const scrub = (message: string): string => (apiKey === "" ? message : message.split(apiKey).join("[redacted]"));
  const headers: Record<string, string> = { accept: "text/plain" };
  if (apiKey !== "") headers.authorization = `Bearer ${apiKey}`;
  await (opts.limiter ?? (apiKey === "" ? jinaKeylessLimiter : { take: () => Promise.resolve() })).take();
  let res: Response;
  try {
    res = await doFetch(readerUrl(url), { method: "GET", headers, signal });
  } catch (e) {
    const timedOut = signal.aborted && signal.reason instanceof DOMException && signal.reason.name === "TimeoutError";
    return timedOut
      ? { ok: false, kind: "timeout", message: "Jina Reader timed out" }
      : { ok: false, kind: "network", message: scrub(e instanceof Error ? e.message : String(e)).slice(0, 200) };
  }
  if (res.status === 429) {
    await res.body?.cancel();
    return { ok: false, kind: "rate_limited", status: 429, message: "Jina Reader rate limit" };
  }
  if (!res.ok) {
    await res.body?.cancel();
    return { ok: false, kind: "http", status: res.status, message: `Jina Reader HTTP ${res.status}` };
  }
  const text = (await res.text()).slice(0, opts.maxChars ?? 200_000);
  return { ok: true, status: res.status, text };
}
```

`fetchers/edgar.ts`:

```ts
import type { FetchLike } from "../llm/types.ts";
import { type Limiter, secLimiter } from "./limiter.ts";

export interface Filing {
  form: string;
  accession: string;
  filingDate: string;
  primaryDocument: string;
  reportDate: string | null;
}

export type EdgarResult<T> =
  | { ok: true; value: T }
  | { ok: false; kind: "not_configured" | "http" | "network"; status?: number | undefined; message: string };

export interface EdgarClient {
  resolveCik(ticker: string): Promise<EdgarResult<string | null>>;
  submissions(cik: string): Promise<EdgarResult<Filing[]>>;
  filingUrl(cik: string, accession: string, primaryDocument: string): string;
}

export interface EdgarOptions {
  userAgent?: string | undefined;
  fetchImpl?: FetchLike | undefined;
  limiter?: Limiter | undefined;
  signal?: AbortSignal | undefined;
}

const TICKERS_URL = "https://www.sec.gov/files/company_tickers.json";
const TICKER_TTL_MS = 6 * 60 * 60 * 1000;
let tickerCache: { at: number; map: Map<string, string> } | null = null;

export function resetTickerCache(): void {
  tickerCache = null;
}

export const padCik = (cik: string | number): string => String(cik).replace(/\D/g, "").padStart(10, "0");

export function createEdgarClient(opts: EdgarOptions): EdgarClient {
  const doFetch: FetchLike = opts.fetchImpl ?? ((input, init) => fetch(input, init));
  const limiter = opts.limiter ?? secLimiter;
  const userAgent = opts.userAgent?.trim() ?? "";

  async function getJson(url: string): Promise<EdgarResult<unknown>> {
    if (userAgent === "") return { ok: false, kind: "not_configured", message: "SEC_USER_AGENT is not configured" };
    await limiter.take();
    let res: Response;
    try {
      res = await doFetch(url, {
        method: "GET",
        headers: { "user-agent": userAgent, accept: "application/json" },
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
    } catch (e) {
      return { ok: false, kind: "network", message: (e instanceof Error ? e.message : String(e)).slice(0, 200) };
    }
    if (!res.ok) {
      await res.body?.cancel();
      return { ok: false, kind: "http", status: res.status, message: `EDGAR HTTP ${res.status}` };
    }
    try {
      return { ok: true, value: await res.json() };
    } catch {
      return { ok: false, kind: "http", status: res.status, message: "EDGAR returned invalid JSON" };
    }
  }

  return {
    async resolveCik(ticker) {
      const wanted = ticker.trim().toUpperCase();
      if (tickerCache === null || Date.now() - tickerCache.at > TICKER_TTL_MS) {
        const res = await getJson(TICKERS_URL);
        if (!res.ok) return res;
        const map = new Map<string, string>();
        if (res.value !== null && typeof res.value === "object") {
          for (const row of Object.values(res.value as Record<string, unknown>)) {
            const r = row as { cik_str?: number | string; ticker?: string };
            if (r.ticker && r.cik_str !== undefined) map.set(r.ticker.toUpperCase(), padCik(r.cik_str));
          }
        }
        tickerCache = { at: Date.now(), map };
      }
      return { ok: true, value: tickerCache.map.get(wanted) ?? null };
    },

    async submissions(cik) {
      const res = await getJson(`https://data.sec.gov/submissions/CIK${padCik(cik)}.json`);
      if (!res.ok) return res;
      const recent = (res.value as { filings?: { recent?: Record<string, unknown[]> } })?.filings?.recent;
      const forms = recent?.form ?? [];
      const filings: Filing[] = [];
      for (let i = 0; i < forms.length; i++) {
        const form = String(forms[i] ?? "");
        const accession = String(recent?.accessionNumber?.[i] ?? "");
        const filingDate = String(recent?.filingDate?.[i] ?? "");
        const primaryDocument = String(recent?.primaryDocument?.[i] ?? "");
        if (form === "" || accession === "" || primaryDocument === "") continue;
        const reportDate = String(recent?.reportDate?.[i] ?? "");
        filings.push({ form, accession, filingDate, primaryDocument, reportDate: reportDate === "" ? null : reportDate });
      }
      return { ok: true, value: filings };
    },

    filingUrl(cik, accession, primaryDocument) {
      return `https://www.sec.gov/Archives/edgar/data/${Number(padCik(cik))}/${accession.replaceAll("-", "")}/${primaryDocument}`;
    },
  };
}
```

`fetchers/rss.ts`:

```ts
import { XMLParser } from "npm:fast-xml-parser@5.11.2";
import type { FetchLike } from "../llm/types.ts";
import { publicUrlProblem } from "./direct.ts";

export interface FeedItem {
  guid: string;
  title: string;
  link: string;
  published: string | null;
}

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", textNodeName: "#text" });

function asArray(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function text(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number") return String(value);
  if (value !== null && typeof value === "object") return text((value as Record<string, unknown>)["#text"]);
  return "";
}

function atomLink(value: unknown): string {
  const links = asArray(value).map((l) => (l ?? {}) as Record<string, unknown>);
  if (links.length === 0) return "";
  const alternate = links.find((l) => l["@_rel"] === undefined || l["@_rel"] === "alternate") ?? links[0];
  return text(alternate?.["@_href"]) || text(alternate);
}

function isoOrNull(value: string): string | null {
  if (value === "") return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

/** RSS 2.0 and Atom. Anything else (or malformed XML) yields no items. */
export function parseFeed(xml: string): FeedItem[] {
  let doc: Record<string, any>;
  try {
    doc = parser.parse(xml) as Record<string, any>;
  } catch {
    return [];
  }
  const items: FeedItem[] = [];
  for (const raw of asArray(doc?.rss?.channel?.item)) {
    const item = (raw ?? {}) as Record<string, unknown>;
    const link = text(item.link);
    const title = text(item.title);
    items.push({
      guid: text(item.guid) || link || title,
      title,
      link,
      published: isoOrNull(text(item.pubDate) || text(item["dc:date"])),
    });
  }
  for (const raw of asArray(doc?.feed?.entry)) {
    const entry = (raw ?? {}) as Record<string, unknown>;
    const link = atomLink(entry.link);
    const title = text(entry.title);
    items.push({
      guid: text(entry.id) || link || title,
      title,
      link,
      published: isoOrNull(text(entry.published) || text(entry.updated)),
    });
  }
  return items.filter((i) => i.guid !== "");
}

export async function fetchFeed(
  url: string,
  opts: { fetchImpl?: FetchLike | undefined; signal?: AbortSignal | undefined } = {},
): Promise<{ ok: true; items: FeedItem[] } | { ok: false; message: string }> {
  const problem = publicUrlProblem(url);
  if (problem) return { ok: false, message: problem };
  const doFetch: FetchLike = opts.fetchImpl ?? ((input, init) => fetch(input, init));
  const timeout = AbortSignal.timeout(15_000);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
  try {
    const res = await doFetch(url, { headers: { accept: "application/rss+xml, application/atom+xml, application/xml, text/xml" }, signal });
    if (!res.ok) {
      await res.body?.cancel();
      return { ok: false, message: `HTTP ${res.status}` };
    }
    return { ok: true, items: parseFeed((await res.text()).slice(0, 2 * 1024 * 1024)) };
  } catch (e) {
    return { ok: false, message: (e instanceof Error ? e.message : String(e)).slice(0, 200) };
  }
}
```

`search/tavily.ts`:

```ts
import type { FetchLike } from "../llm/types.ts";

export interface SearchHit {
  url: string;
  title: string;
  snippet: string;
  publishedDate?: string | undefined;
}

export type TavilyResult =
  | { ok: true; results: SearchHit[] }
  | { ok: false; kind: "quota" | "rate_limited" | "http" | "network" | "not_configured"; status?: number | undefined; message: string };

export interface TavilyClient {
  search(query: string, signal?: AbortSignal): Promise<TavilyResult>;
}

export interface TavilyOptions {
  apiKey?: string | undefined;
  fetchImpl?: FetchLike | undefined;
}

/** One basic-depth search (1 credit). 429 is a rate limit; 432 and 433 are Tavily's plan and pay-as-you-go limits. */
export function createTavilyClient(opts: TavilyOptions): TavilyClient {
  const apiKey = opts.apiKey?.trim() ?? "";
  const doFetch: FetchLike = opts.fetchImpl ?? ((input, init) => fetch(input, init));
  return {
    async search(query, signal) {
      if (apiKey === "") return { ok: false, kind: "not_configured", message: "TAVILY_API_KEY is not set" };
      let res: Response;
      try {
        res = await doFetch("https://api.tavily.com/search", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ api_key: apiKey, query, search_depth: "basic", max_results: 5, include_answer: false }),
          ...(signal ? { signal } : {}),
        });
      } catch (e) {
        const message = (e instanceof Error ? e.message : String(e)).split(apiKey).join("[redacted]").slice(0, 200);
        return { ok: false, kind: "network", message };
      }
      if (res.status === 429) {
        await res.body?.cancel();
        return { ok: false, kind: "rate_limited", status: 429, message: "Tavily rate limit" };
      }
      if (res.status === 432 || res.status === 433) {
        await res.body?.cancel();
        return { ok: false, kind: "quota", status: res.status, message: "Tavily usage limit exceeded" };
      }
      if (!res.ok) {
        await res.body?.cancel();
        return { ok: false, kind: "http", status: res.status, message: `Tavily HTTP ${res.status}` };
      }
      let body: { results?: Record<string, unknown>[] };
      try {
        body = (await res.json()) as { results?: Record<string, unknown>[] };
      } catch {
        return { ok: false, kind: "http", status: res.status, message: "Tavily returned invalid JSON" };
      }
      const results: SearchHit[] = [];
      for (const r of body.results ?? []) {
        const url = typeof r.url === "string" ? r.url : "";
        if (url === "") continue;
        const published = typeof r.published_date === "string" ? r.published_date : typeof r.publishedDate === "string" ? r.publishedDate : undefined;
        results.push({
          url,
          title: typeof r.title === "string" ? r.title : url,
          snippet: typeof r.content === "string" ? r.content.slice(0, 500) : "",
          ...(published ? { publishedDate: published } : {}),
        });
      }
      return { ok: true, results };
    },
  };
}
```

- [ ] **Step 9: Run all adapter tests, type check and lint**

Run: `deno test -A --config supabase/functions/deno.json supabase/functions/_shared/adapters`
Expected: PASS (limiter 1, extract 4, direct 8, jina 3, edgar 4, rss 3, tavily 3, plus the Task 2 tests when present). If Deno reports leaked timers from `AbortSignal.timeout` in a test, pass `{ sanitizeOps: false, sanitizeResources: false }` to that `Deno.test` call.

Run: `bun run functions:check` then `bun run lint:fix` then `bun run lint`
Expected: exit 0. (`rss.ts` uses `Record<string, any>` for the parsed XML document; if Biome flags `noExplicitAny`, type it as `Record<string, unknown>` and narrow with the existing `asArray` and `text` helpers, or add `// biome-ignore lint/suspicious/noExplicitAny: fast-xml-parser output is untyped`.)

- [ ] **Step 10: Commit**

```text
git add supabase/functions/_shared/adapters/search supabase/functions/_shared/adapters/fetchers
git commit -m "feat(research): add Tavily, direct, Jina, EDGAR and RSS retrieval adapters with SSRF guard and SEC limiter"
```

---

### Task 4: Core `research.ts` (pure logic, Vitest)

**Files:**
- Create: `supabase/functions/_shared/core/research.ts`
- Test: `supabase/functions/_shared/core/research.test.ts`

**Interfaces:**
- Consumes: nothing at runtime (the tests read `prompt.txt` and the spec file, and import `classifyOperational` from P1's `classify.ts`).
- Produces (all pure; no `Date`, `URL`, `console`, `fetch`, randomness):
  - Constants: `PROMPT_VERSION`, `SCHEMA_VERSION`, `RESEARCH_PROMPT_TEMPLATE`, `EVIDENCE_PREAMBLE`, `STAGE1_SYSTEM`, `RESEARCH_OUTPUT_SCHEMA`, `STAGE1_OUTPUT_SCHEMA`, `ANNUAL_FORMS`, `INTERIM_FORMS`, `CURRENT_FORMS`, `WATCH_FORMS`, `FACT_TOPICS`, `CLAIM_TYPES`, `MAX_QUOTE_CHARS`.
  - Prompts: `fillResearchPrompt(vars)`, `buildStage1User(doc)`, `buildStage2User(ctx)`, `renderEvidenceEntry(entry)`, `fitEvidence(entries, maxChars)`, `renderFilingList(filings)`.
  - Retrieval planning: `dateTerms(researchDate)`, `industryKind(sector, industry)`, `industryNote(kind)`, `queryTemplates(ctx)`, `documentTier(c)`, `rankDocuments(candidates)`, `selectDocuments(ranked, opts)`, `pickFilings(filings)`, `hostOf(url)`, `isRegulatorHost(host)`, `isIrUrl(url)`.
  - Validation and rendering: `normalizeWs`, `quoteOccurs(quote, text)`, `validateStage1Facts(raw, text)`, `validateResearchOutput(raw, ledgerIds, attempt)`, `wordCount`, `stripUrls`, `dateLabel`, `renderSources(entries)`.
  - Types: `PromptVars`, `LedgerEntry`, `Stage1Fact`, `ResearchOutput`, `ValidationResult`, `RankCandidate`, `SourceKind`, `IndustryKind`, `JsonSchemaObject`.

- [ ] **Step 1: Write the failing tests `research.test.ts`**

```ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { classifyOperational } from "./classify.ts";
import {
  EVIDENCE_PREAMBLE,
  PROMPT_VERSION,
  RESEARCH_OUTPUT_SCHEMA,
  RESEARCH_PROMPT_TEMPLATE,
  SCHEMA_VERSION,
  STAGE1_SYSTEM,
  buildStage1User,
  buildStage2User,
  dateLabel,
  dateTerms,
  fillResearchPrompt,
  fitEvidence,
  industryKind,
  pickFilings,
  queryTemplates,
  quoteOccurs,
  rankDocuments,
  renderSources,
  selectDocuments,
  stripUrls,
  validateResearchOutput,
  validateStage1Facts,
  wordCount,
  type LedgerEntry,
  type RankCandidate,
  type ResearchOutput,
} from "./research.ts";

const fromRoot = (p: string) => fileURLToPath(new URL(`../../../../${p}`, import.meta.url));
const read = (p: string) => readFileSync(fromRoot(p), "utf8").replace(/\r\n/g, "\n");

/** First fenced block after `marker`; `fence` is "```" or "~~~~". */
function fenced(source: string, marker: string, lang: string, fence = "```"): string {
  const at = source.indexOf(marker);
  if (at < 0) throw new Error(`marker not found: ${marker}`);
  const open = source.indexOf(`${fence}${lang}`, at);
  const bodyStart = source.indexOf("\n", open) + 1;
  const close = source.indexOf(`\n${fence}`, bodyStart);
  return source.slice(bodyStart, close);
}

const words = (n: number) => Array.from({ length: n }, (_, i) => `word${i % 50}`).join(" ");

function validOutput(over: Partial<ResearchOutput> = {}): ResearchOutput {
  return {
    report_md: `${words(500)} [E1]`,
    summary: "It fell on a guidance cut; the verdict is positive.",
    news_reason: "Guidance cut after a weak quarter [E2].",
    conclusion: "Meets these two fundamental checks.",
    bankruptcy_risk: "Low",
    material_damage_established: false,
    sufficient_evidence: true,
    cited_evidence_ids: [2, 1],
    facts_vs_claims: [
      { section: "established_facts", items: [{ text: "Revenue fell 4%.", evidence_ids: [1] }] },
      { section: "management_claims", items: [{ text: "Management expects a recovery.", evidence_ids: [2] }] },
    ],
    missing_documents: [],
    limitations: [],
    research_cutoff_date: "2026-10-15",
    ...over,
  };
}
const LEDGER = [1, 2, 3];

const VARS = {
  companyName: "Acme Corp",
  ticker: "ACME",
  primaryExchange: "NasdaqGS",
  reportingCurrency: "USD",
  researchDate: "2026-10-15",
};

describe("verbatim prompt constants (spec 9.6, brief section 10)", () => {
  it("template equals prompt.txt lines 554-589 with the five placeholders substituted", () => {
    let expected = read("prompt.txt").split("\n").slice(553, 589).join("\n");
    for (const [from, to] of [
      ["[Company name]", "{{COMPANY_NAME}}"],
      ["[Ticker]", "{{TICKER}}"],
      ["[Exchange]", "{{PRIMARY_EXCHANGE}}"],
      ["[Currency]", "{{REPORTING_CURRENCY}}"],
      ["[Date]", "{{RESEARCH_DATE}}"],
    ] as const) {
      expect(expected).toContain(from);
      expected = expected.replace(from, to);
    }
    expect(RESEARCH_PROMPT_TEMPLATE).toBe(expected);
    expect(RESEARCH_PROMPT_TEMPLATE.startsWith("Analyze this company for a potential long-term investment.")).toBe(true);
    expect(RESEARCH_PROMPT_TEMPLATE.endsWith("Keep technical-analysis commentary outside this report.")).toBe(true);
  });

  it("template equals the text in the design spec", () => {
    const spec = read("docs/superpowers/specs/2026-10-15-stock-screener-design.md");
    expect(RESEARCH_PROMPT_TEMPLATE).toBe(fenced(spec, "Core research prompt template", "text", "~~~~").trim());
  });

  it("uses exactly the five documented placeholders", () => {
    const found = new Set(RESEARCH_PROMPT_TEMPLATE.match(/\{\{[A-Z_]+\}\}/g));
    expect([...found].sort()).toEqual(
      ["{{COMPANY_NAME}}", "{{PRIMARY_EXCHANGE}}", "{{REPORTING_CURRENCY}}", "{{RESEARCH_DATE}}", "{{TICKER}}"],
    );
  });

  it("preamble and Stage 1 prompt equal the spec; schema equals the spec JSON", () => {
    const spec = read("docs/superpowers/specs/2026-10-15-stock-screener-design.md");
    expect(EVIDENCE_PREAMBLE).toBe(fenced(spec, "Evidence preamble (system role", "text").trim());
    expect(STAGE1_SYSTEM).toBe(fenced(spec, "**Stage 1 - extraction", "text").trim());
    expect(RESEARCH_OUTPUT_SCHEMA).toEqual(JSON.parse(fenced(spec, "### 9.6.1 Output JSON schema", "json")));
  });

  it("versions are non-empty strings", () => {
    expect(PROMPT_VERSION).toMatch(/\S/);
    expect(SCHEMA_VERSION).toMatch(/\S/);
  });
});

describe("fillResearchPrompt", () => {
  it("substitutes every placeholder and leaves none behind", () => {
    const out = fillResearchPrompt(VARS);
    expect(out).toContain("**COMPANY:** Acme Corp");
    expect(out).toContain("**TICKER:** ACME");
    expect(out).toContain("**PRIMARY EXCHANGE:** NasdaqGS");
    expect(out).toContain("**REPORTING CURRENCY:** USD");
    expect(out).toContain("**RESEARCH DATE:** 2026-10-15");
    expect(out).not.toContain("{{");
  });

  it("rejects an empty variable and is safe against replacement patterns in values", () => {
    expect(() => fillResearchPrompt({ ...VARS, ticker: "  " })).toThrow(/TICKER/);
    expect(fillResearchPrompt({ ...VARS, companyName: "A $& B $1 Inc" })).toContain("**COMPANY:** A $& B $1 Inc");
  });
});

describe("queryTemplates and industry switch", () => {
  it("derives date terms", () => {
    expect(dateTerms("2026-10-15")).toEqual({ year: 2026, month: "October", fiscalYear: 2025, quarter: "Q3 2026" });
    expect(dateTerms("2026-01-10").quarter).toBe("Q4 2025");
    expect(dateTerms("2026-04-01").quarter).toBe("Q1 2026");
    expect(() => dateTerms("nonsense")).toThrow();
  });

  it("builds the six general templates", () => {
    expect(queryTemplates({ company: "Acme Corp", ticker: "ACME", researchDate: "2026-10-15", industry: "general" })).toEqual([
      "Acme Corp ACME annual report 2025 investor relations",
      "Acme Corp latest quarterly interim results Q3 2026",
      "Acme Corp shares fall reason October 2026",
      "Acme Corp debt maturities refinancing covenants liquidity",
      "Acme Corp going concern OR credit rating downgrade OR investigation OR restatement",
      "Acme Corp guidance outlook management commentary",
    ]);
  });

  it("switches terms 4 and 6 for banks and insurers", () => {
    const q = queryTemplates({ company: "First Bank", ticker: "FBK", researchDate: "2026-10-15", industry: "financial" });
    expect(q).toHaveLength(6);
    expect(q[3]).toBe("First Bank debt maturities refinancing covenants liquidity regulatory capital liquidity asset quality");
    expect(q[5]).toBe("First Bank regulatory capital liquidity asset quality regulatory disclosure");
    expect(q.every((s) => !/ {2}/.test(s))).toBe(true);
  });

  it("detects financial sectors", () => {
    expect(industryKind("Financial Services", "Banks - Regional")).toBe("financial");
    expect(industryKind("Technology", "Software")).toBe("general");
    expect(industryKind(null, "Insurance - Life")).toBe("financial");
    expect(industryKind(null, null)).toBe("general");
  });
});

describe("rankDocuments and selectDocuments", () => {
  const c = (over: Partial<RankCandidate> & { evidenceId: number }): RankCandidate => ({
    url: `https://x.example/${over.evidenceId}`,
    kind: "search_result",
    ...over,
  });
  const candidates: RankCandidate[] = [
    c({ evidenceId: 1, url: "https://news.example.com/a", publishedAt: "2026-10-10T00:00:00Z" }),
    c({ evidenceId: 2, kind: "edgar_filing", form: "8-K", filingDate: "2026-10-01", url: "https://www.sec.gov/a8k" }),
    c({ evidenceId: 3, kind: "edgar_filing", form: "10-K", filingDate: "2026-02-20", url: "https://www.sec.gov/a10k" }),
    c({ evidenceId: 4, kind: "ir_page", url: "https://investors.acme.com/q3" }),
    c({ evidenceId: 5, url: "https://www.fca.org.uk/news/x" }),
    c({ evidenceId: 6, kind: "edgar_filing", form: "10-Q", filingDate: "2026-08-01", url: "https://www.sec.gov/a10q" }),
    c({ evidenceId: 7, kind: "yahoo_news", url: "https://finance.yahoo.com/n/1", publishedAt: "2026-10-12T00:00:00Z" }),
  ];

  it("orders EDGAR annual, interim, current, then IR, regulators, independent (newest first)", () => {
    expect(rankDocuments(candidates).map((x) => x.evidenceId)).toEqual([3, 6, 2, 4, 5, 7, 1]);
  });

  it("is deterministic for any input order", () => {
    const shuffled = [...candidates].reverse();
    expect(rankDocuments(shuffled).map((x) => x.evidenceId)).toEqual(rankDocuments(candidates).map((x) => x.evidenceId));
  });

  it("takes at most 3 EDGAR filings and 8 documents overall", () => {
    const many: RankCandidate[] = [
      ...["10-K", "10-Q", "8-K", "8-K", "8-K"].map((form, i) =>
        c({ evidenceId: 10 + i, kind: "edgar_filing", form, filingDate: `2026-0${i + 1}-01`, url: `https://www.sec.gov/f${i}` })),
      ...Array.from({ length: 6 }, (_, i) => c({ evidenceId: 20 + i, url: `https://news.example.com/${i}` })),
    ];
    const picked = selectDocuments(rankDocuments(many));
    expect(picked).toHaveLength(8);
    expect(picked.filter((x) => x.kind === "edgar_filing")).toHaveLength(3);
    expect(picked.slice(0, 3).map((x) => x.form)).toEqual(["10-K", "10-Q", "8-K"]);
  });
});

describe("pickFilings", () => {
  const f = (form: string, filingDate: string, accession: string) => ({ form, filingDate, accession, primaryDocument: `${accession}.htm` });
  it("returns the latest annual, the latest interim and current reports filed since the annual", () => {
    const picked = pickFilings([
      f("8-K", "2026-10-02", "a5"), f("10-Q", "2026-08-01", "a4"), f("8-K", "2026-03-01", "a3"),
      f("10-K", "2026-02-20", "a2"), f("8-K", "2026-01-05", "a1"), f("10-K", "2025-02-20", "a0"),
    ]);
    expect(picked.annual?.accession).toBe("a2");
    expect(picked.interim?.accession).toBe("a4");
    expect(picked.current.map((x) => x.accession)).toEqual(["a5", "a3"]);
  });

  it("handles foreign filers and missing filings", () => {
    const picked = pickFilings([f("6-K", "2026-09-01", "b2"), f("20-F", "2026-04-01", "b1")]);
    expect(picked.annual?.form).toBe("20-F");
    expect(picked.interim).toBeNull();
    expect(picked.current.map((x) => x.accession)).toEqual(["b2"]);
    expect(pickFilings([])).toEqual({ annual: null, interim: null, current: [] });
  });
});

describe("quote check", () => {
  const text = "The company   reported a net\nloss of $4.2 million.\tLiquidity remains adequate.";
  it("matches after whitespace normalisation, case-sensitively", () => {
    expect(quoteOccurs("reported a net loss of $4.2 million.", text)).toBe(true);
    expect(quoteOccurs("  Liquidity   remains\nadequate. ", text)).toBe(true);
    expect(quoteOccurs("REPORTED A NET LOSS", text)).toBe(false);
    expect(quoteOccurs("net profit of $4.2 million", text)).toBe(false);
  });
  it("rejects empty quotes and quotes longer than 300 characters", () => {
    expect(quoteOccurs("   ", text)).toBe(false);
    const long = "a".repeat(301);
    expect(quoteOccurs(long, long)).toBe(false);
    expect(quoteOccurs("a".repeat(300), "a".repeat(300))).toBe(true);
  });
  it("validateStage1Facts drops facts whose quote is not in the document", () => {
    const res = validateStage1Facts(
      {
        facts: [
          { topic: "liquidity", claim: "Liquidity is adequate.", claim_type: "management_claim", quote: "Liquidity remains adequate.", where: "MD&A" },
          { topic: "going_concern", claim: "Going concern doubt.", claim_type: "established_fact", quote: "substantial doubt about going concern", where: "Note 1" },
          { topic: "bogus", claim: "x", claim_type: "established_fact", quote: "net loss", where: "" },
          { topic: "other", claim: "y", claim_type: "rumour", quote: "net loss", where: "" },
        ],
      },
      text,
    );
    expect(res.valid).toBe(true);
    expect(res.kept.map((x) => x.topic)).toEqual(["liquidity", "other"]);
    expect(res.dropped).toBe(2);
    expect(validateStage1Facts({ nothing: true }, text).valid).toBe(false);
    expect(validateStage1Facts({ facts: [] }, text)).toEqual({ valid: true, kept: [], dropped: 0 });
  });
});

describe("validateResearchOutput (spec 9.6.1 code checks)", () => {
  it("accepts a well-formed, consistent output and sorts cited ids", () => {
    const res = validateResearchOutput(validOutput(), LEDGER, 1);
    expect(res.ok).toBe(true);
    expect(res.limitations).toEqual([]);
    expect(res.output?.cited_evidence_ids).toEqual([1, 2]);
    expect(res.inconsistent).toBe(false);
  });

  it("schema failure: retry once, then invalid_json", () => {
    const bad = { ...validOutput(), conclusion: "Maybe." };
    const first = validateResearchOutput(bad, LEDGER, 1);
    expect(first.ok).toBe(false);
    expect(first.retryWith).toMatch(/schema/i);
    const second = validateResearchOutput(bad, LEDGER, 2);
    expect(second).toMatchObject({ ok: false, failure: "invalid_json" });
    expect(second.retryWith).toBeUndefined();
    expect(validateResearchOutput("nope", LEDGER, 1).ok).toBe(false);
    const { conclusion: _drop, ...missing } = validOutput();
    expect(validateResearchOutput(missing, LEDGER, 1).ok).toBe(false);
  });

  it("rejects unknown evidence ids in cited ids, fact items and [E9] markers in report_md", () => {
    for (const out of [
      validOutput({ cited_evidence_ids: [1, 9] }),
      validOutput({ facts_vs_claims: [{ section: "interpretation", items: [{ text: "x", evidence_ids: [9] }] }] }),
      validOutput({ report_md: `${words(500)} see [E9]` }),
    ]) {
      const first = validateResearchOutput(out, LEDGER, 1);
      expect(first.ok).toBe(false);
      expect(first.retryWith).toContain("E9");
      expect(validateResearchOutput(out, LEDGER, 2)).toMatchObject({ ok: false, failure: "unknown_evidence_id" });
    }
  });

  it("an established fact without evidence is retried, then dropped with a limitation", () => {
    const out = validOutput({
      facts_vs_claims: [
        { section: "established_facts", items: [{ text: "Cited.", evidence_ids: [1] }, { text: "Uncited.", evidence_ids: [] }] },
      ],
    });
    expect(validateResearchOutput(out, LEDGER, 1).ok).toBe(false);
    const second = validateResearchOutput(out, LEDGER, 2);
    expect(second.ok).toBe(true);
    expect(second.limitations).toContain("dropped_uncited_established_facts:1");
    expect(second.output?.facts_vs_claims[0]?.items.map((i) => i.text)).toEqual(["Cited."]);
  });

  it("word count outside 350-1,100 is retried, then stored with a limitation", () => {
    for (const n of [100, 1200]) {
      const out = validOutput({ report_md: `${words(n)} [E1]` });
      const first = validateResearchOutput(out, LEDGER, 1);
      expect(first.ok).toBe(false);
      expect(first.retryWith).toMatch(/500-800/);
      const second = validateResearchOutput(out, LEDGER, 2);
      expect(second.ok).toBe(true);
      expect(second.limitations[0]).toMatch(/^report_length_out_of_range:/);
    }
    expect(wordCount("## Heading\n\n- **bold** long-term plan")).toBe(4);
    const lim = (n: number) => validateResearchOutput(validOutput({ report_md: `${words(n)} [E1]` }), LEDGER, 2).limitations;
    expect(lim(348)).toHaveLength(1); // 349 words
    expect(lim(349)).toHaveLength(0); // 350 words
    expect(lim(1099)).toHaveLength(0); // 1,100 words
    expect(lim(1100)).toHaveLength(1); // 1,101 words
  });

  it("consistency rule: Meets needs sufficient evidence, no established damage and Low/Moderate risk", () => {
    const variants = [
      validOutput({ sufficient_evidence: false }),
      validOutput({ material_damage_established: true }),
      validOutput({ bankruptcy_risk: "High" }),
      validOutput({ bankruptcy_risk: "Unclear" }),
    ];
    for (const out of variants) {
      const first = validateResearchOutput(out, LEDGER, 1);
      expect(first.ok).toBe(false);
      expect(first.retryWith).toMatch(/Reconcile/);
      const second = validateResearchOutput(out, LEDGER, 2);
      expect(second.ok).toBe(true);
      expect(second.inconsistent).toBe(true);
      expect(second.limitations).toContain("inconsistent_output");
      expect(second.output?.conclusion).toBe("Meets these two fundamental checks.");
      const facts = {
        status: "complete" as const,
        conclusion: out.conclusion,
        bankruptcyRisk: out.bankruptcy_risk,
        materialDamageEstablished: out.material_damage_established,
        sufficientEvidence: out.sufficient_evidence,
      };
      expect(classifyOperational(facts).category).not.toBe("green");
    }
  });

  it("conclusion and bankruptcy risk are stored independently (never derived from each other)", () => {
    const out = validOutput({ conclusion: "Does not meet one or both checks.", bankruptcy_risk: "Low", material_damage_established: true });
    const res = validateResearchOutput(out, LEDGER, 1);
    expect(res.ok).toBe(true);
    expect(res.output?.conclusion).toBe("Does not meet one or both checks.");
    expect(res.output?.bankruptcy_risk).toBe("Low");
    expect(res.limitations).toEqual([]);
  });

  it("combines every retryable problem into one feedback message", () => {
    const out = validOutput({ report_md: `${words(50)} [E1]`, sufficient_evidence: false, cited_evidence_ids: [1, 8] });
    const first = validateResearchOutput(out, LEDGER, 1);
    expect(first.retryWith).toContain("E8");
    expect(first.retryWith).toMatch(/500-800/);
    expect(first.retryWith).toMatch(/Reconcile/);
  });

  it("strips URLs typed by the model from every text field", () => {
    const out = validOutput({
      report_md: `${words(500)} see https://evil.example/x?a=1 and www.evil.example/y [E1]`,
      summary: "Details at http://evil.example",
      facts_vs_claims: [{ section: "interpretation", items: [{ text: "Source: https://evil.example/z", evidence_ids: [1] }] }],
    });
    const res = validateResearchOutput(out, LEDGER, 1);
    expect(res.ok).toBe(true);
    const serialized = JSON.stringify(res.output);
    expect(serialized).not.toMatch(/https?:\/\//);
    expect(serialized).not.toContain("www.evil");
    expect(res.output?.report_md).toContain("[link removed]");
    expect(stripUrls("a https://x.example/p?q=1) b")).toBe("a [link removed]) b");
  });
});

describe("renderSources", () => {
  const entry = (over: Partial<LedgerEntry> & { evidenceId: number }): LedgerEntry => ({
    url: `https://s.example/${over.evidenceId}`, title: `Doc ${over.evidenceId}`, publisher: "Pub", kind: "other",
    publishedAt: null, filingDate: null, retrievedAt: "2026-10-15T08:00:00Z", verification: "ok", facts: [], ...over,
  });

  it("renders only ledger rows, in evidence order, with a date label per source", () => {
    const md = renderSources([
      entry({ evidenceId: 3, kind: "search_result", publishedAt: "2026-09-01T00:00:00Z", title: "Search [hit]" }),
      entry({ evidenceId: 1, kind: "edgar_filing", filingDate: "2026-02-20", publisher: "SEC EDGAR", title: "10-K" }),
      entry({ evidenceId: 2, kind: "rss", publishedAt: "2026-10-01T10:00:00Z", publisher: null }),
      entry({ evidenceId: 4 }),
    ]);
    const lines = md.split("\n").filter((l) => l.startsWith("- "));
    expect(md.startsWith("## Sources")).toBe(true);
    expect(lines).toEqual([
      "- [E1] [10-K](https://s.example/1) - SEC EDGAR - filing date 2026-02-20",
      "- [E2] [Doc 2](https://s.example/2) - publisher not available - published 2026-10-01",
      "- [E3] [Search (hit)](https://s.example/3) - Pub - date as reported by search 2026-09-01",
      "- [E4] [Doc 4](https://s.example/4) - Pub - date not available",
    ]);
    expect(renderSources([])).toContain("No sources");
  });

  it("dateLabel never presents a page age as a publication date", () => {
    expect(dateLabel({ kind: "ir_page", publishedAt: null, filingDate: null })).toBe("date not available");
  });
});

describe("prompt builders", () => {
  const e = (id: number, facts: LedgerEntry["facts"] = []): LedgerEntry => ({
    evidenceId: id, url: `https://s.example/${id}`, title: `Title "${id}"`, publisher: "P", kind: "edgar_filing",
    publishedAt: null, filingDate: "2026-02-20", retrievedAt: "2026-10-15T08:00:00Z", verification: "ok", facts,
  });
  const fact = { topic: "liquidity" as const, claim: "Cash is $1B.", claim_type: "established_fact" as const, quote: "cash of $1 billion", where: "p.3" };

  it("buildStage1User carries the metadata and the capped text", () => {
    const u = buildStage1User({ evidenceId: 3, title: "10-K 2025", kind: "edgar_filing", dateLabel: "filing date 2026-02-20", url: "https://s.example/3", text: "BODY TEXT" });
    expect(u).toContain("evidence_id: E3");
    expect(u).toContain("title: 10-K 2025");
    expect(u).toContain("date: filing date 2026-02-20");
    expect(u.endsWith("BODY TEXT")).toBe(true);
  });

  it("buildStage2User follows spec 9.6: prompt, cutoff, industry, deterministic data, ledger, missing", () => {
    const u = buildStage2User({
      vars: VARS,
      industryNote: "bank/insurer: use regulatory capital, liquidity, asset quality",
      deterministicData: "- 10-K filed 2026-02-20",
      shown: [e(1, [fact]), e(2)],
      missing: ["Latest quarterly report: not retrieved"],
    });
    expect(u.startsWith("Analyze this company")).toBe(true);
    expect(u).toContain("RESEARCH CUTOFF DATE: 2026-10-15  (state this date in research_cutoff_date)");
    expect(u).toContain("INDUSTRY GUIDANCE: bank/insurer");
    expect(u).toContain("DETERMINISTIC DATA (from EDGAR, may be empty): - 10-K filed 2026-02-20");
    expect(u).toContain('[E1] kind=edgar_filing title="Title \'1\'" date=filing date 2026-02-20 retrieved=2026-10-15T08:00:00Z');
    expect(u).toContain('facts: - (established_fact) Cash is $1B.  | quote: "cash of $1 billion"');
    expect(u).toContain("MISSING OR FAILED RETRIEVALS: Latest quarterly report: not retrieved");
    expect(u).not.toContain("{{");
  });

  it("buildStage2User states empty inputs explicitly and appends correction feedback", () => {
    const u = buildStage2User({ vars: VARS, industryNote: "n", deterministicData: " ", shown: [], missing: [], feedback: "Cite only E1." });
    expect(u).toContain("DETERMINISTIC DATA (from EDGAR, may be empty): none");
    expect(u).toContain("no evidence items were obtained");
    expect(u).toContain("MISSING OR FAILED RETRIEVALS: none");
    expect(u.endsWith("CORRECTION REQUIRED: Cite only E1.")).toBe(true);
  });

  it("fitEvidence keeps the evidence block inside the character budget and reports what it omitted", () => {
    const big = { ...fact, claim: "c".repeat(400) };
    const entries = Array.from({ length: 10 }, (_, i) => e(i + 1, [big, big, big]));
    const { shown, omitted } = fitEvidence(entries, 3000);
    expect(shown.length).toBeGreaterThan(0);
    expect(shown.length + omitted.length).toBe(10);
    expect(shown.map((x) => x.evidenceId)).toEqual([...shown.map((x) => x.evidenceId)].sort((a, b) => a - b));
    const all = fitEvidence(entries.slice(0, 1), 48_000);
    expect(all.omitted).toEqual([]);
    expect(all.shown[0]?.facts).toHaveLength(3);
  });
});
```

- [ ] **Step 2: Run to see the tests fail**

Run: `bun run test:core -- research`
Expected: FAIL with `Failed to resolve import "./research.ts"`.

- [ ] **Step 3: Implement `research.ts`**

The three prompt constants and the schema are inserted verbatim from the spec (`.trim()` removes the leading and trailing newline of each template literal). Do not retype them: copy lines 2615-2620 (Stage 1 prompt), 2630-2636 (preamble), 2642-2677 (core prompt) and 2726-2747 (schema) of `docs/superpowers/specs/2026-10-15-stock-screener-design.md`; the tests in Step 1 compare against the spec and against `prompt.txt`.

```ts
// supabase/functions/_shared/core/research.ts
// Pure research-pipeline logic (spec section 9). No Date, URL, console, fetch or randomness (core purity guard).

/** Bump whenever the preamble, the Stage 1 prompt, the schema or the query templates change (spec 9.12). */
export const PROMPT_VERSION = "2026-10-15.1";
export const SCHEMA_VERSION = "research-output-1";

export const ANNUAL_FORMS: readonly string[] = ["10-K", "20-F", "40-F"];
export const INTERIM_FORMS: readonly string[] = ["10-Q"];
export const CURRENT_FORMS: readonly string[] = ["8-K", "6-K"];
/** Forms whose appearance counts as new information for the material-change monitor (spec 9.7). */
export const WATCH_FORMS: readonly string[] = ["8-K", "6-K", "10-Q", "10-K", "20-F", "40-F", "NT 10-K", "NT 10-Q"];
export const MAX_QUOTE_CHARS = 300;
export const REPORT_WORDS_MIN = 350;
export const REPORT_WORDS_MAX = 1100;
export const STAGE2_EVIDENCE_MAX_CHARS = 48_000;

export interface JsonSchemaObject {
  type: "object";
  properties: Record<string, unknown>;
  required: string[];
  additionalProperties: false;
}

/** Stage 1 system prompt (spec 9.6, fixed prefix). */
export const STAGE1_SYSTEM = `
You extract facts from ONE document for an investment research file. You have no other knowledge and no web access.
Return JSON matching the schema. For every fact give: topic (decline_reason, liquidity, debt_maturity, refinancing, covenant,
dilution, going_concern, auditor, regulatory_capital, asset_quality, guidance, litigation, ratings, other), claim (one sentence),
claim_type (established_fact | management_claim | forecast | allegation | interpretation), quote (a VERBATIM substring of the
document, at most 300 characters), and where (section or page if visible). Do not paraphrase inside quote. Do not infer facts that
are not stated. If the document contains nothing relevant, return an empty facts array.
`.trim();

/** Evidence preamble, Stage 2 system role (spec 9.6). */
export const EVIDENCE_PREAMBLE = `
You are the writing stage of a research pipeline. All web research and document reading has ALREADY been done by software; you
have no web access. Every fact you use MUST come from the EVIDENCE items below and MUST be cited by its id like [E3]. Where the
instructions below say "use current web research" or "read the latest report", treat the EVIDENCE items as the result of that work;
if a document the instructions ask for is not present, say so in missing_documents and treat the evidence as incomplete. Never
invent URLs, figures, documents or quotations. Separate established facts, management claims, forecasts, allegations and your own
interpretation in facts_vs_claims. Bankruptcy risk is a qualitative judgement. Do not discuss technical analysis or price charts.
Return JSON that matches the supplied schema. report_md must be about 500-800 words, written for a beginner.
`.trim();

/** Core research prompt of brief section 10, unchanged except for the five placeholders (spec 9.6). */
export const RESEARCH_PROMPT_TEMPLATE = `
Analyze this company for a potential long-term investment.

**COMPANY:** {{COMPANY_NAME}}

**TICKER:** {{TICKER}}

**PRIMARY EXCHANGE:** {{PRIMARY_EXCHANGE}}

**REPORTING CURRENCY:** {{REPORTING_CURRENCY}}

**RESEARCH DATE:** {{RESEARCH_DATE}}

My strategy identifies stocks whose prices have fallen substantially below their historical trend. I assess the technical entry separately. Your job is to investigate the business objectively and answer two questions:

1. Is the stock falling for temporary reasons, or because of lasting damage to the business?
2. Is the company at risk of bankruptcy, or financially strong enough to survive its current problems?

Use current web research. Read the latest available annual report and quarterly or interim report, including relevant financial-statement notes. Check subsequent earnings releases, material announcements, and reliable reporting about the reasons for the decline. Prioritize regulatory filings, the company's investor-relations materials, and credible independent reporting. Treat management's expectations as claims to evaluate.

Use measures appropriate to the industry. For banks and insurers, for example, examine regulatory capital, liquidity, asset quality, and relevant industry disclosures rather than applying ordinary corporate debt ratios mechanically. Explain whether financial distress could seriously damage existing shareholders even if the company avoids bankruptcy.

Assess bankruptcy risk as Low, Moderate, High, or Unclear. This is a qualitative judgment, not a calculated probability. Explain the evidence and limitations.

**OUTPUT FORMAT**

Write for a beginner. Explain unfamiliar terms briefly. Keep the main report to approximately 500–800 words, with sources listed separately.

Finish with one classification:

- Meets these two fundamental checks.
- Does not meet one or both checks.
- Insufficient evidence to decide.

Explain that classification in two or three simple sentences.

Keep technical-analysis commentary outside this report.
`.trim();

/** Stage 2 output JSON schema (spec 9.6.1), verbatim. */
export const RESEARCH_OUTPUT_SCHEMA: JsonSchemaObject = {
  "type": "object",
  "additionalProperties": false,
  "required": ["report_md","summary","news_reason","conclusion","bankruptcy_risk","material_damage_established","sufficient_evidence","cited_evidence_ids","facts_vs_claims","missing_documents","limitations","research_cutoff_date"],
  "properties": {
    "report_md": { "type": "string" },
    "summary": { "type": "string" },
    "news_reason": { "type": "string" },
    "conclusion": { "type": "string", "enum": ["Meets these two fundamental checks.", "Does not meet one or both checks.", "Insufficient evidence to decide."] },
    "bankruptcy_risk": { "type": "string", "enum": ["Low", "Moderate", "High", "Unclear"] },
    "material_damage_established": { "type": "boolean" },
    "sufficient_evidence": { "type": "boolean" },
    "cited_evidence_ids": { "type": "array", "items": { "type": "integer" } },
    "facts_vs_claims": { "type": "array", "items": { "type": "object", "additionalProperties": false, "required": ["section","items"],
      "properties": { "section": { "type": "string", "enum": ["established_facts","management_claims","forecasts","allegations","interpretation"] },
        "items": { "type": "array", "items": { "type": "object", "additionalProperties": false, "required": ["text","evidence_ids"],
          "properties": { "text": { "type": "string" }, "evidence_ids": { "type": "array", "items": { "type": "integer" } } } } } } } },
    "missing_documents": { "type": "array", "items": { "type": "string" } },
    "limitations": { "type": "array", "items": { "type": "string" } },
    "research_cutoff_date": { "type": "string" }
  }
}
;

export const FACT_TOPICS = [
  "decline_reason", "liquidity", "debt_maturity", "refinancing", "covenant", "dilution", "going_concern",
  "auditor", "regulatory_capital", "asset_quality", "guidance", "litigation", "ratings", "other",
] as const;
export type FactTopic = (typeof FACT_TOPICS)[number];

export const CLAIM_TYPES = ["established_fact", "management_claim", "forecast", "allegation", "interpretation"] as const;
export type ClaimType = (typeof CLAIM_TYPES)[number];

/** Stage 1 output schema: one object with a `facts` array (spec 9.6). */
export const STAGE1_OUTPUT_SCHEMA: JsonSchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["facts"],
  properties: {
    facts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["topic", "claim", "claim_type", "quote", "where"],
        properties: {
          topic: { type: "string", enum: [...FACT_TOPICS] },
          claim: { type: "string" },
          claim_type: { type: "string", enum: [...CLAIM_TYPES] },
          quote: { type: "string" },
          where: { type: "string" },
        },
      },
    },
  },
};

export type SourceKind = "edgar_filing" | "ir_page" | "rss" | "yahoo_news" | "search_result" | "other";
export type ResearchConclusion =
  | "Meets these two fundamental checks."
  | "Does not meet one or both checks."
  | "Insufficient evidence to decide.";
export type ResearchBankruptcyRisk = "Low" | "Moderate" | "High" | "Unclear";
export type ClaimSection = "established_facts" | "management_claims" | "forecasts" | "allegations" | "interpretation";

export interface Stage1Fact {
  topic: FactTopic;
  claim: string;
  claim_type: ClaimType;
  quote: string;
  where: string;
}

export interface LedgerEntry {
  evidenceId: number;
  url: string;
  title: string | null;
  publisher: string | null;
  kind: SourceKind;
  publishedAt: string | null;
  filingDate: string | null;
  retrievedAt: string | null;
  verification: "pending" | "ok" | "failed" | "skipped";
  facts: Stage1Fact[];
}

export interface PromptVars {
  companyName: string;
  ticker: string;
  primaryExchange: string;
  reportingCurrency: string;
  researchDate: string;
}

export interface ResearchOutput {
  report_md: string;
  summary: string;
  news_reason: string;
  conclusion: ResearchConclusion;
  bankruptcy_risk: ResearchBankruptcyRisk;
  material_damage_established: boolean;
  sufficient_evidence: boolean;
  cited_evidence_ids: number[];
  facts_vs_claims: { section: ClaimSection; items: { text: string; evidence_ids: number[] }[] }[];
  missing_documents: string[];
  limitations: string[];
  research_cutoff_date: string;
}

// ---------------------------------------------------------------- prompts

/** Fills the five placeholders in a single pass (values are never re-scanned and `$` patterns are inert). */
export function fillResearchPrompt(vars: PromptVars): string {
  const values: Record<string, string> = {
    "{{COMPANY_NAME}}": vars.companyName,
    "{{TICKER}}": vars.ticker,
    "{{PRIMARY_EXCHANGE}}": vars.primaryExchange,
    "{{REPORTING_CURRENCY}}": vars.reportingCurrency,
    "{{RESEARCH_DATE}}": vars.researchDate,
  };
  return RESEARCH_PROMPT_TEMPLATE.replace(/\{\{[A-Z_]+\}\}/g, (token) => {
    const value = values[token]?.trim();
    if (value === undefined) throw new Error(`unknown placeholder ${token}`);
    if (value === "") throw new Error(`research prompt variable for ${token} is empty`);
    return value;
  });
}

const oneLine = (s: string): string => s.replace(/\s+/g, " ").replace(/"/g, "'").trim();

export function dateLabel(e: Pick<LedgerEntry, "kind" | "publishedAt" | "filingDate">): string {
  if (e.filingDate) return `filing date ${e.filingDate.slice(0, 10)}`;
  if (e.publishedAt) {
    const day = e.publishedAt.slice(0, 10);
    return e.kind === "search_result" ? `date as reported by search ${day}` : `published ${day}`;
  }
  return "date not available";
}

export interface Stage1Doc {
  evidenceId: number;
  title: string | null;
  kind: SourceKind;
  dateLabel: string;
  url: string;
  text: string;
}

export function buildStage1User(doc: Stage1Doc): string {
  return [
    "DOCUMENT METADATA",
    `evidence_id: E${doc.evidenceId}`,
    `title: ${oneLine(doc.title ?? doc.url)}`,
    `kind: ${doc.kind}`,
    `date: ${doc.dateLabel}`,
    `url: ${doc.url}`,
    "DOCUMENT TEXT:",
    doc.text,
  ].join("\n");
}

export function renderEvidenceEntry(e: LedgerEntry): string {
  const head = `[E${e.evidenceId}] kind=${e.kind} title="${oneLine(e.title ?? e.url)}" date=${dateLabel(e)} retrieved=${e.retrievedAt ?? "not retrieved"}`;
  const lines = e.facts.map((f) => `- (${f.claim_type}) ${oneLine(f.claim)}  | quote: "${oneLine(f.quote)}"`);
  if (lines.length === 0) return `${head}\n     facts: (no facts extracted; headline only)`;
  return [head, `     facts: ${lines[0]}`, ...lines.slice(1).map((l) => `            ${l}`)].join("\n");
}

/** Keeps the evidence block inside the character budget; entries that do not fit are reported as omitted. */
export function fitEvidence(
  entries: readonly LedgerEntry[],
  maxChars = STAGE2_EVIDENCE_MAX_CHARS,
): { shown: LedgerEntry[]; omitted: number[] } {
  const shown: LedgerEntry[] = [];
  const omitted: number[] = [];
  let used = 0;
  for (const entry of entries) {
    const min = entry.facts.length === 0 ? 0 : 1;
    let placed = false;
    for (let keep = entry.facts.length; keep >= min; keep--) {
      const candidate = keep === entry.facts.length ? entry : { ...entry, facts: entry.facts.slice(0, keep) };
      const size = renderEvidenceEntry(candidate).length + 1;
      if (used + size <= maxChars) {
        shown.push(candidate);
        used += size;
        placed = true;
        break;
      }
    }
    if (!placed) omitted.push(entry.evidenceId);
  }
  return { shown, omitted };
}

export interface Stage2Context {
  vars: PromptVars;
  industryNote: string;
  deterministicData: string;
  shown: readonly LedgerEntry[];
  missing: readonly string[];
  feedback?: string | undefined;
}

/** Stage 2 user message exactly as spec 9.6: core prompt, cutoff, industry, deterministic data, ledger, missing. */
export function buildStage2User(ctx: Stage2Context): string {
  const data = ctx.deterministicData.trim();
  const lines = [
    fillResearchPrompt(ctx.vars),
    "",
    `RESEARCH CUTOFF DATE: ${ctx.vars.researchDate}  (state this date in research_cutoff_date)`,
    `INDUSTRY GUIDANCE: ${ctx.industryNote}`,
    `DETERMINISTIC DATA (from EDGAR, may be empty): ${data === "" ? "none" : data}`,
    "EVIDENCE:",
    ...(ctx.shown.length === 0 ? ["(no evidence items were obtained)"] : ctx.shown.map(renderEvidenceEntry)),
    `MISSING OR FAILED RETRIEVALS: ${ctx.missing.length === 0 ? "none" : ctx.missing.join("; ")}`,
  ];
  if (ctx.feedback && ctx.feedback.trim() !== "") lines.push("", `CORRECTION REQUIRED: ${ctx.feedback.trim()}`);
  return lines.join("\n");
}

// ---------------------------------------------------------------- retrieval planning

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export function dateTerms(researchDate: string): { year: number; month: string; fiscalYear: number; quarter: string } {
  const year = Number(researchDate.slice(0, 4));
  const monthIndex = Number(researchDate.slice(5, 7));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(researchDate) || monthIndex < 1 || monthIndex > 12) {
    throw new Error(`invalid research date ${researchDate}`);
  }
  const currentQuarter = Math.ceil(monthIndex / 3);
  const quarter = currentQuarter === 1 ? `Q4 ${year - 1}` : `Q${currentQuarter - 1} ${year}`;
  return { year, month: MONTHS[monthIndex - 1] ?? "", fiscalYear: year - 1, quarter };
}

export type IndustryKind = "financial" | "general";

export function industryKind(sector: string | null | undefined, industry?: string | null): IndustryKind {
  return /financial|bank|insur/i.test(`${sector ?? ""} ${industry ?? ""}`) ? "financial" : "general";
}

export function industryNote(kind: IndustryKind): string {
  return kind === "financial"
    ? "bank/insurer: use regulatory capital, liquidity, asset quality"
    : "operating company: use liquidity, debt maturities, refinancing needs, covenants and cash generation";
}

export interface QueryContext {
  company: string;
  ticker: string;
  researchDate: string;
  industry: IndustryKind;
}

const clean = (s: string): string => s.replace(/\s+/g, " ").trim();

/** The six deterministic query templates of spec 9.3. */
export function queryTemplates(ctx: QueryContext): string[] {
  const t = dateTerms(ctx.researchDate);
  const terms = ctx.industry === "financial" ? "regulatory capital liquidity asset quality" : "";
  return [
    `${ctx.company} ${ctx.ticker} annual report ${t.fiscalYear} investor relations`,
    `${ctx.company} latest quarterly interim results ${t.quarter}`,
    `${ctx.company} shares fall reason ${t.month} ${t.year}`,
    `${ctx.company} debt maturities refinancing covenants liquidity ${terms}`,
    `${ctx.company} going concern OR credit rating downgrade OR investigation OR restatement`,
    ctx.industry === "financial"
      ? `${ctx.company} ${terms} regulatory disclosure`
      : `${ctx.company} guidance outlook management commentary`,
  ].map(clean);
}

export interface RankCandidate {
  evidenceId: number;
  url: string;
  kind: SourceKind;
  form?: string | null | undefined;
  publishedAt?: string | null | undefined;
  filingDate?: string | null | undefined;
}

export function hostOf(url: string): string {
  const match = /^[a-z][a-z0-9+.-]*:\/\/([^/?#:]+)/i.exec(url.trim());
  return (match?.[1] ?? "").toLowerCase();
}

const REGULATOR_HOST =
  /(^|\.)(sec\.gov|fca\.org\.uk|esma\.europa\.eu|ecb\.europa\.eu|eba\.europa\.eu|eiopa\.europa\.eu|bafin\.de|fdic\.gov|federalreserve\.gov|occ\.gov|edinet-fsa\.go\.jp)$|\.gov$|\.gov\.[a-z]{2}$/;

export function isRegulatorHost(host: string): boolean {
  return REGULATOR_HOST.test(host.toLowerCase());
}

export function isIrUrl(url: string): boolean {
  const host = hostOf(url);
  if (/^(investor|investors|ir)\./.test(host)) return true;
  return /\/(investors?|ir)(\/|$)/i.test(url.replace(/^[a-z]+:\/\/[^/]+/i, ""));
}

const inForms = (forms: readonly string[], form: string | null | undefined): boolean =>
  forms.includes((form ?? "").toUpperCase());

/** 0 EDGAR annual, 1 EDGAR interim, 2 EDGAR current, 3 company IR, 4 regulators, 5 independent (spec 9.3). */
export function documentTier(c: RankCandidate): number {
  if (c.kind === "edgar_filing") {
    if (inForms(ANNUAL_FORMS, c.form)) return 0;
    if (inForms(INTERIM_FORMS, c.form)) return 1;
    if (inForms(CURRENT_FORMS, c.form)) return 2;
    return 5;
  }
  if (c.kind === "ir_page" || c.kind === "rss" || isIrUrl(c.url)) return 3;
  if (isRegulatorHost(hostOf(c.url))) return 4;
  return 5;
}

const dayOf = (c: RankCandidate): string => (c.filingDate ?? c.publishedAt ?? "").slice(0, 10);

export function rankDocuments<T extends RankCandidate>(candidates: readonly T[]): T[] {
  return [...candidates].sort((a, b) => {
    const ta = documentTier(a);
    const tb = documentTier(b);
    if (ta !== tb) return ta - tb;
    const da = dayOf(a);
    const db = dayOf(b);
    if (da !== db) return da > db ? -1 : 1;
    return a.url < b.url ? -1 : a.url > b.url ? 1 : a.evidenceId - b.evidenceId;
  });
}

/** At most `max` documents (default 8), of which at most `edgarMax` (default 3) are EDGAR filings. */
export function selectDocuments<T extends RankCandidate>(
  ranked: readonly T[],
  opts: { max?: number; edgarMax?: number } = {},
): T[] {
  const max = opts.max ?? 8;
  const edgarMax = opts.edgarMax ?? 3;
  const picked: T[] = [];
  let edgar = 0;
  for (const c of ranked) {
    if (picked.length >= max) break;
    if (c.kind === "edgar_filing") {
      if (edgar >= edgarMax) continue;
      edgar++;
    }
    picked.push(c);
  }
  return picked;
}

export interface FilingLike {
  form: string;
  accession: string;
  filingDate: string;
  primaryDocument: string;
}

const byFilingDateDesc = (a: FilingLike, b: FilingLike): number =>
  a.filingDate !== b.filingDate ? (a.filingDate > b.filingDate ? -1 : 1) : a.accession < b.accession ? 1 : -1;

/** Latest annual, latest interim and up to 3 current reports filed after the annual (spec 9.3, 9.10 prefetch). */
export function pickFilings<T extends FilingLike>(filings: readonly T[]): { annual: T | null; interim: T | null; current: T[] } {
  const sorted = [...filings].sort(byFilingDateDesc);
  const annual = sorted.find((f) => inForms(ANNUAL_FORMS, f.form)) ?? null;
  const interim = sorted.find((f) => inForms(INTERIM_FORMS, f.form)) ?? null;
  const since = annual?.filingDate ?? "";
  const current = sorted.filter((f) => inForms(CURRENT_FORMS, f.form) && f.filingDate > since).slice(0, 3);
  return { annual, interim, current };
}

export function renderFilingList(filings: readonly FilingLike[], limit = 12): string {
  return [...filings]
    .sort(byFilingDateDesc)
    .slice(0, limit)
    .map((f) => `- ${f.form} filed ${f.filingDate} (accession ${f.accession})`)
    .join("\n");
}

// ---------------------------------------------------------------- validation

export function normalizeWs(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** A quote is valid when it is <= 300 characters and occurs in the text after whitespace normalisation. */
export function quoteOccurs(quote: string, text: string): boolean {
  const q = normalizeWs(quote);
  if (q === "" || q.length > MAX_QUOTE_CHARS) return false;
  return normalizeWs(text).includes(q);
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const oneOf = <T extends string>(list: readonly T[], v: unknown): v is T =>
  typeof v === "string" && (list as readonly string[]).includes(v);

export interface Stage1Validation {
  valid: boolean;
  kept: Stage1Fact[];
  dropped: number;
}

/** Keeps only facts with a verbatim quote; an unknown topic becomes `other`, an unknown claim type drops the fact. */
export function validateStage1Facts(raw: unknown, docText: string): Stage1Validation {
  if (!isObj(raw) || !Array.isArray(raw.facts)) return { valid: false, kept: [], dropped: 0 };
  const normalized = normalizeWs(docText);
  const kept: Stage1Fact[] = [];
  let dropped = 0;
  for (const item of raw.facts) {
    if (!isObj(item)) {
      dropped++;
      continue;
    }
    const claim = typeof item.claim === "string" ? item.claim.trim() : "";
    const quote = typeof item.quote === "string" ? normalizeWs(item.quote) : "";
    if (claim === "" || !oneOf(CLAIM_TYPES, item.claim_type)) {
      dropped++;
      continue;
    }
    if (quote === "" || quote.length > MAX_QUOTE_CHARS || !normalized.includes(quote)) {
      dropped++;
      continue;
    }
    kept.push({
      topic: oneOf(FACT_TOPICS, item.topic) ? item.topic : "other",
      claim,
      claim_type: item.claim_type,
      quote,
      where: typeof item.where === "string" ? item.where.trim() : "",
    });
  }
  return { valid: true, kept, dropped };
}

export function wordCount(markdown: string): number {
  return markdown.split(/\s+/).filter((token) => /[\p{L}\p{N}]/u.test(token)).length;
}

/** URLs typed by the model are discarded; our code renders URLs from the ledger (spec 9.5 rule 1). */
export function stripUrls(text: string): string {
  return text
    .replace(/\bhttps?:\/\/[^\s)\]>"'<]+/gi, "[link removed]")
    .replace(/\bwww\.[^\s)\]>"'<]+/gi, "[link removed]");
}

const CONCLUSIONS = [
  "Meets these two fundamental checks.",
  "Does not meet one or both checks.",
  "Insufficient evidence to decide.",
] as const;
const RISKS = ["Low", "Moderate", "High", "Unclear"] as const;
const SECTIONS = ["established_facts", "management_claims", "forecasts", "allegations", "interpretation"] as const;
const OUTPUT_KEYS = [
  "report_md", "summary", "news_reason", "conclusion", "bankruptcy_risk", "material_damage_established",
  "sufficient_evidence", "cited_evidence_ids", "facts_vs_claims", "missing_documents", "limitations", "research_cutoff_date",
];

const isIdList = (v: unknown): v is number[] => Array.isArray(v) && v.every((n) => Number.isInteger(n) && n > 0);
const isStringList = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === "string");

function checkShape(raw: unknown): string[] {
  if (!isObj(raw)) return ["the output is not a JSON object"];
  const errs: string[] = [];
  for (const key of ["report_md", "summary", "news_reason"]) {
    if (typeof raw[key] !== "string") errs.push(`${key} must be a string`);
  }
  if (!oneOf(CONCLUSIONS, raw.conclusion)) errs.push("conclusion must be one of the three exact strings");
  if (!oneOf(RISKS, raw.bankruptcy_risk)) errs.push("bankruptcy_risk must be Low, Moderate, High or Unclear");
  for (const key of ["material_damage_established", "sufficient_evidence"]) {
    if (typeof raw[key] !== "boolean") errs.push(`${key} must be a boolean`);
  }
  if (!isIdList(raw.cited_evidence_ids)) errs.push("cited_evidence_ids must be an array of positive integers");
  if (!Array.isArray(raw.facts_vs_claims)) {
    errs.push("facts_vs_claims must be an array");
  } else {
    for (const group of raw.facts_vs_claims) {
      if (!isObj(group) || !oneOf(SECTIONS, group.section) || !Array.isArray(group.items)) {
        errs.push("each facts_vs_claims entry needs a valid section and an items array");
        continue;
      }
      for (const item of group.items) {
        if (!isObj(item) || typeof item.text !== "string" || !isIdList(item.evidence_ids)) {
          errs.push("each facts_vs_claims item needs text and evidence_ids");
        }
      }
    }
  }
  if (!isStringList(raw.missing_documents)) errs.push("missing_documents must be an array of strings");
  if (!isStringList(raw.limitations)) errs.push("limitations must be an array of strings");
  if (typeof raw.research_cutoff_date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(raw.research_cutoff_date)) {
    errs.push("research_cutoff_date must be YYYY-MM-DD");
  }
  for (const key of Object.keys(raw)) {
    if (!OUTPUT_KEYS.includes(key)) errs.push(`unexpected property ${key}`);
  }
  return errs;
}

export interface ValidationResult {
  ok: boolean;
  /** The sanitised output (URLs stripped, ids sorted, uncited established facts dropped) when `ok`. */
  output: ResearchOutput | null;
  /** Feedback for the one allowed retry (attempt 1 only). */
  retryWith?: string;
  /** Terminal failure code when `ok` is false and no retry is left. */
  failure?: "invalid_json" | "unknown_evidence_id";
  /** Limitation codes added by the validator (the handler merges them with the model's own). */
  limitations: string[];
  inconsistent: boolean;
}

const fail = (extra: Pick<ValidationResult, "retryWith" | "failure">): ValidationResult => ({
  ok: false,
  output: null,
  limitations: [],
  inconsistent: false,
  ...extra,
});

/**
 * The code-check table of spec 9.6.1. Attempt 1 collects every retryable problem into one feedback message;
 * attempt 2 degrades instead: drop uncited established facts, store with a length limitation, store an
 * inconsistent "Meets" with `inconsistent_output`. Unknown evidence ids and schema failures stay terminal.
 */
export function validateResearchOutput(
  raw: unknown,
  ledgerIds: readonly number[],
  attempt: 1 | 2 = 1,
): ValidationResult {
  const shapeErrors = checkShape(raw);
  if (shapeErrors.length > 0) {
    return attempt === 1
      ? fail({ retryWith: `Your reply did not match the JSON schema: ${shapeErrors.slice(0, 5).join("; ")}. Return only JSON that matches the schema.` })
      : fail({ failure: "invalid_json" });
  }
  const out = JSON.parse(JSON.stringify(raw)) as ResearchOutput;
  const allowed = new Set(ledgerIds);
  const used = new Set<number>(out.cited_evidence_ids);
  for (const group of out.facts_vs_claims) {
    for (const item of group.items) for (const id of item.evidence_ids) used.add(id);
  }
  for (const m of out.report_md.matchAll(/\[E(\d+)\]/g)) used.add(Number(m[1]));
  const unknown = [...used].filter((id) => !allowed.has(id)).sort((a, b) => a - b);
  const feedback: string[] = [];
  if (unknown.length > 0) {
    if (attempt === 2) return fail({ failure: "unknown_evidence_id" });
    const known = [...allowed].sort((a, b) => a - b).map((id) => `E${id}`).join(", ");
    feedback.push(`These evidence ids are not in the ledger: ${unknown.map((id) => `E${id}`).join(", ")}. Cite only ${known || "nothing (the ledger is empty)"}.`);
  }
  const uncited = out.facts_vs_claims
    .filter((g) => g.section === "established_facts")
    .reduce((n, g) => n + g.items.filter((i) => i.evidence_ids.length === 0).length, 0);
  if (uncited > 0) {
    feedback.push("Every item under established_facts needs at least one evidence id; add one or move the item to interpretation.");
  }
  const wc = wordCount(out.report_md);
  const badLength = wc < REPORT_WORDS_MIN || wc > REPORT_WORDS_MAX;
  if (badLength) {
    feedback.push(`report_md has ${wc} words; write about 500-800 words (never fewer than ${REPORT_WORDS_MIN} or more than ${REPORT_WORDS_MAX}).`);
  }
  const inconsistent =
    out.conclusion === "Meets these two fundamental checks." &&
    !(out.sufficient_evidence && !out.material_damage_established && (out.bankruptcy_risk === "Low" || out.bankruptcy_risk === "Moderate"));
  if (inconsistent) {
    feedback.push('Reconcile the output: "Meets these two fundamental checks." requires sufficient_evidence=true, material_damage_established=false and bankruptcy_risk Low or Moderate; otherwise choose another conclusion.');
  }
  if (attempt === 1 && feedback.length > 0) return fail({ retryWith: feedback.join(" ") });

  const limitations: string[] = [];
  let dropped = 0;
  const groups = out.facts_vs_claims.map((g) =>
    g.section !== "established_facts"
      ? g
      : {
          ...g,
          items: g.items.filter((i) => {
            if (i.evidence_ids.length > 0) return true;
            dropped++;
            return false;
          }),
        });
  if (dropped > 0) limitations.push(`dropped_uncited_established_facts:${dropped}`);
  if (badLength) limitations.push(`report_length_out_of_range:${wc}`);
  if (inconsistent) limitations.push("inconsistent_output");
  const uniqueSorted = (ids: number[]): number[] => [...new Set(ids)].sort((a, b) => a - b);
  const output: ResearchOutput = {
    ...out,
    report_md: stripUrls(out.report_md),
    summary: stripUrls(out.summary),
    news_reason: stripUrls(out.news_reason),
    cited_evidence_ids: uniqueSorted(out.cited_evidence_ids),
    facts_vs_claims: groups.map((g) => ({
      section: g.section,
      items: g.items.map((i) => ({ text: stripUrls(i.text), evidence_ids: uniqueSorted(i.evidence_ids) })),
    })),
    missing_documents: out.missing_documents.map(stripUrls),
    limitations: out.limitations.map(stripUrls),
  };
  return { ok: true, output, limitations, inconsistent };
}

// ---------------------------------------------------------------- rendering

const mdText = (s: string): string => s.replace(/\s+/g, " ").replace(/\[/g, "(").replace(/\]/g, ")").trim();
const mdUrl = (u: string): string => u.replace(/\s/g, "%20").replace(/\(/g, "%28").replace(/\)/g, "%29");

/** The "Sources" section, rendered only from ledger rows, in evidence order (spec 9.5 rule 1 and 5). */
export function renderSources(entries: readonly LedgerEntry[]): string {
  if (entries.length === 0) return "## Sources\n\nNo sources were cited.";
  const lines = [...entries]
    .sort((a, b) => a.evidenceId - b.evidenceId)
    .map(
      (e) =>
        `- [E${e.evidenceId}] [${mdText(e.title ?? e.url)}](${mdUrl(e.url)}) - ${e.publisher ?? "publisher not available"} - ${dateLabel(e)}`,
    );
  return ["## Sources", "", ...lines].join("\n");
}
```

- [ ] **Step 4: Run the tests, then type check and lint**

Run: `bun run test:core -- research`
Expected: PASS, about 30 tests in `research.test.ts`.

Run: `bun run typecheck` then `bun run lint:fix` then `bun run lint`
Expected: exit 0, including the core purity guard (the file uses no `Date`, `URL`, `console`, `fetch`). `research.test.ts` is excluded from the core `tsconfig` (P0 decision), so its `node:fs` import is fine.

- [ ] **Step 5: Commit**

```text
git add supabase/functions/_shared/core/research.ts supabase/functions/_shared/core/research.test.ts
git commit -m "feat(research): add pure research core (verbatim prompt, validation, ranking, rendering)"
```

---

### Task 5: Research worker handlers, store, seeds, `news`, `classify:final`, `research_now`

**Files:**
- Create: `supabase/functions/_shared/adapters/research_types.ts`, `research_store.ts`, `providers.ts`
- Create: `supabase/functions/worker-tick/handlers/{research_steps,research,research_seed,news,classify_final,p2_register}.ts`
- Create: `supabase/functions/worker-tick/handlers/testing/{fake_store,fakes}.ts`
- Create (tests): `supabase/functions/worker-tick/handlers/{research,news,classify_final,research_seed}.test.ts`
- Create: `supabase/functions/scan-control/actions/research_now.ts`, `research_now.test.ts`
- Modify (one-line merges, step 16): the P1 handler registry and seeder registry of `worker-tick`, and the P1 action table of `scan-control`.

**Interfaces:**
- Consumes: Task 1 tables and RPC wrappers; Task 2 `LlmProvider`, `createLlmProviders`; Task 3 `TavilyClient`, `EdgarClient`, `fetchDocument`, `readViaJina`, `fetchFeed`, `canonicalUrl`, `capText`; Task 4 core (`@core/research.ts`); P1 `classifyOperational` (`@core/classify.ts`), Yahoo `news`, `scanEvent`, `serviceClient`.
- Produces: `ResearchStore` (port) + `createSupabaseResearchStore(db)`; `ResearchDeps`; `researchHandler(deps)`, `newsHandler(deps)`, `classifyFinalHandler(deps)`, `publishFinalHandler(deps)`, `seedResearchStage(deps, runId, date)`, `seedNewsStage(deps, runId, date)`, `registerP2(deps)`; `researchNow(deps, input)` for `scan-control`; `createResearchDeps(env, db, fetchImpl?)`.
- Step names (spec 9.10): `plan`, `prefetch`, `search:1`, `search:2`, `fetch:1`, `fetch:2`, `fetch:3`, `extract:1`..`extract:4`, `synthesize`, `validate`. Job keys: first job `research:<security_id>:<trigger>:plan`; follow-ups `research:<report_id>:<step>[:<n>]` (stage `research`, `priority` by trigger: manual 5, new_discount 10, premium 20, monitor_first 30, monitor_change 40, refresh 90); a Stage 2 retry uses the suffix `:r2`; a step that runs short of time re-enqueues itself with `:<n>`; a resumed deferred report uses `:resume:<scan_date>`.
- Defer codes (`research_reports.error` when `status = quota_deferred`): `llm_quota`, `tavily_quota`, `daily_cap`, `provider_not_configured`.
- Card rule (A-27): `refresh` and `monitor_change` reports, and a `new_discount` report that replaces a stale current public report, never change a card while they run, defer or fail (`usage.preserve_cards`); a card with no linked report is judged by the security's current PUBLIC report, so a stale category stays and the UI marks it "refresh pending". A holders-only report is never copied onto a public card.

- [ ] **Step 1: Re-check the P1 contracts this task consumes**

Run: `git grep -n "classifyOperational" -- supabase/functions/_shared/core` and `git grep -n "HANDLERS\|seedNextStage\|scanEvent\|serviceClient" -- supabase/functions`
Expected: `classifyOperational` is exported from `_shared/core/classify.ts`; a `HANDLERS` record, a seeder entry point, a Yahoo `news` function, `scanEvent` and `serviceClient` exist. If a name differs, change only `providers.ts` (imports of `news`, `scanEvent`) and `p2_register.ts` (registry shape); nothing else in this task imports a P1 module except `classifyOperational`.

- [ ] **Step 2: Write the shared types and ports `_shared/adapters/research_types.ts`**

```ts
import type { DirectOptions, DocFetchResult } from "./fetchers/direct.ts";
import type { EdgarClient } from "./fetchers/edgar.ts";
import type { JinaOptions, JinaResult } from "./fetchers/jina.ts";
import type { FeedItem } from "./fetchers/rss.ts";
import type { LlmProvider } from "./llm/types.ts";
import type { TavilyClient } from "./search/tavily.ts";
import type { ResearchBankruptcyRisk, ResearchConclusion, SourceKind, Stage1Fact } from "../core/research.ts";

export type ResearchTrigger = "new_discount" | "premium" | "monitor_first" | "monitor_change" | "refresh" | "manual";
export type ReportStatus = "queued" | "running" | "complete" | "failed" | "quota_deferred" | "stale";
export type Visibility = "public" | "holders";
export type DeferCode = "llm_quota" | "tavily_quota" | "daily_cap" | "provider_not_configured";

/** Spec 9.8, seeded verbatim into `app_settings.research`. */
export interface ResearchSettings {
  max_full_reports_per_day: number;
  tavily_daily_cap: number;
  tavily_monthly_budget: number;
  llm_daily_request_cap: number;
  max_change_checks_per_day: number;
  reuse_days: number;
  tavily_reserved_for_reports: number;
}

export const DEFAULT_RESEARCH_SETTINGS: ResearchSettings = {
  max_full_reports_per_day: 4,
  tavily_daily_cap: 32,
  tavily_monthly_budget: 950,
  llm_daily_request_cap: 300,
  max_change_checks_per_day: 40,
  reuse_days: 30,
  tavily_reserved_for_reports: 24,
};

/** Public identifiers of one security; nothing here is user data. */
export interface SecurityContext {
  securityId: string;
  companyId: string;
  companyName: string;
  ticker: string;
  primaryExchange: string;
  reportingCurrency: string;
  sector: string | null;
  industry: string | null;
  secCik: string | null;
  irRssUrls: string[];
  newsSymbol: string | null;
}

export interface ReportUsage {
  reserved?: Record<string, true>;
  preserve_cards?: boolean;
  tokens?: { input: number; output: number };
  llm_calls?: number;
  queries?: string[];
  queries_done?: number[];
  selected?: number[];
  deterministic?: string;
  industry_note?: string;
  limited_sources?: boolean;
  low_quota_logged?: boolean;
  missing?: string[];
  stage2?: { attempt: 1 | 2; json: unknown } | null;
  synth_attempt?: 1 | 2;
  retry_feedback?: string | null;
  shown_ids?: number[];
  dropped_facts?: number;
  liveness_checks?: number;
}

export interface ReportRow {
  id: string;
  securityId: string;
  companyId: string;
  scanRunId: string | null;
  trigger: ResearchTrigger;
  status: ReportStatus;
  step: string | null;
  notBefore: string | null;
  isCurrent: boolean;
  visibility: Visibility;
  reportMd: string | null;
  summary: string | null;
  newsSummary: string | null;
  conclusion: ResearchConclusion | null;
  bankruptcyRisk: ResearchBankruptcyRisk | null;
  materialDamageEstablished: boolean | null;
  sufficientEvidence: boolean | null;
  citedEvidenceIds: number[];
  claims: unknown;
  missingDocuments: string[];
  limitations: string[];
  researchCutoffDate: string | null;
  startedAt: string | null;
  completedAt: string | null;
  provider: string | null;
  model: string | null;
  promptVersion: string | null;
  schemaVersion: string | null;
  usage: ReportUsage;
  queriesUsed: number;
  docsFetched: number;
  error: string | null;
  supersedesId: string | null;
  idempotencyKey: string;
}

export type ReportPatch = Partial<Omit<ReportRow, "id" | "idempotencyKey" | "securityId" | "companyId">>;

export interface NewReport {
  idempotencyKey: string;
  securityId: string;
  companyId: string;
  scanRunId: string | null;
  trigger: ResearchTrigger;
  visibility: Visibility;
}

export interface SourceMeta {
  form?: string;
  accession?: string;
  query?: string;
  dateSource?: string;
  extracted?: boolean;
  fetch_error?: string;
}

export interface SourceRow {
  reportId: string;
  evidenceId: number;
  url: string;
  canonicalUrl: string;
  title: string | null;
  publisher: string | null;
  kind: SourceKind;
  publishedAt: string | null;
  filingDate: string | null;
  retrievedAt: string | null;
  httpStatus: number | null;
  contentType: string | null;
  contentHash: string | null;
  excerpt: string | null;
  extracted: Stage1Fact[];
  livenessVerifiedAt: string | null;
  verification: "pending" | "ok" | "failed" | "skipped";
  usedInReport: boolean;
  meta: SourceMeta;
}

export type NewSource = Pick<
  SourceRow,
  "url" | "canonicalUrl" | "title" | "publisher" | "kind" | "publishedAt" | "filingDate" | "excerpt" | "meta"
>;
export type SourcePatch = Partial<Omit<SourceRow, "reportId" | "evidenceId">>;

export interface NewJob {
  scanRunId: string;
  stage: "research" | "news" | "classify" | "publish";
  key: string;
  payload: Record<string, unknown>;
  priority?: number;
  notBefore?: string;
}

export interface CardRow {
  id: number;
  mode: string;
  securityId: string;
  rank: number;
  symbol: string;
  researchReportId: string | null;
  operationalCategory: string;
}

export interface CardUpdate {
  scanRunId: string;
  securityId: string;
  reportId: string | null;
  category: string;
  reasonCode: string;
  summary: string | null;
  conclusion: string | null;
  bankruptcyRisk: string | null;
  completedAt: string | null;
}

export interface CardPatch extends Omit<CardUpdate, "scanRunId" | "securityId"> {
  displayOrder: number;
}

export interface NewsItem {
  id: string;
  title: string;
  link: string;
  publishedAt: string | null;
  form?: string;
}

/** Items the `news` stage saw today; the change check compares them with what it has already acknowledged. */
export interface LatestItems {
  yahoo: NewsItem[];
  edgar: NewsItem[];
  rss: NewsItem[];
}

export interface ResearchStore {
  loadSecurity(securityId: string): Promise<SecurityContext | null>;
  saveSecCik(companyId: string, cik: string): Promise<void>;
  hasDiscountCard(securityId: string): Promise<boolean>;
  findReportByKey(key: string): Promise<ReportRow | null>;
  createReport(input: NewReport): Promise<ReportRow>;
  getReport(id: string): Promise<ReportRow | null>;
  patchReport(id: string, patch: ReportPatch): Promise<void>;
  deleteReport(id: string): Promise<void>;
  currentReport(securityId: string): Promise<ReportRow | null>;
  hasInflightReport(securityId: string): Promise<boolean>;
  hasAnyReport(securityId: string): Promise<boolean>;
  hasOpenFindingSince(securityId: string, sinceIso: string): Promise<boolean>;
  promoteReport(reportId: string): Promise<string | null>;
  listSources(reportId: string): Promise<SourceRow[]>;
  addSources(reportId: string, rows: NewSource[]): Promise<SourceRow[]>;
  patchSource(reportId: string, evidenceId: number, patch: SourcePatch): Promise<void>;
  clearSources(reportId: string): Promise<void>;
  putWorkText(reportId: string, evidenceId: number, text: string): Promise<void>;
  getWorkText(reportId: string, evidenceId: number): Promise<string | null>;
  deleteWorkTexts(reportId: string): Promise<void>;
  consumeQuota(provider: string, resource: string, amount: number, period: "day" | "month", limit: number): Promise<boolean>;
  quotaUsed(provider: string, resource: string, period: "day" | "month"): Promise<number>;
  enqueueJob(job: NewJob): Promise<void>;
  applyReportToCards(update: CardUpdate): Promise<number>;
  hasPendingCard(scanRunId: string, securityId: string): Promise<boolean>;
  listCards(scanRunId: string): Promise<CardRow[]>;
  updateCard(id: number, patch: CardPatch): Promise<void>;
  updateMonitorReport(securityId: string, reportId: string, category: string): Promise<void>;
  setLatestItems(securityId: string, latest: LatestItems): Promise<void>;
  mergeCoverage(scanRunId: string, patch: Record<string, unknown>): Promise<void>;
  refreshScanStatus(scanRunId: string): Promise<void>;
  latestScanRun(): Promise<{ id: string; scanDateLocal: string } | null>;
  listPendingDiscountSecurities(scanRunId: string): Promise<string[]>;
  listPremiumSecurities(scanRunId: string): Promise<string[]>;
  listStaleCurrentReports(olderThanIso: string): Promise<{ securityId: string; reportId: string }[]>;
  listDeferred(nowIso: string): Promise<ReportRow[]>;
  listNewsTargets(scanRunId: string): Promise<string[]>;
}

export interface YahooNewsItem {
  uuid: string;
  title: string;
  publisher?: string | undefined;
  link: string;
  providerPublishTime: Date | string;
  relatedTickers?: string[] | undefined;
}

export interface FetchPort {
  direct(url: string, opts?: DirectOptions): Promise<DocFetchResult>;
  jina(url: string, opts?: JinaOptions): Promise<JinaResult>;
  feed(
    url: string,
    opts?: { signal?: AbortSignal | undefined },
  ): Promise<{ ok: true; items: FeedItem[] } | { ok: false; message: string }>;
}

export interface Job {
  id: number | string;
  scan_run_id: string;
  stage: string;
  key: string;
  payload: Record<string, unknown>;
  attempts?: number;
}

export interface HandlerCtx {
  signal: AbortSignal;
  /** `performance.now()` value at which the invocation must have finished (spec 7.5). */
  deadline: number;
}

export interface ResearchDeps {
  store: ResearchStore;
  llm: Record<string, LlmProvider>;
  /** Provider names, primary first. */
  llmOrder: string[];
  tavily: TavilyClient;
  fetch: FetchPort;
  edgar: EdgarClient;
  yahooNews: (symbol: string) => Promise<YahooNewsItem[]>;
  settings: () => Promise<ResearchSettings>;
  now: () => Date;
  sha256: (text: string) => Promise<string>;
  log: (
    event: string,
    data?: Record<string, unknown>,
    ctx?: { scanRunId?: string; securityId?: string; level?: "info" | "warn" | "error" },
  ) => Promise<void>;
  secUserAgent: string;
  jinaApiKey?: string | undefined;
  /** Registered by Task 6: the daily change-check job (`payload.kind = "change_check"`). */
  changeCheck?: ((job: Job, ctx: HandlerCtx) => Promise<unknown>) | undefined;
  /** Registered by Task 6: extra jobs the stage 10 seeder adds (change checks, monitor_first). */
  seedExtras?: ((scanRunId: string, scanDateLocal: string) => Promise<number>) | undefined;
}
```

- [ ] **Step 3: Write the in-memory fake store `worker-tick/handlers/testing/fake_store.ts`**

Reads return clones (like a database); `structuredClone` keeps a handler that forgets to persist a change from passing by accident.

```ts
import type {
  CardPatch, CardRow, CardUpdate, LatestItems, NewJob, NewReport, NewSource, ReportPatch, ReportRow,
  ResearchStore, SecurityContext, SourcePatch, SourceRow,
} from "@adapters/research_types.ts";

export interface FakeCard extends CardRow {
  scanRunId: string;
  categoryReason?: string;
  withheld?: boolean;
  summary?: string | null;
  conclusion?: string | null;
  bankruptcyRisk?: string | null;
  completedAt?: string | null;
  displayOrder?: number;
}

export interface FakeJob extends NewJob {
  id: number;
  status: "queued" | "done";
}

/** In-memory ResearchStore. Mirrors the SQL rules the handlers rely on: unique key, canonical dedupe, quota cap. */
export class FakeStore implements ResearchStore {
  securities = new Map<string, SecurityContext>();
  reports = new Map<string, ReportRow>();
  sources = new Map<string, SourceRow[]>();
  texts = new Map<string, string>();
  cards: FakeCard[] = [];
  jobs: FakeJob[] = [];
  quota = new Map<string, number>();
  quotaCalls: { provider: string; resource: string; amount: number; granted: boolean }[] = [];
  discountCards = new Set<string>();
  findings: { securityId: string; detectedAt: string }[] = [];
  monitorLatest = new Map<string, LatestItems>();
  monitorReports = new Map<string, { reportId: string; category: string }>();
  coverage = new Map<string, Record<string, unknown>>();
  premium = new Map<string, string[]>();
  scanRuns: { id: string; scanDateLocal: string }[] = [];
  /** User-level data that must never reach a provider; privacy tests assert it stays here. */
  secrets: Record<string, string> = {};
  refreshed: string[] = [];
  private seq = 0;

  async loadSecurity(id: string) {
    const s = this.securities.get(id);
    return s ? structuredClone(s) : null;
  }
  async saveSecCik(companyId: string, cik: string) {
    for (const s of this.securities.values()) if (s.companyId === companyId) s.secCik = cik;
  }
  async hasDiscountCard(securityId: string) {
    return this.discountCards.has(securityId) || this.cards.some((c) => c.securityId === securityId);
  }
  async findReportByKey(key: string) {
    const r = [...this.reports.values()].find((x) => x.idempotencyKey === key);
    return r ? structuredClone(r) : null;
  }
  async createReport(input: NewReport) {
    const existing = await this.findReportByKey(input.idempotencyKey);
    if (existing) return existing;
    const row: ReportRow = {
      id: `rep-${++this.seq}`, securityId: input.securityId, companyId: input.companyId, scanRunId: input.scanRunId,
      trigger: input.trigger, status: "queued", step: null, notBefore: null, isCurrent: false, visibility: input.visibility,
      reportMd: null, summary: null, newsSummary: null, conclusion: null, bankruptcyRisk: null,
      materialDamageEstablished: null, sufficientEvidence: null, citedEvidenceIds: [], claims: [], missingDocuments: [],
      limitations: [], researchCutoffDate: null, startedAt: null, completedAt: null, provider: null, model: null,
      promptVersion: null, schemaVersion: null, usage: {}, queriesUsed: 0, docsFetched: 0, error: null,
      supersedesId: null, idempotencyKey: input.idempotencyKey,
    };
    this.reports.set(row.id, row);
    return structuredClone(row);
  }
  async getReport(id: string) {
    const r = this.reports.get(id);
    return r ? structuredClone(r) : null;
  }
  async patchReport(id: string, patch: ReportPatch) {
    const row = this.reports.get(id);
    if (!row) throw new Error(`no report ${id}`);
    Object.assign(row, structuredClone(patch));
  }
  async deleteReport(id: string) {
    this.reports.delete(id);
    this.sources.delete(id);
  }
  async currentReport(securityId: string) {
    const r = [...this.reports.values()].find((x) => x.securityId === securityId && x.isCurrent);
    return r ? structuredClone(r) : null;
  }
  async hasInflightReport(securityId: string) {
    return [...this.reports.values()].some(
      (r) => r.securityId === securityId && (r.status === "running" || r.status === "quota_deferred"),
    );
  }
  async hasAnyReport(securityId: string) {
    return [...this.reports.values()].some((r) => r.securityId === securityId);
  }
  async hasOpenFindingSince(securityId: string, sinceIso: string) {
    return this.findings.some((f) => f.securityId === securityId && f.detectedAt > sinceIso);
  }
  async promoteReport(reportId: string) {
    const row = this.reports.get(reportId);
    if (!row || row.status !== "complete") throw new Error("only a complete report can become current");
    let previous: string | null = null;
    for (const r of this.reports.values()) {
      if (r.securityId === row.securityId && r.isCurrent && r.id !== reportId) {
        previous = r.id;
        r.isCurrent = false;
      }
    }
    row.isCurrent = true;
    if (previous) row.supersedesId = previous;
    return previous;
  }
  async listSources(reportId: string) {
    return structuredClone(this.sources.get(reportId) ?? []);
  }
  async addSources(reportId: string, rows: NewSource[]) {
    const list = this.sources.get(reportId) ?? [];
    const inserted: SourceRow[] = [];
    for (const r of rows) {
      if (list.some((s) => s.canonicalUrl === r.canonicalUrl)) continue;
      const row: SourceRow = {
        reportId, evidenceId: Math.max(0, ...list.map((s) => s.evidenceId)) + 1, url: r.url, canonicalUrl: r.canonicalUrl,
        title: r.title, publisher: r.publisher, kind: r.kind, publishedAt: r.publishedAt, filingDate: r.filingDate,
        retrievedAt: null, httpStatus: null, contentType: null, contentHash: null, excerpt: r.excerpt, extracted: [],
        livenessVerifiedAt: null, verification: "pending", usedInReport: false, meta: { ...r.meta },
      };
      list.push(row);
      inserted.push(structuredClone(row));
    }
    this.sources.set(reportId, list);
    return inserted;
  }
  async patchSource(reportId: string, evidenceId: number, patch: SourcePatch) {
    const row = (this.sources.get(reportId) ?? []).find((s) => s.evidenceId === evidenceId);
    if (!row) throw new Error(`no source E${evidenceId}`);
    Object.assign(row, structuredClone(patch));
  }
  async clearSources(reportId: string) {
    this.sources.set(reportId, []);
  }
  async putWorkText(reportId: string, evidenceId: number, text: string) {
    this.texts.set(`${reportId}:${evidenceId}`, text);
  }
  async getWorkText(reportId: string, evidenceId: number) {
    return this.texts.get(`${reportId}:${evidenceId}`) ?? null;
  }
  async deleteWorkTexts(reportId: string) {
    for (const k of [...this.texts.keys()]) if (k.startsWith(`${reportId}:`)) this.texts.delete(k);
  }
  async consumeQuota(provider: string, resource: string, amount: number, period: "day" | "month", limit: number) {
    const key = `${provider}|${resource}|${period}`;
    const used = this.quota.get(key) ?? 0;
    const granted = used + amount <= limit;
    if (granted) this.quota.set(key, used + amount);
    this.quotaCalls.push({ provider, resource, amount, granted });
    return granted;
  }
  async quotaUsed(provider: string, resource: string, period: "day" | "month") {
    return this.quota.get(`${provider}|${resource}|${period}`) ?? 0;
  }
  async enqueueJob(job: NewJob) {
    if (this.jobs.some((j) => j.scanRunId === job.scanRunId && j.stage === job.stage && j.key === job.key)) return;
    this.jobs.push({ ...job, id: ++this.seq, status: "queued" });
  }
  async applyReportToCards(u: CardUpdate) {
    let n = 0;
    for (const c of this.cards) {
      if (c.scanRunId !== u.scanRunId || c.securityId !== u.securityId) continue;
      c.operationalCategory = u.category;
      c.categoryReason = u.reasonCode;
      c.withheld = !(u.category === "green" || u.category === "amber");
      if (u.reportId) c.researchReportId = u.reportId;
      c.summary = u.summary;
      c.conclusion = u.conclusion;
      c.bankruptcyRisk = u.bankruptcyRisk;
      c.completedAt = u.completedAt;
      n++;
    }
    return n;
  }
  async hasPendingCard(scanRunId: string, securityId: string) {
    return this.cards.some((c) => c.scanRunId === scanRunId && c.securityId === securityId && c.operationalCategory === "pending");
  }
  async listCards(scanRunId: string) {
    return this.cards.filter((c) => c.scanRunId === scanRunId).map((c) => ({ ...c }));
  }
  async updateCard(id: number, patch: CardPatch) {
    const c = this.cards.find((x) => x.id === id);
    if (!c) throw new Error(`no card ${id}`);
    c.operationalCategory = patch.category;
    c.categoryReason = patch.reasonCode;
    c.withheld = !(patch.category === "green" || patch.category === "amber");
    c.researchReportId = patch.reportId;
    c.summary = patch.summary;
    c.conclusion = patch.conclusion;
    c.bankruptcyRisk = patch.bankruptcyRisk;
    c.completedAt = patch.completedAt;
    c.displayOrder = patch.displayOrder;
  }
  async updateMonitorReport(securityId: string, reportId: string, category: string) {
    this.monitorReports.set(securityId, { reportId, category });
  }
  async setLatestItems(securityId: string, latest: LatestItems) {
    this.monitorLatest.set(securityId, structuredClone(latest));
  }
  async mergeCoverage(scanRunId: string, patch: Record<string, unknown>) {
    this.coverage.set(scanRunId, { ...(this.coverage.get(scanRunId) ?? {}), ...patch });
  }
  async refreshScanStatus(scanRunId: string) {
    this.refreshed.push(scanRunId);
  }
  async latestScanRun() {
    return this.scanRuns.at(-1) ?? null;
  }
  async listPendingDiscountSecurities(scanRunId: string) {
    const ids = new Set(this.cards.filter((c) => c.scanRunId === scanRunId && c.operationalCategory === "pending").map((c) => c.securityId));
    const out: string[] = [];
    for (const id of ids) if (!(await this.hasInflightReport(id))) out.push(id);
    return out;
  }
  async listPremiumSecurities(scanRunId: string) {
    return this.premium.get(scanRunId) ?? [];
  }
  async listStaleCurrentReports(olderThanIso: string) {
    return [...this.reports.values()]
      .filter((r) => r.isCurrent && r.completedAt !== null && r.completedAt < olderThanIso)
      .map((r) => ({ securityId: r.securityId, reportId: r.id }));
  }
  async listDeferred(nowIso: string) {
    return [...this.reports.values()]
      .filter((r) => r.status === "quota_deferred" && (r.notBefore ?? "") <= nowIso)
      .map((r) => structuredClone(r));
  }
  async listNewsTargets(scanRunId: string) {
    return [...new Set(this.cards.filter((c) => c.scanRunId === scanRunId).map((c) => c.securityId))];
  }
}
```

- [ ] **Step 4: Write the fake providers and the world builder `worker-tick/handlers/testing/fakes.ts`**

```ts
import type { DocFetchResult } from "@adapters/fetchers/direct.ts";
import type { EdgarClient, Filing } from "@adapters/fetchers/edgar.ts";
import type { JinaResult } from "@adapters/fetchers/jina.ts";
import type { GenerateJsonRequest, GenerateJsonResult, LlmProvider } from "@adapters/llm/types.ts";
import {
  DEFAULT_RESEARCH_SETTINGS, type FetchPort, type HandlerCtx, type Job, type ResearchDeps,
  type ResearchSettings, type SecurityContext, type YahooNewsItem,
} from "@adapters/research_types.ts";
import type { SearchHit, TavilyClient, TavilyResult } from "@adapters/search/tavily.ts";
import { EVIDENCE_PREAMBLE, STAGE1_SYSTEM, type ResearchOutput } from "@core/research.ts";
import { researchHandler } from "../research.ts";
import { FakeStore } from "./fake_store.ts";

export const words = (n: number) => Array.from({ length: n }, (_, i) => `word${i % 50}`).join(" ");

export type Verdict = "green" | "amber" | "red" | "inconsistent" | "unknown_id" | "cite_unverified";

export class FakeLlm implements LlmProvider {
  calls: GenerateJsonRequest[] = [];
  /** Counter value of this provider's daily quota at the moment of each call (proves reserve-before-call). */
  quotaSeen: number[] = [];
  onCall: (() => void) | undefined;
  constructor(
    readonly name = "gemini",
    readonly model = "fake-model",
    readonly configured = true,
    public responder: (req: GenerateJsonRequest) => GenerateJsonResult<unknown> = () => ({ ok: false, kind: "http", message: "no responder" }),
  ) {}
  async generateJson<T>(req: GenerateJsonRequest): Promise<GenerateJsonResult<T>> {
    this.onCall?.();
    this.calls.push(req);
    if (!this.configured) return { ok: false, kind: "not_configured", message: "not configured" };
    return this.responder(req) as GenerateJsonResult<T>;
  }
  get stage1Calls() {
    return this.calls.filter((c) => c.system === STAGE1_SYSTEM);
  }
  get stage2Calls() {
    return this.calls.filter((c) => c.system === EVIDENCE_PREAMBLE);
  }
}

/** Builds Stage 1 and Stage 2 answers from the prompt itself so quotes and evidence ids always match the ledger. */
export function scriptedResponder(getVerdict: () => Verdict) {
  return (req: GenerateJsonRequest): GenerateJsonResult<unknown> => {
    const usage = { input: 100, output: 50 };
    if (req.system === STAGE1_SYSTEM) {
      const body = req.user.split("DOCUMENT TEXT:\n")[1] ?? "";
      const quote = body.slice(0, 60).replace(/\s+/g, " ").trim();
      return {
        ok: true, usage, model: "fake-model",
        json: { facts: [{ topic: "liquidity", claim: "The company reports its liquidity position.", claim_type: "management_claim", quote, where: "p.1" }] },
      };
    }
    const ids = [...req.user.matchAll(/\[E(\d+)\] kind=\w+/g)].map((m) => Number(m[1]));
    const headlineIds = [...req.user.matchAll(/\[E(\d+)\] kind=\w+[^\n]*\n\s+facts: \(no facts extracted; headline only\)/g)].map((m) => Number(m[1]));
    const first = ids.slice(0, 2);
    const verdict = getVerdict();
    const base: ResearchOutput = {
      report_md: `${words(500)} [E${first[0] ?? 1}]`,
      summary: "Fell on weak guidance; the verdict follows the evidence.",
      news_reason: "Guidance cut.",
      conclusion: "Meets these two fundamental checks.",
      bankruptcy_risk: "Low",
      material_damage_established: false,
      sufficient_evidence: true,
      cited_evidence_ids: first,
      facts_vs_claims: [{ section: "established_facts", items: [{ text: "Liquidity is described in the filing.", evidence_ids: first.slice(0, 1) }] }],
      missing_documents: [],
      limitations: [],
      research_cutoff_date: "2026-10-15",
    };
    if (verdict === "amber") base.bankruptcy_risk = "Moderate";
    if (verdict === "red") {
      base.conclusion = "Does not meet one or both checks.";
      base.bankruptcy_risk = "High";
      base.material_damage_established = true;
    }
    if (verdict === "inconsistent") base.sufficient_evidence = false;
    if (verdict === "unknown_id") base.cited_evidence_ids = [999];
    if (verdict === "cite_unverified") base.cited_evidence_ids = [...first, ...headlineIds].slice(0, 7);
    return { ok: true, usage, model: "fake-model", json: base };
  };
}

export class FakeTavily implements TavilyClient {
  queries: string[] = [];
  mode: "ok" | "quota" = "ok";
  /** Daily Tavily counter at the moment of each call. */
  quotaSeen: number[] = [];
  constructor(private readonly store: FakeStore) {}
  async search(query: string): Promise<TavilyResult> {
    this.quotaSeen.push(this.store.quota.get("tavily|credits|day") ?? 0);
    this.queries.push(query);
    if (this.mode === "quota") return { ok: false, kind: "quota", status: 432, message: "limit" };
    const n = this.queries.length;
    const hits: SearchHit[] = [
      { url: `https://investors.acme.example/doc-${n}`, title: `IR document ${n}`, snippet: "investor relations", publishedDate: "2026-09-01" },
      { url: `https://news.example.com/story-${n}`, title: `Story ${n}`, snippet: "shares fell" },
    ];
    return { ok: true, results: hits };
  }
}

export class FakeFetch implements FetchPort {
  directCalls: string[] = [];
  jinaCalls: string[] = [];
  failUrls = new Set<string>();
  feedItems: { guid: string; title: string; link: string; published: string | null }[] = [];
  async direct(url: string): Promise<DocFetchResult> {
    this.directCalls.push(url);
    if (this.failUrls.has(url)) return { ok: false, kind: "http", status: 404, message: "HTTP 404" };
    return { ok: true, status: 200, contentType: "text/html", text: `Document body for ${url}. ${words(80)}`, truncated: false, finalUrl: url, bytes: 500 };
  }
  async jina(url: string): Promise<JinaResult> {
    this.jinaCalls.push(url);
    if (this.failUrls.has(url)) return { ok: false, kind: "http", status: 404, message: "HTTP 404" };
    return { ok: true, status: 200, text: `Reader text for ${url}. ${words(80)}` };
  }
  async feed() {
    return { ok: true as const, items: this.feedItems };
  }
}

export class FakeEdgar implements EdgarClient {
  filings: Filing[] = [
    { form: "8-K", accession: "0000000001-26-000003", filingDate: "2026-10-02", primaryDocument: "k8.htm", reportDate: null },
    { form: "10-Q", accession: "0000000001-26-000002", filingDate: "2026-08-01", primaryDocument: "q.htm", reportDate: "2026-06-30" },
    { form: "10-K", accession: "0000000001-26-000001", filingDate: "2026-02-20", primaryDocument: "k.htm", reportDate: "2025-12-31" },
  ];
  calls: string[] = [];
  async resolveCik(ticker: string) {
    this.calls.push(`cik:${ticker}`);
    return { ok: true as const, value: "0000000001" };
  }
  async submissions(cik: string) {
    this.calls.push(`sub:${cik}`);
    return { ok: true as const, value: this.filings };
  }
  filingUrl(cik: string, accession: string, doc: string) {
    return `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accession.replaceAll("-", "")}/${doc}`;
  }
}

export const SEC_1: SecurityContext = {
  securityId: "sec-1", companyId: "co-1", companyName: "Acme Corp", ticker: "ACME", primaryExchange: "NasdaqGS",
  reportingCurrency: "USD", sector: "Technology", industry: "Software", secCik: "0000000001", irRssUrls: [], newsSymbol: null,
};

export interface World {
  store: FakeStore;
  llm: FakeLlm;
  tavily: FakeTavily;
  fetch: FakeFetch;
  edgar: FakeEdgar;
  deps: ResearchDeps;
  logs: { event: string; data?: Record<string, unknown> | undefined }[];
  yahoo: { items: YahooNewsItem[]; calls: string[]; fail: boolean };
  verdict: { value: Verdict };
  clock: { now: Date };
  settings: { value: ResearchSettings };
  /** Runs one job directly (no queue). */
  handle(job: Job, ctx?: Partial<HandlerCtx>): Promise<unknown>;
  /** Runs queued jobs FIFO by priority, each due job once; returns the number of executions. */
  drain(ctx?: Partial<HandlerCtx>, maxExecutions?: number): Promise<number>;
  /** Enqueues `first` and drains. */
  run(first: Job, ctx?: Partial<HandlerCtx>, maxExecutions?: number): Promise<number>;
}

export function makeWorld(opts: { configured?: boolean; security?: SecurityContext } = {}): World {
  const store = new FakeStore();
  const security = opts.security ?? SEC_1;
  store.securities.set(security.securityId, { ...security });
  store.scanRuns.push({ id: "run-1", scanDateLocal: "2026-10-15" });
  store.cards.push({
    id: 1, scanRunId: "run-1", mode: "worldwide", securityId: security.securityId, rank: 53, symbol: security.ticker,
    researchReportId: null, operationalCategory: "pending",
  });
  const verdict = { value: "green" as Verdict };
  const llm = new FakeLlm("gemini", "fake-model", opts.configured ?? true, scriptedResponder(() => verdict.value));
  llm.onCall = () => llm.quotaSeen.push(store.quota.get("gemini|llm_requests|day") ?? 0);
  const tavily = new FakeTavily(store);
  const fetch = new FakeFetch();
  const edgar = new FakeEdgar();
  const logs: World["logs"] = [];
  const yahoo = { items: [] as YahooNewsItem[], calls: [] as string[], fail: false };
  const clock = { now: new Date("2026-10-15T08:00:00Z") };
  const settings = { value: { ...DEFAULT_RESEARCH_SETTINGS } };
  const deps: ResearchDeps = {
    store, llm: { gemini: llm }, llmOrder: ["gemini"], tavily, fetch, edgar,
    yahooNews: async (symbol) => {
      yahoo.calls.push(symbol);
      if (yahoo.fail) throw new Error("yahoo down");
      return yahoo.items;
    },
    settings: async () => settings.value,
    now: () => clock.now,
    sha256: async (text) => `sha:${text.length}`,
    log: async (event, data) => {
      logs.push({ event, data });
    },
    secUserAgent: "Screener admin@example.com",
  };
  const handler = researchHandler(deps);
  const context = (ctx: Partial<HandlerCtx> = {}): HandlerCtx => ({
    signal: new AbortController().signal, deadline: performance.now() + 120_000, ...ctx,
  });
  const world: World = {
    store, llm, tavily, fetch, edgar, deps, logs, yahoo, verdict, clock, settings,
    handle: (job, ctx) => handler(job, context(ctx)),
    async drain(ctx, maxExecutions = 200) {
      let executed = 0;
      while (executed < maxExecutions) {
        const due = store.jobs
          .filter((j) => j.status === "queued" && (j.notBefore ?? "") <= clock.now.toISOString())
          .sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100) || a.id - b.id)[0];
        if (!due) break;
        due.status = "done";
        executed++;
        await handler({ id: due.id, scan_run_id: due.scanRunId, stage: due.stage, key: due.key, payload: due.payload }, context(ctx));
      }
      return executed;
    },
    async run(first, ctx, maxExecutions) {
      await store.enqueueJob({ scanRunId: first.scan_run_id, stage: "research", key: first.key, payload: first.payload, priority: 10 });
      return await world.drain(ctx, maxExecutions);
    },
  };
  return world;
}

export function planJob(over: Record<string, unknown> = {}, securityId = "sec-1", trigger = "new_discount"): Job {
  return {
    id: 0, scan_run_id: "run-1", stage: "research", key: `research:${securityId}:${trigger}:plan`,
    payload: { security_id: securityId, trigger, scan_run_id: "run-1", scan_date_local: "2026-10-15", ...over },
  };
}
```

- [ ] **Step 5: Write the failing handler tests `worker-tick/handlers/research.test.ts`**

```ts
import { assert, assertEquals, assertNotEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { STAGE1_SYSTEM } from "@core/research.ts";
import { seedResearchStage } from "./research_seed.ts";
import { makeWorld, planJob, scriptedResponder, SEC_1, type World } from "./testing/fakes.ts";

const reportsOf = (w: World, id = "sec-1") => [...w.store.reports.values()].filter((r) => r.securityId === id);

async function addCurrent(w: World, over: { visibility?: "public" | "holders"; completedAt?: string; key?: string } = {}) {
  const current = await w.store.createReport({
    idempotencyKey: over.key ?? "old-key", securityId: "sec-1", companyId: "co-1", scanRunId: "old",
    trigger: "new_discount", visibility: over.visibility ?? "public",
  });
  await w.store.patchReport(current.id, {
    status: "complete", isCurrent: true, completedAt: over.completedAt ?? "2026-10-10T08:00:00.000Z",
    conclusion: "Meets these two fundamental checks.", bankruptcyRisk: "Low", materialDamageEstablished: false,
    sufficientEvidence: true, summary: "Earlier summary.",
  });
  return current;
}

Deno.test("happy path: 13 steps end in complete + green with provenance, ledger and card", async () => {
  const w = makeWorld();
  assertEquals(await w.run(planJob()), 13);
  const [report] = reportsOf(w);
  assert(report);
  assertEquals(report.status, "complete");
  assertEquals(report.conclusion, "Meets these two fundamental checks.");
  assertEquals(report.bankruptcyRisk, "Low");
  assertEquals(report.isCurrent, true);
  assertEquals([report.provider, report.model], ["gemini", "fake-model"]);
  assert(report.promptVersion && report.schemaVersion);
  assertEquals(report.idempotencyKey, "sec-1:new_discount:2026-10-15");
  assertEquals(report.queriesUsed, 6);
  assertEquals(report.docsFetched, 8);
  assertEquals(report.researchCutoffDate, "2026-10-15");
  assertStringIncludes(report.reportMd ?? "", "## Sources");
  // budgets: 6 queries, 8 documents (3 EDGAR via Jina), 8 Stage-1 calls, one Stage-2 call
  assertEquals(w.tavily.queries.length, 6);
  assertEquals(w.fetch.directCalls.length + w.fetch.jinaCalls.length, 8);
  assertEquals(w.fetch.jinaCalls.filter((u) => u.includes("sec.gov")).length, 3);
  assertEquals(w.llm.stage1Calls.length, 8);
  assertEquals(w.llm.stage2Calls.length, 1);
  const card = w.store.cards[0];
  assertEquals([card?.operationalCategory, card?.researchReportId, card?.withheld], ["green", report.id, false]);
  assertEquals(w.store.texts.size, 0, "transient texts are deleted at the end");
  // every URL in the stored report comes from a verified ledger row
  const sources = await w.store.listSources(report.id);
  const ledgerUrls = new Set(sources.map((s) => s.canonicalUrl));
  for (const url of (report.reportMd ?? "").match(/https?:\/\/[^\s)]+/g) ?? []) assert(ledgerUrls.has(url), url);
  for (const id of report.citedEvidenceIds) {
    const src = sources.find((s) => s.evidenceId === id);
    assertEquals(src?.verification, "ok");
    assertEquals(src?.usedInReport, true);
    assert(src?.retrievedAt && src.contentHash && src.httpStatus === 200);
  }
});

Deno.test("quota is consumed before every external call", async () => {
  const w = makeWorld();
  await w.run(planJob());
  assertEquals(w.tavily.quotaSeen, [1, 2, 3, 4, 5, 6]);
  assertEquals(w.llm.quotaSeen, [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assertEquals(w.store.quota.get("research|full_reports:discount|day"), 1);
  assertEquals(w.store.quota.get("tavily|credits_report|day"), 6);
  assertEquals(w.store.quota.get("tavily|credits|month"), 6);
  assert(w.store.quotaCalls.every((c) => c.granted));
});

Deno.test("red path: High risk is classified red and withheld", async () => {
  const w = makeWorld();
  w.verdict.value = "red";
  await w.run(planJob());
  const card = w.store.cards[0];
  assertEquals([card?.operationalCategory, card?.categoryReason, card?.withheld], ["red", "bankruptcy_high", true]);
  assertEquals(reportsOf(w)[0]?.bankruptcyRisk, "High");
});

Deno.test("amber path: Moderate risk with sufficient evidence is amber, never green", async () => {
  const w = makeWorld();
  w.verdict.value = "amber";
  await w.run(planJob());
  assertEquals(w.store.cards[0]?.operationalCategory, "amber");
});

Deno.test("unknown evidence id -> one retry with feedback -> failed, grey research_failed", async () => {
  const w = makeWorld();
  w.verdict.value = "unknown_id";
  await w.run(planJob());
  const report = reportsOf(w)[0];
  assertEquals([report?.status, report?.error, report?.isCurrent], ["failed", "unknown_evidence_id", false]);
  assertEquals(w.llm.stage2Calls.length, 2, "exactly one retry");
  assertStringIncludes(w.llm.stage2Calls[1]?.user ?? "", "CORRECTION REQUIRED");
  assertStringIncludes(w.llm.stage2Calls[1]?.user ?? "", "E999");
  assertEquals([w.store.cards[0]?.operationalCategory, w.store.cards[0]?.categoryReason], ["grey", "research_failed"]);
  assertEquals(w.store.texts.size, 0);
});

Deno.test("inconsistent Meets is stored with a limitation and never maps to green", async () => {
  const w = makeWorld();
  w.verdict.value = "inconsistent";
  await w.run(planJob());
  const report = reportsOf(w)[0];
  assertEquals(report?.status, "complete");
  assert(report?.limitations.includes("inconsistent_output"));
  assertNotEquals(w.store.cards[0]?.operationalCategory, "green");
  assertEquals(w.store.cards[0]?.operationalCategory, "grey");
});

Deno.test("Tavily exhausted at search:1 with >= 2 primary documents continues with limited_sources", async () => {
  const w = makeWorld();
  w.tavily.mode = "quota";
  await w.run(planJob());
  const report = reportsOf(w)[0];
  assertEquals(report?.status, "complete");
  assert(report?.limitations.includes("limited_sources"));
  assertEquals(w.tavily.queries.length, 1, "no further search after the quota answer");
  assertStringIncludes(w.llm.stage2Calls[0]?.user ?? "", "evidence may be incomplete");
});

Deno.test("Tavily exhausted with no primary documents -> quota_deferred, resumed (not duplicated) the next UTC day", async () => {
  const w = makeWorld({ security: { ...SEC_1, secCik: null } });
  w.edgar.filings = [];
  w.tavily.mode = "quota";
  await w.run(planJob());
  const deferred = reportsOf(w)[0];
  assertEquals([deferred?.status, deferred?.error, deferred?.step], ["quota_deferred", "tavily_quota", "search:1"]);
  assertEquals(deferred?.notBefore, "2026-10-16T00:05:00.000Z");
  assertEquals([w.store.cards[0]?.operationalCategory, w.store.cards[0]?.categoryReason], ["pending", "research_quota_deferred"]);
  assertEquals(w.store.jobs.filter((j) => j.status === "queued").length, 0, "nothing is retried the same day");

  w.clock.now = new Date("2026-10-16T08:00:00Z");
  w.tavily.mode = "ok";
  w.store.scanRuns.push({ id: "run-2", scanDateLocal: "2026-10-16" });
  w.store.cards.push({ id: 2, scanRunId: "run-2", mode: "worldwide", securityId: "sec-1", rank: 53, symbol: "ACME", researchReportId: null, operationalCategory: "pending" });
  assertEquals(await seedResearchStage(w.deps, "run-2", "2026-10-16"), 1);
  const resumed = w.store.jobs.find((j) => j.scanRunId === "run-2");
  assertEquals([resumed?.payload.step, resumed?.payload.report_id], ["search:1", deferred?.id]);
  await w.drain();
  assertEquals(reportsOf(w).length, 1);
  assertEquals(reportsOf(w)[0]?.status, "complete");
  assertEquals(w.store.cards.find((c) => c.id === 2)?.operationalCategory, "green");
});

Deno.test("LLM quota exhausted -> quota_deferred at the step reached, candidate stays pending", async () => {
  const w = makeWorld();
  w.llm.responder = () => ({ ok: false, kind: "quota", status: 429, message: "daily quota" });
  await w.run(planJob());
  const report = reportsOf(w)[0];
  assertEquals([report?.status, report?.error, report?.step], ["quota_deferred", "llm_quota", "extract:1"]);
  assertEquals(w.store.cards[0]?.operationalCategory, "pending");
});

Deno.test("not configured -> quota_deferred with provider_not_configured and no external call", async () => {
  const w = makeWorld({ configured: false });
  await w.run(planJob());
  const report = reportsOf(w)[0];
  assertEquals([report?.status, report?.error, report?.step], ["quota_deferred", "provider_not_configured", "plan"]);
  assertEquals(w.llm.calls.length + w.tavily.queries.length + w.fetch.directCalls.length, 0);
  assertEquals(w.store.cards[0]?.operationalCategory, "pending");
});

Deno.test("max_full_reports_per_day reached -> the next discount is deferred with daily_cap", async () => {
  const w = makeWorld();
  w.settings.value = { ...w.settings.value, max_full_reports_per_day: 1 };
  w.store.securities.set("sec-2", { ...SEC_1, securityId: "sec-2", companyId: "co-2", companyName: "Beta Inc", ticker: "BETA" });
  w.store.cards.push({ id: 2, scanRunId: "run-1", mode: "worldwide", securityId: "sec-2", rank: 60, symbol: "BETA", researchReportId: null, operationalCategory: "pending" });
  await w.run(planJob());
  await w.run(planJob({}, "sec-2"));
  assertEquals(reportsOf(w, "sec-1")[0]?.status, "complete");
  const second = reportsOf(w, "sec-2")[0];
  assertEquals([second?.status, second?.error], ["quota_deferred", "daily_cap"]);
  assertEquals(w.store.cards.find((c) => c.securityId === "sec-2")?.operationalCategory, "pending");
});

Deno.test("re-running plan creates one report and reserves quota once", async () => {
  const w = makeWorld();
  const job = planJob();
  await w.run(job, {}, 1); // plan only
  const planned = reportsOf(w)[0];
  assert(planned);
  await w.handle({ ...job, key: `${job.key}:redelivered` }); // the same plan delivered again after a killed invocation
  assertEquals(reportsOf(w).length, 1);
  assertEquals(w.store.quota.get("research|full_reports:discount|day"), 1);
  assertEquals(w.store.jobs.filter((j) => j.key === `research:${planned.id}:prefetch`).length, 1);
});

Deno.test("fetch re-run does not refetch ok documents", async () => {
  const w = makeWorld();
  await w.run(planJob(), {}, 5); // plan, prefetch, search:1, search:2, fetch:1
  const report = reportsOf(w)[0];
  assert(report);
  const before = w.fetch.directCalls.length + w.fetch.jinaCalls.length;
  assertEquals(before, 3);
  await w.handle({
    id: 99, scan_run_id: "run-1", stage: "research", key: `research:${report.id}:fetch:1:again`,
    payload: { security_id: "sec-1", trigger: "new_discount", scan_date_local: "2026-10-15", report_id: report.id, step: "fetch:1" },
  });
  assertEquals(w.fetch.directCalls.length + w.fetch.jinaCalls.length, before);
});

Deno.test("reuse links a current report <= 30 days old and creates no row and no external call", async () => {
  const w = makeWorld();
  const current = await addCurrent(w);
  await w.run(planJob());
  assertEquals(reportsOf(w).length, 1);
  assertEquals([w.store.cards[0]?.researchReportId, w.store.cards[0]?.operationalCategory], [current.id, "green"]);
  assertEquals(w.llm.calls.length + w.tavily.queries.length + w.fetch.directCalls.length + w.edgar.calls.length, 0);
});

Deno.test("reuse is skipped for an old report, a holders-only report and a newer finding; the new report supersedes", async () => {
  for (const variant of ["old", "holders", "finding"] as const) {
    const w = makeWorld();
    const current = await addCurrent(w, {
      visibility: variant === "holders" ? "holders" : "public",
      completedAt: variant === "old" ? "2026-09-01T00:00:00.000Z" : "2026-10-10T08:00:00.000Z",
    });
    if (variant === "finding") w.store.findings.push({ securityId: "sec-1", detectedAt: "2026-10-12T00:00:00.000Z" });
    await w.run(planJob());
    assertEquals(reportsOf(w).length, 2, variant);
    const latest = reportsOf(w).find((r) => r.id !== current.id);
    assertEquals([latest?.status, latest?.supersedesId], ["complete", current.id], variant);
    assertEquals(w.store.reports.get(current.id)?.isCurrent, false, variant);
  }
});

Deno.test("a refresh of a stale report never downgrades the card while it runs", async () => {
  const w = makeWorld();
  const current = await addCurrent(w, { completedAt: "2026-09-01T00:00:00.000Z" });
  await w.store.applyReportToCards({
    scanRunId: "run-1", securityId: "sec-1", reportId: current.id, category: "green", reasonCode: "meets_checks",
    summary: "Earlier summary.", conclusion: null, bankruptcyRisk: null, completedAt: "2026-09-01T00:00:00.000Z",
  });
  await w.run(planJob({}, "sec-1", "refresh"), {}, 4); // plan .. search:2, report still running
  assertEquals(reportsOf(w).find((r) => r.id !== current.id)?.status, "running");
  assertEquals(w.store.cards[0]?.operationalCategory, "green");
  assertEquals(w.store.cards[0]?.researchReportId, current.id);
});

Deno.test("validate: unverified cited sources are liveness-checked (<= 4 GETs); failures end in citation_verification_failed", async () => {
  const w = makeWorld();
  w.verdict.value = "cite_unverified";
  for (let n = 1; n <= 6; n++) w.fetch.failUrls.add(`https://news.example.com/story-${n}`);
  await w.run(planJob());
  const report = reportsOf(w)[0];
  assertEquals([report?.status, report?.error], ["failed", "citation_verification_failed"]);
  assertEquals(w.store.cards[0]?.operationalCategory, "grey");
  assert((report?.usage.liveness_checks ?? 99) <= 4, "at most 4 GETs per validate attempt");
  assertEquals(w.llm.stage2Calls.length, 2, "one retry with the unverified ids excluded");
});

Deno.test("Stage 1 facts whose quote is not in the document are dropped", async () => {
  const w = makeWorld();
  const inner = scriptedResponder(() => w.verdict.value);
  w.llm.responder = (req) => {
    const res = inner(req);
    if (req.system === STAGE1_SYSTEM && res.ok) {
      const fact = (res.json as { facts: { quote: string }[] }).facts[0];
      if (fact) fact.quote = "a fabricated quotation that is not in the text";
    }
    return res;
  };
  await w.run(planJob());
  const report = reportsOf(w)[0];
  assert(report);
  assert((report.usage.dropped_facts ?? 0) >= 8);
  const sources = await w.store.listSources(report.id);
  assert(sources.filter((s) => s.verification === "ok").every((s) => s.extracted.length === 0));
});

Deno.test("prompts, queries and fetches contain no user ids or quantities and are identical for a held security", async () => {
  const run = async (trigger: string) => {
    const w = makeWorld();
    w.store.secrets = { user: "user-0000-secret", qty: "777 shares", basis: "cost basis 12.34" };
    await w.run(planJob({}, "sec-1", trigger));
    return w;
  };
  const candidate = await run("new_discount");
  const held = await run("monitor_first");
  for (const w of [candidate, held]) {
    const traffic = JSON.stringify([w.llm.calls, w.tavily.queries, w.fetch.directCalls, w.fetch.jinaCalls]);
    for (const secret of Object.values(w.store.secrets)) assertEquals(traffic.includes(secret), false, secret);
    assert(w.llm.stage2Calls.length === 1);
  }
  assertEquals(candidate.llm.stage2Calls[0]?.user, held.llm.stage2Calls[0]?.user);
  assertEquals(candidate.llm.stage2Calls[0]?.system, held.llm.stage2Calls[0]?.system);
  assertEquals(candidate.tavily.queries, held.tavily.queries);
});

Deno.test("a step short of time re-enqueues itself with a numeric suffix instead of overrunning", async () => {
  const w = makeWorld();
  await w.run(planJob(), { deadline: performance.now() + 500 }, 5); // plan, prefetch, search:1, search:2, fetch:1
  const again = w.store.jobs.find((j) => /:fetch:1:1$/.test(j.key));
  assert(again, "fetch:1 re-enqueued as :1");
  assertEquals(reportsOf(w)[0]?.status, "running");
});

Deno.test("an LLM transport failure (http) throws so the worker retries with backoff", async () => {
  const w = makeWorld();
  w.llm.responder = () => ({ ok: false, kind: "http", status: 503, message: "unavailable" });
  let thrown = "";
  try {
    await w.run(planJob());
  } catch (e) {
    thrown = (e as Error).message;
  }
  assertStringIncludes(thrown, "llm http");
});
```

- [ ] **Step 6: Write the failing tests for `news`, `classify:final`, the seeders and `research_now`, then run all**

`worker-tick/handlers/news.test.ts`:

```ts
import { assert, assertEquals } from "jsr:@std/assert@1";
import type { Job } from "@adapters/research_types.ts";
import { newsHandler } from "./news.ts";
import { makeWorld, SEC_1 } from "./testing/fakes.ts";

const job = (): Job => ({
  id: 1, scan_run_id: "run-1", stage: "news", key: "news:sec-1",
  payload: { security_id: "sec-1", scan_run_id: "run-1", scan_date_local: "2026-10-15" },
});
const ctx = () => ({ signal: new AbortController().signal, deadline: performance.now() + 60_000 });
const item = (uuid: string, related: string[]) => ({
  uuid, title: `Story ${uuid}`, link: `https://finance.yahoo.com/n/${uuid}`, providerPublishTime: "2026-10-14T10:00:00Z", relatedTickers: related,
});

Deno.test("news: Yahoo items are filtered by relatedTickers, EDGAR forms recorded, items attached to the queued report", async () => {
  const w = makeWorld();
  w.yahoo.items = [item("a", ["ACME", "OTHER"]), item("b", ["OTHER"]), item("c", ["ACME"])];
  const res = (await newsHandler(w.deps)(job(), ctx())) as { yahoo: number; edgar: number; attached: number };
  assertEquals([res.yahoo, res.edgar, res.attached], [2, 3, 5]);
  assertEquals(w.yahoo.calls, ["ACME"]);
  const latest = w.store.monitorLatest.get("sec-1");
  assertEquals([latest?.yahoo.length, latest?.edgar.length, latest?.rss.length], [2, 3, 0]);
  const report = await w.store.findReportByKey("sec-1:new_discount:2026-10-15");
  assertEquals(report?.status, "queued");
  const kinds = (await w.store.listSources(report?.id ?? "")).map((s) => s.kind).sort();
  assertEquals(kinds, ["edgar_filing", "edgar_filing", "edgar_filing", "yahoo_news", "yahoo_news"]);
  assertEquals(w.store.cards[0]?.operationalCategory, "pending", "the card is not touched by the news stage");
  assertEquals(w.store.cards[0]?.researchReportId, null);
});

Deno.test("news: a non-US symbol skips Yahoo, uses RSS, and rerunning does not duplicate sources", async () => {
  const w = makeWorld({ security: { ...SEC_1, ticker: "SAP.DE", secCik: null, irRssUrls: ["https://ir.example.com/feed.xml"] } });
  w.fetch.feedItems = [{ guid: "g1", title: "IR item", link: "https://ir.example.com/1", published: "2026-10-14T00:00:00.000Z" }];
  const handler = newsHandler(w.deps);
  await handler(job(), ctx());
  await handler(job(), ctx());
  assertEquals(w.yahoo.calls, []);
  assertEquals(w.edgar.calls, []);
  const reports = [...w.store.reports.values()];
  assertEquals(reports.length, 1);
  const sources = await w.store.listSources(reports[0]?.id ?? "");
  assertEquals(sources.map((s) => s.kind), ["rss"]);
});

Deno.test("news: no report is attached when a reusable current report exists or one is already running", async () => {
  const w = makeWorld();
  const current = await w.store.createReport({ idempotencyKey: "k", securityId: "sec-1", companyId: "co-1", scanRunId: "old", trigger: "new_discount", visibility: "public" });
  await w.store.patchReport(current.id, { status: "complete", isCurrent: true, completedAt: "2026-10-10T00:00:00.000Z" });
  await newsHandler(w.deps)(job(), ctx());
  assertEquals([...w.store.reports.values()].length, 1);
  assert(w.store.monitorLatest.has("sec-1"), "latest items are still recorded for the change check");
});

Deno.test("news: a failing source is logged and does not fail the job", async () => {
  const w = makeWorld();
  w.yahoo.fail = true;
  const res = (await newsHandler(w.deps)(job(), ctx())) as { edgar: number };
  assertEquals(res.edgar, 3);
  assert(w.logs.some((l) => l.event === "news_source_failed" && l.data?.source === "yahoo"));
});
```

`worker-tick/handlers/classify_final.test.ts`:

```ts
import { assertEquals } from "jsr:@std/assert@1";
import type { ReportPatch } from "@adapters/research_types.ts";
import { FakeStore } from "./testing/fake_store.ts";
import { assignDisplayOrder, classifyFinalHandler, publishFinalHandler, researchCoverage } from "./classify_final.ts";

const job = { id: 1, scan_run_id: "run-1", stage: "classify", key: "classify:final", payload: {} };
const log = async () => {};

async function report(store: FakeStore, sid: string, patch: ReportPatch = {}) {
  const r = await store.createReport({
    idempotencyKey: `k-${sid}`, securityId: sid, companyId: `co-${sid}`, scanRunId: "run-1", trigger: "new_discount",
    visibility: patch.visibility ?? "public",
  });
  await store.patchReport(r.id, patch);
  return r;
}

const meets = { status: "complete" as const, conclusion: "Meets these two fundamental checks." as const, materialDamageEstablished: false, sufficientEvidence: true, completedAt: "2026-10-14T00:00:00.000Z" };
let nextId = 0;
function card(store: FakeStore, sid: string, rank: number, reportId: string | null = null) {
  store.cards.push({ id: ++nextId, scanRunId: "run-1", mode: "worldwide", securityId: sid, rank, symbol: sid.toUpperCase(), researchReportId: reportId, operationalCategory: "pending" });
}

Deno.test("classify:final recomputes every card, orders green, amber, then withheld, and never clears the rest", async () => {
  nextId = 0;
  const store = new FakeStore();
  const a = await report(store, "a", { ...meets, bankruptcyRisk: "Low" });
  const b = await report(store, "b", { ...meets, bankruptcyRisk: "Moderate" });
  const c = await report(store, "c", { ...meets, conclusion: "Does not meet one or both checks.", bankruptcyRisk: "High", materialDamageEstablished: true });
  const d = await report(store, "d", { status: "failed", error: "unknown_evidence_id" });
  const h = await report(store, "h", { status: "quota_deferred", error: "llm_quota" });
  const stale = await report(store, "f", { ...meets, bankruptcyRisk: "Low", isCurrent: true, completedAt: "2026-08-20T00:00:00.000Z" });
  await report(store, "g", { ...meets, bankruptcyRisk: "Low", isCurrent: true, visibility: "holders" });
  card(store, "a", 5, a.id); card(store, "b", 3, b.id); card(store, "c", 1, c.id); card(store, "d", 2, d.id);
  card(store, "e", 4); card(store, "f", 9); card(store, "g", 7); card(store, "h", 8, h.id);

  await classifyFinalHandler({ store, log })(job);
  const by = (sid: string) => store.cards.find((x) => x.securityId === sid);
  assertEquals(["a", "b", "c", "d", "e", "f", "g", "h"].map((s) => by(s)?.operationalCategory), ["green", "amber", "red", "grey", "pending", "green", "pending", "pending"]);
  assertEquals(["a", "b", "c", "d", "e", "f", "g", "h"].map((s) => by(s)?.withheld), [false, false, true, true, true, false, true, true]);
  assertEquals(by("c")?.categoryReason, "bankruptcy_high");
  assertEquals(by("d")?.categoryReason, "research_failed");
  assertEquals(by("h")?.categoryReason, "research_quota_deferred");
  assertEquals(by("f")?.researchReportId, stale.id, "an unlinked card keeps the stale PUBLIC report (A-27)");
  assertEquals(by("g")?.researchReportId, null, "a holders-only report is never copied onto a public card");
  assertEquals(["a", "f", "b", "c", "d", "e", "g", "h"].map((s) => by(s)?.displayOrder), [1, 2, 3, 4, 5, 6, 7, 8]);
});

Deno.test("assignDisplayOrder orders per mode by category, rank, symbol", () => {
  const order = assignDisplayOrder([
    { id: 1, mode: "us", rank: 2, symbol: "B", category: "amber" },
    { id: 2, mode: "us", rank: 2, symbol: "A", category: "green" },
    { id: 3, mode: "us", rank: 1, symbol: "Z", category: "pending" },
    { id: 4, mode: "worldwide", rank: 9, symbol: "Q", category: "red" },
  ]);
  assertEquals([order.get(2), order.get(1), order.get(3), order.get(4)], [1, 2, 3, 1]);
});

Deno.test("publish:final merges coverage.research and refreshes the scan status", async () => {
  nextId = 0;
  const store = new FakeStore();
  const a = await report(store, "a", { ...meets, bankruptcyRisk: "Low", scanRunId: "run-0" });
  const h = await report(store, "h", { status: "quota_deferred", error: "provider_not_configured" });
  const d = await report(store, "d", { status: "quota_deferred", error: "llm_quota" });
  card(store, "a", 1, a.id); card(store, "h", 2, h.id); card(store, "d", 3, d.id); card(store, "e", 4);
  const coverage = await researchCoverage(store, "run-1");
  assertEquals(coverage, { cards: 4, complete: 1, pending: 1, deferred: 1, failed: 0, not_configured: 1, reused: 1 });
  await publishFinalHandler({ store, log })({ ...job, key: "publish:final", stage: "publish" });
  assertEquals((store.coverage.get("run-1") as { research: unknown }).research, coverage);
  assertEquals(store.refreshed, ["run-1"]);
});
```

`worker-tick/handlers/research_seed.test.ts`:

```ts
import { assertEquals } from "jsr:@std/assert@1";
import { seedNewsStage, seedResearchStage } from "./research_seed.ts";
import { FakeStore } from "./testing/fake_store.ts";

const NOW = new Date("2026-10-16T08:00:00Z");
const deps = (store: FakeStore, extras?: () => Promise<number>) => ({
  store, now: () => NOW, log: async () => {}, settings: async () => ({
    max_full_reports_per_day: 4, tavily_daily_cap: 32, tavily_monthly_budget: 950, llm_daily_request_cap: 300,
    max_change_checks_per_day: 40, reuse_days: 30, tavily_reserved_for_reports: 24,
  }), seedExtras: extras,
});

Deno.test("seedResearchStage seeds resumes, new discounts, premiums and refreshes in priority order, idempotently", async () => {
  const store = new FakeStore();
  const card = (id: number, sid: string) =>
    store.cards.push({ id, scanRunId: "run-2", mode: "worldwide", securityId: sid, rank: id, symbol: sid, researchReportId: null, operationalCategory: "pending" });
  card(1, "s1"); card(2, "s2"); // s2 has a running report: it is resumed, not seeded as new
  const running = await store.createReport({ idempotencyKey: "k2", securityId: "s2", companyId: "c", scanRunId: "run-1", trigger: "new_discount", visibility: "public" });
  await store.patchReport(running.id, { status: "quota_deferred", step: "extract:2", notBefore: "2026-10-16T00:05:00.000Z" });
  const later = await store.createReport({ idempotencyKey: "k3", securityId: "s3", companyId: "c", scanRunId: "run-1", trigger: "monitor_first", visibility: "holders" });
  await store.patchReport(later.id, { status: "quota_deferred", step: "plan", notBefore: "2026-10-17T00:05:00.000Z" });
  store.premium.set("run-2", ["s4"]);
  const old = await store.createReport({ idempotencyKey: "k5", securityId: "s5", companyId: "c", scanRunId: "run-0", trigger: "new_discount", visibility: "public" });
  await store.patchReport(old.id, { status: "complete", isCurrent: true, completedAt: "2026-09-01T00:00:00.000Z" });

  const count = await seedResearchStage(deps(store, async () => 2), "run-2", "2026-10-16");
  assertEquals(count, 1 + 1 + 1 + 1 + 2);
  const byKey = (k: string) => store.jobs.find((j) => j.key === k);
  assertEquals(byKey(`research:${running.id}:extract:2:resume:2026-10-16`)?.priority, 10);
  assertEquals(byKey(`research:${running.id}:extract:2:resume:2026-10-16`)?.payload.step, "extract:2");
  assertEquals(byKey(`research:${later.id}:plan:resume:2026-10-16`), undefined, "not due yet");
  assertEquals(byKey("research:s1:new_discount:plan")?.priority, 10);
  assertEquals(byKey("research:s2:new_discount:plan"), undefined);
  assertEquals(byKey("research:s4:premium:plan")?.priority, 20);
  assertEquals(byKey("research:s5:refresh:plan")?.priority, 90);
  const before = store.jobs.length;
  await seedResearchStage(deps(store), "run-2", "2026-10-16");
  assertEquals(store.jobs.length, before, "seeding twice adds no job");
});

Deno.test("seedNewsStage seeds one news job per card security", async () => {
  const store = new FakeStore();
  for (const [id, sid] of [[1, "s1"], [2, "s2"], [3, "s1"]] as const) {
    store.cards.push({ id, scanRunId: "run-2", mode: id === 3 ? "us" : "worldwide", securityId: sid, rank: id, symbol: sid, researchReportId: null, operationalCategory: "pending" });
  }
  assertEquals(await seedNewsStage(deps(store), "run-2", "2026-10-16"), 2);
  assertEquals(store.jobs.map((j) => j.key).sort(), ["news:s1", "news:s2"]);
});
```

`scan-control/actions/research_now.test.ts`:

```ts
import { assert, assertEquals } from "jsr:@std/assert@1";
import { makeWorld, SEC_1 } from "../../worker-tick/handlers/testing/fakes.ts";
import { researchNow } from "./research_now.ts";

Deno.test("research_now: validates input, queues one manual job, is idempotent per day", async () => {
  const w = makeWorld();
  assertEquals((await researchNow({ store: w.store }, { security_id: "not valid!" })).ok, false);
  assertEquals(await researchNow({ store: w.store }, { security_id: "unknown" }), { ok: false, error: "unknown_security" });
  const first = await researchNow({ store: w.store }, { security_id: SEC_1.securityId });
  assert(first.ok);
  assertEquals(first.job_key, "research:sec-1:manual:plan");
  const job = w.store.jobs.find((j) => j.key === first.job_key);
  assertEquals([job?.priority, job?.payload.trigger, job?.payload.scan_date_local], [5, "manual", "2026-10-15"]);
  await w.drain();
  const report = [...w.store.reports.values()][0];
  assertEquals([report?.trigger, report?.status], ["manual", "complete"]);
  const second = await researchNow({ store: w.store }, { security_id: SEC_1.securityId });
  assert(second.ok);
  assertEquals(second.existing_report_id, report?.id);
  assertEquals(w.store.jobs.filter((j) => j.key === "research:sec-1:manual:plan").length, 1, "no second job");
});

Deno.test("research_now: no scan run yet", async () => {
  const w = makeWorld();
  w.store.scanRuns.length = 0;
  assertEquals(await researchNow({ store: w.store }, { security_id: "sec-1" }), { ok: false, error: "no_scan_run" });
});
```

Run the suite and see it fail:

Run: `deno test -A --config supabase/functions/deno.json supabase/functions/worker-tick/handlers supabase/functions/scan-control`
Expected: FAIL with `Module not found` for `research.ts`, `research_seed.ts`, `news.ts`, `classify_final.ts`, `research_now.ts`.

- [ ] **Step 7: Implement the step functions `worker-tick/handlers/research_steps.ts`**

```ts
import { classifyOperational } from "@core/classify.ts";
import {
  ANNUAL_FORMS, EVIDENCE_PREAMBLE, INTERIM_FORMS, PROMPT_VERSION, RESEARCH_OUTPUT_SCHEMA, SCHEMA_VERSION,
  STAGE1_OUTPUT_SCHEMA, STAGE1_SYSTEM, buildStage1User, buildStage2User, dateLabel, fitEvidence, hostOf,
  industryKind, industryNote, isIrUrl, pickFilings, queryTemplates, rankDocuments, renderFilingList,
  renderSources, selectDocuments, validateResearchOutput, validateStage1Facts,
  type LedgerEntry, type PromptVars, type RankCandidate, type ResearchOutput,
} from "@core/research.ts";
import { canonicalUrl, capText } from "@adapters/fetchers/extract.ts";
import type { Filing } from "@adapters/fetchers/edgar.ts";
import type { GenerateJsonRequest, JsonSchema, LlmProvider } from "@adapters/llm/types.ts";
import type {
  DeferCode, HandlerCtx, Job, NewSource, ReportPatch, ReportRow, ResearchDeps, ResearchSettings,
  ResearchTrigger, SecurityContext, SourceRow, Visibility,
} from "@adapters/research_types.ts";

export const STEP_ORDER = [
  "plan", "prefetch", "search:1", "search:2", "fetch:1", "fetch:2", "fetch:3",
  "extract:1", "extract:2", "extract:3", "extract:4", "synthesize", "validate",
] as const;
export type StepName = (typeof STEP_ORDER)[number];

/** Lower runs first (`scan_jobs.priority`); spec 9.1: discount > premium > monitor_first > monitor_change > refresh. */
export const TRIGGER_PRIORITY: Record<ResearchTrigger, number> = {
  manual: 5, new_discount: 10, premium: 20, monitor_first: 30, monitor_change: 40, refresh: 90,
};

const REUSE_TRIGGERS = new Set<ResearchTrigger>(["new_discount", "premium", "monitor_first"]);
/** Triggers whose report must never downgrade the card the user already sees while it runs or fails (A-27). */
const PRESERVE_TRIGGERS = new Set<ResearchTrigger>(["refresh", "monitor_change"]);
const REPORT_CLASS: Record<ResearchTrigger, string> = {
  new_discount: "discount", premium: "premium", monitor_first: "monitor", monitor_change: "monitor", refresh: "refresh", manual: "manual",
};
const MIN_DOC_CHARS = 200;
const MAX_DOC_CHARS = 48_000;
const STEP_MIN_MS = 25_000;
const AUX_CAPS = { jina: 200, sec: 5000 } as const;

export type StepOutcome =
  | { kind: "next"; step: StepName; reportId: string; suffix?: string }
  | { kind: "again"; reportId: string }
  | { kind: "retry_synthesize"; reportId: string }
  | { kind: "done"; status: "complete" | "failed" | "deferred" | "reused"; reportId: string | null };

export interface ChainPayload {
  security_id: string;
  trigger: ResearchTrigger;
  scan_run_id: string;
  scan_date_local: string;
  report_id: string | null;
  step: string;
  n: number;
  force: boolean;
}

export function parsePayload(raw: Record<string, unknown>, job: Job): ChainPayload {
  const str = (key: string): string => (typeof raw[key] === "string" ? (raw[key] as string) : "");
  const trigger = str("trigger") as ResearchTrigger;
  if (!(trigger in TRIGGER_PRIORITY)) throw new Error(`invalid research trigger "${trigger}"`);
  const securityId = str("security_id");
  if (securityId === "") throw new Error("research job without security_id");
  const scanDate = str("scan_date_local");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(scanDate)) throw new Error(`invalid scan_date_local "${scanDate}"`);
  return {
    security_id: securityId, trigger, scan_run_id: job.scan_run_id, scan_date_local: scanDate,
    report_id: str("report_id") || null, step: str("step") || "plan", n: Number(raw.n ?? 0) || 0, force: raw.force === true,
  };
}

interface Env {
  deps: ResearchDeps;
  job: Job;
  ctx: HandlerCtx;
  p: ChainPayload;
  settings: ResearchSettings;
  security: SecurityContext;
  report: ReportRow;
  provider: LlmProvider | null;
}

// ---------------------------------------------------------------- small helpers

export function nextUtcDayPlus(now: Date, minutes = 5): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, minutes)).toISOString();
}

export function ageDays(iso: string, now: Date): number {
  return (now.getTime() - Date.parse(iso)) / 86_400_000;
}

/** A current public report within the reuse window may be linked instead of regenerated (spec 9.11). */
export function isReusable(cur: ReportRow, trigger: ResearchTrigger, settings: ResearchSettings, now: Date): boolean {
  return (
    cur.status === "complete" &&
    cur.completedAt !== null &&
    ageDays(cur.completedAt, now) <= settings.reuse_days &&
    (trigger !== "new_discount" || cur.visibility === "public")
  );
}

export function toFacts(r: ReportRow | null) {
  return r
    ? {
        status: r.status,
        conclusion: r.conclusion,
        bankruptcyRisk: r.bankruptcyRisk,
        materialDamageEstablished: r.materialDamageEstablished,
        sufficientEvidence: r.sufficientEvidence,
      }
    : null;
}

/** US-style ticker (no exchange suffix) usable with EDGAR and Yahoo news, else the ADR line, else null (spec 5.10). */
export function secTicker(sec: SecurityContext): string | null {
  const own = sec.ticker.toUpperCase();
  if (/^[A-Z]{1,5}([-.][A-Z])?$/.test(own)) return own.replace(".", "-");
  return sec.newsSymbol ? sec.newsSymbol.toUpperCase() : null;
}

const toIso = (date: string | undefined): string | null => {
  if (!date) return null;
  const t = Date.parse(date);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
};

const dedupe = (items: string[]): string[] => [...new Set(items.filter((s) => s.trim() !== ""))];

async function save(env: Env, patch: ReportPatch = {}): Promise<void> {
  Object.assign(env.report, patch);
  await env.deps.store.patchReport(env.report.id, { ...patch, usage: env.report.usage });
}

function addLimitation(env: Env, code: string): void {
  if (!env.report.limitations.includes(code)) env.report.limitations = [...env.report.limitations, code];
}

async function applyCards(env: Env, r: ReportRow = env.report): Promise<void> {
  if (env.report.usage.preserve_cards === true && r.status !== "complete") return;
  const { category, reasonCode } = classifyOperational(toFacts(r));
  await env.deps.store.applyReportToCards({
    scanRunId: env.job.scan_run_id, securityId: env.security.securityId, reportId: r.id, category, reasonCode,
    summary: r.summary, conclusion: r.conclusion, bankruptcyRisk: r.bankruptcyRisk, completedAt: r.completedAt,
  });
}

async function defer(env: Env, code: DeferCode, step: string): Promise<StepOutcome> {
  await save(env, { status: "quota_deferred", step, error: code, notBefore: nextUtcDayPlus(env.deps.now()) });
  await applyCards(env);
  await env.deps.log("research_quota_deferred", { report_id: env.report.id, step, code }, scope(env, "warn"));
  return { kind: "done", status: "deferred", reportId: env.report.id };
}

async function failReport(env: Env, code: string): Promise<StepOutcome> {
  await save(env, { status: "failed", error: code, completedAt: null });
  await env.deps.store.deleteWorkTexts(env.report.id);
  await applyCards(env);
  await env.deps.log("research_failed", { report_id: env.report.id, code }, scope(env, "error"));
  return { kind: "done", status: "failed", reportId: env.report.id };
}

const scope = (env: Env, level: "info" | "warn" | "error" = "info") => ({
  scanRunId: env.job.scan_run_id, securityId: env.security.securityId, level,
});

function next(env: Env, from: string, suffix?: string): StepOutcome {
  if (from === "search:1" && env.report.usage.limited_sources) {
    return { kind: "next", step: "fetch:1", reportId: env.report.id };
  }
  const following = STEP_ORDER[STEP_ORDER.indexOf(from as StepName) + 1];
  if (!following) throw new Error(`no step after ${from}`);
  return { kind: "next", step: following, reportId: env.report.id, ...(suffix ? { suffix } : {}) };
}

// ---------------------------------------------------------------- quota

interface QuotaSpec {
  provider: string;
  resource: string;
  period: "day" | "month";
  limit: number;
}

async function consumeAll(env: Env, specs: QuotaSpec[]): Promise<boolean> {
  for (const s of specs) {
    if (!(await env.deps.store.consumeQuota(s.provider, s.resource, 1, s.period, s.limit))) return false;
  }
  return true;
}

/** Reserves once per report and flag, so a re-delivered step never double-counts. */
async function reserveOnce(env: Env, flag: string, specs: QuotaSpec[]): Promise<boolean> {
  const reserved = (env.report.usage.reserved ??= {});
  if (reserved[flag]) return true;
  if (!(await consumeAll(env, specs))) return false;
  reserved[flag] = true;
  await save(env);
  return true;
}

/** Report searches count against the reserved-for-reports bucket and the overall daily and monthly caps. */
export function tavilySpecs(s: ResearchSettings, forReport: boolean): QuotaSpec[] {
  return [
    ...(forReport ? [{ provider: "tavily", resource: "credits_report", period: "day" as const, limit: s.tavily_reserved_for_reports }] : []),
    { provider: "tavily", resource: "credits", period: "day", limit: s.tavily_daily_cap },
    { provider: "tavily", resource: "credits", period: "month", limit: s.tavily_monthly_budget },
  ];
}

/** Primary first; the alternate is used for NEW reports only, when the primary is unconfigured or >= 90% of its cap. */
export async function chooseProvider(deps: ResearchDeps, settings: ResearchSettings): Promise<LlmProvider | null> {
  const providers = deps.llmOrder.map((name) => deps.llm[name]).filter((p): p is LlmProvider => p !== undefined);
  const primary = providers[0];
  const alternate = providers[1];
  if (!primary) return null;
  const used = await deps.store.quotaUsed(primary.name, "llm_requests", "day");
  const nearCap = used >= 0.9 * settings.llm_daily_request_cap;
  if (primary.configured && !nearCap) return primary;
  if (alternate?.configured) {
    if (nearCap) await deps.log("llm_error", { reason: "primary_near_daily_cap", used, cap: settings.llm_daily_request_cap });
    return alternate;
  }
  return primary.configured ? primary : null;
}

type LlmOutcome = { ok: true; json: unknown } | { ok: false; defer: DeferCode } | { ok: false; invalid: string };

/** Reserves quota, calls the model, accounts tokens and maps failures (spec 9.8). http/network throw so the worker retries. */
async function callLlm(env: Env, req: Omit<GenerateJsonRequest, "signal" | "schema"> & { schema: JsonSchema }): Promise<LlmOutcome> {
  const provider = env.provider;
  if (!provider || !provider.configured) return { ok: false, defer: "provider_not_configured" };
  const granted = await env.deps.store.consumeQuota(provider.name, "llm_requests", 1, "day", env.settings.llm_daily_request_cap);
  if (!granted) return { ok: false, defer: "llm_quota" };
  const res = await provider.generateJson<unknown>({ ...req, signal: env.ctx.signal });
  const usage = env.report.usage;
  usage.llm_calls = (usage.llm_calls ?? 0) + 1;
  if (res.ok) {
    usage.tokens = {
      input: (usage.tokens?.input ?? 0) + res.usage.input,
      output: (usage.tokens?.output ?? 0) + res.usage.output,
    };
    return { ok: true, json: res.json };
  }
  await env.deps.log("llm_error", { kind: res.kind, status: res.status ?? null, provider: provider.name }, scope(env, "warn"));
  if (res.kind === "rate_limited" || res.kind === "quota") return { ok: false, defer: "llm_quota" };
  if (res.kind === "not_configured") return { ok: false, defer: "provider_not_configured" };
  if (res.kind === "invalid_json" || res.kind === "schema") return { ok: false, invalid: res.message };
  throw new Error(`llm ${res.kind}: ${res.message}`);
}

/** Primary filings and company pages go through Jina Reader; the rest is fetched directly (spec 9.4). */
async function fetchSource(
  env: Env,
  src: SourceRow,
): Promise<{ text: string; status: number; contentType: string } | { error: string; status: number | null }> {
  const { deps, ctx } = env;
  let jinaTried = false;
  const viaJina = async () => {
    jinaTried = true;
    if (!(await deps.store.consumeQuota("jina", "requests", 1, "day", AUX_CAPS.jina))) return { error: "jina_quota", status: null };
    const r = await deps.fetch.jina(src.url, { apiKey: deps.jinaApiKey, signal: ctx.signal });
    if (!r.ok) return { error: `jina_${r.kind}`, status: r.status ?? null };
    return { text: r.text, status: r.status, contentType: "text/markdown" };
  };
  if (src.kind === "edgar_filing") {
    const r = await viaJina();
    if ("text" in r && r.text.trim().length >= MIN_DOC_CHARS) return r;
  }
  if (src.url.includes("sec.gov")) await deps.store.consumeQuota("sec", "requests", 1, "day", AUX_CAPS.sec);
  const d = await deps.fetch.direct(src.url, { signal: ctx.signal, secUserAgent: deps.secUserAgent });
  if (d.ok && d.text !== null && d.text.length >= MIN_DOC_CHARS) {
    return { text: d.text, status: d.status, contentType: d.contentType };
  }
  const retryable = d.ok || d.kind === "content_type" || d.kind === "timeout" || d.status === 401 || d.status === 403 || d.status === 429;
  if (!jinaTried && retryable) {
    const r = await viaJina();
    if ("text" in r && r.text.trim().length >= MIN_DOC_CHARS) return r;
    if ("error" in r) return r;
  }
  if (d.ok) return { error: d.text === null ? "pdf_unreadable" : "empty_document", status: d.status };
  return { error: `direct_${d.kind}`, status: d.status ?? null };
}

// ---------------------------------------------------------------- steps

export async function runResearchStep(deps: ResearchDeps, job: Job, ctx: HandlerCtx, p: ChainPayload): Promise<StepOutcome> {
  const settings = await deps.settings();
  const security = await deps.store.loadSecurity(p.security_id);
  if (!security) throw new Error(`security ${p.security_id} not found`);
  if (p.step === "plan") return await planStep({ deps, job, ctx, p, settings, security });
  if (!p.report_id) throw new Error(`step ${p.step} without report_id`);
  const report = await deps.store.getReport(p.report_id);
  if (!report) throw new Error(`report ${p.report_id} not found`);
  if (report.status === "complete" || report.status === "failed") {
    return { kind: "done", status: report.status === "complete" ? "complete" : "failed", reportId: report.id };
  }
  const provider = report.provider ? (deps.llm[report.provider] ?? null) : null;
  const env: Env = { deps, job, ctx, p, settings, security, report, provider };
  if (report.status === "quota_deferred" || report.status === "queued") {
    await save(env, { status: "running", error: null, notBefore: null });
    await applyCards(env);
  }
  const [name, n] = p.step.split(":");
  const index = Number(n ?? 0);
  switch (name) {
    case "prefetch": return await prefetchStep(env);
    case "search": return await searchStep(env, index);
    case "fetch": return await fetchStep(env, index);
    case "extract": return await extractStep(env, index);
    case "synthesize": return await synthesizeStep(env);
    case "validate": return await validateStep(env);
    default: throw new Error(`unknown research step ${p.step}`);
  }
}

async function planStep(base: Omit<Env, "report" | "provider">): Promise<StepOutcome> {
  const { deps, job, p, settings, security } = base;
  const { store } = deps;
  const now = deps.now();
  const key = `${security.securityId}:${p.trigger}:${p.scan_date_local}`;
  const existing = p.report_id ? await store.getReport(p.report_id) : await store.findReportByKey(key);
  const withReport = (report: ReportRow, provider: LlmProvider | null): Env => ({ ...base, report, provider });

  // An existing finished report for this key is final: re-delivery is a no-op (idempotency).
  if (existing && (existing.status === "complete" || (existing.status === "failed" && !p.force))) {
    await applyCards(withReport(existing, null), existing);
    return { kind: "done", status: existing.status === "complete" ? "reused" : "failed", reportId: existing.id };
  }

  const started = existing !== null && (existing.status === "running" || existing.status === "quota_deferred");
  const current = await store.currentReport(security.securityId);
  const finding = current?.completedAt ? await store.hasOpenFindingSince(security.securityId, current.completedAt) : false;
  if (!started && REUSE_TRIGGERS.has(p.trigger) && !p.force && current && isReusable(current, p.trigger, settings, now) && !finding) {
    if (existing && existing.status === "queued") await store.deleteReport(existing.id);
    await applyCards(withReport(current, null), current);
    await deps.log("research_reused", { report_id: current.id, trigger: p.trigger }, { scanRunId: job.scan_run_id, securityId: security.securityId });
    return { kind: "done", status: "reused", reportId: current.id };
  }
  const preserve =
    PRESERVE_TRIGGERS.has(p.trigger) ||
    (p.trigger === "new_discount" && current !== null && current.status === "complete" && current.visibility === "public" && !finding);

  const stored = existing?.provider ? deps.llm[existing.provider] : undefined;
  const provider = stored?.configured ? stored : await chooseProvider(deps, settings);
  const visibility: Visibility = p.trigger === "new_discount" || (await store.hasDiscountCard(security.securityId)) ? "public" : "holders";
  let report = existing;
  if (!report) {
    report = await store.createReport({
      idempotencyKey: key, securityId: security.securityId, companyId: security.companyId, scanRunId: job.scan_run_id,
      trigger: p.trigger, visibility,
    });
  } else if (report.status === "failed") {
    await store.clearSources(report.id);
    await store.deleteWorkTexts(report.id);
    await store.patchReport(report.id, { status: "queued", step: null, error: null, usage: {}, queriesUsed: 0, docsFetched: 0, limitations: [], missingDocuments: [] });
    report = (await store.getReport(report.id)) ?? report;
  }
  const env = withReport(report, provider);
  env.report.usage.preserve_cards = preserve;
  if (!provider) return await defer(env, "provider_not_configured", "plan");

  const reserved = await reserveOnce(env, "plan", [
    { provider: "research", resource: `full_reports:${REPORT_CLASS[p.trigger]}`, period: "day", limit: settings.max_full_reports_per_day },
  ]);
  if (!reserved) return await defer(env, "daily_cap", "plan");

  let cik = security.secCik;
  if (!cik) {
    const ticker = secTicker(security);
    if (ticker) {
      const res = await deps.edgar.resolveCik(ticker);
      if (res.ok && res.value) {
        cik = res.value;
        security.secCik = cik;
        await store.saveSecCik(security.companyId, cik);
      } else if (!res.ok) {
        addLimitation(env, "edgar_unavailable");
      }
    }
  }
  const kind = industryKind(security.sector, security.industry);
  env.report.usage.queries = queryTemplates({
    company: security.companyName, ticker: security.ticker, researchDate: p.scan_date_local, industry: kind,
  });
  env.report.usage.industry_note = industryNote(kind);
  await save(env, {
    status: "running", provider: provider.name, model: provider.model, promptVersion: PROMPT_VERSION,
    schemaVersion: SCHEMA_VERSION, scanRunId: job.scan_run_id, startedAt: report.startedAt ?? now.toISOString(),
    step: "plan", error: null, notBefore: null, limitations: env.report.limitations,
  });
  await applyCards(env);
  return next(env, "plan");
}

async function prefetchStep(env: Env): Promise<StepOutcome> {
  const { deps, report, security } = env;
  const cik = security.secCik;
  let filings: Filing[] = [];
  if (cik) {
    const res = await deps.edgar.submissions(cik);
    if (res.ok) filings = res.value;
    else addLimitation(env, "edgar_unavailable");
  }
  const picked = pickFilings(filings);
  const chosen = [picked.annual, picked.interim, ...picked.current].filter((f): f is Filing => f !== null);
  if (cik && chosen.length > 0) {
    const rows: NewSource[] = chosen.map((f) => {
      const url = deps.edgar.filingUrl(cik, f.accession, f.primaryDocument);
      return {
        url, canonicalUrl: canonicalUrl(url), title: `${f.form} filed ${f.filingDate}`, publisher: "SEC EDGAR",
        kind: "edgar_filing", publishedAt: null, filingDate: f.filingDate, excerpt: null,
        meta: { form: f.form, accession: f.accession },
      };
    });
    await deps.store.addSources(report.id, rows);
  }
  report.usage.deterministic = renderFilingList(chosen);
  await save(env, { step: "prefetch", limitations: report.limitations });
  return next(env, "prefetch");
}

async function tavilyExhausted(env: Env, step: string, why: string): Promise<StepOutcome> {
  const sources = await env.deps.store.listSources(env.report.id);
  const primary = sources.filter((s) => s.kind === "edgar_filing").length;
  await env.deps.log("search_quota_low", { step, why, primary_documents: primary }, scope(env, "warn"));
  if (primary >= 2) {
    env.report.usage.limited_sources = true;
    addLimitation(env, "limited_sources");
    await save(env, { limitations: env.report.limitations });
    return next(env, step);
  }
  return await defer(env, "tavily_quota", step);
}

async function searchStep(env: Env, n: number): Promise<StepOutcome> {
  const { deps, report, settings } = env;
  const usage = report.usage;
  if (usage.limited_sources) return next(env, `search:${n}`);
  const queries = usage.queries ?? [];
  const indexes = n === 1 ? [0, 1, 2] : [3, 4, 5];
  const done = new Set(usage.queries_done ?? []);
  if (n === 1 && !usage.low_quota_logged) {
    const monthly = await deps.store.quotaUsed("tavily", "credits", "month");
    if (monthly >= 0.9 * settings.tavily_monthly_budget) {
      usage.low_quota_logged = true;
      await deps.log("search_quota_low", { monthly, budget: settings.tavily_monthly_budget }, scope(env, "warn"));
    }
  }
  for (const i of indexes) {
    const query = queries[i];
    if (query === undefined || done.has(i)) continue;
    if (!(await consumeAll(env, tavilySpecs(settings, true)))) return await tavilyExhausted(env, `search:${n}`, "cap");
    const res = await deps.tavily.search(query, env.ctx.signal);
    if (!res.ok && (res.kind === "quota" || res.kind === "rate_limited" || res.kind === "not_configured")) {
      return await tavilyExhausted(env, `search:${n}`, res.kind);
    }
    if (res.ok) {
      const rows: NewSource[] = res.results.map((h) => ({
        url: h.url, canonicalUrl: canonicalUrl(h.url), title: h.title, publisher: hostOf(h.url),
        kind: isIrUrl(h.url) ? "ir_page" : "search_result", publishedAt: toIso(h.publishedDate), filingDate: null,
        excerpt: h.snippet === "" ? null : h.snippet.slice(0, 2000), meta: { query, dateSource: "search" },
      }));
      await deps.store.addSources(report.id, rows);
    } else {
      await deps.log("search_quota_low", { kind: res.kind, status: res.status ?? null }, scope(env, "warn"));
    }
    done.add(i);
    usage.queries_done = [...done];
    await save(env, { queriesUsed: done.size });
  }
  await save(env, { step: `search:${n}` });
  return next(env, `search:${n}`);
}

const candidateOf = (s: SourceRow): RankCandidate => ({
  evidenceId: s.evidenceId, url: s.canonicalUrl, kind: s.kind, form: s.meta.form ?? null,
  publishedAt: s.publishedAt, filingDate: s.filingDate,
});

async function fetchStep(env: Env, n: number): Promise<StepOutcome> {
  const { deps, report } = env;
  const sources = await deps.store.listSources(report.id);
  if (!report.usage.selected) {
    report.usage.selected = selectDocuments(rankDocuments(sources.filter((s) => s.verification === "pending").map(candidateOf))).map((c) => c.evidenceId);
    await save(env);
  }
  const slice = report.usage.selected.slice((n - 1) * 3, n * 3);
  for (const id of slice) {
    const src = sources.find((s) => s.evidenceId === id);
    if (!src || src.verification !== "pending") continue;
    if (env.ctx.deadline - performance.now() < STEP_MIN_MS) return { kind: "again", reportId: report.id };
    const res = await fetchSource(env, src);
    const now = deps.now().toISOString();
    if ("text" in res) {
      const text = capText(res.text, MAX_DOC_CHARS);
      await deps.store.putWorkText(report.id, src.evidenceId, text);
      await deps.store.patchSource(report.id, src.evidenceId, {
        verification: "ok", httpStatus: res.status, contentType: res.contentType, contentHash: await deps.sha256(text),
        excerpt: text.slice(0, 2000), retrievedAt: now, livenessVerifiedAt: now,
      });
      report.docsFetched += 1;
    } else {
      await deps.store.patchSource(report.id, src.evidenceId, {
        verification: "failed", httpStatus: res.status, meta: { ...src.meta, fetch_error: res.error },
      });
      report.usage.missing = dedupe([...(report.usage.missing ?? []), `${src.title ?? src.url}: not retrieved (${res.error})`]);
    }
    await save(env, { docsFetched: report.docsFetched });
  }
  await save(env, { step: `fetch:${n}` });
  return next(env, `fetch:${n}`);
}

async function extractStep(env: Env, n: number): Promise<StepOutcome> {
  const { deps, report } = env;
  const sources = (await deps.store.listSources(report.id)).filter((s) => s.verification === "ok").sort((a, b) => a.evidenceId - b.evidenceId);
  for (const src of sources.slice((n - 1) * 2, n * 2)) {
    if (src.meta.extracted) continue;
    if (env.ctx.deadline - performance.now() < STEP_MIN_MS) return { kind: "again", reportId: report.id };
    const text = await deps.store.getWorkText(report.id, src.evidenceId);
    if (text === null) {
      await deps.store.patchSource(report.id, src.evidenceId, { meta: { ...src.meta, extracted: true } });
      continue;
    }
    const res = await callLlm(env, {
      system: STAGE1_SYSTEM,
      user: buildStage1User({ evidenceId: src.evidenceId, title: src.title, kind: src.kind, dateLabel: dateLabel(src), url: src.canonicalUrl, text }),
      schema: STAGE1_OUTPUT_SCHEMA, schemaName: "stage1_facts", maxOutputTokens: 4096, temperature: 0.1,
    });
    if (!res.ok && "defer" in res) {
      await save(env);
      return await defer(env, res.defer, `extract:${n}`);
    }
    const validated = res.ok ? validateStage1Facts(res.json, text) : { valid: false, kept: [], dropped: 0 };
    if (!validated.valid) addLimitation(env, `extraction_failed:E${src.evidenceId}`);
    report.usage.dropped_facts = (report.usage.dropped_facts ?? 0) + validated.dropped;
    await deps.store.patchSource(report.id, src.evidenceId, { extracted: validated.kept, meta: { ...src.meta, extracted: true } });
    await save(env, { limitations: report.limitations });
  }
  await save(env, { step: `extract:${n}` });
  return next(env, `extract:${n}`);
}

const ledgerOf = (s: SourceRow): LedgerEntry => ({
  evidenceId: s.evidenceId, url: s.canonicalUrl, title: s.title, publisher: s.publisher, kind: s.kind,
  publishedAt: s.publishedAt, filingDate: s.filingDate, retrievedAt: s.retrievedAt, verification: s.verification, facts: s.extracted,
});

function derivedMissing(env: Env, sources: SourceRow[]): string[] {
  const hasOk = (forms: readonly string[]) =>
    sources.some((s) => s.kind === "edgar_filing" && s.verification === "ok" && forms.includes(s.meta.form ?? ""));
  const out = [...(env.report.usage.missing ?? [])];
  if (!hasOk(ANNUAL_FORMS)) out.push("Latest annual report (10-K, 20-F or 40-F): not obtained");
  if (!hasOk(INTERIM_FORMS)) out.push("Latest quarterly or interim report: not obtained");
  if (env.report.usage.limited_sources) out.push("Web search was unavailable (quota exhausted): evidence may be incomplete");
  return dedupe(out);
}

function promptVars(env: Env): PromptVars {
  return {
    companyName: env.security.companyName, ticker: env.security.ticker, primaryExchange: env.security.primaryExchange,
    reportingCurrency: env.security.reportingCurrency, researchDate: env.p.scan_date_local,
  };
}

async function synthesizeStep(env: Env): Promise<StepOutcome> {
  const { deps, report } = env;
  const attempt = report.usage.synth_attempt ?? 1;
  const sources = await deps.store.listSources(report.id);
  const byId = new Map(sources.map((s) => [s.evidenceId, s]));
  const withFacts = rankDocuments(sources.filter((s) => s.verification === "ok" && s.extracted.length > 0).map(candidateOf));
  const headlines = rankDocuments(
    sources.filter((s) => s.verification === "pending" && s.kind !== "edgar_filing").map(candidateOf),
  ).slice(0, 6);
  const ordered = [...withFacts, ...headlines].flatMap((c) => {
    const s = byId.get(c.evidenceId);
    return s ? [ledgerOf(s)] : [];
  });
  const { shown, omitted } = fitEvidence(ordered);
  shown.sort((a, b) => a.evidenceId - b.evidenceId);
  const user = buildStage2User({
    vars: promptVars(env), industryNote: report.usage.industry_note ?? "", deterministicData: report.usage.deterministic ?? "",
    shown, missing: derivedMissing(env, sources), feedback: report.usage.retry_feedback ?? undefined,
  });
  const res = await callLlm(env, {
    system: EVIDENCE_PREAMBLE, user, schema: RESEARCH_OUTPUT_SCHEMA, schemaName: "research_output",
    maxOutputTokens: 6144, temperature: 0.2,
  });
  if (!res.ok && "defer" in res) {
    await save(env);
    return await defer(env, res.defer, "synthesize");
  }
  if (!res.ok) {
    if (attempt === 1) {
      report.usage.synth_attempt = 2;
      report.usage.retry_feedback = "Your previous reply was not valid JSON matching the schema. Return only JSON that matches the schema.";
      await save(env, { step: "synthesize" });
      return { kind: "retry_synthesize", reportId: report.id };
    }
    return await failReport(env, "invalid_json");
  }
  report.usage.stage2 = { attempt, json: res.json };
  report.usage.shown_ids = shown.map((e) => e.evidenceId);
  void omitted;
  await save(env, { step: "synthesize" });
  return next(env, "synthesize", attempt === 2 ? "r2" : undefined);
}

async function validateStep(env: Env): Promise<StepOutcome> {
  const { deps, report, p } = env;
  const stage2 = report.usage.stage2;
  if (!stage2) throw new Error("validate step without a Stage 2 output");
  const attempt = stage2.attempt;
  const verdict = validateResearchOutput(stage2.json, report.usage.shown_ids ?? [], attempt);
  const retry = async (feedback: string): Promise<StepOutcome> => {
    report.usage.synth_attempt = 2;
    report.usage.retry_feedback = feedback;
    report.usage.stage2 = null;
    await save(env, { step: "validate" });
    return { kind: "retry_synthesize", reportId: report.id };
  };
  if (!verdict.ok || !verdict.output) {
    if (verdict.retryWith && attempt === 1) return await retry(verdict.retryWith);
    return await failReport(env, verdict.failure ?? "invalid_json");
  }
  const output: ResearchOutput = verdict.output;

  // Citation liveness: a cited source must have been fetched this run, or pass a GET now (<= 4 per attempt).
  const sources = await deps.store.listSources(report.id);
  const cited = sources.filter((s) => output.cited_evidence_ids.includes(s.evidenceId));
  const unverified = cited.filter((s) => s.verification !== "ok").sort((a, b) => a.evidenceId - b.evidenceId);
  let checks = 0;
  const bad: SourceRow[] = [];
  for (const src of unverified) {
    if (checks >= 4) {
      bad.push(src);
      continue;
    }
    checks++;
    const res = await deps.fetch.direct(src.url, { timeoutMs: 8000, signal: env.ctx.signal, secUserAgent: deps.secUserAgent });
    const now = deps.now().toISOString();
    if (res.ok) {
      await deps.store.patchSource(report.id, src.evidenceId, {
        verification: "ok", httpStatus: res.status, contentType: res.contentType, retrievedAt: now, livenessVerifiedAt: now,
      });
      src.verification = "ok";
    } else {
      await deps.store.patchSource(report.id, src.evidenceId, { verification: "failed", httpStatus: res.status ?? null });
      bad.push(src);
    }
  }
  report.usage.liveness_checks = checks;
  if (bad.length > 0) {
    const ids = bad.map((s) => `E${s.evidenceId}`).join(", ");
    if (attempt === 1) return await retry(`These sources could not be verified and must not be cited: ${ids}. Cite only verified evidence.`);
    return await failReport(env, "citation_verification_failed");
  }

  const now = deps.now().toISOString();
  const limitations = dedupe([...report.limitations, ...output.limitations, ...verdict.limitations]);
  if (output.research_cutoff_date !== p.scan_date_local) limitations.push("cutoff_date_mismatch");
  const missing = dedupe([...derivedMissing(env, sources), ...output.missing_documents]);
  const reportMd = `${output.report_md.trim()}\n\n${renderSources(cited.map(ledgerOf))}\n`;
  await save(env, {
    status: "complete", step: "validate", reportMd, summary: output.summary, newsSummary: output.news_reason,
    conclusion: output.conclusion, bankruptcyRisk: output.bankruptcy_risk,
    materialDamageEstablished: output.material_damage_established, sufficientEvidence: output.sufficient_evidence,
    citedEvidenceIds: output.cited_evidence_ids, claims: output.facts_vs_claims, missingDocuments: missing, limitations,
    researchCutoffDate: p.scan_date_local, completedAt: now, error: null, notBefore: null,
  });
  for (const src of cited) await deps.store.patchSource(report.id, src.evidenceId, { usedInReport: true });
  await deps.store.deleteWorkTexts(report.id);
  const superseded = await deps.store.promoteReport(report.id);
  env.report.isCurrent = true;
  env.report.supersedesId = superseded;
  await applyCards(env);
  const { category } = classifyOperational(toFacts(env.report));
  await deps.store.updateMonitorReport(env.security.securityId, report.id, category);
  await deps.log("research_complete", { report_id: report.id, category, superseded, tokens: report.usage.tokens ?? null }, scope(env));
  return { kind: "done", status: "complete", reportId: report.id };
}
```

- [ ] **Step 8: Implement the dispatcher `worker-tick/handlers/research.ts`**

```ts
import type { HandlerCtx, Job, ResearchDeps } from "@adapters/research_types.ts";
import { TRIGGER_PRIORITY, parsePayload, runResearchStep, type ChainPayload, type StepOutcome } from "./research_steps.ts";

async function enqueueFollowUp(deps: ResearchDeps, job: Job, p: ChainPayload, outcome: StepOutcome): Promise<void> {
  if (outcome.kind === "done" || !outcome.reportId) return;
  const base = {
    security_id: p.security_id, trigger: p.trigger, scan_run_id: job.scan_run_id,
    scan_date_local: p.scan_date_local, report_id: outcome.reportId,
  };
  const priority = TRIGGER_PRIORITY[p.trigger];
  const id = outcome.reportId;
  if (outcome.kind === "next") {
    const suffix = outcome.suffix ? `:${outcome.suffix}` : "";
    await deps.store.enqueueJob({
      scanRunId: job.scan_run_id, stage: "research", key: `research:${id}:${outcome.step}${suffix}`,
      payload: { ...base, step: outcome.step }, priority,
    });
  } else if (outcome.kind === "again") {
    await deps.store.enqueueJob({
      scanRunId: job.scan_run_id, stage: "research", key: `research:${id}:${p.step}:${p.n + 1}`,
      payload: { ...base, step: p.step, n: p.n + 1 }, priority,
    });
  } else {
    await deps.store.enqueueJob({
      scanRunId: job.scan_run_id, stage: "research", key: `research:${id}:synthesize:r2`,
      payload: { ...base, step: "synthesize" }, priority,
    });
  }
}

/** Handler of stage `research`: one bounded step per job, then the follow-up job (spec 9.10). */
export function researchHandler(deps: ResearchDeps) {
  return async (job: Job, ctx: HandlerCtx): Promise<unknown> => {
    if (job.payload.kind === "change_check") {
      if (!deps.changeCheck) throw new Error("change_check job received but no change-check handler is registered");
      return await deps.changeCheck(job, ctx);
    }
    const p = parsePayload(job.payload, job);
    const outcome = await runResearchStep(deps, job, ctx, p);
    await enqueueFollowUp(deps, job, p, outcome);
    return outcome;
  };
}
```

- [ ] **Step 9: Implement the stage 9 and stage 10 seeders `worker-tick/handlers/research_seed.ts`**

A stage's jobs are seeded when all jobs of the previous stage are terminal (spec 7.4). `seedNewsStage` runs when `portfolio_scan` is terminal, `seedResearchStage` when `news` is terminal. Both are idempotent (`ON CONFLICT DO NOTHING` on `(scan_run_id, stage, key)`).

```ts
import type { NewJob, ResearchDeps } from "@adapters/research_types.ts";
import { TRIGGER_PRIORITY } from "./research_steps.ts";

type SeedDeps = Pick<ResearchDeps, "store" | "now" | "log" | "settings" | "seedExtras">;

/** Stage 9: one `news:<security_id>` job per pending card and per monitored holding. */
export async function seedNewsStage(deps: SeedDeps, scanRunId: string, scanDateLocal: string): Promise<number> {
  const targets = await deps.store.listNewsTargets(scanRunId);
  for (const securityId of targets) {
    await deps.store.enqueueJob({
      scanRunId, stage: "news", key: `news:${securityId}`, priority: 50,
      payload: { security_id: securityId, scan_run_id: scanRunId, scan_date_local: scanDateLocal },
    });
  }
  return targets.length;
}

/**
 * Stage 10 seeder. Order follows the daily-cap priority of spec 9.1:
 * resume deferred reports, new discounts, premiums, then refreshes; Task 6 adds change checks and monitor_first.
 */
export async function seedResearchStage(deps: SeedDeps, scanRunId: string, scanDateLocal: string): Promise<number> {
  const { store } = deps;
  const now = deps.now();
  const settings = await deps.settings();
  let count = 0;
  const add = async (job: NewJob) => {
    await store.enqueueJob(job);
    count++;
  };

  const deferred = (await store.listDeferred(now.toISOString())).sort(
    (a, b) => TRIGGER_PRIORITY[a.trigger] - TRIGGER_PRIORITY[b.trigger],
  );
  for (const r of deferred) {
    const step = r.step ?? "plan";
    await add({
      scanRunId, stage: "research", key: `research:${r.id}:${step}:resume:${scanDateLocal}`, priority: TRIGGER_PRIORITY[r.trigger],
      payload: { security_id: r.securityId, trigger: r.trigger, scan_date_local: scanDateLocal, report_id: r.id, step },
    });
  }
  for (const securityId of await store.listPendingDiscountSecurities(scanRunId)) {
    await add({
      scanRunId, stage: "research", key: `research:${securityId}:new_discount:plan`, priority: TRIGGER_PRIORITY.new_discount,
      payload: { security_id: securityId, trigger: "new_discount", scan_date_local: scanDateLocal },
    });
  }
  for (const securityId of await store.listPremiumSecurities(scanRunId)) {
    await add({
      scanRunId, stage: "research", key: `research:${securityId}:premium:plan`, priority: TRIGGER_PRIORITY.premium,
      payload: { security_id: securityId, trigger: "premium", scan_date_local: scanDateLocal },
    });
  }
  const cutoff = new Date(now.getTime() - settings.reuse_days * 86_400_000).toISOString();
  for (const { securityId } of await store.listStaleCurrentReports(cutoff)) {
    if (await store.hasInflightReport(securityId)) continue;
    await add({
      scanRunId, stage: "research", key: `research:${securityId}:refresh:plan`, priority: TRIGGER_PRIORITY.refresh,
      payload: { security_id: securityId, trigger: "refresh", scan_date_local: scanDateLocal },
    });
  }
  if (deps.seedExtras) count += await deps.seedExtras(scanRunId, scanDateLocal);
  await deps.log("stage_seeded", { stage: "research", jobs: count }, { scanRunId });
  return count;
}
```

- [ ] **Step 10: Implement the `news` stage handler `worker-tick/handlers/news.ts`**

Yahoo news only for US-style symbols (spec 5.10, spike 3.6); EDGAR submissions and company RSS feeds for everyone. The handler records what it saw in `risk_monitor_state.last_seen_items.latest` and, for a pending discount card that has no reusable report, attaches the items to the queued report row the `plan` step will adopt (same idempotency key). It never touches the card.

```ts
import { WATCH_FORMS, pickFilings } from "@core/research.ts";
import { canonicalUrl } from "@adapters/fetchers/extract.ts";
import type { Filing } from "@adapters/fetchers/edgar.ts";
import type { HandlerCtx, Job, NewSource, NewsItem, ResearchDeps } from "@adapters/research_types.ts";
import { isReusable, secTicker } from "./research_steps.ts";

const iso = (value: Date | string): string | null => {
  const t = typeof value === "string" ? Date.parse(value) : value.getTime();
  return Number.isNaN(t) ? null : new Date(t).toISOString();
};
const newest = (a: NewsItem, b: NewsItem) => (b.publishedAt ?? "").localeCompare(a.publishedAt ?? "");

export function newsHandler(deps: ResearchDeps) {
  return async (job: Job, ctx: HandlerCtx): Promise<unknown> => {
    const securityId = String(job.payload.security_id ?? "");
    const scanDate = String(job.payload.scan_date_local ?? "");
    const security = await deps.store.loadSecurity(securityId);
    if (!security) return { skipped: "unknown_security" };
    const where = { scanRunId: job.scan_run_id, securityId, level: "warn" as const };
    const symbol = secTicker(security);
    const ownSymbols = [security.ticker, security.newsSymbol].filter((s): s is string => !!s);

    let yahoo: NewsItem[] = [];
    if (symbol) {
      try {
        const raw = await deps.yahooNews(symbol);
        yahoo = raw
          .filter((i) => (i.relatedTickers ?? []).some((t) => t === symbol || ownSymbols.includes(t)))
          .map((i): NewsItem => ({ id: i.uuid, title: i.title, link: i.link, publishedAt: iso(i.providerPublishTime) }))
          .sort(newest)
          .slice(0, 50);
      } catch (e) {
        await deps.log("news_source_failed", { source: "yahoo", message: (e as Error).message.slice(0, 200) }, where);
      }
    }

    let cik = security.secCik;
    if (!cik && symbol) {
      const res = await deps.edgar.resolveCik(symbol);
      if (res.ok && res.value) {
        cik = res.value;
        await deps.store.saveSecCik(security.companyId, cik);
      }
    }
    let filings: Filing[] = [];
    if (cik) {
      const res = await deps.edgar.submissions(cik);
      if (res.ok) filings = res.value.filter((f) => WATCH_FORMS.includes(f.form)).slice(0, 30);
      else await deps.log("news_source_failed", { source: "edgar", kind: res.kind }, where);
    }
    const edgar: NewsItem[] = cik
      ? filings.map((f) => ({
          id: f.accession, title: `${f.form} filed ${f.filingDate}`, publishedAt: f.filingDate, form: f.form,
          link: deps.edgar.filingUrl(cik as string, f.accession, f.primaryDocument),
        }))
      : [];

    const rss: NewsItem[] = [];
    for (const url of security.irRssUrls.slice(0, 3)) {
      const res = await deps.fetch.feed(url, { signal: ctx.signal });
      if (!res.ok) {
        await deps.log("news_source_failed", { source: "rss", message: res.message }, where);
        continue;
      }
      for (const item of res.items.slice(0, 20)) {
        rss.push({ id: item.guid, title: item.title, link: item.link, publishedAt: item.published });
      }
    }
    rss.sort(newest);

    await deps.store.setLatestItems(securityId, { yahoo, edgar, rss: rss.slice(0, 50) });

    let attached = 0;
    if (await deps.store.hasPendingCard(job.scan_run_id, securityId)) {
      const settings = await deps.settings();
      const current = await deps.store.currentReport(securityId);
      const finding = current?.completedAt ? await deps.store.hasOpenFindingSince(securityId, current.completedAt) : false;
      const reusable = current !== null && isReusable(current, "new_discount", settings, deps.now()) && !finding;
      if (!reusable && !(await deps.store.hasInflightReport(securityId))) {
        const key = `${securityId}:new_discount:${scanDate}`;
        const report =
          (await deps.store.findReportByKey(key)) ??
          (await deps.store.createReport({
            idempotencyKey: key, securityId, companyId: security.companyId, scanRunId: job.scan_run_id,
            trigger: "new_discount", visibility: "public",
          }));
        if (report.status === "queued") {
          const picked = pickFilings(filings);
          const rows: NewSource[] = [
            ...yahoo.slice(0, 6).map((i): NewSource => ({
              url: i.link, canonicalUrl: canonicalUrl(i.link), title: i.title, publisher: "Yahoo Finance", kind: "yahoo_news",
              publishedAt: i.publishedAt, filingDate: null, excerpt: null, meta: { dateSource: "yahoo" },
            })),
            ...rss.slice(0, 6).map((i): NewSource => ({
              url: i.link, canonicalUrl: canonicalUrl(i.link), title: i.title, publisher: "Company investor relations", kind: "rss",
              publishedAt: i.publishedAt, filingDate: null, excerpt: null, meta: { dateSource: "rss" },
            })),
            ...[picked.annual, picked.interim, ...picked.current]
              .filter((f): f is Filing => f !== null)
              .map((f): NewSource => {
                const url = deps.edgar.filingUrl(cik as string, f.accession, f.primaryDocument);
                return {
                  url, canonicalUrl: canonicalUrl(url), title: `${f.form} filed ${f.filingDate}`, publisher: "SEC EDGAR",
                  kind: "edgar_filing", publishedAt: null, filingDate: f.filingDate, excerpt: null,
                  meta: { form: f.form, accession: f.accession },
                };
              }),
          ].filter((r) => r.url !== "");
          attached = (await deps.store.addSources(report.id, rows)).length;
        }
      }
    }
    return { yahoo: yahoo.length, edgar: edgar.length, rss: rss.length, attached };
  };
}
```

- [ ] **Step 11: Implement `classify:final` and `publish:final` `worker-tick/handlers/classify_final.ts`**

```ts
import { classifyOperational } from "@core/classify.ts";
import type { CardRow, HandlerCtx, Job, ReportRow, ResearchDeps, ResearchStore } from "@adapters/research_types.ts";
import { toFacts } from "./research_steps.ts";

const CATEGORY_RANK: Record<string, number> = { green: 0, amber: 1, red: 2, grey: 3, pending: 4 };

export interface OrderInput {
  id: number;
  mode: string;
  rank: number;
  symbol: string;
  category: string;
}

/** Green, then Amber (cleared cards), then withheld Red, Grey, pending; inside a group rank, then symbol (spec 14.4). */
export function assignDisplayOrder(rows: readonly OrderInput[]): Map<number, number> {
  const byMode = new Map<string, OrderInput[]>();
  for (const row of rows) {
    const list = byMode.get(row.mode) ?? [];
    list.push(row);
    byMode.set(row.mode, list);
  }
  const out = new Map<number, number>();
  for (const list of byMode.values()) {
    list.sort(
      (a, b) =>
        (CATEGORY_RANK[a.category] ?? 9) - (CATEGORY_RANK[b.category] ?? 9) ||
        a.rank - b.rank ||
        (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0),
    );
    list.forEach((row, index) => out.set(row.id, index + 1));
  }
  return out;
}

/**
 * The report a card is judged by: its linked report, or (card not yet linked) the security's current PUBLIC report,
 * possibly older than 30 days: the category stays and the UI marks it "refresh pending" (A-27).
 */
async function reportFor(store: ResearchStore, card: CardRow): Promise<ReportRow | null> {
  if (card.researchReportId) return await store.getReport(card.researchReportId);
  const current = await store.currentReport(card.securityId);
  return current && current.visibility === "public" ? current : null;
}

export interface ResearchCoverage {
  cards: number;
  complete: number;
  pending: number;
  deferred: number;
  failed: number;
  not_configured: number;
  reused: number;
}

export async function researchCoverage(store: ResearchStore, scanRunId: string): Promise<ResearchCoverage> {
  const c: ResearchCoverage = { cards: 0, complete: 0, pending: 0, deferred: 0, failed: 0, not_configured: 0, reused: 0 };
  for (const card of await store.listCards(scanRunId)) {
    c.cards++;
    const r = await reportFor(store, card);
    if (!r || r.status === "queued" || r.status === "running" || r.status === "stale") c.pending++;
    else if (r.status === "complete") {
      c.complete++;
      if (r.scanRunId !== scanRunId) c.reused++;
    } else if (r.status === "quota_deferred") {
      if (r.error === "provider_not_configured") c.not_configured++;
      else c.deferred++;
    } else c.failed++;
  }
  return c;
}

/** Stage 11 `classify:final`: recompute every card of the run from its report (spec 7.4, 4.8). Idempotent. */
export function classifyFinalHandler(deps: Pick<ResearchDeps, "store" | "log">) {
  return async (job: Job): Promise<unknown> => {
    const cards = await deps.store.listCards(job.scan_run_id);
    const resolved: { card: CardRow; report: ReportRow | null; category: string; reasonCode: string }[] = [];
    for (const card of cards) {
      const report = await reportFor(deps.store, card);
      const { category, reasonCode } = classifyOperational(toFacts(report));
      resolved.push({ card, report, category, reasonCode });
    }
    const order = assignDisplayOrder(
      resolved.map((r) => ({ id: r.card.id, mode: r.card.mode, rank: r.card.rank, symbol: r.card.symbol, category: r.category })),
    );
    const counts: Record<string, number> = {};
    for (const r of resolved) {
      counts[r.category] = (counts[r.category] ?? 0) + 1;
      await deps.store.updateCard(r.card.id, {
        reportId: r.report?.id ?? null, category: r.category, reasonCode: r.reasonCode,
        summary: r.report?.summary ?? null, conclusion: r.report?.conclusion ?? null,
        bankruptcyRisk: r.report?.bankruptcyRisk ?? null, completedAt: r.report?.completedAt ?? null,
        displayOrder: order.get(r.card.id) ?? 0,
      });
    }
    await deps.log("classify_final", { cards: cards.length, ...counts }, { scanRunId: job.scan_run_id });
    return { cards: cards.length, categories: counts };
  };
}

/** Stage 11 `publish:final`: `coverage.research` counts, then let P1 recompute the scan status and publication flags. */
export function publishFinalHandler(deps: Pick<ResearchDeps, "store" | "log">) {
  return async (job: Job, _ctx?: HandlerCtx): Promise<unknown> => {
    const coverage = await researchCoverage(deps.store, job.scan_run_id);
    await deps.store.mergeCoverage(job.scan_run_id, { research: coverage });
    await deps.store.refreshScanStatus(job.scan_run_id);
    return coverage;
  };
}
```

- [ ] **Step 12: Implement the registration seam `worker-tick/handlers/p2_register.ts`**

```ts
import type { HandlerCtx, Job, ResearchDeps } from "@adapters/research_types.ts";
import { classifyFinalHandler, publishFinalHandler } from "./classify_final.ts";
import { newsHandler } from "./news.ts";
import { researchHandler } from "./research.ts";
import { seedNewsStage, seedResearchStage } from "./research_seed.ts";

export type Handler = (job: Job, ctx: HandlerCtx) => Promise<unknown>;
export type Seeder = (run: { scanRunId: string; scanDateLocal: string }) => Promise<number>;

export interface P2Registration {
  handlers: { research: Handler; news: Handler };
  /** Wrap P1's `classify` / `publish` handlers: keys `classify:final` and `publish:final` are P2's, the rest stays P1's. */
  wrapClassify(p1: Handler): Handler;
  wrapPublish(p1: Handler): Handler;
  seeders: { news: Seeder; research: Seeder };
}

export function registerP2(deps: ResearchDeps): P2Registration {
  const classifyFinal = classifyFinalHandler(deps);
  const publishFinal = publishFinalHandler(deps);
  return {
    handlers: { research: researchHandler(deps), news: newsHandler(deps) },
    wrapClassify: (p1) => (job, ctx) => (job.key === "classify:final" ? classifyFinal(job) : p1(job, ctx)),
    wrapPublish: (p1) => (job, ctx) => (job.key === "publish:final" ? publishFinal(job, ctx) : p1(job, ctx)),
    seeders: {
      news: (run) => seedNewsStage(deps, run.scanRunId, run.scanDateLocal),
      research: (run) => seedResearchStage(deps, run.scanRunId, run.scanDateLocal),
    },
  };
}
```

- [ ] **Step 13: Implement the `scan-control` action `scan-control/actions/research_now.ts`**

```ts
import type { ResearchStore } from "@adapters/research_types.ts";

export type ResearchNowResult =
  | { ok: true; job_key: string; scan_run_id: string; scan_date_local: string; existing_report_id: string | null }
  | { ok: false; error: "invalid_input" | "unknown_security" | "no_scan_run" };

const ID = /^[\w-]{1,64}$/;

/**
 * Operator request (spec 7.12): queue a `manual` full report for one security in the latest scan run.
 * Idempotent per Sofia day: a second call returns the existing report unless it failed (`force` re-queues a failed one).
 * P1 check: `claim_jobs` must claim research jobs of the latest run even after it finished; if it only claims running
 * runs, call `refresh_scan_status` for the run first.
 */
export async function researchNow(
  deps: { store: Pick<ResearchStore, "loadSecurity" | "latestScanRun" | "enqueueJob" | "findReportByKey"> },
  input: { security_id?: unknown; force?: unknown },
): Promise<ResearchNowResult> {
  const securityId = typeof input.security_id === "string" ? input.security_id : "";
  if (!ID.test(securityId)) return { ok: false, error: "invalid_input" };
  if (!(await deps.store.loadSecurity(securityId))) return { ok: false, error: "unknown_security" };
  const run = await deps.store.latestScanRun();
  if (!run) return { ok: false, error: "no_scan_run" };
  const existing = await deps.store.findReportByKey(`${securityId}:manual:${run.scanDateLocal}`);
  const force = input.force === true;
  if (existing && !(existing.status === "failed" && force)) {
    return { ok: true, job_key: "", scan_run_id: run.id, scan_date_local: run.scanDateLocal, existing_report_id: existing.id };
  }
  const key = `research:${securityId}:manual:plan${existing ? `:${Date.now()}` : ""}`;
  await deps.store.enqueueJob({
    scanRunId: run.id, stage: "research", key, priority: 5,
    payload: { security_id: securityId, trigger: "manual", scan_date_local: run.scanDateLocal, force },
  });
  return { ok: true, job_key: key, scan_run_id: run.id, scan_date_local: run.scanDateLocal, existing_report_id: existing?.id ?? null };
}
```

Register it in the P1 `scan-control` action table with one line (for example `research_now: (req, db) => researchNow({ store: createSupabaseResearchStore(db) }, req.body)`), keeping P1's admin check in front of it.

- [ ] **Step 14: Implement the Supabase store `_shared/adapters/research_store.ts`**

All queries run with the service-role client; no user identifier is ever read into the research path except `risk_monitor_state` rows used to find monitored securities.

```ts
import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  CardPatch, CardRow, CardUpdate, LatestItems, NewJob, NewReport, NewSource, ReportPatch, ReportRow,
  ResearchStore, SecurityContext, SourcePatch, SourceRow,
} from "./research_types.ts";

type Row = Record<string, unknown>;

function fail(op: string, error: { message: string } | null): void {
  if (error) throw new Error(`research store ${op}: ${error.message}`);
}

const REPORT_COLUMNS: Record<string, string> = {
  scanRunId: "scan_run_id", status: "status", step: "step", notBefore: "not_before", isCurrent: "is_current",
  visibility: "visibility", reportMd: "report_md", summary: "summary", newsSummary: "news_summary",
  conclusion: "conclusion", bankruptcyRisk: "bankruptcy_risk", materialDamageEstablished: "material_damage_established",
  sufficientEvidence: "sufficient_evidence", citedEvidenceIds: "cited_evidence_ids", claims: "claims",
  missingDocuments: "missing_documents", limitations: "limitations", researchCutoffDate: "research_cutoff_date",
  startedAt: "started_at", completedAt: "completed_at", provider: "provider", model: "model",
  promptVersion: "prompt_version", schemaVersion: "schema_version", usage: "usage", queriesUsed: "queries_used",
  docsFetched: "docs_fetched", error: "error", supersedesId: "supersedes_id", trigger: "trigger",
};

const toReport = (r: Row): ReportRow => ({
  id: r.id as string, securityId: r.security_id as string, companyId: r.company_id as string,
  scanRunId: (r.scan_run_id as string | null) ?? null, trigger: r.trigger as ReportRow["trigger"],
  status: r.status as ReportRow["status"], step: (r.step as string | null) ?? null,
  notBefore: (r.not_before as string | null) ?? null, isCurrent: Boolean(r.is_current),
  visibility: r.visibility as ReportRow["visibility"], reportMd: (r.report_md as string | null) ?? null,
  summary: (r.summary as string | null) ?? null, newsSummary: (r.news_summary as string | null) ?? null,
  conclusion: (r.conclusion as ReportRow["conclusion"]) ?? null,
  bankruptcyRisk: (r.bankruptcy_risk as ReportRow["bankruptcyRisk"]) ?? null,
  materialDamageEstablished: (r.material_damage_established as boolean | null) ?? null,
  sufficientEvidence: (r.sufficient_evidence as boolean | null) ?? null,
  citedEvidenceIds: (r.cited_evidence_ids as number[] | null) ?? [], claims: r.claims ?? [],
  missingDocuments: (r.missing_documents as string[] | null) ?? [], limitations: (r.limitations as string[] | null) ?? [],
  researchCutoffDate: (r.research_cutoff_date as string | null) ?? null, startedAt: (r.started_at as string | null) ?? null,
  completedAt: (r.completed_at as string | null) ?? null, provider: (r.provider as string | null) ?? null,
  model: (r.model as string | null) ?? null, promptVersion: (r.prompt_version as string | null) ?? null,
  schemaVersion: (r.schema_version as string | null) ?? null, usage: (r.usage as ReportRow["usage"]) ?? {},
  queriesUsed: Number(r.queries_used ?? 0), docsFetched: Number(r.docs_fetched ?? 0), error: (r.error as string | null) ?? null,
  supersedesId: (r.supersedes_id as string | null) ?? null, idempotencyKey: r.idempotency_key as string,
});

const toSource = (r: Row): SourceRow => ({
  reportId: r.report_id as string, evidenceId: Number(r.evidence_id), url: r.url as string,
  canonicalUrl: r.canonical_url as string, title: (r.title as string | null) ?? null, publisher: (r.publisher as string | null) ?? null,
  kind: r.kind as SourceRow["kind"], publishedAt: (r.published_at as string | null) ?? null,
  filingDate: (r.filing_date as string | null) ?? null, retrievedAt: (r.retrieved_at as string | null) ?? null,
  httpStatus: (r.http_status as number | null) ?? null, contentType: (r.content_type as string | null) ?? null,
  contentHash: (r.content_hash as string | null) ?? null, excerpt: (r.excerpt as string | null) ?? null,
  extracted: (r.extracted as SourceRow["extracted"]) ?? [], livenessVerifiedAt: (r.liveness_verified_at as string | null) ?? null,
  verification: r.verification as SourceRow["verification"], usedInReport: Boolean(r.used_in_report),
  meta: (r.meta as SourceRow["meta"]) ?? {},
});

const SOURCE_COLUMNS: Record<string, string> = {
  title: "title", publisher: "publisher", kind: "kind", publishedAt: "published_at", filingDate: "filing_date",
  retrievedAt: "retrieved_at", httpStatus: "http_status", contentType: "content_type", contentHash: "content_hash",
  excerpt: "excerpt", extracted: "extracted", livenessVerifiedAt: "liveness_verified_at", verification: "verification",
  usedInReport: "used_in_report", meta: "meta", url: "url", canonicalUrl: "canonical_url",
};

function mapPatch(patch: Record<string, unknown>, columns: Record<string, string>): Row {
  const out: Row = {};
  for (const [key, value] of Object.entries(patch)) {
    const column = columns[key];
    if (column && value !== undefined) out[column] = value;
  }
  return out;
}

const utcDayStart = (now: Date) => now.toISOString().slice(0, 10);
const utcMonthStart = (now: Date) => `${now.toISOString().slice(0, 7)}-01`;

export function createSupabaseResearchStore(db: SupabaseClient, now: () => Date = () => new Date()): ResearchStore {
  const reportById = async (id: string): Promise<ReportRow | null> => {
    const { data, error } = await db.from("research_reports").select("*").eq("id", id).maybeSingle();
    fail("getReport", error);
    return data ? toReport(data as Row) : null;
  };
  const listSources = async (reportId: string): Promise<SourceRow[]> => {
    const { data, error } = await db.from("research_sources").select("*").eq("report_id", reportId).order("evidence_id");
    fail("listSources", error);
    return ((data ?? []) as Row[]).map(toSource);
  };

  return {
    async loadSecurity(securityId): Promise<SecurityContext | null> {
      const { data, error } = await db
        .from("securities")
        .select("id, company_id, yahoo_symbol, financial_currency, currency_major, companies(name, sector, industry, sec_cik, ir_rss_urls, news_symbol), exchanges(name)")
        .eq("id", securityId)
        .maybeSingle();
      fail("loadSecurity", error);
      if (!data) return null;
      const row = data as unknown as Row & { companies: Row; exchanges: Row };
      return {
        securityId: row.id as string, companyId: row.company_id as string, companyName: row.companies.name as string,
        ticker: row.yahoo_symbol as string, primaryExchange: (row.exchanges?.name as string) ?? "",
        reportingCurrency: ((row.financial_currency as string | null) ?? (row.currency_major as string)) || "",
        sector: (row.companies.sector as string | null) ?? null, industry: (row.companies.industry as string | null) ?? null,
        secCik: (row.companies.sec_cik as string | null) ?? null, irRssUrls: (row.companies.ir_rss_urls as string[] | null) ?? [],
        newsSymbol: (row.companies.news_symbol as string | null) ?? null,
      };
    },
    async saveSecCik(companyId, cik) {
      const { error } = await db.from("companies").update({ sec_cik: cik }).eq("id", companyId);
      fail("saveSecCik", error);
    },
    async hasDiscountCard(securityId) {
      const { count, error } = await db.from("todays_discounts").select("id", { count: "exact", head: true }).eq("security_id", securityId);
      fail("hasDiscountCard", error);
      return (count ?? 0) > 0;
    },
    async findReportByKey(key) {
      const { data, error } = await db.from("research_reports").select("*").eq("idempotency_key", key).maybeSingle();
      fail("findReportByKey", error);
      return data ? toReport(data as Row) : null;
    },
    async createReport(input: NewReport) {
      const { error } = await db.from("research_reports").upsert(
        {
          idempotency_key: input.idempotencyKey, security_id: input.securityId, company_id: input.companyId,
          scan_run_id: input.scanRunId, trigger: input.trigger, visibility: input.visibility, kind: "full",
        },
        { onConflict: "idempotency_key", ignoreDuplicates: true },
      );
      fail("createReport", error);
      const { data, error: readError } = await db.from("research_reports").select("*").eq("idempotency_key", input.idempotencyKey).single();
      fail("createReport(read)", readError);
      return toReport(data as Row);
    },
    getReport: reportById,
    async patchReport(id, patch: ReportPatch) {
      const { error } = await db.from("research_reports").update(mapPatch(patch, REPORT_COLUMNS)).eq("id", id);
      fail("patchReport", error);
    },
    async deleteReport(id) {
      const unlink = await db.from("todays_discounts").update({ research_report_id: null }).eq("research_report_id", id);
      fail("deleteReport(unlink)", unlink.error);
      const { error } = await db.from("research_reports").delete().eq("id", id);
      fail("deleteReport", error);
    },
    async currentReport(securityId) {
      const { data, error } = await db.from("research_reports").select("*").eq("security_id", securityId).eq("is_current", true).maybeSingle();
      fail("currentReport", error);
      return data ? toReport(data as Row) : null;
    },
    async hasInflightReport(securityId) {
      const { count, error } = await db.from("research_reports").select("id", { count: "exact", head: true })
        .eq("security_id", securityId).in("status", ["running", "quota_deferred"]);
      fail("hasInflightReport", error);
      return (count ?? 0) > 0;
    },
    async hasAnyReport(securityId) {
      const { count, error } = await db.from("research_reports").select("id", { count: "exact", head: true }).eq("security_id", securityId);
      fail("hasAnyReport", error);
      return (count ?? 0) > 0;
    },
    async hasOpenFindingSince(securityId, sinceIso) {
      const { count, error } = await db.from("risk_findings").select("id", { count: "exact", head: true })
        .eq("security_id", securityId).is("resolved_at", null).gt("detected_at", sinceIso);
      fail("hasOpenFindingSince", error);
      return (count ?? 0) > 0;
    },
    async promoteReport(reportId) {
      const { data, error } = await db.rpc("promote_research_report_rpc", { p_report_id: reportId });
      fail("promoteReport", error);
      return (data as string | null) ?? null;
    },
    listSources,
    async addSources(reportId, rows: NewSource[]) {
      const existing = await listSources(reportId);
      const seen = new Set(existing.map((s) => s.canonicalUrl));
      let nextId = Math.max(0, ...existing.map((s) => s.evidenceId)) + 1;
      const payload: Row[] = [];
      for (const r of rows) {
        if (seen.has(r.canonicalUrl)) continue;
        seen.add(r.canonicalUrl);
        payload.push({
          report_id: reportId, evidence_id: nextId++, url: r.url, canonical_url: r.canonicalUrl, title: r.title,
          publisher: r.publisher, kind: r.kind, published_at: r.publishedAt, filing_date: r.filingDate,
          excerpt: r.excerpt, meta: r.meta,
        });
      }
      if (payload.length === 0) return [];
      const { data, error } = await db.from("research_sources").insert(payload).select();
      fail("addSources", error);
      return ((data ?? []) as Row[]).map(toSource);
    },
    async patchSource(reportId, evidenceId, patch: SourcePatch) {
      const { error } = await db.from("research_sources").update(mapPatch(patch, SOURCE_COLUMNS))
        .eq("report_id", reportId).eq("evidence_id", evidenceId);
      fail("patchSource", error);
    },
    async clearSources(reportId) {
      const { error } = await db.from("research_sources").delete().eq("report_id", reportId);
      fail("clearSources", error);
    },
    async putWorkText(reportId, evidenceId, text) {
      const { error } = await db.from("research_work_texts").upsert({ report_id: reportId, evidence_id: evidenceId, text }, { onConflict: "report_id,evidence_id" });
      fail("putWorkText", error);
    },
    async getWorkText(reportId, evidenceId) {
      const { data, error } = await db.from("research_work_texts").select("text").eq("report_id", reportId).eq("evidence_id", evidenceId).maybeSingle();
      fail("getWorkText", error);
      return (data as { text: string } | null)?.text ?? null;
    },
    async deleteWorkTexts(reportId) {
      const { error } = await db.from("research_work_texts").delete().eq("report_id", reportId);
      fail("deleteWorkTexts", error);
    },
    async consumeQuota(provider, resource, amount, period, limit) {
      const { data, error } = await db.rpc("consume_quota_rpc", {
        p_provider: provider, p_resource: resource, p_amount: amount, p_period_kind: period, p_limit: limit,
      });
      fail("consumeQuota", error);
      return data === true;
    },
    async quotaUsed(provider, resource, period) {
      const start = period === "day" ? utcDayStart(now()) : utcMonthStart(now());
      const { data, error } = await db.from("ai_quota_usage").select("used")
        .eq("provider", provider).eq("resource", resource).eq("period_kind", period).eq("period_start", start).maybeSingle();
      fail("quotaUsed", error);
      return Number((data as { used: number } | null)?.used ?? 0);
    },
    async enqueueJob(job: NewJob) {
      const { error } = await db.from("scan_jobs").upsert(
        {
          scan_run_id: job.scanRunId, stage: job.stage, key: job.key, payload: job.payload, priority: job.priority ?? 100,
          ...(job.notBefore ? { not_before: job.notBefore } : {}),
        },
        { onConflict: "scan_run_id,stage,key", ignoreDuplicates: true },
      );
      fail("enqueueJob", error);
    },
    async applyReportToCards(u: CardUpdate) {
      const { data, error } = await db.from("todays_discounts").update({
        operational_category: u.category, category_reason: u.reasonCode,
        withheld: !(u.category === "green" || u.category === "amber"),
        ...(u.reportId ? { research_report_id: u.reportId } : {}),
        research_summary: u.summary, conclusion: u.conclusion, bankruptcy_risk: u.bankruptcyRisk,
        research_completed_at: u.completedAt,
      }).eq("scan_run_id", u.scanRunId).eq("security_id", u.securityId).select("id");
      fail("applyReportToCards", error);
      return (data ?? []).length;
    },
    async hasPendingCard(scanRunId, securityId) {
      const { count, error } = await db.from("todays_discounts").select("id", { count: "exact", head: true })
        .eq("scan_run_id", scanRunId).eq("security_id", securityId).eq("operational_category", "pending");
      fail("hasPendingCard", error);
      return (count ?? 0) > 0;
    },
    async listCards(scanRunId) {
      const { data, error } = await db.from("todays_discounts")
        .select("id, mode, security_id, rank, operational_category, research_report_id, securities(yahoo_symbol)")
        .eq("scan_run_id", scanRunId);
      fail("listCards", error);
      return ((data ?? []) as unknown as Row[]).map((r): CardRow => ({
        id: Number(r.id), mode: r.mode as string, securityId: r.security_id as string, rank: Number(r.rank),
        symbol: ((r.securities as Row | null)?.yahoo_symbol as string) ?? "", researchReportId: (r.research_report_id as string | null) ?? null,
        operationalCategory: r.operational_category as string,
      }));
    },
    async updateCard(id, patch: CardPatch) {
      const { error } = await db.from("todays_discounts").update({
        operational_category: patch.category, category_reason: patch.reasonCode,
        withheld: !(patch.category === "green" || patch.category === "amber"), research_report_id: patch.reportId,
        research_summary: patch.summary, conclusion: patch.conclusion, bankruptcy_risk: patch.bankruptcyRisk,
        research_completed_at: patch.completedAt, display_order: patch.displayOrder,
      }).eq("id", id);
      fail("updateCard", error);
    },
    async updateMonitorReport(securityId, reportId, category) {
      const { error } = await db.from("risk_monitor_state").update({ last_report_id: reportId, last_category: category }).eq("security_id", securityId);
      fail("updateMonitorReport", error);
    },
    async setLatestItems(securityId, latest: LatestItems) {
      const { data, error } = await db.from("risk_monitor_state").select("user_id, last_seen_items").eq("security_id", securityId);
      fail("setLatestItems(read)", error);
      for (const row of (data ?? []) as { user_id: string; last_seen_items: Row | null }[]) {
        const update = await db.from("risk_monitor_state")
          .update({ last_seen_items: { ...(row.last_seen_items ?? {}), latest } })
          .eq("user_id", row.user_id).eq("security_id", securityId);
        fail("setLatestItems", update.error);
      }
    },
    async mergeCoverage(scanRunId, patch) {
      const { data, error } = await db.from("scan_runs").select("coverage").eq("id", scanRunId).single();
      fail("mergeCoverage(read)", error);
      const merged = { ...((data as { coverage: Row } | null)?.coverage ?? {}), ...patch };
      const update = await db.from("scan_runs").update({ coverage: merged }).eq("id", scanRunId);
      fail("mergeCoverage", update.error);
    },
    async refreshScanStatus(scanRunId) {
      const { error } = await db.rpc("refresh_scan_status", { p_run: scanRunId });
      fail("refreshScanStatus", error);
    },
    async latestScanRun() {
      const { data, error } = await db.from("scan_runs").select("id, scan_date_local").order("scan_date_local", { ascending: false }).limit(1).maybeSingle();
      fail("latestScanRun", error);
      const row = data as { id: string; scan_date_local: string } | null;
      return row ? { id: row.id, scanDateLocal: row.scan_date_local } : null;
    },
    async listPendingDiscountSecurities(scanRunId) {
      const { data, error } = await db.from("todays_discounts").select("security_id").eq("scan_run_id", scanRunId).eq("operational_category", "pending");
      fail("listPendingDiscountSecurities", error);
      const ids = [...new Set(((data ?? []) as { security_id: string }[]).map((r) => r.security_id))];
      if (ids.length === 0) return [];
      const busy = await db.from("research_reports").select("security_id").in("security_id", ids).in("status", ["running", "quota_deferred"]);
      fail("listPendingDiscountSecurities(inflight)", busy.error);
      const inflight = new Set(((busy.data ?? []) as { security_id: string }[]).map((r) => r.security_id));
      return ids.filter((id) => !inflight.has(id));
    },
    async listPremiumSecurities(scanRunId) {
      const { data, error } = await db.from("signal_episodes").select("security_id")
        .eq("opened_scan_run_id", scanRunId).in("kind", ["premium1", "premium2"]);
      fail("listPremiumSecurities", error);
      return [...new Set(((data ?? []) as { security_id: string }[]).map((r) => r.security_id))];
    },
    async listStaleCurrentReports(olderThanIso) {
      const { data, error } = await db.from("research_reports").select("id, security_id")
        .eq("is_current", true).eq("status", "complete").lt("completed_at", olderThanIso);
      fail("listStaleCurrentReports", error);
      const stale = (data ?? []) as { id: string; security_id: string }[];
      if (stale.length === 0) return [];
      const ids = stale.map((s) => s.security_id);
      const monitored = await db.from("risk_monitor_state").select("security_id").in("security_id", ids).eq("status", "active");
      fail("listStaleCurrentReports(monitor)", monitored.error);
      const cards = await db.from("todays_discounts").select("security_id").in("security_id", ids);
      fail("listStaleCurrentReports(cards)", cards.error);
      const active = new Set([
        ...((monitored.data ?? []) as { security_id: string }[]).map((r) => r.security_id),
        ...((cards.data ?? []) as { security_id: string }[]).map((r) => r.security_id),
      ]);
      return stale.filter((s) => active.has(s.security_id)).map((s) => ({ securityId: s.security_id, reportId: s.id }));
    },
    async listDeferred(nowIso) {
      const { data, error } = await db.from("research_reports").select("*").eq("status", "quota_deferred").lte("not_before", nowIso);
      fail("listDeferred", error);
      return ((data ?? []) as Row[]).map(toReport);
    },
    async listNewsTargets(scanRunId) {
      const cards = await db.from("todays_discounts").select("security_id").eq("scan_run_id", scanRunId);
      fail("listNewsTargets(cards)", cards.error);
      const monitored = await db.from("risk_monitor_state").select("security_id").eq("status", "active");
      fail("listNewsTargets(monitor)", monitored.error);
      return [...new Set([
        ...((cards.data ?? []) as { security_id: string }[]).map((r) => r.security_id),
        ...((monitored.data ?? []) as { security_id: string }[]).map((r) => r.security_id),
      ])];
    },
  };
}
```

- [ ] **Step 15: Implement the dependency builder `_shared/adapters/providers.ts`**

```ts
import type { SupabaseClient } from "@supabase/supabase-js";
import { createEdgarClient } from "./fetchers/edgar.ts";
import { fetchDocument } from "./fetchers/direct.ts";
import { fetchFeed } from "./fetchers/rss.ts";
import { readViaJina } from "./fetchers/jina.ts";
import { createLlmProviders } from "./llm/index.ts";
import type { FetchLike } from "./llm/types.ts";
import { scanEvent } from "./log.ts";
import { createSupabaseResearchStore } from "./research_store.ts";
import { DEFAULT_RESEARCH_SETTINGS, type ResearchDeps, type ResearchSettings } from "./research_types.ts";
import { createTavilyClient } from "./search/tavily.ts";
import { news as yahooNews } from "./yahoo.ts";

export type Env = Record<string, string | undefined>;

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Builds the research dependencies from function secrets. `fetchImpl` is injected by fixture mode (Task 8);
 * production passes nothing and every adapter uses the global `fetch`.
 */
export function createResearchDeps(env: Env, db: SupabaseClient, fetchImpl?: FetchLike): ResearchDeps {
  const store = createSupabaseResearchStore(db);
  const providers = createLlmProviders(env, fetchImpl);
  const secUserAgent = env.SEC_USER_AGENT ?? "";
  let cached: ResearchSettings | null = null;
  return {
    store,
    llm: providers.byName,
    llmOrder: providers.order,
    tavily: createTavilyClient({ apiKey: env.TAVILY_API_KEY, fetchImpl }),
    fetch: {
      direct: (url, opts) => fetchDocument(url, { fetchImpl, ...opts }),
      jina: (url, opts) => readViaJina(url, { fetchImpl, ...opts }),
      feed: (url, opts) => fetchFeed(url, { fetchImpl, ...opts }),
    },
    edgar: createEdgarClient({ userAgent: secUserAgent, fetchImpl }),
    yahooNews,
    async settings() {
      if (cached) return cached;
      const { data } = await db.from("app_settings").select("value").eq("key", "research").maybeSingle();
      cached = { ...DEFAULT_RESEARCH_SETTINGS, ...((data as { value: Partial<ResearchSettings> } | null)?.value ?? {}) };
      return cached;
    },
    now: () => new Date(),
    sha256: sha256Hex,
    log: async (event, data, ctx) => {
      await scanEvent(db, {
        event, level: ctx?.level ?? "info", data: data ?? {},
        ...(ctx?.scanRunId ? { scan_run_id: ctx.scanRunId } : {}),
        ...(ctx?.securityId ? { security_id: ctx.securityId } : {}),
      });
    },
    secUserAgent,
    jinaApiKey: env.JINA_API_KEY,
  };
}
```

`createResearchDeps` is called once per `worker-tick` invocation, so the settings cache lives for one invocation (at most 150 s); a `set_setting` change is picked up by the next tick.

- [ ] **Step 16: Wire P2 into the P1 registries and document the new secrets**

Three one-line merges, each in a file P1 owns (find the exact spots with the `git grep` of step 1):

```ts
// worker-tick (where HANDLERS and the seeder registry are built; once per invocation)
import { createResearchDeps } from "@adapters/providers.ts";
import { registerP2 } from "./handlers/p2_register.ts";

const p2 = registerP2(createResearchDeps(Deno.env.toObject(), serviceClient()));
HANDLERS.research = p2.handlers.research;
HANDLERS.news = p2.handlers.news;
HANDLERS.classify = p2.wrapClassify(HANDLERS.classify); // key "classify:final" is P2's, "classify:initial" stays P1's
HANDLERS.publish = p2.wrapPublish(HANDLERS.publish);   // key "publish:final"
SEEDERS.news = p2.seeders.news;                         // seeded when portfolio_scan is terminal
SEEDERS.research = p2.seeders.research;                 // seeded when news is terminal
// STAGE_CAPS: research: 2 (spec 7.4); news: 1
```

```ts
// scan-control action table
research_now: (body, db) => researchNow({ store: createSupabaseResearchStore(db) }, body),
```

Append to `supabase/functions/.env.example` (names only, no values):

```text
# P2 research
GEMINI_API_KEY=
GEMINI_MODEL=
LLM_PRIMARY=gemini
LLM_ALT_PROVIDER=
LLM_ALT_BASE_URL=
LLM_ALT_API_KEY=
LLM_ALT_MODEL=
TAVILY_API_KEY=
JINA_API_KEY=
SEC_USER_AGENT=
```

- [ ] **Step 17: Run the whole Deno suite, the type checks and the linters**

Run: `deno test -A --config supabase/functions/deno.json supabase/functions/worker-tick/handlers supabase/functions/scan-control`
Expected: PASS (research 21, news 4, classify_final 3, seeds 2, research_now 2).

Run: `bun run functions:check` then `bun run typecheck` then `bun run lint:fix` then `bun run lint`
Expected: exit 0. Common first-run findings: an `exactOptionalPropertyTypes` complaint where an optional property receives `undefined` (use a conditional spread or widen the property with `| undefined`), and Biome `noNonNullAssertion` warnings (none are required by this code).

- [ ] **Step 18: Commit**

```text
git add supabase/functions/_shared/adapters/research_types.ts supabase/functions/_shared/adapters/research_store.ts supabase/functions/_shared/adapters/providers.ts supabase/functions/worker-tick supabase/functions/scan-control supabase/functions/.env.example
git commit -m "feat(research): add worker research steps, news stage, classify:final, quota deferral and research_now"
```

---

### Task 6: Material-change monitor (`core/risk.ts`, `adapters/monitor_store.ts`, `handlers/risk_check.ts`)

**Files:**
- Create: `supabase/functions/_shared/core/risk.ts`, `risk.test.ts`
- Create: `supabase/functions/_shared/adapters/monitor_store.ts`
- Create: `supabase/functions/worker-tick/handlers/risk_check.ts`, `risk_check.test.ts`, `testing/fake_monitor.ts`
- Modify: `supabase/functions/worker-tick/handlers/p2_register.ts` (Task 5): `registerP2(deps, monitor?)` attaches `deps.changeCheck` and `deps.seedExtras`; and the call site in `worker-tick` passes `createSupabaseMonitorStore(db)`.

**Interfaces:**
- Consumes: Task 5 (`ResearchDeps`, `researchHandler` dispatch on `payload.kind = "change_check"`, `chooseProvider`, `tavilySpecs`, `ResearchStore.enqueueJob/consumeQuota/hasAnyReport/loadSecurity`), Task 4 (`WATCH_FORMS`, `JsonSchemaObject`), Task 3 (`canonicalUrl`).
- Produces: core `NEWS_KEYWORDS`, `matchKeywords`, `computeDelta`, `isEmptyDelta`, `isFirstObservation`, `mergeSeen`, `strongestKeyword`, `MATERIAL_CRITERIA`, `CHANGE_SYSTEM`, `CHANGE_CLASSIFICATION_SCHEMA`, `buildChangeUser`, `validateChangeOutput`, `fingerprintInput`, `findingAction`; `MonitorStore` + `createSupabaseMonitorStore(db)`; `riskCheckHandler(deps, monitor)`; `seedChecks(deps, monitor)`.
- Job: stage `research`, key `research:<security_id>:check`, payload `{ kind: "change_check", security_id, scan_date_local }`, priority 50. One job per security; findings fan out to every user who monitors it.
- Algorithm (spec 9.7): (5) no report yet means enqueue `monitor_first` regardless of delta; first observation only records the baseline (the full report covers it); (1) delta = `latest` minus `seen` (EDGAR watch forms, RSS guids, keyword-matching Yahoo titles, A-29); (2) empty delta updates `last_check_at` and nothing else (no search, no model); (3) otherwise reserve one change-check slot, at most one Tavily query and one small model call; (4) material means findings (fingerprint = sha256 of category plus sorted canonical primary URLs, duplicates updated not re-inserted) and one `monitor_change` full report; (6) `seen` is updated only after a classification succeeded, so a deferred check is retried the next day.

- [ ] **Step 1: Write the failing core tests `core/risk.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import {
  CHANGE_CLASSIFICATION_SCHEMA, CHANGE_SYSTEM, MATERIAL_CRITERIA, NEWS_KEYWORDS, buildChangeUser, computeDelta,
  findingAction, fingerprintInput, isEmptyDelta, isFirstObservation, matchKeywords, mergeSeen, strongestKeyword,
  validateChangeOutput, type ChangeItem, type ItemLike,
} from "./risk.ts";

const item = (id: string, title: string, over: Partial<ItemLike> = {}): ItemLike => ({
  id, title, link: `https://x.example/${id}`, publishedAt: "2026-10-14T00:00:00.000Z", ...over,
});

describe("keyword filter (A-29)", () => {
  it("lists the fifteen keywords of spec 9.7, strongest first", () => {
    expect(NEWS_KEYWORDS).toHaveLength(15);
    expect(NEWS_KEYWORDS[0]).toBe("going concern");
  });
  it("matches whole words with common suffixes, case-insensitively", () => {
    expect(matchKeywords("Moody's DOWNGRADED Acme after covenant waiver")).toEqual(["covenant", "downgrade"]);
    expect(matchKeywords("Regulators probe Acme; lawsuits follow")).toEqual(["probe", "lawsuit"]);
    expect(matchKeywords("Acme raises capital  raise plans? profit warning issued")).toEqual(["profit warning", "capital raise"].filter((k) => k === "profit warning"));
    expect(matchKeywords("Acme launches a new product")).toEqual([]);
    expect(matchKeywords("A problem with the website")).toEqual([]);
  });
  it("picks the strongest keyword", () => {
    expect(strongestKeyword(["guidance", "bankruptcy"])).toBe("bankruptcy");
    expect(strongestKeyword([])).toBeNull();
  });
});

describe("computeDelta", () => {
  const latest = {
    edgar: [item("a1", "8-K filed", { form: "8-K" }), item("a2", "SC 13G filed", { form: "SC 13G" }), item("a3", "10-Q filed", { form: "10-Q" })],
    rss: [item("r1", "Press release"), item("r2", "Another release")],
    yahoo: [item("y1", "Acme downgrade looms"), item("y2", "Acme opens new store")],
  };
  it("counts new watch-form filings, any new RSS item, and keyword-matching Yahoo titles", () => {
    const d = computeDelta({ edgar: ["a3"], rss: ["r2"], yahoo: [] }, latest);
    expect(d.edgar.map((i) => i.id)).toEqual(["a1"]);
    expect(d.rss.map((i) => i.id)).toEqual(["r1"]);
    expect(d.yahoo.map((i) => i.id)).toEqual(["y1"]);
    expect(d.keywords).toEqual(["downgrade"]);
    expect(isEmptyDelta(d)).toBe(false);
  });
  it("is empty when everything was seen or irrelevant", () => {
    const d = computeDelta({ edgar: ["a1", "a2", "a3"], rss: ["r1", "r2"], yahoo: ["y1"] }, latest);
    expect(isEmptyDelta(d)).toBe(true);
    expect(isEmptyDelta(computeDelta({}, { yahoo: [item("y2", "Acme opens new store")] }))).toBe(true);
  });
  it("detects a first observation and merges seen ids with a cap", () => {
    expect(isFirstObservation({})).toBe(true);
    expect(isFirstObservation({ edgar: [] })).toBe(true);
    expect(isFirstObservation({ edgar: ["a"] })).toBe(false);
    const merged = mergeSeen({ edgar: ["a", "b"] }, latest, 3);
    expect(merged.edgar).toEqual(["b", "a1", "a2"]);
    expect(merged.rss).toEqual(["r1", "r2"]);
  });
});

describe("classification prompt, schema and validation", () => {
  it("states the six material-change categories and the fixed output schema", () => {
    for (const c of ["liquidity_debt", "credit_rating", "accounting_audit", "regulatory_legal", "guidance", "governance"]) {
      expect(MATERIAL_CRITERIA).toContain(c);
      expect(CHANGE_SYSTEM).toContain(c);
    }
    expect(CHANGE_CLASSIFICATION_SCHEMA.required).toEqual(["material", "category", "severity", "summary", "evidence_ids"]);
    expect(CHANGE_CLASSIFICATION_SCHEMA.additionalProperties).toBe(false);
  });

  it("keeps the user message inside 4k tokens and numbers the items", () => {
    const items: ChangeItem[] = Array.from({ length: 40 }, (_, i) => ({
      id: i + 1, kind: "rss", title: `Item ${i + 1}`, date: "2026-10-14", excerpt: "x".repeat(2000), primary: true, url: `https://x.example/${i}`,
    }));
    const text = buildChangeUser({ company: "Acme", ticker: "ACME", previous: { category: "green", summary: "Stable.", date: "2026-09-20" }, items });
    expect(text.length).toBeLessThanOrEqual(16_000);
    expect(text).toContain("[E1]");
    expect(text).toContain("PREVIOUS ASSESSMENT: category=green");
    expect(text).toMatch(/further items omitted/);
    expect(buildChangeUser({ company: "Acme", ticker: "ACME", previous: null, items: [] })).toContain("PREVIOUS ASSESSMENT: none");
  });

  it("accepts a valid answer and rejects unknown ids, categories and shapes", () => {
    const good = { material: true, category: "liquidity_debt", severity: "material", summary: "Going concern doubt.", evidence_ids: [1] };
    expect(validateChangeOutput(good, [1, 2])).toEqual({ ok: true, output: good });
    expect(validateChangeOutput({ ...good, evidence_ids: [9] }, [1, 2]).ok).toBe(false);
    expect(validateChangeOutput({ ...good, category: "weather" }, [1]).ok).toBe(false);
    expect(validateChangeOutput({ ...good, summary: "" }, [1]).ok).toBe(false);
    expect(validateChangeOutput("nope", [1]).ok).toBe(false);
    expect(validateChangeOutput({ ...good, material: true, evidence_ids: [] }, [1]).ok).toBe(false);
  });
});

describe("findings", () => {
  it("fingerprint input is the category plus the sorted, de-duplicated canonical URLs", () => {
    expect(fingerprintInput("liquidity_debt", ["https://b.example/2", "https://a.example/1", "https://b.example/2"])).toBe(
      "liquidity_debt\nhttps://a.example/1\nhttps://b.example/2",
    );
    expect(fingerprintInput("guidance", [])).toBe("guidance\n");
  });
  it("updates an open finding when there is no new primary-source evidence, otherwise inserts", () => {
    expect(findingAction(null, ["https://a.example/1"])).toBe("insert");
    expect(findingAction({ primaryUrls: ["https://a.example/1"] }, ["https://a.example/1"])).toBe("update");
    expect(findingAction({ primaryUrls: ["https://a.example/1"] }, [])).toBe("update");
    expect(findingAction({ primaryUrls: ["https://a.example/1"] }, ["https://a.example/2"])).toBe("insert");
  });
});
```

- [ ] **Step 2: Run to see the tests fail**

Run: `bun run test:core -- risk`
Expected: FAIL with `Failed to resolve import "./risk.ts"`.

- [ ] **Step 3: Implement `core/risk.ts`**

```ts
// supabase/functions/_shared/core/risk.ts
// Pure logic of the material-change monitor (spec 9.7). No Date, URL, console, fetch or randomness.
import { WATCH_FORMS, type JsonSchemaObject } from "./research.ts";

/** Yahoo news keyword pre-filter (A-29), strongest first. */
export const NEWS_KEYWORDS = [
  "going concern", "bankruptcy", "default", "covenant", "downgrade", "restatement", "investigation", "probe",
  "lawsuit", "fraud", "guidance", "profit warning", "recall", "delisting", "capital raise",
] as const;

const PATTERNS = NEWS_KEYWORDS.map((keyword) => ({ keyword, re: new RegExp(`\\b${keyword.replace(/ /g, "\\s+")}`, "i") }));

/** Whole-word-start match, so "downgraded", "lawsuits" and "defaulted" count but "problem" is not "probe". */
export function matchKeywords(title: string): string[] {
  return PATTERNS.filter(({ re }) => re.test(title)).map(({ keyword }) => keyword);
}

export function strongestKeyword(keywords: readonly string[]): string | null {
  return NEWS_KEYWORDS.find((k) => keywords.includes(k)) ?? null;
}

export interface ItemLike {
  id: string;
  title: string;
  link: string;
  publishedAt: string | null;
  form?: string | undefined;
}
export interface SeenItems {
  yahoo?: string[];
  edgar?: string[];
  rss?: string[];
}
export interface LatestLike {
  yahoo?: ItemLike[];
  edgar?: ItemLike[];
  rss?: ItemLike[];
}
export interface Delta {
  edgar: ItemLike[];
  rss: ItemLike[];
  yahoo: ItemLike[];
  keywords: string[];
}

/** New items since the last acknowledged check (spec 9.7 step 1). */
export function computeDelta(seen: SeenItems, latest: LatestLike): Delta {
  const seenEdgar = new Set(seen.edgar ?? []);
  const seenRss = new Set(seen.rss ?? []);
  const seenYahoo = new Set(seen.yahoo ?? []);
  const edgar = (latest.edgar ?? []).filter((i) => !seenEdgar.has(i.id) && WATCH_FORMS.includes(i.form ?? ""));
  const rss = (latest.rss ?? []).filter((i) => !seenRss.has(i.id));
  const yahoo = (latest.yahoo ?? []).filter((i) => !seenYahoo.has(i.id) && matchKeywords(i.title).length > 0);
  const keywords = [...new Set([...yahoo, ...rss].flatMap((i) => matchKeywords(i.title)))];
  return { edgar, rss, yahoo, keywords };
}

export const isEmptyDelta = (d: Delta): boolean => d.edgar.length + d.rss.length + d.yahoo.length === 0;

/** Nothing acknowledged yet: the first check records a baseline; the full report covers the history. */
export function isFirstObservation(seen: SeenItems): boolean {
  return (seen.edgar?.length ?? 0) + (seen.rss?.length ?? 0) + (seen.yahoo?.length ?? 0) === 0;
}

/** Acknowledges every latest id, keeping the newest `cap` ids per channel. */
export function mergeSeen(seen: SeenItems, latest: LatestLike, cap = 200): SeenItems {
  const merge = (old: string[] | undefined, items: ItemLike[] | undefined): string[] => {
    const ids = [...(old ?? [])];
    for (const i of items ?? []) if (!ids.includes(i.id)) ids.push(i.id);
    return ids.slice(-cap);
  };
  return { edgar: merge(seen.edgar, latest.edgar), rss: merge(seen.rss, latest.rss), yahoo: merge(seen.yahoo, latest.yahoo) };
}

export const CHANGE_CATEGORIES = [
  "liquidity_debt", "guidance", "accounting_audit", "regulatory_legal", "credit_rating", "governance", "other",
] as const;
export type ChangeCategory = (typeof CHANGE_CATEGORIES)[number];

/** Explicit material-change criteria (A-29); the classification call receives this list. */
export const MATERIAL_CRITERIA = [
  "- liquidity_debt: going-concern doubt; covenant breach or waiver request; missed payment or grace period; distressed exchange or restructuring; failed or very costly refinancing; emergency equity raise; debt maturity wall not covered by liquidity.",
  "- credit_rating: downgrade to below investment grade, or a downgrade of two or more notches, or a negative watch from a major agency.",
  "- accounting_audit: restatement or non-reliance on prior statements; auditor resignation or qualified opinion; late annual or quarterly filing (NT forms).",
  "- regulatory_legal: formal investigation, fraud allegation, sanction threatening a licence or capital (banks and insurers: capital shortfall or supervisory action), litigation with potentially balance-sheet-level impact.",
  "- guidance: guidance withdrawal, profit warning or a cut large enough to change the investment thesis.",
  "- governance: abrupt CEO or CFO exit together with another red flag.",
].join("\n");

export const CHANGE_SYSTEM = [
  "You decide whether NEW public items about ONE listed company are a material change for a long-term shareholder.",
  "You have no other knowledge and no web access. Use only the numbered items you are given and cite them by id in evidence_ids.",
  "Set material=true only when an item meets one of the criteria below; otherwise set material=false, category \"other\" and severity \"watch\".",
  "summary is one or two plain sentences. Never invent facts, figures or sources.",
  "",
  "MATERIAL CHANGE CRITERIA",
  MATERIAL_CRITERIA,
].join("\n");

export const CHANGE_CLASSIFICATION_SCHEMA: JsonSchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["material", "category", "severity", "summary", "evidence_ids"],
  properties: {
    material: { type: "boolean" },
    category: { type: "string", enum: [...CHANGE_CATEGORIES] },
    severity: { type: "string", enum: ["material", "watch"] },
    summary: { type: "string" },
    evidence_ids: { type: "array", items: { type: "integer" } },
  },
};

export interface ChangeItem {
  id: number;
  kind: "edgar_filing" | "rss" | "yahoo_news" | "search_result";
  title: string;
  date: string | null;
  excerpt: string;
  /** Primary source: an SEC filing or a company investor-relations feed item. */
  primary: boolean;
  url: string;
}

const CHANGE_USER_MAX_CHARS = 16_000; // about 4k tokens

export function buildChangeUser(ctx: {
  company: string;
  ticker: string;
  previous: { category: string | null; summary: string | null; date: string | null } | null;
  items: readonly ChangeItem[];
}): string {
  const previous = ctx.previous
    ? `category=${ctx.previous.category ?? "unknown"}; summary=${ctx.previous.summary ?? "none"}; date=${ctx.previous.date ?? "unknown"}`
    : "none";
  const head = [`COMPANY: ${ctx.company} (${ctx.ticker})`, `PREVIOUS ASSESSMENT: ${previous}`, "NEW ITEMS:"];
  const blocks: string[] = [];
  let used = head.join("\n").length + 60;
  let omitted = 0;
  for (const i of ctx.items) {
    const block = `[E${i.id}] kind=${i.kind} date=${i.date ?? "not available"} title="${i.title.replace(/\s+/g, " ").replace(/"/g, "'")}"\n     excerpt: ${i.excerpt.replace(/\s+/g, " ").slice(0, 400)}`;
    if (used + block.length + 1 > CHANGE_USER_MAX_CHARS) {
      omitted++;
      continue;
    }
    blocks.push(block);
    used += block.length + 1;
  }
  return [...head, ...blocks, ...(omitted > 0 ? [`(${omitted} further items omitted for length)`] : [])].join("\n");
}

export interface ChangeOutput {
  material: boolean;
  category: ChangeCategory;
  severity: "material" | "watch";
  summary: string;
  evidence_ids: number[];
}

export function validateChangeOutput(
  raw: unknown,
  allowedIds: readonly number[],
): { ok: true; output: ChangeOutput } | { ok: false; message: string } {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, message: "not an object" };
  const o = raw as Record<string, unknown>;
  if (typeof o.material !== "boolean") return { ok: false, message: "material must be a boolean" };
  if (!(CHANGE_CATEGORIES as readonly string[]).includes(String(o.category))) return { ok: false, message: "unknown category" };
  if (o.severity !== "material" && o.severity !== "watch") return { ok: false, message: "unknown severity" };
  if (typeof o.summary !== "string" || o.summary.trim() === "") return { ok: false, message: "summary is required" };
  if (!Array.isArray(o.evidence_ids) || !o.evidence_ids.every((n) => Number.isInteger(n))) {
    return { ok: false, message: "evidence_ids must be integers" };
  }
  const ids = o.evidence_ids as number[];
  if (ids.some((id) => !allowedIds.includes(id))) return { ok: false, message: "unknown evidence id" };
  if (o.material && ids.length === 0) return { ok: false, message: "a material change must cite evidence" };
  return {
    ok: true,
    output: { material: o.material, category: o.category as ChangeCategory, severity: o.severity, summary: o.summary.trim().slice(0, 400), evidence_ids: ids },
  };
}

/** Input of `sha256(category + sorted canonical primary URLs)` (spec 9.7 step 4). */
export function fingerprintInput(category: string, canonicalUrls: readonly string[]): string {
  return `${category}\n${[...new Set(canonicalUrls)].sort().join("\n")}`;
}

/** An open finding of the same category with no new primary-source evidence is only updated. */
export function findingAction(
  open: { primaryUrls: readonly string[] } | null,
  newPrimaryUrls: readonly string[],
): "insert" | "update" {
  if (!open) return "insert";
  return newPrimaryUrls.every((u) => open.primaryUrls.includes(u)) ? "update" : "insert";
}
```

- [ ] **Step 4: Run the core tests**

Run: `bun run test:core -- risk`
Expected: PASS (about 10 tests). The `matchKeywords("Acme raises capital  raise plans? profit warning issued")` assertion in step 1 is intentionally written so that only the `profit warning` keyword remains ("capital raise" needs the words in that order); if it fails, simplify that single line to `expect(matchKeywords("Profit warning issued")).toEqual(["profit warning"])`.

- [ ] **Step 5: Write the monitor store `_shared/adapters/monitor_store.ts`**

```ts
import type { SupabaseClient } from "@supabase/supabase-js";
import type { LatestLike, SeenItems } from "../core/risk.ts";

export interface MonitorRow {
  userId: string;
  securityId: string;
  lastReportId: string | null;
  lastCategory: string | null;
  seen: SeenItems;
  latest: LatestLike;
  lastCheckAt: string | null;
  nextDueAt: string | null;
}

export interface OpenFinding {
  id: string;
  category: string;
  fingerprint: string;
  primaryUrls: string[];
}

export interface NewFinding {
  userId: string;
  securityId: string;
  fingerprint: string;
  category: string;
  severity: "material" | "watch";
  summary: string;
  evidence: { id: number; url: string; title: string; primary: boolean }[];
}

export interface MonitorStore {
  /** Active monitor rows of one security (one per monitoring user). */
  rows(securityId: string): Promise<MonitorRow[]>;
  /** Securities with at least one active row that is due. */
  listDue(nowIso: string): Promise<string[]>;
  touch(securityId: string, patch: { lastCheckAt: string; nextDueAt: string; seen?: SeenItems }): Promise<void>;
  openFinding(userId: string, securityId: string, category: string): Promise<OpenFinding | null>;
  /** False when the (user, security, fingerprint) finding already exists. */
  insertFinding(finding: NewFinding): Promise<boolean>;
  updateFinding(id: string, patch: { summary: string; severity: string; evidence: NewFinding["evidence"] }): Promise<void>;
  previousAssessment(securityId: string): Promise<{ category: string | null; summary: string | null; date: string | null } | null>;
}

type Row = Record<string, unknown>;
const check = (op: string, error: { message: string; code?: string } | null): void => {
  if (error) throw new Error(`monitor store ${op}: ${error.message}`);
};

export function createSupabaseMonitorStore(db: SupabaseClient): MonitorStore {
  return {
    async rows(securityId) {
      const { data, error } = await db
        .from("risk_monitor_state")
        .select("user_id, security_id, last_report_id, last_category, last_seen_items, last_check_at, next_due_at")
        .eq("security_id", securityId)
        .eq("status", "active");
      check("rows", error);
      return ((data ?? []) as Row[]).map((r) => {
        const items = (r.last_seen_items as { seen?: SeenItems; latest?: LatestLike } | null) ?? {};
        return {
          userId: r.user_id as string, securityId: r.security_id as string, lastReportId: (r.last_report_id as string | null) ?? null,
          lastCategory: (r.last_category as string | null) ?? null, seen: items.seen ?? {}, latest: items.latest ?? {},
          lastCheckAt: (r.last_check_at as string | null) ?? null, nextDueAt: (r.next_due_at as string | null) ?? null,
        };
      });
    },
    async listDue(nowIso) {
      const { data, error } = await db
        .from("risk_monitor_state")
        .select("security_id")
        .eq("status", "active")
        .or(`next_due_at.is.null,next_due_at.lte.${nowIso}`);
      check("listDue", error);
      return [...new Set(((data ?? []) as { security_id: string }[]).map((r) => r.security_id))];
    },
    async touch(securityId, patch) {
      const { data, error } = await db.from("risk_monitor_state").select("user_id, last_seen_items").eq("security_id", securityId);
      check("touch(read)", error);
      for (const row of (data ?? []) as { user_id: string; last_seen_items: Row | null }[]) {
        const items = row.last_seen_items ?? {};
        const update = await db
          .from("risk_monitor_state")
          .update({
            last_check_at: patch.lastCheckAt, next_due_at: patch.nextDueAt,
            last_seen_items: patch.seen ? { ...items, seen: patch.seen } : items,
          })
          .eq("user_id", row.user_id)
          .eq("security_id", securityId);
        check("touch", update.error);
      }
    },
    async openFinding(userId, securityId, category) {
      const { data, error } = await db
        .from("risk_findings")
        .select("id, category, fingerprint, evidence")
        .eq("user_id", userId).eq("security_id", securityId).eq("category", category).is("resolved_at", null)
        .order("detected_at", { ascending: false }).limit(1).maybeSingle();
      check("openFinding", error);
      if (!data) return null;
      const row = data as { id: string; category: string; fingerprint: string; evidence: { url: string; primary: boolean }[] | null };
      return {
        id: row.id, category: row.category, fingerprint: row.fingerprint,
        primaryUrls: (row.evidence ?? []).filter((e) => e.primary).map((e) => e.url),
      };
    },
    async insertFinding(f) {
      const { error } = await db.from("risk_findings").insert({
        user_id: f.userId, security_id: f.securityId, fingerprint: f.fingerprint, category: f.category,
        severity: f.severity, summary: f.summary, evidence: f.evidence,
      });
      if (error?.code === "23505") return false;
      check("insertFinding", error);
      return true;
    },
    async updateFinding(id, patch) {
      const { error } = await db.from("risk_findings").update({ summary: patch.summary, severity: patch.severity, evidence: patch.evidence }).eq("id", id);
      check("updateFinding", error);
    },
    async previousAssessment(securityId) {
      const { data, error } = await db.from("risk_monitor_state").select("last_report_id, last_category").eq("security_id", securityId).limit(1).maybeSingle();
      check("previousAssessment", error);
      const state = data as { last_report_id: string | null; last_category: string | null } | null;
      if (!state?.last_report_id) return state ? { category: state.last_category, summary: null, date: null } : null;
      const report = await db.from("research_reports").select("summary, completed_at").eq("id", state.last_report_id).maybeSingle();
      check("previousAssessment(report)", report.error);
      const r = report.data as { summary: string | null; completed_at: string | null } | null;
      return { category: state.last_category, summary: r?.summary ?? null, date: r?.completed_at?.slice(0, 10) ?? null };
    },
  };
}
```

- [ ] **Step 6: Write the in-memory fake `worker-tick/handlers/testing/fake_monitor.ts` and the failing handler tests**

`testing/fake_monitor.ts`:

```ts
import type { LatestLike, SeenItems } from "@core/risk.ts";
import type { MonitorRow, MonitorStore, NewFinding, OpenFinding } from "@adapters/monitor_store.ts";

export interface FakeFinding extends NewFinding {
  id: string;
  resolved: boolean;
}

export class FakeMonitor implements MonitorStore {
  monitorRows: MonitorRow[] = [];
  findings: FakeFinding[] = [];
  touched: { securityId: string; lastCheckAt: string; nextDueAt: string; seen?: SeenItems }[] = [];
  previous: { category: string | null; summary: string | null; date: string | null } | null = null;
  private seq = 0;

  addRow(over: Partial<MonitorRow> & { userId: string; securityId: string }): MonitorRow {
    const row: MonitorRow = {
      lastReportId: null, lastCategory: null, seen: {}, latest: {}, lastCheckAt: null, nextDueAt: null, ...over,
    };
    this.monitorRows.push(row);
    return row;
  }
  async rows(securityId: string) {
    return structuredClone(this.monitorRows.filter((r) => r.securityId === securityId));
  }
  async listDue(nowIso: string) {
    return [...new Set(this.monitorRows.filter((r) => r.nextDueAt === null || r.nextDueAt <= nowIso).map((r) => r.securityId))];
  }
  async touch(securityId: string, patch: { lastCheckAt: string; nextDueAt: string; seen?: SeenItems }) {
    this.touched.push({ securityId, ...patch });
    for (const r of this.monitorRows.filter((x) => x.securityId === securityId)) {
      r.lastCheckAt = patch.lastCheckAt;
      r.nextDueAt = patch.nextDueAt;
      if (patch.seen) r.seen = patch.seen;
    }
  }
  async openFinding(userId: string, securityId: string, category: string): Promise<OpenFinding | null> {
    const f = this.findings.find((x) => x.userId === userId && x.securityId === securityId && x.category === category && !x.resolved);
    return f ? { id: f.id, category: f.category, fingerprint: f.fingerprint, primaryUrls: f.evidence.filter((e) => e.primary).map((e) => e.url) } : null;
  }
  async insertFinding(f: NewFinding) {
    if (this.findings.some((x) => x.userId === f.userId && x.securityId === f.securityId && x.fingerprint === f.fingerprint)) return false;
    this.findings.push({ ...f, id: `f-${++this.seq}`, resolved: false });
    return true;
  }
  async updateFinding(id: string, patch: { summary: string; severity: string; evidence: NewFinding["evidence"] }) {
    const f = this.findings.find((x) => x.id === id);
    if (f) Object.assign(f, { summary: patch.summary, severity: patch.severity as FakeFinding["severity"], evidence: patch.evidence });
  }
  async previousAssessment() {
    return this.previous;
  }
  setLatest(securityId: string, latest: LatestLike) {
    for (const r of this.monitorRows.filter((x) => x.securityId === securityId)) r.latest = latest;
  }
}
```

`risk_check.test.ts`:

```ts
import { assert, assertEquals } from "jsr:@std/assert@1";
import type { Job } from "@adapters/research_types.ts";
import { CHANGE_SYSTEM } from "@core/risk.ts";
import { researchHandler } from "./research.ts";
import { riskCheckHandler, seedChecks } from "./risk_check.ts";
import { FakeMonitor } from "./testing/fake_monitor.ts";
import { makeWorld, scriptedResponder, type World } from "./testing/fakes.ts";

const EIGHT_K = {
  id: "0000000001-26-000099", title: "8-K filed 2026-10-14", form: "8-K", publishedAt: "2026-10-14",
  link: "https://www.sec.gov/Archives/edgar/data/1/000000000126000099/k8.htm",
};
const checkJob = (): Job => ({
  id: 1, scan_run_id: "run-1", stage: "research", key: "research:sec-1:check",
  payload: { kind: "change_check", security_id: "sec-1", scan_date_local: "2026-10-15" },
});
const ctx = () => ({ signal: new AbortController().signal, deadline: performance.now() + 60_000 });
const MATERIAL = { material: true, category: "liquidity_debt", severity: "material", summary: "Going-concern doubt disclosed.", evidence_ids: [1] };

function setup() {
  const w = makeWorld();
  w.deps.sha256 = async (text) => `h:${text}`;
  const monitor = new FakeMonitor();
  const answer = { value: MATERIAL as unknown };
  const inner = scriptedResponder(() => w.verdict.value);
  w.llm.responder = (req) =>
    req.system === CHANGE_SYSTEM ? { ok: true, usage: { input: 10, output: 5 }, model: "fake-model", json: answer.value } : inner(req);
  const handler = riskCheckHandler(w.deps, monitor);
  return { w, monitor, answer, handler };
}
const seenAll = { edgar: ["old-1"], rss: ["old-r"], yahoo: ["old-y"] };
const withReport = { lastReportId: "rep-0" };
const jobsOf = (w: World, stage = "research") => w.store.jobs.filter((j) => j.stage === stage).map((j) => j.key);

Deno.test("first observation records a baseline without any search or model call", async () => {
  const { w, monitor, handler } = setup();
  monitor.addRow({ userId: "u1", securityId: "sec-1", ...withReport, latest: { edgar: [EIGHT_K] } });
  const res = (await handler(checkJob(), ctx())) as { outcome: string };
  assertEquals(res.outcome, "baseline");
  assertEquals(monitor.monitorRows[0]?.seen.edgar, [EIGHT_K.id]);
  assertEquals(w.tavily.queries.length + w.llm.calls.length, 0);
});

Deno.test("no delta: only last_check_at moves; no search, no model call, no quota", async () => {
  const { w, monitor, handler } = setup();
  monitor.addRow({ userId: "u1", securityId: "sec-1", ...withReport, seen: { edgar: [EIGHT_K.id] }, latest: { edgar: [EIGHT_K] } });
  const res = (await handler(checkJob(), ctx())) as { outcome: string };
  assertEquals(res.outcome, "no_delta");
  assertEquals(w.tavily.queries.length + w.llm.calls.length, 0);
  assertEquals(w.store.quota.size, 0);
  assertEquals(monitor.touched.length, 1);
  assertEquals(monitor.touched[0]?.seen, undefined, "seen is not rewritten");
  assertEquals(monitor.monitorRows[0]?.nextDueAt, "2026-10-16T04:00:00.000Z");
});

Deno.test("no report yet: monitor_first is enqueued regardless of delta", async () => {
  const { w, monitor, handler } = setup();
  monitor.addRow({ userId: "u1", securityId: "sec-1", seen: { edgar: [EIGHT_K.id] }, latest: { edgar: [EIGHT_K] } });
  await handler(checkJob(), ctx());
  assertEquals(jobsOf(w), ["research:sec-1:monitor_first:plan"]);
  const job = w.store.jobs[0];
  assertEquals([job?.priority, job?.payload.trigger], [30, "monitor_first"]);
});

Deno.test("delta, not material: one Tavily query and one small call, no finding, seen updated", async () => {
  const { w, monitor, answer, handler } = setup();
  answer.value = { material: false, category: "other", severity: "watch", summary: "Routine filing.", evidence_ids: [1] };
  monitor.addRow({ userId: "u1", securityId: "sec-1", ...withReport, seen: seenAll, latest: { edgar: [EIGHT_K] } });
  const res = (await handler(checkJob(), ctx())) as { outcome: string };
  assertEquals(res.outcome, "not_material");
  assertEquals([w.tavily.queries.length, w.llm.calls.length], [1, 1]);
  assertEquals(w.tavily.queries[0], "Acme Corp ACME announcement");
  assertEquals(monitor.findings.length, 0);
  assertEquals(jobsOf(w), []);
  assert(monitor.monitorRows[0]?.seen.edgar?.includes(EIGHT_K.id));
  assertEquals(w.store.quota.get("research|change_checks|day"), 1);
});

Deno.test("material: findings for every monitoring user, fingerprint over category and primary URLs, one monitor_change report", async () => {
  const { w, monitor, handler } = setup();
  monitor.previous = { category: "green", summary: "Stable.", date: "2026-09-20" };
  for (const userId of ["u1", "u2"]) monitor.addRow({ userId, securityId: "sec-1", ...withReport, seen: seenAll, latest: { edgar: [EIGHT_K] } });
  const res = (await handler(checkJob(), ctx())) as { outcome: string };
  assertEquals(res.outcome, "material");
  const expected = `h:liquidity_debt\n${EIGHT_K.link}`;
  assertEquals(monitor.findings.map((f) => [f.userId, f.fingerprint, f.category, f.severity]), [
    ["u1", expected, "liquidity_debt", "material"], ["u2", expected, "liquidity_debt", "material"],
  ]);
  assertEquals(monitor.findings[0]?.evidence, [{ id: 1, url: EIGHT_K.link, title: EIGHT_K.title, primary: true }]);
  assertEquals(jobsOf(w), ["research:sec-1:monitor_change:plan"]);
  const job = w.store.jobs[0];
  assertEquals([job?.priority, job?.payload.trigger], [40, "monitor_change"]);
  assert(w.llm.calls[0]?.user.includes("PREVIOUS ASSESSMENT: category=green"));
  assert(!JSON.stringify(w.llm.calls).includes("u1"), "no user id reaches the model");
});

Deno.test("duplicate suppression: same primary evidence updates the open finding; new primary evidence inserts and re-queues", async () => {
  const { w, monitor, handler } = setup();
  monitor.addRow({ userId: "u1", securityId: "sec-1", ...withReport, seen: seenAll, latest: { edgar: [EIGHT_K] } });
  await handler(checkJob(), ctx());
  assertEquals(monitor.findings.length, 1);
  // the same item is reported again (for example the seen list was reset): the open finding is only updated
  monitor.monitorRows[0]!.seen = seenAll;
  await handler({ ...checkJob(), key: "research:sec-1:check:2" }, ctx());
  assertEquals(monitor.findings.length, 1);
  assertEquals(jobsOf(w), ["research:sec-1:monitor_change:plan"], "no second report job");
  // a different 8-K is new primary-source evidence
  const other = { ...EIGHT_K, id: "0000000001-26-000100", link: "https://www.sec.gov/Archives/edgar/data/1/000000000126000100/k8.htm" };
  monitor.monitorRows[0]!.seen = seenAll;
  monitor.setLatest("sec-1", { edgar: [other] });
  await handler({ ...checkJob(), key: "research:sec-1:check:3" }, ctx());
  assertEquals(monitor.findings.length, 2);
});

Deno.test("quota: daily check cap, LLM cap and missing provider defer without marking anything seen; Tavily denial still classifies", async () => {
  const cap = setup();
  cap.monitor.addRow({ userId: "u1", securityId: "sec-1", ...withReport, seen: seenAll, latest: { edgar: [EIGHT_K] } });
  cap.w.settings.value = { ...cap.w.settings.value, max_change_checks_per_day: 0 };
  assertEquals(((await cap.handler(checkJob(), ctx())) as { outcome: string }).outcome, "deferred_cap");
  assertEquals(cap.w.llm.calls.length + cap.w.tavily.queries.length, 0);
  assertEquals(cap.monitor.monitorRows[0]?.seen, seenAll);

  const llm = setup();
  llm.monitor.addRow({ userId: "u1", securityId: "sec-1", ...withReport, seen: seenAll, latest: { edgar: [EIGHT_K] } });
  llm.w.settings.value = { ...llm.w.settings.value, llm_daily_request_cap: 0 };
  assertEquals(((await llm.handler(checkJob(), ctx())) as { outcome: string }).outcome, "deferred_llm");
  assertEquals(llm.monitor.findings.length, 0);

  const none = makeWorld({ configured: false });
  const monitor = new FakeMonitor();
  monitor.addRow({ userId: "u1", securityId: "sec-1", ...withReport, seen: seenAll, latest: { edgar: [EIGHT_K] } });
  assertEquals(((await riskCheckHandler(none.deps, monitor)(checkJob(), ctx())) as { outcome: string }).outcome, "deferred_provider");

  const noSearch = setup();
  noSearch.monitor.addRow({ userId: "u1", securityId: "sec-1", ...withReport, seen: seenAll, latest: { edgar: [EIGHT_K] } });
  noSearch.w.settings.value = { ...noSearch.w.settings.value, tavily_daily_cap: 0 };
  const res = (await noSearch.handler(checkJob(), ctx())) as { outcome: string };
  assertEquals(res.outcome, "material");
  assertEquals([noSearch.w.tavily.queries.length, noSearch.w.llm.calls.length], [0, 1]);
});

Deno.test("an invalid answer is retried once, then the check is left unacknowledged; http failures throw", async () => {
  const { w, monitor, answer, handler } = setup();
  answer.value = { nonsense: true };
  monitor.addRow({ userId: "u1", securityId: "sec-1", ...withReport, seen: seenAll, latest: { edgar: [EIGHT_K] } });
  const res = (await handler(checkJob(), ctx())) as { outcome: string };
  assertEquals(res.outcome, "llm_invalid");
  assertEquals(w.llm.calls.length, 2);
  assertEquals(monitor.monitorRows[0]?.seen, seenAll);
  w.llm.responder = () => ({ ok: false, kind: "http", status: 503, message: "down" });
  let thrown = "";
  try {
    await handler(checkJob(), ctx());
  } catch (e) {
    thrown = (e as Error).message;
  }
  assert(thrown.includes("llm http"));
});

Deno.test("Yahoo titles need a keyword; unmatched titles never trigger a check", async () => {
  const { w, monitor, handler } = setup();
  monitor.addRow({
    userId: "u1", securityId: "sec-1", ...withReport, seen: seenAll,
    latest: { yahoo: [{ id: "y9", title: "Acme opens a new store", link: "https://finance.yahoo.com/n/y9", publishedAt: null }] },
  });
  assertEquals(((await handler(checkJob(), ctx())) as { outcome: string }).outcome, "no_delta");
  monitor.setLatest("sec-1", { yahoo: [{ id: "y10", title: "Acme faces fraud probe", link: "https://finance.yahoo.com/n/y10", publishedAt: null }] });
  assertEquals(((await handler(checkJob(), ctx())) as { outcome: string }).outcome, "material");
  assertEquals(w.tavily.queries[0], "Acme Corp ACME fraud", "the strongest keyword drives the query");
  assertEquals(monitor.findings[0]?.evidence[0]?.primary, false, "Yahoo news is never primary evidence");
});

Deno.test("the seeder queues one check per due security and the research dispatcher routes it", async () => {
  const { w, monitor, answer } = setup();
  answer.value = { material: false, category: "other", severity: "watch", summary: "Routine.", evidence_ids: [] };
  monitor.addRow({ userId: "u1", securityId: "sec-1", ...withReport, seen: { edgar: [EIGHT_K.id] }, latest: { edgar: [EIGHT_K] }, nextDueAt: "2026-10-14T00:00:00.000Z" });
  monitor.addRow({ userId: "u1", securityId: "sec-2", ...withReport, nextDueAt: "2026-10-17T00:00:00.000Z" });
  const seed = seedChecks(w.deps, monitor);
  assertEquals(await seed("run-1", "2026-10-15"), 1);
  await seed("run-1", "2026-10-15");
  const job = w.store.jobs[0];
  assertEquals([job?.key, job?.priority, job?.payload.kind], ["research:sec-1:check", 50, "change_check"]);
  w.deps.changeCheck = riskCheckHandler(w.deps, monitor);
  const res = (await researchHandler(w.deps)({ id: 1, scan_run_id: "run-1", stage: "research", key: job?.key ?? "", payload: job?.payload ?? {} }, ctx())) as { outcome: string };
  assertEquals(res.outcome, "no_delta");
});
```

Run: `bun run test:core -- risk` (passes after step 3) and `deno test -A --config supabase/functions/deno.json supabase/functions/worker-tick/handlers/risk_check.test.ts`
Expected: the Deno file FAILS with `Module not found "file:///.../risk_check.ts"`.

- [ ] **Step 7: Implement the handler `worker-tick/handlers/risk_check.ts`**

```ts
import {
  CHANGE_CLASSIFICATION_SCHEMA, CHANGE_SYSTEM, buildChangeUser, computeDelta, findingAction, fingerprintInput,
  isEmptyDelta, isFirstObservation, mergeSeen, strongestKeyword, validateChangeOutput,
  type ChangeItem, type ChangeOutput, type ItemLike,
} from "@core/risk.ts";
import { canonicalUrl } from "@adapters/fetchers/extract.ts";
import type { MonitorStore } from "@adapters/monitor_store.ts";
import type { HandlerCtx, Job, ResearchDeps } from "@adapters/research_types.ts";
import { TRIGGER_PRIORITY, chooseProvider, tavilySpecs } from "./research_steps.ts";

const NEXT_DUE_HOURS = 20; // due again at tomorrow's scan, whatever its exact start time
const CHECK_PRIORITY = 50;

/** Seeds one `research:<security_id>:check` job per security with a due monitor row (stage 10 seeder extra). */
export function seedChecks(deps: ResearchDeps, monitor: MonitorStore) {
  return async (scanRunId: string, scanDateLocal: string): Promise<number> => {
    const due = await monitor.listDue(deps.now().toISOString());
    for (const securityId of due) {
      await deps.store.enqueueJob({
        scanRunId, stage: "research", key: `research:${securityId}:check`, priority: CHECK_PRIORITY,
        payload: { kind: "change_check", security_id: securityId, scan_date_local: scanDateLocal },
      });
    }
    return due.length;
  };
}

type Outcome =
  | "skipped" | "baseline" | "no_delta" | "deferred_cap" | "deferred_llm" | "deferred_provider" | "llm_invalid"
  | "not_material" | "material";

export function riskCheckHandler(deps: ResearchDeps, monitor: MonitorStore) {
  return async (job: Job, ctx: HandlerCtx): Promise<{ outcome: Outcome; detail?: string }> => {
    const securityId = String(job.payload.security_id ?? "");
    const scanDate = String(job.payload.scan_date_local ?? "");
    const scope = { scanRunId: job.scan_run_id, securityId };
    const now = deps.now();
    const nowIso = now.toISOString();
    const nextDueAt = new Date(now.getTime() + NEXT_DUE_HOURS * 3_600_000).toISOString();

    const security = await deps.store.loadSecurity(securityId);
    const rows = await monitor.rows(securityId);
    const head = rows[0];
    if (!security || !head) return { outcome: "skipped", detail: security ? "not_monitored" : "unknown_security" };

    // Step 5: no report yet means a full `monitor_first` report regardless of the delta.
    if (!(await deps.store.hasAnyReport(securityId))) {
      await deps.store.enqueueJob({
        scanRunId: job.scan_run_id, stage: "research", key: `research:${securityId}:monitor_first:plan`,
        priority: TRIGGER_PRIORITY.monitor_first,
        payload: { security_id: securityId, trigger: "monitor_first", scan_date_local: scanDate },
      });
    }

    if (isFirstObservation(head.seen)) {
      await monitor.touch(securityId, { lastCheckAt: nowIso, nextDueAt, seen: mergeSeen({}, head.latest) });
      return { outcome: "baseline" };
    }
    const delta = computeDelta(head.seen, head.latest);
    // Step 2: nothing new means no search and no model call.
    if (isEmptyDelta(delta)) {
      await monitor.touch(securityId, { lastCheckAt: nowIso, nextDueAt });
      return { outcome: "no_delta" };
    }

    const settings = await deps.settings();
    if (!(await deps.store.consumeQuota("research", "change_checks", 1, "day", settings.max_change_checks_per_day))) {
      await deps.log("research_quota_deferred", { check: "daily_cap" }, { ...scope, level: "warn" });
      return { outcome: "deferred_cap" };
    }
    const provider = await chooseProvider(deps, settings);
    if (!provider) {
      await deps.log("llm_error", { check: "provider_not_configured" }, { ...scope, level: "warn" });
      return { outcome: "deferred_provider" };
    }

    // Numbered evidence: EDGAR filings and company IR items are primary; Yahoo headlines and search hits are not.
    const items: ChangeItem[] = [];
    const add = (kind: ChangeItem["kind"], i: ItemLike, primary: boolean, excerpt = "") =>
      items.push({ id: items.length + 1, kind, title: i.title, date: i.publishedAt, excerpt, primary, url: i.link });
    for (const i of delta.edgar) add("edgar_filing", i, true);
    for (const i of delta.rss) add("rss", i, true);
    for (const i of delta.yahoo) add("yahoo_news", i, false);

    // At most one Tavily query per check, only when the credits allow it.
    const keyword = strongestKeyword(delta.keywords) ?? "announcement";
    let granted = true;
    for (const spec of tavilySpecs(settings, false)) {
      if (!(await deps.store.consumeQuota(spec.provider, spec.resource, 1, spec.period, spec.limit))) {
        granted = false;
        break;
      }
    }
    if (granted) {
      const res = await deps.tavily.search(`${security.companyName} ${security.ticker} ${keyword}`, ctx.signal);
      if (res.ok) {
        for (const h of res.results.slice(0, 3)) {
          add("search_result", { id: h.url, title: h.title, link: h.url, publishedAt: h.publishedDate ?? null }, false, h.snippet);
        }
      }
    }

    const previous = await monitor.previousAssessment(securityId);
    const user = buildChangeUser({ company: security.companyName, ticker: security.ticker, previous, items });
    const allowed = items.map((i) => i.id);
    let answer: ChangeOutput | null = null;
    for (let attempt = 1; attempt <= 2 && !answer; attempt++) {
      if (!(await deps.store.consumeQuota(provider.name, "llm_requests", 1, "day", settings.llm_daily_request_cap))) {
        await deps.log("research_quota_deferred", { check: "llm_cap" }, { ...scope, level: "warn" });
        return { outcome: "deferred_llm" };
      }
      const res = await provider.generateJson<unknown>({
        system: CHANGE_SYSTEM, user, schema: CHANGE_CLASSIFICATION_SCHEMA, schemaName: "change_check",
        maxOutputTokens: 1024, temperature: 0.1, signal: ctx.signal,
      });
      if (!res.ok) {
        await deps.log("llm_error", { kind: res.kind, check: true }, { ...scope, level: "warn" });
        if (res.kind === "rate_limited" || res.kind === "quota") return { outcome: "deferred_llm" };
        if (res.kind === "not_configured") return { outcome: "deferred_provider" };
        if (res.kind === "invalid_json" || res.kind === "schema") continue;
        throw new Error(`llm ${res.kind}: ${res.message}`);
      }
      const checked = validateChangeOutput(res.json, allowed);
      if (checked.ok) answer = checked.output;
    }
    if (!answer) return { outcome: "llm_invalid" }; // left unacknowledged: retried at the next scan

    const acknowledge = async () => {
      await monitor.touch(securityId, { lastCheckAt: nowIso, nextDueAt, seen: mergeSeen(head.seen, head.latest) });
    };
    if (!answer.material) {
      await acknowledge();
      return { outcome: "not_material", detail: answer.category };
    }

    const cited = items.filter((i) => answer.evidence_ids.includes(i.id));
    const evidence = cited.map((i) => ({ id: i.id, url: canonicalUrl(i.url), title: i.title, primary: i.primary }));
    const primaryUrls = evidence.filter((e) => e.primary).map((e) => e.url);
    const fingerprint = await deps.sha256(fingerprintInput(answer.category, primaryUrls.length > 0 ? primaryUrls : evidence.map((e) => e.url)));
    let inserted = false;
    for (const row of rows) {
      const open = await monitor.openFinding(row.userId, securityId, answer.category);
      if (findingAction(open, primaryUrls) === "update" && open) {
        await monitor.updateFinding(open.id, { summary: answer.summary, severity: answer.severity, evidence });
      } else if (await monitor.insertFinding({
        userId: row.userId, securityId, fingerprint, category: answer.category, severity: answer.severity, summary: answer.summary, evidence,
      })) {
        inserted = true;
      }
    }
    if (inserted) {
      await deps.store.enqueueJob({
        scanRunId: job.scan_run_id, stage: "research", key: `research:${securityId}:monitor_change:plan`,
        priority: TRIGGER_PRIORITY.monitor_change,
        payload: { security_id: securityId, trigger: "monitor_change", scan_date_local: scanDate },
      });
    }
    await acknowledge();
    await deps.log("research_complete", { check: "material", category: answer.category, new_finding: inserted }, scope);
    return { outcome: "material", detail: answer.category };
  };
}
```

- [ ] **Step 8: Update `p2_register.ts` so the monitor is attached when a store is passed**

Replace the head of `registerP2` with:

```ts
import type { MonitorStore } from "@adapters/monitor_store.ts";
import { riskCheckHandler, seedChecks } from "./risk_check.ts";

export function registerP2(deps: ResearchDeps, monitor?: MonitorStore): P2Registration {
  if (monitor) {
    deps.changeCheck = riskCheckHandler(deps, monitor);
    deps.seedExtras = seedChecks(deps, monitor);
  }
  const classifyFinal = classifyFinalHandler(deps);
  // ...the rest of the function is unchanged
```

and at the `worker-tick` call site pass the store: `registerP2(createResearchDeps(Deno.env.toObject(), db), createSupabaseMonitorStore(db))`.

- [ ] **Step 9: Run the suites, the type checks, the linters**

Run: `bun run test:core -- risk` then `deno test -A --config supabase/functions/deno.json supabase/functions/worker-tick`
Expected: PASS (risk core 10, risk_check 10, plus all Task 5 tests).

Run: `bun run functions:check` then `bun run typecheck` then `bun run lint:fix` then `bun run lint`
Expected: exit 0.

- [ ] **Step 10: Commit**

```text
git add supabase/functions/_shared/core/risk.ts supabase/functions/_shared/core/risk.test.ts supabase/functions/_shared/adapters/monitor_store.ts supabase/functions/worker-tick
git commit -m "feat(research): add material-change monitor with delta detection, findings and monitor_change reports"
```

---

### Task 7: Web, research report page and card wiring (parallel in wave A; implementer loads `frontend-design` and `ui-ux-pro-max`)

**Files:**
- Create: `apps/web/src/features/research/{labels,types,queries}.ts`, `MarkdownBody.tsx`, `ReportView.tsx`, `ReportPage.tsx`, `ResearchSection.tsx`, `MonitoredHoldingBlock.tsx`
- Create (tests): `apps/web/src/features/research/{labels.test.ts,MarkdownBody.test.tsx,ReportView.test.tsx,ResearchSection.test.tsx}`
- Modify: `apps/web/src/router.tsx` (route `/research/$reportId`), `apps/web/package.json` and `bun.lock` (two dependencies)

**Interfaces:**
- Consumes: view `public.v_card_research` and tables `research_reports`, `research_sources` (Task 1, public RLS), the P5 Supabase client singleton `@/lib/supabase` (if P4/P5 has not created it yet, create the two-line singleton from `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`).
- Produces: `researchLabel(input)`, `MarkdownBody`, `ReportView`, `ReportPage`, `ResearchSection`, `MonitoredHoldingBlock`, `useReport(id)`, `useCardResearch(scanRunId)`. The Overview of P0 is still a placeholder (P4 builds the cards), so this task ships the research content blocks and P4 mounts `<ResearchSection/>` in `DiscountCard` and `WithheldPanel`.
- Self-contained: no import from Task 4; the date label logic is a six-line copy kept in `labels.ts`.

- [ ] **Step 1: Add the dependencies**

Run: `bun add --cwd apps/web react-markdown@10.1.0 rehype-sanitize@6.0.0`
Expected: both appear with exact versions in `apps/web/package.json` (`bunfig.toml` sets `exact = true`).

- [ ] **Step 2: Write the failing tests**

`labels.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { researchLabel } from "./labels";

const NOW = new Date("2026-10-15T08:00:00Z");
const l = (over: Partial<Parameters<typeof researchLabel>[0]>) =>
  researchLabel({ reportStatus: null, reportError: null, completedAt: null, now: NOW, ...over });

describe("researchLabel", () => {
  it("shows pending for no report, queued and running", () => {
    expect(l({}).text).toBe("Research pending");
    expect(l({ reportStatus: "queued" }).text).toBe("Research pending");
    expect(l({ reportStatus: "running" }).text).toBe("Research pending");
  });
  it("distinguishes quota deferral from a missing provider", () => {
    expect(l({ reportStatus: "quota_deferred", reportError: "llm_quota" }).text).toBe("Research deferred (quota)");
    expect(l({ reportStatus: "quota_deferred", reportError: "daily_cap" }).text).toBe("Research deferred (quota)");
    expect(l({ reportStatus: "quota_deferred", reportError: "provider_not_configured" }).text).toBe("Research not configured");
  });
  it("labels failures, fresh and stale research", () => {
    expect(l({ reportStatus: "failed" }).text).toBe("Research failed");
    expect(l({ reportStatus: "complete", completedAt: "2026-10-10T08:00:00Z" }).text).toBe("Research dated 2026-10-10");
    expect(l({ reportStatus: "complete", completedAt: "2026-09-01T08:00:00Z" }).text).toBe("Research dated 2026-09-01 (refresh pending)");
    expect(l({ reportStatus: "complete", completedAt: "2026-09-15T08:00:00Z" }).code).toBe("dated");
    expect(l({ reportStatus: "complete", completedAt: "2026-09-14T07:00:00Z" }).code).toBe("stale");
  });
  it("never reads a missing report as complete", () => {
    expect(l({ reportStatus: "complete", completedAt: null }).text).toBe("Research pending");
  });
});
```

`MarkdownBody.test.tsx`:

```tsx
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MarkdownBody } from "./MarkdownBody";

describe("MarkdownBody sanitiser", () => {
  it("renders markdown", () => {
    const { container } = render(<MarkdownBody markdown={"## Title\n\nSome **bold** text"} />);
    expect(container.querySelector("h2")?.textContent).toBe("Title");
    expect(container.querySelector("strong")?.textContent).toBe("bold");
  });
  it("never produces a script element, an inline handler or a javascript: link", () => {
    const md = 'Hi <script>alert(1)</script> <img src=x onerror="alert(2)">\n\n[click](javascript:alert(3))\n\n<a href="javascript:alert(4)" onclick="x()">raw</a>';
    const { container } = render(<MarkdownBody markdown={md} />);
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(container.innerHTML).not.toMatch(/onerror|onclick/i);
    for (const a of container.querySelectorAll("a")) expect(a.getAttribute("href") ?? "").not.toMatch(/^javascript:/i);
  });
  it("opens http links safely", () => {
    const { container } = render(<MarkdownBody markdown="[SEC](https://www.sec.gov/x)" />);
    const a = container.querySelector("a");
    expect(a?.getAttribute("rel")).toBe("noopener noreferrer");
    expect(a?.getAttribute("target")).toBe("_blank");
  });
});
```

`ReportView.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ReportView } from "./ReportView";
import type { ReportData } from "./types";

const data: ReportData = {
  id: "r1", companyName: "Acme Corp", ticker: "ACME", researchDate: "2026-10-15", cutoffDate: "2026-10-15",
  provider: "gemini", model: "flash-lite-x", promptVersion: "2026-10-15.1", schemaVersion: "research-output-1",
  conclusion: "Meets these two fundamental checks.", bankruptcyRisk: "Moderate", materialDamageEstablished: false, sufficientEvidence: true,
  reportMd: "Body text [E1]\n\n## Sources\n\n- [E1] [10-K](https://www.sec.gov/a) - SEC EDGAR - filing date 2026-02-20\n",
  claims: [{ section: "established_facts", items: [{ text: "Revenue fell 4%.", evidence_ids: [1] }] },
           { section: "management_claims", items: [{ text: "A recovery is expected.", evidence_ids: [2] }] }],
  missingDocuments: ["Latest quarterly report: not obtained"], limitations: ["limited_sources"],
};

describe("ReportView", () => {
  it("shows the header, the two independent outputs and the provenance", () => {
    render(<ReportView data={data} />);
    expect(screen.getByRole("heading", { name: /Acme Corp/ })).toBeTruthy();
    expect(screen.getByText("ACME")).toBeTruthy();
    expect(screen.getByText(/Research date/).textContent).toContain("2026-10-15");
    expect(screen.getByText(/Cutoff date/).textContent).toContain("2026-10-15");
    expect(screen.getByText(/gemini/).textContent).toContain("flash-lite-x");
    expect(screen.getByText(/2026-10-15\.1/)).toBeTruthy();
    expect(screen.getByLabelText("Research conclusion").textContent).toContain("Meets these two fundamental checks.");
    const risk = screen.getByLabelText("Bankruptcy risk").textContent ?? "";
    expect(risk).toContain("Moderate");
    expect(risk).toContain("Sufficient evidence: yes");
    expect(risk).toContain("Material lasting damage established: no");
  });
  it("lists facts versus claims, missing documents, limitations, sources and the AI disclaimer", () => {
    render(<ReportView data={data} />);
    expect(screen.getByText("Established facts")).toBeTruthy();
    expect(screen.getByText("Management claims")).toBeTruthy();
    expect(screen.getByText("Revenue fell 4%.")).toBeTruthy();
    expect(screen.getByText("Latest quarterly report: not obtained")).toBeTruthy();
    expect(screen.getByText("limited_sources")).toBeTruthy();
    expect(screen.getByRole("link", { name: "10-K" }).getAttribute("href")).toBe("https://www.sec.gov/a");
    expect(screen.getByRole("note").textContent).toMatch(/generated by an AI model/i);
    expect(screen.getByRole("note").textContent).toMatch(/not financial advice/i);
  });
});
```

`ResearchSection.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MonitoredHoldingBlock } from "./MonitoredHoldingBlock";
import { ResearchSection } from "./ResearchSection";
import type { CardResearch } from "./types";

const base: CardResearch = {
  securityId: "s1", category: "green", reasonCode: "meets_checks", withheld: false, reportId: "r1",
  summary: "Fell on a guidance cut; balance sheet is sound.", conclusion: "Meets these two fundamental checks.",
  bankruptcyRisk: "Low", completedAt: "2026-10-10T08:00:00Z", reportStatus: "complete", reportError: null,
};
const now = new Date("2026-10-15T08:00:00Z");

describe("ResearchSection", () => {
  it("shows summary, conclusion, risk, category text and the research date with a report link", () => {
    render(<ResearchSection research={base} now={now} />);
    expect(screen.getByText(base.summary ?? "")).toBeTruthy();
    expect(screen.getByText(/Meets these two fundamental checks\./)).toBeTruthy();
    expect(screen.getByText(/Bankruptcy risk: Low/)).toBeTruthy();
    expect(screen.getByText(/Meets the checks/)).toBeTruthy();
    expect(screen.getByText("Research dated 2026-10-10")).toBeTruthy();
    expect(screen.getByRole("link", { name: /Full report/ }).getAttribute("href")).toBe("/research/r1");
  });
  it("amber carries a text warning, not colour alone", () => {
    render(<ResearchSection research={{ ...base, category: "amber", bankruptcyRisk: "Moderate" }} now={now} />);
    expect(screen.getByText(/Caution: moderate bankruptcy risk/)).toBeTruthy();
  });
  it.each([
    [{ reportStatus: "queued", reportId: null, completedAt: null }, "Research pending"],
    [{ reportStatus: "quota_deferred", reportError: "llm_quota", completedAt: null, category: "pending" }, "Research deferred (quota)"],
    [{ reportStatus: "quota_deferred", reportError: "provider_not_configured", completedAt: null, category: "pending" }, "Research not configured"],
    [{ completedAt: "2026-09-01T08:00:00Z" }, "Research dated 2026-09-01 (refresh pending)"],
  ] as const)("labels %j as %s and never shows a conclusion that was not researched", (over, text) => {
    render(<ResearchSection research={{ ...base, ...over }} now={now} />);
    expect(screen.getByText(text)).toBeTruthy();
  });
  it("a pending card shows no verdict text", () => {
    render(<ResearchSection research={{ ...base, category: "pending", conclusion: null, bankruptcyRisk: null, summary: null, reportStatus: "running", completedAt: null }} now={now} />);
    expect(screen.queryByText(/Meets/)).toBeNull();
    expect(screen.queryByText(/Bankruptcy risk/)).toBeNull();
  });
});

describe("MonitoredHoldingBlock", () => {
  it("shows the two separate timestamps", () => {
    render(<MonitoredHoldingBlock fullReportDate="2026-09-20" lastCheckDate="2026-10-15" />);
    expect(screen.getByText("Full report: 2026-09-20 · Last change check: 2026-10-15")).toBeTruthy();
  });
  it("says so when there is no report or no check yet", () => {
    render(<MonitoredHoldingBlock fullReportDate={null} lastCheckDate={null} />);
    expect(screen.getByText("Full report: none yet · Last change check: none yet")).toBeTruthy();
  });
});
```

- [ ] **Step 3: Run to see them fail**

Run: `bun run test:web -- research`
Expected: FAIL with `Failed to resolve import "./labels"` (and the other modules).

- [ ] **Step 4: Implement `types.ts`, `labels.ts`, `MarkdownBody.tsx`, `MonitoredHoldingBlock.tsx`**

`types.ts`:

```ts
export type ReportStatus = "queued" | "running" | "complete" | "failed" | "quota_deferred" | "stale";

export interface CardResearch {
  securityId: string;
  category: "green" | "amber" | "red" | "grey" | "pending";
  reasonCode: string | null;
  withheld: boolean;
  reportId: string | null;
  summary: string | null;
  conclusion: string | null;
  bankruptcyRisk: "Low" | "Moderate" | "High" | "Unclear" | null;
  completedAt: string | null;
  reportStatus: ReportStatus | null;
  reportError: string | null;
}

export interface ClaimGroup {
  section: "established_facts" | "management_claims" | "forecasts" | "allegations" | "interpretation";
  items: { text: string; evidence_ids: number[] }[];
}

export interface ReportData {
  id: string;
  companyName: string;
  ticker: string;
  researchDate: string;
  cutoffDate: string | null;
  provider: string | null;
  model: string | null;
  promptVersion: string | null;
  schemaVersion: string | null;
  conclusion: string | null;
  bankruptcyRisk: string | null;
  materialDamageEstablished: boolean | null;
  sufficientEvidence: boolean | null;
  reportMd: string;
  claims: ClaimGroup[];
  missingDocuments: string[];
  limitations: string[];
}
```

`labels.ts`:

```ts
import type { ReportStatus } from "./types";

export interface LabelInput {
  reportStatus: ReportStatus | null;
  reportError: string | null;
  completedAt: string | null;
  now?: Date;
  reuseDays?: number;
}

export type ResearchLabelCode = "pending" | "deferred" | "not_configured" | "failed" | "dated" | "stale";

/** Staleness is derived from the completion date, never from the report status (A-27). */
export function researchLabel(i: LabelInput): { code: ResearchLabelCode; text: string } {
  const pending = { code: "pending" as const, text: "Research pending" };
  if (i.reportStatus === "failed") return { code: "failed", text: "Research failed" };
  if (i.reportStatus === "quota_deferred") {
    return i.reportError === "provider_not_configured"
      ? { code: "not_configured", text: "Research not configured" }
      : { code: "deferred", text: "Research deferred (quota)" };
  }
  if ((i.reportStatus === "complete" || i.reportStatus === "stale") && i.completedAt) {
    const date = i.completedAt.slice(0, 10);
    const ageDays = ((i.now ?? new Date()).getTime() - Date.parse(i.completedAt)) / 86_400_000;
    return ageDays > (i.reuseDays ?? 30)
      ? { code: "stale", text: `Research dated ${date} (refresh pending)` }
      : { code: "dated", text: `Research dated ${date}` };
  }
  return pending;
}

export const CATEGORY_TEXT: Record<string, string> = {
  green: "Meets the checks",
  amber: "Caution: moderate bankruptcy risk",
  red: "Does not meet the checks",
  grey: "Inconclusive",
  pending: "Research pending",
};
```

`MarkdownBody.tsx`:

```tsx
import ReactMarkdown from "react-markdown";
import rehypeSanitize from "rehype-sanitize";

/** Model-written Markdown is untrusted: raw HTML is never rendered and the output is sanitised. */
export function MarkdownBody({ markdown }: { markdown: string }) {
  return (
    <div className="prose prose-sm max-w-none dark:prose-invert">
      <ReactMarkdown
        rehypePlugins={[rehypeSanitize]}
        components={{
          a: ({ href, children }) => {
            const safe = href && /^https?:\/\//i.test(href) ? href : undefined;
            return safe ? (
              <a href={safe} target="_blank" rel="noopener noreferrer" className="underline">
                {children}
              </a>
            ) : (
              <span>{children}</span>
            );
          },
        }}
      >
        {markdown}
      </ReactMarkdown>
    </div>
  );
}
```

`MonitoredHoldingBlock.tsx`:

```tsx
/** A change check never claims a regenerated report (brief 9): the two dates are always shown apart. */
export function MonitoredHoldingBlock({ fullReportDate, lastCheckDate }: { fullReportDate: string | null; lastCheckDate: string | null }) {
  return (
    <p className="text-xs text-muted-foreground">
      {`Full report: ${fullReportDate ?? "none yet"} · Last change check: ${lastCheckDate ?? "none yet"}`}
    </p>
  );
}
```

- [ ] **Step 5: Implement `ResearchSection.tsx`, `ReportView.tsx`**

`ResearchSection.tsx`:

```tsx
import { CATEGORY_TEXT, researchLabel } from "./labels";
import type { CardResearch } from "./types";

/** Research content of a card or a withheld row: label first, verdict only when real research completed. */
export function ResearchSection({ research, now }: { research: CardResearch; now?: Date }) {
  const label = researchLabel({
    reportStatus: research.reportStatus, reportError: research.reportError, completedAt: research.completedAt,
    ...(now ? { now } : {}),
  });
  const hasVerdict = research.category !== "pending" && research.conclusion !== null;
  return (
    <section aria-label="Research" className="space-y-1 text-sm">
      {hasVerdict ? (
        <>
          <p className="font-medium">{CATEGORY_TEXT[research.category]}</p>
          {research.summary ? <p>{research.summary}</p> : null}
          <p>{research.conclusion}</p>
          {research.bankruptcyRisk ? <p>{`Bankruptcy risk: ${research.bankruptcyRisk}`}</p> : null}
        </>
      ) : null}
      <p className="text-xs text-muted-foreground">{label.text}</p>
      {research.reportId && research.reportStatus === "complete" ? (
        <a className="text-xs underline" href={`/research/${research.reportId}`}>
          Full report
        </a>
      ) : null}
    </section>
  );
}
```

`ReportView.tsx`:

```tsx
import { MarkdownBody } from "./MarkdownBody";
import type { ClaimGroup, ReportData } from "./types";

const SECTION_TITLE: Record<ClaimGroup["section"], string> = {
  established_facts: "Established facts", management_claims: "Management claims", forecasts: "Forecasts",
  allegations: "Allegations", interpretation: "Interpretation",
};
const yesNo = (v: boolean | null) => (v === null ? "unknown" : v ? "yes" : "no");

export function ReportView({ data }: { data: ReportData }) {
  return (
    <article className="mx-auto max-w-4xl space-y-6 px-4 py-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold">
          {data.companyName} <span className="text-muted-foreground">{data.ticker}</span>
        </h1>
        <p className="text-sm">{`Research date: ${data.researchDate}`}</p>
        <p className="text-sm">{`Cutoff date: ${data.cutoffDate ?? "not stated"}`}</p>
        <p className="text-xs text-muted-foreground">
          {`Generated by ${data.provider ?? "unknown"} / ${data.model ?? "unknown"}, prompt ${data.promptVersion ?? "?"}, schema ${data.schemaVersion ?? "?"}`}
        </p>
      </header>

      <div className="grid gap-4 md:grid-cols-2">
        <section aria-label="Research conclusion" className="rounded-lg border p-4">
          <h2 className="text-sm font-medium text-muted-foreground">Research conclusion</h2>
          <p className="mt-1 font-medium">{data.conclusion ?? "No conclusion"}</p>
        </section>
        <section aria-label="Bankruptcy risk" className="rounded-lg border p-4">
          <h2 className="text-sm font-medium text-muted-foreground">Bankruptcy risk</h2>
          <p className="mt-1 font-medium">{data.bankruptcyRisk ?? "Unclear"}</p>
          <p className="text-sm">{`Sufficient evidence: ${yesNo(data.sufficientEvidence)}`}</p>
          <p className="text-sm">{`Material lasting damage established: ${yesNo(data.materialDamageEstablished)}`}</p>
        </section>
      </div>

      <MarkdownBody markdown={data.reportMd} />

      {data.claims.filter((g) => g.items.length > 0).map((group) => (
        <section key={group.section} className="space-y-1">
          <h2 className="text-base font-medium">{SECTION_TITLE[group.section]}</h2>
          <ul className="list-disc pl-5 text-sm">
            {group.items.map((item) => (
              <li key={item.text}>
                <span>{item.text}</span>{" "}
                <span className="text-xs text-muted-foreground">{item.evidence_ids.map((id) => `[E${id}]`).join(" ")}</span>
              </li>
            ))}
          </ul>
        </section>
      ))}

      {data.missingDocuments.length > 0 ? (
        <section>
          <h2 className="text-base font-medium">Missing documents</h2>
          <ul className="list-disc pl-5 text-sm">{data.missingDocuments.map((m) => <li key={m}>{m}</li>)}</ul>
        </section>
      ) : null}
      {data.limitations.length > 0 ? (
        <section>
          <h2 className="text-base font-medium">Limitations</h2>
          <ul className="list-disc pl-5 text-sm">{data.limitations.map((m) => <li key={m}>{m}</li>)}</ul>
        </section>
      ) : null}

      <aside role="note" className="rounded-lg border bg-muted p-4 text-sm">
        This research was generated by an AI model from the listed public sources. It is not financial advice, it may be
        wrong, and the model and provider are shown above. Check the sources before acting.
      </aside>
    </article>
  );
}
```

- [ ] **Step 6: Implement the data hooks, the page and the route**

`queries.ts`:

```ts
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import type { CardResearch, ReportData } from "./types";

export function useReport(id: string) {
  return useQuery({
    queryKey: ["report", id],
    staleTime: 10 * 60_000,
    queryFn: async (): Promise<ReportData | null> => {
      const { data, error } = await supabase
        .from("research_reports")
        .select("id, report_md, claims, missing_documents, limitations, conclusion, bankruptcy_risk, material_damage_established, sufficient_evidence, research_cutoff_date, completed_at, provider, model, prompt_version, schema_version, companies(name), securities(yahoo_symbol)")
        .eq("id", id)
        .eq("status", "complete")
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (!data) return null;
      const r = data as unknown as Record<string, any>;
      return {
        id: r.id, companyName: r.companies?.name ?? "", ticker: r.securities?.yahoo_symbol ?? "",
        researchDate: String(r.completed_at ?? "").slice(0, 10), cutoffDate: r.research_cutoff_date ?? null,
        provider: r.provider, model: r.model, promptVersion: r.prompt_version, schemaVersion: r.schema_version,
        conclusion: r.conclusion, bankruptcyRisk: r.bankruptcy_risk, materialDamageEstablished: r.material_damage_established,
        sufficientEvidence: r.sufficient_evidence, reportMd: r.report_md ?? "", claims: r.claims ?? [],
        missingDocuments: r.missing_documents ?? [], limitations: r.limitations ?? [],
      };
    },
  });
}

/** Research columns of today's cards, merged by the Overview with `todays_discounts_feed` on (mode, security_id). */
export function useCardResearch(scanRunId: string | null) {
  return useQuery({
    queryKey: ["cardResearch", scanRunId],
    enabled: scanRunId !== null,
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<Map<string, CardResearch>> => {
      const { data, error } = await supabase.from("v_card_research").select("*").eq("scan_run_id", scanRunId);
      if (error) throw new Error(error.message);
      return new Map(
        (data ?? []).map((r: Record<string, any>) => [
          r.security_id as string,
          {
            securityId: r.security_id, category: r.operational_category, reasonCode: r.category_reason ?? null,
            withheld: r.withheld, reportId: r.research_report_id ?? null, summary: r.research_summary ?? null,
            conclusion: r.conclusion ?? null, bankruptcyRisk: r.bankruptcy_risk ?? null, completedAt: r.research_completed_at ?? null,
            reportStatus: r.report_status ?? null, reportError: r.report_error ?? null,
          } satisfies CardResearch,
        ]),
      );
    },
  });
}
```

`ReportPage.tsx`:

```tsx
import { useParams } from "@tanstack/react-router";
import { ReportView } from "./ReportView";
import { useReport } from "./queries";

export function ReportPage() {
  const { reportId } = useParams({ strict: false }) as { reportId: string };
  const { data, isLoading, error, refetch } = useReport(reportId);
  if (isLoading) return <p className="p-6" aria-busy="true">Loading report...</p>;
  if (error) {
    return (
      <p className="p-6" role="alert">
        The report could not be loaded. <button type="button" className="underline" onClick={() => refetch()}>Retry</button>
      </p>
    );
  }
  if (!data) return <p className="p-6">This report does not exist or is not available to you.</p>;
  return <ReportView data={data} />;
}
```

Edit `apps/web/src/router.tsx`: add the import and the route (code-based, P0 style):

```tsx
import { ReportPage } from "@/features/research/ReportPage";
// next to the other createRoute calls
const researchRoute = createRoute({ getParentRoute: () => rootRoute, path: "/research/$reportId", component: ReportPage });
// and add `researchRoute` to the `rootRoute.addChildren([...])` array
```

- [ ] **Step 7: Run tests, type check, lint**

Run: `bun run test:web -- research` then `bun run typecheck` then `bun run lint:fix` then `bun run lint`
Expected: PASS (labels 4, sanitiser 3, report view 2, section 8 incl. the table, monitored 2); exit 0. If Biome flags `any` in `queries.ts`, type the rows with a local `interface` instead.

- [ ] **Step 8: Commit**

```text
git add apps/web package.json bun.lock
git commit -m "feat(web): add research report page, card research section and status labels"
```

---

### Task 8: Fixture-mode end-to-end (`bun run test:integration`)

**Files:**
- Create: `supabase/functions/_shared/adapters/fixtures/{gemini,tavily,jina,edgar,rss}/*.ts` (recorded-shape fixtures as string and JSON constants, so they bundle into the Edge Function)
- Create: `supabase/functions/_shared/adapters/fixtures/fixture_fetch.ts`, `fixture_fetch.test.ts`
- Modify: `supabase/functions/_shared/adapters/providers.ts` (fixture switch)
- Create: `tools/self-test/research.ts`
- Modify: root `package.json` (`test:integration` chains the research scenario)

**Interfaces:**
- Consumes: everything from Tasks 1-7; the local Supabase stack (`bun run supabase:start`, functions served with `supabase/functions/.env` containing `PROVIDER_MODE=fixture`, `SUPABASE_URL=http://127.0.0.1:54321`, `CRON_SHARED_SECRET`, `SEC_USER_AGENT=Fixture admin@example.com`, `GEMINI_API_KEY=fixture`, `GEMINI_MODEL=fixture-model`, `TAVILY_API_KEY=fixture`).
- Produces: `createFixtureFetch(): FetchLike` (answers only known fixture URLs; any other URL throws, so a mock can never leak a real request); `PROVIDER_MODE=fixture` in `createResearchDeps`, refused unless `SUPABASE_URL` is `127.0.0.1` or `localhost` (spec 7.12); the scenario `tools/self-test/research.ts`.
- Fixture world: **GRNC** Greenfield Corp (Green), **RDCO** Redline Holdings (Red: High bankruptcy risk), **HOLD** Holdfast Inc (monitored holding with a material 8-K). CIKs `0000111111`, `0000222222`, `0000333333`. The Stage 1 and Stage 2 answers are generated from the prompt by the fixture (quote copied from the document text, evidence ids read from the ledger in the prompt), so they always match the run's ledger; the verdict is chosen by the ticker in the prompt.

- [ ] **Step 1: Re-check the P1 runner and the Yahoo fixture mode**

Run: `git grep -n "self-test\|PROVIDER_MODE\|provider_mode" -- tools supabase package.json`
Expected: P1's `tools/run-local-scan.ts --self-test` exists and its Yahoo adapter already honours fixture mode (spec 7.12). If Yahoo news has no fixture mode, make `yahooNews` return `[]` when `PROVIDER_MODE=fixture` (the HOLD scenario below needs only EDGAR). The scenario script below is standalone and does not depend on the P1 runner's internals.

- [ ] **Step 2: Write the failing fixture-router test `fixture_fetch.test.ts`**

```ts
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { createFixtureFetch } from "./fixture_fetch.ts";

const post = (url: string, body: unknown) => ({ url, init: { method: "POST", body: JSON.stringify(body) } });

Deno.test("fixture fetch answers Tavily, EDGAR, Jina and direct pages and nothing else", async () => {
  const f = createFixtureFetch();
  const t = post("https://api.tavily.com/search", { query: "Greenfield Corp GRNC annual report 2025 investor relations" });
  const tavily = await (await f(t.url, t.init)).json();
  assert(tavily.results.length >= 2);
  const subs = await (await f("https://data.sec.gov/submissions/CIK0000111111.json")).json();
  assertEquals(subs.filings.recent.form.includes("10-K"), true);
  const jina = await (await f("https://r.jina.ai/https://www.sec.gov/Archives/edgar/data/111111/000011111126000001/grnc-10k.htm")).text();
  assert(jina.length > 300);
  const page = await f(tavily.results[0].url);
  assertEquals(page.headers.get("content-type")?.startsWith("text/html"), true);
  await assertRejects(() => f("https://example.org/not-a-fixture"), Error, "no fixture");
});

Deno.test("fixture Gemini builds Stage 2 output from the ledger in the prompt and picks the verdict by ticker", async () => {
  const f = createFixtureFetch();
  const call = async (ticker: string) => {
    const user = `**TICKER:** ${ticker}\nEVIDENCE:\n[E1] kind=edgar_filing title="x" date=d retrieved=r\n     facts: - (management_claim) c  | quote: "q"\n[E2] kind=edgar_filing title="y" date=d retrieved=r\n     facts: - (management_claim) c  | quote: "q"`;
    const res = await f("https://generativelanguage.googleapis.com/v1beta/models/fixture-model:generateContent", {
      method: "POST",
      body: JSON.stringify({ systemInstruction: { parts: [{ text: "You are the writing stage of a research pipeline." }] }, contents: [{ role: "user", parts: [{ text: user }] }] }),
    });
    return JSON.parse((await res.json()).candidates[0].content.parts[0].text);
  };
  const green = await call("GRNC");
  assertEquals([green.conclusion, green.bankruptcy_risk, green.cited_evidence_ids], ["Meets these two fundamental checks.", "Low", [1, 2]]);
  const red = await call("RDCO");
  assertEquals([red.conclusion, red.bankruptcy_risk], ["Does not meet one or both checks.", "High"]);
});
```

Run: `deno test -A --config supabase/functions/deno.json supabase/functions/_shared/adapters/fixtures`
Expected: FAIL with `Module not found "./fixture_fetch.ts"`.

- [ ] **Step 3: Write the fixtures**

`fixtures/edgar/data.ts`:

```ts
/** Submissions per CIK: a 10-K, a 10-Q and an 8-K (HOLD's 8-K is the material one). */
export const SUBMISSIONS: Record<string, unknown> = Object.fromEntries(
  [["0000111111", "grnc", "111111"], ["0000222222", "rdco", "222222"], ["0000333333", "hold", "333333"]].map(([cik, slug, short]) => [
    cik,
    {
      cik,
      filings: {
        recent: {
          accessionNumber: [`${cik}-26-000003`, `${cik}-26-000002`, `${cik}-26-000001`],
          filingDate: ["2026-10-14", "2026-08-01", "2026-02-20"],
          reportDate: ["2026-10-13", "2026-06-30", "2025-12-31"],
          form: ["8-K", "10-Q", "10-K"],
          primaryDocument: [`${slug}-8k.htm`, `${slug}-10q.htm`, `${slug}-10k.htm`],
          shortCik: [short, short, short],
        },
      },
    },
  ]),
);

export const COMPANY_TICKERS = {
  "0": { cik_str: 111111, ticker: "GRNC", title: "Greenfield Corp" },
  "1": { cik_str: 222222, ticker: "RDCO", title: "Redline Holdings" },
  "2": { cik_str: 333333, ticker: "HOLD", title: "Holdfast Inc" },
};
```
`fixtures/jina/docs.ts`:

```ts
const para = (name: string, tone: string) =>
  `${name} annual report. ${tone} Liquidity and capital resources: the company held cash and equivalents and an undrawn revolving facility at year end. ` +
  `Debt maturities are described in the notes to the financial statements. Management believes liquidity is adequate for the next twelve months. `.repeat(3);

export const JINA_DOCS: Record<string, string> = {
  grnc: para("Greenfield Corp", "Revenue declined four percent because of a one-time customer loss; the balance sheet is strong."),
  rdco: para("Redline Holdings", "The company disclosed substantial doubt about its ability to continue as a going concern after a covenant breach."),
  hold: para("Holdfast Inc", "Operations were stable in the period."),
};
```

`fixtures/tavily/results.ts`:

```ts
export function tavilyResults(query: string) {
  const slug = /greenfield/i.test(query) ? "grnc" : /redline/i.test(query) ? "rdco" : "hold";
  const n = Math.abs([...query].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7)) % 1000;
  return {
    results: [
      { title: `${slug.toUpperCase()} investor presentation ${n}`, url: `https://investors.${slug}.example/ir-${n}`, content: "Investor relations presentation.", published_date: "2026-09-01" },
      { title: `${slug.toUpperCase()} shares move ${n}`, url: `https://news.example.com/${slug}-${n}`, content: "Shares moved after the update." },
    ],
  };
}
```

`fixtures/rss/feed.ts`:

```ts
export const EMPTY_FEED = `<?xml version="1.0"?><rss version="2.0"><channel><title>IR</title></channel></rss>`;
```

`fixtures/gemini/answers.ts`:

```ts
import { words } from "./words.ts";

export { words };

export function stage1Answer(user: string) {
  const body = user.split("DOCUMENT TEXT:\n")[1] ?? "";
  const quote = body.slice(0, 80).replace(/\s+/g, " ").trim();
  return { facts: [{ topic: "liquidity", claim: "The company describes its liquidity.", claim_type: "management_claim", quote, where: "MD&A" }] };
}

export function stage2Answer(user: string) {
  const ids = [...user.matchAll(/\[E(\d+)\] kind=edgar_filing/g)].map((m) => Number(m[1])).slice(0, 2);
  const red = /\*\*TICKER:\*\* RDCO/.test(user);
  return {
    report_md: `${words(520)} [E${ids[0] ?? 1}]`,
    summary: red ? "Distress after a covenant breach; withheld." : "Fell on a one-time customer loss; balance sheet is sound.",
    news_reason: red ? "Covenant breach and going-concern doubt." : "One-time customer loss.",
    conclusion: red ? "Does not meet one or both checks." : "Meets these two fundamental checks.",
    bankruptcy_risk: red ? "High" : "Low",
    material_damage_established: red,
    sufficient_evidence: true,
    cited_evidence_ids: ids,
    facts_vs_claims: [{ section: "established_facts", items: [{ text: "Liquidity is described in the filing.", evidence_ids: ids.slice(0, 1) }] }],
    missing_documents: [],
    limitations: [],
    research_cutoff_date: /\*\*RESEARCH DATE:\*\* (\d{4}-\d{2}-\d{2})/.exec(user)?.[1] ?? "2026-10-15",
  };
}

export function changeAnswer() {
  return { material: true, category: "liquidity_debt", severity: "material", summary: "The 8-K discloses a covenant waiver request.", evidence_ids: [1] };
}
```

`fixtures/gemini/words.ts`:

```ts
export const words = (n: number): string => Array.from({ length: n }, (_, i) => `word${i % 50}`).join(" ");
```

- [ ] **Step 4: Implement `fixtures/fixture_fetch.ts` and the provider switch**

```ts
import type { FetchLike } from "../llm/types.ts";
import { changeAnswer, stage1Answer, stage2Answer } from "./gemini/answers.ts";
import { COMPANY_TICKERS, SUBMISSIONS } from "./edgar/data.ts";
import { JINA_DOCS } from "./jina/docs.ts";
import { EMPTY_FEED } from "./rss/feed.ts";
import { tavilyResults } from "./tavily/results.ts";

const json = (body: unknown) => Response.json(body);
const slugOf = (s: string) => (/111111|grnc|greenfield/i.test(s) ? "grnc" : /222222|rdco|redline/i.test(s) ? "rdco" : "hold");

/** Answers recorded-shape responses for known URLs only. Unknown URLs throw: no silent mock, no real network. */
export function createFixtureFetch(): FetchLike {
  return async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const body = typeof init?.body === "string" ? init.body : "";
    if (url === "https://api.tavily.com/search") return json(tavilyResults(String(JSON.parse(body).query ?? "")));
    if (url.endsWith("company_tickers.json")) return json(COMPANY_TICKERS);
    const cik = /submissions\/CIK(\d{10})\.json/.exec(url)?.[1];
    if (cik && SUBMISSIONS[cik]) return json(SUBMISSIONS[cik]);
    if (url.startsWith("https://r.jina.ai/")) {
      const text = JINA_DOCS[slugOf(url)] ?? "";
      return new Response(text, { headers: { "content-type": "text/plain" } });
    }
    if (url.includes("generativelanguage.googleapis.com")) {
      const parsed = JSON.parse(body) as { systemInstruction: { parts: { text: string }[] }; contents: { parts: { text: string }[] }[] };
      const system = parsed.systemInstruction.parts[0]?.text ?? "";
      const user = parsed.contents[0]?.parts[0]?.text ?? "";
      const answer = system.includes("MATERIAL CHANGE CRITERIA")
        ? changeAnswer()
        : system.includes("You extract facts from ONE document")
          ? stage1Answer(user)
          : stage2Answer(user);
      return json({
        candidates: [{ content: { parts: [{ text: JSON.stringify(answer) }] }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 300 },
      });
    }
    if (/^https:\/\/(investors|news)\.[a-z]+\.example/.test(url) || /^https:\/\/investors\.[a-z]+\.example/.test(url)) {
      const text = JINA_DOCS[slugOf(url)] ?? "";
      return new Response(`<html><body><p>${text}</p></body></html>`, { headers: { "content-type": "text/html" } });
    }
    if (url.endsWith("/feed.xml")) return new Response(EMPTY_FEED, { headers: { "content-type": "application/rss+xml" } });
    throw new Error(`no fixture for ${url}`);
  };
}
```

In `providers.ts` add the switch at the top of `createResearchDeps`:

```ts
import { createFixtureFetch } from "./fixtures/fixture_fetch.ts";

// inside createResearchDeps, before the store is built
if (env.PROVIDER_MODE === "fixture") {
  const local = /^https?:\/\/(127\.0\.0\.1|localhost)([:/]|$)/.test(env.SUPABASE_URL ?? "");
  if (!local) throw new Error("PROVIDER_MODE=fixture is refused unless SUPABASE_URL is 127.0.0.1 or localhost");
  fetchImpl = createFixtureFetch();
}
```

(declare the parameter `let`-able by renaming it `injectedFetch` and `let fetchImpl = injectedFetch;`). `PROVIDER_MODE` is never read anywhere else.

Run: `deno test -A --config supabase/functions/deno.json supabase/functions/_shared/adapters/fixtures`
Expected: PASS (2 tests).

- [ ] **Step 5: Write the scenario `tools/self-test/research.ts`**

The script seeds a far-future scan run (`2099-01-01`, so the public view picks it up), drives `worker-tick` over HTTP and asserts through the service client and an anonymous client. It cleans up after itself.

```ts
import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL ?? "http://127.0.0.1:54321";
if (!/^https?:\/\/(127\.0\.0\.1|localhost)/.test(url)) throw new Error("self-test runs against the local stack only");
const service = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY ?? "", { auth: { persistSession: false } });
const anon = createClient(url, process.env.SUPABASE_ANON_KEY ?? "", { auth: { persistSession: false } });
const cron = process.env.CRON_SHARED_SECRET ?? "";
const RUN_DATE = "2099-01-01";
const USER = "00000000-0000-0000-0000-0000000000f1";
const U = (n: number) => `00000000-0000-0000-0000-00000000a${String(n).padStart(3, "0")}`;
const ids = { grnc: U(1), rdco: U(2), hold: U(3) } as const;
const co = { grnc: U(11), rdco: U(12), hold: U(13) } as const;

function check(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(`FAIL: ${message}`);
  console.log(`ok: ${message}`);
}
const must = <T>(r: { data: T; error: { message: string } | null }, what: string): T => {
  if (r.error) throw new Error(`${what}: ${r.error.message}`);
  return r.data;
};

async function seed() {
  must(await service.from("exchanges").upsert({ code: "NMS", name: "NasdaqGS", country: "United States", timezone: "America/New_York", currencies: ["USD"] }), "exchange");
  const defs = [["grnc", "Greenfield Corp", "GRNC", "0000111111"], ["rdco", "Redline Holdings", "RDCO", "0000222222"], ["hold", "Holdfast Inc", "HOLD", "0000333333"]] as const;
  for (const [k, name, sym, cik] of defs) {
    must(await service.from("companies").upsert({ id: co[k], name, name_normalized: name.toLowerCase(), sec_cik: cik, sector: "Technology" }), `company ${k}`);
    must(await service.from("securities").upsert({ id: ids[k], company_id: co[k], yahoo_symbol: sym, exchange_code: "NMS", currency: "USD", currency_major: "USD", quote_type: "EQUITY", financial_currency: "USD", is_canonical: true, role: "canonical" }), `security ${k}`);
  }
  const run = must(await service.from("scan_runs").upsert({ scan_date_local: RUN_DATE, status: "running", settings_snapshot: { provider_mode: "fixture" }, trigger: "manual", results_published_at: new Date().toISOString() }, { onConflict: "scan_date_local" }).select("id").single(), "scan run");
  const runId = (run as { id: string }).id;
  for (const k of ["grnc", "rdco"] as const) {
    const ep = must(await service.from("signal_episodes").insert({ security_id: ids[k], company_id: co[k], kind: "discount", mode: "worldwide", threshold_line: "-3", opened_scan_run_id: runId, opened_session_date: "2098-12-31", opened_close: 10, opened_line_value: 12, open_reason: "new_entry", last_evaluated_session_date: "2098-12-31" }).select("id").single(), `episode ${k}`);
    must(await service.from("todays_discounts").insert({ scan_run_id: runId, mode: "worldwide", security_id: ids[k], company_id: co[k], episode_id: (ep as { id: string }).id, is_new_episode: true, rank: k === "grnc" ? 5 : 6, close: 10, currency: "USD", session_date: "2098-12-31", threshold_line: "-3", lower_line_end: 12, channel: {}, trend_ok: true, eligibility: {}, operational_category: "pending", category_reason: "research_pending", data_freshness: "fresh", display_order: 0 }), `card ${k}`);
  }
  must(await service.from("risk_monitor_state").upsert({ user_id: USER, security_id: ids.hold, reasons: ["outside_top50"], last_seen_items: { seen: { edgar: ["0000333333-26-000001"], rss: ["x"], yahoo: ["x"] }, latest: {} }, next_due_at: null }), "monitor row");
  return runId;
}

async function enqueue(runId: string, stage: string, key: string, payload: Record<string, unknown>, priority = 10) {
  must(await service.from("scan_jobs").upsert({ scan_run_id: runId, stage, key, payload, priority }, { onConflict: "scan_run_id,stage,key", ignoreDuplicates: true }), `enqueue ${key}`);
}

async function drain(runId: string, stages: string[], maxMs = 240_000) {
  const t0 = Date.now();
  for (;;) {
    await fetch(`${url}/functions/v1/worker-tick`, { method: "POST", headers: { "x-cron-secret": cron } });
    await new Promise((r) => setTimeout(r, 2500));
    const open = must(await service.from("scan_jobs").select("id").eq("scan_run_id", runId).in("stage", stages).in("status", ["queued", "leased", "failed"]), "poll");
    if ((open as unknown[]).length === 0) return;
    if (Date.now() - t0 > maxMs) throw new Error(`jobs did not drain: ${stages.join(",")}`);
  }
}

async function cleanup(runId: string) {
  await service.from("todays_discounts").delete().eq("scan_run_id", runId);
  await service.from("research_reports").delete().in("security_id", Object.values(ids));
  await service.from("risk_findings").delete().eq("user_id", USER);
  await service.from("risk_monitor_state").delete().eq("user_id", USER);
  await service.from("signal_episodes").delete().eq("opened_scan_run_id", runId);
  await service.from("scan_runs").delete().eq("id", runId);
}

const runId = await seed();
try {
  const plan = (sid: string, trigger = "new_discount") => ({ security_id: sid, trigger, scan_date_local: RUN_DATE });
  await service.from("app_settings").upsert({ key: "research", value: { max_full_reports_per_day: 1, tavily_daily_cap: 32, tavily_monthly_budget: 950, llm_daily_request_cap: 300, max_change_checks_per_day: 40, reuse_days: 30, tavily_reserved_for_reports: 24 } });
  await service.from("ai_quota_usage").delete().like("resource", "full_reports:%");

  // A. daily cap of one report: exactly one finishes, the other is deferred and stays pending (never cleared)
  for (const k of ["grnc", "rdco"] as const) await enqueue(runId, "research", `research:${ids[k]}:new_discount:plan`, plan(ids[k]));
  await drain(runId, ["research"]);
  const afterA = must(await service.from("research_reports").select("id, security_id, status, error").in("security_id", [ids.grnc, ids.rdco]), "reports A") as { id: string; security_id: string; status: string; error: string | null }[];
  check(afterA.filter((r) => r.status === "complete").length === 1, "A: one report complete under max_full_reports_per_day = 1");
  const deferred = afterA.find((r) => r.status === "quota_deferred");
  check(deferred && deferred.error === "daily_cap", "A: the other report is quota_deferred with daily_cap");
  const cardOf = async (sid: string) => (must(await service.from("todays_discounts").select("operational_category").eq("scan_run_id", runId).eq("security_id", sid).single(), "card") as { operational_category: string }).operational_category;
  check((await cardOf(deferred.security_id)) === "pending", "A: the deferred candidate stays pending");

  // B. raise the cap and resume the deferred report the way the stage 10 seeder does
  await service.from("app_settings").upsert({ key: "research", value: { max_full_reports_per_day: 4, tavily_daily_cap: 32, tavily_monthly_budget: 950, llm_daily_request_cap: 300, max_change_checks_per_day: 40, reuse_days: 30, tavily_reserved_for_reports: 24 } });
  await service.from("research_reports").update({ not_before: new Date(Date.now() - 1000).toISOString() }).eq("id", deferred.id);
  await enqueue(runId, "research", `research:${deferred.id}:plan:resume:${RUN_DATE}`, { ...plan(deferred.security_id), report_id: deferred.id, step: "plan" });
  await drain(runId, ["research"]);

  // C. monitored holding with a material 8-K: baseline already present, so the new 8-K is a delta
  await service.from("risk_monitor_state").update({ last_seen_items: { seen: { edgar: ["0000333333-26-000001"], rss: ["x"], yahoo: ["x"] }, latest: { edgar: [{ id: "0000333333-26-000003", title: "8-K filed 2026-10-14", link: "https://www.sec.gov/Archives/edgar/data/333333/000033333326000003/hold-8k.htm", publishedAt: "2026-10-14", form: "8-K" }] } } }).eq("user_id", USER).eq("security_id", ids.hold);
  await enqueue(runId, "research", `research:${ids.hold}:check`, { kind: "change_check", security_id: ids.hold, scan_date_local: RUN_DATE }, 50);
  await drain(runId, ["research"]);

  // D. final classification
  await enqueue(runId, "classify", "classify:final", {}, 100);
  await drain(runId, ["classify"]);

  const grnc = must(await service.from("research_reports").select("*").eq("security_id", ids.grnc).eq("trigger", "new_discount").single(), "grnc report") as Record<string, any>;
  const rdco = must(await service.from("research_reports").select("*").eq("security_id", ids.rdco).eq("trigger", "new_discount").single(), "rdco report") as Record<string, any>;
  check(grnc.status === "complete" && (await cardOf(ids.grnc)) === "green", "GRNC is complete and Green");
  check(rdco.status === "complete" && (await cardOf(ids.rdco)) === "red", "RDCO is complete and Red");
  check(grnc.provider && grnc.model && grnc.prompt_version && grnc.schema_version, "provider, model, prompt_version and schema_version are persisted");

  const sources = must(await service.from("research_sources").select("evidence_id, verification, http_status, content_hash, retrieved_at, liveness_verified_at, used_in_report").eq("report_id", grnc.id), "sources") as Record<string, any>[];
  const cited = sources.filter((s) => (grnc.cited_evidence_ids as number[]).includes(s.evidence_id));
  check(cited.length > 0 && cited.every((s) => s.verification === "ok" && s.http_status === 200 && s.content_hash && s.retrieved_at && s.liveness_verified_at && s.used_in_report), "every cited source has liveness fields and is used_in_report");

  const publicCards = must(await anon.from("v_todays_discounts").select("security_id, operational_category, withheld").eq("mode", "worldwide"), "anon view") as { security_id: string; operational_category: string; withheld: boolean }[];
  check(publicCards.some((c) => c.security_id === ids.grnc && !c.withheld), "the Green candidate is a public card");
  check(!publicCards.some((c) => c.security_id === ids.rdco && !c.withheld), "the Red candidate is absent from the public cards");
  check(publicCards.some((c) => c.security_id === ids.rdco && c.withheld && c.operational_category === "red"), "the Red candidate is in the withheld view");

  const findings = must(await service.from("risk_findings").select("category, severity").eq("user_id", USER).eq("security_id", ids.hold), "findings") as { category: string }[];
  check(findings.length === 1 && findings[0]?.category === "liquidity_debt", "HOLD: one liquidity_debt finding from the material 8-K");
  const change = must(await service.from("research_reports").select("id, trigger").eq("security_id", ids.hold), "hold reports") as { trigger: string }[];
  check(change.some((r) => r.trigger === "monitor_change") || change.some((r) => r.trigger === "monitor_first"), "HOLD: a full report was queued");

  // E. re-running creates no duplicate reports (idempotency key and reuse)
  const before = must(await service.from("research_reports").select("id").in("security_id", [ids.grnc, ids.rdco]), "count before") as unknown[];
  for (const k of ["grnc", "rdco"] as const) await enqueue(runId, "research", `research:${ids[k]}:new_discount:plan:rerun`, plan(ids[k]));
  await enqueue(runId, "research", `research:${ids.grnc}:manual:plan`, plan(ids.grnc, "manual"), 5);
  await enqueue(runId, "research", `research:${ids.grnc}:manual:plan:again`, plan(ids.grnc, "manual"), 5);
  await drain(runId, ["research"]);
  const after = must(await service.from("research_reports").select("id, trigger").in("security_id", [ids.grnc, ids.rdco]), "count after") as { trigger: string }[];
  check(after.length === before.length + 1 && after.filter((r) => r.trigger === "manual").length === 1, "re-running adds no duplicate report (one manual report for two manual requests)");
  const current = must(await service.from("research_reports").select("id").eq("security_id", ids.grnc).eq("is_current", true), "current") as unknown[];
  check(current.length === 1, "exactly one current report per security");
  console.log("research integration scenario passed");
} finally {
  await cleanup(runId);
}
```

- [ ] **Step 6: Chain it into `test:integration` and run it**

Root `package.json`: set `"test:integration": "bun run tools/run-local-scan.ts --self-test && bun run tools/self-test/research.ts"` (if P1 has not yet created the first part, use only the second until it does). Install the client if the root lacks it: `bun add -d @supabase/supabase-js@2.117.3`.

Run: `bun run supabase:reset` then `bun run supabase:serve` in a second terminal (env file with `PROVIDER_MODE=fixture`), then `bun run test:integration`
Expected: every `ok:` line printed and `research integration scenario passed`. Run `bun run lint` and `bun run typecheck`.

- [ ] **Step 7: Commit**

```text
git add supabase/functions/_shared/adapters/fixtures supabase/functions/_shared/adapters/providers.ts tools/self-test package.json bun.lock
git commit -m "test(research): add fixture-mode providers and the research integration scenario"
```

---

### Task 9: Operator guide section "AI research" (`docs/operator-guide.md`, parallel in wave A)

**Files:**
- Modify: `docs/operator-guide.md` (P0 skeleton: section 2 gets a P2 subsection, section 9 is filled)

**Interfaces:**
- Consumes: the P0 skeleton headings (`## 2. Configure Supabase, Vault, cron and function secrets`, `## 9. Review signal history and research reports (pending P2, P4)`); secret names from spec 3.11 and Task 2/3 (`GEMINI_API_KEY`, `GEMINI_MODEL`, `LLM_PRIMARY`, `LLM_ALT_*`, `TAVILY_API_KEY`, `JINA_API_KEY`, `SEC_USER_AGENT`).
- Produces: the operator-facing runbook for P2. Documentation only; every command below is for the operator on a real project and is not run during implementation.

- [ ] **Step 1: Replace the heading and body of section 9**

Replace `## 9. Review signal history and research reports (pending P2, P4)` and its (empty) body with the following. Keep the other sections untouched.

````markdown
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

Optional second provider for new reports when Gemini is nearly out of quota (it must speak the OpenAI chat-completions protocol with JSON-schema output; Groq, OpenRouter `:free` models and Mistral qualify, but mind their free limits: Groq free allows 8,000 tokens per minute, so it can only do very small calls):

```text
bunx supabase secrets set --project-ref <ref> LLM_ALT_PROVIDER=groq LLM_ALT_BASE_URL=https://api.groq.com/openai/v1 LLM_ALT_API_KEY=... LLM_ALT_MODEL=<model id>
```

`LLM_PRIMARY` is `gemini` (default) or `openai_compatible`. If a key is missing, research does not fail loudly: candidates stay "Research not configured" until you set it.

### 9.3 Daily caps (`app_settings.research`)

| Key | Default | Meaning |
|---|---|---|
| `max_full_reports_per_day` | 4 | full reports per trigger class per UTC day; more are deferred to the next day |
| `tavily_daily_cap` | 32 | Tavily credits per UTC day (6 per report, 1 per change check) |
| `tavily_reserved_for_reports` | 24 | the part of the daily credits only full reports may use |
| `tavily_monthly_budget` | 950 | credits per UTC month, safely under the free 1,000 |
| `llm_daily_request_cap` | 300 | model calls per UTC day; set it below the limit AI Studio shows you |
| `max_change_checks_per_day` | 40 | material-change checks per UTC day |
| `reuse_days` | 30 | a completed report is reused this long unless a material change is found |

Change a cap through `scan-control` `set_setting` (audited), for example `{"action":"set_setting","key":"research","value":{...all keys...}}`.

### 9.4 Run research on demand

`scan-control` action `research_now` queues a manual full report for one security in the latest scan:

```text
curl -X POST "https://<ref>.supabase.co/functions/v1/scan-control" -H "x-cron-secret: <CRON_SHARED_SECRET>" -H "content-type: application/json" -d "{\"action\":\"research_now\",\"security_id\":\"<security uuid>\"}"
```

A second request on the same Sofia day returns the existing report. Add `"force":true` to re-run a report that failed. The worker finishes the 13 steps in about 15 to 40 minutes.

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

Reading the `error` column of a `quota_deferred` report: `llm_quota` (model limit, retried next UTC day), `tavily_quota` (search credits), `daily_cap` (`max_full_reports_per_day`), `provider_not_configured` (a key is missing: set it, then use `research_now` with `force`, or wait for the next day's automatic retry). A `failed` report with `citation_verification_failed` or `unknown_evidence_id` means the model produced an answer that could not be verified twice; the candidate is shown as Grey ("research failed"), never as cleared.

### 9.6 Privacy statement

Only public information leaves the system: the company name, ticker, exchange, reporting currency, the research date, public document URLs and the text of public documents. No user id, email, quantity, cost basis, portfolio composition or broker data is ever sent to Gemini, Tavily or Jina, and prompts are identical for a candidate and for a security someone holds. The **free Gemini service uses submitted content to improve Google products**; that is acceptable here only because the content is public. Whether a private individual's public site meets the free tier's "professional or business purposes" wording is an open question (Q-04); the research pages show an AI disclaimer and the model used, and a legal review of the "Meets / Does not meet" wording is recommended (Q-05).
````

- [ ] **Step 2: Add the P2 secrets to section 2 step 4**

In `## 2.` step 4, after the sentence listing `CRON_SHARED_SECRET SEC_USER_AGENT SITE_URL`, append: `The research secrets (GEMINI_API_KEY, GEMINI_MODEL, TAVILY_API_KEY, optional JINA_API_KEY and LLM_ALT_*) are explained in section 9.2.`

- [ ] **Step 3: Commit**

```text
git add docs/operator-guide.md
git commit -m "docs: add the AI research operator guide (keys, secrets, caps, research_now, quota, privacy)"
```

---

### Task 10: Phase exit checklist

**Files:**
- Create: `docs/discovery/p2-results.md` (verification record: command outputs, the numbers measured in P2-01..P2-06)
- Modify: `docs/superpowers/specs/2026-10-15-stock-screener-design.md` (one pointer line in 19.2, as P0 did)

**Interfaces:**
- Consumes: Tasks 1-9 merged. Runs on the owner's machine with Docker; the live items need the owner's free keys.

- [ ] **Step 1: Run every automated gate**

Run, in order:

```text
bun run lint
bun run typecheck
bun run test:core
bun run test:web
bun run functions:check
bun run functions:test
bun run supabase:reset
bun run test:db
bun run test:integration
```

Expected: all exit 0; `test:db` lists `research_quota.sql`, `research_constraints.sql`, `research_rls.sql` as passing; `test:integration` prints `research integration scenario passed`. Paste the tail of each output into `docs/discovery/p2-results.md`.

- [ ] **Step 2: Self-review checklist (tick each against the diff)**

- Every Global Constraint value appears in code and in a test: 6 queries, 8 documents (3 EDGAR), 48,000 characters, 8 Stage-1 calls, one Stage-2 call plus one retry, 4 liveness GETs, 300-character quotes, 350-1,100 words, 30 days, `app_settings.research` seed equals spec 9.8.
- The five Review Focus failure modes each have a named failing-then-passing test (search the test names listed in the Review Focus section).
- `RESEARCH_PROMPT_TEMPLATE` equals `prompt.txt` lines 554-589 and the spec block (Task 4 tests green).
- `git grep -n "paid\|billing" -- supabase/functions` shows no code path that enables billing or a paid provider.
- `git grep -n "user_id\|quantity" -- supabase/functions/_shared/core/research.ts supabase/functions/worker-tick/handlers/research_steps.ts` shows no user data in prompt-building code.
- No placeholder text, no `TODO`, in the new files; names match across tasks (`new_discount`, `quota_deferred`, `provider_not_configured`, `research_report_id`, `research_summary`).

- [ ] **Step 3: Live verification tasks of spec 18 (owner, free keys; record results in `docs/discovery/p2-results.md`)**

- P2-01: send the Stage 2 schema to the real Gemini model; record whether `responseSchema` accepts it after `toGeminiSchema` and adjust only that function if not.
- P2-02: run `research_now` for five companies (a US large cap, an ADR filer, a bank, a non-SEC filer, a distressed name); record tokens, latency, evidence counts; tune the caps if a step exceeds 100 s.
- P2-03: confirm EDGAR submissions with the declared User-Agent at the 4 req/s pacing.
- P2-04: check Jina Reader on one 10-K and one IR PDF.
- P2-05: confirm the IBKR catalogue import and EUR resolution if the P2 `eur_catalogue`/`eur_resolve` stages (spec 5.7) were scheduled into this phase by the lead (they are not part of this plan).
- P2-06: read the Tavily and Jina storage terms and note the result in Q-04/Q-05.
- Exit criteria (spec 18): the five test reports pass citation validation with no fabricated URL; Green, Amber, Red, Grey and pending behave per the table; quota exhaustion produces `quota_deferred` and never a cleared candidate; daily caps hold over a 5-day run (`ai_quota_usage` never exceeds a limit).

- [ ] **Step 4: Record and commit**

Add to section 19.2 of the spec one line: `P2 verification results: docs/discovery/p2-results.md`.

```text
git add docs/discovery/p2-results.md docs/superpowers/specs/2026-10-15-stock-screener-design.md
git commit -m "docs: record P2 verification results and exit checklist"
```
