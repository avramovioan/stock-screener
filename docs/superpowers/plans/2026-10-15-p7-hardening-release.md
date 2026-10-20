# P7 Security Hardening, Release Readiness and Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the project. Prove the security posture of spec section 15 with executable guards (enforced CSP and minimal headers, a declarative cross-user RLS matrix, an outbound-fetch call-site inventory, a secret-name inventory, redaction per 15.6, rate limits on every public or user-triggered function, the Yahoo kill switch, a dependency audit with a documented exceptions file, a keep-alive that also evaluates freshness alerts), clear the deferred review findings of P0 to P4, consolidate the Playwright flows into one local-stack suite, finish `docs/operator-guide.md` and `README.md`, record real evidence of every suite and the 28 acceptance criteria in `docs/discovery/p7-results.md`, and finish the branch locally (fast-forward into `master`, tag `v0.1.0-local`, no push).

**Architecture:** Every guard is a pure function in `tools/lib/*.ts` with Vitest tests, driven by a thin CLI in `tools/*.ts` that is wired into `package.json`, `ci.yml` and `deploy-web.yml` (same pattern as P0). The CSP lives in `apps/web/public/_headers` as a template with the single token `__SUPABASE_ORIGIN__`; `tools/render-headers.ts` rewrites `dist/_headers` after the build from `VITE_SUPABASE_URL`, `tools/check-headers.ts` verifies the rendered file, and a Playwright spec serves `dist` through `tools/serve-dist.ts` (which applies `_headers`) and fails on any `securitypolicyviolation`. The RLS matrix is one pgTAP file whose plan count is computed from a declarative temp table and which fails when a table, view or public function exists without an entry. Evidence is collected by `tools/verify-all.ts`, which runs every suite and writes `docs/discovery/p7-evidence/*`; `p7-results.md` quotes that evidence and nothing else.

**Tech Stack:** Bun 1.3.14 (scripts, tools), Node 22.13.1 (Vitest, Vite, Playwright), TypeScript 6.0.3, Biome 2.5.15, Vitest 5.0.4, Playwright 1.64.1 with `@axe-core/playwright` (added in P4), Deno (local 2.9.6, CI 2.1.x) for Edge Functions, Supabase CLI 2.121.0 with pgTAP, Cloudflare Workers Static Assets, GitHub Actions. No new runtime dependency is added by this plan.

**Spec:** docs/superpowers/specs/2026-10-15-stock-screener-design.md (sections 15, 16, 17.5 to 17.7, 18 P7, 19)

## Task Dependencies and Concurrency

P7 starts only when P0 to P6 are merged on `build/initial` (the phase plans own their files; this plan edits them only where stated). Paths of P2, P3, P5a, P5b and P6 artifacts below are the ones those plans create; every task starts with a `git ls-files` or `git grep` step that confirms a path before it is edited, and uses the real path if a phase deviated.

| Task | Needs | Runs in parallel with | Owns (no other task edits these) |
|---|---|---|---|
| 1 Security review wave and hardening fixes | P0 to P6 | 2, 3 | `docs/discovery/security-review.md`, `apps/web/public/_headers`, `tools/lib/{headers,fetch-callsites,secret-names,secret-inventory,audit,alerts}.ts`, `tools/{render-headers,check-headers,serve-dist,check-fetch-callsites,check-secret-inventory,audit-deps,keepalive,probe-rate-limit}.ts`, `tools/audit-exceptions.json`, `apps/web/e2e/csp.spec.ts`, `supabase/functions/_shared/adapters/{log,rate-limit,throttle,settings,env,yahoo}.ts`, `quotes/ratelimit.ts`, the `index.ts` of `push-subscribe`, `broker-sync`, `portfolio-refresh`, `scan-control/{validate,actions}.ts`, `worker-tick/providers.ts`, `quotes/provider.ts`, the adapters that read `FLEX_BASE_URL` and `RESEND_API_URL`, `MarkdownBody.tsx`, migration `20261015007100_providers_setting.sql` and `supabase/tests/0910_providers_setting.test.sql`, `.github/workflows/keepalive.yml`, the added steps of `ci.yml` |
| 2 Cross-user RLS matrix | P1 to P6 migrations | 1, 3 | `supabase/tests/0900_rls_matrix.test.sql`, migration `20261015007000_p7_function_grants.sql` |
| 3 Deferred-minor triage and fixes | P0 to P6 | 1, 2 | `tools/lib/dup-deps*`, `http.ts`, `fetchers/{direct,jina}.ts`, `llm/index.ts`, `format.ts`, `movement-cell.tsx`, `popover.tsx`, `data-state.tsx`, `query-client.ts`, `tokens.contrast.test.ts`, `thresholds.ts`, `biome.json`, `apps/web/.env.example`, the `pull_request` block of `ci.yml`, `workflow-lint.ts` |
| 4 End-to-end suite | 1 (headers), 3 (UI fixes), P3, P5a, P5b, P6 features | 5 | `apps/web/e2e/local/**`, `apps/web/playwright.local.config.ts`, `tools/e2e-setup.ts`, `tools/lib/e2e-env*` |
| 5 Operator guide and README | 1 (names, headers), P2 to P6 guide fills | 4 | `docs/operator-guide.md`, `README.md`, `tools/gen-secret.ts`, `tools/lib/guide-check*`, `tools/check-operator-guide.ts` |
| 6 Verification record and release | 1 to 5 | none | `docs/discovery/p7-results.md`, `docs/discovery/parity-results.md`, `docs/discovery/p7-evidence/**`, `tools/{verify-all,parity-print,release-check}.ts`, `tools/lib/{verify-all,parity,release-check}*` |
| 7 Phase exit checklist | 6 | none | none (verification only) |

Tasks 1, 2 and 3 share two files and edit them in different regions: root `package.json` (Task 1 adds scripts, Task 3 aligns devDependencies) and `.github/workflows/ci.yml` (Task 3 edits the `pull_request` block, Task 1 adds steps to the `web` job). When tasks run at once, each re-reads the file immediately before editing and edits only its region. Task 4 and Task 5 never edit the same file; both add scripts to the root `package.json`, so they follow the same rule.

## Global Constraints

- **No secret in the bundle or in logs.** `bun run check:bundle` scans `apps/web/dist` after every build with the names from `tools/lib/secret-names.ts` (one list for the bundle scan and the inventory check); `redact()` removes keys matching `/token|secret|key|authorization|password|cookie|crumb|email|endpoint|p256dh|auth/i` and masks e-mail-shaped and long base64-shaped values; nothing sensitive reaches `console`.
- **RLS on every table and an entry for every table.** `supabase/tests/0900_rls_matrix.test.sql` fails when a public table, view or public function exists without a matrix entry, when RLS is off, when a privilege differs from the matrix, or when one user can read, insert as, update or delete another user's row. Spec 6.9 is the reference; every deviation is a comment `-- deviation: <plan id>` next to the matrix row and a line in `security-review.md`.
- **CSP enforced, not report-only.** Header `Content-Security-Policy` (never `-Report-Only`) with exactly: `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' <Supabase origin>; worker-src 'self'; manifest-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'`. No inline script, no `unsafe-eval`, no wildcard and no scheme-only source in `connect-src`. `style-src 'unsafe-inline'` stays (Radix, Sonner and chart libraries write style attributes; a static host cannot issue nonces) and is a documented residual risk.
- **Other headers.** `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Cross-Origin-Opener-Policy: same-origin-allow-popups`, and a `Permissions-Policy` that denies `accelerometer, autoplay, bluetooth, camera, display-capture, geolocation, gyroscope, hid, magnetometer, microphone, midi, payment, serial, usb, xr-spatial-tracking` and allows only `clipboard-write=(self)`. `Strict-Transport-Security` is managed by Cloudflare (dashboard, SSL/TLS, Edge Certificates, HSTS); if it ever appears in `_headers` it must carry `max-age` of at least 15552000.
- **Service worker never caches authenticated or Supabase responses** (`isNeverCached`, `NetworkOnly`; verified by `sw-routes.test.ts` and by the security review greps, not changed here).
- **Open-redirect protection** only through `safeNext` (P5a `features/auth/redirects.ts`); the review greps for any other use of a `next`, `redirect` or `returnTo` parameter.
- **Rate limits, exact values:** `quotes` 60 requests per minute per hashed IP (A-26, existing); `push-subscribe` 20 per minute per hashed IP in front of its 10-subscriptions-per-user cap; `broker-sync` 20 per minute per hashed IP in front of its 10-minute manual cooldown and the Flex limiter (1.1 s spacing, 10 per 60 s); `portfolio-refresh` 60 per minute per hashed IP in front of its 60 s manual cooldown. All four answer 429 with `Retry-After`. The client IP is `cf-connecting-ip`, else the right-most `x-forwarded-for` entry; a spoofed left-most entry must not bypass a limit (`tools/probe-rate-limit.ts`).
- **SSRF guard on every outbound fetch of a user- or model-influenced URL.** `tools/check-fetch-callsites.ts` lists every `fetch(` or `fetchImpl(` call site outside tests and fails when a file is not in the policy table (`fixed-host`, `ssrf-guarded`, `endpoint-allow-listed`, `operator-configured`). Operator-configured base URLs (`LLM_ALT_BASE_URL`, `FLEX_BASE_URL`, `RESEND_API_URL`) must be `https` unless `SUPABASE_URL` is local.
- **Yahoo kill switch exists in code** (`app_settings.providers.yahoo_enabled`, spec 15.5): when false, every Yahoo request is refused with `YahooUnavailableError` (jobs reschedule without consuming attempts, `quotes` answers from its cache or with 502, exactly as for an open breaker) and the site keeps serving the last published data.
- **Dependency audit** (`bun run audit`) is clean of known critical and high advisories for production dependencies of the web app and for the `npm:` specifiers of the Edge Functions, or each remaining advisory is an entry in `tools/audit-exceptions.json` with a reason and an expiry date.
- **All suites green before the release commit:** `lint`, `typecheck`, `test:core`, `test:tools`, `test:web`, `functions:check`, `functions:test`, `test:db`, `test:integration`, `build`, `test:e2e:local`, plus `lint:workflows`, `check:functions-config`, `functions:selftest`, `check:bundle`, `check:headers`, `check:fetch`, `check:secrets`, `check:guide`, `audit`, `test:e2e`.
- **No push to GitHub** and no hosted-project command without the owner's instruction. The branch finish is local: fast-forward `master`, tag `v0.1.0-local`.
- **Windows 11 first.** Commands are PowerShell or Git Bash safe, use `bun run`, `bunx` and `node`; no bash-only syntax in `package.json`; tools spawn `bunx` with `shell: true` only.
- **Evidence rule.** A verdict of "met" in `p7-results.md` is allowed only when the cited evidence file in `docs/discovery/p7-evidence/` shows the test passing; otherwise the verdict is "not demonstrated" with the reason.

## Plan decisions (recorded in `security-review.md`, section "Decisions")

| ID | Decision | Why |
|---|---|---|
| P7-D1 | `_headers` is a template; `tools/render-headers.ts` substitutes `__SUPABASE_ORIGIN__` in `dist/_headers`. Local builds without `VITE_SUPABASE_URL` render the placeholder origin `https://unset.invalid` and print a warning; `deploy-web.yml` runs `check:headers -- --expect-origin "$VITE_SUPABASE_URL"`. | The project ref is not known in the repository; a wildcard `*.supabase.co` would let a script exfiltrate to any Supabase project. |
| P7-D2 | The RLS matrix seeds rows generically from `pg_attribute` with `session_replication_role = replica` (no FK checks, no triggers) and per-table `seed_override` JSON. A table whose seed cannot be satisfied may carry a skip reason; at most 5 skips are allowed. | One mechanism covers tables added later without hand-written inserts. |
| P7-D3 | Rate limiting is applied in `index.ts` before the handler, by hashed IP, with the existing atomic counter `public.quotes_rl_incr`. | No handler signature changes; the per-user cooldowns of P5b stay in the handlers. |
| P7-D4 | The kill switch lives in `createThrottle` (`isEnabled` option) because every Yahoo request, including the crumb and cookie requests, already passes it. | One cut point for the worker and for `quotes`; reuses the reschedule path of the breaker. |
| P7-D5 | One Playwright config for local-stack tests, `apps/web/playwright.local.config.ts`, on the Vite dev server (port 5173, the only origin on the local auth allow-list). The production-build variant of P4 Task 7 is retired. | P4 and P5a defined two different `test:e2e:local` scripts; the dev-server one is the only one that can sign in. |
| P7-D6 | The environment variable `UNSUBSCRIBE_SECRET` (P3) is the real name; spec 15.4 calls it `UNSUBSCRIBE_SIGNING_KEY`. Task 6 corrects the spec line. `EMAIL_FROM` replaces the spec's `RESEND_FROM` the same way. | Names in code win; the inventory check enforces one list. |
| P7-D7 | Hosted-only exit items of spec P7 (a full unattended production day, the keep-alive failure drill on GitHub, the `supabase secrets list` comparison) are written as drills in the operator guide section "Production cut-over and drills" and recorded in `p7-results.md` as "owner-run, not executed locally". | They need the hosted project and the owner's accounts. |
| P7-D8 | Spec 16.4 and 16.5 (keep-alive freshness check and alert conditions) were not built by P0 to P6 (`keepalive.yml` only reads one row). Task 1 adds `tools/keepalive.ts` with the conditions that the public `scan_status` and `health` data can evaluate; conditions needing fields that `health` does not expose are listed in the operator guide as manual checks. | Closes the P7 exit item "keep-alive and freshness alerts proven by a deliberate failure" as far as it can be proven locally. |

## Review Focus

Five release risks follow from the spec; each is pinned by a check in the owning task so that a regression after this plan fails a command, not a reviewer.

1. **The enforced CSP breaks the app or quietly stays weak (Task 1).** A policy that parses but blocks the chart, the service worker or the Supabase calls; a wildcard `connect-src`; `-Report-Only` left in place; the template token shipped unrendered. Pinned by `tools/lib/headers.ts` (parse and rule tests, including the committed `_headers`), `check:headers` after every build, and `apps/web/e2e/csp.spec.ts`, which serves the real `dist` with its real headers and asserts zero violations on every public route and that an injected inline script is blocked.
2. **A table, view or function ships without access review (Task 2).** A new migration adds a table without RLS or a public function that `anon` can execute (the existing `public.is_admin()` is one: `revoke ... from public` leaves the Supabase default grant to `anon`). Pinned by `0900_rls_matrix.test.sql`, which enumerates `pg_tables`, `pg_views` and `pg_proc` and compares them with the declarative matrix in both directions, and by the cross-user probes.
3. **A model- or user-influenced URL is fetched without a guard (Task 1).** A new adapter calls `fetch` with a URL from search results, a document, a push subscription or an env base URL. Pinned by `check:fetch` (every call-site file must be in the policy table; `ssrf-guarded` files must import the guard; operator-configured URLs must pass `requireHttpsBase`) with unit tests of the scanner.
4. **Secret or personal data reaches a log or the bundle because two name lists drift (Task 1).** The bundle scan still listed `UNSUBSCRIBE_SIGNING_KEY` while the code reads `UNSUBSCRIBE_SECRET`; `redact()` was narrower than spec 15.6. Pinned by `tools/lib/secret-names.ts` (single list), `check:secrets` (every secret-looking name read by code must be in the list and in the operator guide, no `VITE_` secret, `.env.example` holds no real value) and the extended `log.test.ts` with seeded secrets.
5. **A release claim without evidence (Task 6).** "All green" written from memory, a verdict of "met" without a passing test, a dirty tree, a tracked `.env`, an accidental push. Pinned by `tools/verify-all.ts` (runs every suite, stores output and a summary JSON), `tools/release-check.ts` (clean tree, branch, no tracked secret files, no unresolved marker in `p7-results.md`, fast-forward possible, tag absent) and the evidence rule above.

---

## Task 1: Security review wave and hardening fixes

**Concurrency:** parallel with Tasks 2 and 3. Inside the task, the parts are file-disjoint and may be split between workers: part A (steps 1 to 2), part B (steps 3 to 8, headers), part C (steps 9 to 13, logging, secrets, markdown), part D (steps 14 to 19, outbound calls, rate limits, kill switch), part E (steps 20 to 21, dependency audit), part F (steps 22 to 24, keep-alive), part G (step 25, final review document, after Task 2 has merged).

**Files:**
- Create: `docs/discovery/security-review.md`
- Create: `tools/lib/headers.ts`, `tools/lib/headers.test.ts`, `tools/render-headers.ts`, `tools/check-headers.ts`, `tools/serve-dist.ts`, `apps/web/e2e/csp.spec.ts`
- Create: `tools/lib/secret-names.ts`, `tools/lib/secret-names.test.ts`, `tools/lib/secret-inventory.ts`, `tools/lib/secret-inventory.test.ts`, `tools/check-secret-inventory.ts`
- Create: `tools/lib/fetch-callsites.ts`, `tools/lib/fetch-callsites.test.ts`, `tools/check-fetch-callsites.ts`
- Create: `supabase/functions/_shared/adapters/rate-limit.ts`, `rate-limit.test.ts`, `tools/probe-rate-limit.ts`
- Create: `supabase/migrations/20261015007100_providers_setting.sql`, `supabase/tests/0910_providers_setting.test.sql`
- Create: `tools/lib/audit.ts`, `tools/lib/audit.test.ts`, `tools/audit-deps.ts`, `tools/audit-exceptions.json`
- Create: `tools/lib/alerts.ts`, `tools/lib/alerts.test.ts`, `tools/keepalive.ts`
- Create: `apps/web/src/features/research/markdown-security.test.tsx`
- Modify: `apps/web/public/_headers`, `apps/web/playwright.config.ts` (second web server), `package.json` (scripts), `tools/lib/secret-scan.ts`, `supabase/functions/_shared/adapters/{log.ts,log.test.ts,env.ts,env.test.ts,throttle.ts,throttle.test.ts,settings.ts,settings.test.ts,yahoo.ts}`, `supabase/functions/quotes/{ratelimit.ts,provider.ts}`, `supabase/functions/worker-tick/providers.ts`, `supabase/functions/scan-control/{validate.ts,validate.test.ts,actions.ts}`, the `index.ts` of `push-subscribe`, `broker-sync`, `portfolio-refresh`, the adapters that read `FLEX_BASE_URL` and `RESEND_API_URL`, `apps/web/src/features/research/{MarkdownBody.tsx,ReportView.tsx}`, `.github/workflows/{ci.yml,deploy-web.yml,keepalive.yml}`

**Interfaces:**
- Consumes: P0 `tools/lib/secret-scan.ts`, `tools/check-bundle-secrets.ts`, `apps/web/src/sw-routes.ts`; P1 `quotes_rl_incr`, `createThrottle`, `scan-control`; P2 `MarkdownBody`; P3 `isAllowedPushEndpoint` in `adapters/push.ts`; P5a `safeNext`; P5b and P3 function `index.ts` files; P4 `apps/web/e2e/support/stub-api.ts`.
- Produces: `parseHeadersFile`, `parseCsp`, `renderHeaders`, `matchHeaders`, `headerProblems`, `originOf`, `ORIGIN_TOKEN`; `SERVER_SECRET_NAMES`, `inventoryProblems`; `findFetchCalls`, `fetchPolicyProblems`, `FETCH_POLICY`; `withIpRateLimit`, `rpcIncr`, `clientIp`, `requireHttpsBase`; `createYahooEnabledCheck`, `parseProviderSettings`; `parseBunAudit`, `parseNpmAudit`, `auditProblems`, `specifiersFromSource`; `evaluateAlerts`; root scripts `render:headers`, `check:headers`, `check:fetch`, `check:secrets`, `audit`, `keepalive`, `probe:ratelimit`; setting `app_settings.providers`.

### Part A: evidence and the review document

- [ ] **Step 1: Confirm the paths this task edits and capture the baseline evidence**

Run (PowerShell, repository root). Every command is read-only.

```powershell
git ls-files apps/web/src/features/auth/redirects.ts apps/web/src/features/research/MarkdownBody.tsx apps/web/src/features/research/ReportView.tsx supabase/functions/push-subscribe/index.ts supabase/functions/broker-sync/index.ts supabase/functions/portfolio-refresh/index.ts supabase/functions/_shared/adapters/push.ts supabase/functions/_shared/adapters/email.ts supabase/functions/_shared/adapters/flex.ts supabase/functions/scan-control/validate.ts
git grep -n -E 'getClaims|getUser\(' -- supabase/functions ':!*.test.ts'
git grep -n -E 'dangerouslySetInnerHTML|innerHTML|insertAdjacentHTML|document\.write|eval\(|new Function' -- apps/web/src ':!*.test.*'
git grep -n -E 'console\.(log|error|warn|info|debug)' -- supabase/functions ':!*.test.ts'
git grep -n -E 'document\.cookie|credentials: ?"include"|Set-Cookie' -- apps supabase/functions
git grep -n -E 'access-control-allow-origin.*\*' -- supabase/functions ':!*.test.ts'
git grep -n -E 'searchParams\.get\("(next|redirect|returnTo)"\)|[?&](next|redirect|returnTo)=' -- apps/web/src ':!*.test.*'
git grep -n 'yahoo_enabled' -- supabase apps tools
git grep -n -E 'FLEX_BASE_URL|RESEND_API_URL|LLM_ALT_BASE_URL' -- supabase/functions ':!*.test.ts'
```

Expected and what each result means:
- first command prints every path (a missing path means the phase used another name: use the real one in the later steps and in the review document);
- `getClaims` appears in every user-facing function (`push-subscribe`, `broker-sync`, `portfolio-refresh`, `scan-control`) and nowhere is a client-supplied user id trusted;
- the XSS grep prints nothing (a hit is a finding);
- the console grep prints nothing (every log goes through `scanEvent` and `redact`);
- the cookie grep prints nothing (no cookie auth, so no CSRF surface, spec T9);
- the CORS grep prints nothing (`corsHeaders` echoes only the `SITE_URL` origin);
- the redirect grep prints only `features/auth/redirects.ts` consumers (any other hit must route through `safeNext`);
- `yahoo_enabled` prints nothing on 2026-10-15: the kill switch of spec 15.5 is not implemented yet (finding S-10, fixed in steps 18 and 19);
- the base-URL grep lists the three operator-configured URLs that step 14 validates.

Keep the raw output: it goes into `security-review.md` in step 2.

- [ ] **Step 2: Create `docs/discovery/security-review.md`**

Write the file with the structure below. The findings table is the planning-time review (every row was derived by reading the code on 2026-10-15); after each later step, replace its `Status` cell with `fixed in <commit>` and, when a command's output contradicts a row, correct the row or add one. Paste the raw output of step 1 and of the commands named in each later step under the matching section heading.

````markdown
# Security review (P7)

Date: 2026-10-15. Scope: spec section 15 (T1 to T23), the repository at `build/initial`, local stack only
(no hosted project was touched). Severity: High (exploitable now or breaks a spec guarantee), Medium (needs a
second weakness or a misuse), Low, Info. Status: fixed (commit), deferred (reason), accepted (owner-visible risk).

## Findings

| ID | Sev | Area | Finding | Fix or decision | Status |
|---|---|---|---|---|---|
| S-01 | High | CSP | Policy shipped as `Content-Security-Policy-Report-Only` with `connect-src https://*.supabase.co` (any Supabase project). | Enforced header, `connect-src 'self' <project origin>` rendered at build time, `check:headers`, CSP e2e (steps 3 to 8). | open |
| S-02 | Medium | Headers | `Permissions-Policy` denies camera, microphone and geolocation only. | Deny list of 15 features, `clipboard-write=(self)` only (step 4). | open |
| S-03 | Info | Headers | HSTS is not set in `_headers`. | Managed by Cloudflare; operator guide section 6 and the cut-over section tell how to enable it. | accepted |
| S-04 | Medium | Logging | `REDACT_KEY` lacks `password`, `endpoint`, `p256dh`, `auth` of spec 15.6 and `redactString` does not mask e-mail or long base64 values. | Extend key list and value masks, test with seeded secrets (step 9). Residual of ledger item D-27. | open |
| S-05 | Medium | Secrets | Bundle scan name list (`tools/lib/secret-scan.ts`) drifted from the code: it lists `UNSUBSCRIBE_SIGNING_KEY` but code reads `UNSUBSCRIBE_SECRET`, and lacks `RATE_LIMIT_SALT`. Ledger item D-02. | One list in `secret-names.ts`, `check:secrets` (steps 10 and 11). | open |
| S-06 | Medium | XSS | `MarkdownBody` links any `http(s)` URL found in model text and `rehype-sanitize` still allows `img`; spec T13 requires links from the evidence ledger only. Ledger items D-34 and D-35. | `skipHtml`, blocked elements, links only for `allowedUrls`, tests with hostile Markdown (step 12). | open |
| S-07 | Medium | RLS | `public.is_admin()` is executable by `anon` (`revoke from public` does not remove the Supabase default grant). Ledger item D-31. | Task 2 migration `20261015007000_p7_function_grants.sql` and the function matrix in `0900_rls_matrix.test.sql`. | open |
| S-08 | Medium | Rate limit | `quotes` takes the left-most `x-forwarded-for` entry as the client IP: a client can rotate it and bypass 60 per minute. | `cf-connecting-ip`, else right-most entry (step 17); `probe:ratelimit`. | open |
| S-09 | Medium | Rate limit | `push-subscribe`, `broker-sync` and `portfolio-refresh` have per-user caps or cooldowns but no per-IP request limit. | `withIpRateLimit` in each `index.ts` (steps 16 and 17). | open |
| S-10 | High | Spec 15.5 | The Yahoo kill switch (`app_settings.providers.yahoo_enabled`) is not implemented. | Setting, validation, `createThrottle` guard, wiring (steps 18 and 19). | open |
| S-11 | Low | SSRF | Operator-configured base URLs (`LLM_ALT_BASE_URL`, `FLEX_BASE_URL`, `RESEND_API_URL`) are not validated. | `requireHttpsBase` (step 14). | open |
| S-12 | Low | Ops | `keepalive.yml` performs one read; spec 16.4 freshness and 16.5 alert conditions were never built. | `tools/keepalive.ts` and `tools/lib/alerts.ts` (steps 22 to 24). | open |
| S-13 | Low | CSP | `style-src 'unsafe-inline'` remains. | Accepted: Radix, Sonner and the chart library write style attributes; scripts stay strict. | accepted |
| S-14 | Low | Session | supabase-js keeps the session in `localStorage` (T8). | Accepted: XSS is the only reader; mitigated by S-01 and S-06. | accepted |
| S-15 | Info | Logging | Flex request URLs carry the token (`t=`). | Verified in step 1 (`console` grep) and by `redactString` (URL credential mask); the `flex.ts` adapter never logs URLs. | accepted |
| S-16 | Info | SSRF | `fetchDocument` DNS check is best effort (`dnsCheck: "skipped"` when no resolver); DNS rebinding between check and fetch is not closed. | Accepted and documented; mitigations: https/http only, public host names, redirects re-validated, 2 MB cap, no secrets in requests. | accepted |
| S-17 | Info | RLS | `ai_quota_usage` has no admin read policy (spec 6.9 marks the admin page optional). | Deviation recorded in the matrix; quota is read through SQL by the operator. | accepted |
| S-18 | Info | RLS | `ibkr_catalogue` and `eur_equivalents` are readable by `anon` (P6 deviation from spec 6.9: public contract data, no personal data). | Deviation recorded in the matrix. | accepted |
| S-19 | Info | Supply chain | Production dependency advisories. | Step 21 output and `tools/audit-exceptions.json`. | open |

## Decisions

(Copy the table "Plan decisions" of `docs/superpowers/plans/2026-10-15-p7-hardening-release.md`, rows P7-D1 to P7-D8.)

## Evidence by area

For each heading, paste the command and its output (trimmed to the relevant lines).

### 1. Authentication and session
### 2. RLS matrix (output of `supabase test db` for `0900_rls_matrix.test.sql`, and the query in step 25)
### 3. Secrets inventory (`bun run check:secrets`; owner-run: `bunx supabase secrets list --project-ref <ref>` compared by name)
### 4. Logging and redaction
### 5. XSS surfaces
### 6. CSP and headers (`bun run check:headers`, the CSP e2e)
### 7. Service worker caching (`apps/web/src/sw-routes.test.ts` result)
### 8. Outbound requests and SSRF (`bun run check:fetch`)
### 9. Open redirects
### 10. Rate limits (`bun run probe:ratelimit` output)
### 11. CSRF posture
### 12. Dependency audit (`bun run audit`) and Deno dependencies
````

Replace the line "(Copy the table ...)" with the actual copied table when writing the file. Commit:

```text
git add docs/discovery/security-review.md
git commit -m "docs(security): add the P7 security review with the planning-time findings"
```

### Part B: enforced CSP and minimal headers

- [ ] **Step 3: Write the failing header tests (TDD)**

`tools/lib/headers.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  headerProblems,
  matchHeaders,
  ORIGIN_TOKEN,
  originOf,
  parseCsp,
  parseHeadersFile,
  renderHeaders,
} from "./headers.ts";

const ORIGIN = "https://abcdefghijklmnopqrst.supabase.co";
const committed = readFileSync(
  fileURLToPath(new URL("../../apps/web/public/_headers", import.meta.url)),
  "utf8",
);

const csp = (connect: string) =>
  `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src ${connect}; worker-src 'self'; manifest-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'`;

const PERMISSIONS =
  "accelerometer=(), autoplay=(), bluetooth=(), camera=(), clipboard-write=(self), display-capture=(), geolocation=(), gyroscope=(), hid=(), magnetometer=(), microphone=(), midi=(), payment=(), serial=(), usb=(), xr-spatial-tracking=()";

function file(over: Record<string, string | null> = {}): string {
  const base: Record<string, string> = {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": PERMISSIONS,
    "Cross-Origin-Opener-Policy": "same-origin-allow-popups",
    "X-Frame-Options": "DENY",
    "Content-Security-Policy": csp(`'self' ${ORIGIN}`),
  };
  const lines = ["/*"];
  for (const [name, value] of Object.entries({ ...base, ...over })) {
    if (value !== null) lines.push(`  ${name}: ${value}`);
  }
  lines.push(
    "/assets/*",
    "  Cache-Control: public, max-age=31536000, immutable",
    "/sw.js",
    "  Cache-Control: no-cache",
    "/index.html",
    "  Cache-Control: no-cache",
  );
  return lines.join("\n");
}

const rendered = { mode: "rendered", expectedOrigin: ORIGIN } as const;
const problems = (text: string, mode: Parameters<typeof headerProblems>[1] = rendered) =>
  headerProblems(parseHeadersFile(text), mode);

describe("parseHeadersFile and parseCsp", () => {
  it("groups headers per path rule, lower-cases names and joins repeats", () => {
    const rules = parseHeadersFile("# c\n/*\n  A: 1\n  a: 2\n/x\n  B: 3\n");
    expect(rules.get("/*")?.get("a")).toBe("1, 2");
    expect(rules.get("/x")?.get("b")).toBe("3");
  });
  it("splits a policy into directives", () => {
    expect(parseCsp("default-src 'self'; connect-src 'self' https://a.b").get("connect-src")).toEqual([
      "'self'",
      "https://a.b",
    ]);
  });
});

describe("headerProblems (rendered)", () => {
  it("accepts the reference configuration", () => {
    expect(problems(file())).toEqual([]);
  });
  it("rejects a report-only policy and a missing enforced policy", () => {
    expect(problems(file({ "Content-Security-Policy": null, "Content-Security-Policy-Report-Only": csp(`'self' ${ORIGIN}`) })).join("\n")).toMatch(/Content-Security-Policy is missing|report-only/i);
  });
  it.each([
    ["wildcard connect-src", csp("'self' https://*.supabase.co")],
    ["star connect-src", csp("'self' *")],
    ["scheme-only connect-src", csp("'self' https:")],
    ["extra connect-src origin", csp(`'self' ${ORIGIN} https://evil.example`)],
    ["other project origin", csp("'self' https://zzzzzzzzzzzzzzzzzzzz.supabase.co")],
    ["unsafe-inline script", csp(`'self' ${ORIGIN}`).replace("script-src 'self'", "script-src 'self' 'unsafe-inline'")],
    ["unsafe-eval script", csp(`'self' ${ORIGIN}`).replace("script-src 'self'", "script-src 'self' 'unsafe-eval'")],
    ["framing allowed", csp(`'self' ${ORIGIN}`).replace("frame-ancestors 'none'", "frame-ancestors 'self'")],
    ["no object-src", csp(`'self' ${ORIGIN}`).replace("object-src 'none'; ", "")],
    ["remote images", csp(`'self' ${ORIGIN}`).replace("img-src 'self' data:", "img-src 'self' data: https:")],
  ])("rejects %s", (_name, value) => {
    expect(problems(file({ "Content-Security-Policy": value })).length).toBeGreaterThan(0);
  });
  it("rejects an unrendered template token and accepts it in template mode", () => {
    const template = file({ "Content-Security-Policy": csp(`'self' ${ORIGIN_TOKEN}`) });
    expect(problems(template).join("\n")).toContain(ORIGIN_TOKEN);
    expect(problems(template, { mode: "template" })).toEqual([]);
  });
  it("checks the other headers", () => {
    expect(problems(file({ "X-Frame-Options": "SAMEORIGIN" })).length).toBeGreaterThan(0);
    expect(problems(file({ "X-Content-Type-Options": null })).length).toBeGreaterThan(0);
    expect(problems(file({ "Cross-Origin-Opener-Policy": "unsafe-none" })).length).toBeGreaterThan(0);
    expect(problems(file({ "Referrer-Policy": "unsafe-url" })).length).toBeGreaterThan(0);
  });
  it("requires every listed feature denied and nothing else allowed", () => {
    expect(problems(file({ "Permissions-Policy": PERMISSIONS.replace("camera=()", "camera=*") })).join("\n")).toMatch(/camera/);
    expect(problems(file({ "Permissions-Policy": PERMISSIONS.replace("camera=(), ", "") })).join("\n")).toMatch(/camera/);
    expect(problems(file({ "Permissions-Policy": `${PERMISSIONS}, fullscreen=(self)` })).join("\n")).toMatch(/fullscreen/);
  });
  it("accepts Strict-Transport-Security only with a long max-age", () => {
    expect(problems(file({ "Strict-Transport-Security": "max-age=31536000; includeSubDomains" }))).toEqual([]);
    expect(problems(file({ "Strict-Transport-Security": "max-age=60" })).length).toBeGreaterThan(0);
  });
  it("requires no-cache for the entry points and immutable assets", () => {
    expect(problems(file().replace("  Cache-Control: no-cache\n/index.html", "  Cache-Control: max-age=60\n/index.html")).length).toBeGreaterThan(0);
  });
});

describe("renderHeaders, originOf and matchHeaders", () => {
  it("reduces a URL to its https origin and refuses other schemes", () => {
    expect(originOf("https://abc.supabase.co/rest/v1/")).toBe("https://abc.supabase.co");
    expect(originOf("http://abc.supabase.co")).toBeNull();
    expect(originOf("not a url")).toBeNull();
  });
  it("substitutes every token and flags a placeholder render", () => {
    const out = renderHeaders(`a ${ORIGIN_TOKEN} b ${ORIGIN_TOKEN}`, `${ORIGIN}/`);
    expect(out).toEqual({ text: `a ${ORIGIN} b ${ORIGIN}`, origin: ORIGIN, placeholder: false });
    const fallback = renderHeaders(ORIGIN_TOKEN, undefined);
    expect(fallback.placeholder).toBe(true);
    expect(fallback.origin).toBe("https://unset.invalid");
    expect(() => renderHeaders("no token", ORIGIN)).toThrow(/token/);
  });
  it("applies every matching rule, in file order", () => {
    const rules = parseHeadersFile(file());
    expect(matchHeaders(rules, "/assets/a.js")["cache-control"]).toContain("immutable");
    expect(matchHeaders(rules, "/assets/a.js")["x-frame-options"]).toBe("DENY");
    expect(matchHeaders(rules, "/sw.js")["cache-control"]).toBe("no-cache");
    expect(matchHeaders(rules, "/about")["cache-control"]).toBeUndefined();
  });
});

describe("the committed apps/web/public/_headers", () => {
  it("passes template mode and renders into a file that passes rendered mode", () => {
    expect(headerProblems(parseHeadersFile(committed), { mode: "template" })).toEqual([]);
    const { text } = renderHeaders(committed, ORIGIN);
    expect(headerProblems(parseHeadersFile(text), rendered)).toEqual([]);
  });
});
```

Run: `bun run test:tools headers`
Expected: FAIL, module `./headers.ts` not found.

- [ ] **Step 4: Implement `tools/lib/headers.ts` and write the final `_headers`**

`tools/lib/headers.ts`:

```ts
export const ORIGIN_TOKEN = "__SUPABASE_ORIGIN__";
export const PLACEHOLDER_ORIGIN = "https://unset.invalid";

export type HeaderRules = Map<string, Map<string, string>>;
export type HeaderMode = { mode: "template" } | { mode: "rendered"; expectedOrigin?: string };

/** Cloudflare `_headers` syntax: an unindented path rule followed by indented `Name: value` lines. */
export function parseHeadersFile(text: string): HeaderRules {
  const rules: HeaderRules = new Map();
  let current: Map<string, string> | null = null;
  for (const raw of text.split(/\r?\n/)) {
    if (raw.trim() === "" || raw.trimStart().startsWith("#")) continue;
    if (!/^\s/.test(raw)) {
      const key = raw.trim();
      current = rules.get(key) ?? new Map<string, string>();
      rules.set(key, current);
      continue;
    }
    if (current === null) throw new Error(`header line before any path rule: ${raw.trim()}`);
    const colon = raw.indexOf(":");
    if (colon < 0) throw new Error(`header line without a colon: ${raw.trim()}`);
    const name = raw.slice(0, colon).trim().toLowerCase();
    const value = raw.slice(colon + 1).trim();
    current.set(name, current.has(name) ? `${current.get(name)}, ${value}` : value);
  }
  return rules;
}

export function parseCsp(value: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const part of value.split(";")) {
    const tokens = part.trim().split(/\s+/).filter(Boolean);
    const [name, ...sources] = tokens;
    if (name !== undefined) out.set(name.toLowerCase(), sources);
  }
  return out;
}

export function originOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" ? parsed.origin : null;
  } catch {
    return null;
  }
}

export function renderHeaders(
  template: string,
  supabaseUrl: string | undefined,
): { text: string; origin: string; placeholder: boolean } {
  if (!template.includes(ORIGIN_TOKEN)) throw new Error(`template does not contain ${ORIGIN_TOKEN}`);
  const origin = supabaseUrl === undefined ? null : originOf(supabaseUrl);
  const chosen = origin ?? PLACEHOLDER_ORIGIN;
  return { text: template.split(ORIGIN_TOKEN).join(chosen), origin: chosen, placeholder: origin === null };
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

/** Headers that apply to a path: every matching rule, in file order; equal names are joined with ", ". */
export function matchHeaders(rules: HeaderRules, pathname: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [pattern, headers] of rules) {
    if (!globToRegExp(pattern).test(pathname)) continue;
    for (const [name, value] of headers) out[name] = name in out ? `${out[name]}, ${value}` : value;
  }
  return out;
}

const EXACT: Record<string, string[]> = {
  "default-src": ["'self'"],
  "script-src": ["'self'"],
  "worker-src": ["'self'"],
  "manifest-src": ["'self'"],
  "object-src": ["'none'"],
  "frame-ancestors": ["'none'"],
  "base-uri": ["'self'"],
  "form-action": ["'self'"],
};
const SUBSET: Record<string, string[]> = {
  "style-src": ["'self'", "'unsafe-inline'"],
  "img-src": ["'self'", "data:"],
  "font-src": ["'self'"],
};

export function cspProblems(value: string, mode: HeaderMode): string[] {
  const problems: string[] = [];
  const csp = parseCsp(value);
  for (const [name, expected] of Object.entries(EXACT)) {
    const actual = csp.get(name);
    if (actual === undefined) problems.push(`CSP: ${name} is missing`);
    else if (actual.join(" ") !== expected.join(" ")) problems.push(`CSP: ${name} must be exactly ${expected.join(" ")} (found ${actual.join(" ")})`);
  }
  for (const [name, allowed] of Object.entries(SUBSET)) {
    const actual = csp.get(name);
    if (actual === undefined) problems.push(`CSP: ${name} is missing`);
    else for (const source of actual) if (!allowed.includes(source)) problems.push(`CSP: ${name} must not contain ${source}`);
  }
  const connect = csp.get("connect-src");
  if (connect === undefined) problems.push("CSP: connect-src is missing");
  else {
    const [self, origin, ...rest] = connect;
    if (self !== "'self'") problems.push("CSP: connect-src must start with 'self'");
    if (rest.length > 0 || origin === undefined) problems.push(`CSP: connect-src must be 'self' plus exactly one origin (found ${connect.join(" ")})`);
    else if (mode.mode === "template") {
      if (origin !== ORIGIN_TOKEN) problems.push(`CSP: the template connect-src origin must be ${ORIGIN_TOKEN}`);
    } else if (origin.includes(ORIGIN_TOKEN)) {
      problems.push(`CSP: ${ORIGIN_TOKEN} was not rendered (run bun run render:headers)`);
    } else if (originOf(origin) !== origin) {
      problems.push(`CSP: connect-src origin must be an https origin without path or wildcard (found ${origin})`);
    } else if (mode.expectedOrigin !== undefined && origin !== mode.expectedOrigin) {
      problems.push(`CSP: connect-src origin ${origin} differs from the expected ${mode.expectedOrigin}`);
    }
  }
  for (const [name, sources] of csp) {
    if (!(name in EXACT) && !(name in SUBSET) && name !== "connect-src") problems.push(`CSP: unexpected directive ${name}`);
    for (const source of sources) {
      if (source.includes("*")) problems.push(`CSP: ${name} contains a wildcard (${source})`);
      if (source === "'unsafe-eval'") problems.push(`CSP: ${name} contains 'unsafe-eval'`);
      if (source === "'unsafe-inline'" && name !== "style-src") problems.push(`CSP: ${name} contains 'unsafe-inline'`);
    }
  }
  return problems;
}

export const DENIED_FEATURES = [
  "accelerometer", "autoplay", "bluetooth", "camera", "display-capture", "geolocation", "gyroscope", "hid",
  "magnetometer", "microphone", "midi", "payment", "serial", "usb", "xr-spatial-tracking",
] as const;

export function permissionsProblems(value: string): string[] {
  const parsed = new Map<string, string>();
  for (const part of value.split(",")) {
    const match = /^\s*([a-z-]+)=\((.*)\)\s*$/.exec(part);
    if (match?.[1] !== undefined) parsed.set(match[1], (match[2] ?? "").trim());
    else if (part.trim() !== "") parsed.set(part.trim(), "*");
  }
  const problems: string[] = [];
  for (const feature of DENIED_FEATURES) {
    const v = parsed.get(feature);
    if (v === undefined) problems.push(`Permissions-Policy: ${feature} is not denied (missing)`);
    else if (v !== "") problems.push(`Permissions-Policy: ${feature} must be () (found ${v})`);
  }
  if (parsed.get("clipboard-write") !== "self") problems.push("Permissions-Policy: clipboard-write must be (self) (the Copy button)");
  for (const [feature, v] of parsed) {
    if (feature === "clipboard-write" || (DENIED_FEATURES as readonly string[]).includes(feature)) continue;
    problems.push(`Permissions-Policy: ${feature}=(${v}) is not on the reviewed list`);
  }
  return problems;
}

export function headerProblems(rules: HeaderRules, mode: HeaderMode): string[] {
  const all = rules.get("/*");
  if (all === undefined) return ["/* rule is missing"];
  const problems: string[] = [];
  const enforced = all.get("content-security-policy");
  if (all.has("content-security-policy-report-only")) problems.push("Content-Security-Policy-Report-Only must not be shipped (the policy is enforced)");
  if (enforced === undefined) problems.push("Content-Security-Policy is missing");
  else problems.push(...cspProblems(enforced, mode));
  const expect = (name: string, value: string) => {
    if (all.get(name.toLowerCase()) !== value) problems.push(`${name} must be ${value} (found ${all.get(name.toLowerCase()) ?? "missing"})`);
  };
  expect("X-Frame-Options", "DENY");
  expect("X-Content-Type-Options", "nosniff");
  expect("Referrer-Policy", "strict-origin-when-cross-origin");
  expect("Cross-Origin-Opener-Policy", "same-origin-allow-popups");
  const permissions = all.get("permissions-policy");
  if (permissions === undefined) problems.push("Permissions-Policy is missing");
  else problems.push(...permissionsProblems(permissions));
  const hsts = all.get("strict-transport-security");
  if (hsts !== undefined) {
    const maxAge = Number(/max-age=(\d+)/.exec(hsts)?.[1] ?? "0");
    if (maxAge < 15_552_000) problems.push(`Strict-Transport-Security max-age must be at least 15552000 (found ${maxAge})`);
  }
  if (!(rules.get("/sw.js")?.get("cache-control") ?? "").includes("no-cache")) problems.push("/sw.js must be Cache-Control: no-cache");
  if (!(rules.get("/index.html")?.get("cache-control") ?? "").includes("no-cache")) problems.push("/index.html must be Cache-Control: no-cache");
  if (!(rules.get("/assets/*")?.get("cache-control") ?? "").includes("immutable")) problems.push("/assets/* must be immutable");
  return problems;
}
```

Overwrite `apps/web/public/_headers` (keep the cache rules that P0 and P3 added after the `/*` block: `/manifest.webmanifest`, `/theme-init.js`, and any rule a later phase appended; replace only the header comment and the `/*` block):

```text
# Cloudflare Workers Static Assets headers (static assets only; there is no Worker script).
# __SUPABASE_ORIGIN__ is replaced after the build by tools/render-headers.ts with the origin of VITE_SUPABASE_URL.
# Strict-Transport-Security is managed in the Cloudflare dashboard (SSL/TLS, Edge Certificates, HSTS).
/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
  Permissions-Policy: accelerometer=(), autoplay=(), bluetooth=(), camera=(), clipboard-write=(self), display-capture=(), geolocation=(), gyroscope=(), hid=(), magnetometer=(), microphone=(), midi=(), payment=(), serial=(), usb=(), xr-spatial-tracking=()
  Cross-Origin-Opener-Policy: same-origin-allow-popups
  X-Frame-Options: DENY
  Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' __SUPABASE_ORIGIN__; worker-src 'self'; manifest-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'
```

Run: `bun run test:tools headers`
Expected: all tests pass.

- [ ] **Step 5: Render and check commands, scripts, workflows**

`tools/render-headers.ts`:

```ts
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderHeaders } from "./lib/headers.ts";

const source = fileURLToPath(new URL("../apps/web/public/_headers", import.meta.url));
const target = fileURLToPath(new URL("../apps/web/dist/_headers", import.meta.url));
if (!existsSync(target)) {
  console.error("render:headers: apps/web/dist/_headers not found; run the web build first");
  process.exit(1);
}
const { text, origin, placeholder } = renderHeaders(readFileSync(source, "utf8"), process.env.VITE_SUPABASE_URL);
writeFileSync(target, text);
console.log(
  `render:headers: connect-src origin ${origin}${placeholder ? " (PLACEHOLDER: VITE_SUPABASE_URL is not a valid https URL; never deploy this build)" : ""}`,
);
```

`tools/check-headers.ts`:

```ts
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { headerProblems, type HeaderMode, originOf, parseHeadersFile } from "./lib/headers.ts";

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const template = args.includes("--template");
const file = fileURLToPath(
  new URL(template ? "../apps/web/public/_headers" : "../apps/web/dist/_headers", import.meta.url),
);
if (!existsSync(file)) {
  console.error(`check:headers: ${file} not found${template ? "" : " (run bun run build first)"}`);
  process.exit(1);
}
const expectedSource = flag("expect-origin") ?? process.env.VITE_SUPABASE_URL;
const expectedOrigin = expectedSource === undefined ? undefined : (originOf(expectedSource) ?? undefined);
const mode: HeaderMode = template
  ? { mode: "template" }
  : expectedOrigin === undefined
    ? { mode: "rendered" }
    : { mode: "rendered", expectedOrigin };
const problems = headerProblems(parseHeadersFile(readFileSync(file, "utf8")), mode);
if (problems.length > 0) {
  for (const problem of problems) console.error(`check:headers: ${problem}`);
  process.exit(1);
}
console.log(`check:headers: OK (${template ? "template" : "rendered"}${expectedOrigin === undefined ? "" : `, origin ${expectedOrigin}`})`);
```

Edit root `package.json` `scripts` (re-read first):

```jsonc
"build": "bun run --filter @screener/web build && bun run render:headers && bun run check:bundle && bun run check:headers",
"render:headers": "bun run tools/render-headers.ts",
"check:headers": "bun run tools/check-headers.ts",
"test:e2e": "VITE_SUPABASE_URL=https://csp-e2e.supabase.co VITE_SUPABASE_ANON_KEY=csp-e2e-anon VITE_SITE_URL=https://csp-e2e.example.com bun run build && bun run --filter @screener/web e2e",
```

(`bun run` scripts use Bun's cross-platform shell, so the inline variables work on Windows. The fixed origin makes the e2e build deterministic: the stubbed API of P4 intercepts by path, so no DNS lookup happens.) If P4 or P5a changed `build` or `test:e2e`, keep their other content and add only the three differences.

`.github/workflows/deploy-web.yml`: no new step is needed (the `build` script now renders and checks with the job's `VITE_SUPABASE_URL`, which `tools/check-web-env.ts` already requires to be a real https URL). Verify by reading the workflow once and noting it in the review document.

- [ ] **Step 6: Serve `dist` with its headers, and the CSP end-to-end spec**

`tools/serve-dist.ts` (Node `http`, so it type-checks with the root `types: ["node"]`):

```ts
import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { matchHeaders, parseHeadersFile } from "./lib/headers.ts";

const argv = process.argv.slice(2);
const portIndex = argv.indexOf("--port");
const port = Number(portIndex >= 0 ? argv[portIndex + 1] : "4174");
const root = fileURLToPath(new URL("../apps/web/dist/", import.meta.url));
if (!existsSync(join(root, "_headers"))) {
  console.error("serve-dist: apps/web/dist/_headers not found; run bun run build first");
  process.exit(1);
}
const rules = parseHeadersFile(readFileSync(join(root, "_headers"), "utf8"));
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json",
};

createServer((req, res) => {
  const pathname = decodeURIComponent(new URL(req.url ?? "/", "http://localhost").pathname);
  const candidate = normalize(join(root, pathname));
  const inside = candidate === root.slice(0, -1) || candidate.startsWith(root.endsWith(sep) ? root : root + sep);
  const isFile = inside && existsSync(candidate) && statSync(candidate).isFile();
  const file = isFile ? candidate : join(root, "index.html"); // SPA fallback
  const body = readFileSync(file);
  res.writeHead(200, {
    ...matchHeaders(rules, pathname),
    "content-type": TYPES[extname(file)] ?? "application/octet-stream",
  });
  res.end(body);
}).listen(port, () => console.log(`serve-dist: http://localhost:${port} (headers from dist/_headers)`));
```

`apps/web/e2e/csp.spec.ts`:

```ts
import { expect, test } from "@playwright/test";
import { stubApi } from "./support/stub-api";

// Served by tools/serve-dist.ts: the real dist with the real dist/_headers (second webServer of playwright.config.ts).
test.use({ baseURL: "http://localhost:4174" });

type Probe = { __csp: string[] };
const ROUTES = ["/", "/quotes?symbol=MSFT", "/about", "/auth/sign-in", "/auth/sign-up"];

test.beforeEach(async ({ page }) => {
  await stubApi(page);
  await page.addInitScript(() => {
    const w = window as unknown as Probe;
    w.__csp = [];
    document.addEventListener("securitypolicyviolation", (e) => {
      w.__csp.push(`${e.violatedDirective} ${e.blockedURI}`);
    });
  });
});

test.describe("without the service worker", () => {
  test.use({ serviceWorkers: "block" });

  for (const route of ROUTES) {
    test(`no CSP violation and enforced headers on ${route}`, async ({ page }) => {
      const consoleCsp: string[] = [];
      page.on("console", (m) => {
        if (/content security policy/i.test(m.text())) consoleCsp.push(m.text());
      });
      const response = await page.goto(route);
      await page.waitForLoadState("networkidle");
      const headers = response?.headers() ?? {};
      expect(headers["content-security-policy"]).toContain("script-src 'self'");
      expect(headers["content-security-policy-report-only"]).toBeUndefined();
      expect(headers["x-frame-options"]).toBe("DENY");
      expect(headers["x-content-type-options"]).toBe("nosniff");
      expect(await page.evaluate(() => (window as unknown as Probe).__csp)).toEqual([]);
      expect(consoleCsp).toEqual([]);
    });
  }

  test("an injected inline script is blocked", async ({ page }) => {
    await page.goto("/about");
    const executed = await page.evaluate(() => {
      const script = document.createElement("script");
      script.textContent = "window.__injected = true";
      document.head.append(script);
      return (window as unknown as { __injected?: boolean }).__injected === true;
    });
    expect(executed).toBe(false);
    await page.waitForFunction(() => (window as unknown as Probe).__csp.length > 0);
    const seen = await page.evaluate(() => (window as unknown as Probe).__csp);
    expect(seen.some((entry) => entry.startsWith("script-src"))).toBe(true);
  });

  test("a connection to another origin is blocked", async ({ page }) => {
    await page.goto("/about");
    const outcome = await page.evaluate(() =>
      fetch("https://evil.example/collect").then(
        () => "allowed",
        () => "blocked",
      ),
    );
    expect(outcome).toBe("blocked");
    const seen = await page.evaluate(() => (window as unknown as Probe).__csp);
    expect(seen.some((entry) => entry.startsWith("connect-src"))).toBe(true);
  });
});

test.describe("with the service worker", () => {
  test.use({ serviceWorkers: "allow" });

  test("the worker registers under the policy without violations", async ({ page }) => {
    await page.goto("/");
    const scope = await page.evaluate(async () => (await navigator.serviceWorker.ready).scope);
    expect(scope).toBe("http://localhost:4174/");
    expect(await page.evaluate(() => (window as unknown as Probe).__csp)).toEqual([]);
  });
});
```

Edit `apps/web/playwright.config.ts`: replace the single `webServer` object with an array (keep P0's server, add the header-applying one):

```ts
webServer: [
  {
    command: "bun run preview",
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
  {
    command: "bun run tools/serve-dist.ts --port 4174",
    cwd: "../..",
    url: "http://localhost:4174/index.html",
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
],
```

- [ ] **Step 7: Run the header checks**

```text
bun run test:tools headers
bun run lint:fix
bun run lint
bun run typecheck
bunx playwright install chromium
bun run test:e2e
```

Expected: the header tests pass; `build` ends with `check:headers: OK (rendered, origin https://csp-e2e.supabase.co)`; Playwright runs P0's smoke tests, the stubbed specs of P4 and `csp.spec.ts` (8 tests) green. If a route reports a violation, read `__csp` in the failure: a blocked `img-src` or `font-src` means the app loads an asset from another origin (fix the app: self-host the asset); a blocked `style-src` means an inline `<style>` element or `style` attribute written by markup (allowed by `'unsafe-inline'`, so this indicates a different directive: read the entry); never widen `script-src`.

- [ ] **Step 8: Commit part B**

```text
git add apps/web/public/_headers apps/web/playwright.config.ts apps/web/e2e/csp.spec.ts tools/lib/headers.ts tools/lib/headers.test.ts tools/render-headers.ts tools/check-headers.ts tools/serve-dist.ts package.json docs/discovery/security-review.md
git commit -m "feat(security): enforce the CSP with a rendered Supabase origin, tighten headers, add header guards and the CSP e2e"
```

### Part C: logging, secret names, Markdown

- [ ] **Step 9: Redaction per spec 15.6 (TDD)**

Append to `supabase/functions/_shared/adapters/log.test.ts`:

```ts
Deno.test("redact covers the spec 15.6 key list and masks e-mail and long base64 values", () => {
  const out = redact({
    password: "hunter2",
    pushEndpoint: "https://fcm.googleapis.com/fcm/send/abc",
    subscription: { p256dh: "BNc", auth: "xyz" },
    note: "contact jane.doe@example.com about it",
    blob: "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMTIzNDU2Nzg5YWJjZGVm",
    sha: "a".repeat(64),
    jobId: 12,
    status: "done",
  }) as Record<string, unknown>;
  const { password, pushEndpoint, subscription, note, blob, sha, jobId, status } = out;
  assertEquals(password, REDACTED);
  assertEquals(pushEndpoint, REDACTED);
  assertEquals(subscription, { p256dh: REDACTED, auth: REDACTED });
  assertEquals(note, "contact [redacted-email] about it");
  assertEquals(blob, "[redacted-blob]");
  assertEquals(sha, "a".repeat(64)); // a hex digest is an id, not a secret
  assertEquals([jobId, status], [12, "done"]);
});
```

Run: `deno test --config supabase/functions/deno.json supabase/functions/_shared/adapters/log.test.ts`
Expected: the new test fails (`password` is not redacted, the e-mail is not masked).

In `supabase/functions/_shared/adapters/log.ts` replace the `REDACT_KEY` line and extend `redactString`:

```ts
export const REDACT_KEY = /token|secret|key|authorization|password|cookie|crumb|email|endpoint|p256dh|auth/i;
```

```ts
const EMAIL_VALUE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const LONG_BLOB = /[A-Za-z0-9+/_-]{48,}={0,2}/g;
```

and in `redactString`, extend the chain after `URL_USERINFO`:

```ts
  const masked = s
    .replace(URL_CREDENTIAL, `$1${REDACTED}`)
    .replace(BEARER, `Bearer ${REDACTED}`)
    .replace(URL_USERINFO, `$1${REDACTED}@`)
    .replace(EMAIL_VALUE, "[redacted-email]")
    .replace(LONG_BLOB, (blob) => (/^[0-9a-f]+$/i.test(blob) ? blob : "[redacted-blob]"));
```

Update the header comment of `log.ts` to the new key list. Run the Deno tests of the file again: all pass (the existing `tokenCount: REDACTED` expectation still holds).

- [ ] **Step 10: One list of server-only names (TDD)**

`tools/lib/secret-names.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { scanText } from "./secret-scan.ts";
import { SERVER_SECRET_NAMES } from "./secret-names.ts";

describe("SERVER_SECRET_NAMES", () => {
  it.each(SERVER_SECRET_NAMES)("the bundle scan flags %s", (name) => {
    const findings = scanText(`var x = "${name}";`);
    expect(findings.map((f) => f.rule)).toContain("server-only-name");
  });
  it("covers the names the code actually reads", () => {
    for (const name of ["UNSUBSCRIBE_SECRET", "RATE_LIMIT_SALT", "FLEX_ENC_KEY_V1", "VAPID_PRIVATE_KEY", "CRON_SHARED_SECRET", "RESEND_WEBHOOK_SECRET"]) {
      expect(scanText(name).length, name).toBeGreaterThan(0);
    }
  });
});
```

Before writing it, open `tools/lib/secret-scan.ts` and note the `rule` string it uses for name hits (the P0 file reports `rule` and `detail`); use that exact string in the first test.

`tools/lib/secret-names.ts`:

```ts
/**
 * Server-only configuration names (spec 3.11 and 15.4). One list for the bundle scan and for `check:secrets`.
 * A prefix entry (FLEX_ENC, VAPID_PRIVATE) covers versioned names such as FLEX_ENC_KEY_V2.
 */
export const SERVER_SECRET_NAMES = [
  "SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_DB_PASSWORD",
  "SUPABASE_ACCESS_TOKEN",
  "CRON_SHARED_SECRET",
  "WORKER_TICK_SECRET",
  "FLEX_ENC",
  "VAPID_PRIVATE",
  "RESEND_API_KEY",
  "RESEND_WEBHOOK_SECRET",
  "UNSUBSCRIBE_SECRET",
  "UNSUBSCRIBE_SIGNING_KEY",
  "RATE_LIMIT_SALT",
  "GEMINI_API_KEY",
  "TAVILY_API_KEY",
  "JINA_API_KEY",
  "LLM_ALT_API_KEY",
  "CLOUDFLARE_API_TOKEN",
  "KEEPALIVE_PASSWORD",
] as const;

/** Names the platform injects or that are public by design: never reported as secrets. */
export const PUBLIC_OR_PLATFORM_NAMES = [
  "SUPABASE_URL",
  "SUPABASE_ANON_KEY",
  "SUPABASE_DB_URL",
  "SITE_URL",
  "VAPID_PUBLIC_KEY",
  "VAPID_SUBJECT",
  "FUNCTIONS_PUBLIC_URL",
] as const;

/** Read only by tests, tools and the local stack. Never set in production. */
export const LOCAL_ONLY_NAMES = [
  "ALLOW_FIXTURE_PROVIDERS",
  "FLEX_FIXTURE_MODE",
  "PUSH_ENDPOINT_EXTRA_HOSTS",
  "RESEND_API_URL",
  "DB_INTEGRATION",
  "YF_LIVE",
] as const;

export const isServerSecret = (name: string): boolean =>
  SERVER_SECRET_NAMES.some((entry) => name === entry || name.startsWith(entry));
```

In `tools/lib/secret-scan.ts` replace the local `FORBIDDEN_NAMES` array with `import { SERVER_SECRET_NAMES as FORBIDDEN_NAMES } from "./secret-names.ts";` (keep the rest). Run `bun run test:tools secret` and fix the first test's rule string if needed. Expected: pass.

- [ ] **Step 11: Secret inventory check (TDD) and wiring**

`tools/lib/secret-inventory.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { envNamesInSource, inventoryProblems } from "./secret-inventory.ts";

describe("envNamesInSource", () => {
  it("finds Deno.env.get, requireEnv and get() style reads", () => {
    const text = `Deno.env.get("A_ONE"); requireEnv("B_TWO"); const v = get("C_THREE"); headers.get("x-y");`;
    expect(envNamesInSource(text)).toEqual(["A_ONE", "B_TWO", "C_THREE"]);
  });
});

describe("inventoryProblems", () => {
  const ok = {
    codeNames: ["CRON_SHARED_SECRET", "SITE_URL", "FLEX_ENC_KEY_V1"],
    guideText: "`CRON_SHARED_SECRET` `FLEX_ENC_KEY_V1` `SITE_URL`",
    exampleFiles: [{ path: "supabase/functions/.env.example", text: "CRON_SHARED_SECRET=local-dev-cron-secret\nFLEX_ENC_KEY_V1=\n" }],
  };
  it("accepts a documented, listed configuration", () => {
    expect(inventoryProblems(ok)).toEqual([]);
  });
  it("flags a secret-looking name that the bundle scan would miss", () => {
    const p = inventoryProblems({ ...ok, codeNames: [...ok.codeNames, "NEW_SERVICE_API_KEY"], guideText: `${ok.guideText} \`NEW_SERVICE_API_KEY\`` });
    expect(p.join("\n")).toMatch(/NEW_SERVICE_API_KEY.*SERVER_SECRET_NAMES/);
  });
  it("flags a name the operator guide does not mention", () => {
    expect(inventoryProblems({ ...ok, codeNames: [...ok.codeNames, "MYSTERY_SETTING"] }).join("\n")).toMatch(/MYSTERY_SETTING.*operator guide/);
  });
  it("flags a real-looking value in an example file and a secret in a VITE_ name", () => {
    const p = inventoryProblems({ ...ok, exampleFiles: [{ path: "x/.env.example", text: "RESEND_API_KEY=re_abcdef123456\nVITE_SERVICE_ROLE_KEY=\n" }] });
    expect(p.join("\n")).toMatch(/RESEND_API_KEY/);
    expect(p.join("\n")).toMatch(/VITE_SERVICE_ROLE_KEY/);
  });
});
```

`tools/lib/secret-inventory.ts`:

```ts
import { isServerSecret, LOCAL_ONLY_NAMES, PUBLIC_OR_PLATFORM_NAMES } from "./secret-names.ts";

const SECRET_LOOKING = /KEY|SECRET|TOKEN|PASSWORD|SALT/;
const LOCAL_EXAMPLE_VALUES = new Set(["local-dev-cron-secret"]);
const READ = /(?:Deno\.env\.get|requireEnv|optionalEnv|\bget)\(\s*"([A-Z][A-Z0-9_]+)"\s*\)/g;

/** True when the text spells the name as a whole word (code span, table cell or env-file line). */
function mentions(text: string, name: string): boolean {
  return new RegExp(`(^|[^A-Za-z0-9_])${name}([^A-Za-z0-9_]|$)`).test(text);
}

export function envNamesInSource(text: string): string[] {
  return [...text.matchAll(READ)].map((m) => m[1] as string);
}

export interface InventoryInput {
  codeNames: string[];
  guideText: string;
  exampleFiles: Array<{ path: string; text: string }>;
}

export function inventoryProblems(input: InventoryInput): string[] {
  const problems: string[] = [];
  const known = new Set<string>([...PUBLIC_OR_PLATFORM_NAMES, ...LOCAL_ONLY_NAMES]);
  for (const name of [...new Set(input.codeNames)].sort()) {
    if (SECRET_LOOKING.test(name) && !(PUBLIC_OR_PLATFORM_NAMES as readonly string[]).includes(name) && !isServerSecret(name)) {
      problems.push(`${name} looks like a secret but is not in SERVER_SECRET_NAMES (the bundle scan would not catch it)`);
    }
    if (!known.has(name) && !mentions(input.guideText, name)) {
      problems.push(`${name} is read by the code but not documented in the operator guide`);
    }
  }
  for (const file of input.exampleFiles) {
    for (const line of file.text.split(/\r?\n/)) {
      const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line.trim());
      if (match?.[1] === undefined) continue;
      const [name, value = ""] = [match[1], match[2]];
      if (name.startsWith("VITE_") && /SECRET|SERVICE_ROLE|PRIVATE|TOKEN|PASSWORD|API_KEY/.test(name)) {
        problems.push(`${file.path}: ${name} would put a secret into the browser bundle`);
      }
      if (SECRET_LOOKING.test(name) && value !== "" && !LOCAL_EXAMPLE_VALUES.has(value)) {
        problems.push(`${file.path}: ${name} has a value; example files hold names only`);
      }
    }
  }
  return problems;
}
```

`tools/check-secret-inventory.ts`:

```ts
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { envNamesInSource, inventoryProblems } from "./lib/secret-inventory.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const functions = join(root, "supabase", "functions");
const sources = readdirSync(functions, { recursive: true, encoding: "utf8" }).filter(
  (f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !f.includes("fixtures") && !f.includes("node_modules"),
);
const codeNames = sources.flatMap((f) => envNamesInSource(readFileSync(join(functions, f), "utf8")));
const guide = join(root, "docs", "operator-guide.md");
const exampleFiles = ["supabase/functions/.env.example", "apps/web/.env.example"]
  .filter((p) => existsSync(join(root, p)))
  .map((p) => ({ path: p, text: readFileSync(join(root, p), "utf8") }));

const problems = inventoryProblems({
  codeNames,
  guideText: existsSync(guide) ? readFileSync(guide, "utf8") : "",
  exampleFiles,
});
if (problems.length > 0) {
  for (const problem of problems) console.error(`check:secrets: ${problem}`);
  process.exit(1);
}
console.log(`check:secrets: OK (${new Set(codeNames).size} environment names, ${exampleFiles.length} example files)`);
```

Add root scripts `"check:secrets": "bun run tools/check-secret-inventory.ts"`. Run `bun run check:secrets`. Expected on the first run: it lists the names that are read by code but missing from the guide (for example `FUNCTIONS_PUBLIC_URL`, `LLM_PRIMARY`, `GEMINI_MODEL` if a phase forgot them); Task 5 documents each, so record the list in `security-review.md` (section 3) and rerun after Task 5. Until Task 5 lands, run it with the guide check only informational: the command may exit 1 at this point and that is expected.

- [ ] **Step 12: Markdown policy (TDD)**

Locate the renderer: `git grep -ln "react-markdown" -- apps/web/src` (P2 creates `apps/web/src/features/research/MarkdownBody.tsx`). Write `apps/web/src/features/research/markdown-security.test.tsx`:

```tsx
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MarkdownBody } from "./MarkdownBody";

const LEDGER = "https://www.sec.gov/Archives/edgar/data/1/a.htm";
const HOSTILE = [
  "<script>window.__pwned = 1</script>",
  '<img src="x" onerror="window.__pwned = 2">',
  "[click](javascript:window.__pwned=3)",
  "![track](https://tracker.example/p.png)",
  "<https://evil.example/phish>",
  `[ok](${LEDGER})`,
  '<iframe src="https://evil.example"></iframe>',
  "[data](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)",
].join("\n\n");

describe("MarkdownBody security", () => {
  it("renders no active content and no link when no URL is listed", () => {
    const { container } = render(<MarkdownBody markdown={HOSTILE} />);
    expect(container.querySelector("script, img, iframe, style, form, input, object, embed, svg")).toBeNull();
    expect(container.querySelectorAll("a")).toHaveLength(0);
    for (const el of Array.from(container.querySelectorAll("*"))) {
      for (const attr of Array.from(el.attributes)) expect(attr.name.startsWith("on")).toBe(false);
    }
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });

  it("links only ledger URLs, in a new tab with noopener noreferrer", () => {
    const { container } = render(<MarkdownBody markdown={HOSTILE} allowedUrls={[LEDGER]} />);
    const links = Array.from(container.querySelectorAll("a"));
    expect(links.map((a) => a.getAttribute("href"))).toEqual([LEDGER]);
    expect(links[0]?.getAttribute("rel")).toBe("noopener noreferrer");
    expect(links[0]?.getAttribute("target")).toBe("_blank");
  });

  it("keeps a hostile publisher name in a sources line inert", () => {
    const { container } = render(
      <MarkdownBody markdown={"1. [Evil](javascript:alert(1)) <b onclick=x>pub</b>"} />,
    );
    expect(container.querySelectorAll("a, b")).toHaveLength(0);
    expect(container.textContent).toContain("Evil");
  });
});
```

Run: `bun run test:web markdown-security`
Expected: FAIL (the current component links any `http(s)` URL and accepts no `allowedUrls`).

Replace `MarkdownBody.tsx`:

```tsx
import ReactMarkdown from "react-markdown";
import rehypeSanitize from "rehype-sanitize";

const BLOCKED = [
  "img", "picture", "source", "iframe", "frame", "object", "embed", "script", "style", "link", "meta",
  "form", "input", "button", "svg", "math", "video", "audio",
];

function normalise(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : null;
  } catch {
    return null;
  }
}

/**
 * Model-written Markdown is untrusted (spec 15.2 T11 and T13): raw HTML is skipped, images and embeds are removed, and a
 * link is rendered as a link only when its URL is one of the evidence-ledger URLs in `allowedUrls`; everything else is text.
 */
export function MarkdownBody({
  markdown,
  allowedUrls = [],
}: {
  markdown: string;
  allowedUrls?: readonly string[];
}) {
  const allowed = new Set(allowedUrls.map(normalise).filter((u): u is string => u !== null));
  return (
    <div className="prose prose-sm max-w-none dark:prose-invert">
      <ReactMarkdown
        skipHtml
        rehypePlugins={[rehypeSanitize]}
        disallowedElements={BLOCKED}
        unwrapDisallowed
        urlTransform={(url) => (normalise(url) === null ? "" : url)}
        components={{
          a: ({ href, children }) => {
            const target = href === undefined ? null : normalise(href);
            return target !== null && allowed.has(target) ? (
              <a href={target} target="_blank" rel="noopener noreferrer" className="underline">
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

Then wire the ledger URLs: `git grep -n "MarkdownBody" -- apps/web/src ':!*.test.*'`; in `ReportView.tsx` pass `allowedUrls={sources.map((s) => s.url)}` where `sources` is the array the component already renders from `research_sources` (use the real variable name). In `MarkdownBody.test.tsx` of P2, every test that expects a rendered link now passes `allowedUrls`.

Run: `bun run test:web research`
Expected: all research and security tests pass.

- [ ] **Step 13: Commit part C**

```text
bun run lint:fix
bun run lint
bun run typecheck
bun run test:tools
bun run test:web
git add supabase/functions/_shared/adapters/log.ts supabase/functions/_shared/adapters/log.test.ts tools/lib/secret-names.ts tools/lib/secret-names.test.ts tools/lib/secret-inventory.ts tools/lib/secret-inventory.test.ts tools/check-secret-inventory.ts tools/lib/secret-scan.ts apps/web/src/features/research package.json docs/discovery/security-review.md
git commit -m "feat(security): redaction per spec 15.6, single secret-name list with inventory check, link-safe Markdown"
```

### Part D: outbound requests, rate limits, kill switch

- [ ] **Step 14: Operator-configured base URLs must be https (TDD)**

Append to `supabase/functions/_shared/adapters/env.test.ts` (extend its import to `import { requireEnv, requireHttpsBase } from "./env.ts";`):

```ts
Deno.test("requireHttpsBase accepts https, accepts http only for a local stack, rejects the rest", () => {
  assertEquals(
    requireHttpsBase("X_URL", "https://api.example.com/v1", "https://abc.supabase.co"),
    "https://api.example.com/v1",
  );
  assertEquals(
    requireHttpsBase("X_URL", "http://host.docker.internal:54782/emails", "http://127.0.0.1:54321"),
    "http://host.docker.internal:54782/emails",
  );
  assertThrows(() => requireHttpsBase("X_URL", "http://api.example.com", "https://abc.supabase.co"), Error, "X_URL must be an https URL");
  assertThrows(() => requireHttpsBase("X_URL", "ftp://api.example.com", "http://127.0.0.1:54321"), Error, "X_URL must be an https URL");
  assertThrows(() => requireHttpsBase("X_URL", "not a url", "https://abc.supabase.co"), Error, "X_URL is not a valid URL");
});
```

Run: `deno test --config supabase/functions/deno.json supabase/functions/_shared/adapters/env.test.ts`
Expected: FAIL (`requireHttpsBase` is not exported).

Append to `supabase/functions/_shared/adapters/env.ts`:

```ts
function isLocalStack(supabaseUrl: string): boolean {
  try {
    const host = new URL(supabaseUrl).hostname;
    return host === "127.0.0.1" || host === "localhost" || host === "host.docker.internal";
  } catch {
    return false;
  }
}

/**
 * Operator-configured base URLs (LLM_ALT_BASE_URL, FLEX_BASE_URL, RESEND_API_URL) must be https; plain http is accepted
 * only when SUPABASE_URL is a local stack (fixture and mock servers). Spec 15.2 T12.
 */
export function requireHttpsBase(
  name: string,
  value: string,
  supabaseUrl: string = Deno.env.get("SUPABASE_URL") ?? "",
): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} is not a valid URL`);
  }
  if (url.protocol === "https:") return value;
  if (url.protocol === "http:" && isLocalStack(supabaseUrl)) return value;
  throw new Error(`${name} must be an https URL`);
}
```

Apply it where the variables are read: `git grep -n -E "FLEX_BASE_URL|RESEND_API_URL" -- supabase/functions ':!*.test.ts'`. For each hit, wrap the value, for example `baseUrl: requireHttpsBase("FLEX_BASE_URL", Deno.env.get("FLEX_BASE_URL") ?? DEFAULT_FLEX_URL)` and `url: requireHttpsBase("RESEND_API_URL", Deno.env.get("RESEND_API_URL") ?? "https://api.resend.com/emails")`. `LLM_ALT_BASE_URL` is wrapped in Task 3 (it owns `llm/index.ts`). Run the Deno tests of the touched adapters (`flex`, `email`): they inject their own URLs through options, so they keep passing.

- [ ] **Step 15: Outbound call-site inventory (TDD)**

`tools/lib/fetch-callsites.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { type FetchPolicy, fetchPolicyProblems, findFetchCalls } from "./fetch-callsites.ts";

describe("findFetchCalls", () => {
  it("finds fetch and fetchImpl calls and ignores comments and type uses", () => {
    const text = [
      "// fetch(x)",
      " * fetch(y)",
      "const r = await fetch(url);",
      "const q = o.fetchImpl(u, i);",
      "type F = typeof fetch;",
      "const t = throttle.fetch(u);",
    ].join("\n");
    expect(findFetchCalls("a.ts", text).map((c) => c.line)).toEqual([3, 4, 6]);
  });
});

describe("fetchPolicyProblems", () => {
  const policy: Record<string, FetchPolicy> = {
    "f/guarded.ts": { category: "ssrf-guarded", reason: "search results", requires: ["publicUrlProblem"] },
    "f/fixed.ts": { category: "fixed-host", reason: "api.example.com" },
    "f/gone.ts": { category: "fixed-host", reason: "removed" },
  };
  it("accepts reviewed files whose guard is present and lists stale entries separately", () => {
    const result = fetchPolicyProblems(
      [
        { file: "f/guarded.ts", text: "import { publicUrlProblem } from 'x'; fetch(u)" },
        { file: "f/fixed.ts", text: "fetch('https://api.example.com')" },
      ],
      policy,
    );
    expect(result.problems).toEqual([]);
    expect(result.stale).toEqual(["f/gone.ts"]);
  });
  it("flags an unreviewed call site and a guarded file that lost its guard", () => {
    const result = fetchPolicyProblems(
      [
        { file: "f/new.ts", text: "const r = await fetch(userUrl);" },
        { file: "f/guarded.ts", text: "fetch(u)" },
      ],
      policy,
    );
    expect(result.problems.join("\n")).toMatch(/f\/new\.ts:1.*not reviewed/);
    expect(result.problems.join("\n")).toMatch(/f\/guarded\.ts.*publicUrlProblem/);
  });
  it("ignores files without a call", () => {
    expect(fetchPolicyProblems([{ file: "f/none.ts", text: "const a = 1;" }], {}).problems).toEqual([]);
  });
});
```

`tools/lib/fetch-callsites.ts`:

```ts
export type FetchCategory =
  | "fixed-host"
  | "ssrf-guarded"
  | "endpoint-allow-listed"
  | "operator-configured";

export interface FetchPolicy {
  category: FetchCategory;
  reason: string;
  /** Strings that must appear in the file (the guard it relies on). */
  requires?: string[];
}
export interface SourceFile {
  file: string;
  text: string;
}
export interface Callsite {
  file: string;
  line: number;
  text: string;
}

const CALL = /\b(?:fetch|fetchImpl)\s*\(/;

export function findFetchCalls(file: string, text: string): Callsite[] {
  const out: Callsite[] = [];
  text.split(/\r?\n/).forEach((raw, index) => {
    const trimmed = raw.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) return;
    if (CALL.test(raw)) out.push({ file, line: index + 1, text: trimmed });
  });
  return out;
}

/**
 * Reviewed outbound call sites (spec 15.2 T12). A file with a `fetch(` call that is not listed here fails
 * `bun run check:fetch`: review the URL source, then add it with the matching category.
 */
export const FETCH_POLICY: Record<string, FetchPolicy> = {
  "supabase/functions/_shared/adapters/yahoo.ts": { category: "fixed-host", reason: "Yahoo hosts used by yahoo-finance2 (query1, query2, fc); symbols never form a host" },
  "supabase/functions/_shared/adapters/throttle.ts": { category: "fixed-host", reason: "wraps the Yahoo fetch; URLs come from yahoo-finance2" },
  "supabase/functions/_shared/adapters/fx.ts": { category: "fixed-host", reason: "api.frankfurter.dev and the Yahoo provider" },
  "supabase/functions/_shared/adapters/search/tavily.ts": { category: "fixed-host", reason: "api.tavily.com" },
  "supabase/functions/_shared/adapters/llm/gemini.ts": { category: "fixed-host", reason: "generativelanguage.googleapis.com" },
  "supabase/functions/_shared/adapters/llm/openai-compatible.ts": { category: "operator-configured", reason: "LLM_ALT_BASE_URL validated by requireHttpsBase in llm/index.ts" },
  "supabase/functions/_shared/adapters/fetchers/direct.ts": { category: "ssrf-guarded", reason: "URLs from search results and documents: public host names only, DNS check, redirects re-validated, 2 MB cap", requires: ["publicUrlProblem", "readCapped"] },
  "supabase/functions/_shared/adapters/fetchers/jina.ts": { category: "ssrf-guarded", reason: "r.jina.ai receives a model-influenced target URL: checked with publicUrlProblem first", requires: ["publicUrlProblem"] },
  "supabase/functions/_shared/adapters/fetchers/edgar.ts": { category: "fixed-host", reason: "sec.gov paths built from CIK and accession numbers" },
  "supabase/functions/_shared/adapters/push.ts": { category: "endpoint-allow-listed", reason: "user-supplied push endpoints: https push services only (isAllowedPushEndpoint)", requires: ["isAllowedPushEndpoint"] },
  "supabase/functions/_shared/adapters/email.ts": { category: "operator-configured", reason: "api.resend.com; RESEND_API_URL validated by requireHttpsBase", requires: ["requireHttpsBase"] },
  "supabase/functions/_shared/adapters/flex.ts": { category: "operator-configured", reason: "IBKR Flex host; FLEX_BASE_URL validated by requireHttpsBase", requires: ["requireHttpsBase"] },
  "supabase/functions/_shared/adapters/ibkr-catalogue.ts": { category: "fixed-host", reason: "IBKR contract catalogue hosts; only numeric ids and exchange codes from our tables enter the URL" },
  "supabase/functions/quotes/provider.ts": { category: "fixed-host", reason: "passes the global fetch to the Yahoo provider" },
  "supabase/functions/worker-tick/providers.ts": { category: "fixed-host", reason: "passes the global fetch to the Yahoo and FX providers" },
};

export function fetchPolicyProblems(
  files: SourceFile[],
  policy: Record<string, FetchPolicy> = FETCH_POLICY,
): { problems: string[]; stale: string[] } {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const { file, text } of files) {
    const calls = findFetchCalls(file, text);
    if (calls.length === 0) continue;
    seen.add(file);
    const entry = policy[file];
    if (entry === undefined) {
      const first = calls[0] as Callsite;
      problems.push(`${file}:${first.line}: outbound fetch not reviewed (add it to FETCH_POLICY after checking where its URL comes from)`);
      continue;
    }
    for (const needle of entry.requires ?? []) {
      if (!text.includes(needle)) problems.push(`${file}: policy says ${entry.category} but the file no longer mentions ${needle}`);
    }
  }
  const stale = Object.keys(policy).filter((file) => !seen.has(file)).sort();
  return { problems, stale };
}
```

`tools/check-fetch-callsites.ts`:

```ts
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchPolicyProblems } from "./lib/fetch-callsites.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const base = join(root, "supabase", "functions");
const files = readdirSync(base, { recursive: true, encoding: "utf8" })
  .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !f.includes("fixtures") && !f.includes("node_modules"))
  .map((f) => ({
    file: `supabase/functions/${f.split("\\").join("/")}`,
    text: readFileSync(join(base, f), "utf8"),
  }));
const { problems, stale } = fetchPolicyProblems(files);
for (const entry of stale) console.warn(`check:fetch: policy entry without a call site (remove it if the file is gone): ${entry}`);
if (problems.length > 0) {
  for (const problem of problems) console.error(`check:fetch: ${problem}`);
  process.exit(1);
}
console.log(`check:fetch: OK (${files.length} files scanned)`);
```

Add root script `"check:fetch": "bun run tools/check-fetch-callsites.ts"`. Run `bun run test:tools fetch-callsites` (pass) and `bun run check:fetch`. Expected: either OK, or a list of call-site files this plan did not know (for example a P6 or P5b adapter). For each, read the file, decide the category from where the URL comes from, and add the entry; if the URL is model- or user-influenced and unguarded, that is a finding: fix it with `publicUrlProblem` (exported from `fetchers/direct.ts`) and add `requires`. Record the final policy table in `security-review.md` section 8.

- [ ] **Step 16: The rate-limit wrapper (TDD)**

`supabase/functions/_shared/adapters/rate-limit.test.ts`:

```ts
import { assertEquals } from "@std/assert";
import { clientIp, withIpRateLimit } from "./rate-limit.ts";

function harness(perMinute = 3) {
  const counters = new Map<string, number>();
  let nowMs = Date.UTC(2026, 9, 15, 7, 0, 10);
  const calls: string[] = [];
  const incr = (key: string): Promise<number> => {
    const n = (counters.get(key) ?? 0) + 1;
    counters.set(key, n);
    return Promise.resolve(n);
  };
  const handler = withIpRateLimit(
    (req) => {
      calls.push(req.method);
      return new Response("ok");
    },
    { fn: "f", perMinute, salt: "salt-salt-salt-salt-salt-salt-12", incr, now: () => nowMs },
  );
  return { handler, counters, calls, advance: (ms: number) => (nowMs += ms) };
}
const req = (headers: Record<string, string> = {}, method = "POST") =>
  new Request("https://f.example/x", { method, headers });

Deno.test("allows perMinute requests then answers 429 with Retry-After and CORS", async () => {
  const h = harness(3);
  for (let i = 0; i < 3; i++) assertEquals((await h.handler(req({ "cf-connecting-ip": "1.1.1.1" }))).status, 200);
  const limited = await h.handler(req({ "cf-connecting-ip": "1.1.1.1", origin: "https://site.example" }));
  assertEquals(limited.status, 429);
  assertEquals(Number(limited.headers.get("retry-after")) >= 1, true);
  assertEquals((await limited.json()).error, "rate_limited");
  assertEquals(h.calls.length, 3);
});

Deno.test("buckets are per IP and reset with the minute", async () => {
  const h = harness(1);
  assertEquals((await h.handler(req({ "cf-connecting-ip": "1.1.1.1" }))).status, 200);
  assertEquals((await h.handler(req({ "cf-connecting-ip": "2.2.2.2" }))).status, 200);
  assertEquals((await h.handler(req({ "cf-connecting-ip": "1.1.1.1" }))).status, 429);
  h.advance(60_000);
  assertEquals((await h.handler(req({ "cf-connecting-ip": "1.1.1.1" }))).status, 200);
});

Deno.test("a spoofed left-most x-forwarded-for entry does not change the bucket", async () => {
  const h = harness(1);
  assertEquals((await h.handler(req({ "x-forwarded-for": "1.2.3.4, 9.9.9.9" }))).status, 200);
  assertEquals((await h.handler(req({ "x-forwarded-for": "5.6.7.8, 9.9.9.9" }))).status, 429);
  assertEquals(clientIp(req({ "x-forwarded-for": "1.2.3.4, 9.9.9.9" })), "9.9.9.9");
  assertEquals(clientIp(req({ "cf-connecting-ip": "7.7.7.7", "x-forwarded-for": "1.2.3.4" })), "7.7.7.7");
  assertEquals(clientIp(req()), "unknown");
});

Deno.test("preflight requests are never counted, and a counter failure lets the request through", async () => {
  const h = harness(1);
  for (let i = 0; i < 5; i++) assertEquals((await h.handler(req({}, "OPTIONS"))).status, 200);
  assertEquals(h.counters.size, 0);
  const open = withIpRateLimit(() => new Response("ok"), {
    fn: "f",
    perMinute: 1,
    salt: "salt-salt-salt-salt-salt-salt-12",
    incr: () => Promise.reject(new Error("db down")),
  });
  assertEquals((await open(req())).status, 200);
});
```

Run: `deno test --config supabase/functions/deno.json supabase/functions/_shared/adapters/rate-limit.test.ts`
Expected: FAIL, module not found.

`supabase/functions/_shared/adapters/rate-limit.ts`:

```ts
import { corsHeaders, json } from "./http.ts";

/** Behind Cloudflare the real client is `cf-connecting-ip`; otherwise the RIGHT-most `x-forwarded-for` entry (added by the proxy, not the client). */
export function clientIp(req: Request): string {
  const cf = req.headers.get("cf-connecting-ip")?.trim();
  if (cf) return cf;
  const parts = (req.headers.get("x-forwarded-for") ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  return parts.at(-1) ?? "unknown";
}

/** SHA-256 of salt + UTC day + IP, truncated: the raw IP is never stored or logged; the salt rotates daily. */
export async function hashIp(ip: string, salt: string, nowMs: number): Promise<string> {
  const day = new Date(nowMs).toISOString().slice(0, 10);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${salt}:${day}:${ip}`));
  return [...new Uint8Array(digest)]
    .slice(0, 16)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export interface RateLimitOptions {
  fn: string;
  perMinute: number;
  salt: string;
  /** Atomic counter: returns the new count for the key. */
  incr: (key: string, expiresAtIso: string) => Promise<number>;
  now?: () => number;
}

/**
 * Per-IP request limit in front of a handler (spec 15.2 T7). Counters live in `quote_cache` rows `rl:<fn>:<hash>:<minute>`
 * through `public.quotes_rl_incr`. A counter failure lets the request through: availability first, the per-user cooldowns
 * inside the handlers still apply.
 */
export function withIpRateLimit(
  handler: (req: Request) => Response | Promise<Response>,
  o: RateLimitOptions,
): (req: Request) => Promise<Response> {
  return async (req) => {
    if (req.method === "OPTIONS") return handler(req);
    const nowMs = (o.now ?? Date.now)();
    const minute = Math.floor(nowMs / 60_000);
    let count: number;
    try {
      const key = `rl:${o.fn}:${await hashIp(clientIp(req), o.salt, nowMs)}:${minute}`;
      count = await o.incr(key, new Date((minute + 2) * 60_000).toISOString());
    } catch {
      return handler(req);
    }
    if (count <= o.perMinute) return handler(req);
    const retryAfter = Math.max(1, Math.ceil(((minute + 1) * 60_000 - nowMs) / 1000));
    return json(
      { error: "rate_limited", retryAfterSeconds: retryAfter },
      {
        status: 429,
        headers: { "retry-after": String(retryAfter), ...corsHeaders(req.headers.get("origin")) },
      },
    );
  };
}

interface RpcClient {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }>;
}

/** The production counter: the atomic SQL function created by the quotes migration. */
export function rpcIncr(db: RpcClient): RateLimitOptions["incr"] {
  return async (key, expiresAtIso) => {
    const { data, error } = await db.rpc("quotes_rl_incr", { p_key: key, p_expires: expiresAtIso });
    if (error !== null || typeof data !== "number") throw new Error("rate_limit_counter_unavailable");
    return data;
  };
}
```

Run the test file again: all 4 pass.

- [ ] **Step 17: Wire the limiter, fix the `quotes` client IP, add the probe**

1. `supabase/functions/quotes/ratelimit.ts`: delete the local `hashIp` and `clientIp` bodies and re-export: `export { clientIp, hashIp } from "@adapters/rate-limit.ts";` (keep `RATE_LIMIT_PER_MINUTE` and `checkRate`). Run `deno test --config supabase/functions/deno.json supabase/functions/quotes`; a test that asserted the left-most `x-forwarded-for` entry now asserts the right-most one (update the expectation, the old behaviour is finding S-08).
2. In `supabase/functions/push-subscribe/index.ts`, `broker-sync/index.ts` and `portfolio-refresh/index.ts` (read each file first; the service-role client is named `admin` or `db`), add the imports and wrap the handler passed to `Deno.serve`:

```ts
import { rpcIncr, withIpRateLimit } from "@adapters/rate-limit.ts";
// ...after the service-role client exists:
const limitOptions = (fn: string, perMinute: number) => ({
  fn,
  perMinute,
  salt: requireEnv("RATE_LIMIT_SALT"),
  incr: rpcIncr(admin),
});
// push-subscribe:
Deno.serve(withIpRateLimit((req) => handlePushSubscribe(req, { /* unchanged dependencies */ }), limitOptions("push-subscribe", 20)));
// broker-sync:        limitOptions("broker-sync", 20)
// portfolio-refresh:  limitOptions("portfolio-refresh", 60)
```

   `requireEnv` is already imported in these files from `@adapters/env.ts`; if a file reads the service client under another name, pass that. Add `RATE_LIMIT_SALT` to the operator guide list in Task 5 (it is already a `quotes` secret).
3. `tools/probe-rate-limit.ts` (owner or CI runs it against a served or hosted function; it sends only GET or POST requests the function already accepts and prints no secret):

```ts
// Usage: bun run probe:ratelimit -- --url http://127.0.0.1:54321/functions/v1/quotes/MSFT --limit 60 [--method GET]
// Needs SUPABASE_ANON_KEY in the environment (sent as apikey and bearer). Exits 1 when a spoofed X-Forwarded-For bypasses the limit
// or when a single client is limited before `limit` requests.
const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const url = flag("url");
const limit = Number(flag("limit") ?? "60");
const method = flag("method") ?? "GET";
const anon = process.env.SUPABASE_ANON_KEY ?? "";
if (url === undefined || !Number.isFinite(limit) || anon === "") {
  console.error("usage: bun run probe:ratelimit -- --url <function url> --limit <n> [--method GET|POST]; set SUPABASE_ANON_KEY");
  process.exit(2);
}
const base = { apikey: anon, authorization: `Bearer ${anon}` };
const hit = async (extra: Record<string, string>) =>
  (await fetch(url, { method, headers: { ...base, ...extra }, ...(method === "POST" ? { body: "{}" } : {}) })).status;

// 1. rotate the left-most X-Forwarded-For entry: a spoofing client must still run into the limit
let limited = 0;
for (let i = 0; i < limit + 15; i++) if ((await hit({ "x-forwarded-for": `10.${i % 250}.${i % 200}.${i % 100}` })) === 429) limited += 1;
console.log(`spoofed X-Forwarded-For: ${limited} of ${limit + 15} requests were limited`);

// 2. next minute: one honest client gets its full allowance
const wait = 61_000 - (Date.now() % 60_000);
console.log(`waiting ${Math.round(wait / 1000)} s for a fresh minute bucket`);
await new Promise((resolve) => setTimeout(resolve, wait));
let early = 0;
for (let i = 0; i < limit; i++) if ((await hit({})) === 429) early += 1;
console.log(`single client: ${early} of ${limit} requests were limited`);

const failures: string[] = [];
if (limited === 0) failures.push("a rotating X-Forwarded-For bypassed the limit");
if (early > 0) failures.push("a single client was limited before its allowance");
if (failures.length > 0) {
  console.error(`probe:ratelimit FAIL: ${failures.join("; ")}`);
  process.exit(1);
}
console.log("probe:ratelimit OK");
```

Add root script `"probe:ratelimit": "bun run tools/probe-rate-limit.ts"`.

   Run it once against the local stack (functions served with `RATE_LIMIT_SALT` set): `bun run probe:ratelimit -- --url http://127.0.0.1:54321/functions/v1/quotes/MSFT --limit 60`, and once per other function with its limit (a 401 or 400 answer counts as a request; only 429 is counted). Paste the output into section 10 of the review document. If Kong passes the client's own `X-Forwarded-For` through unchanged (every request then shares the right-most entry of the local gateway), the single-client check still passes and the spoof check proves the bypass is closed.

- [ ] **Step 18: The kill switch setting, migration and pgTAP (TDD)**

`supabase/tests/0910_providers_setting.test.sql`:

```sql
begin;
create extension if not exists pgtap with schema extensions;
select plan(4);

select is((select value from app_settings where key = 'providers'), '{"yahoo_enabled": true}'::jsonb,
  'the provider kill switch row exists and defaults to enabled');
select is((select is_public from app_settings where key = 'providers'), false, 'the providers setting is not public');

set local role anon;
select is((select count(*)::int from app_settings where key = 'providers'), 0, 'anon cannot read the providers setting');
reset role;

set local role authenticated;
select throws_ok($$update app_settings set value = '{"yahoo_enabled": false}' where key = 'providers'$$, '42501', null,
  'a signed-in user cannot flip the kill switch');
reset role;

select * from finish();
rollback;
```

`supabase/migrations/20261015007100_providers_setting.sql`:

```sql
-- P7: Yahoo kill switch (spec 15.5, mitigation 4). Not public; changed only through scan-control set_setting (audited).
insert into app_settings (key, value, is_public, description)
values ('providers', '{"yahoo_enabled": true}'::jsonb, false,
        'Provider kill switches (15.5). yahoo_enabled = false freezes every Yahoo request; the site keeps serving the last published data.')
on conflict (key) do nothing;
```

If the migration timestamp does not sort after P6's migrations (`ls supabase/migrations`), rename both this file and Task 2's to a later common prefix.

- [ ] **Step 19: The kill switch in code (TDD)**

1. `supabase/functions/_shared/adapters/settings.test.ts`, append (extend its import with `createYahooEnabledCheck, parseProviderSettings`):

```ts
Deno.test("providers setting: only an explicit false disables Yahoo", () => {
  assertEquals(parseProviderSettings({ yahoo_enabled: false }).yahooEnabled, false);
  for (const raw of [{ yahoo_enabled: true }, {}, null, undefined, "x", { yahoo_enabled: "false" }]) {
    assertEquals(parseProviderSettings(raw).yahooEnabled, true);
  }
});

Deno.test("createYahooEnabledCheck caches for the ttl and keeps the last value when the read fails", async () => {
  let now = 0;
  let reads = 0;
  let raw: unknown = { yahoo_enabled: true };
  let fail = false;
  const check = createYahooEnabledCheck(
    () => {
      reads++;
      return fail ? Promise.reject(new Error("db")) : Promise.resolve(raw);
    },
    () => now,
    30_000,
  );
  assertEquals(await check(), true);
  assertEquals(reads, 1);
  raw = { yahoo_enabled: false };
  now = 10_000;
  assertEquals(await check(), true);
  assertEquals(reads, 1);
  now = 31_000;
  assertEquals(await check(), false);
  assertEquals(reads, 2);
  fail = true;
  now = 70_000;
  assertEquals(await check(), false);
});
```

   Append to `supabase/functions/_shared/adapters/settings.ts`:

```ts
export interface ProviderSettings {
  yahooEnabled: boolean;
}

/** Anything but an explicit `false` keeps Yahoo on: a malformed row must never freeze the site. */
export function parseProviderSettings(raw: unknown): ProviderSettings {
  const flag =
    typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>).yahoo_enabled : undefined;
  return { yahooEnabled: flag !== false };
}

/** Cached read of the kill switch (30 s); a failing read keeps the last known value (default: enabled). */
export function createYahooEnabledCheck(
  read: () => Promise<unknown>,
  nowMs: () => number,
  ttlMs = 30_000,
): () => Promise<boolean> {
  let cached: { at: number; value: boolean } | null = null;
  return async () => {
    const now = nowMs();
    if (cached !== null && now - cached.at < ttlMs) return cached.value;
    let value = cached?.value ?? true;
    try {
      value = parseProviderSettings(await read()).yahooEnabled;
    } catch {
      // keep the last known value
    }
    cached = { at: now, value };
    return value;
  };
}
```

2. `supabase/functions/_shared/adapters/throttle.test.ts`, append:

```ts
Deno.test("kill switch: a disabled provider refuses every request without calling fetch", async () => {
  const clock = createFakeClock();
  let calls = 0;
  let enabled = false;
  const throttle = createThrottle({
    fetchImpl: () => {
      calls++;
      return Promise.resolve(new Response("{}", { status: 200 }));
    },
    clock,
    breaker: createKvBreakerStore(createMemoryKv(clock)),
    isEnabled: () => Promise.resolve(enabled),
  });
  await assertRejects(() => throttle.fetch("https://query1.finance.yahoo.com/v7/x"), YahooUnavailableError);
  assertEquals(calls, 0);
  enabled = true;
  assertEquals((await throttle.fetch("https://query1.finance.yahoo.com/v7/x")).status, 200);
  assertEquals(calls, 1);
});
```

   In `throttle.ts` add `isEnabled?: () => Promise<boolean>;` to `ThrottleOptions` and, at the start of each attempt in `once()` (directly after the `BudgetExceededError` line, before the breaker check):

```ts
      if (opts.isEnabled !== undefined && !(await opts.isEnabled()))
        throw new YahooUnavailableError(clock.now() + 15 * 60_000);
```

   In `yahoo.ts` add `isEnabled?: () => Promise<boolean>;` to `YahooProviderOptions` and pass it to `createThrottle` next to the other optional spreads: `...(o.isEnabled === undefined ? {} : { isEnabled: o.isEnabled }),`.

3. Wire the two construction sites (read each file; `a.db.sb` in the worker, `db` in `quotes`):

```ts
// supabase/functions/worker-tick/providers.ts, inside createYahooProvider({ ... })
isEnabled: createYahooEnabledCheck(
  async () => (await a.db.sb.from("app_settings").select("value").eq("key", "providers").maybeSingle()).data?.value,
  Date.now,
),
// supabase/functions/quotes/provider.ts, inside createProvider(db)
isEnabled: createYahooEnabledCheck(
  async () => (await db.from("app_settings").select("value").eq("key", "providers").maybeSingle()).data?.value,
  Date.now,
),
```

   with `import { createYahooEnabledCheck } from "../_shared/adapters/settings.ts";` (worker) and `from "@adapters/settings.ts"` (quotes). The worker already reschedules a job that throws `YahooUnavailableError` without consuming an attempt; `quotes` answers from its cache or 502 exactly as it does for an open breaker.
4. `supabase/functions/scan-control/validate.ts`: add `"providers"` to `SETTING_KEYS` (keep every key a phase already added, for example `research`), and, before the `if (!isRec(value)) return fail("value_must_be_an_object");` line of the `set_setting` case, insert:

```ts
      if (key === "providers") {
        if (
          !isRec(value) ||
          typeof value.yahoo_enabled !== "boolean" ||
          Object.keys(value).some((k) => k !== "yahoo_enabled")
        )
          return fail("providers_must_be_exactly_yahoo_enabled_boolean");
        return { ok: true, action: "set_setting", key, value, reason };
      }
```

   `supabase/functions/scan-control/actions.ts`: change the upsert flag to `is_public: p.key !== "pipeline" && p.key !== "providers",`. Append to `validate.test.ts`:

```ts
Deno.test("set_setting providers accepts exactly { yahoo_enabled: boolean }", () => {
  const ok = parseRequest({ action: "set_setting", key: "providers", value: { yahoo_enabled: false }, confirm: true, reason: "yahoo block" });
  assertEquals(ok.ok, true);
  for (const value of [{ yahoo_enabled: "no" }, {}, { yahoo_enabled: true, other: 1 }]) {
    assertEquals(parseRequest({ action: "set_setting", key: "providers", value, confirm: true, reason: "x yz" }).ok, false);
  }
});
```

   Run: `bun run functions:check`, `bun run functions:test`, then `bunx supabase db reset` and `bun run test:db` (the new `0910` suite passes). Commit part D:

```text
git add supabase tools package.json docs/discovery/security-review.md
git commit -m "feat(security): per-IP rate limits on the user functions, right-most client IP, https-only base URLs, outbound inventory, Yahoo kill switch"
```

### Part E: dependency audit

- [ ] **Step 20: Audit parsing and policy (TDD)**

`tools/lib/audit.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { auditProblems, parseBunAudit, parseNpmAudit, specifiersFromSource } from "./audit.ts";

const bun = {
  "left-pad": [
    { id: 1111, url: "https://github.com/advisories/GHSA-aaaa-bbbb-cccc", title: "bad", severity: "high", vulnerable_versions: "<1.3.1" },
  ],
  fine: [{ id: 2222, url: "https://github.com/advisories/GHSA-dddd-eeee-ffff", title: "meh", severity: "low" }],
};
const npm = {
  vulnerabilities: {
    "fast-xml-parser": {
      severity: "critical",
      via: [{ source: 3333, name: "fast-xml-parser", title: "entity expansion", url: "https://github.com/advisories/GHSA-gggg-hhhh-iiii", severity: "critical" }, "other-pkg"],
    },
  },
};

describe("parsers", () => {
  it("reads the Bun format", () => {
    expect(parseBunAudit(bun).map((a) => [a.pkg, a.severity, a.id])).toEqual([
      ["left-pad", "high", "GHSA-aaaa-bbbb-cccc"],
      ["fine", "low", "GHSA-dddd-eeee-ffff"],
    ]);
  });
  it("reads the npm format and ignores transitive string entries", () => {
    expect(parseNpmAudit(npm).map((a) => [a.pkg, a.severity, a.id])).toEqual([["fast-xml-parser", "critical", "GHSA-gggg-hhhh-iiii"]]);
  });
  it("returns nothing for an empty or unknown shape", () => {
    expect(parseBunAudit({})).toEqual([]);
    expect(parseNpmAudit({ vulnerabilities: {} })).toEqual([]);
    expect(parseNpmAudit(null)).toEqual([]);
  });
});

describe("auditProblems", () => {
  const advisories = [...parseBunAudit(bun), ...parseNpmAudit(npm)];
  const now = Date.parse("2026-10-15T00:00:00Z");
  it("blocks high and critical advisories without an exception", () => {
    const { problems } = auditProblems(advisories, [], now);
    expect(problems).toHaveLength(2);
    expect(problems.join("\n")).toMatch(/GHSA-aaaa-bbbb-cccc/);
  });
  it("accepts a documented exception until it expires and flags an expired one", () => {
    const exceptions = [
      { id: "GHSA-aaaa-bbbb-cccc", reason: "dev-only path, not reachable", expires: "2027-01-01" },
      { id: "GHSA-gggg-hhhh-iiii", reason: "no fix yet", expires: "2026-01-01" },
    ];
    const { problems } = auditProblems(advisories, exceptions, now);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/expired/);
  });
  it("warns about an exception that matches nothing", () => {
    const { warnings } = auditProblems([], [{ id: "GHSA-zzzz-zzzz-zzzz", reason: "x", expires: "2027-01-01" }], now);
    expect(warnings).toHaveLength(1);
  });
});

describe("specifiersFromSource", () => {
  it("finds npm: specifiers with scope and exact version", () => {
    const text = `import a from "npm:fast-xml-parser@5.11.2"; import { x } from 'npm:@supabase/supabase-js@2.117.3'; "npm:yahoo-finance2@4.0.3"; "npm:nover"`;
    expect(specifiersFromSource(text)).toEqual([
      { name: "fast-xml-parser", version: "5.11.2" },
      { name: "@supabase/supabase-js", version: "2.117.3" },
      { name: "yahoo-finance2", version: "4.0.3" },
    ]);
  });
});
```

`tools/lib/audit.ts`:

```ts
export type Severity = "info" | "low" | "moderate" | "high" | "critical";
export interface Advisory {
  pkg: string;
  severity: Severity;
  id: string;
  title: string;
}
export interface AuditException {
  id: string;
  reason: string;
  expires: string;
}

const SEVERITIES = new Set<string>(["info", "low", "moderate", "high", "critical"]);
const isRec = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const severityOf = (v: unknown): Severity => (typeof v === "string" && SEVERITIES.has(v) ? (v as Severity) : "low");

function advisoryId(url: unknown, id: unknown): string {
  if (typeof url === "string") {
    const ghsa = /GHSA-[a-z0-9-]+/i.exec(url)?.[0];
    if (ghsa !== undefined) return ghsa;
    return url;
  }
  return String(id ?? "unknown");
}

/** `bun audit --json`: { "<package>": [ { id, url, title, severity, vulnerable_versions } ] }. */
export function parseBunAudit(json: unknown): Advisory[] {
  if (!isRec(json)) return [];
  const out: Advisory[] = [];
  for (const [pkg, list] of Object.entries(json)) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (!isRec(item)) continue;
      out.push({ pkg, severity: severityOf(item.severity), id: advisoryId(item.url, item.id), title: String(item.title ?? "") });
    }
  }
  return out;
}

/** `npm audit --json` (npm 7+): { vulnerabilities: { <package>: { via: [ { source, title, url, severity } | "<package>" ] } } }. */
export function parseNpmAudit(json: unknown): Advisory[] {
  if (!isRec(json) || !isRec(json.vulnerabilities)) return [];
  const out: Advisory[] = [];
  for (const [pkg, vuln] of Object.entries(json.vulnerabilities)) {
    if (!isRec(vuln) || !Array.isArray(vuln.via)) continue;
    for (const via of vuln.via) {
      if (!isRec(via)) continue;
      out.push({ pkg, severity: severityOf(via.severity), id: advisoryId(via.url, via.source), title: String(via.title ?? "") });
    }
  }
  return out;
}

export function auditProblems(
  advisories: Advisory[],
  exceptions: AuditException[],
  nowMs: number,
): { problems: string[]; warnings: string[] } {
  const problems: string[] = [];
  const warnings: string[] = [];
  const used = new Set<string>();
  for (const a of advisories) {
    if (a.severity !== "high" && a.severity !== "critical") continue;
    const exception = exceptions.find((e) => e.id === a.id);
    if (exception === undefined) {
      problems.push(`${a.severity} advisory ${a.id} in ${a.pkg}: ${a.title} (fix the dependency or add a reviewed exception)`);
      continue;
    }
    used.add(exception.id);
    if (Date.parse(`${exception.expires}T23:59:59Z`) < nowMs) {
      problems.push(`exception for ${a.id} (${a.pkg}) expired on ${exception.expires}: ${exception.reason}`);
    }
  }
  for (const e of exceptions) if (!used.has(e.id)) warnings.push(`exception ${e.id} matches no current advisory (remove it)`);
  return { problems, warnings };
}

const NPM_SPECIFIER = /npm:((?:@[a-z0-9~-][a-z0-9._~-]*\/)?[a-z0-9~-][a-z0-9._~-]*)@(\d+\.\d+\.\d+[\w.+-]*)/g;

export function specifiersFromSource(text: string): Array<{ name: string; version: string }> {
  return [...text.matchAll(NPM_SPECIFIER)].map((m) => ({ name: m[1] as string, version: m[2] as string }));
}
```

Run: `bun run test:tools audit` (fails before the file exists, passes after).

- [ ] **Step 21: The audit command, exceptions file, CI, evidence**

`tools/audit-exceptions.json`:

```json
{
  "exceptions": []
}
```

`tools/audit-deps.ts`:

```ts
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Advisory, type AuditException, auditProblems, parseBunAudit, parseNpmAudit, specifiersFromSource } from "./lib/audit.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const advisories: Advisory[] = [];

// 1. production dependencies of the workspace, resolved by bun.lock
const bun = spawnSync("bun", ["audit", "--json", "--prod"], { cwd: root, encoding: "utf8", shell: true });
try {
  advisories.push(...parseBunAudit(JSON.parse(bun.stdout || "{}")));
} catch {
  console.error(`audit: could not read the output of "bun audit" (exit ${bun.status}): ${(bun.stderr || bun.stdout).slice(0, 300)}`);
  process.exit(2);
}

// 2. npm: specifiers of the Edge Functions, resolved exactly as pinned
const functions = join(root, "supabase", "functions");
const specifiers = new Map<string, string>();
for (const file of readdirSync(functions, { recursive: true, encoding: "utf8" })) {
  if (!(file.endsWith(".ts") || file.endsWith("deno.json")) || file.includes("node_modules")) continue;
  for (const s of specifiersFromSource(readFileSync(join(functions, file), "utf8"))) specifiers.set(s.name, s.version);
}
if (specifiers.size > 0) {
  const dir = mkdtempSync(join(tmpdir(), "deno-audit-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "deno-deps", version: "0.0.0", private: true, dependencies: Object.fromEntries(specifiers) }));
  const install = spawnSync("npm", ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: dir, encoding: "utf8", shell: true });
  if (install.status !== 0) {
    console.error(`audit: npm could not resolve the Deno dependencies: ${install.stderr.slice(0, 300)}`);
    process.exit(2);
  }
  const npm = spawnSync("npm", ["audit", "--omit=dev", "--json"], { cwd: dir, encoding: "utf8", shell: true });
  advisories.push(...parseNpmAudit(JSON.parse(npm.stdout || "{}")));
}

const exceptions = (JSON.parse(readFileSync(join(root, "tools", "audit-exceptions.json"), "utf8")) as { exceptions: AuditException[] }).exceptions;
const { problems, warnings } = auditProblems(advisories, exceptions, Date.now());
for (const warning of warnings) console.warn(`audit: ${warning}`);
console.log(`audit: ${advisories.length} advisories (${advisories.filter((a) => a.severity === "high" || a.severity === "critical").length} high or critical), ${specifiers.size} Deno npm packages`);
if (problems.length > 0) {
  for (const problem of problems) console.error(`audit: ${problem}`);
  process.exit(1);
}
console.log("audit: OK");
```

Root script `"audit": "bun run tools/audit-deps.ts"`. Add steps to the `web` job of `.github/workflows/ci.yml` after the bundle scan (re-read the file first; Task 3 may have edited the `pull_request` block): `- run: bun run check:fetch`, `- run: bun run check:secrets`, `- run: bun run audit`. The `audit` step needs network and may fail on a new advisory; that is the intent.

Run `bun run audit`. Expected: `audit: OK` or a list of advisories. For each blocking advisory: update the dependency (`bun update <pkg>`, then rerun the suites) or, when no fix exists or the path is unreachable in production, add an exception with the advisory id, a reason and an expiry date at most 90 days away. Verify the Deno side by hand once: `deno info --config supabase/functions/deno.json supabase/functions/worker-tick/index.ts` lists the npm packages; they must match the audited set. Paste the outputs into section 12 of the review document.

```text
git add tools/lib/audit.ts tools/lib/audit.test.ts tools/audit-deps.ts tools/audit-exceptions.json package.json .github/workflows/ci.yml docs/discovery/security-review.md
git commit -m "feat(security): dependency audit for the workspace and the Edge Function npm specifiers with a reviewed exceptions file"
```

### Part F: keep-alive with freshness and alerts

- [ ] **Step 22: Alert evaluation (TDD)**

`tools/lib/alerts.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { evaluateAlerts } from "./alerts.ts";

const NOW = Date.parse("2026-10-15T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();
const status = (over: { finished?: string | null; published?: string | null; processed?: number; total?: number } = {}) => ({
  last_successful: { finished_at: over.finished === undefined ? hoursAgo(5) : over.finished },
  latest_published: {
    results_published_at: over.published === undefined ? hoursAgo(5) : over.published,
    coverage: { candidates: { total: over.total ?? 40, processed: over.processed ?? 40 } },
  },
});

describe("evaluateAlerts", () => {
  it("is quiet for a fresh, complete scan", () => {
    expect(evaluateAlerts({ status: status(), health: { ok: true, db: { size_mb: 120 } }, nowMs: NOW })).toEqual([]);
  });
  it("flags a scan older than 36 hours and a missing record", () => {
    expect(evaluateAlerts({ status: status({ finished: hoursAgo(40) }), health: null, nowMs: NOW })[0]).toMatch(/40\.0 h ago/);
    expect(evaluateAlerts({ status: status({ finished: null }), health: null, nowMs: NOW })).toContain("no successful scan on record");
  });
  it("flags a stale published result and low coverage", () => {
    const p = evaluateAlerts({ status: status({ published: hoursAgo(50), processed: 30, total: 40 }), health: null, nowMs: NOW });
    expect(p.join("\n")).toMatch(/published result is 50\.0 h old/);
    expect(p.join("\n")).toMatch(/coverage 75\.0%/);
  });
  it("flags health failures and a database above 400 MB", () => {
    const p = evaluateAlerts({ status: status(), health: { ok: false, db: { size_mb: 401 } }, nowMs: NOW });
    expect(p).toEqual(["health reports ok=false", "database size 401 MB exceeds 400 MB"]);
  });
  it("lets the limit be lowered to force a deliberate failure", () => {
    expect(evaluateAlerts({ status: status(), health: null, nowMs: NOW, maxAgeHours: 0 }).length).toBe(2);
  });
});
```

`tools/lib/alerts.ts`:

```ts
export const DEFAULT_MAX_AGE_HOURS = 36;
export const DB_SIZE_ALERT_MB = 400;
export const MIN_COVERAGE = 0.9;

const isRec = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const pick = (v: unknown, ...path: string[]): unknown =>
  path.reduce<unknown>((acc, key) => (isRec(acc) ? acc[key] : undefined), v);
const hoursSince = (iso: unknown, nowMs: number): number | null => {
  if (typeof iso !== "string") return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : (nowMs - t) / 3_600_000;
};

export interface AlertInput {
  status: unknown;
  health: unknown;
  nowMs: number;
  maxAgeHours?: number;
}

/**
 * Spec 16.4 and 16.5 conditions that `scan_status` and `health` can evaluate: scan age, published age, coverage below 90%,
 * database above 400 MB, health not ok. Conditions that need fields `health` does not expose (breaker open for 1 h, deferred
 * research, email cap, failed deliveries) are manual checks in the operator guide.
 */
export function evaluateAlerts(i: AlertInput): string[] {
  const max = i.maxAgeHours ?? DEFAULT_MAX_AGE_HOURS;
  const out: string[] = [];
  const finished = hoursSince(pick(i.status, "last_successful", "finished_at"), i.nowMs);
  if (finished === null) out.push("no successful scan on record");
  else if (finished > max) out.push(`last successful scan finished ${finished.toFixed(1)} h ago (limit ${max} h)`);
  const published = hoursSince(pick(i.status, "latest_published", "results_published_at"), i.nowMs);
  if (published === null) out.push("no published scan result on record");
  else if (published > max) out.push(`latest published result is ${published.toFixed(1)} h old (limit ${max} h)`);
  const total = pick(i.status, "latest_published", "coverage", "candidates", "total");
  const processed = pick(i.status, "latest_published", "coverage", "candidates", "processed");
  if (typeof total === "number" && total > 0 && typeof processed === "number" && processed / total < MIN_COVERAGE) {
    out.push(`coverage ${((100 * processed) / total).toFixed(1)}% of candidates is below ${MIN_COVERAGE * 100}%`);
  }
  if (pick(i.health, "ok") === false) out.push("health reports ok=false");
  const size = pick(i.health, "db", "size_mb");
  if (typeof size === "number" && size > DB_SIZE_ALERT_MB) out.push(`database size ${size} MB exceeds ${DB_SIZE_ALERT_MB} MB`);
  return out;
}
```

Run `bun run test:tools alerts` (fail, then pass).

- [ ] **Step 23: The keep-alive tool and workflow**

`tools/keepalive.ts`:

```ts
import { DEFAULT_MAX_AGE_HOURS, evaluateAlerts } from "./lib/alerts.ts";

function need(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    console.error(`::error::keepalive: ${name} is not set`);
    process.exit(1);
  }
  return value.trim();
}
const fail = (message: string): never => {
  console.error(`::error::${message}`);
  process.exit(1);
};

const url = need("SUPABASE_URL").replace(/\/$/, "");
const anon = need("ANON_KEY");
const email = need("KEEPALIVE_EMAIL");
const password = need("KEEPALIVE_PASSWORD");
const parsedMax = Number(process.env.KEEPALIVE_MAX_AGE_HOURS ?? "");
const maxAgeHours = Number.isFinite(parsedMax) && parsedMax >= 0 && process.env.KEEPALIVE_MAX_AGE_HOURS ? parsedMax : DEFAULT_MAX_AGE_HOURS;
const timeout = () => AbortSignal.timeout(20_000);

// 1. authenticated database activity as the dedicated low-privilege user (spec 16.4)
const tokenRes = await fetch(`${url}/auth/v1/token?grant_type=password`, {
  method: "POST",
  headers: { apikey: anon, "content-type": "application/json" },
  body: JSON.stringify({ email, password }),
  signal: timeout(),
});
if (!tokenRes.ok) fail(`token request failed with HTTP ${tokenRes.status}`);
const accessToken = ((await tokenRes.json()) as { access_token?: string }).access_token;
if (!accessToken) fail("token response contained no access_token");
console.log(`::add-mask::${accessToken}`);
const read = await fetch(`${url}/rest/v1/app_settings?select=key&limit=1`, {
  headers: { apikey: anon, authorization: `Bearer ${accessToken}` },
  signal: timeout(),
});
if (!read.ok) fail(`authenticated REST read failed with HTTP ${read.status}`);

// 2. public freshness data and the health function
const publicHeaders = { apikey: anon, authorization: `Bearer ${anon}` };
const statusRes = await fetch(`${url}/rest/v1/rpc/scan_status`, {
  method: "POST",
  headers: { ...publicHeaders, "content-type": "application/json" },
  body: "{}",
  signal: timeout(),
});
if (!statusRes.ok) fail(`scan_status failed with HTTP ${statusRes.status}`);
const status: unknown = await statusRes.json();
const healthRes = await fetch(`${url}/functions/v1/health`, { headers: publicHeaders, signal: timeout() });
const health: unknown = healthRes.ok ? await healthRes.json() : null;

const problems = evaluateAlerts({ status, health, nowMs: Date.now(), maxAgeHours });
if (!healthRes.ok) problems.push(`health function answered HTTP ${healthRes.status}`);
if (problems.length > 0) {
  for (const problem of problems) console.error(`::error::${problem}`);
  process.exit(1);
}
console.log(`keep-alive OK: authenticated read HTTP 200, freshness within ${maxAgeHours} h, health ok`);
```

Rewrite `.github/workflows/keepalive.yml` (same schedule and gate; the job now checks out the repository so it can run the tool):

```yaml
name: Keep-alive

on:
  schedule:
    - cron: "17 6 * * *"
  workflow_dispatch:

permissions:
  contents: read

jobs:
  keepalive:
    # Off until the app_settings table exists: set repository variable KEEPALIVE_ENABLED=true.
    if: ${{ vars.KEEPALIVE_ENABLED == 'true' }}
    runs-on: ubuntu-latest
    timeout-minutes: 5
    env:
      SUPABASE_URL: ${{ vars.KEEPALIVE_SUPABASE_URL }}
      ANON_KEY: ${{ vars.KEEPALIVE_ANON_KEY }}
      KEEPALIVE_EMAIL: ${{ secrets.KEEPALIVE_EMAIL }}
      KEEPALIVE_PASSWORD: ${{ secrets.KEEPALIVE_PASSWORD }}
      # optional: set to 0 for a deliberate failure drill (operator guide, section "Production cut-over and drills")
      KEEPALIVE_MAX_AGE_HOURS: ${{ vars.KEEPALIVE_MAX_AGE_HOURS }}
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: 1.3.14
      - run: bun run tools/keepalive.ts
```

Add root script `"keepalive": "bun run tools/keepalive.ts"`. Run `bun run lint:workflows` (expected `workflows: OK`).

- [ ] **Step 24: Prove the tool locally and commit**

With the stack running and the fixture scan done (Task 4's setup, or `bun run scan:local -- start --mode fixture` then `tick`):

```powershell
$s = bunx supabase status -o json | ConvertFrom-Json
$env:SUPABASE_URL = $s.API_URL
$env:ANON_KEY = $s.ANON_KEY
$env:KEEPALIVE_EMAIL = "e2e-owner@example.test"
$env:KEEPALIVE_PASSWORD = "E2e-Passw0rd-9x"
bun run keepalive
$env:KEEPALIVE_MAX_AGE_HOURS = "0"
bun run keepalive
```

Expected: the first run prints `keep-alive OK: ...` (it needs the e2e owner user from Task 4's setup or any confirmed local user; create one in the local Studio otherwise); the second run prints two `::error::` lines (scan age and published age) and exits 1: this is the deliberate failure proof for the local environment. Paste both outputs into the review document (section 10) and record, in `p7-results.md` later, that the GitHub-side drill is owner-run.

```text
git add tools/lib/alerts.ts tools/lib/alerts.test.ts tools/keepalive.ts .github/workflows/keepalive.yml package.json
git commit -m "feat(ops): keep-alive evaluates scan freshness, coverage and database size, with a deliberate-failure switch"
```

### Part G: finish the review document

- [ ] **Step 25: Final review document (run after Task 2 has merged)**

1. RLS evidence. With the stack running and migrations applied, run the inventory query (PowerShell here-string piped into the database container; the container name is `supabase_db_` plus the `project_id` of `config.toml`):

```powershell
@'
select c.relname as table_name,
       c.relrowsecurity as rls,
       has_table_privilege('anon', c.oid, 'select') as anon_select,
       has_any_column_privilege('anon', c.oid, 'select') as anon_any_col,
       has_table_privilege('authenticated', c.oid, 'select') as auth_select,
       has_any_column_privilege('authenticated', c.oid, 'insert,update') as auth_write,
       (select count(*) from pg_policy p where p.polrelid = c.oid) as policies
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relkind in ('r','p')
 order by 1;
'@ | docker exec -i supabase_db_stock-screener psql -U postgres -d postgres -P pager=off
```

   Paste the table into section 2 together with the tail of `bunx supabase test db` for `0900_rls_matrix.test.sql`.
2. Run and paste: `bun run check:secrets` (section 3; after Task 5 it must print OK), the `git grep` outputs of step 1 (sections 1, 5, 9, 11), `bunx vitest run --project web sw-routes` (section 7), `bun run check:headers` and `bun run test:e2e` CSP lines (section 6), `bun run check:fetch` (section 8), the probe output (section 10), `bun run audit` and the `deno info` listing (section 12). The hosted comparison `bunx supabase secrets list --project-ref <ref>` is owner-run: write "not run: no hosted project; the operator compares names with `bun run check:secrets` output" if there is none.
3. Set the `Status` of every row S-01 to S-19 to `fixed (<short sha>)`, `accepted` or `deferred (reason)`; no row may stay `open`.
4. Add the closing section "Residual risks" listing S-13, S-14, S-16 and the Yahoo ToS position (D1, Q-03) with one sentence each.

```text
git add docs/discovery/security-review.md
git commit -m "docs(security): finish the P7 security review with command evidence and final statuses"
```

---

## Task 2: Cross-user RLS matrix test

**Concurrency:** parallel with Tasks 1 and 3 (it owns only the new test file and one migration). It needs the migrations of P1 to P6 (all tables exist).

**Files:**
- Create: `supabase/tests/0900_rls_matrix.test.sql`
- Create: `supabase/migrations/20261015007000_p7_function_grants.sql`

**Interfaces:**
- Consumes: every table, view and public function created by the migrations of P1 to P6; spec 6.9 (reference matrix); two users, one admin and anon.
- Produces: a pgTAP file that (a) enumerates `pg_tables`, `pg_views` and `pg_proc` of schema `public` against a declarative matrix in both directions, (b) asserts RLS is enabled everywhere, (c) asserts every `anon` and `authenticated` privilege (select, insert, update, delete; table-level or column-level) against the matrix, (d) proves with seeded rows that user A cannot read, insert as, update or delete user B's rows and that anon sees nothing, (e) proves hidden rows (premium episodes, holder-only reports, admin-only tables) are invisible to anon and to a non-holder, non-admin user and visible to an admin where declared, (f) asserts the `EXECUTE` privilege of every public function. The plan count is computed from the matrix.

Reference rules for the matrix (apply when a row disagrees with a migration): spec 6.9 and the phase plans decide; if the migration is wrong, fix it with a new corrective migration (never edit an old migration); if the spec is stale, keep the migration, write the row as the migration has it and add `-- deviation: <plan id>` plus a line in `security-review.md`. Known deviations at planning time: `ibkr_catalogue` and `eur_equivalents` are public (P6: contract data), `audit_events` has column-level select for admins (P5a), `ai_quota_usage` has no admin read policy.

- [ ] **Step 1: Read the real table list and the real grants**

With the stack running (`bun run supabase:start`, `bunx supabase db reset`):

```powershell
@'
select c.relname,
       has_table_privilege('anon', c.oid, 'select') as anon_sel, has_any_column_privilege('anon', c.oid, 'select') as anon_any,
       has_table_privilege('authenticated', c.oid, 'select') as auth_sel, has_any_column_privilege('authenticated', c.oid, 'select') as auth_any,
       has_table_privilege('authenticated', c.oid, 'insert') as auth_ins, has_any_column_privilege('authenticated', c.oid, 'insert') as auth_ins_any,
       has_table_privilege('authenticated', c.oid, 'update') as auth_upd, has_any_column_privilege('authenticated', c.oid, 'update') as auth_upd_any,
       has_table_privilege('authenticated', c.oid, 'delete') as auth_del
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relkind in ('r','p') order by 1;
select viewname from pg_views where schemaname = 'public' order by 1;
select p.oid::regprocedure::text, has_function_privilege('anon', p.oid, 'execute') as anon_exec, has_function_privilege('authenticated', p.oid, 'execute') as auth_exec
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.prorettype <> 'trigger'::regtype
   and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e') order by 1;
'@ | docker exec -i supabase_db_stock-screener psql -U postgres -d postgres -P pager=off
```

Keep the output: it is the baseline for the matrix rows below (the matrix in Step 3 was written from spec 6.9 and the phase plans; any table, view or function in this output that the matrix lacks must be added in Step 4).

- [ ] **Step 2: Write the migration (the function-grant fix, finding S-07)**

`supabase/migrations/20261015007000_p7_function_grants.sql`:

```sql
-- P7: public.is_admin() must not be callable by anon. `revoke ... from public` does not remove the grant that
-- Supabase's default privileges give to anon and authenticated directly. RLS policies that use it are `to authenticated`.
revoke execute on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated;
```

If P6's last migration sorts after this timestamp (`ls supabase/migrations`), rename the file (and Task 1's `20261015007100_providers_setting.sql`) so that both sort after every phase migration, keeping their relative order.

- [ ] **Step 3: Write `supabase/tests/0900_rls_matrix.test.sql`**

```sql
-- Cross-user access matrix (spec 15.3 and 17.2). The matrix below is the single declaration of who may do what.
-- When a migration adds a table, view or public function this file fails until the new object has an entry.
--   matrix.anon / matrix.auth : four characters = select, insert, update, delete.
--                               Y = table-level privilege, C = column-level privilege only, N = none.
--   owner_col                 : column holding auth.uid() on per-user tables (cross-user probes run for these).
--   hidden_where              : rows that anon and a signed-in non-holder, non-admin user must NOT see.
--   admin_reads               : rows of hidden_where are readable by an admin.
--   seed_override             : column values the generic seeder must use (check constraints, enum values).
--   skip_behaviour            : reason when the generic seed cannot satisfy a table (at most 5 rows may skip).
begin;
create extension if not exists pgtap with schema extensions;
set local session_replication_role = replica; -- seeds skip foreign keys and triggers

create temp table actors on commit drop as
  select '00000000-0000-0000-0000-00000000cc01'::uuid as a,
         '00000000-0000-0000-0000-00000000cc02'::uuid as b,
         '00000000-0000-0000-0000-00000000cc03'::uuid as c;

create temp table matrix (
  tbl text primary key,
  anon text not null check (anon ~ '^[YCN]{4}$'),
  auth text not null check (auth ~ '^[YCN]{4}$'),
  owner_col text,
  hidden_where text,
  admin_reads boolean not null default false,
  seed_override jsonb not null default '{}'::jsonb,
  skip_behaviour text
) on commit drop;

insert into matrix (tbl, anon, auth, owner_col, hidden_where, admin_reads, seed_override) values
  -- public reference and result tables
  ('exchanges',                   'YNNN', 'YNNN', null, null, false, '{}'),
  ('fx_rates',                    'YNNN', 'YNNN', null, null, false, '{}'),
  ('companies',                   'YNNN', 'YNNN', null, null, false, '{}'),
  ('securities',                  'YNNN', 'YNNN', null, null, false, '{}'),
  ('eur_equivalents',             'YNNN', 'YNNN', null, null, false, '{}'),
  ('ibkr_catalogue',              'YNNN', 'YNNN', null, null, false, '{}'), -- deviation: P6 (public IBKR contract data, spec 6.9 had no access)
  ('universe_snapshots',          'YNNN', 'YNNN', null, null, false, '{}'),
  ('universe_membership_events',  'YNNN', 'YNNN', null, null, false, '{}'),
  ('todays_discounts',            'YNNN', 'YNNN', null, null, false, '{}'),
  ('price_series',                'CNNN', 'CNNN', null, null, false, '{}'), -- arrays only through get_price_series (A-41)
  ('scan_runs',                   'CNNN', 'CNNN', null, null, false, '{}'), -- settings_snapshot, errors_summary, code_version hidden by column grants
  ('scan_security_results',       'CNNN', 'CNNN', null, $$scope <> 'universe'$$, false, '{"scope":"holding_only"}'),
  ('signal_episodes',             'YNNN', 'YNNN', null, $$kind <> 'discount'$$, false, '{"kind":"premium1","threshold_line":"+1","mode":"worldwide"}'),
  ('research_reports',            'YNNN', 'YNNN', null, $$visibility <> 'public'$$, false, '{"visibility":"holders"}'),
  ('research_sources',            'YNNN', 'YNNN', null, 'true', false, '{}'),
  ('app_settings',                'YNNN', 'YNNN', null, 'not is_public', false, '{"is_public":false,"key":"p7_matrix_hidden"}'),
  -- service role only (no policy, no grant)
  ('security_identity_overrides', 'NNNN', 'NNNN', null, null, false, '{}'),
  ('market_cap_snapshots',        'NNNN', 'NNNN', null, null, false, '{}'),
  ('quote_cache',                 'NNNN', 'NNNN', null, null, false, '{}'),
  ('email_events',                'NNNN', 'NNNN', null, null, false, '{}'),
  ('research_work_texts',         'NNNN', 'NNNN', null, null, false, '{}'),
  ('eur_equivalent_overrides',    'NNNN', 'NNNN', null, null, false, '{}'),
  ('ai_quota_usage',              'NNNN', 'NNNN', null, null, false, '{}'), -- deviation: spec 6.9 lists an optional admin read; quota is read by SQL
  -- admin-only reads
  ('scan_jobs',                   'NNNN', 'YNNN', null, 'true', true, '{}'),
  ('scan_events',                 'NNNN', 'YNNN', null, 'true', true, '{}'),
  ('audit_events',                'NNNN', 'CNNN', null, 'true', true, '{}'), -- deviation: P5a column-level select
  -- holder-only reads
  ('risk_monitor_state',          'NNNN', 'YNNN', null, 'true', false, '{}'),
  ('risk_findings',               'NNNN', 'YNNN', null, 'true', false, '{}'),
  -- per-user tables
  ('profiles',                    'NNNN', 'CNCN', 'user_id', null, false, '{}'),
  ('notification_preferences',    'NNNN', 'YCCN', 'user_id', null, false, '{}'),
  ('push_subscriptions',          'NNNN', 'CNNN', 'user_id', null, false, '{}'),
  ('digests',                     'NNNN', 'YNNN', 'user_id', null, false, '{}'),
  ('digest_items',                'NNNN', 'YNNN', 'user_id', null, false, '{}'),
  ('digest_deliveries',           'NNNN', 'CNNN', 'user_id', null, false, '{}'),
  ('broker_connections',          'NNNN', 'CNNN', 'user_id', null, false, '{}'),
  ('broker_sync_runs',            'NNNN', 'CNNN', 'user_id', null, false, '{}'),
  ('broker_positions',            'NNNN', 'YNNN', 'user_id', null, false, '{}'),
  ('broker_trades',               'NNNN', 'YNNN', 'user_id', null, false, '{}'),
  ('broker_closed_lots',          'NNNN', 'YNNN', 'user_id', null, false, '{}'),
  ('broker_cash_transactions',    'NNNN', 'YNNN', 'user_id', null, false, '{}'),
  ('broker_corporate_actions',    'NNNN', 'YNNN', 'user_id', null, false, '{}'),
  ('broker_fx_rates',             'NNNN', 'YNNN', 'user_id', null, false, '{}'),
  ('broker_nav',                  'NNNN', 'YNNN', 'user_id', null, false, '{}');

create temp table view_matrix (vw text primary key, anon boolean not null, auth boolean not null) on commit drop;
insert into view_matrix values ('v_todays_discounts', true, true), ('v_card_research', true, true);

create temp table fn_allow (proname text primary key, anon boolean not null, auth boolean not null) on commit drop;
insert into fn_allow values
  ('company_list', true, true), ('universe_summary', true, true), ('scan_status', true, true),
  ('get_price_series', true, true), ('todays_discounts_feed', true, true),
  ('is_admin', false, true), ('record_audit', false, true);

-- ---------------------------------------------------------------- helpers (all run as the caller of the test, then switch role inside)
create function pg_temp.set_caller(p_role text, p_uid uuid) returns void language plpgsql as $f$
begin
  execute format('set local role %I', p_role);
  perform set_config('request.jwt.claims',
    case when p_uid is null then json_build_object('role', p_role)::text
         else json_build_object('sub', p_uid, 'role', p_role)::text end, true);
end $f$;

create function pg_temp.priv_code(p_role text, p_tbl text, p_op text) returns text language sql stable as $f$
  select case
    when has_table_privilege(p_role, format('public.%I', p_tbl), upper(p_op)) then 'Y'
    when p_op <> 'delete' and has_any_column_privilege(p_role, format('public.%I', p_tbl), upper(p_op)) then 'C'
    else 'N' end
$f$;

-- One row document per table from the NOT NULL columns without default; p_role keeps only columns that role may insert.
create function pg_temp.build_doc(p_tbl text, p_owner uuid, p_extra jsonb default '{}'::jsonb, p_role text default null)
returns jsonb language plpgsql as $f$
declare
  a record; v_val jsonb; v_doc jsonb := '{}'::jsonb; v_over jsonb; v_owner_col text;
begin
  select seed_override, owner_col into v_over, v_owner_col from matrix where tbl = p_tbl;
  for a in
    select att.attname, att.atttypid, t.typtype, t.typcategory, t.typname
      from pg_attribute att join pg_type t on t.oid = att.atttypid
     where att.attrelid = format('public.%I', p_tbl)::regclass and att.attnum > 0 and not att.attisdropped
       and att.attnotnull and not att.atthasdef and att.attidentity = '' and att.attgenerated = ''
  loop
    v_val := case
      when a.typtype = 'e' then to_jsonb((select enumlabel from pg_enum where enumtypid = a.atttypid order by enumsortorder limit 1))
      when a.typname = 'uuid' then to_jsonb(gen_random_uuid()::text)
      when a.typcategory = 'A' then '[]'::jsonb
      when a.typname in ('jsonb', 'json') then '{}'::jsonb
      when a.typname = 'interval' then to_jsonb('1 day'::text)
      when a.typcategory = 'I' then to_jsonb('10.0.0.1'::text)
      when a.typcategory = 'N' then to_jsonb(1)
      when a.typname = 'bool' then to_jsonb(false)
      when a.typname = 'date' then to_jsonb('2026-10-15'::text)
      when a.typcategory = 'D' then to_jsonb(now()::text)
      when a.typname = 'bytea' then to_jsonb('\x00'::text)
      else to_jsonb('x' || substr(md5(random()::text), 1, 8))
    end;
    v_doc := v_doc || jsonb_build_object(a.attname, v_val);
  end loop;
  v_doc := v_doc || coalesce(v_over, '{}'::jsonb) || coalesce(p_extra, '{}'::jsonb);
  if v_owner_col is not null and p_owner is not null then
    v_doc := v_doc || jsonb_build_object(v_owner_col, p_owner::text);
  end if;
  if p_role is not null then
    select coalesce(jsonb_object_agg(k, v_doc -> k), '{}'::jsonb) into v_doc
      from jsonb_object_keys(v_doc) k
     where has_column_privilege(p_role, format('public.%I', p_tbl), k, 'INSERT');
  end if;
  return v_doc;
end $f$;

create function pg_temp.seed_row(p_tbl text, p_owner uuid, p_extra jsonb default '{}'::jsonb) returns void language plpgsql as $f$
declare v_doc jsonb := pg_temp.build_doc(p_tbl, p_owner, p_extra); v_cols text;
begin
  select string_agg(format('%I', k), ', ') into v_cols from jsonb_object_keys(v_doc) k;
  execute format('insert into public.%I (%s) select %s from jsonb_populate_record(null::public.%I, $1)', p_tbl, v_cols, v_cols, p_tbl) using v_doc;
exception when others then
  raise exception 'seed failed for %: % (add a seed_override entry for this table in the matrix)', p_tbl, sqlerrm;
end $f$;

create function pg_temp.scalar_as(p_role text, p_uid uuid, p_sql text) returns text language plpgsql as $f$
declare v text;
begin
  perform pg_temp.set_caller(p_role, p_uid);
  execute p_sql into v;
  reset role;
  return v;
exception
  when insufficient_privilege then reset role; return 'denied';
  when others then reset role; return 'error:' || sqlstate;
end $f$;

create function pg_temp.dml_as(p_role text, p_uid uuid, p_sql text) returns text language plpgsql as $f$
declare n bigint;
begin
  perform pg_temp.set_caller(p_role, p_uid);
  execute p_sql;
  get diagnostics n = row_count;
  reset role;
  return 'rows:' || n;
exception
  when insufficient_privilege then reset role; return 'denied';
  when others then reset role; return 'passed:' || sqlstate;
end $f$;

-- 'denied' when privileges or a row policy refuse the insert; anything else (inserted, constraint error) passed access control.
create function pg_temp.insert_probe(p_tbl text, p_role text, p_uid uuid, p_owner uuid) returns text language plpgsql as $f$
declare v_doc jsonb := pg_temp.build_doc(p_tbl, p_owner, '{}'::jsonb, p_role); v_cols text;
begin
  if v_doc = '{}'::jsonb then return 'denied'; end if;
  select string_agg(format('%I', k), ', ') into v_cols from jsonb_object_keys(v_doc) k;
  begin
    perform pg_temp.set_caller(p_role, p_uid);
    execute format('insert into public.%I (%s) select %s from jsonb_populate_record(null::public.%I, $1)', p_tbl, v_cols, v_cols, p_tbl) using v_doc;
    reset role;
    raise exception using errcode = 'P0001', message = 'probe_inserted'; -- undo the row
  exception
    when insufficient_privilege then reset role; return 'denied';
    when sqlstate 'P0001' then reset role; return 'inserted';
    when others then reset role; return 'passed:' || sqlstate;
  end;
end $f$;

create function pg_temp.expected_of(p_kind text, p_tbl text) returns text language plpgsql as $f$
declare m record; v text;
begin
  select * into m from matrix where tbl = p_tbl;
  if p_kind like 'priv.%' then
    return substr(case split_part(p_kind, '.', 2) when 'anon' then m.anon else m.auth end,
                  array_position(array['select','insert','update','delete'], split_part(p_kind, '.', 3)), 1);
  end if;
  case p_kind
    when 'own_count' then return case when substr(m.auth, 1, 1) = 'N' then 'denied' else '1' end;
    when 'anon_count' then return case when substr(m.anon, 1, 1) = 'N' then 'denied' else '0' end;
    when 'cross_insert' then return 'denied';
    when 'cross_update' then return 'blocked';
    when 'cross_delete' then return 'blocked';
    when 'own_insert' then return 'allowed';
    when 'own_update' then return 'rows:1';
    when 'own_delete' then return 'rows:1';
    when 'hidden_anon' then
      if substr(m.anon, 1, 1) = 'N' then return 'denied'; end if;
      execute format('select count(*)::text from public.%I where not (%s)', p_tbl, m.hidden_where) into v;
      return v;
    when 'hidden_auth' then
      if substr(m.auth, 1, 1) = 'N' then return 'denied'; end if;
      execute format('select count(*)::text from public.%I where not (%s)', p_tbl, m.hidden_where) into v;
      return v;
    when 'admin_count' then
      execute format('select count(*)::text from public.%I', p_tbl) into v;
      return v;
    else raise exception 'unknown check kind %', p_kind;
  end case;
end $f$;

create function pg_temp.actual_of(p_kind text, p_tbl text) returns text language plpgsql as $f$
declare
  v_a uuid := (select a from actors); v_b uuid := (select b from actors); v_c uuid := (select c from actors);
  v_own text; v_res text; v_count text := format('select count(*)::text from public.%I', p_tbl);
begin
  select owner_col into v_own from matrix where tbl = p_tbl;
  if p_kind like 'priv.%' then
    return pg_temp.priv_code(split_part(p_kind, '.', 2), p_tbl, split_part(p_kind, '.', 3));
  end if;
  case p_kind
    when 'own_count' then return pg_temp.scalar_as('authenticated', v_a, v_count);
    when 'anon_count' then return pg_temp.scalar_as('anon', null, v_count);
    when 'hidden_anon' then return pg_temp.scalar_as('anon', null, v_count);
    when 'hidden_auth' then return pg_temp.scalar_as('authenticated', v_a, v_count);
    when 'admin_count' then return pg_temp.scalar_as('authenticated', v_c, v_count);
    when 'cross_insert' then
      v_res := pg_temp.insert_probe(p_tbl, 'authenticated', v_a, v_b);
      return case when v_res = 'denied' then 'denied' else 'allowed' end;
    when 'own_insert' then
      v_res := pg_temp.insert_probe(p_tbl, 'authenticated', v_a, v_a);
      return case when v_res = 'denied' then 'denied' else 'allowed' end;
    when 'cross_update' then
      v_res := pg_temp.dml_as('authenticated', v_a, format('update public.%I set %I = %I where %I = %L', p_tbl, v_own, v_own, v_own, v_b));
      return case when v_res in ('denied', 'rows:0') then 'blocked' else 'LEAK ' || v_res end;
    when 'cross_delete' then
      v_res := pg_temp.dml_as('authenticated', v_a, format('delete from public.%I where %I = %L', p_tbl, v_own, v_b));
      return case when v_res in ('denied', 'rows:0') then 'blocked' else 'LEAK ' || v_res end;
    when 'own_update' then
      return pg_temp.dml_as('authenticated', v_a, format('update public.%I set %I = %I where %I = %L', p_tbl, v_own, v_own, v_own, v_a));
    when 'own_delete' then
      return pg_temp.dml_as('authenticated', v_a, format('delete from public.%I where %I = %L', p_tbl, v_own, v_a));
    else raise exception 'unknown check kind %', p_kind;
  end case;
end $f$;

-- ---------------------------------------------------------------- seeds (two users, one admin; one hidden row per hidden table)
do $seed$
declare m record; v_a uuid := (select a from actors); v_b uuid := (select b from actors); v_c uuid := (select c from actors);
begin
  insert into auth.users (id, email) values (v_a, 'matrix-a@example.test'), (v_b, 'matrix-b@example.test'), (v_c, 'matrix-admin@example.test');
  for m in select * from matrix where skip_behaviour is null order by tbl loop
    if m.owner_col is not null then
      perform pg_temp.seed_row(m.tbl, v_a);
      perform pg_temp.seed_row(m.tbl, v_b);
    elsif m.hidden_where is not null then
      perform pg_temp.seed_row(m.tbl, null);
    end if;
  end loop;
  perform pg_temp.seed_row('profiles', v_c, '{"is_admin": true}'::jsonb);
end $seed$;

-- ---------------------------------------------------------------- check descriptors (no execution: the plan count comes from these)
create temp view checks as
select row_number() over (order by grp, tbl, kind) as ord, kind, tbl, descr
  from (
    select 1 as grp, 'priv.' || r.role || '.' || o.op as kind, m.tbl,
           format('%s: %s may %s as declared', m.tbl, r.role, o.op) as descr
      from matrix m cross join (values ('anon'), ('authenticated')) r(role)
           cross join (values ('select'), ('insert'), ('update'), ('delete')) o(op)
    union all
    select 2, k.kind, m.tbl, format('%s: %s', m.tbl, k.kind)
      from matrix m cross join (values ('own_count'), ('anon_count'), ('cross_insert'), ('cross_update'), ('cross_delete')) k(kind)
     where m.owner_col is not null and m.skip_behaviour is null
    union all
    select 2, 'own_insert', m.tbl, format('%s: own_insert', m.tbl)
      from matrix m where m.owner_col is not null and m.skip_behaviour is null and substr(m.auth, 2, 1) = 'Y'
    union all
    select 2, 'own_update', m.tbl, format('%s: own_update', m.tbl)
      from matrix m where m.owner_col is not null and m.skip_behaviour is null and substr(m.auth, 3, 1) = 'Y'
    union all
    select 2, k.kind, m.tbl, format('%s: %s', m.tbl, k.kind)
      from matrix m cross join (values ('hidden_anon'), ('hidden_auth')) k(kind)
     where m.hidden_where is not null and m.skip_behaviour is null
    union all
    select 2, 'admin_count', m.tbl, format('%s: an admin reads the admin-only rows', m.tbl)
      from matrix m where m.admin_reads and m.skip_behaviour is null and substr(m.auth, 1, 1) <> 'N'
    union all
    select 3, 'own_delete', m.tbl, format('%s: own_delete', m.tbl) -- destructive: runs last
      from matrix m where m.owner_col is not null and m.skip_behaviour is null and substr(m.auth, 4, 1) = 'Y'
  ) all_checks;

create temp view public_functions as
select p.oid, p.proname, p.oid::regprocedure::text as sig
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.prorettype <> 'trigger'::regtype
   and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e');

create temp view fn_checks as
select f.sig, r.role,
       case r.role when 'anon' then coalesce(a.anon, false) else coalesce(a.auth, false) end as expected,
       has_function_privilege(r.role, f.oid, 'execute') as actual
  from public_functions f cross join (values ('anon'), ('authenticated')) r(role)
       left join fn_allow a on a.proname = f.proname;

create temp view view_checks as
select m.vw, r.role as what, case r.role when 'anon' then m.anon else m.auth end as expected,
       has_table_privilege(r.role, format('public.%I', m.vw), 'select') as actual
  from view_matrix m cross join (values ('anon'), ('authenticated')) r(role)
union all
select m.vw, 'security_invoker', true,
       coalesce((select 'security_invoker=true' = any (c.reloptions) from pg_class c where c.oid = format('public.%I', m.vw)::regclass), false)
  from view_matrix m;

select plan((select count(*)::int from checks) + (select count(*)::int from fn_checks) + (select count(*)::int from view_checks) + 10);

-- ---------------------------------------------------------------- coverage and structure (10 assertions)
select is((select coalesce(string_agg(t.tablename, ', ' order by t.tablename), '') from pg_tables t
            where t.schemaname = 'public' and t.tablename not in (select tbl from matrix)),
          '', 'every public table has a matrix entry');
select is((select coalesce(string_agg(m.tbl, ', ' order by m.tbl), '') from matrix m where to_regclass(format('public.%I', m.tbl)) is null),
          '', 'every matrix entry names an existing table');
select is((select coalesce(string_agg(c.relname, ', ' order by c.relname), '') from pg_class c join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity),
          '', 'row level security is enabled on every public table');
select is((select coalesce(string_agg(v.viewname, ', ' order by v.viewname), '') from pg_views v
            where v.schemaname = 'public' and v.viewname not in (select vw from view_matrix)),
          '', 'every public view has a view matrix entry');
select is((select coalesce(string_agg(m.vw, ', ' order by m.vw), '') from view_matrix m where to_regclass(format('public.%I', m.vw)) is null),
          '', 'every view matrix entry names an existing view');
select ok(not has_schema_privilege('anon', 'app', 'usage') and not has_schema_privilege('authenticated', 'app', 'usage')
          and not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                           where n.nspname = 'app' and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'))),
          'schema app is closed to anon and authenticated (usage and every function)');
select ok((select count(*) from matrix where skip_behaviour is not null) <= 5, 'at most five tables skip the behavioural probes');
select is((select coalesce(string_agg(a.proname, ', ' order by a.proname), '') from fn_allow a where a.proname not in (select proname from public_functions)),
          '', 'every function allow-list entry names an existing public function');
select is((select coalesce(string_agg(p.tablename || '.' || p.policyname, ', ' order by p.tablename, p.policyname), '')
             from pg_policies p join matrix m on m.tbl = p.tablename
            where p.schemaname = 'public' and m.owner_col is not null and ('anon' = any (p.roles) or 'public' = any (p.roles))),
          '', 'no policy of a per-user table applies to anon or PUBLIC');
select is((select coalesce(string_agg(p.tablename || '.' || p.policyname, ', ' order by p.tablename, p.policyname), '')
             from pg_policies p join matrix m on m.tbl = p.tablename
            where p.schemaname = 'public' and m.owner_col is not null
              and (coalesce(p.qual, '') || ' ' || coalesce(p.with_check, '')) not like '%auth.uid()%'),
          '', 'every policy of a per-user table is bound to auth.uid()');

-- ---------------------------------------------------------------- the matrix, row by row
select is(pg_temp.actual_of(c.kind, c.tbl), pg_temp.expected_of(c.kind, c.tbl), c.descr)
  from (select * from checks order by ord offset 0) c;

select is(f.actual, f.expected, format('%s: %s may execute', f.sig, f.role))
  from (select * from fn_checks order by sig, role offset 0) f;

select is(v.actual, v.expected, format('%s: %s', v.vw, v.what))
  from (select * from view_checks order by vw, what offset 0) v;

select * from finish();
rollback;
```

- [ ] **Step 4: Run, reconcile, repeat**

```text
bunx supabase db reset
bun run test:db
```

Expected on the first run: pgTAP prints the plan and a number of failures; read each failure's `have`/`want` and apply exactly one of these rules, then rerun until `Result: PASS`:

| Failure message | Cause | Action |
|---|---|---|
| `every public table has a matrix entry` lists names | a table this plan did not know | add a row after reading its grants (Step 1 output) and its policies; per-user tables need `owner_col` |
| `<table>: <role> may <op> as declared` | the migration and the matrix disagree | decide with the reference rules above: fix the migration (new corrective migration) or correct the row with a `-- deviation:` comment |
| `seed failed for <table>: ...` | a check constraint or enum the generic seed cannot guess | add a `seed_override` JSON with the column values the error names; if two attempts fail set `skip_behaviour` to a reason that names the dedicated pgTAP suite (maximum five tables) |
| `<table>: cross_update` shows `LEAK rows:1` | one user can modify another user's row | a security bug: fix the policy with a new migration; do not weaken the test |
| `<signature>: anon may execute` (boolean mismatch) | a public function is executable by anon or authenticated without an entry | revoke with a new migration (`revoke execute on function ... from public, anon, authenticated; grant ... to service_role`) or add an `fn_allow` row after review |
| `<table>: hidden_anon` or `hidden_auth` shows a count above the expected | a row that must be hidden is visible | a security bug (premium episode, holder-only report, admin-only row): fix the policy |
| `session_replication_role` permission error | the local `postgres` role cannot set it | stop and report: the fallback is to seed through `auth.users`-backed fixtures per table, which needs a plan change |

Every row you add or correct is also written into section 2 of `docs/discovery/security-review.md`.

- [ ] **Step 5: Prove the test fails when it should (mutation checks, then undo)**

Confirm the three guards bite by changing the local test database, running the suite and restoring the database with `bunx supabase db reset` after each one (PowerShell; the container name is the one of Step 1):

```powershell
# 1. a table without a matrix entry and without RLS
bunx supabase db reset
"create table public.p7_probe_table (id int);" | docker exec -i supabase_db_stock-screener psql -U postgres -d postgres
bun run test:db
# expect failures: "every public table has a matrix entry" and "row level security is enabled on every public table"

# 2. RLS switched off on a per-user table
bunx supabase db reset
"alter table public.profiles disable row level security;" | docker exec -i supabase_db_stock-screener psql -U postgres -d postgres
bun run test:db
# expect failures: the RLS assertion, "profiles: own_count" and "profiles: cross_update"

# 3. a function granted to anon
bunx supabase db reset
"grant execute on function public.is_admin() to anon;" | docker exec -i supabase_db_stock-screener psql -U postgres -d postgres
bun run test:db
# expect a failure: "public.is_admin(): anon may execute"
bunx supabase db reset
```

Record the three observed failures in `security-review.md` section 2.

- [ ] **Step 6: Commit**

```text
git add supabase/tests/0900_rls_matrix.test.sql supabase/migrations/20261015007000_p7_function_grants.sql docs/discovery/security-review.md
git commit -m "test(db): declarative cross-user RLS matrix with coverage guards, privilege and probe checks, and the is_admin grant fix"
```

---

## Task 3: Deferred-minor triage and the batched fixes

**Concurrency:** parallel with Tasks 1 and 2. File ownership is listed in the task table; items marked "Task 1" or "Task 2" in the triage are implemented there and only recorded here.

**Files:**
- Create: `docs/discovery/p7-triage.md`
- Create: `tools/lib/dup-deps.ts`, `tools/lib/dup-deps.test.ts`, `apps/web/src/lib/query-client.test.ts`, `apps/web/src/components/status/movement-cell.test.ts`, `supabase/functions/_shared/core/fixtures-parity.test.ts`
- Modify: `supabase/functions/_shared/adapters/{http.ts,http.test.ts}`, `supabase/functions/_shared/adapters/fetchers/{direct.ts,jina.ts,jina.test.ts}`, `supabase/functions/_shared/adapters/llm/{index.ts,index.test.ts}`, `supabase/functions/_shared/core/{thresholds.ts,thresholds.test.ts}`, `apps/web/src/lib/{format.ts,format.test.ts,query-client.ts}`, `apps/web/src/components/status/movement-cell.tsx`, `apps/web/src/components/{popover.tsx,popover.test.tsx}`, `apps/web/src/components/data-state/{data-state.tsx,data-state.test.tsx}`, `apps/web/src/styles/tokens.contrast.test.ts`, `tools/lib/{workflow-lint.ts,workflow-lint.test.ts}`, `biome.json`, `.github/workflows/ci.yml` (the `pull_request` block only), `apps/web/.env.example`

### The triage table

Sources: the four SDD ledgers under `.superpowers/sdd/` (P0, P1, P2, P4; every line containing "minor (deferred)" or "Minors deferred", plus the P0 ruling line that parks the workflow nits). Verdicts: **fixed already** (a commit on the branch resolves it), **fix now** (cheap, testable, in this plan), **defer** (with the reason the owner can accept). 64 items.

| ID | Ledger and task | Item | Verdict | Where, or why deferred |
|---|---|---|---|---|
| D-01 | P0 T4 | `sw.ts` `focusOrOpen` should try/catch navigate and focus | fixed already | commit 188a8b8 (`sw-click.ts`) |
| D-02 | P0 T4 | secret scan uses a fixed name list | fix now | Task 1 step 10 (`secret-names.ts`) |
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
| D-29 | P1 T8-11 | `apply_quote_rows` duplicate symbols | defer | step 1 greps the callers; the handlers de-duplicate symbols before the call; if a caller does not, it becomes a fix in that handler |
| D-30 | P1 T8-11 | `company_list.total_count` naming | defer | rename churns the RPC contract and the generated types |
| D-31 | P1 T8-11 | `is_admin` anon EXECUTE grant | fix now | Task 2 (migration plus the function matrix) |
| D-32 | P1 T8-11 | `reap_expired_leases` stale `last_error` | defer | cosmetic in an operator-only column |
| D-33 | P2 T2-4 | summary and `news_reason` word caps | defer | quality tuning, not safety |
| D-34 | P2 T2-4 | `stripUrls` misses scheme-less URLs | fix now | Task 1 step 12 (the renderer links only ledger URLs, so a scheme-less URL stays text) |
| D-35 | P2 T2-4 | `renderSources` publisher escaping | fix now | Task 1 step 12 (hostile publisher test) |
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

- [ ] **Step 1: Write the triage record and run the three verification greps**

Create `docs/discovery/p7-triage.md` with the title, the sentence "Source: `.superpowers/sdd/*/progress.md` (git-ignored), collected on 2026-10-15; verdicts decided in P7 Task 3.", the table above (all 64 rows) and, below it, the counts line produced by:

```powershell
(Select-String -Path docs/discovery/p7-triage.md -Pattern '\| fix now \|').Count
(Select-String -Path docs/discovery/p7-triage.md -Pattern '\| fixed already \|').Count
(Select-String -Path docs/discovery/p7-triage.md -Pattern '\| defer \|').Count
```

Expected counts at planning time: 22 fix now, 7 fixed already, 35 defer. Then run the verification greps that back three verdicts and paste each result under the table:

```powershell
git grep -n -E 'Math\["random"\]|\["now"\]|new Date\($' -- supabase/functions/_shared/core ':!*.test.ts'
git grep -n "apply_quote_rows" -- supabase/functions ':!*.test.ts'
git grep -n -i -E 'submit order|submit-order' -- apps/web/src
```

Expected: the first and third print nothing (D-03, D-60 confirmed); the second shows the callers: if one passes a list that can contain duplicates, change D-29 to `fix now` and de-duplicate with `[...new Set(symbols)]` in that handler with a test.

- [ ] **Step 2: `requireCronSecret` trim and `readJson` size guard (D-04, D-05; TDD)**

Append to `supabase/functions/_shared/adapters/http.test.ts`:

```ts
Deno.test("requireCronSecret trims the header and the configured secret", async () => {
  const padded = new Request("https://f.example/", { headers: { "x-cron-secret": "  s3cret \n" } });
  assertEquals(await requireCronSecret(padded, "s3cret\n"), null);
  assertEquals((await requireCronSecret(new Request("https://f.example/"), "s3cret"))?.status, 401);
  assertEquals((await requireCronSecret(padded, "   "))?.status, 500);
});

Deno.test("readJson refuses an oversized body from content-length and caps a streamed body", async () => {
  const declared = new Request("https://f.example/", {
    method: "POST",
    headers: { "content-length": "2000000" },
    body: "{}",
  });
  assertEquals((await readJson(declared)).ok, false);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(600));
      controller.enqueue(new Uint8Array(600));
      controller.close();
    },
  });
  const streamed = new Request("https://f.example/", { method: "POST", body: stream, duplex: "half" } as RequestInit);
  const result = await readJson(streamed, 1000);
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.response.status, 413);
});
```

Run: `deno test --config supabase/functions/deno.json supabase/functions/_shared/adapters/http.test.ts`
Expected: the trim test fails (padded header rejected) and the declared-size test fails (the body is read and parsed).

In `supabase/functions/_shared/adapters/http.ts` replace `requireCronSecret` and `readJson`:

```ts
export async function requireCronSecret(req: Request, secret: string): Promise<Response | null> {
  const expected = secret.trim();
  if (expected.length === 0) return json({ error: "server_misconfigured" }, { status: 500 });
  const provided = (req.headers.get("x-cron-secret") ?? "").trim();
  return (await timingSafeEqualStrings(provided, expected))
    ? null
    : json({ error: "unauthorized" }, { status: 401 });
}

export type JsonBody = { ok: true; value: unknown } | { ok: false; response: Response };

/** Body text, or null when it exceeds `maxBytes` (checked on content-length first, then while streaming). */
async function readCappedBody(req: Request, maxBytes: number): Promise<string | null> {
  const declared = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) return null;
  const reader = req.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder().decode(bytes);
}

/** Reads and parses a JSON request body (default limit 1 MB) without buffering more than the limit. */
export async function readJson(req: Request, maxBytes = 1_000_000): Promise<JsonBody> {
  const text = await readCappedBody(req, maxBytes);
  if (text === null) {
    return { ok: false, response: json({ error: "payload_too_large" }, { status: 413 }) };
  }
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, response: json({ error: "invalid_json" }, { status: 400 }) };
  }
}
```

Run the file's tests again (all pass), then `deno test --config supabase/functions/deno.json supabase/functions/scan-control supabase/functions/worker-tick` (callers keep passing).

- [ ] **Step 3: Jina body cap and failure handling (D-38; TDD)**

Append to `supabase/functions/_shared/adapters/fetchers/jina.test.ts`:

```ts
Deno.test("jina: the body is read with a cap and a failing body stream is a network failure", async () => {
  const big = stub(() => new Response("x".repeat(5_000)));
  const ok = await readViaJina("https://example.com/r.pdf", { fetchImpl: big.fetchImpl, limiter: noLimiter, maxChars: 100 });
  assert(ok.ok);
  assertEquals(ok.text.length, 100);
  const broken = stub(
    () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("ab"));
            controller.error(new Error("socket reset"));
          },
        }),
      ),
  );
  const failed = await readViaJina("https://example.com/r.pdf", { fetchImpl: broken.fetchImpl, limiter: noLimiter });
  assertEquals(failed.ok, false);
  if (!failed.ok) assertEquals(failed.kind, "network");
});
```

Run it: the second half fails (an unhandled rejection from `res.text()`).

In `fetchers/direct.ts` change `async function readCapped(` to `export async function readCapped(`. In `fetchers/jina.ts` import it (`import { publicUrlProblem, readCapped } from "./direct.ts";`) and replace the last two lines of `readViaJina`:

```ts
  const maxChars = opts.maxChars ?? 200_000;
  try {
    const { bytes } = await readCapped(res, maxChars * 4); // at most 4 bytes per character
    return { ok: true, status: res.status, text: new TextDecoder().decode(bytes).slice(0, maxChars) };
  } catch (e) {
    return {
      ok: false,
      kind: "network",
      message: scrub(e instanceof Error ? e.message : String(e)).slice(0, 200),
    };
  }
```

Run `deno test --config supabase/functions/deno.json supabase/functions/_shared/adapters/fetchers` (all pass).

- [ ] **Step 4: `LLM_PRIMARY` validation and the https-only alternate provider URL (D-41; TDD)**

Append to `supabase/functions/_shared/adapters/llm/index.test.ts` (extend its imports with `assertThrows` if absent):

```ts
Deno.test("LLM_PRIMARY: an unknown value is a configuration error; known values and blank are accepted", () => {
  assertThrows(() => createLlmProviders({ LLM_PRIMARY: "gemni" }), Error, "LLM_PRIMARY");
  for (const value of [undefined, "", " gemini ", "openai_compatible"]) createLlmProviders({ LLM_PRIMARY: value });
});

Deno.test("LLM_ALT_BASE_URL must be https outside a local stack", () => {
  assertThrows(
    () => createLlmProviders({ LLM_ALT_BASE_URL: "http://api.example.com/v1" }),
    Error,
    "LLM_ALT_BASE_URL must be an https URL",
  );
  createLlmProviders({ LLM_ALT_BASE_URL: "https://api.groq.com/openai/v1" });
});
```

Run: fails. In `llm/index.ts` add `import { requireHttpsBase } from "../env.ts";` and, at the top of `createLlmProviders`:

```ts
  const primaryName = (env.LLM_PRIMARY ?? "").trim();
  if (primaryName !== "" && primaryName !== "gemini" && primaryName !== "openai_compatible") {
    throw new Error(`LLM_PRIMARY must be "gemini" or "openai_compatible" (found "${primaryName}")`);
  }
  const altBase = env.LLM_ALT_BASE_URL?.trim();
```

then use `baseUrl: altBase === undefined || altBase === "" ? env.LLM_ALT_BASE_URL : requireHttpsBase("LLM_ALT_BASE_URL", altBase),` in the `createOpenAiCompatibleProvider` call and `const swapped = primaryName === "openai_compatible";`. Task 1 adds `requireHttpsBase` to `env.ts`; if Task 1 has not merged yet, add the function from Task 1 step 14 verbatim (identical text, so the later merge is a no-op) and note it in the commit message.

- [ ] **Step 5: `classifyHolding` finite channel end and the fixture parity test (D-19, D-21; TDD)**

Append to `supabase/functions/_shared/core/thresholds.test.ts`:

```ts
describe("classifyHolding with a non-finite channel end", () => {
  const base = { evaluable: true, quoteType: "EQUITY", close: 100, worldwideRank: 5 } as const;
  it("is unavailable when any channel end value is not finite", () => {
    expect(classifyHolding({ ...base, end: { base: 100, upper1: Number.NaN, upper2: 120, lower1: 90, lower2: 80 } })).toBe("unavailable");
    expect(classifyHolding({ ...base, end: { base: 100, upper1: 110, upper2: 120, lower1: Number.POSITIVE_INFINITY, lower2: 80 } })).toBe("unavailable");
  });
  it("still classifies a finite end", () => {
    expect(classifyHolding({ ...base, end })).not.toBe("unavailable");
  });
});
```

Run: `bun run test:core thresholds` (the first test fails: a NaN `upper1` makes the comparisons false and the holding is classified as neutral). In `thresholds.ts`, inside `classifyHolding`, extend the guard:

```ts
  if (
    !i.evaluable ||
    i.quoteType !== "EQUITY" ||
    i.close === null ||
    !Number.isFinite(i.close) ||
    i.end === null ||
    ![i.end.base, i.end.upper1, i.end.upper2, i.end.lower1, i.end.lower2].every(Number.isFinite)
  )
    return "unavailable";
```

Create `supabase/functions/_shared/core/fixtures-parity.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const read = (relative: string): unknown =>
  JSON.parse(readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8"));

it("the core parity fixture equals the discovery copy value for value (formatting may differ)", () => {
  expect(read("./fixtures/stddevchn-synthetic.json")).toEqual(
    read("../../../../docs/discovery/fixtures/stddevchn-synthetic.json"),
  );
});
```

Run `bun run test:core` (all pass; if the two files differ in value the discovery copy is the reference: copy its values into the core fixture and rerun the indicator suite).

- [ ] **Step 6: Number and date formatting (D-42, D-43, D-44; TDD)**

Append to `apps/web/src/lib/format.test.ts` (inside the file, new `describe` blocks):

```ts
describe("formatMarketCap unit boundaries", () => {
  it("steps up a unit when rounding reaches 1000", () => {
    expect(formatMarketCap(999.6e6, "USD")).toBe("1B USD");
    expect(formatMarketCap(999.4e6, "USD")).toBe("999M USD");
    expect(formatMarketCap(999.96e9, "USD")).toBe("1T USD");
    expect(formatMarketCap(999_999.6, "USD")).toBe("1M USD");
    expect(formatMarketCap(999_999.4, "USD")).toBe("999,999 USD");
    expect(formatMarketCap(-999.6e6, "USD")).toBe("-1B USD");
  });
});

describe("formatMoney negative zero", () => {
  it("never shows -0.00", () => {
    expect(formatMoney(-0.00001, "USD")).toBe("0.00 USD");
    expect(formatMoney(-0, "USD")).toBe("0.00 USD");
    expect(formatMoney(-0.004, "USD")).toBe("-0.004 USD");
  });
});

describe("formatSessionDate impossible dates", () => {
  it("rejects a date that does not exist", () => {
    expect(formatSessionDate("2026-02-30")).toBe("n/a");
    expect(formatSessionDate("2026-13-01")).toBe("n/a");
    expect(formatSessionDate("2026-02-28")).toBe("28 Feb 2026");
  });
});
```

Run `bun run test:web format`: the three blocks fail. In `apps/web/src/lib/format.ts` replace `formatMarketCap`, patch `formatMoney` and `formatSessionDate`:

```ts
const CAP_UNITS = [
  { d: 1e12, s: "T" },
  { d: 1e9, s: "B" },
  { d: 1e6, s: "M" },
] as const;

function capText(value: number, unit: (typeof CAP_UNITS)[number]): number {
  const scaled = value / unit.d;
  const digits = unit.s === "T" ? 2 : Math.abs(scaled) >= 100 ? 0 : Math.abs(scaled) >= 10 ? 1 : 2;
  return Number(scaled.toFixed(digits));
}

/** "1.23T USD", "456B USD", "850M EUR". Market caps are reported in the major unit; never divide. A value that rounds to 1000 of a unit moves up one unit (999.6M is 1B). */
export function formatMarketCap(
  value: number | null | undefined,
  ccy: string | null | undefined,
): string {
  if (!isNum(value)) return NA;
  const suffix = ccy ? ` ${ccy}` : "";
  const abs = Math.abs(value);
  let index = CAP_UNITS.findIndex((u) => abs >= u.d);
  if (index === -1) {
    if (Math.round(abs) < 1e6) return `${integer.format(value)}${suffix}`;
    index = CAP_UNITS.length - 1; // 999,999.6 rounds to 1M
  }
  let unit = CAP_UNITS[index] as (typeof CAP_UNITS)[number];
  let text = capText(value, unit);
  while (Math.abs(text) >= 1000 && index > 0) {
    index -= 1;
    unit = CAP_UNITS[index] as (typeof CAP_UNITS)[number];
    text = capText(value, unit);
  }
  return `${text}${unit.s}${suffix}`;
}
```

In `formatMoney` replace the final line with:

```ts
  const text = fmt.format(v).replace(/^-(0(?:\.0+)?)$/, "$1"); // never "-0.00"
  return `${text} ${code}`;
```

and `formatSessionDate`'s last two lines with:

```ts
  const d = new Date(`${day}T12:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== day) return NA;
  return dayFmt.format(d);
```

Run `bun run test:web format` (all pass, including the P4 originals `1.23T USD`, `456B USD`, `850M EUR`).

- [ ] **Step 7: MovementCell, Popover, Retry focus, query retry (D-45, D-50, D-51, D-56; TDD)**

1. `apps/web/src/components/status/movement-cell.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { movementOf } from "./movement-cell";

describe("movementOf", () => {
  it("is null for a missing or non-finite value", () => {
    expect(movementOf(null)).toBeNull();
    expect(movementOf(undefined)).toBeNull();
    expect(movementOf(Number.NaN)).toBeNull();
  });
  it("derives direction and magnitude from the number, not from formatted text", () => {
    expect(movementOf(12.3456)).toEqual({ dir: "up", abs: "12.35", text: "+12.35%" });
    expect(movementOf(-0.5)).toEqual({ dir: "down", abs: "0.50", text: "-0.50%" });
    expect(movementOf(0.004)).toEqual({ dir: "flat", abs: "0.00", text: "0.00%" });
    expect(movementOf(-0.004)).toEqual({ dir: "flat", abs: "0.00", text: "0.00%" });
  });
});
```

   Run (fails: no export). Rewrite `movement-cell.tsx`:

```tsx
import { ArrowDown, ArrowUp, Minus } from "lucide-react";
import { formatPct } from "@/lib/format";

export function movementOf(
  pct: number | null | undefined,
): { dir: "up" | "down" | "flat"; abs: string; text: string } | null {
  if (typeof pct !== "number" || !Number.isFinite(pct)) return null;
  const rounded = Number(pct.toFixed(2));
  const dir = rounded > 0 ? "up" : rounded < 0 ? "down" : "flat";
  return { dir, abs: Math.abs(rounded).toFixed(2), text: formatPct(pct) };
}

/** Sign + arrow + spoken label; colour only reinforces. */
export function MovementCell({ pct }: { pct: number | null | undefined }) {
  const move = movementOf(pct);
  if (move === null) {
    return (
      <span className="text-muted-foreground" role="img" aria-label="Movement unavailable">
        n/a
      </span>
    );
  }
  const label =
    move.dir === "up" ? `Up ${move.abs} percent` : move.dir === "down" ? `Down ${move.abs} percent` : "Unchanged";
  const Icon = move.dir === "up" ? ArrowUp : move.dir === "down" ? ArrowDown : Minus;
  return (
    <span
      className={`inline-flex items-center gap-1 tabular-nums ${move.dir === "up" ? "move-up" : move.dir === "down" ? "move-down" : ""}`}
      role="img"
      aria-label={label}
    >
      <Icon aria-hidden="true" size={14} />
      <span aria-hidden="true">{move.text}</span>
    </span>
  );
}
```

   Run `bun run test:web status movement-cell` (the P4 `MovementCell` tests keep passing).
2. Popover. Append to `apps/web/src/components/popover.test.tsx` inside `describe("Popover", ...)`:

```tsx
  it("closes on an outside pointerdown (touch and pen included)", () => {
    const btn = setup();
    fireEvent.click(btn);
    expect(screen.getByRole("dialog", { name: "The list" })).toBeTruthy();
    fireEvent.pointerDown(screen.getByRole("button", { name: "Outside" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
```

   Run it (fails: the listener is `mousedown`). In `popover.tsx` change `const onDown = (e: MouseEvent) =>` to `(e: PointerEvent)` and both `"mousedown"` strings to `"pointerdown"`.
3. Retry focus. Append to `data-state.test.tsx` inside the `describe`:

```tsx
  it("the Retry button has a visible focus style", () => {
    render(<ErrorState message="boom" onRetry={() => undefined} />);
    expect(screen.getByRole("button", { name: "Retry" }).className).toContain("focus-visible:outline-2");
  });
```

   In `data-state.tsx` change the Retry button class to `"mt-2 rounded border px-3 py-1 text-sm underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"`.
4. Query retry. `apps/web/src/lib/query-client.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { ApiError } from "@/features/screening/errors";
import { shouldRetry } from "./query-client";

describe("shouldRetry", () => {
  it("never retries a denied or rate-limited request", () => {
    expect(shouldRetry(0, new ApiError("rls_denied", "no", 403))).toBe(false);
    expect(shouldRetry(0, new ApiError("rate_limited", "slow", 429))).toBe(false);
  });
  it("retries transient failures twice", () => {
    expect(shouldRetry(0, new ApiError("network", "x", 0))).toBe(true);
    expect(shouldRetry(1, new ApiError("server", "x", 500))).toBe(true);
    expect(shouldRetry(2, new ApiError("server", "x", 500))).toBe(false);
    expect(shouldRetry(0, new Error("unknown"))).toBe(true);
  });
});
```

   In `query-client.ts` add the import `import { ApiError } from "@/features/screening/errors";`, the function

```ts
/** Retry transient failures only: a denied (401, 403, RLS) or rate-limited request will not succeed by itself. */
export function shouldRetry(failureCount: number, error: unknown): boolean {
  if (error instanceof ApiError && (error.kind === "rls_denied" || error.kind === "rate_limited")) return false;
  return failureCount < 2;
}
```

   and `retry: shouldRetry,` in place of `retry: 2,`.

- [ ] **Step 8: Contrast pairs, duplicate dependencies, workflow rule, Biome override, `.env.example`**

1. Contrast (D-08): in `apps/web/src/styles/tokens.contrast.test.ts` add to `PAIRS` after `["destructive-foreground", "destructive"]`:

```ts
  ["primary", "background"],
  ["primary", "card"],
  ["muted-foreground", "card"],
  ["destructive", "background"],
  ["destructive", "card"],
```

   Run `bun run test:web tokens`. If a pair fails (most likely a dark-theme `destructive` or `primary` used as text), darken or lighten that one token in `apps/web/src/styles/index.css` by the smallest step that reaches 4.5:1, keep the hue, and rerun the whole web suite; do not remove the pair.
2. Duplicate dependencies (D-10). `tools/lib/dup-deps.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { duplicateDependencyProblems, type PackageJson } from "./dup-deps.ts";

const read = (relative: string): PackageJson =>
  JSON.parse(readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8")) as PackageJson;

describe("duplicateDependencyProblems", () => {
  it("allows a package in both files only with the same range", () => {
    const root = { devDependencies: { vite: "^8.3.4", vitest: "^5.0.4" } };
    expect(duplicateDependencyProblems(root, [{ name: "web", pkg: { devDependencies: { vite: "^8.3.4" } } }])).toEqual([]);
    expect(duplicateDependencyProblems(root, [{ name: "web", pkg: { devDependencies: { vite: "^8.0.0" } } }])).toEqual([
      "vite: root declares ^8.3.4 but web declares ^8.0.0",
    ]);
  });
  it("holds for the committed package.json files", () => {
    expect(duplicateDependencyProblems(read("../../package.json"), [{ name: "apps/web", pkg: read("../../apps/web/package.json") }])).toEqual([]);
  });
});
```

   `tools/lib/dup-deps.ts`:

```ts
export interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

/** A package declared in the root and in a workspace must use the same range (version drift risk, ledger D-10). */
export function duplicateDependencyProblems(
  root: PackageJson,
  workspaces: Array<{ name: string; pkg: PackageJson }>,
): string[] {
  const rootDeps = { ...root.dependencies, ...root.devDependencies };
  const problems: string[] = [];
  for (const ws of workspaces) {
    for (const [name, range] of Object.entries({ ...ws.pkg.dependencies, ...ws.pkg.devDependencies })) {
      const rootRange = rootDeps[name];
      if (rootRange !== undefined && rootRange !== range) {
        problems.push(`${name}: root declares ${rootRange} but ${ws.name} declares ${range}`);
      }
    }
  }
  return problems;
}
```

   Run `bun run test:tools dup-deps`. If the committed-files test fails, align the ranges in `apps/web/package.json` to the root (or the reverse, whichever is newer in `bun.lock`) and run `bun install`.
3. Workflow rule (D-11). Append to `tools/lib/workflow-lint.test.ts`:

```ts
describe("labels need the labeled activity type", () => {
  const doc = (on: unknown) => ({
    name: "x",
    on,
    permissions: { contents: "read" },
    jobs: {
      a: {
        "runs-on": "ubuntu-latest",
        if: "${{ contains(github.event.pull_request.labels.*.name, 'e2e') }}",
        steps: [{ run: "echo hi" }],
      },
    },
  });
  it("flags a pull_request trigger that cannot fire on a label", () => {
    expect(lintWorkflow(doc({ pull_request: null }), "w.yml").join("\n")).toMatch(/labeled/);
    expect(lintWorkflow(doc({ pull_request: { types: ["opened"] } }), "w.yml").join("\n")).toMatch(/labeled/);
  });
  it("accepts it when labeled is listed", () => {
    expect(lintWorkflow(doc({ pull_request: { types: ["opened", "labeled"] } }), "w.yml")).toEqual([]);
  });
});
```

   In `tools/lib/workflow-lint.ts`, right after the `if (!isMapping(jobs) || Object.keys(jobs).length === 0) { ... }` block, add:

```ts
  if (JSON.stringify(jobs).includes("pull_request.labels")) {
    const pr = isMapping(triggers) ? triggers.pull_request : undefined;
    const types = isMapping(pr) && Array.isArray(pr.types) ? pr.types : [];
    if (!types.includes("labeled")) {
      add("a job reads pull_request.labels but on.pull_request.types does not include labeled");
    }
  }
```

   and in `.github/workflows/ci.yml` change `pull_request:` to:

```yaml
  pull_request:
    types: [opened, synchronize, reopened, labeled]
```

   Run `bun run test:tools workflow-lint` and `bun run lint:workflows`.
4. Biome override (D-15). In `biome.json` add, after the `linter` block:

```json
  "overrides": [
    {
      "includes": ["supabase/functions/_shared/core/indicator.ts"],
      "linter": { "rules": { "complexity": { "useLiteralKeys": "off" } } }
    }
  ],
```

   (the file reads fields of a `Record<string, unknown>` by name on purpose, so the literal-key rewrite is not wanted there). Run `bun run lint` (the ten infos for `indicator.ts` are gone).
5. `.env.example` (D-57): delete the last line of `apps/web/.env.example` (`# Regenerate DB types after every migration: ...`); Task 5 puts the sentence in the README script table.

- [ ] **Step 9: Run everything and commit**

```text
bun run lint:fix
bun run lint
bun run typecheck
bun run test:core
bun run test:tools
bun run test:web
bun run functions:check
bun run functions:test
git add docs/discovery/p7-triage.md tools supabase/functions apps/web/src apps/web/.env.example biome.json .github/workflows/ci.yml
git commit -m "fix: batched deferred review findings (body caps, trim, formatting, a11y, retry policy, lint config) with triage record"
```

Expected: all commands exit 0; `p7-triage.md` counts read 22, 7, 35 (change the counts line if step 1 moved a verdict).

---

## Task 4: End-to-end suite against the local stack

**Concurrency:** after Task 1 (headers) and Task 3 (UI fixes), and after the features of P3 (notifications page), P5a (auth, profile), P5b (broker, portfolio, analytics) and P6 (hand-off dialog) exist; parallel with Task 5 (no shared files except root `package.json` scripts: re-read before editing).

**Files:**
- Create: `tools/lib/e2e-env.ts`, `tools/lib/e2e-env.test.ts`, `tools/e2e-setup.ts`
- Create: `apps/web/playwright.local.config.ts` (or replace the P5a file of the same name), `apps/web/tsconfig.e2e.json`
- Create: `apps/web/e2e/local/support/{stack.ts,push-mock.ts}`
- Create: `apps/web/e2e/local/{30-profile,35-isolation,40-notifications,50-portfolio-analytics,90-a11y-viewports}.local.spec.ts`
- Move with `git mv`: `apps/web/e2e/local/overview.local.spec.ts` to `10-overview.local.spec.ts`; `apps/web/e2e/auth.spec.ts` to `apps/web/e2e/local/20-auth.local.spec.ts`; `apps/web/e2e/local/handoff.local.spec.ts` to `60-handoff.local.spec.ts`
- Modify: `apps/web/playwright.config.ts` (the default run ignores `local/`), `apps/web/package.json` (`e2e:local`), root `package.json` (`e2e:setup`, `e2e:serve`, `test:e2e:local`, `typecheck`), root `tsconfig.json` (remove the P5a entries for the moved files), `.gitignore`

**Interfaces:**
- Consumes: P1 `tools/run-local-scan.ts` (`start --mode fixture`, `tick`) and `tools/lib/local-stack.ts` (`resolveStack`, `callFunction`, `rest`); P3 `tools/gen-vapid.ts` (`bun run gen:vapid`), functions `push-subscribe`, Profile -> Notifications page; P5a sign-in page and guards; P5b `broker-sync` worker action `ingest_fixture`, fixture `supabase/functions/_shared/adapters/fixtures/flex/activity-sample.xml`, Portfolio and Analytics pages; P6 hand-off dialog; P2 `scan-control` action `research_now`; the three existing local specs.
- Produces: `bun run e2e:setup` (full reset and seed), `bun run e2e:serve` (functions with the e2e env file), `bun run test:e2e:local` (ensure the seed, then Playwright on the Vite dev server), the spec files above, `parseStackStatus`, `parseEnvFile`, `serializeEnv`, `e2eFunctionsEnv`.

- [ ] **Step 1: Inventory what P4, P5a and P6 left, and the type-check coverage**

```powershell
git ls-files apps/web/e2e apps/web/playwright.config.ts apps/web/playwright.local.config.ts tools/lib/local-supabase.ts tools/gen-vapid.ts
git grep -n -E "test:e2e:local|e2e:local" -- package.json apps/web/package.json
Get-Content apps/web/tsconfig.json
Get-Content tsconfig.json
```

Expected: the three specs named above, a P5a `playwright.local.config.ts` that starts `bun run dev`, two different `test:e2e:local` definitions merged by whoever ran P5a last, and tsconfig `include` lists. Decision P7-D5: one config (`playwright.local.config.ts`, dev server), one script. The specs that touch `window`, `document` or `navigator` inside `page.evaluate` need the DOM library, which the root `tsconfig.json` (lib ES2023, node types) does not have; `apps/web/tsconfig.e2e.json` below covers every e2e file and config.

- [ ] **Step 2: Environment helpers (TDD)**

`tools/lib/e2e-env.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { e2eFunctionsEnv, parseEnvFile, parseStackStatus, serializeEnv } from "./e2e-env.ts";

describe("parseStackStatus", () => {
  it("reads the legacy key names after status lines", () => {
    const out = `Stopped services: [x]\n${JSON.stringify({ API_URL: "http://127.0.0.1:54321", ANON_KEY: "a", SERVICE_ROLE_KEY: "s" })}\n`;
    expect(parseStackStatus(out)).toEqual({ url: "http://127.0.0.1:54321", anonKey: "a", serviceKey: "s" });
  });
  it("falls back to the publishable and secret key names", () => {
    const out = JSON.stringify({ API_URL: "http://127.0.0.1:54321", PUBLISHABLE_KEY: "p", SECRET_KEY: "k" });
    expect(parseStackStatus(out)).toMatchObject({ anonKey: "p", serviceKey: "k" });
  });
  it("fails loudly without JSON or keys", () => {
    expect(() => parseStackStatus("no json")).toThrow(/JSON/);
    expect(() => parseStackStatus(JSON.stringify({ API_URL: "x" }))).toThrow(/ANON_KEY/);
  });
});

describe("env files", () => {
  it("round-trips values with spaces and JSON", () => {
    const env = { A: "plain", B: "two words", C: '{"kty":"EC","d":"x"}' };
    expect(parseEnvFile(serializeEnv(env))).toEqual(env);
  });
  it("ignores comments and blank lines", () => {
    expect(parseEnvFile("# c\n\nA=1\n")).toEqual({ A: "1" });
  });
});

describe("e2eFunctionsEnv", () => {
  const vapid = { VAPID_PUBLIC_KEY: "pub", VAPID_PRIVATE_KEY: '{"kty":"EC"}', VAPID_SUBJECT: "mailto:e2e@example.test" };
  it("generates a 32-byte Flex key and a long salt, keeps an existing cron secret and forces the local flags", () => {
    const env = e2eFunctionsEnv({ CRON_SHARED_SECRET: "keep-me" }, vapid);
    expect(Buffer.from(env.FLEX_ENC_KEY_V1 ?? "", "base64")).toHaveLength(32);
    expect((env.RATE_LIMIT_SALT ?? "").length).toBeGreaterThanOrEqual(32);
    expect(env.CRON_SHARED_SECRET).toBe("keep-me");
    expect([env.ALLOW_FIXTURE_PROVIDERS, env.FLEX_FIXTURE_MODE, env.SITE_URL]).toEqual(["1", "1", "http://localhost:5173"]);
    expect(env.PUSH_ENDPOINT_EXTRA_HOSTS).toBe("push.example.test");
  });
  it("is stable: a second call keeps the generated secrets", () => {
    const first = e2eFunctionsEnv({}, vapid);
    expect(e2eFunctionsEnv(first, vapid)).toEqual(first);
  });
});
```

`tools/lib/e2e-env.ts`:

```ts
import { randomBytes } from "node:crypto";

export const E2E_PASSWORD = "E2e-Passw0rd-9x";
export const OWNER_EMAIL = "e2e-owner@example.test";
export const OTHER_EMAIL = "e2e-other@example.test";
export const PUSH_HOST = "push.example.test";

export interface StackKeys {
  url: string;
  anonKey: string;
  serviceKey: string;
}

/** `supabase status -o json` may print status lines before the JSON; key names differ between CLI versions. */
export function parseStackStatus(output: string): StackKeys {
  const start = output.indexOf("{");
  const end = output.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("supabase status printed no JSON object");
  const data = JSON.parse(output.slice(start, end + 1)) as Record<string, unknown>;
  const pick = (...names: string[]): string => {
    for (const name of names) {
      const value = data[name];
      if (typeof value === "string" && value !== "") return value;
    }
    throw new Error(`supabase status has none of: ${names.join(", ")}`);
  };
  return {
    url: pick("API_URL"),
    anonKey: pick("ANON_KEY", "PUBLISHABLE_KEY"),
    serviceKey: pick("SERVICE_ROLE_KEY", "SECRET_KEY"),
  };
}

export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2 && ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"')))) {
      value = value.slice(1, -1);
    }
    out[line.slice(0, eq).trim()] = value;
  }
  return out;
}

export function serializeEnv(env: Record<string, string>): string {
  return `${Object.entries(env)
    .map(([name, value]) => {
      if (!/["\s#]/.test(value)) return `${name}=${value}`;
      if (value.includes("'")) throw new Error(`${name} contains a single quote; cannot be written to an env file`);
      return `${name}='${value}'`;
    })
    .join("\n")}\n`;
}

/** The function secrets of the local end-to-end run. Generated values are kept when `existing` already has them. */
export function e2eFunctionsEnv(
  existing: Record<string, string>,
  vapid: Record<string, string>,
): Record<string, string> {
  const keep = (name: string, make: () => string): string => {
    const value = existing[name];
    return value !== undefined && value !== "" ? value : make();
  };
  return {
    CRON_SHARED_SECRET: keep("CRON_SHARED_SECRET", () => "local-dev-cron-secret"),
    SITE_URL: "http://localhost:5173",
    SEC_USER_AGENT: keep("SEC_USER_AGENT", () => "E2E Local e2e@example.test"),
    ALLOW_FIXTURE_PROVIDERS: "1",
    FLEX_FIXTURE_MODE: "1",
    FLEX_ENC_KEY_V1: keep("FLEX_ENC_KEY_V1", () => randomBytes(32).toString("base64")),
    FLEX_ENC_KEY_CURRENT: "1",
    FLEX_USER_AGENT: keep("FLEX_USER_AGENT", () => "e2e-local"),
    RATE_LIMIT_SALT: keep("RATE_LIMIT_SALT", () => randomBytes(24).toString("base64url")),
    UNSUBSCRIBE_SECRET: keep("UNSUBSCRIBE_SECRET", () => randomBytes(24).toString("base64url")),
    RESEND_API_KEY: keep("RESEND_API_KEY", () => "re_e2e"),
    EMAIL_FROM: keep("EMAIL_FROM", () => "Screener <alerts@e2e.test>"),
    RESEND_WEBHOOK_SECRET: keep("RESEND_WEBHOOK_SECRET", () => `whsec_${randomBytes(24).toString("base64")}`),
    RESEND_API_URL: "http://host.docker.internal:54782/emails",
    FUNCTIONS_PUBLIC_URL: "http://127.0.0.1:54321/functions/v1",
    PUSH_ENDPOINT_EXTRA_HOSTS: PUSH_HOST,
    ...vapid,
  };
}
```

Run `bun run test:tools e2e-env` (fails before the file exists, passes after).

- [ ] **Step 3: The setup script (the documented exact setup)**

`tools/e2e-setup.ts`:

```ts
// Local end-to-end environment (spec 17.5). Idempotent; `--ensure` skips the reset and the scan when the data is already there.
//
// The exact manual equivalent, PowerShell, repository root:
//   bunx supabase start
//   bunx supabase db reset
//   bun run gen:vapid -- mailto:e2e@example.test --out supabase/functions/.env.e2e-vapid
//   (this script writes supabase/functions/.env.e2e: fixture flags, Flex key, rate-limit salt, VAPID keys)
//   bun run e2e:serve                     # a second terminal, keep it running
//   bun run scan:local -- start --mode fixture
//   bun run scan:local -- tick --max-minutes 20
//   create e2e-owner@example.test and e2e-other@example.test through the admin API (password E2E_PASSWORD)
//   seed AAPL and SHEL.L securities and fresh delayed quotes, link a broker connection for the owner,
//   post the fixture Flex statement to broker-sync (worker action ingest_fixture)
//   queue one research report for the first discount card (scan-control research_now)
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { E2E_PASSWORD, e2eFunctionsEnv, OTHER_EMAIL, OWNER_EMAIL, parseEnvFile, serializeEnv } from "./lib/e2e-env.ts";
import { assertLocalUrl, callFunction, resolveStack, rest, sleep } from "./lib/local-stack.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const ensure = process.argv.includes("--ensure");
const envFile = join(root, "supabase", "functions", ".env.e2e");
const vapidFile = join(root, "supabase", "functions", ".env.e2e-vapid");

function sh(command: string, args: string[]): void {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", shell: true });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}`);
}
const stackIsUp = () =>
  spawnSync("bunx", ["supabase", "status", "-o", "json"], { cwd: root, encoding: "utf8", shell: true, stdio: "pipe" }).status === 0;

// 1. stack and database
if (!stackIsUp()) sh("bunx", ["supabase", "start"]);
if (!ensure) sh("bunx", ["supabase", "db", "reset"]);

// 2. function secrets (kept between runs so push subscriptions and Flex ciphertext stay valid)
const existing = existsSync(envFile) ? parseEnvFile(readFileSync(envFile, "utf8")) : {};
if (existing.VAPID_PRIVATE_KEY === undefined) {
  sh("bun", ["run", "gen:vapid", "--", "mailto:e2e@example.test", "--out", "supabase/functions/.env.e2e-vapid"]);
}
const vapidAll = existsSync(vapidFile) ? parseEnvFile(readFileSync(vapidFile, "utf8")) : {};
const vapid = Object.fromEntries(
  Object.entries({ ...vapidAll, ...Object.fromEntries(Object.entries(existing).filter(([k]) => k.startsWith("VAPID_"))) }).filter(
    ([k]) => k === "VAPID_PUBLIC_KEY" || k === "VAPID_PRIVATE_KEY" || k === "VAPID_SUBJECT",
  ),
);
if (vapid.VAPID_PRIVATE_KEY === undefined) throw new Error("no VAPID keys: P3's tools/gen-vapid.ts (bun run gen:vapid) must write them");
const env = e2eFunctionsEnv(existing, vapid);
writeFileSync(envFile, serializeEnv(env));
process.env.CRON_SHARED_SECRET = env.CRON_SHARED_SECRET ?? "local-dev-cron-secret";

const stack = resolveStack();
assertLocalUrl(stack.url);

// 3. the functions must be served with that env file
async function waitForFunctions(): Promise<void> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${stack.url}/functions/v1/health`)).ok) return;
    } catch {
      // not up yet
    }
    await sleep(2000);
  }
  throw new Error("Edge Functions are not served. Run `bun run e2e:serve` in a second terminal, then rerun this command.");
}
await waitForFunctions();

// 4. the fixture-mode scan
const runs = (await rest(stack, "scan_runs?select=id,status&order=scan_date_local.desc&limit=1")) as Array<{ status: string }>;
const scanned = runs[0] !== undefined && (runs[0].status === "complete" || runs[0].status === "partial");
if (!ensure || !scanned) {
  sh("bun", ["run", "tools/run-local-scan.ts", "start", "--mode", "fixture"]);
  sh("bun", ["run", "tools/run-local-scan.ts", "tick", "--max-minutes", "20"]);
}

// 5. users through the admin API (recreated: their rows cascade)
const admin = { apikey: stack.serviceKey, authorization: `Bearer ${stack.serviceKey}`, "content-type": "application/json" };
async function recreateUser(email: string): Promise<string> {
  const list = (await (await fetch(`${stack.url}/auth/v1/admin/users?per_page=200`, { headers: admin })).json()) as {
    users?: Array<{ id: string; email?: string }>;
  };
  const old = list.users?.find((u) => u.email === email);
  if (old !== undefined) await fetch(`${stack.url}/auth/v1/admin/users/${old.id}`, { method: "DELETE", headers: admin });
  const created = await fetch(`${stack.url}/auth/v1/admin/users`, {
    method: "POST",
    headers: admin,
    body: JSON.stringify({ email, password: E2E_PASSWORD, email_confirm: true }),
  });
  if (!created.ok) throw new Error(`creating ${email} failed: HTTP ${created.status}`);
  return ((await created.json()) as { id: string }).id;
}
const ownerId = await recreateUser(OWNER_EMAIL);
await recreateUser(OTHER_EMAIL);

// 6. securities, fresh delayed quotes and the owner's fixture statement (same seeding as the P5b integration test)
async function send(path: string, method: string, body: unknown, prefer = "return=representation"): Promise<unknown> {
  const res = await fetch(`${stack.url}/rest/v1/${path}`, { method, headers: { ...admin, prefer }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`${method} ${path} -> HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json().catch(() => null);
}
async function companyId(name: string, normalized: string): Promise<string> {
  const found = (await rest(stack, `companies?select=id&name_normalized=eq.${normalized}`)) as Array<{ id: string }>;
  if (found[0] !== undefined) return found[0].id;
  return ((await send("companies", "POST", { name, name_normalized: normalized })) as Array<{ id: string }>)[0]?.id ?? "";
}
const apple = await companyId("Apple Inc", "apple");
const shell = await companyId("Shell plc", "shell");
await send("securities?on_conflict=yahoo_symbol", "POST", [
  { company_id: apple, yahoo_symbol: "AAPL", exchange_code: "NMS", currency: "USD", currency_major: "USD", quote_type: "EQUITY", isin: "US0378331005", is_canonical: true },
  { company_id: shell, yahoo_symbol: "SHEL.L", exchange_code: "LSE", currency: "GBp", currency_major: "GBP", minor_divisor: 100, quote_type: "EQUITY", isin: "GB00BP6MXD84", is_canonical: true },
], "resolution=merge-duplicates,return=minimal");
const future = new Date(Date.now() + 6 * 3_600_000).toISOString();
const quote = (symbol: string, price: number, currency: string, pct: number) => ({
  key: `quote:${symbol}`,
  payload: { symbol, currency, exchange: "X", regularMarketPrice: price, regularMarketTime: Date.now() - 60_000, regularMarketChangePercent: pct, marketState: "REGULAR", fetchedAt: new Date().toISOString(), stale: false },
  provider: "yahoo",
  expires_at: future,
});
await send("quote_cache?on_conflict=key", "POST", [quote("AAPL", 232, "USD", 1), quote("SHEL.L", 2735, "GBp", 0.5), quote("USDEUR=X", 0.93, "EUR", 0), quote("GBPEUR=X", 1.16, "EUR", 0)], "resolution=merge-duplicates,return=minimal");
await send("broker_connections?on_conflict=user_id", "POST", { user_id: ownerId, status: "linked", query_id: "123456", linked_at: new Date().toISOString() }, "resolution=merge-duplicates,return=minimal");
const xml = readFileSync(join(root, "supabase", "functions", "_shared", "adapters", "fixtures", "flex", "activity-sample.xml"), "utf8");
await callFunction(stack, "broker-sync", { action: "ingest_fixture", userId: ownerId, xml });

// 7. one research report for the first card (fixture providers; idempotent per day)
const cards = (await rest(stack, "todays_discounts?select=security_id&limit=1")) as Array<{ security_id: string }>;
let reportId: string | null = null;
if (cards[0] !== undefined) {
  await callFunction(stack, "scan-control", { action: "research_now", security_id: cards[0].security_id });
  for (let i = 0; i < 60 && reportId === null; i++) {
    const rows = (await rest(stack, `research_reports?select=id,status&security_id=eq.${cards[0].security_id}&order=created_at.desc&limit=1`)) as Array<{ id: string; status: string }>;
    if (rows[0]?.status === "complete") reportId = rows[0].id;
    else await sleep(3000);
  }
}
console.log(JSON.stringify({ ok: true, stack: stack.url, owner: OWNER_EMAIL, other: OTHER_EMAIL, cards: cards.length, researchReport: reportId }));
if (reportId === null) console.warn("e2e-setup: no completed research report (the report page checks will skip)");
```

Add root scripts (re-read `package.json` first):

```jsonc
"e2e:setup": "bun run tools/e2e-setup.ts",
"e2e:serve": "supabase functions serve --no-verify-jwt --env-file supabase/functions/.env.e2e",
"test:e2e:local": "bun run tools/e2e-setup.ts --ensure && bun run --filter @screener/web e2e:local",
```

and in `apps/web/package.json` `scripts`: `"e2e:local": "playwright test --config playwright.local.config.ts"` (replace the P5a definition). `.env.e2e` and `.env.e2e-vapid` are covered by the existing `.env*` ignore rule; add `apps/web/e2e/local/.auth/` to `.gitignore` (session files of the a11y spec).

- [ ] **Step 4: One Playwright config for the local stack, type-check coverage, default-run exclusion**

`apps/web/playwright.local.config.ts` (create, or overwrite the P5a file):

```ts
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";
import { parseEnvFile, parseStackStatus } from "../../tools/lib/e2e-env.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const status = parseStackStatus(
  execSync("bunx supabase status -o json", { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }),
);
const envFile = fileURLToPath(new URL("../../supabase/functions/.env.e2e", import.meta.url));
const functionsEnv = existsSync(envFile) ? parseEnvFile(readFileSync(envFile, "utf8")) : {};

// Values the specs and the dev server need. The service key is used by the specs only (API calls), never by the browser bundle.
process.env.VITE_SUPABASE_URL = status.url;
process.env.VITE_SUPABASE_ANON_KEY = status.anonKey;
process.env.VITE_SITE_URL = "http://localhost:5173";
process.env.VITE_VAPID_PUBLIC_KEY = functionsEnv.VAPID_PUBLIC_KEY ?? "";
process.env.E2E_SUPABASE_URL = status.url;
process.env.E2E_SERVICE_ROLE_KEY = status.serviceKey;
process.env.E2E_CRON_SECRET = functionsEnv.CRON_SHARED_SECRET ?? "local-dev-cron-secret";

const inherited = Object.fromEntries(
  Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
);

// The Vite dev server on the one origin the local auth allow-list knows (http://localhost:5173): stop any other dev server first.
// One worker: the specs share one database and the 60 s and 10 minute cooldowns.
export default defineConfig({
  testDir: "./e2e/local",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: "list",
  use: { baseURL: "http://localhost:5173", trace: "on-first-retry", serviceWorkers: "block" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "bun run dev",
    url: "http://localhost:5173",
    reuseExistingServer: false,
    timeout: 60_000,
    env: inherited,
  },
});
```

`apps/web/tsconfig.e2e.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "lib": ["ES2023", "DOM"], "types": ["node"], "noEmit": true },
  "include": ["e2e", "playwright.config.ts", "playwright.local.config.ts"]
}
```

Append `&& tsc -p apps/web/tsconfig.e2e.json --noEmit` to the root `typecheck` script (before `bun run tools/check-core-purity.ts`), and remove from the root `tsconfig.json` `include` the entries `apps/web/playwright.local.config.ts` and `apps/web/e2e/auth.spec.ts` that P5a added (the moved files no longer exist there).

In `apps/web/playwright.config.ts` (the default production-build run) remove P4's `const LOCAL = Boolean(process.env.E2E_LOCAL);` line and make the ignore unconditional: `testIgnore: ["**/local/**"],`. Keep the second `webServer` that Task 1 added.

- [ ] **Step 5: Move the three existing specs and update their headers**

```powershell
git mv apps/web/e2e/local/overview.local.spec.ts apps/web/e2e/local/10-overview.local.spec.ts
git mv apps/web/e2e/auth.spec.ts apps/web/e2e/local/20-auth.local.spec.ts
git mv apps/web/e2e/local/handoff.local.spec.ts apps/web/e2e/local/60-handoff.local.spec.ts
```

In `10-overview.local.spec.ts` and `60-handoff.local.spec.ts` replace the header comment block that describes the setup with this one (the environment variables the specs read are now set by `playwright.local.config.ts`, so the PowerShell lines that exported them are dropped):

```ts
/**
 * Local-stack end-to-end spec (P7 Task 4). Setup, once per session (PowerShell, repository root):
 *   bun run e2e:setup        # supabase start, db reset, fixture scan, users, fixture Flex statement, research report
 *   bun run e2e:serve        # second terminal: Edge Functions with supabase/functions/.env.e2e
 *   bun run test:e2e:local   # ensures the seed, starts the Vite dev server on 5173, runs every spec in e2e/local
 * The service-role key reaches these specs through E2E_SERVICE_ROLE_KEY and never reaches the browser bundle.
 */
```

In `20-auth.local.spec.ts` add `import { OWNER, signIn } from "./support/stack";` at the top and append:

```ts
test("every guarded route redirects a signed-out visitor to sign-in and never renders the page", async ({ page }) => {
  for (const path of ["/portfolio", "/analytics", "/profile/security", "/profile/broker", "/profile/notifications"]) {
    await page.goto(path);
    await page.waitForURL(/\/auth\/sign-in/);
    expect(new URL(page.url()).searchParams.get("next")).toBe(path);
    await expect(page.getByRole("heading", { level: 1, name: /^(Portfolio|Analytics)$/ })).toHaveCount(0);
  }
});

test("the e2e owner opens every guarded page after signing in", async ({ page }) => {
  await signIn(page, OWNER);
  await expect(page).toHaveURL("/");
  const pages = [
    ["/portfolio", "Portfolio"],
    ["/analytics", "Analytics"],
    ["/profile/security", "Security"],
    ["/profile/broker", "Broker"],
    ["/profile/notifications", "Notifications"],
  ] as const;
  for (const [path, heading] of pages) {
    await page.goto(path);
    await expect(page.getByRole("heading", { name: heading }).first()).toBeVisible();
  }
});
```

(The moved P5a spec creates its own random users through the UI; keep that. Its sign-up count plus the sign-ins of the other specs stays below the local limit of 30 sign-ins per 5 minutes per IP configured in `supabase/config.toml`.)

- [ ] **Step 6: Shared support code**

`apps/web/e2e/local/support/stack.ts`:

```ts
import { randomUUID } from "node:crypto";
import { type APIRequestContext, expect, type Page, request } from "@playwright/test";
import { E2E_PASSWORD, OTHER_EMAIL, OWNER_EMAIL } from "../../../../../tools/lib/e2e-env.ts";

export const API = process.env.E2E_SUPABASE_URL ?? process.env.VITE_SUPABASE_URL ?? "http://127.0.0.1:54321";
export const ANON = process.env.VITE_SUPABASE_ANON_KEY ?? "";
export const SERVICE = process.env.E2E_SERVICE_ROLE_KEY ?? "";
export const OWNER = { email: OWNER_EMAIL, password: E2E_PASSWORD };
export const OTHER = { email: OTHER_EMAIL, password: E2E_PASSWORD };
export const FAKE_PUSH_ENDPOINT = `https://push.example.test/e2e/${randomUUID()}`;

export function api(key: string, bearer: string = key): Promise<APIRequestContext> {
  return request.newContext({
    baseURL: API,
    extraHTTPHeaders: { apikey: key, Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
  });
}

/** A user's access token through the password grant (for direct REST probes). */
export async function accessToken(who: { email: string; password: string }): Promise<string> {
  const ctx = await request.newContext({ baseURL: API, extraHTTPHeaders: { apikey: ANON, "Content-Type": "application/json" } });
  const res = await ctx.post("/auth/v1/token?grant_type=password", { data: who });
  expect(res.ok(), `password grant for ${who.email}`).toBe(true);
  const token = ((await res.json()) as { access_token: string }).access_token;
  await ctx.dispose();
  return token;
}

export async function userId(email: string): Promise<string> {
  const svc = await api(SERVICE);
  const res = await svc.get("/auth/v1/admin/users?per_page=200");
  const users = ((await res.json()) as { users: Array<{ id: string; email?: string }> }).users;
  await svc.dispose();
  const found = users.find((u) => u.email === email);
  expect(found, `user ${email} exists (run bun run e2e:setup)`).toBeTruthy();
  return found?.id ?? "";
}

export async function signIn(page: Page, who: { email: string; password: string } = OWNER, next?: string): Promise<void> {
  await page.goto(next === undefined ? "/auth/sign-in" : `/auth/sign-in?next=${encodeURIComponent(next)}`);
  await page.getByLabel("Email").fill(who.email);
  await page.getByLabel("Password", { exact: true }).fill(who.password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

/** Requests to the local API that are not reads: proves "no write path" claims. */
export function trackWrites(page: Page): string[] {
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
  return writes;
}

/** Uncaught page errors fail the test that installed this. */
export function pageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  return errors;
}
```

`apps/web/e2e/local/support/push-mock.ts` (a fake Push API in the page: Chromium cannot reach a real push service from a test; the `push-subscribe` function is the real one and accepts the endpoint because the e2e env sets `PUSH_ENDPOINT_EXTRA_HOSTS=push.example.test`):

```ts
import type { Page } from "@playwright/test";

export async function installFakePush(page: Page, endpoint: string): Promise<void> {
  await page.addInitScript((ep: string) => {
    const bytes = (length: number, fill: number) => new Uint8Array(length).fill(fill);
    const b64url = (u8: Uint8Array) =>
      btoa(String.fromCharCode(...u8)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const p256dh = b64url(bytes(65, 4));
    const auth = b64url(bytes(16, 7));
    let current: unknown = null;
    const subscription = () => ({
      endpoint: ep,
      expirationTime: null,
      getKey: (name: string) => (name === "p256dh" ? bytes(65, 4).buffer : name === "auth" ? bytes(16, 7).buffer : null),
      toJSON: () => ({ endpoint: ep, expirationTime: null, keys: { p256dh, auth } }),
      unsubscribe: async () => {
        current = null;
        return true;
      },
    });
    const pushManager = {
      getSubscription: async () => current,
      subscribe: async () => {
        current = subscription();
        return current;
      },
      permissionState: async () => "granted",
    };
    const registration = { pushManager, scope: "/", active: {}, addEventListener() {}, removeEventListener() {} };
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: {
        ready: Promise.resolve(registration),
        register: async () => registration,
        getRegistration: async () => registration,
        addEventListener() {},
        removeEventListener() {},
        controller: null,
      },
    });
    Object.defineProperty(window, "PushManager", { configurable: true, value: function PushManager() {} });
    Object.defineProperty(window, "Notification", {
      configurable: true,
      value: Object.assign(function Notification() {}, { permission: "granted", requestPermission: async () => "granted" }),
    });
  }, endpoint);
}
```

- [ ] **Step 7: The new specs**

`apps/web/e2e/local/30-profile.local.spec.ts`:

```ts
import { expect, test } from "@playwright/test";
import { OTHER, OWNER, pageErrors, signIn } from "./support/stack";

test("Profile pages render for a signed-in user and the broker form never autocompletes the Flex token", async ({ page }) => {
  const errors = pageErrors(page);
  await signIn(page, OTHER);
  await expect(page).toHaveURL("/");
  for (const [path, heading] of [["/profile/security", "Security"], ["/profile/broker", "Broker"], ["/profile/notifications", "Notifications"]] as const) {
    await page.goto(path);
    await expect(page.getByRole("heading", { name: heading }).first()).toBeVisible();
  }
  await page.goto("/profile/broker");
  const token = page.getByLabel(/flex token/i);
  await expect(token).toHaveAttribute("autocomplete", "off");
  await expect(token).toHaveValue("");
  expect(errors).toEqual([]);
});

test("the linked owner's broker page never shows token material", async ({ page }) => {
  await signIn(page, OWNER);
  await page.goto("/profile/broker");
  await expect(page.getByText(/linked/i).first()).toBeVisible();
  const html = await page.content();
  expect(html).not.toMatch(/flex_token|ciphertext|FLEX_ENC/i);
});
```

`apps/web/e2e/local/35-isolation.local.spec.ts` (API level, no UI):

```ts
import { expect, test } from "@playwright/test";
import { accessToken, ANON, api, OTHER, OWNER } from "./support/stack";

async function rows(res: { ok(): boolean; json(): Promise<unknown> }): Promise<unknown[]> {
  return res.ok() ? ((await res.json()) as unknown[]) : [];
}

test("the owner reads the fixture statement; another user and anon read nothing", async () => {
  const owner = await api(ANON, await accessToken(OWNER));
  const other = await api(ANON, await accessToken(OTHER));
  const anon = await api(ANON);
  for (const table of ["broker_positions", "broker_trades", "broker_nav", "broker_sync_runs"]) {
    const mine = await rows(await owner.get(`/rest/v1/${table}?select=user_id&limit=5`));
    expect(mine.length, `${table} rows for the owner`).toBeGreaterThan(0);
    expect(await rows(await other.get(`/rest/v1/${table}?select=user_id&limit=5`)), `${table} for another user`).toEqual([]);
    expect(await rows(await anon.get(`/rest/v1/${table}?select=user_id&limit=5`)), `${table} for anon`).toEqual([]);
  }
});

test("secret columns and admin functions are closed", async () => {
  const owner = await api(ANON, await accessToken(OWNER));
  const anon = await api(ANON);
  expect((await owner.get("/rest/v1/broker_connections?select=*")).ok(), "select * on broker_connections").toBe(false);
  expect((await owner.get("/rest/v1/broker_connections?select=status")).ok()).toBe(true);
  expect((await owner.get("/rest/v1/push_subscriptions?select=endpoint,p256dh,auth")).ok(), "push key columns").toBe(false);
  expect((await anon.post("/rest/v1/rpc/is_admin", { data: {} })).ok(), "anon executes is_admin").toBe(false);
  const ownerAdmin = await owner.post("/rest/v1/rpc/is_admin", { data: {} });
  expect(await ownerAdmin.json()).toBe(false);
  expect((await owner.patch("/rest/v1/profiles?select=is_admin", { data: { is_admin: true } })).ok(), "self-promotion").toBe(false);
});
```

`apps/web/e2e/local/40-notifications.local.spec.ts`:

```ts
import { expect, test } from "@playwright/test";
import { installFakePush } from "./support/push-mock";
import { accessToken, ANON, api, FAKE_PUSH_ENDPOINT, OWNER, signIn, SERVICE, userId } from "./support/stack";

test.beforeEach(async ({ page }) => {
  await installFakePush(page, FAKE_PUSH_ENDPOINT);
  await signIn(page, OWNER);
  await expect(page).toHaveURL("/");
});

test.afterEach(async () => {
  const svc = await api(SERVICE);
  const id = await userId(OWNER.email);
  await svc.delete(`/rest/v1/push_subscriptions?user_id=eq.${id}`);
  await svc.delete(`/rest/v1/notification_preferences?user_id=eq.${id}`);
  await svc.dispose();
});

test("the push switch subscribes through push-subscribe and unsubscribes again", async ({ page }) => {
  const bodies: string[] = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && r.url().includes("/functions/v1/push-subscribe")) bodies.push(r.postData() ?? "");
  });
  await page.goto("/profile/notifications");
  const push = page.getByRole("switch", { name: "Push notifications on this device" });
  await expect(push).toBeVisible();
  await push.click();
  await expect(push).toBeChecked();
  expect(bodies.some((b) => b.includes('"subscribe"') && b.includes(FAKE_PUSH_ENDPOINT))).toBe(true);

  const owner = await api(ANON, await accessToken(OWNER));
  const safe = (await (await owner.get("/rest/v1/push_subscriptions?select=id,user_agent,revoked_at")).json()) as unknown[];
  expect(safe.length).toBeGreaterThan(0);
  expect((await owner.get("/rest/v1/push_subscriptions?select=endpoint")).ok(), "endpoint column").toBe(false);

  await push.click();
  await expect(push).not.toBeChecked();
  expect(bodies.some((b) => b.includes('"unsubscribe"'))).toBe(true);
});

test("the email and send-empty switches persist across a reload", async ({ page }) => {
  await page.goto("/profile/notifications");
  const email = page.getByRole("switch", { name: "Email notifications" });
  const empty = page.getByRole("switch", { name: "Send empty digests" });
  await expect(email).toBeVisible();
  const before = await email.isChecked();
  await email.click();
  await expect(email).toBeChecked({ checked: !before });
  await empty.click();
  await page.reload();
  await expect(page.getByRole("switch", { name: "Email notifications" })).toBeChecked({ checked: !before });
  await expect(page.getByRole("switch", { name: "Send empty digests" })).toBeChecked({ checked: true });
});
```

`apps/web/e2e/local/50-portfolio-analytics.local.spec.ts`:

```ts
import { expect, test } from "@playwright/test";
import { OTHER, OWNER, pageErrors, signIn } from "./support/stack";

test("the owner's Portfolio shows the fixture positions and a manual refresh that enters its cooldown", async ({ page }) => {
  const errors = pageErrors(page);
  await signIn(page, OWNER);
  await page.goto("/portfolio");
  await expect(page.getByRole("heading", { level: 1, name: "Portfolio" })).toBeVisible();
  await expect(page.getByTestId("positions-table")).toBeVisible();
  const tickers = await page.locator('[data-testid="row-ticker"], [data-testid="card-ticker"]').allTextContents();
  expect(tickers.join(" ")).toMatch(/AAPL/);
  const refresh = page.getByRole("button", { name: /refresh/i }).first();
  await expect(refresh).toBeEnabled();
  await refresh.click();
  await expect(refresh).toBeDisabled();
  expect(errors).toEqual([]);
});

test("the owner's Analytics page renders from the fixture statement", async ({ page }) => {
  const errors = pageErrors(page);
  await signIn(page, OWNER);
  await page.goto("/analytics");
  await expect(page.getByRole("heading", { level: 1, name: "Analytics" })).toBeVisible();
  await expect(page.getByText(/unavailable|error/i)).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("a user without a broker sees the link prompt, not positions", async ({ page }) => {
  await signIn(page, OTHER);
  await page.goto("/portfolio");
  await expect(page.locator('a[href="/profile/broker"]').first()).toBeVisible();
  await expect(page.getByTestId("positions-table")).toHaveCount(0);
});
```

`apps/web/e2e/local/90-a11y-viewports.local.spec.ts`:

```ts
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import { ANON, api, OWNER, signIn } from "./support/stack";

const AUTH_FILE = join(dirname(fileURLToPath(import.meta.url)), ".auth", "owner.json");
const VIEWPORTS = [
  { name: "360", width: 360, height: 740 },
  { name: "1280", width: 1280, height: 800 },
] as const;

async function firstCardSymbol(): Promise<string> {
  const ctx = await api(ANON);
  const res = await ctx.post("/rest/v1/rpc/todays_discounts_feed", { data: { p_mode: "worldwide" } });
  const rows = (await res.json()) as Array<{ yahoo_symbol: string }>;
  await ctx.dispose();
  return rows[0]?.yahoo_symbol ?? "AAPL";
}
async function firstReportId(): Promise<string | null> {
  const ctx = await api(ANON);
  const res = await ctx.get("/rest/v1/research_reports?select=id&status=eq.complete&limit=1");
  const rows = res.ok() ? ((await res.json()) as Array<{ id: string }>) : [];
  await ctx.dispose();
  return rows[0]?.id ?? null;
}

async function checkPage(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await page.waitForLoadState("networkidle");
  await expect(page.getByRole("heading").first()).toBeVisible();
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  const blocking = results.violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map((v) => ({ id: v.id, impact: v.impact, targets: v.nodes.map((n) => n.target) }));
  expect(blocking, path).toEqual([]);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, `${path}: horizontal page scroll`).toBeLessThanOrEqual(1);
}

for (const viewport of VIEWPORTS) {
  for (const scheme of viewport.name === "1280" ? (["light", "dark"] as const) : (["light"] as const)) {
    test.describe(`${viewport.name}px ${scheme}`, () => {
      test.use({ viewport: { width: viewport.width, height: viewport.height }, colorScheme: scheme });

      test("public pages", async ({ page }) => {
        const symbol = await firstCardSymbol();
        for (const path of ["/", `/quotes?symbol=${encodeURIComponent(symbol)}`, "/about", "/auth/sign-in", "/auth/sign-up"]) {
          await checkPage(page, path);
        }
        const report = await firstReportId();
        if (report !== null) await checkPage(page, `/research/${report}`);
      });

      test.describe("signed in", () => {
        test.beforeAll(async ({ browser }) => {
          mkdirSync(dirname(AUTH_FILE), { recursive: true });
          const context = await browser.newContext();
          const page = await context.newPage();
          await signIn(page, OWNER);
          await expect(page).toHaveURL("/");
          await context.storageState({ path: AUTH_FILE });
          await context.close();
        });
        test.use({ storageState: AUTH_FILE });

        test("guarded pages", async ({ page }) => {
          for (const path of ["/portfolio", "/analytics", "/profile/security", "/profile/broker", "/profile/notifications"]) {
            await checkPage(page, path);
          }
        });
      });
    });
  }
}
```

Run `bun run lint:fix`, `bun run lint`, `bun run typecheck` (the new `tsconfig.e2e.json` project must pass; the DOM-typed `page.evaluate` callbacks compile there).

- [ ] **Step 8: Reconcile selectors with the real components (read, then fix the spec, not the app)**

The specs use labels and test ids that the phase plans define; confirm each one in the implemented code before the first run, and change the spec to the real text when a phase deviated:

| Selector used | Defined by | Check |
|---|---|---|
| `getByLabel("Email")`, `"Password"`, button `"Sign in"` | P5a Task 4 | `git grep -n "Sign in" -- apps/web/src/features/auth` |
| headings `Portfolio`, `Analytics`, `Security`, `Broker`, `Notifications` | P5a Task 5, P5b Tasks 6 to 8 | `git grep -n -E "<h1|<h2" -- apps/web/src/features/portfolio apps/web/src/features/profile` |
| `positions-table`, `row-ticker`, `card-ticker` | P5b Task 7 | `git grep -n "positions-table" -- apps/web/src` |
| button `/refresh/i` and its disabled countdown | P5b Task 7 | `git grep -n -i "refresh" -- apps/web/src/features/portfolio` |
| switches `Push notifications on this device`, `Email notifications`, `Send empty digests` | P3 Task 6 | `git grep -n "aria-label=" -- apps/web/src/features/notifications` |
| `getByLabel(/flex token/i)` and its `autocomplete="off"` | P5b Task 6 | `git grep -n "autoComplete" -- apps/web/src/features/profile` |
| `todays_discounts_feed` rows with `yahoo_symbol`, report route `/research/<id>` | P4 Task 1, P2 Task 7 | `git grep -n "research/" -- apps/web/src/router.tsx` |
| `toHaveText("Trade on IBKR")`, `trade-dialog`, `no-order-notice`, `ibot-prompt` | P6 Task 5 | already in the moved `60-handoff` spec |

The fake push subscription implements both `toJSON()` and `getKey()`; if the notifications component reads the subscription differently (for example `sub.endpoint` plus `sub.getKey("p256dh")` only), adjust `push-mock.ts` to expose exactly what it reads.

- [ ] **Step 9: Run the whole suite**

```powershell
bun run supabase:start
bun run e2e:setup
```

In a second terminal: `bun run e2e:serve` (the setup script waits up to 90 s for the functions; start the serve terminal as soon as the script prints that it is waiting). When the setup prints `{"ok":true,...}`:

```powershell
bun run test:e2e:local
bun run test:e2e
```

Expected: `test:e2e:local` runs the moved overview spec, the auth spec (original tests plus the two guard tests), profile (2), isolation (2), notifications (2), portfolio and analytics (3), hand-off, and the accessibility matrix (public and signed-in pages at 360 px light, 1280 px light and 1280 px dark), all green; `test:e2e` runs P0's smoke tests, the stubbed P4 specs and `csp.spec.ts`, all green and without any `e2e/local` test. Fixes go into the components (a failing axe rule or a horizontal scroll at 360 px is a product bug, including ledger items D-52 and D-53 if they are the cause), never into weaker assertions. Save the final output of both commands for Task 6 (`tools/verify-all.ts` captures it again).

Spec 17.5 coverage map (also copied into `p7-results.md`): item 1 and 2 `10-overview`; 3 `10-overview` (Show on graph, links, attribution); 4 (range buttons, indicator toggle) the stubbed P4 chart specs in `test:e2e`; 5 and 6 `20-auth`; 7 `50-portfolio-analytics`; 8 `60-handoff`; 9 (theme persists) P0 `smoke.spec.ts`; 10 (keyboard) P4 `keyboard.spec.ts`; 11 `90-a11y-viewports` and P4 `a11y.spec.ts`.

- [ ] **Step 10: Commit**

```text
git add tools/lib/e2e-env.ts tools/lib/e2e-env.test.ts tools/e2e-setup.ts apps/web/playwright.local.config.ts apps/web/playwright.config.ts apps/web/tsconfig.e2e.json apps/web/e2e apps/web/package.json package.json tsconfig.json .gitignore
git commit -m "test(e2e): consolidate the local-stack Playwright suite with one config, a documented setup script and the full flow set"
```

---

## Task 5: Operator guide and README completion

**Concurrency:** parallel with Task 4 (no shared files except root `package.json` scripts; re-read before editing). It needs Task 1's names (`check:secrets`, the rate limits, the kill switch, `keepalive`, the headers) and the guide sections that P2 (section 9), P3 (section 4 and 12.1), P5a (section 3), P5b (sections 5 and 10) and P6 (the hand-off section) already wrote.

**Files:**
- Create: `tools/lib/guide-check.ts`, `tools/lib/guide-check.test.ts`, `tools/check-operator-guide.ts`, `tools/lib/gen-secret.ts`, `tools/lib/gen-secret.test.ts`, `tools/gen-secret.ts`
- Modify: `docs/operator-guide.md`, `README.md`, `package.json` (scripts `check:guide`, `gen:secret`), `.github/workflows/ci.yml` (one step), `.gitignore` (`backups/`)

**Interfaces:**
- Consumes: the current `docs/operator-guide.md` (sections 0 to 13 from P0, filled in part by P2, P3, P5a, P5b, P6), `tools/lib/secret-names.ts` (Task 1), the code names of every secret (read from `git grep` output in step 1).
- Produces: `guideProblems(text)`; `bun run check:guide`; `generateSecret(bytes, format, random?)`; `bun run gen:secret`; the finished guide (every section filled, the secret and variable inventory, rotation calendar, incident runbooks, production cut-over and drills); the finished README.

- [ ] **Step 1: Read the current state and the real names**

```powershell
Select-String -Path docs/operator-guide.md -Pattern '^## ' | ForEach-Object { $_.Line }
git grep -n -E 'pending' -- docs/operator-guide.md
git grep -h -o -E '(Deno\.env\.get|requireEnv)\("[A-Z][A-Z0-9_]+"\)' -- supabase/functions ':!*.test.ts' | Sort-Object -Unique
```

Expected: the section headings 0 to 13 plus the P6 hand-off section (numbered 14 by P6); the `pending` hits are the headings of sections 1, 7, 8, 13 (and any phase that did not fill its own); the third command lists the environment names the code reads. Every name in the third list must appear in the guide before this task ends (`check:secrets` enforces it). Note the exact number P6 used for its section: the cut-over section added in step 5 takes the next free number and this plan calls it "Production cut-over and drills".

- [ ] **Step 2: The guide guard (TDD)**

`tools/lib/guide-check.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { guideProblems } from "./guide-check.ts";

const filler = "line one\nline two\nline three\nline four\n";
function guide(over: { drop?: number[]; extra?: string; headings?: Record<number, string> } = {}): string {
  const parts: string[] = [];
  for (let n = 0; n <= 13; n++) {
    if (over.drop?.includes(n)) continue;
    parts.push(`## ${n}. ${over.headings?.[n] ?? `Section ${n} (filled)`}\n\n${filler}`);
  }
  parts.push(`## 15. Production cut-over and drills\n\n${filler}`);
  parts.push(`Names: ${REQUIRED.map((name) => `\`${name}\``).join(" ")}. ALLOW_FIXTURE_PROVIDERS is never set on the hosted project.\n${over.extra ?? ""}`);
  return parts.join("\n");
}
const REQUIRED = [
  "CRON_SHARED_SECRET", "SEC_USER_AGENT", "RATE_LIMIT_SALT", "SITE_URL", "GEMINI_API_KEY", "TAVILY_API_KEY", "JINA_API_KEY",
  "VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_SUBJECT", "RESEND_API_KEY", "EMAIL_FROM", "RESEND_WEBHOOK_SECRET",
  "UNSUBSCRIBE_SECRET", "FLEX_ENC_KEY_V1", "FLEX_USER_AGENT", "ALLOW_FIXTURE_PROVIDERS", "project_url", "worker_tick_secret",
  "SUPABASE_ACCESS_TOKEN", "SUPABASE_DB_PASSWORD", "SUPABASE_PROJECT_REF", "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID",
  "VITE_SUPABASE_URL", "VITE_SUPABASE_ANON_KEY", "VITE_SITE_URL", "VITE_VAPID_PUBLIC_KEY", "KEEPALIVE_EMAIL", "KEEPALIVE_PASSWORD",
  "KEEPALIVE_ENABLED",
];

describe("guideProblems", () => {
  it("accepts a complete guide", () => {
    expect(guideProblems(guide())).toEqual([]);
  });
  it("flags a missing section, a pending heading and an empty section", () => {
    expect(guideProblems(guide({ drop: [7] })).join("\n")).toMatch(/section 7 is missing/);
    expect(guideProblems(guide({ headings: { 1: "Data provider (pending P1)" } })).join("\n")).toMatch(/pending/);
    expect(guideProblems(guide().replace(filler, "x\n")).join("\n")).toMatch(/has no content/);
  });
  it("flags an undocumented name, a stale name and a leaked secret shape", () => {
    expect(guideProblems(guide().replace("`FLEX_ENC_KEY_V1`", "")).join("\n")).toMatch(/FLEX_ENC_KEY_V1/);
    expect(guideProblems(guide({ extra: "use UNSUBSCRIBE_SIGNING_KEY" })).join("\n")).toMatch(/stale name UNSUBSCRIBE_SIGNING_KEY/);
    expect(guideProblems(guide({ extra: "token eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.c2lnbmF0dXJlc2lnbmF0dXJl" })).join("\n")).toMatch(/secret/);
  });
  it("requires the warning that fixture providers are never hosted", () => {
    expect(guideProblems(guide().replace("is never set on", "is set on")).join("\n")).toMatch(/ALLOW_FIXTURE_PROVIDERS/);
  });
});
```

`tools/lib/guide-check.ts`:

```ts
export const REQUIRED_NAMES = [
  "CRON_SHARED_SECRET", "SEC_USER_AGENT", "RATE_LIMIT_SALT", "SITE_URL", "GEMINI_API_KEY", "TAVILY_API_KEY", "JINA_API_KEY",
  "VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_SUBJECT", "RESEND_API_KEY", "EMAIL_FROM", "RESEND_WEBHOOK_SECRET",
  "UNSUBSCRIBE_SECRET", "FLEX_ENC_KEY_V1", "FLEX_USER_AGENT", "ALLOW_FIXTURE_PROVIDERS", "project_url", "worker_tick_secret",
  "SUPABASE_ACCESS_TOKEN", "SUPABASE_DB_PASSWORD", "SUPABASE_PROJECT_REF", "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID",
  "VITE_SUPABASE_URL", "VITE_SUPABASE_ANON_KEY", "VITE_SITE_URL", "VITE_VAPID_PUBLIC_KEY", "KEEPALIVE_EMAIL", "KEEPALIVE_PASSWORD",
  "KEEPALIVE_ENABLED",
] as const;

const STALE: Array<[string, string]> = [
  ["UNSUBSCRIBE_SIGNING_KEY", "UNSUBSCRIBE_SECRET"],
  ["RESEND_FROM", "EMAIL_FROM"],
];

const SECRET_SHAPES: RegExp[] = [
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  /sb_secret_[A-Za-z0-9_-]{8,}/,
  /\bre_[A-Za-z0-9]{20,}/,
  /whsec_[A-Za-z0-9+/=]{20,}/,
  /AIza[0-9A-Za-z_-]{30,}/,
  /tvly-[A-Za-z0-9]{10,}/,
];

interface Section {
  heading: string;
  body: string;
}

function sections(text: string): Section[] {
  const out: Section[] = [];
  let current: Section | null = null;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("## ")) {
      current = { heading: line.slice(3).trim(), body: "" };
      out.push(current);
    } else if (current !== null) {
      current.body += `${line}\n`;
    }
  }
  return out;
}

export function guideProblems(text: string): string[] {
  const problems: string[] = [];
  const all = sections(text);
  for (let n = 0; n <= 13; n++) {
    if (!all.some((s) => new RegExp(`^${n}\\.`).test(s.heading))) problems.push(`section ${n} is missing`);
  }
  if (!all.some((s) => /^\d+\.\s*Production cut-over and drills/i.test(s.heading))) {
    problems.push("the section 'Production cut-over and drills' is missing");
  }
  for (const s of all) {
    if (/pending/i.test(s.heading)) problems.push(`section "${s.heading}" is still marked pending`);
    if (s.body.split("\n").filter((l) => l.trim() !== "").length < 4) problems.push(`section "${s.heading}" has no content`);
  }
  for (const name of REQUIRED_NAMES) if (!text.includes(name)) problems.push(`the name ${name} is not documented`);
  for (const [stale, real] of STALE) if (text.includes(stale)) problems.push(`stale name ${stale} (the code uses ${real})`);
  if (!/ALLOW_FIXTURE_PROVIDERS[^\n]*never|never[^\n]*ALLOW_FIXTURE_PROVIDERS/i.test(text)) {
    problems.push("ALLOW_FIXTURE_PROVIDERS must be documented as never set on the hosted project");
  }
  if (SECRET_SHAPES.some((re) => re.test(text))) problems.push("the guide contains a string shaped like a secret");
  return problems;
}
```

`tools/check-operator-guide.ts`:

```ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { guideProblems } from "./lib/guide-check.ts";

const file = fileURLToPath(new URL("../docs/operator-guide.md", import.meta.url));
const problems = guideProblems(readFileSync(file, "utf8"));
if (problems.length > 0) {
  for (const problem of problems) console.error(`check:guide: ${problem}`);
  process.exit(1);
}
console.log("check:guide: OK");
```

Root scripts: `"check:guide": "bun run tools/check-operator-guide.ts"`, `"gen:secret": "bun run tools/gen-secret.ts"`. Add `- run: bun run check:guide` to the `web` job of `ci.yml`. Run `bun run test:tools guide-check` (fails first, then passes), then `bun run check:guide`: it must fail now and list exactly the gaps that steps 4 to 7 close (sections pending, missing names).

- [ ] **Step 3: Secret generator (TDD) used by the guide**

`tools/lib/gen-secret.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { generateSecret } from "./gen-secret.ts";

describe("generateSecret", () => {
  const random = (n: number) => new Uint8Array(n).fill(255);
  it("encodes the requested number of bytes", () => {
    expect(generateSecret(32, "hex", random)).toBe("ff".repeat(32));
    expect(Buffer.from(generateSecret(32, "base64", random), "base64")).toHaveLength(32);
    expect(generateSecret(3, "base64url", random)).toBe("____");
  });
  it("rejects a size below 16 bytes and an unknown format", () => {
    expect(() => generateSecret(8, "hex", random)).toThrow(/16/);
    expect(() => generateSecret(32, "base32" as never, random)).toThrow(/format/);
  });
});
```

`tools/lib/gen-secret.ts`:

```ts
import { randomBytes } from "node:crypto";

export type SecretFormat = "base64" | "base64url" | "hex";

export function generateSecret(
  bytes: number,
  format: SecretFormat,
  random: (n: number) => Uint8Array = (n) => randomBytes(n),
): string {
  if (!Number.isInteger(bytes) || bytes < 16) throw new Error("a secret needs at least 16 bytes");
  if (format !== "base64" && format !== "base64url" && format !== "hex") throw new Error(`unknown format ${String(format)}`);
  return Buffer.from(random(bytes)).toString(format);
}
```

`tools/gen-secret.ts`:

```ts
import { generateSecret, type SecretFormat } from "./lib/gen-secret.ts";

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
// bun run gen:secret                       32 random bytes, base64url (CRON_SHARED_SECRET, RATE_LIMIT_SALT, UNSUBSCRIBE_SECRET)
// bun run gen:secret -- --format base64    base64 of 32 bytes (FLEX_ENC_KEY_Vn must be exactly 32 bytes in base64)
console.log(generateSecret(Number(flag("bytes") ?? "32"), (flag("format") ?? "base64url") as SecretFormat));
```

Run `bun run test:tools gen-secret`.

- [ ] **Step 4: Sections 1, 2, 7 and 8 of the guide**

In `docs/operator-guide.md` replace the heading `## 1. Configure and validate the data provider (pending P1)` and its body with the first block, the whole of section 2 with the second, and sections 7 and 8 with the third and fourth. Keep every other section as the phases wrote it.

````markdown
## 1. Configure and validate the data provider (filled in P7)

Market data comes from Yahoo Finance through the unofficial `yahoo-finance2` library, behind a provider interface
(`supabase/functions/_shared/adapters/providers.ts`); FX rates come from Frankfurter with Yahoo as the fallback. Nothing needs an
account or a key.

**Decision record (owner, 2026-10-15, spec 15.5).** Yahoo's terms prohibit automated collection and commercial reuse; the
research verdict was NO-GO; the owner accepted the risk and chose zero cost. Consequences: Yahoo can block or change its endpoints
at any time, a legal notice is possible, and the site states "Market data from Yahoo Finance, delayed, for information only" on
`/about`. If Yahoo objects, stop publishing or switch the provider (only `adapters/yahoo.ts` changes). Open question Q-03 (is a
private public-facing site "commercial") stays with the owner.

**Etiquette built in.** At most 3.3 requests per second, a circuit breaker (5 consecutive 429 or 5xx answers open it for 10 minutes),
a 90-second request budget per function call, one daily sweep, 5-minute quote cache, no per-visitor fan-out.

### 1.1 Validate the provider (after the first deployment and after any Yahoo incident)

```powershell
# health of the function layer (no secrets in the answer)
curl.exe -sS https://<ref>.supabase.co/functions/v1/health
```

```sql
-- FX rows of the latest days (source frankfurter or yahoo); a currency missing for 4 days is flagged stale
select ccy, usd_per_unit, rate_date, source from fx_rates order by rate_date desc, ccy limit 30;
-- Yahoo behaviour of the last scan: breaker, 429s, schema drift
select at, level, event, data from scan_events where event like 'yahoo_%' order by at desc limit 30;
```

Healthy: no `yahoo_breaker_open`, `yahoo_schema_drift` count 0 or small, FX rows dated within 4 days.

### 1.2 The kill switch

Freeze every Yahoo request (the worker reschedules jobs without using attempts, `quotes` serves cached rows or answers 502, the
site keeps showing the last published data with a stale banner):

```powershell
$h = @{ "x-cron-secret" = $env:CRON_SHARED_SECRET }
$body = '{"action":"set_setting","key":"providers","value":{"yahoo_enabled":false},"confirm":true,"reason":"Yahoo blocking requests"}'
Invoke-RestMethod -Method Post -Uri "https://<ref>.supabase.co/functions/v1/scan-control" -Headers $h -ContentType "application/json" -Body $body
```

Switch it back with `"yahoo_enabled":true` and a new reason. Every change is written to `audit_events`. A malformed value never
freezes the site: only an explicit `false` does.

### 1.3 Switching provider

Implement `MarketDataProvider` for the new source (spec 5.1), keep the core untouched, add the host to
`tools/lib/fetch-callsites.ts` (`bun run check:fetch`), update the "Market data from ..." statement on `/about`, and record the
decision here with its date.
````

````markdown
## 2. Configure Supabase, Vault, cron and function secrets (filled in P7)

All commands run from the repository root in PowerShell. Never paste a secret into a file that is committed, into a `VITE_*`
variable or into chat. Generate random values with `bun run gen:secret` (base64url, 32 bytes) and `bun run gen:secret -- --format base64` (for the Flex key).

### 2.1 Create the project and link the repository

1. Supabase dashboard, New project (Free plan, the region closest to you, a strong database password stored in your password
   manager). Note the **project ref** (the 20-letter id in the URL) and the password.
2. Dashboard, Account, Access Tokens: create a token for the CLI and for CI.
3. Link and inspect:

```powershell
bunx supabase login
bunx supabase link --project-ref <ref> --password <database password>
bunx supabase db push --dry-run
```

### 2.2 Push the migrations, then deploy the functions (order matters: database first)

```powershell
bunx supabase db push
bunx supabase functions deploy --project-ref <ref>
```

`supabase/config.toml` sets `verify_jwt = false` for every function (they authenticate in code); `bun run check:functions-config`
guards it. The CLI needs Docker running to bundle functions. Migrations are forward-only (section 13).

### 2.3 Function secrets (set once and on rotation; CI never sets them)

Create `supabase/functions/.env.production` (git-ignored by `.env*`), then delete it after use:

```text
CRON_SHARED_SECRET=<bun run gen:secret>
RATE_LIMIT_SALT=<bun run gen:secret>
SITE_URL=https://<your domain>
SEC_USER_AGENT=Your Name your.email@example.com
```

```powershell
bunx supabase secrets set --env-file supabase/functions/.env.production --project-ref <ref>
bunx supabase secrets list --project-ref <ref>
```

`secrets list` prints names and digests only: compare the names with the inventory in section 13.2. The other secrets are set in the
section that explains them: `GEMINI_API_KEY`, `GEMINI_MODEL`, `TAVILY_API_KEY`, `JINA_API_KEY` (optional), `LLM_*` (section 9);
`VAPID_*`, `RESEND_API_KEY`, `EMAIL_FROM`, `RESEND_WEBHOOK_SECRET`, `UNSUBSCRIBE_SECRET` (section 4); `FLEX_ENC_KEY_V1`,
`FLEX_ENC_KEY_CURRENT`, `FLEX_USER_AGENT` (section 5). `SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` are
injected by the platform. **`ALLOW_FIXTURE_PROVIDERS`, `FLEX_FIXTURE_MODE` and `PUSH_ENDPOINT_EXTRA_HOSTS` are local-only and are never set on the hosted project.**

### 2.4 Vault secrets and the cron jobs

The minute tick and the daily jobs read two Vault secrets. Run once in the SQL editor (Dashboard, SQL), using the same value as
`CRON_SHARED_SECRET` for the second one:

```sql
select vault.create_secret('https://<ref>.supabase.co', 'project_url');
select vault.create_secret('<the CRON_SHARED_SECRET value>', 'worker_tick_secret');
```

To change one later: `select vault.update_secret(id, '<new value>') from vault.secrets where name = 'worker_tick_secret';` and set
the function secret to the same value in the same minute (the tick fails with 401 for that minute otherwise, which is harmless).
`app.kick_workers()` does nothing until both exist. Verify the schedule:

```sql
select jobname, schedule, active from cron.job order by jobname;
select jobname, status, start_time from cron.job_run_details order by start_time desc limit 10;
```

Expected jobs: `scan-start-0700`, `scan-start-0800`, `scan-catchup`, `tick-minute`, `purge-cron-history`, plus the retention and
notification jobs the later phases added.

### 2.5 Local function secrets

`Copy-Item supabase/functions/.env.example supabase/functions/.env`, fill the names, then `bun run supabase:serve`. For the
end-to-end suite use `bun run e2e:setup` and `bun run e2e:serve` (section 0), which write and use `supabase/functions/.env.e2e`.
````

````markdown
## 7. Run a safe manual scan (filled in P7)

A scan is idempotent per Europe/Sofia date: starting it again does not create a second run for the same date (spec 7.11), and a
scan never changes anything that a re-run would not recompute.

**Locally with recorded data (safe, no network):**

```powershell
bun run supabase:start
bun run supabase:serve                                   # second terminal
bun run scan:local -- start --mode fixture
bun run scan:local -- tick --max-minutes 20
bun run scan:local -- status
bun run scan:local -- failures
```

Fixture mode is refused unless the Supabase URL is local (spec 7.12).

**On the hosted project (live Yahoo data):**

```powershell
$h = @{ "x-cron-secret" = $env:CRON_SHARED_SECRET }
Invoke-RestMethod -Method Post -Uri "https://<ref>.supabase.co/functions/v1/scan-control" -Headers $h -ContentType "application/json" -Body '{"action":"start","provider_mode":"live"}'
```

The minute tick (`pg_cron`) then works through the stages; nothing else is needed. A full worldwide scan takes tens of minutes.
Do the first one on a weekday afternoon when you can watch it (section 8). Other actions of `scan-control`: `status`, `list_failures`,
`requeue`, `recompute`, `set_setting`, `override`, `research_now` (section 9).
````

````markdown
## 8. Inspect coverage and failures (filled in P7)

```powershell
$h = @{ "x-cron-secret" = $env:CRON_SHARED_SECRET }
Invoke-RestMethod -Method Post -Uri "https://<ref>.supabase.co/functions/v1/scan-control" -Headers $h -ContentType "application/json" -Body '{"action":"status"}'
Invoke-RestMethod -Method Post -Uri "https://<ref>.supabase.co/functions/v1/scan-control" -Headers $h -ContentType "application/json" -Body '{"action":"list_failures"}'
```

```sql
-- the last runs: status, coverage (processed/total candidates, whether the list was published) and universe sizes
select scan_date_local, status, started_at, finished_at, latest_session_date, coverage, universe_sizes
  from scan_runs order by scan_date_local desc limit 7;

-- jobs that failed or died in the latest run
select stage, key, status, attempts, last_error from scan_jobs
 where scan_run_id = (select id from scan_runs order by scan_date_local desc limit 1) and status in ('failed', 'dead')
 order by stage, key limit 50;

-- recent events (counts, durations, reason codes; never secrets)
select at, level, event, data from scan_events order by at desc limit 50;
```

How to read it: `complete` is the goal; `partial` means some candidates stayed unprocessed (the list is published only at 95% or more
of candidates, the site shows the coverage panel); `failed` means nothing was published and the site shows the last good data with a
banner. A `dead` job exhausted its attempts: read `last_error`, fix the cause, then `{"action":"requeue"}` to try the dead and failed
jobs again, or `{"action":"recompute"}` to re-derive results from stored series. The incident runbooks are in section 13.4.
````

- [ ] **Step 5: Sections 6 and 11 amendments, section 12, section 13 and the new cut-over section**

Section 6, step 6: replace the sentence that says the Content-Security-Policy is report-only with:

````markdown
6. The Content-Security-Policy in `apps/web/public/_headers` is enforced. `__SUPABASE_ORIGIN__` is replaced after every build with the
   origin of `VITE_SUPABASE_URL` (`bun run render:headers`, verified by `bun run check:headers`); the deploy workflow therefore
   needs no manual edit. Strict-Transport-Security is not in the file: in the Cloudflare dashboard open SSL/TLS, Edge Certificates and
   enable HSTS (max-age at least 6 months, include subdomains only when every subdomain is https). Check the result with
   `curl.exe -sI https://<your domain>` (look for `content-security-policy` and `strict-transport-security`).
````

Section 11: replace the table with the following (keep the introductory sentence, the `production` environment paragraph and the last sentence of the section):

````markdown
| Name | Kind | Used by | Notes |
|---|---|---|---|
| `SUPABASE_ACCESS_TOKEN` | secret | deploy-supabase | personal access token |
| `SUPABASE_DB_PASSWORD` | secret | deploy-supabase | project database password |
| `SUPABASE_PROJECT_REF` | variable | deploy-supabase | 20-letter project id |
| `CLOUDFLARE_API_TOKEN` | secret | deploy-web | scoped to Workers edit |
| `CLOUDFLARE_ACCOUNT_ID` | secret | deploy-web | |
| `VITE_SUPABASE_URL` | variable | deploy-web | `https://<ref>.supabase.co`; also the only non-self origin in the CSP |
| `VITE_SUPABASE_ANON_KEY` | variable | deploy-web | publishable (anon) key, public by design |
| `VITE_SITE_URL` | variable | deploy-web | public site URL, https |
| `VITE_VAPID_PUBLIC_KEY` | variable | deploy-web | public Web Push key (section 4.1) |
| `KEEPALIVE_SUPABASE_URL` | variable | keepalive | same as `VITE_SUPABASE_URL` |
| `KEEPALIVE_ANON_KEY` | variable | keepalive | same as `VITE_SUPABASE_ANON_KEY` |
| `KEEPALIVE_EMAIL` | secret | keepalive | dedicated low-privilege confirmed user |
| `KEEPALIVE_PASSWORD` | secret | keepalive | |
| `KEEPALIVE_ENABLED` | variable | keepalive | `true` once the migrations are deployed |
| `KEEPALIVE_MAX_AGE_HOURS` | variable | keepalive | optional, default 36; `0` forces a failure for the drill |
````

Section 12: replace the first paragraph (the one that says the workflow reads one row of `app_settings`) with:

````markdown
A Supabase Free project pauses after a week without enough user database activity (spec 16.4). `keepalive.yml` runs daily at 06:17 UTC
and executes `tools/keepalive.ts`: it signs in as the dedicated user, reads one row of `app_settings` through REST, reads the public
`scan_status` and the `health` function, and fails the job (GitHub emails you) when: the sign-in or the read fails, the last
successful scan or the latest published result is older than 36 hours, the latest published run processed under 90% of its
candidates, `health` is not ok, or the database is above 400 MB. Conditions that `health` does not expose yet (Yahoo breaker open
for more than an hour, more than 5 research candidates deferred two days in a row, email cap reached three days running, more than
20% failed deliveries) are manual checks: run the queries of sections 8, 9 and 4.9 weekly. Run it by hand with the variables of the
workflow: `bun run keepalive`.
````

Replace section 13 (heading and body) with:

````markdown
## 13. Backups, rotations, retention and incident runbooks (filled in P7)

### 13.1 Backups (the Free plan has none)

Reconstructable without a backup: `price_series`, the universe and the results (re-run the sweep), broker records (Flex backfill of
about four calendar years). Not reconstructable: signal episodes and digests (dedupe state), research report history, risk findings,
audit events, users, preferences, push subscriptions and encrypted Flex tokens (users re-register and re-link).

Once a month, from the repository root with Docker running:

```powershell
$env:SUPABASE_DB_PASSWORD = "<database password>"
New-Item -ItemType Directory -Force backups | Out-Null
bunx supabase db dump --linked --data-only --use-copy -f "backups/$(Get-Date -Format yyyy-MM-dd)-data.sql" -x "public.price_series,public.market_cap_snapshots,public.universe_snapshots,public.scan_security_results,public.quote_cache,public.scan_events,public.scan_jobs"
```

The dump contains personal data and encrypted tokens: keep it offline (an encrypted disk or a password manager attachment), never in
the repository (`backups/` is git-ignored) and never in a CI artifact. Restore into a fresh project: `bunx supabase db push`, then
`psql "<connection string>" -f backups/<file>.sql`; per-user rows need their `auth.users` entries, so after a rebuild users sign up
again and the non-per-user tables (episodes, reports, audit) are the value of the dump. A paused project can be restored from the
dashboard within one year. Test the restore into the local stack once (`bunx supabase db reset`, then the `psql` command against
`postgresql://postgres:postgres@127.0.0.1:54322/postgres`) before relying on it.

### 13.2 Secrets and variables inventory, and rotation

| Name | Where it lives | Rotate | If it leaks |
|---|---|---|---|
| `SUPABASE_SERVICE_ROLE_KEY` | platform (functions only) | regenerate in the dashboard, redeploy functions | full database access: rotate at once, read `audit_events` |
| `CRON_SHARED_SECRET` and Vault `worker_tick_secret` | function secret and Vault, same value | yearly or on suspicion; change both together | forged calls only run scheduled work |
| `RATE_LIMIT_SALT` | function secret | yearly; changing it resets all rate-limit buckets | counters become guessable (low impact) |
| `FLEX_ENC_KEY_V<n>`, `FLEX_ENC_KEY_CURRENT` | function secret | add a version, `rekey`, retire the old one (section 5.3) | with database access the stored tokens decrypt: rotate and have users re-issue tokens |
| `FLEX_USER_AGENT`, `SEC_USER_AGENT`, `SITE_URL`, `EMAIL_FROM` | function secret | when the contact or domain changes | none (identification only) |
| `VAPID_PRIVATE_KEY`, `VAPID_PUBLIC_KEY`, `VAPID_SUBJECT` | function secret (public key also `VITE_VAPID_PUBLIC_KEY`) | only on compromise: every subscription is invalidated | an attacker can push to existing subscriptions |
| `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`, `UNSUBSCRIBE_SECRET` | function secret | in Resend, or generate a new random value; a new `UNSUBSCRIBE_SECRET` voids sent unsubscribe links | spam sending, forged unsubscribes |
| `GEMINI_API_KEY`, `TAVILY_API_KEY`, `JINA_API_KEY`, `LLM_ALT_API_KEY` | function secret | in the provider console | quota theft (free tiers, no billing) |
| `SUPABASE_ACCESS_TOKEN`, `SUPABASE_DB_PASSWORD`, `CLOUDFLARE_API_TOKEN` | GitHub secrets | yearly; Cloudflare token scoped to Workers edit | deployment takeover |
| `KEEPALIVE_EMAIL`, `KEEPALIVE_PASSWORD` | GitHub secrets | yearly | the account is a plain user without data |
| User Flex tokens | IBKR | the user, in Client Portal (6 hours to 1 year) | read access to account activity: disable the token at IBKR |

Put a yearly calendar reminder for the rotations. After any rotation run `bun run check:secrets` and `bunx supabase secrets list --project-ref <ref>` and compare names.

### 13.3 Retention and size

`retention-cleanup` (daily 01:30 UTC) deletes expired rows in batches of 5,000 and writes a `cleanup_result` event with per-table counts;
notification data is kept 180 days (section 12.1); `cron.job_run_details` 7 days. It never deletes active episodes, open findings,
referenced digest items, research reports, audit events or broker records. Check the size monthly:

```sql
select pg_size_pretty(pg_database_size(current_database()));
select relname, pg_size_pretty(pg_total_relation_size(relid)) from pg_catalog.pg_statio_user_tables order by pg_total_relation_size(relid) desc limit 10;
```

The alert threshold is 400 MB of the 500 MB Free limit.

### 13.4 Incident runbooks

| Incident | First actions |
|---|---|
| The scan did not run | `select * from cron.job_run_details order by start_time desc limit 10;` Is the project paused (dashboard)? Resume it. Do the Vault secrets exist (section 2.4)? Then `scan-control start` (section 7) and read `scan_events` (section 8). |
| Yahoo blocks requests or the schema drifts | Look for `yahoo_breaker_open` and `yahoo_schema_drift` events; freeze with the kill switch (section 1.2); fix `adapters/yahoo.ts` or switch provider (section 1.3). |
| Research is stuck or deferred | Check quotas and `research_reports.status` (section 9.5); `requeue` dead jobs; raise caps only within the free limits. |
| Push failures spike | Count 404/410 answers in `digest_deliveries`; verify the VAPID keys were not rotated; the user switches push off and on again. |
| E-mail bounces or complaints | Resend dashboard, domain DNS (SPF, DKIM, DMARC), `select type, count(*) from email_events group by 1;` (section 4.9). |
| Flex errors | Map the code with section 5 and spec 12.4: 1012 token expired (user re-links), 1018 rate limit (wait). |
| Suspected secret leak | Rotate it with the table in 13.2, redeploy, read `audit_events` and `scan_events` for the window, rotate dependent secrets (a leaked service-role key means everything). |
| A migration broke something | Migrations are forward-only: write a corrective migration; for a destructive change dump first (13.1). Functions: `git revert` and redeploy. |
| The site is wrong after a deploy | Run the "Deploy web" workflow manually and choose the previous commit or tag in "Use workflow from"; Cloudflare keeps earlier deployments. |
| Account deletion request | `select id, email from auth.users where email = '<address>';` then `delete from auth.users where id = '<id>';` (cascades profile, preferences, subscriptions, broker rows); there is no self-service export or deletion yet (Q-09). |

### 13.5 Rollback summary

Web: redeploy the previous commit. Functions: revert and redeploy; they tolerate the old and the new schema for one release
(expand and contract). Database: corrective migration. Scan data: `recompute`. Settings: set the previous value through `set_setting`
(audited). Secrets: section 13.2.

### 13.6 Public sign-up

Every account can consume the shared e-mail budget (100 per day). After the intended users exist, turn off "Allow new users to sign
up" in Authentication, Sign In / Providers (open question Q-06, the owner decides).
````

Append the new final section (use the number after the last existing one; P6 used 14, so this is 15):

````markdown
## 15. Production cut-over and drills (filled in P7)

Run in order; tick each line when done.

1. [ ] Section 2: project, `supabase link`, `db push`, function secrets, Vault secrets, `functions deploy`; `bunx supabase secrets list` shows every name of 13.2 that applies.
2. [ ] Sections 3 to 5: Google sign-in, VAPID and Resend (domain verified, webhook 2xx), IBKR Flex link for the owner.
3. [ ] Section 11: GitHub secrets and variables; `production` environment with yourself as reviewer; run "Deploy Supabase" once (migrations job waits for approval) and "Deploy web" once.
4. [ ] Section 6: custom domain, HSTS in Cloudflare, `curl.exe -sI https://<your domain>` shows the CSP and HSTS headers.
5. [ ] Section 7: first live scan; section 8: coverage 95% or more; the Overview shows cards or the honest empty state.
6. [ ] Set `KEEPALIVE_ENABLED=true`, run "Keep-alive" manually: green.

Drills (record the date and result of each in `docs/discovery/p7-results.md`, table "Hosted drills"):

| Drill | Steps | Pass when |
|---|---|---|
| Keep-alive failure | set the repository variable `KEEPALIVE_MAX_AGE_HOURS` to `0`, run "Keep-alive" manually, then delete the variable | the run is red, GitHub emails you, the log names the scan age; the next run without the variable is green |
| Kill switch | section 1.2 with `yahoo_enabled` false, open the site, set it back | the site shows the last data with the stale banner; no `yahoo_*` request events during the freeze; scans resume after the switch is back |
| Backup restore | section 13.1 dump, restore into the local stack | row counts of `signal_episodes` and `research_reports` match |
| Secrets comparison | `bunx supabase secrets list --project-ref <ref>` against `bun run check:secrets` and 13.2 | no unexpected name, no missing name |
| Unattended day | leave the project alone for one full day including 10:00 Europe/Sofia | one `complete` scan for the date, digests delivered to the owner's enabled channels, keep-alive green |
| TradingView parity | `bun run parity -- --symbol MSFT` and the procedure of spec 17.6 | `docs/discovery/parity-results.md` filled, all levels within tolerance or explained as data difference |
````

Run `bun run check:guide` (expected `check:guide: OK`) and `bun run check:secrets` (expected OK; if it names an environment variable the code reads that the guide does not mention, document it in the section that owns it and rerun).

- [ ] **Step 6: README**

Replace `README.md` with:

````markdown
# Personal stock screener

A private stock screener. Every day a resumable scan computes the standard-deviation channel of the Pine script `stddevchn.pine` (port in
`supabase/functions/_shared/core/indicator.ts`) for a worldwide universe of large companies, ranks discounted and premium securities,
researches the discounted ones with a free language model that may only cite retrieved documents, and serves the result as a PWA with
Web Push and e-mail digests. A signed-in owner can link a read-only IBKR Flex report to see a portfolio and analytics, and prepare
(never place) an order through a guided hand-off to IBKR's iBot.

## Architecture in one page

```text
Browser (PWA, React 19, Vite 8, TanStack Router and Query, Lightweight Charts)
   | HTTPS, anon key + user JWT, CSP enforced
   v
Supabase (Free)                                         Cloudflare Workers Static Assets
  Postgres 17: RLS on every table, pg_cron, pg_net,      serves the built SPA and _headers
  Vault, pgTAP-tested policies                           (deployed by GitHub Actions)
  Edge Functions (Deno): worker-tick, scan-control, health, quotes, retention-cleanup,
    notify-dispatch, push-subscribe, resend-webhook, notify-unsubscribe, broker-sync, portfolio-refresh
   |                         |                        |
   v                         v                        v
Yahoo Finance, Frankfurter   Gemini, Tavily, Jina,    Resend, Web Push services,
(market data, FX)            SEC EDGAR (research)     IBKR Flex Web Service (read-only)
```

One algorithm source: `supabase/functions/_shared/core` is pure TypeScript shared by the Edge Functions, the web app (`@core/*`) and
the tests. Time and randomness are parameters. Trust boundaries, data flows and the threat model are in spec sections 2 and 15; the
P7 security review is `docs/discovery/security-review.md`.

## Prerequisites (Windows 11 or Linux)

Bun 1.3.x, Node 22.13.1 (`.node-version`), Docker Desktop, Deno 2.x (`npm i -g deno`). The Supabase CLI is a dev dependency
(`bunx supabase ...` or the `supabase:*` scripts).

## Quick start

```text
bun install
bun run dev                   # Vite dev server on http://localhost:5173
bun run supabase:start        # local Supabase stack (Docker)
bun run supabase:serve        # Edge Functions (second terminal)
bun run scan:local -- start --mode fixture   # a scan over recorded data, then: bun run scan:local -- tick
```

Copy `apps/web/.env.example` to `apps/web/.env.local` and `supabase/functions/.env.example` to `supabase/functions/.env`; never commit
real values. After every migration regenerate the database types with `bun run types:gen` (the stack must be running).

## Scripts

| Script | What it does |
|---|---|
| `dev`, `build`, `format`, `lint`, `lint:fix` | Vite dev server; production build (then header rendering, bundle secret scan and header check); Biome |
| `typecheck` | `tsc` for web, core, tools and e2e, plus the core purity check |
| `test`, `test:core`, `test:tools`, `test:web` | Vitest projects (and Deno tests for `test`) |
| `functions:check`, `functions:test`, `functions:selftest` | `deno check`, `deno test` and the self-test of the checker |
| `test:db` | pgTAP suites against the local stack (includes the RLS matrix) |
| `test:integration` | fixture-mode scan, idempotency, rank change, research, notifications, broker, hand-off scenarios |
| `test:e2e` | production build served with its real headers; stubbed Playwright specs and the CSP spec |
| `e2e:setup`, `e2e:serve`, `test:e2e:local` | local-stack Playwright suite: seed, serve functions, run |
| `check:bundle`, `check:headers`, `check:fetch`, `check:secrets`, `check:guide`, `check:functions-config`, `check:auth-config`, `lint:workflows` | the repository guards (spec 15) |
| `audit` | dependency advisories for the workspace and the Edge Function npm packages |
| `probe:ratelimit`, `keepalive` | rate-limit probe and the keep-alive check (run by `keepalive.yml`) |
| `parity` | prints our channel levels for a symbol and date for the TradingView comparison (spec 17.6) |
| `verify:all`, `release:check` | run every suite and store the evidence; pre-release checks |
| `gen:secret`, `gen:vapid`, `gen:icons`, `gen:fixtures:yahoo`, `gen:fixtures:world` | generators |
| `scan:local`, `supabase:start`, `supabase:stop`, `supabase:reset`, `supabase:serve`, `types:gen` | local stack helpers |

## Repository map

```text
apps/web/                    the PWA (src/features/*, src/components, public/_headers, e2e/)
supabase/functions/_shared/core        pure domain code (indicator, bars, eligibility, ranking, episodes, accounting, digest, research)
supabase/functions/_shared/adapters    Yahoo, FX, LLM, search, fetchers, push, e-mail, Flex, logging, rate limits
supabase/functions/<name>/             one Edge Function each (handler.ts, index.ts, deno.json)
supabase/migrations, supabase/tests    SQL migrations and pgTAP suites (0900_rls_matrix is the access matrix)
tools/                       CLIs and their tested logic (tools/lib)
docs/superpowers/specs       the design specification
docs/superpowers/plans       the phase plans P0 to P7
docs/discovery               research, verification records, security review, parity results
docs/operator-guide.md       the runbook
```

## Documents

- Specification: `docs/superpowers/specs/2026-10-15-stock-screener-design.md`
- Plans: `docs/superpowers/plans/` (P0 foundations, P1 engine and pipeline, P2 AI research, P3 notifications, P4 public UI, P5a auth,
  P5b broker and portfolio, P6 IBKR hand-off, P7 hardening and release)
- Runbook: `docs/operator-guide.md`; security review: `docs/discovery/security-review.md`; verification record:
  `docs/discovery/p7-results.md`

## Decisions and disclaimers

- **Market data.** Yahoo Finance through an unofficial library. Yahoo's terms prohibit automated collection and commercial reuse; the
  owner accepted that risk and chose zero cost (spec 15.5). A kill switch freezes all Yahoo requests; the provider interface allows
  replacement. Prices are delayed and for information only.
- **IBKR.** Read-only through the Flex Web Service: no trading permissions, no orders, no IBKR password. Positions are as of the last
  Flex statement (T+1). "Trade on IBKR" only prepares text and a checklist; the user submits in IBKR. `IBIS2` is the owner's own
  destination practice, not an IBKR-documented exchange.
- **AI research.** Free-tier models write text from numbered retrieved documents; quotes are verified against the documents and
  nothing is ever recommended. A "Meets the checks" result is not investment advice; Red and Grey are never presented as cleared.
  Free-tier terms for a public site are an open owner question (Q-04, Q-05).
- **Privacy and security.** The application is not end-to-end encrypted: functions with the service role and the database
  administrator can read stored data. Row level security isolates users; the Flex token is encrypted with a key held only in function
  secrets. No secret is committed; the CI scans the bundle for secrets.
- **No warranty.** This is a personal project, not a financial product; nothing here is investment, tax or legal advice.
````

Add `backups/` to `.gitignore`. Run `bun run lint` (Markdown is outside Biome's scope) and `bun run check:guide`.

- [ ] **Step 7: Commit**

```text
git add docs/operator-guide.md README.md tools/lib/guide-check.ts tools/lib/guide-check.test.ts tools/check-operator-guide.ts tools/lib/gen-secret.ts tools/lib/gen-secret.test.ts tools/gen-secret.ts package.json .github/workflows/ci.yml .gitignore
git commit -m "docs: finish the operator guide and README, add the guide check and the secret generator"
```

---

## Task 6: Verification record, parity tool and release

**Concurrency:** last. It starts when Tasks 1 to 5 are merged and committed; nothing runs in parallel with it.

**Files:**
- Create: `tools/lib/verify-all.ts`, `tools/lib/verify-all.test.ts`, `tools/verify-all.ts`
- Create: `tools/lib/parity.ts`, `tools/lib/parity.test.ts`, `tools/parity-print.ts`
- Create: `tools/lib/release-check.ts`, `tools/lib/release-check.test.ts`, `tools/release-check.ts`
- Create: `docs/discovery/p7-results.md`, `docs/discovery/parity-results.md`, `docs/discovery/p7-evidence/*` (generated)
- Modify: `package.json` (`verify:all`, `parity`, `release:check`), `docs/superpowers/specs/2026-10-15-stock-screener-design.md` (pointers, name corrections, decision rows)

**Interfaces:**
- Consumes: every root script named in the Global Constraints, `computeChannel`, `DEFAULT_SETTINGS` and the threshold helpers of `supabase/functions/_shared/core`, the public RPC `get_price_series`, git.
- Produces: `bun run verify:all` (runs every suite, writes `docs/discovery/p7-evidence/<suite>.txt`, `summary.json`, `summary.md` and refreshes the suite table inside `p7-results.md`), `bun run parity -- --symbol <S> [--as-of <date>]`, `bun run release:check`, the verification record, the tag `v0.1.0-local`.

- [ ] **Step 1: The evidence runner (TDD)**

`tools/lib/verify-all.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { replaceBetweenMarkers, renderTable, selectSuites, summarizeOutput, SUITES } from "./verify-all.ts";

describe("summarizeOutput", () => {
  it("reads Vitest, Deno, pgTAP, Playwright and Biome summaries", () => {
    expect(summarizeOutput("test-tools", " Tests  118 passed (118)\n")).toBe("118 tests passed");
    expect(summarizeOutput("functions-test", "ok | 119 passed | 0 failed (12s)\n")).toBe("119 passed, 0 failed");
    expect(summarizeOutput("test-db", "Files=11, Tests=642,  9 wallclock secs\nResult: PASS\n")).toBe("11 files, 642 tests, PASS");
    expect(summarizeOutput("test-e2e", "  14 passed (21.3s)\n")).toBe("14 passed");
    expect(summarizeOutput("lint", "Checked 412 files in 80ms. No fixes applied.\n")).toBe("412 files checked");
    expect(summarizeOutput("build", "nothing recognisable")).toBe("");
  });
  it("reports failures", () => {
    expect(summarizeOutput("test-web", " Tests  2 failed | 90 passed (92)\n")).toBe("2 failed, 90 passed");
  });
});

describe("selectSuites", () => {
  it("filters by --only and --skip and rejects unknown names", () => {
    expect(selectSuites(["lint", "build"], []).map((s) => s.name)).toEqual(["lint", "build"]);
    expect(selectSuites([], ["audit"]).some((s) => s.name === "audit")).toBe(false);
    expect(() => selectSuites(["nope"], [])).toThrow(/unknown suite/);
    expect(SUITES.map((s) => s.name)).toContain("test-e2e-local");
  });
});

describe("renderTable and replaceBetweenMarkers", () => {
  it("renders one row per result with the evidence path", () => {
    const table = renderTable([{ name: "lint", command: "bun run lint", exitCode: 0, durationMs: 4200, summary: "412 files checked" }]);
    expect(table).toContain("| lint | `bun run lint` | PASS | 412 files checked | 4.2 s | `docs/discovery/p7-evidence/lint.txt` |");
  });
  it("marks a skipped suite and a failure", () => {
    const table = renderTable([
      { name: "audit", command: "bun run audit", exitCode: null, durationMs: 0, summary: "", skipped: "no network" },
      { name: "build", command: "bun run build", exitCode: 1, durationMs: 1000, summary: "" },
    ]);
    expect(table).toContain("SKIPPED (no network)");
    expect(table).toContain("FAIL (exit 1)");
  });
  it("replaces only the text between the markers", () => {
    const text = "a\n<!-- suites:begin -->\nold\n<!-- suites:end -->\nb\n";
    expect(replaceBetweenMarkers(text, "suites", "new")).toBe("a\n<!-- suites:begin -->\nnew\n<!-- suites:end -->\nb\n");
    expect(() => replaceBetweenMarkers("no markers", "suites", "x")).toThrow(/markers/);
  });
});
```

`tools/lib/verify-all.ts`:

```ts
export interface Suite {
  name: string;
  command: string;
  args: string[];
  /** The suite needs the local stack ("stack") or the stack plus served functions ("functions"), or the network ("network"). */
  needs?: "stack" | "functions" | "network";
}

const bun = (name: string, script: string, needs?: Suite["needs"]): Suite => ({
  name,
  command: "bun",
  args: ["run", script],
  ...(needs === undefined ? {} : { needs }),
});

export const SUITES: Suite[] = [
  bun("lint", "lint"),
  bun("lint-workflows", "lint:workflows"),
  bun("typecheck", "typecheck"),
  bun("test-core", "test:core"),
  bun("test-tools", "test:tools"),
  bun("test-web", "test:web"),
  bun("check-functions-config", "check:functions-config"),
  bun("functions-check", "functions:check"),
  bun("functions-test", "functions:test"),
  bun("functions-selftest", "functions:selftest"),
  bun("check-fetch", "check:fetch"),
  bun("check-secrets", "check:secrets"),
  bun("check-guide", "check:guide"),
  bun("audit", "audit", "network"),
  bun("build", "build"),
  bun("check-bundle", "check:bundle"),
  bun("check-headers", "check:headers"),
  bun("test-e2e", "test:e2e"),
  bun("test-db", "test:db", "stack"),
  bun("test-integration", "test:integration", "functions"),
  bun("test-e2e-local", "test:e2e:local", "functions"),
];

export interface VerifyResult {
  name: string;
  command: string;
  exitCode: number | null;
  durationMs: number;
  summary: string;
  skipped?: string;
}

export function selectSuites(only: string[], skip: string[]): Suite[] {
  for (const name of [...only, ...skip]) {
    if (!SUITES.some((s) => s.name === name)) throw new Error(`unknown suite ${name}`);
  }
  return SUITES.filter((s) => (only.length === 0 || only.includes(s.name)) && !skip.includes(s.name));
}

export function summarizeOutput(name: string, output: string): string {
  const failedVitest = /Tests\s+(\d+) failed \| (\d+) passed/.exec(output);
  if (failedVitest) return `${failedVitest[1]} failed, ${failedVitest[2]} passed`;
  const vitest = /Tests\s+(\d+) passed/.exec(output);
  if (vitest) return `${vitest[1]} tests passed`;
  const deno = /ok \| (\d+) passed \| (\d+) failed/.exec(output);
  if (deno) return `${deno[1]} passed, ${deno[2]} failed`;
  const pg = /Files=(\d+), Tests=(\d+)/.exec(output);
  if (pg) return `${pg[1]} files, ${pg[2]} tests, ${/Result: (\w+)/.exec(output)?.[1] ?? "?"}`;
  const pw = /(\d+) passed \(/.exec(output);
  if (pw && (name.startsWith("test-e2e") || name === "build")) return `${pw[1]} passed`;
  const biome = /Checked (\d+) files/.exec(output);
  if (biome) return `${biome[1]} files checked`;
  return "";
}

export function renderTable(results: VerifyResult[]): string {
  const rows = results.map((r) => {
    const status = r.skipped !== undefined ? `SKIPPED (${r.skipped})` : r.exitCode === 0 ? "PASS" : `FAIL (exit ${r.exitCode})`;
    return `| ${r.name} | \`${r.command}\` | ${status} | ${r.summary} | ${(r.durationMs / 1000).toFixed(1)} s | \`docs/discovery/p7-evidence/${r.name}.txt\` |`;
  });
  return ["| Suite | Command | Result | Summary | Time | Evidence |", "|---|---|---|---|---|---|", ...rows].join("\n");
}

export function replaceBetweenMarkers(text: string, marker: string, replacement: string): string {
  const begin = `<!-- ${marker}:begin -->`;
  const end = `<!-- ${marker}:end -->`;
  const from = text.indexOf(begin);
  const to = text.indexOf(end);
  if (from < 0 || to < from) throw new Error(`markers ${begin} and ${end} not found`);
  return `${text.slice(0, from + begin.length)}\n${replacement}\n${text.slice(to)}`;
}
```

`tools/verify-all.ts`:

```ts
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderTable, replaceBetweenMarkers, selectSuites, summarizeOutput, type VerifyResult } from "./lib/verify-all.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
const list = (name: string): string[] => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? (args[i + 1] as string).split(",").filter(Boolean) : [];
};
const outDir = join(root, "docs", "discovery", "p7-evidence");
mkdirSync(outDir, { recursive: true });

const stackUp = spawnSync("bunx", ["supabase", "status", "-o", "json"], { cwd: root, shell: true, stdio: "pipe" }).status === 0;
async function functionsUp(): Promise<boolean> {
  try {
    return (await fetch("http://127.0.0.1:54321/functions/v1/health", { signal: AbortSignal.timeout(3000) })).ok;
  } catch {
    return false;
  }
}
const functions = stackUp && (await functionsUp());
const ansi = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

const results: VerifyResult[] = [];
for (const suite of selectSuites(list("only"), list("skip"))) {
  const command = `${suite.command} ${suite.args.join(" ")}`;
  const missing =
    suite.needs === "stack" && !stackUp ? "local stack not running"
    : suite.needs === "functions" && !functions ? "local stack or served functions not running"
    : undefined;
  if (missing !== undefined) {
    results.push({ name: suite.name, command, exitCode: null, durationMs: 0, summary: "", skipped: missing });
    writeFileSync(join(outDir, `${suite.name}.txt`), `$ ${command}\nSKIPPED: ${missing}\n`);
    console.log(`SKIP ${suite.name}: ${missing}`);
    continue;
  }
  console.log(`RUN  ${suite.name}: ${command}`);
  const started = Date.now();
  const run = spawnSync(suite.command, suite.args, { cwd: root, encoding: "utf8", shell: true, maxBuffer: 256 * 1024 * 1024 });
  const durationMs = Date.now() - started;
  const output = `${run.stdout ?? ""}${run.stderr ?? ""}`.replace(ansi, "");
  const tail = output.split(/\r?\n/).slice(-120).join("\n");
  writeFileSync(
    join(outDir, `${suite.name}.txt`),
    `$ ${command}\nexit code: ${run.status}\nduration: ${(durationMs / 1000).toFixed(1)} s\nfinished: ${new Date().toISOString()}\n--- last 120 lines ---\n${tail}\n`,
  );
  results.push({ name: suite.name, command, exitCode: run.status, durationMs, summary: summarizeOutput(suite.name, output) });
  console.log(`${run.status === 0 ? "PASS" : "FAIL"} ${suite.name} ${summarizeOutput(suite.name, output)}`);
}

const commit = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim();
writeFileSync(join(outDir, "summary.json"), `${JSON.stringify({ at: new Date().toISOString(), commit, results }, null, 2)}\n`);
const table = renderTable(results);
writeFileSync(join(outDir, "summary.md"), `${table}\n`);
const doc = join(root, "docs", "discovery", "p7-results.md");
try {
  writeFileSync(doc, replaceBetweenMarkers(readFileSync(doc, "utf8"), "suites", table));
} catch {
  console.warn("verify:all: docs/discovery/p7-results.md has no suite markers yet (written in step 4)");
}
const failed = results.filter((r) => r.skipped === undefined && r.exitCode !== 0);
if (failed.length > 0) {
  console.error(`verify:all: ${failed.length} suite(s) failed: ${failed.map((f) => f.name).join(", ")}`);
  process.exit(1);
}
console.log(`verify:all: ${results.length} suites, ${results.filter((r) => r.skipped !== undefined).length} skipped`);
```

Root scripts: `"verify:all": "bun run tools/verify-all.ts"`. Run `bun run test:tools verify-all` (fails first, then passes).

- [ ] **Step 2: The TradingView parity tool (TDD)**

`tools/lib/parity.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../../supabase/functions/_shared/core/indicator.ts";
import { buildParityReport, formatParityReport } from "./parity.ts";

const dates = ["2026-10-01", "2026-10-02", "2026-10-05", "2026-10-06", "2026-10-07"];
const close = [10, 11, 12, 13, 14];
const series = { dates, close, high: close.map((c) => c + 0.5), low: close.map((c) => c - 0.5) };
const settings = { ...DEFAULT_SETTINGS, length: 5 };

describe("buildParityReport", () => {
  it("reproduces the rising linear fixture (F1) and names the window dates", () => {
    const r = buildParityReport(series, { settings });
    if (!r.ok) throw new Error(r.reason);
    expect(r.windowStartDate).toBe("2026-10-01");
    expect(r.lastDate).toBe("2026-10-07");
    expect(r.stPrice).toBeCloseTo(10, 9);
    expect(r.endPrice).toBeCloseTo(14, 9);
    expect(r.stdDev).toBeCloseTo(0, 9);
    expect(r.rising).toBe(true);
    expect(r.lastBars).toHaveLength(5);
    expect(r.lines.map((l) => l.name)).toEqual(["upper2", "upper1", "base", "lower1", "lower2"]);
  });
  it("uses only bars up to the as-of date", () => {
    const r = buildParityReport(series, { asOf: "2026-10-05", settings: { ...DEFAULT_SETTINGS, length: 3 } });
    if (!r.ok) throw new Error(r.reason);
    expect(r.lastDate).toBe("2026-10-05");
    expect(r.barCount).toBe(3);
  });
  it("reports insufficient bars instead of throwing", () => {
    expect(buildParityReport(series, { settings: DEFAULT_SETTINGS })).toEqual({ ok: false, reason: "insufficient_bars" });
  });
  it("prints full precision values and the comparison tolerance rule", () => {
    const r = buildParityReport(series, { settings });
    if (!r.ok) throw new Error(r.reason);
    const text = formatParityReport("TEST", r);
    expect(text).toContain("symbol: TEST");
    expect(text).toContain("stPrice: 10");
    expect(text).toContain("0.5 * 10^-p");
  });
});
```

`tools/lib/parity.ts`:

```ts
import { type Channel, computeChannel, DEFAULT_SETTINGS, type IndicatorSettings } from "../../supabase/functions/_shared/core/indicator.ts";
import { isDiscount, isPremium, lowerLinePositive } from "../../supabase/functions/_shared/core/thresholds.ts";

export interface ParitySeries {
  dates: string[];
  close: number[];
  high: number[];
  low: number[];
}
export interface ParityLine {
  name: "upper2" | "upper1" | "base" | "lower1" | "lower2";
  startDate: string;
  start: number;
  end: number;
}
export type ParityReport =
  | {
      ok: true;
      barCount: number;
      length: number;
      windowStartDate: string;
      lastDate: string;
      lastClose: number;
      stPrice: number;
      endPrice: number;
      stdDev: number;
      pearsonR: number;
      rising: boolean;
      lines: ParityLine[];
      lastBars: Array<{ date: string; close: number }>;
      classification: string[];
    }
  | { ok: false; reason: string };

export function buildParityReport(
  series: ParitySeries,
  opts: { asOf?: string; settings?: IndicatorSettings } = {},
): ParityReport {
  const keep = series.dates.map((d, i) => (opts.asOf === undefined || d <= opts.asOf ? i : -1)).filter((i) => i >= 0);
  const pick = (values: number[]) => keep.map((i) => values[i] as number);
  const dates = keep.map((i) => series.dates[i] as string);
  const outcome = computeChannel({ close: pick(series.close), high: pick(series.high), low: pick(series.low) }, opts.settings ?? DEFAULT_SETTINGS);
  if (!outcome.ok) return { ok: false, reason: outcome.reason };
  const c: Channel = outcome.channel;
  const lastClose = pick(series.close)[c.lastIndex] as number;
  const line = (name: ParityLine["name"], seg: Channel["base"]): ParityLine => ({
    name,
    startDate: dates[seg.x1] as string,
    start: seg.y1,
    end: seg.y2,
  });
  const classification = [
    isPremium(lastClose, c.end.upper2) ? "close is above the +2 line (extra premium)" : null,
    isPremium(lastClose, c.end.upper1) ? "close is above the +1 line (premium)" : null,
    isDiscount(lastClose, c.end.lower1) ? `close is at or below the -3 line (discount, line end > 0: ${lowerLinePositive(c.end.lower1)})` : null,
    isDiscount(lastClose, c.end.lower2) ? `close is at or below the -4 line (discount, line end > 0: ${lowerLinePositive(c.end.lower2)})` : null,
  ].filter((s): s is string => s !== null);
  return {
    ok: true,
    barCount: c.barCount,
    length: c.length,
    windowStartDate: dates[c.windowStartIndex] as string,
    lastDate: dates[c.lastIndex] as string,
    lastClose,
    stPrice: c.stPrice,
    endPrice: c.endPrice,
    stdDev: c.stdDev,
    pearsonR: c.pearsonR,
    rising: c.rising,
    lines: [line("upper2", c.upper2), line("upper1", c.upper1), line("base", c.base), line("lower1", c.lower1), line("lower2", c.lower2)],
    lastBars: keep.slice(-5).map((i) => ({ date: series.dates[i] as string, close: series.close[i] as number })),
    classification: classification.length > 0 ? classification : ["no discount or premium condition holds"],
  };
}

export function formatParityReport(symbol: string, r: Extract<ParityReport, { ok: true }>): string {
  return [
    `symbol: ${symbol}`,
    `bars used: ${r.barCount} (length ${r.length}), window ${r.windowStartDate} .. ${r.lastDate}`,
    `last close: ${r.lastClose}`,
    `stPrice: ${r.stPrice}`,
    `endPrice: ${r.endPrice}`,
    `stdDev: ${r.stdDev}`,
    `pearsonR: ${r.pearsonR}`,
    `rising: ${r.rising}`,
    ...r.lines.map((l) => `${l.name}: start ${l.start} (${l.startDate}) end ${l.end}`),
    `classification: ${r.classification.join("; ")}`,
    "last 5 bars used (compare these against TradingView first):",
    ...r.lastBars.map((b) => `  ${b.date}  close ${b.close}`),
    "tolerance per level: |diff| <= 0.5 * 10^-p + 1e-9, p = the decimals TradingView displays for the symbol (spec 17.6, D10)",
  ].join("\n");
}
```

`tools/parity-print.ts`:

```ts
import { formatParityReport, buildParityReport } from "./lib/parity.ts";

// bun run parity -- --symbol MSFT [--as-of 2026-10-15] [--length 2500]
// Reads the stored series through the public RPC get_price_series. Environment: SUPABASE_URL and SUPABASE_ANON_KEY
// (or the VITE_ names); locally the values of `bunx supabase status`.
const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const symbol = flag("symbol");
const url = (process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL ?? "").replace(/\/$/, "");
const anon = process.env.SUPABASE_ANON_KEY ?? process.env.VITE_SUPABASE_ANON_KEY ?? "";
if (symbol === undefined || url === "" || anon === "") {
  console.error("usage: bun run parity -- --symbol <Yahoo symbol> [--as-of YYYY-MM-DD] [--length N]; set SUPABASE_URL and SUPABASE_ANON_KEY");
  process.exit(2);
}
const headers = { apikey: anon, authorization: `Bearer ${anon}`, "content-type": "application/json" };
const sec = (await (await fetch(`${url}/rest/v1/securities?select=id&yahoo_symbol=eq.${encodeURIComponent(symbol)}`, { headers })).json()) as Array<{ id: string }>;
if (sec[0] === undefined) {
  console.error(`no security with Yahoo symbol ${symbol}`);
  process.exit(1);
}
const res = await fetch(`${url}/rest/v1/rpc/get_price_series`, { method: "POST", headers, body: JSON.stringify({ p_security_id: sec[0].id }) });
const body = (await res.json()) as unknown;
const row = (Array.isArray(body) ? body[0] : body) as { bar_dates: number[]; close: number[]; high: number[]; low: number[] } | undefined;
if (!res.ok || row === undefined || row === null) {
  console.error(`get_price_series failed: HTTP ${res.status}`);
  process.exit(1);
}
const dates = row.bar_dates.map((d) => new Date(d * 86_400_000).toISOString().slice(0, 10));
const length = flag("length");
const { DEFAULT_SETTINGS } = await import("../supabase/functions/_shared/core/indicator.ts");
const report = buildParityReport(
  { dates, close: row.close, high: row.high, low: row.low },
  { ...(flag("as-of") === undefined ? {} : { asOf: flag("as-of") as string }), settings: { ...DEFAULT_SETTINGS, ...(length === undefined ? {} : { length: Number(length) }) } },
);
if (!report.ok) {
  console.error(`cannot compute the channel: ${report.reason}`);
  process.exit(1);
}
console.log(formatParityReport(symbol, report));
```

Root script `"parity": "bun run tools/parity-print.ts"`. Run `bun run test:tools parity`, then (stack running, fixture scan done) `bun run parity -- --symbol AAPL --length 20` as a smoke run (fixture series may be short; any `insufficient_bars` answer is the correct output).

- [ ] **Step 3: The release guard (TDD)**

`tools/lib/release-check.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { evidenceProblems, gitProblems, trackedForbiddenFiles, unresolvedMarkers } from "./release-check.ts";

describe("trackedForbiddenFiles", () => {
  it("flags env files other than examples, local state and build output", () => {
    const files = [".env", "apps/web/.env.local", "apps/web/.env.example", "supabase/functions/.env", "supabase/functions/.env.e2e", "supabase/.temp/x", "apps/web/dist/a.js", "backups/a.sql", "src/a.ts"];
    expect(trackedForbiddenFiles(files)).toEqual([".env", "apps/web/.env.local", "supabase/functions/.env", "supabase/functions/.env.e2e", "supabase/.temp/x", "apps/web/dist/a.js", "backups/a.sql"]);
  });
});

describe("unresolvedMarkers", () => {
  it("finds TODO, TBD, FIXME and unfilled angle markers with line numbers", () => {
    expect(unresolvedMarkers("ok\nTODO: later\nfine\nvalue <fill in>\n")).toEqual(["line 2: TODO: later", "line 4: value <fill in>"]);
    expect(unresolvedMarkers("all good")).toEqual([]);
  });
});

describe("evidenceProblems", () => {
  const ok = { results: [{ name: "lint", exitCode: 0 }, { name: "build", exitCode: 0 }] };
  it("requires every suite present, passing and not skipped", () => {
    expect(evidenceProblems(ok, ["lint", "build"])).toEqual([]);
    expect(evidenceProblems(ok, ["lint", "test-db"])).toEqual(["suite test-db has no evidence"]);
    expect(evidenceProblems({ results: [{ name: "lint", exitCode: 1 }] }, ["lint"])).toEqual(["suite lint did not pass (exit 1)"]);
    expect(evidenceProblems({ results: [{ name: "lint", exitCode: null, skipped: "x" }] }, ["lint"])).toEqual(["suite lint was skipped (x)"]);
  });
});

describe("gitProblems", () => {
  const base = { branch: "build/initial", porcelain: "", behind: 0, ahead: 12, tagExists: false };
  it("accepts a clean branch that can fast-forward", () => {
    expect(gitProblems(base)).toEqual([]);
  });
  it("flags every violation", () => {
    expect(gitProblems({ ...base, branch: "master" }).join("\n")).toMatch(/build\/initial/);
    expect(gitProblems({ ...base, porcelain: " M a.ts" }).join("\n")).toMatch(/clean/);
    expect(gitProblems({ ...base, behind: 2 }).join("\n")).toMatch(/fast-forward/);
    expect(gitProblems({ ...base, ahead: 0 }).join("\n")).toMatch(/nothing to merge/);
    expect(gitProblems({ ...base, tagExists: true }).join("\n")).toMatch(/v0\.1\.0-local/);
  });
});
```

`tools/lib/release-check.ts`:

```ts
const FORBIDDEN = [/(^|\/)\.env(\.|$)(?!example$)/, /^supabase\/\.temp\//, /^apps\/web\/dist\//, /^backups\//, /(^|\/)\.wrangler\//, /(^|\/)playwright-report\//, /(^|\/)test-results\//];

export function trackedForbiddenFiles(files: string[]): string[] {
  return files.filter((f) => !f.endsWith(".env.example") && FORBIDDEN.some((re) => re.test(f)));
}

export function unresolvedMarkers(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line, i) => (/\b(TODO|TBD|FIXME)\b|<fill/i.test(line) ? `line ${i + 1}: ${line.trim()}` : null))
    .filter((l): l is string => l !== null);
}

export interface EvidenceSummary {
  results: Array<{ name: string; exitCode: number | null; skipped?: string }>;
}

export function evidenceProblems(summary: EvidenceSummary, required: string[]): string[] {
  const problems: string[] = [];
  for (const name of required) {
    const r = summary.results.find((x) => x.name === name);
    if (r === undefined) problems.push(`suite ${name} has no evidence`);
    else if (r.skipped !== undefined) problems.push(`suite ${name} was skipped (${r.skipped})`);
    else if (r.exitCode !== 0) problems.push(`suite ${name} did not pass (exit ${r.exitCode})`);
  }
  return problems;
}

export interface GitState {
  branch: string;
  porcelain: string;
  /** commits on master that build/initial lacks */
  behind: number;
  /** commits on build/initial that master lacks */
  ahead: number;
  tagExists: boolean;
}

export function gitProblems(s: GitState): string[] {
  const problems: string[] = [];
  if (s.branch !== "build/initial") problems.push(`HEAD is ${s.branch}; release from build/initial`);
  if (s.porcelain.trim() !== "") problems.push("the working tree is not clean (commit or discard first)");
  if (s.behind > 0) problems.push(`master has ${s.behind} commit(s) that build/initial lacks: a fast-forward is impossible (rebase or merge master into build/initial first)`);
  if (s.ahead === 0) problems.push("build/initial has no commits beyond master: nothing to merge");
  if (s.tagExists) problems.push("the tag v0.1.0-local already exists");
  return problems;
}
```

`tools/release-check.ts`:

```ts
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SUITES } from "./lib/verify-all.ts";
import { type EvidenceSummary, evidenceProblems, gitProblems, trackedForbiddenFiles, unresolvedMarkers } from "./lib/release-check.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const git = (...args: string[]): string => spawnSync("git", args, { cwd: root, encoding: "utf8" }).stdout.trim();

const counts = git("rev-list", "--left-right", "--count", "master...build/initial").split(/\s+/).map(Number);
const problems = [
  ...gitProblems({
    branch: git("rev-parse", "--abbrev-ref", "HEAD"),
    porcelain: git("status", "--porcelain"),
    behind: counts[0] ?? 0,
    ahead: counts[1] ?? 0,
    tagExists: git("tag", "--list", "v0.1.0-local") !== "",
  }),
  ...trackedForbiddenFiles(git("ls-files").split(/\r?\n/)).map((f) => `tracked file that must never be committed: ${f}`),
];
const results = join(root, "docs", "discovery", "p7-results.md");
if (!existsSync(results)) problems.push("docs/discovery/p7-results.md is missing");
else problems.push(...unresolvedMarkers(readFileSync(results, "utf8")).map((m) => `p7-results.md: ${m}`));
const summaryFile = join(root, "docs", "discovery", "p7-evidence", "summary.json");
if (!existsSync(summaryFile)) problems.push("docs/discovery/p7-evidence/summary.json is missing (run bun run verify:all)");
else problems.push(...evidenceProblems(JSON.parse(readFileSync(summaryFile, "utf8")) as EvidenceSummary, SUITES.map((s) => s.name)));

if (problems.length > 0) {
  for (const problem of problems) console.error(`release:check: ${problem}`);
  process.exit(1);
}
console.log("release:check: OK (no push is performed by the release steps; the owner pushes when ready)");
```

Root script `"release:check": "bun run tools/release-check.ts"`. Run `bun run test:tools release-check` (fails, then passes).

- [ ] **Step 4: Run every suite and write the verification record**

1. Bring the environment up and serve the functions (PowerShell):

```powershell
bun run supabase:start
bun run e2e:setup          # second terminal first: bun run e2e:serve
git grep -n "env.integration" -- tools package.json
```

   If the last command shows that an integration script expects `supabase/functions/.env.integration`, serve with `supabase functions serve --no-verify-jwt --env-file supabase/functions/.env.integration` for the `test-integration` suite only and write down which env file served which suite. The e2e env file already carries the Flex, Resend (mock URL port 54782), VAPID and fixture values those scripts use; add any missing name from the integration script's `--write-env` list to `e2eFunctionsEnv` in `tools/lib/e2e-env.ts` (one line each, with a test) rather than keeping two files.
2. Run the evidence runner: `bun run verify:all`. Expected: 21 suites, each `PASS`, none `SKIPPED`; the process exits 0. A failing suite means the phase is not done: fix the cause (never edit evidence), rerun that suite with `bun run verify:all -- --only <name>` and finally the whole command once more so `summary.json` holds one consistent run.
3. Create `docs/discovery/p7-results.md` with the content below. Replace nothing in the acceptance table's evidence column; the only edits allowed are the verdict cells, and only downward (the evidence rule): a row whose cited suite is not `PASS` in `summary.md` becomes `not demonstrated` with the reason.

````markdown
# P7 verification results

Written at the end of P7 (spec 18). Environment: Windows 11 Enterprise, Bun 1.3.14, Node 22.13.1, Deno 2.9.6 locally (2.1.x in CI),
Supabase CLI 2.121.0, TypeScript 6.0.3, Biome 2.5.15; the commit under test is the field `commit` of `docs/discovery/p7-evidence/summary.json`.
Evidence files: `docs/discovery/p7-evidence/` (one file per suite with the exit code and the last 120 lines, `summary.json`).
CI has not run: the repository has no remote; the first push triggers `ci.yml` (P0 Task 7 step 10 applies).

## 1. Suite results

<!-- suites:begin -->
(replaced by `bun run verify:all`)
<!-- suites:end -->

## 2. Acceptance criteria (brief section 36, spec 17.7)

Verdict values: met, changed by decision, out of scope, not demonstrated. "Changed" items carry the decision id of spec 1.3 and the
owner's acceptance is part of the sign-off of this record.

| # | Criterion | Spec 17.7 status | Verdict | Evidence |
|---|---|---|---|---|
| 1 | Public users can access Overview and Quotes without login | in scope | met | `apps/web/e2e/local/10-overview.local.spec.ts`; `csp.spec.ts` (public routes); `0900_rls_matrix.test.sql` (anon reads); suites `test-e2e-local`, `test-db` |
| 2 | Worldwide and US universes selectable without mutating shared state | in scope | met | `10-overview` (switch performs no write); `0900_rls_matrix` (anon cannot write); suite `test-e2e-local` |
| 3 | Company List ranks by market cap, highlights top 10 | in scope | met | core ranking tests (`test-core`); `10-overview` (15 rows, Load more); `0130_public_reads.test.sql` |
| 4 | Seven-day summary accurate | in scope | met | `0130_public_reads.test.sql`, `0140_data_functions.test.sql` (`universe_summary`, `company_list`); suite `test-db` |
| 5 | Daily scan uses completed bars at 10:00 Europe/Sofia | in scope | met | `0120_pipeline.test.sql` (DST replays of `start_daily_scan`); core bars and calendar tests; suites `test-db`, `test-core` |
| 6 | Channel matches Pine within tolerance | in scope | met (fixtures); TradingView comparison owner-run | `indicator.test.ts` parity fixtures F1 to F9 (`test-core`); `tools/parity-print.ts`; `docs/discovery/parity-results.md` |
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
| 22 | Submission timeout recovery cannot duplicate a live order | out of scope | out of scope | the application never submits an order (`git grep -i "submit order" -- apps/web/src` returns nothing; triage item D-60) |
| 23 | Modifications, partial fills, commissions, final executions | changed / out of scope (V6) | changed by decision | order modification is out of scope; executions, actual commissions and realized P/L come from Flex: accounting tests (`test-core`); broker scenario of `test-integration` |
| 24 | Realized P&L includes closed positions; dividends separate with include toggle | in scope | met | accounting tests (`test-core`); portfolio and analytics web tests (`test-web`) |
| 25 | No mixed-currency totals without conversion | in scope | met | `Money` accounting tests (`test-core`) |
| 26 | Missing or stale prices and failed research honestly labelled | in scope | met | state component and page tests (`test-web`); `90-a11y-viewports.local.spec.ts` renders every page |
| 27 | No credentials or private broker details in the browser | in scope | met | `check-bundle`; `0900_rls_matrix.test.sql`; `35-isolation` and `30-profile` specs; `security-review.md` section 3 |
| 28 | Builds, type checks, tests and deployable artifacts succeed; blockers documented | in scope | met locally; CI not yet run | section 1 (all suites PASS); `build` and `check-headers` evidence |

## 3. Spec 17.5 end-to-end coverage

1 and 2 `10-overview`; 3 `10-overview`; 4 stubbed chart specs in `test-e2e`; 5 and 6 `20-auth`; 7 `50-portfolio-analytics`; 8 `60-handoff`;
9 `smoke.spec.ts` (theme persists); 10 `keyboard.spec.ts`; 11 `90-a11y-viewports` and `a11y.spec.ts`. No test places an order; no test
calls a production provider.

## 4. TradingView manual parity (spec 17.6, acceptance 6)

Owner-run, repeated at any indicator change; results go to `docs/discovery/parity-results.md`.

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
````

   The marker line `(replaced by ...)` is replaced by the next `verify:all` run; run `bun run verify:all -- --only lint` once now so the marker block holds the real table, then run the full command again at the very end of this task. `release:check` rejects any TODO, TBD, FIXME or `<fill` marker left in the record.
4. Create `docs/discovery/parity-results.md` with the table header of spec 17.6 step 7 and one line stating who runs it:

```markdown
# TradingView parity results (spec 17.6, A-30)

Owner-run. Repeat at any indicator change. No instrument has been compared yet; `docs/discovery/p7-results.md` section 4 is the checklist.

| Date | Symbol/exchange | Bars: first/last, count | Close (ours / TV) | st (ours / TV / diff) | end (ours / TV / diff) | sd (ours / TV) | upper1 end | upper2 end | lower1 end | lower2 end | Direction | Classification | Result | Data difference notes |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
```

- [ ] **Step 5: Specification pointers and name corrections**

1. In `docs/superpowers/specs/2026-10-15-stock-screener-design.md`, section 19.2, directly after the existing pointer line(s) below the table (the P0 line `P0 verification results ...` and any later phase pointers) add:

```markdown
P7 verification results: `docs/discovery/p7-results.md`; security review: `docs/discovery/security-review.md`; deferred-finding triage: `docs/discovery/p7-triage.md`; TradingView parity results (owner-run): `docs/discovery/parity-results.md`.
```

2. Section 15.4: replace `UNSUBSCRIBE_SIGNING_KEY` by `UNSUBSCRIBE_SECRET` and, anywhere in the spec, `RESEND_FROM` by `EMAIL_FROM` (names in code win, P7-D6). Find them first: `git grep -n -E "UNSUBSCRIBE_SIGNING_KEY|RESEND_FROM" -- docs/superpowers/specs`; edit each hit with the Edit tool (do not touch `prompt.txt`, the original brief).
3. In section 19.1 add after the `A-41` row:

```markdown
| A-42 | Names | Environment names follow the code: `UNSUBSCRIBE_SECRET` (not `UNSUBSCRIBE_SIGNING_KEY`), `EMAIL_FROM` (not `RESEND_FROM`) | 15.4 |
| A-43 | Security | P7 decisions P7-D1 to P7-D8 (rendered CSP origin, RLS matrix seeding, per-IP rate limits in `index.ts`, kill switch in the throttle, one local Playwright config, hosted drills owner-run, keep-alive alerts) are recorded in `docs/discovery/security-review.md` | 15, 16.4, 16.5 |
```

- [ ] **Step 6: Final verification run and commit the record**

```powershell
bun run verify:all
bun run lint
git add docs tools package.json
git commit -m "docs(p7): verification record with command evidence, acceptance table, parity tool and release guard"
bun run release:check
```

Expected: `verify:all` ends `verify:all: 21 suites, 0 skipped`; `release:check` ends `release:check: OK`. If `release:check` reports a dirty tree (the evidence files changed after the commit), commit them (`git add docs/discovery/p7-evidence docs/discovery/p7-results.md`, `git commit -m "docs(p7): refresh evidence"`) and run it again.

- [ ] **Step 7: Branch finish, local only**

```powershell
git status --short
git log --oneline master..build/initial
git checkout master
git merge --ff-only build/initial
git tag -a v0.1.0-local -m "Personal stock screener v0.1.0-local: P0 to P7 complete, verified locally (docs/discovery/p7-results.md)"
git log -1 --oneline
git tag -n1 v0.1.0-local
git remote -v
```

Expected: the first command prints nothing; the second lists every commit of the build; the merge prints `Fast-forward` (if it refuses, `master` has diverged: stop and ask the owner, never use a non-fast-forward merge or `--force`); the tag is listed; `git remote -v` prints either nothing or the remote, and **nothing is pushed**. The owner pushes with `git push origin master --tags` when ready; the first CI run is then the first action (P0 Task 7 step 10) and any CI-only difference (Deno 2.1.x versus 2.9.6) is fixed on a new branch. Stay on `master` or return with `git checkout build/initial`; both point at the same commit.

---

## Task 7: Phase exit checklist

**Concurrency:** after Task 6. Verification only; nothing is created. Each item is a command or a fact to confirm; any red item sends the work back to the owning task.

- [ ] **Step 1: Clean tree, frozen install, no secret tracked**

```powershell
git status --short
bun install --frozen-lockfile
git ls-files | Select-String -Pattern '(^|/)\.env' | Where-Object { $_ -notmatch '\.env\.example$' }
git ls-files supabase/.temp apps/web/dist apps/web/playwright-report apps/web/test-results .wrangler backups
git grep -n -I -E "sb_secret_|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}" -- apps supabase .github docs/operator-guide.md README.md
```

Expected: the first prints nothing; the second `no changes`; the last three print nothing.

- [ ] **Step 2: Every suite, from the stored evidence and once more live**

```powershell
Get-Content docs/discovery/p7-evidence/summary.md
bun run release:check
```

Expected: 21 rows, all `PASS`; `release:check: OK`. Spot-check two evidence files by opening them (`p7-evidence/test-db.txt` ends `Result: PASS`; `p7-evidence/test-e2e-local.txt` shows every spec passed).

- [ ] **Step 3: The five release risks are pinned (each command must exit 0 and each deliberate break must fail)**

| Risk | Pin | Quick proof |
|---|---|---|
| 1 CSP | `check:headers`, `csp.spec.ts` | edit `dist/_headers` to `Content-Security-Policy-Report-Only`, run `bun run check:headers`: it fails; rebuild |
| 2 Access review | `0900_rls_matrix.test.sql` | the three mutation checks recorded in `security-review.md` section 2 |
| 3 Outbound URLs | `check:fetch` | add a `fetch(userUrl)` to a scratch file under `supabase/functions`: `bun run check:fetch` names it; delete the file |
| 4 Name drift | `check:secrets`, `log.test.ts` | rename `UNSUBSCRIBE_SECRET` in a scratch `Deno.env.get("X_SECRET_NEW")` read: `bun run check:secrets` fails; revert |
| 5 Evidence | `verify:all`, `release:check` | edit one cell of `summary.json` to a failing exit code: `release:check` fails; restore with git |

- [ ] **Step 4: Spec 18 P7 deliverables and exit, item by item**

| P7 deliverable or exit item | Where it is satisfied |
|---|---|
| Security review against 15 (T1 to T23) | `security-review.md` (19 findings, all closed or accepted; each threat row mapped by area) |
| RLS and pgTAP complete | `0900_rls_matrix.test.sql` plus the per-phase suites, suite `test-db` |
| Secret scan | `check:bundle` (one name list), `check:secrets`, CI steps |
| CSP finalised | enforced, rendered origin, `check:headers`, `csp.spec.ts` |
| Dependency review | `audit` and `tools/audit-exceptions.json` |
| Operator guide (16.9) | sections 0 to 15, `check:guide` OK |
| Monitoring and alert rules (16.5) | `tools/keepalive.ts` and the manual checks of operator guide section 12 |
| Backup procedure, rollback drills (16.8) | operator guide 13.1 and 13.5; drills in section 15 |
| Production cut-over (Vault, cron, domain) | operator guide sections 2, 6 and 15 |
| Final Playwright and accessibility run | suites `test-e2e` and `test-e2e-local` (axe at 360 and 1280 px) |
| Privacy and disclaimer pages reviewed (Q-04, Q-05, Q-09) | open questions recorded for the owner in `p7-results.md` section 6 |
| Exit: all of 17.7 demonstrated or marked changed or out of scope | `p7-results.md` section 2 (28 rows, evidence-backed) |
| Exit: keep-alive and freshness alerts proven by a deliberate failure | local proof in `security-review.md` section 10; hosted drill owner-run (section 15) |
| Exit: a full day of unattended production scans | owner-run (section 15); recorded as not run in `p7-results.md` section 5 |

- [ ] **Step 5: Final state**

```powershell
git log --oneline -3
git tag --list v0.1.0-local
git branch --contains v0.1.0-local
git remote -v
```

P7 is complete when: Steps 1 to 4 are green, `master` and `build/initial` point at the tagged commit, nothing was pushed, `p7-results.md` lists the owner-run items (TradingView parity, hosted drills, open questions) as the remaining work, and the owner has read the residual risks and the deferred findings.

## Self-review against the specification (completed while writing this plan)

- **Section 15.** Threat model T1 and T2 (RLS matrix, column privileges in the matrix `C` cells, `35-isolation` secret columns), T3 (Broker page autocomplete test), T4 (bundle scan, single name list, `check:secrets`), T5 and T21 (`requireCronSecret` trim, `scan-control` secret or admin JWT, rate limits), T6 (Svix tests exist in P3; unchanged), T7 (rate limits, right-most IP, kill switch), T8 (CSP, sanitised Markdown), T9 (no cookies grep, CORS grep), T10 (`safeNext`, redirect grep), T11 and T13 (Markdown policy, ledger-only links), T12 (fetch inventory, https base URLs, push allow-list), T14 and T15 (matrix hidden rows), T16 (core tests), T17 (P6), T18 (keep-alive alerts, kill switch), T19 (frozen lockfile, `audit`), T20 (the search-path assertion of `0150_security`), T22 (rate limits, sign-up switch, guide 13.6), T23 (`frame-ancestors`, `X-Frame-Options`, `check:headers`). RLS matrix 15.3, secrets inventory and rotation 15.4 (guide 13.2, `check:secrets`), Yahoo ToS 15.5 (guide section 1, kill switch), logging 15.6 (`redact`), no E2E claim 15.7 (README).
- **Section 16.** 16.2 deployment order (guide 2.2 and 15), 16.3 Cloudflare (guide 6), 16.4 keep-alive (`keepalive.ts`), 16.5 alerts (evaluated ones in code, others listed as manual), 16.6 retention (guide 13.3), 16.7 backups (guide 13.1), 16.8 rollback (guide 13.5 and 13.4), 16.9 outline (sections 1 to 10 plus the extras), 16.10 runbooks (13.4).
- **Section 17.** 17.2 (the matrix completes the DB suites), 17.5 (coverage map in step 9 of Task 4), 17.6 (parity tool, checklist, results file), 17.7 (28-row table with evidence rule).
- **Names used consistently:** `UNSUBSCRIBE_SECRET`, `EMAIL_FROM`, `CRON_SHARED_SECRET` (function secret) and `worker_tick_secret` (Vault), `RATE_LIMIT_SALT`, `providers.yahoo_enabled`, `quotes_rl_incr`, `requireHttpsBase`, `withIpRateLimit`, scripts `check:headers`, `check:fetch`, `check:secrets`, `check:guide`, `audit`, `verify:all`, `release:check`, `e2e:setup`, `e2e:serve`, `test:e2e:local`.
- **Unverified at planning time (execute and record):** the exact output shape of `bun audit --json`; that the local `postgres` role may `set session_replication_role = replica`; the real labels in the P3 to P6 components used by the e2e specs (step 8 of Task 4 lists how to confirm them); whether Kong rewrites `x-forwarded-for`; whether P3's `gen:vapid` accepts `--out`; the migration timestamps of P2 to P6 (rename rule given in Tasks 1 and 2); the table and function lists of P2 to P6 (the matrix reconciles them in Task 2 step 4).
