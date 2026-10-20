# P0 verification results

Written at the end of P0 (spec section 18). Environment: Windows 11, Bun 1.3.14, Node 22.13.1,
Deno 2.9.6 locally and 2.1.x in CI, Supabase CLI 2.121.0, TypeScript 6.0.3, Biome 2.5.15.

Local runtime versions captured on 2026-10-15: `bun --version` 1.3.14, `node --version` v22.13.1,
`deno --version` 2.9.6, `bunx supabase --version` 2.121.0, edge-runtime image
`public.ecr.aws/supabase/edge-runtime:v1.77.4` (from `docker ps` while the stack was up; it
reports "compatible with Deno v2.1.4", matching the 2.1.x used in CI).

| ID | Question | Expected / prepared fallback | Evidence and result |
|---|---|---|---|
| P0-01 | Do Bun 1.3 workspaces and `bun run --filter` work on the Windows dev machine, and does Vitest run under Node? | Expected yes. Fallbacks: `bun --cwd apps/web run <script>` in the root scripts; `node node_modules/vitest/vitest.mjs run --project <name>` for the `test:*` scripts. `linker = "hoisted"` is required because Bun 1.3 defaults to isolated installs. | Observed: yes, no fallback needed. `bun run build` and `bun run test:e2e` use `bun run --filter @screener/web ...` and exit 0. `bun install --frozen-lockfile` reports "Checked 503 installs across 602 packages (no changes)". `vitest run --project core/tools/web` runs under Node 22.13.1 (Vitest v5.0.4). `linker = "hoisted"` is set in `bunfig.toml`. |
| P0-02 | Do import-map prefixes pointing outside the function directory (`@core/`, `@adapters/`) bundle correctly with the Supabase CLI, and does `deno check` enforce `.ts` extensions? (A-21) | Expected yes (the `health` function imports through both prefixes). Fallback: relative imports `../_shared/...` in function code. `.ts` enforcement: `bun run functions:selftest` proves extensionless imports fail `functions:check`. | Observed: yes, no fallback needed. With the local stack up, `bun run supabase:serve` bundled `health` and `curl.exe http://127.0.0.1:54321/functions/v1/health` returned `{"ok":true,"version":"0.0.1","time":"2026-10-15T11:52:25.593Z"}`. `bun run functions:selftest` printed `functions:check self-test: OK (broken adapter, core and function files are all rejected)`. |
| P0-03 | Do `supabase db push` and `supabase functions deploy` work in GitHub Actions? | Unverified until the first manual run of "Deploy Supabase" with real secrets (needs the hosted project, outside this plan). `--skip-vault`, `--yes` and `--dry-run` flags were confirmed with `bunx supabase db push --help` on CLI 2.121.0. | Observed: not run in P0; first run pending operator secrets. |
| P0-04 | Exact TypeScript 6.x version and Biome compatibility; TS 7 deferred. | TypeScript 6.0.3 is the highest 6.x on npm on 2026-10-15 (`npm view typescript versions --json`); npm `latest` is 7.0.2 and is not adopted until Biome, vite-plugin-pwa types and Vitest are verified against it. | Observed: TypeScript is pinned to 6.0.3 (`npm view typescript@6 version` still ends at 6.0.3) and Biome to ^2.5.15 (2.5.15). `bun run typecheck` exits 0 and `bun run lint` (`biome ci .`) reports "No fixes applied". TS 7 remains deferred. |
| T-01 | `bunx` argument passing on Windows (spec 3.2) | `bunx supabase ...`, `bunx playwright install chromium`, `bunx shadcn@4.21.5 add ...` expected to work; fallbacks: `node node_modules/@playwright/test/cli.js install chromium`, `npx shadcn@4.21.5 add ...`. | Observed: `bunx supabase --version`, `bunx supabase start`, `bunx supabase stop --no-backup` and the Playwright e2e run (Chromium) all worked without fallbacks. |
| T-02 | Biome `correctness/useImportExtensions` limited to `supabase/functions/**` | Verified during planning with Biome 2.5.15: overrides and a nested `biome.json` (`extends: "//"`) did not apply the rule; only a global setting does. The `.ts` rule is enforced by `deno check` and `tools/check-core-purity.ts` instead (spec 3.5 allows this). | Observed: as planned. The rule is not used in Biome; enforcement is `deno check` (`bun run functions:check`, proven by `functions:selftest`) and `bun run tools/check-core-purity.ts` (last step of `typecheck`). |
| T-03 | DOM plus WebWorker libs in `apps/web/tsconfig.json` (spec 3.6) | Expected to type-check with `skipLibCheck`. Fallback: `apps/web/tsconfig.sw.json` for `sw.ts` only (Task 4 Step 10). | Observed: `tsc -p apps/web --noEmit` passes; `tsconfig.sw.json` was not needed (only `apps/web/tsconfig.json` exists). The `vite-plugin-pwa` build prints an `inlineDynamicImports option is deprecated, please use codeSplitting: false` warning; it comes from the upstream plugin/bundler and is harmless. |
| T-04 | Location of the pgTAP file for `supabase test db` | Expected `supabase/tests/0001_smoke.test.sql` to be found. Fallback: `supabase/tests/database/`. | Observed: found at `supabase/tests/0001_smoke.test.sql`; `bun run test:db` ended `Files=1, Tests=8` and `Result: PASS`. No fallback needed. |
| T-05 | Hosted-project items (spec P0-05 to P0-07: pg_cron/pg_net versions, platform env variable names, keep-alive user end to end) | Outside this plan: they need the hosted Supabase project. The keep-alive workflow is gated by `KEEPALIVE_ENABLED` and the dedicated user is created per `docs/operator-guide.md` section 12. | Observed: deferred to the operator. |

## Checklist run (2026-10-15, branch `build/initial`)

| Step | Command | Result |
|---|---|---|
| 1 | `bun install --frozen-lockfile` | exit 0, "(no changes)" |
| 2 | `bun run lint` | `No fixes applied.` (after the commit `style(tools): format task 6 tools`) |
| 2 | `bun run lint:workflows` | `workflows: OK (ci.yml, deploy-supabase.yml, deploy-web.yml, keepalive.yml)` |
| 2 | `bun run typecheck` | exit 0, `core purity: OK (2 files scanned, 6 canary globals rejected)` |
| 2 | `bun run test` | core 46 passed (3 files), tools 40, web 79, Deno 13 |
| 3 | `bun run build` | `dist/` contains `sw.js`, `manifest.webmanifest`, `_headers`; `bundle secret scan: OK (10 files)` |
| 3 | `bun run check:bundle` | `bundle secret scan: OK (10 files)` |
| 3 | `bun run check:functions-config` | `functions config: OK (health, retention-cleanup, scan-control, worker-tick)` |
| 3 | `bun run functions:check` | exit 0 |
| 3 | `bun run functions:selftest` | `functions:check self-test: OK (broken adapter, core and function files are all rejected)` |
| 4 | `bun run supabase:start` | stack started |
| 4 | `bun run test:db` | `Files=1, Tests=8`, `Result: PASS` |
| 4 | `supabase:serve` + `curl.exe .../functions/v1/health` | `{"ok":true,"version":"0.0.1","time":"2026-10-15T11:52:25.593Z"}`; stack stopped with `supabase stop --no-backup` |
| 5 | `bun run test:e2e` | `5 passed (21.8s)` in Chromium |
| 6 | the three tracked-secret greps | all print nothing |

Notes:

- Counts differ from the plan's expectation where parallel P1 work has since added files under
  `supabase/functions/_shared/core/`: core runs 46 tests (3 files) instead of 2, and the purity
  scan covers 2 files. These are additions, not regressions.
- During the first run, `functions:check` and one core test file failed transiently because a
  concurrent process created and removed the purity canary file
  (`_shared/core/__purity_canary__.ts`) and was editing core files. Both passed on rerun.

## CI not yet verified

Plan Step 10 (push to GitHub and confirm the CI workflow is green) has NOT been performed: no push
happens without the owner's instruction. No workflow has run yet. The four workflows (`ci.yml`,
`deploy-web.yml`, `deploy-supabase.yml`, `keepalive.yml`) were validated only by the local
`validate-workflows` tool (`bun run lint:workflows`) and by reading.
