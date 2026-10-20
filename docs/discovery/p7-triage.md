# P7 deferred-minor triage

Source: `.superpowers/sdd/*/progress.md` (git-ignored), collected on 2026-10-15; verdicts decided in P7 Task 3.

| ID | Ledger and task | Item | Verdict | Where, or why deferred |
|---|---|---|---|---|
| D-01 | P0 T4 | `sw.ts` `focusOrOpen` should try/catch navigate and focus | fixed already | commit 188a8b8 (`sw-click.ts`) |
| D-02 | P0 T4 | secret scan uses a fixed name list | fixed already | commit a033335 (single secret-name list, `secret-names.ts`) |
| D-03 | P0 T2 | core-purity scan is line based; canary file in the source tree | defer | `tsc` with `lib: ES2023` plus the canary already rejects the dangerous globals; step 1 greps for `Math["random"]` and split `new Date(` and expects nothing; revisit if a purity bug is ever found |
| D-04 | P0 T5 | `readJson` reads the whole body before the size check | fix now | step 2 |
| D-05 | P0 T5 | `requireCronSecret` should trim | fix now | step 2 |
| D-06 | P0 T5 | hand-rolled TOML parser limits | defer | `config.toml` is ours and `check:functions-config` has tests; replace the parser only if the file grows tables it cannot read |
| D-07 | P0 T5 | pgtap extension reaches production through a migration | fixed already | commit 70d93a8 (created inside the test transactions) |
| D-08 | P0 T3 | contrast test misses primary on background, muted on card, destructive as text | fix now | step 8 |
| D-09 | P0 T3 | `tsconfig` mixes DOM, WebWorker and node types | defer | no runtime effect; splitting `sw.ts` into its own project risks the PWA build; revisit with TypeScript 7 |
| D-10 | P0 T1/T3 | `happy-dom`, `vite`, `@vitejs/plugin-react` declared in root and `apps/web` | fix now | step 8 (equal ranges today; a guard test prevents drift) |
| D-11 | P0 workflow | `ci.yml` labeled trigger | fix now | step 8 (`types: [opened, synchronize, reopened, labeled]` plus a lint rule) |
| D-12 | P0 workflow | `deploy-web` path filter | defer | a missed deploy on a docs-only push is harmless and `workflow_dispatch` exists |
| D-13 | P0 workflow | blanket `--no-verify-jwt` | defer | only the local `supabase functions serve` uses it; production `verify_jwt = false` is per function and guarded by `check:functions-config` |
| D-14 | P0 workflow | workflow-lint array form | defer | cosmetic |
| D-15 | P1 T1-3 | ten Biome `useLiteralKeys` infos in `indicator.ts` | fix now | step 8 (Biome override for that file) |
| D-16 | P1 T4-7 | `evaluateTier2` freshness type union; reuse `lowerLinePositive` | defer | refactor without behaviour change; covered by eligibility tests |
| D-17 | P1 T4-7 | dedicated rule code for an unknown `dataSessionDay` | defer | needs a new `RuleCode` and a spec 4.6 wording change; the owner decides |
| D-18 | P1 T4-7 | derive `RuleCode` order from one constant | defer | refactor |
| D-19 | P1 T4-7 | `classifyHolding` finite check | fix now | step 5 (channel end values) |
| D-20 | P1 T4-7 | unused `Observation.rank` and `ActiveEpisode.kind` | defer | public core types consumed by P5b; removal is churn without benefit |
| D-21 | P1 T4-7 | fixture JSON Biome-reformatted versus the docs copy | fix now | step 5 (value-equality test) |
| D-22 | P1 T4-7 | exact test for spec 8.8 example 6 | defer | needs transcription of the worked example; episode behaviour is covered by the episode tests and `idempotency` integration |
| D-23 | P1 T4-7 | Saudi-aware `missingSessionRatio` | defer | Sunday to Thursday week is a product decision (A-16); Saudi securities may be marked `suspect` too often, visible in coverage |
| D-24 | P1 T8-11 | throttle counts network errors toward the breaker | defer | needs live Yahoo evidence from the P1 live scan; behaviour is conservative |
| D-25 | P1 T8-11 | `quote()` silently maps malformed responses to unknown | fixed already | commit a874076 (schema-drift error) |
| D-26 | P1 T8-11 | `claim_jobs` advisory lock order | defer | the two-session `jobs` pgTAP test and the integration lease-recovery scenario pass; no deadlock observed |
| D-27 | P1 T8-11 | `REDACT_KEY` misses cookie and crumb | fixed already | commit a874076; the remaining gap against spec 15.6 is Task 1 step 9 |
| D-28 | P1 T8-11 | `fx.ts` USD identity row labelled `frankfurter` | defer | the label is a CHECK-constrained value (`fx_rates.source in ('frankfurter','yahoo')`) and a provider type union; changing it needs a migration and type churn for a cosmetic label |
| D-29 | P1 T8-11 | `apply_quote_rows` duplicate symbols | fix now | `applyQuoteRows` in `worker-tick/lib/quotes.ts` did not de-duplicate symbols (a repeat would insert the same security twice); now de-duplicated, test in `quotes.test.ts` |
| D-30 | P1 T8-11 | `company_list.total_count` naming | defer | rename churns the RPC contract and the generated types |
| D-31 | P1 T8-11 | `is_admin` anon EXECUTE grant | fixed already | commit 19d0295 (is_admin and app function grants; migration `20261015007000_security_grants.sql`) |
| D-32 | P1 T8-11 | `reap_expired_leases` stale `last_error` | defer | cosmetic in an operator-only column |
| D-33 | P2 T2-4 | summary and `news_reason` word caps | defer | quality tuning, not safety |
| D-34 | P2 T2-4 | `stripUrls` misses scheme-less URLs | fixed already | commit a033335 (link-safe Markdown renderer) |
| D-35 | P2 T2-4 | `renderSources` publisher escaping | fixed already | commit a033335 (link-safe Markdown renderer, publisher escaping) |
| D-36 | P2 T2-4 | `validateStage1Facts` duplication | defer | refactor |
| D-37 | P2 T2-4 | `research.ts` size | defer | refactor |
| D-38 | P2 T2-4 | Jina `text()` outside the try and unbounded | fix now | step 3 |
| D-39 | P2 T2-4 | feed body read before the cap | fixed already | `rss.ts` goes through `fetchDocument`, which reads with `readCapped` (2 MB) |
| D-40 | P2 T2-4 | 2 MB HTML cap truncates 10-Ks | defer | quality decision; the evidence ledger still cites the retrieved part |
| D-41 | P2 T2-4 | unknown `LLM_PRIMARY` falls back silently | fix now | step 4 |
| D-42 | P4 T1-2 | `formatMarketCap` unit-boundary rounding (999.6e6 shows 1000M) | fix now | step 6 |
| D-43 | P4 T1-2 | `formatMoney` shows `-0.00` | fix now | step 6 |
| D-44 | P4 T1-2 | `formatSessionDate` accepts impossible dates | fix now | step 6 |
| D-45 | P4 T1-2 | `MovementCell` re-parses the formatted string | fix now | step 7 |
| D-46 | P4 T1-2 | `StatusBanner` hard-codes "36 hours" | defer | equals the spec 16.5 threshold; make it a setting if the threshold ever changes |
| D-47 | P4 T1-2 | failed banner is amber, not red | defer | owner to confirm spec 14.6 colour rule; listed in `p7-results.md` for the owner |
| D-48 | P4 T1-2 | `role=status` pre-filled | defer | announcement nuance; axe passes |
| D-49 | P4 T1-2 | Skeleton duplicate reduced-motion rule | defer | harmless duplicate |
| D-50 | P4 T1-2 | Retry button lacks a visible focus style | fix now | step 7 |
| D-51 | P4 T1-2 | Popover closes on `mousedown`, not `pointerdown` | fix now | step 7 |
| D-52 | P4 T1-2 | Popover `right-0` can overflow on narrow screens | defer | fixed only if the 360 px overflow or axe check of Task 4 fails |
| D-53 | P4 T1-2 | aria-label differs from visible text | defer | axe passes; WCAG 2.5.3 label-in-name review is manual |
| D-54 | P4 T1-2 | duplicated URL fallback | defer | refactor |
| D-55 | P4 T1-2 | rpc args cast to `never` | defer | type debt until `database.types.ts` is regenerated for the RPCs |
| D-56 | P4 T1-2 | retry predicate for 4xx and `rls_denied` | fix now | step 7 |
| D-57 | P4 T1-2 | stray comment in `.env.example` | fix now | step 8 (the sentence moves to the README script table in Task 5) |
| D-58 | P4 T3 | `viewer.ts` sequence guard | defer | race needs two sign-in changes inside one render; not observed |
| D-59 | P4 T3 | plain `<a>` for sign-in and broker links | fixed already | commit 3de9f30 (router links) |
| D-60 | P4 T3 | disabled Submit Order not focusable | fixed already | P6 Task 5 removes Submit Order (step 1 greps and expects nothing) |
| D-61 | P4 T3 | sticky `thead` ineffective | defer | cosmetic |
| D-62 | P4 T3 | sr-only `dt` duplication | defer | cosmetic |
| D-63 | P4 T3 | `data-testid` heavy tests | defer | test style |
| D-64 | P4 T3 | `Date.now` in `ScanBanner` render | defer | low risk; the banner takes `nowMs` for tests |

Counts: 19 fix now, 11 fixed already, 34 defer (64 items). At planning time the counts were 22, 7 and 35: Task 1 and Task 2 items D-02, D-31, D-34 and D-35 are already on the branch (commits a033335, 19d0295), and the D-29 grep showed that `applyQuoteRows` did not de-duplicate symbols, so D-29 became a fix.

## Verification greps (run on 2026-10-16)

`git grep -n -E 'Math\["random"\]|\["now"\]|new Date\($' -- supabase/functions/_shared/core ':!*.test.ts'` printed nothing (D-03 confirmed).

`git grep -n "apply_quote_rows" -- supabase/functions ':!*.test.ts'` printed the doc comment and the single caller (`worker-tick/lib/quotes.ts:124`, `:125`); that caller takes rows from the sweep, identity and recheck handlers without de-duplicating, so D-29 is a fix now.

`git grep -n -i -E 'submit order|submit-order' -- apps/web/src` printed only tests that assert the label is absent (`no-leaks.test.ts`, `trade-on-ibkr-button.test.tsx`, `todays-discounts.test.tsx`, `trade-control.test.tsx`); no production code (D-60 confirmed).

## Notes on individual fixes

- D-41: an unknown `LLM_PRIMARY` now throws a configuration error. A non-https `LLM_ALT_BASE_URL` already leaves the alternate provider unconfigured (commit 4194cbc, fail-soft by design so one bad variable does not fail every tick); a test pins that behaviour.
- D-08: the dark `destructive` token cannot be both readable text on the dark background (4.5:1) and carry white text; the dark theme now uses `#ef4444` with a dark `destructive-foreground` (`#0c0a09`), light theme unchanged.
- D-11: the lint rule is in `tools/lib/workflow-lint.ts`; `ci.yml` lists `labeled`.
