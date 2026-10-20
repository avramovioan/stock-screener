# P1 verification record (engine and pipeline)

Date: 2026-10-15. Branch `build/initial`. Closing task: plan Task 21. Spec sections 18 (P1) and 19.2.

## 1. Checks run in this session

| Command | Result |
|---|---|
| `bun run typecheck` | exit 0 (web, core, tools; `core purity: OK (13 files scanned, 6 canary globals rejected)`) |
| `bun run lint` | exit 0; 0 errors, 54 warnings, 244 infos (pre-existing style diagnostics) |
| `bun run test:core` | 13 files, 336 tests passed (includes parity fixtures F1-F9; the plan's 268 was the count at drafting time) |
| `bun run test:tools` | 8 files, 58 tests passed |
| `bun run functions:check` | exit 0 |
| `bun run functions:test` | 240 passed, 0 failed, 2 ignored (the two opt-in live tests) |
| `bun run check:functions-config` | `functions config: OK (health, quotes, retention-cleanup, scan-control, worker-tick)` |
| `bun run test:db` | 15 files, 393 assertions run; FAIL only in `supabase/tests/0400_notifications_schema.test.sql` (see 1.1). `0160_episode_transition.test.sql` (now plan 16) and all other suites ok |
| `bun run test:integration` | NOT run in this session (it resets the database while other agents use it). Last green at commit 948dbda, as reported by its implementer (fixture mode: reset, day 1, idempotent rerun, pagination, day 2 rank change) |

### 1.1 test:db failure, not fixed here

`0400_notifications_schema.test.sql` was an untracked file owned by the notifications (P3) agent when run. It stops at line 41 with `malformed array literal: "'{worldwide}'::universe_mode[]"` in `col_default_is` for `digest_modes` (the default expression is passed as a quoted cast string instead of array text). It is a test-authoring bug in that agent's uncommitted work, not a P1 regression. Re-run `bun run test:db` once that file is fixed.

### 1.2 Mechanical guards

- `bun run tools/check-core-purity.ts`: OK.
- `rg "Date\.now|Math\.random|\.localeCompare" supabase/functions/_shared/core --glob '!*.test.ts'`: one hit, `core/mod.ts:2`, a comment stating the rule ("no Date.now(), no Math.random()"). No code use. Treated as pass.
- `rg 'yahoo-finance2"|from "yahoo-finance2' supabase/functions`: no output (pass).

## 2. Part A fix (this session)

`app.transition_episode(uuid,text,date,jsonb)` lacked the revoke/grant lock-down required by the app-function convention (header of `20261015001200_pipeline_functions.sql`). New migration `20261015001700_episode_transition_grants.sql` revokes from public, anon, authenticated and grants execute to service_role; applied with `bunx supabase migration up --include-all`; two privilege assertions added to `0160_episode_transition.test.sql` (plan 14 to 16). Commit e134b03.

## 3. Exit criteria of spec section 18 (P1)

| Criterion | Status |
|---|---|
| F1-F9 parity fixtures pass | Verified (test:core above) |
| RLS and DST tests pass | Verified (test:db: all suites except the foreign 0400 file) |
| Live manual scan over the real universe with coverage report (Task 20) | Not verified in this session, owner step |
| Ranks and signals reproducible (`recompute` identical) | Not verified in this session, owner step (the fixture-mode integration test covers the idempotent rerun, last green 948dbda) |
| Hosted CPU/wall of `fetch_bars` (12) and `compute` (25) jobs, then freeze batch sizes (P1-07) | Not verified in this session, owner step (needs the hosted project; then `scan-control set_setting` on `app_settings.pipeline`) |
| Database size projection below 60% of the limit (P1-08) | Not measurable locally: the local database holds 0 securities and 0 `price_series` rows (database 19.8 MB, all schema overhead; largest tables scan_jobs 232 KB, scan_runs 152 KB). The spec 6.11 engineering estimate is 250-370 MB of 500 MB (50-74%), so the 60% target (300 MB) is NOT yet demonstrated; measure after the live scan |

### 3.1 Owner steps (Task 20 live run; automation was denied by the permission system and not bypassed)

```bash
bunx supabase db reset
# in psql or Studio SQL editor:
select vault.create_secret('http://host.docker.internal:54321','project_url');
select vault.create_secret('<CRON_SHARED_SECRET from supabase/functions/.env>','worker_tick_secret');
bun run tools/run-local-scan.ts start --mode live
bun run tools/run-local-scan.ts tick      # repeat until the run is terminal
bun run tools/run-local-scan.ts status
bun run tools/run-local-scan.ts failures
# then recompute and compare ranks and signals (Task 20 step 5)
# size projection after the run:
#   select relname, pg_size_pretty(pg_total_relation_size(oid)) from pg_class
#    where relnamespace = 'public'::regnamespace and relkind = 'r' order by pg_total_relation_size(oid) desc;
#   extrapolate price_series bytes per security to about 600 securities
```

## 4. Deviations recorded in the plan

The planner's 14 deviations were accepted by ruling (spec names over brief aliases; Vault names `project_url` and `worker_tick_secret`; pg_net timeout 145000 ms; `company_list` SECURITY DEFINER; `is_admin()` in `public`; `start_daily_scan` seeds only `fx`, later stages come from `next_stage_to_seed`; extra SQL helpers; fixture-run deadlines relative to `started_at`; additive core signatures; the rest in the SDD ledger `progress.md`). Review-driven overrides of plan text: Task 17 compute filters `market_cap_snapshots` by run (I1) and carry-forward handles a missing result row correctly (I2); spec 4.6, 7.7 and 8.3 won over the plan text.

## 5. Review rounds

- Core T1-T7: spec pass; 3 Important findings fixed in round 1 (commits 205070c, 9739e90); re-review clean.
- Adapters T8-T11 and DB T12-T16: Important findings fixed in round 1 (fail_job lease guard migration 20261015001400; no credential recording, drift error, wider redaction; commits 69ccc6c, a874076); re-review clean.
- T17-T19: T17 had I1-I5 (run filter, carry-forward, dropped-member coverage, non-atomic episode transition, test gaps), fixed in round 1 (commit 948dbda); re-review found only the missing lock-down, fixed in e134b03. T18 and T19 passed.
- Task 20: parked after three permission denials (db reset, Vault inserts, start RPC).

## 6. P1 answers to spec 19.2

See the Q-15, Q-16 and Q-17 rows in `docs/superpowers/specs/2026-10-15-stock-screener-design.md` section 19.2.
