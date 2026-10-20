# P7 verification results

Written at the end of P7 (spec 18). Environment: Windows 11 Enterprise, Bun 1.3.14, Node 22.13.1, Deno 2.9.6 locally (2.1.x in CI),
Supabase CLI 2.121.0, TypeScript 6.0.3, Biome 2.5.15; the commit under test is the field `commit` of `docs/discovery/p7-evidence/summary.json`.
Evidence files: `docs/discovery/p7-evidence/` (one file per suite with the exit code and the last 120 lines, `summary.json`).
CI has not run: the repository has no remote; the first push triggers `ci.yml` (P0 Task 7 step 10 applies).

## 1. Suite results

<!-- suites:begin -->
| Suite | Command | Result | Summary | Time | Evidence |
|---|---|---|---|---|---|
| lint | `bun run lint` | PASS | 694 files checked | 3.8 s | `docs/discovery/p7-evidence/lint.txt` |
| lint-workflows | `bun run lint:workflows` | PASS |  | 1.0 s | `docs/discovery/p7-evidence/lint-workflows.txt` |
| typecheck | `bun run typecheck` | PASS |  | 20.2 s | `docs/discovery/p7-evidence/typecheck.txt` |
| test-core | `bun run test:core` | PASS | 470 tests passed | 9.3 s | `docs/discovery/p7-evidence/test-core.txt` |
| test-tools | `bun run test:tools` | PASS | 161 tests passed | 8.0 s | `docs/discovery/p7-evidence/test-tools.txt` |
| test-web | `bun run test:web` | PASS | 1035 tests passed | 65.5 s | `docs/discovery/p7-evidence/test-web.txt` |
| check-functions-config | `bun run check:functions-config` | PASS |  | 0.9 s | `docs/discovery/p7-evidence/check-functions-config.txt` |
| functions-check | `bun run functions:check` | PASS |  | 3.8 s | `docs/discovery/p7-evidence/functions-check.txt` |
| functions-test | `bun run functions:test` | PASS | 650 passed, 0 failed | 19.2 s | `docs/discovery/p7-evidence/functions-test.txt` |
| functions-selftest | `bun run functions:selftest` | PASS |  | 4.8 s | `docs/discovery/p7-evidence/functions-selftest.txt` |
| check-fetch | `bun run check:fetch` | PASS |  | 0.9 s | `docs/discovery/p7-evidence/check-fetch.txt` |
| check-secrets | `bun run check:secrets` | PASS |  | 1.0 s | `docs/discovery/p7-evidence/check-secrets.txt` |
| audit | `bun run audit` | PASS |  | 50.1 s | `docs/discovery/p7-evidence/audit.txt` |
| build | `bun run build` | PASS |  | 7.7 s | `docs/discovery/p7-evidence/build.txt` |
| check-bundle | `bun run check:bundle` | PASS |  | 1.2 s | `docs/discovery/p7-evidence/check-bundle.txt` |
| check-headers | `bun run check:headers` | PASS |  | 1.0 s | `docs/discovery/p7-evidence/check-headers.txt` |
| test-e2e | `bun run test:e2e` | PASS | 40 passed | 52.1 s | `docs/discovery/p7-evidence/test-e2e.txt` |
| test-db | `bun run test:db` | PASS | 29 files, 1321 tests, PASS | 6.6 s | `docs/discovery/p7-evidence/test-db.txt` |
| test-integration | `bun run test:integration` | PASS |  | 132.6 s | `docs/discovery/p7-evidence/test-integration.txt` |
| test-e2e-local | `bun run test:e2e:local` | PASS | 39 passed | 304.6 s | `docs/discovery/p7-evidence/test-e2e-local.txt` |
<!-- suites:end -->

The suites ran strictly one at a time (`tools/verify-all.ts` never starts two). The local suites (`test-integration`, `test-e2e-local`)
were served by the local stack's own Edge Runtime, which reads `supabase/functions/.env` (git-ignored); no separate
`.env.integration` file exists (`git grep env.integration -- tools package.json` finds nothing), so one file served every suite.
`supabase/functions/.env` must carry `JWT_ISSUER=http://127.0.0.1:54321/auth/v1`; `tools/e2e-setup.ts` and `tools/test-integration.ts` now
stop with a message naming the file and the value when it is missing or different (`jwtIssuerProblem`, unit-tested in `e2e-env.test.ts`).

Scripts named in the plans that were **not built**, and therefore are not suites here and are not claimed as met:

| Script | State | Reason |
|---|---|---|
| `check:guide` | not built | P7 Task 5 specified it, but no `tools/check-operator-guide.ts` exists in the repository and Task 6 has no implementation for it; the operator guide has no automated completeness check |
| `gen:secret` | not built | same: specified in the Task 5 brief only; the operator guide does not list it as an existing script |

`e2e:setup` exists (`tools/e2e-setup.ts`) and is run inside the `test-e2e-local` suite (`bun run tools/e2e-setup.ts --ensure`).

### 1.1 Local probes and the parity tool

<!-- probes:begin -->

<!-- probes:end -->

## 2. Acceptance criteria (brief section 36, spec 17.7)

Verdict values: met, changed by decision, out of scope, not demonstrated, owner-run. "Changed" items carry the decision id of spec 1.3 and the
owner's acceptance is part of the sign-off of this record. Every cited suite passes in section 1; no verdict was lowered by the evidence rule,
except that the first live Yahoo scan and the TradingView comparison were never executed locally (plan decision P7-D7): they are owner-run.

| # | Criterion | Spec 17.7 status | Verdict | Evidence |
|---|---|---|---|---|
| 1 | Public users can access Overview and Quotes without login | in scope | met | `apps/web/e2e/local/10-overview.local.spec.ts`; `csp.spec.ts` (public routes); `0900_rls_matrix.test.sql` (anon reads); suites `test-e2e-local`, `test-db` |
| 2 | Worldwide and US universes selectable without mutating shared state | in scope | met | `10-overview` (switch performs no write); `0900_rls_matrix` (anon cannot write); suite `test-e2e-local` |
| 3 | Company List ranks by market cap, highlights top 10 | in scope | met | core ranking tests (`test-core`); `10-overview` (15 rows, Load more); `0130_public_reads.test.sql` |
| 4 | Seven-day summary accurate | in scope | met | `0130_public_reads.test.sql`, `0140_data_functions.test.sql` (`universe_summary`, `company_list`); suite `test-db` |
| 5 | Daily scan uses completed bars at 10:00 Europe/Sofia | in scope | met | `0120_pipeline.test.sql` (DST replays of `start_daily_scan`); core bars and calendar tests; suites `test-db`, `test-core` |
| 6 | Channel matches Pine within tolerance | in scope | owner-run (fixtures met; TradingView comparison not executed locally) | `indicator.test.ts` parity fixtures F1 to F9 (`test-core`); `tools/parity-print.ts`; `docs/discovery/parity-results.md` |
| 7 | Uptrend filter uses visual direction | in scope | met | `indicator.test.ts` (F1, F2, F3, F9 `rising`); suite `test-core` |
| 8 | -3/-4 conditions and zero-line filter | in scope | met | `thresholds.test.ts`, `eligibility.test.ts`; suite `test-core` |
| 9 | No duplicate signal episodes | in scope | met | episode tests (`test-core`); partial unique indexes in `0100_schema.test.sql`; idempotent re-run scenario of `test-integration` |
| 10 | Research completes before Green/Amber inclusion in the digest | changed (V12) | changed by decision | digest tests (`test-core`); notification and digest scenarios of `test-integration`; the cut-off rule of spec 7.10 |
| 11 | Amber after Green with explicit labelling | in scope | met | digest tests (`test-core`); `todays-discounts.test.tsx` (`test-web`) |
| 12 | Red and Grey never presented as cleared | in scope | met | classify tests (`test-core`); `withheld-panel` and overview tests (`test-web`) |
| 13 | Owned operating companies outside top 50 monitored daily (as of the last Flex statement) | in scope | met | risk monitor tests and the broker and research scenarios of `test-integration` |
| 14 | Material new portfolio risks deduplicated and in the portfolio digest | in scope | met | risk fingerprint tests (`functions-test`); digest dedupe scenarios of `test-integration` |
| 15 | EUR equivalents verified and never replace the screening instrument (IBKR catalogue permission UNVERIFIED, Q-10) | in scope | met | `0600_eur_handoff.test.sql`; resolution tests (`functions-test`); `60-handoff.local.spec.ts` |
| 16 | Web Push and e-mail independently configurable | in scope | met | `0400_notifications_schema.test.sql` to `0402`; `40-notifications.local.spec.ts`; suite `test-integration` |
| 17 | No access to other users' data | in scope | met | `0900_rls_matrix.test.sql`; `35-isolation.local.spec.ts`; suites `test-db`, `test-e2e-local` |
| 18 | Broker linking only after real capability checks | changed (D4, D5) | changed by decision | linking requires a retrieved and parsed statement: `broker-sync` tests (`functions-test`); broker scenario of `test-integration` |
| 19 | Portfolio and Analytics refresh every five minutes; one-minute manual cooldown | changed (V7) | changed by decision | `AUTO_REFRESH_MS` and `MANUAL_COOLDOWN_S` tests (`test-core`, `test-web`); cooldown in `50-portfolio-analytics.local.spec.ts` and the atomic claim in `0500_broker_schema.test.sql` |
| 20 | Order preparation shows a labelled IBKR quote and freshness | changed (V3) | changed by decision | the dialog shows a labelled Yahoo delayed quote: P6 web tests (`test-web`); `60-handoff.local.spec.ts` |
| 21 | Orders require explicit confirmation and correct contract selection | changed (V4) | changed by decision | no orders exist; the dialog provides the verified EUR listing, conid and checklist: `60-handoff.local.spec.ts` asserts the no-orders statement and that nothing is written |
| 22 | Submission timeout recovery cannot duplicate a live order | out of scope | out of scope | the application never submits an order (`git grep -il "submit order" -- apps/web/src ":!*.test.*"` returns nothing; the only hits are tests asserting that no such button exists; triage item D-60) |
| 23 | Modifications, partial fills, commissions, final executions | changed / out of scope (V6) | changed by decision | order modification is out of scope; executions, actual commissions and realized P/L come from Flex: accounting tests (`test-core`); broker scenario of `test-integration` |
| 24 | Realized P&L includes closed positions; dividends separate with include toggle | in scope | met | accounting tests (`test-core`); portfolio and analytics web tests (`test-web`) |
| 25 | No mixed-currency totals without conversion | in scope | met | `Money` accounting tests (`test-core`) |
| 26 | Missing or stale prices and failed research honestly labelled | in scope | met | state component and page tests (`test-web`); `90-a11y-viewports.local.spec.ts` renders every page |
| 27 | No credentials or private broker details in the browser | in scope | met | `check-bundle`; `0900_rls_matrix.test.sql`; `35-isolation` and `30-profile` specs; `security-review.md` section 3 |
| 28 | Builds, type checks, tests and deployable artifacts succeed; blockers documented | in scope | met locally; CI not yet run | section 1 (all suites PASS); `build` and `check-headers` evidence |

Verdict counts: 28 criteria: 20 met, 6 changed by decision, 1 out of scope, 1 owner-run (row 6: fixtures met, TradingView comparison and live Yahoo scan not executed locally), 0 not demonstrated.

## 3. Spec 17.5 end-to-end coverage

1 and 2 `10-overview`; 3 `10-overview`; 4 stubbed chart specs in `test-e2e`; 5 and 6 `20-auth`; 7 `50-portfolio-analytics`; 8 `60-handoff`;
9 `smoke.spec.ts` (theme persists); 10 `keyboard.spec.ts`; 11 `90-a11y-viewports` and `a11y.spec.ts`. No test places an order; no test
calls a production provider.

## 4. TradingView manual parity (spec 17.6, acceptance 6)

Owner-run, repeated at any indicator change; results go to `docs/discovery/parity-results.md`. The first live Yahoo scan is also owner-run
(plan decision P7-D7): it was not executed locally, so no real provider series exists on this machine to compare against TradingView.

1. [ ] Instruments: AAPL (NASDAQ), MSFT, NVDA (split history), SAP (XETR), 7203 (TSE), 0700 (HKEX), NESN (SIX), and one listing with fewer than 2,500 bars (negative case).
2. [ ] After the close, print our levels: `bun run parity -- --symbol MSFT --as-of <date>` (set `SUPABASE_URL` and `SUPABASE_ANON_KEY` of the project that holds the series).
3. [ ] TradingView: Daily chart of the same listing, "Adjust data for dividends" OFF, add `stddevchn.pine` with Length 2500, Source close, Upper +1 x1, Upper +2 x2, Lower -1 x3, Lower -2 x4, all four checkboxes on, Extend Right on; read after the close.
4. [ ] Read the values at full precision (temporary `label.new` with `str.tostring(value, "#.################")` or the Data Window).
5. [ ] Compare the last 5 closes and the first bar of the 2,500-bar window first; differing bars are a data difference, not an algorithm failure.
6. [ ] Compare each level with `|diff| <= 0.5 * 10^-p + 1e-9`, the direction and the classification.
7. [ ] Record every instrument in `parity-results.md`.
8. [ ] Pass: all levels within tolerance for all instruments, or each discrepancy explained as a data difference with evidence.

## 5. Hosted drills (owner-run, operator guide section "Production cut-over and drills")

| Drill | Date | Result | Notes |
|---|---|---|---|
| Keep-alive failure (`KEEPALIVE_MAX_AGE_HOURS=0`) | not run | not run | needs the hosted project and GitHub; the local equivalent is in `security-review.md` section 10 |
| Kill switch | not run | not run | local proof: `throttle.test.ts`, `0910_providers_setting.test.sql` |
| Backup restore | not run | not run | |
| Secrets comparison | not run | not run | |
| Unattended production day | not run | not run | |

## 6. Open questions after P7

| ID | State |
|---|---|
| Q-01 pause activity | open: needs weeks on the hosted project; keep-alive plus the weekly manual open of the site (operator guide section 12) |
| Q-02 Edge Runtime limits | open: measure during the first hosted scans (`scan_events` durations) |
| Q-03 Yahoo "commercial" | open, owner: risk accepted (D1), restated in operator guide section 1 |
| Q-04, Q-05 Gemini terms, legal review of conclusions | open, owner: disclaimers are on `/about` and the report pages |
| Q-06 close public sign-up | open, owner: how to is in operator guide 13.6 |
| Q-07 staging | decided: none; the local stack plus preview builds |
| Q-08, Q-10 IBKR portal behaviour and website terms | open, owner tests (P6-01, P6-02 in operator guide) |
| Q-09 privacy policy and self-service deletion | open, owner: manual deletion procedure in operator guide 13.4 |
| Q-11 Flex attribute names | open until the first real statement (P5-01 to P5-03 in operator guide section 5.4) |
| Q-12 TradingView default adjustment | answered by the parity run (section 4) |
| Q-13 to Q-17 | resolved or recorded by the phase that owned them (see the phase results documents) |

## 7. Deferred review findings and security review

Triage of 64 ledger items: `docs/discovery/p7-triage.md` (22 fixed in P7, 7 already fixed, 35 deferred with reasons). Security review
with 19 findings and their status: `docs/discovery/security-review.md`. Owner confirmations needed: failed-scan banner colour (D-47),
the residual risks S-13, S-14, S-16, and the open questions above.
