# Security review (P7)

Date: 2026-10-15. Scope: spec section 15 (T1 to T23), the repository at `build/initial`, local stack only
(no hosted project was touched). Severity: High (exploitable now or breaks a spec guarantee), Medium (needs a
second weakness or a misuse), Low, Info. Status: fixed (commit), deferred (reason), accepted (owner-visible risk).

Parts C (logging, secrets inventory, Markdown), D (outbound calls, rate limits, kill switch) and G (final pass):
all parts (A to G) are complete in this revision; the two functions another agent still owns are listed under S-09, S-10 and S-24.

## Findings

| ID | Sev | Area | Finding | Fix or decision | Status |
|---|---|---|---|---|---|
| S-01 | High | CSP | Policy shipped as `Content-Security-Policy-Report-Only` with `connect-src https://*.supabase.co` (any Supabase project). | Enforced header, `connect-src 'self' <project origin>` rendered at build time, `check:headers`, CSP e2e (steps 3 to 8). | fixed (160422d) |
| S-02 | Medium | Headers | `Permissions-Policy` denies camera, microphone and geolocation only. | Deny list of 15 features, `clipboard-write=(self)` only (step 4). | fixed (160422d) |
| S-03 | Info | Headers | HSTS is not set in `_headers`. | Managed by Cloudflare; operator guide section 6 and the cut-over section tell how to enable it. | accepted |
| S-04 | Medium | Logging | `REDACT_KEY` lacks `password`, `endpoint`, `p256dh`, `auth` of spec 15.6 and `redactString` does not mask e-mail or long base64 values. | Extend key list and value masks, test with seeded secrets (step 9). Residual of ledger item D-27. | fixed (a033335) |
| S-05 | Medium | Secrets | Bundle scan name list (`tools/lib/secret-scan.ts`) drifted from the code: it lists `UNSUBSCRIBE_SIGNING_KEY` but code reads `UNSUBSCRIBE_SECRET`, and lacks `RATE_LIMIT_SALT`. Ledger item D-02. | One list in `secret-names.ts`, `check:secrets` (steps 10 and 11). | fixed (a033335) |
| S-06 | Medium | XSS | `MarkdownBody` links any `http(s)` URL found in model text and `rehype-sanitize` still allows `img`; spec T13 requires links from the evidence ledger only. Ledger items D-34 and D-35. | `skipHtml`, blocked elements, links only for `allowedUrls`, tests with hostile Markdown (step 12). | fixed (a033335) |
| S-07 | Medium | RLS | `public.is_admin()` is executable by `anon` (`revoke from public` does not remove the Supabase default grant). Found by the RLS matrix (`0900_rls_matrix.test.sql`). Ledger item D-31. | `supabase/migrations/20261015007000_security_grants.sql`: revoke from public and anon; authenticated keeps it (the admin RLS policies of scan_jobs, scan_events and audit_events call it as the invoking role). Matrix expectation flipped to `anon=false`. | fixed (19d0295) |
| S-08 | Medium | Rate limit | `quotes` takes the left-most `x-forwarded-for` entry as the client IP: a client can rotate it and bypass 60 per minute. | `cf-connecting-ip`, else right-most entry (step 17); `probe:ratelimit`. | fixed (4194cbc) |
| S-09 | Medium | Rate limit | `push-subscribe`, `broker-sync` and `portfolio-refresh` have per-user caps or cooldowns but no per-IP request limit. | `withIpRateLimit` in each `index.ts` (steps 16 and 17). | fixed (4194cbc) for `push-subscribe` and `quotes`; fixed for `broker-sync` (20/min) and `portfolio-refresh` (60/min) in the follow-up commit `fix(security): rate limit, Yahoo kill switch and redacted logs in broker functions` (live probe of the two functions not re-run: no anon key available locally) |
| S-10 | High | Spec 15.5 | The Yahoo kill switch (`app_settings.providers.yahoo_enabled`) is not implemented (the step 1 grep prints nothing). | Setting, validation, `createThrottle` guard, wiring (steps 18 and 19). | fixed (4194cbc) for `worker-tick` and `quotes`; fixed for the `broker-sync` and `portfolio-refresh` providers in the follow-up commit (`isEnabled: createYahooEnabledCheck(...)`) |
| S-11 | Low | SSRF | Operator-configured base URLs (`LLM_ALT_BASE_URL`, `FLEX_BASE_URL`, `RESEND_API_URL`) are not validated (the step 1 grep confirms the reads). | `requireHttpsBase` (step 14). | fixed (4194cbc) |
| S-12 | Low | Ops | `keepalive.yml` performs one read; spec 16.4 freshness and 16.5 alert conditions were never built. | `tools/keepalive.ts` and `tools/lib/alerts.ts` (steps 22 to 24). | fixed (836252d) |
| S-13 | Low | CSP | `style-src 'unsafe-inline'` remains. | Accepted: Radix, Sonner and the chart library write style attributes; scripts stay strict. | accepted |
| S-14 | Low | Session | supabase-js keeps the session in `localStorage` (T8). | Accepted: XSS is the only reader; mitigated by S-01 and S-06. | accepted |
| S-15 | Info | Logging | Flex request URLs carry the token (`t=`). | Verified in step 1 (`console` grep) and by `redactString` (URL credential mask); the `flex.ts` adapter never logs URLs. | accepted |
| S-16 | Info | SSRF | `fetchDocument` DNS check is best effort (`dnsCheck: "skipped"` when no resolver); DNS rebinding between check and fetch is not closed. | Accepted and documented; mitigations: https/http only, public host names, redirects re-validated, 2 MB cap, no secrets in requests. | accepted |
| S-17 | Info | RLS | `ai_quota_usage` has no admin read policy (spec 6.9 marks the admin page optional). Matrix ruling: ACCEPTED. | Deviation recorded in the matrix; quota is read through SQL by the operator. | accepted |
| S-18 | Info | RLS | `ibkr_catalogue` and `eur_equivalents` are readable by `anon` (P6 deviation from spec 6.9: public contract data, no personal data). Matrix ruling: ACCEPTED. | Deviation recorded in the matrix. | accepted |
| S-19 | Info | Supply chain | Production dependency advisories. | See section 12 and `tools/audit-exceptions.json`. | fixed (68335ac): no advisory on 2026-10-15 |
| S-20 | Medium | RLS | App functions `app.fail_job`, `app.holder`, `app.profile_display_name` and the trigger functions `app.audit_eur_override` and `app.notification_preferences_guard` were executable by anon and authenticated through default privileges (pinned in the matrix). Schema `app` has no USAGE for those roles, so they were not reachable through PostgREST, but any future `grant usage on schema app` would have exposed them (`fail_job` is security definer and rewrites job state). | Same migration: `revoke all ... from public, anon, authenticated`; `service_role` keeps `fail_job`, `holder` and `profile_display_name`; triggers need no grants; `alter default privileges in schema app revoke execute on functions from public, anon, authenticated`. The policies `research_reports_holders` and `research_sources_holders` called `app.holder` as the invoking role (the reason authenticated had EXECUTE); they now call `public.holds_security` (identical `broker_positions` body, already authenticated-only). The matrix allow-list `app_fn_allow` is now empty. | fixed in the Part A commit |
| S-21 | Info | RLS | `audit_events` is readable by the owner for their own rows (`audit_events_select_own`, P5a); spec 6.9 says admin only. Matrix ruling: ACCEPTED (users may see their own audit trail; no other user's rows are visible). | Deviation recorded in the matrix. | accepted |
| S-22 | Info | RLS | `push_subscriptions`: the owner may delete own rows (P3; spec 6.9 says select only). Matrix ruling: ACCEPTED (users remove their own devices). | Deviation recorded in the matrix. | accepted |
| S-23 | Info | RLS | `app.holder()` source table. Verified: created in `20261015002000_research_schema.sql` over `risk_monitor_state`, redefined by P5b in `20261015005000_broker_schema.sql` over `broker_positions` (`user_id = auth.uid()` and `security_id` or `signal_security_id` match). The latest definition matches spec 6.9 (`broker_positions`). | None; also covered by the matrix holder-only assertions (holder B sees the holders-only report, A and anon do not). | verified |
| S-24 | Low | Logging | The step 1 console grep is not empty: direct `console.*` calls in `quotes/handler.ts` (twice), `quotes/service.ts`, `scan-control/index.ts` and `worker-tick/index.ts` log only an error message string; `portfolio-refresh/index.ts` logs `JSON.stringify({fn, event, ...data})` without `redact`. | Route through `scanEvent`/`redact` in Part C (those files belong to other in-flight work). `_shared/adapters/push-cli.ts` is a CLI helper. | fixed (a033335) for `quotes`, `scan-control`, `worker-tick`, `notify-dispatch`, digest; fixed for `broker-sync/index.ts`, `portfolio-refresh/index.ts` and `worker-tick/handlers/eur_store.ts` in the follow-up commit (`logLine`; `eur_store.test.ts` asserts the redacted line) |
| S-25 | Low | CSP | `zod@4.6.7` runs a `Function("")` probe that the enforced CSP reports as a `script-src eval` violation on every page (caught, no functional effect, but it pollutes violation reports and the CSP e2e). | `z.config({ jitless: true })` in `apps/web/src/lib/zod-config.ts`; `'unsafe-eval'` never added. | fixed (160422d) |
| S-26 | Medium | Secrets | `RECIPIENT_HASH_SECRET` (keys the webhook recipient HMAC) was missing from the bundle-scan name list, and nine names read by the functions (`EMAIL_FROM`, `FLEX_ENC_KEY_CURRENT`, `FLEX_USER_AGENT`, `RATE_LIMIT_SALT`, `RECIPIENT_HASH_SECRET`, `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`, `SUPABASE_SERVICE_ROLE_KEY`, `UNSUBSCRIBE_SECRET`) were not in the operator guide. Found by the first `check:secrets` run. | Name added to `SERVER_SECRET_NAMES`; operator guide section 2.1 lists every name; `check:secrets` is a CI step. | fixed (a033335) |
| S-27 | Info | SSRF | `FLEX_BASE_URL` is a constant in `flex.ts`, not an environment variable (the brief expected an operator-configured URL). Nothing to validate; the host is fixed. `RESEND_API_URL` and `LLM_ALT_BASE_URL` are validated by `requireHttpsBase`. | Recorded in `FETCH_POLICY`. | accepted |
| S-28 | Low | Push | `notify_subscribe` upserts on `endpoint` and reassigns a known endpoint to the caller (`20261015004200_email_event_user_resolution.sql`). The caller must already know the secret, unguessable push endpoint URL; reassignment is also the right behaviour for a shared device. | Accepted residual risk: knowing the endpoint is equivalent to controlling the browser subscription. | accepted |
| S-29 | Info | Disclosure | The public `health` endpoint returns the scan status and the database size without authentication. The data is non-personal (the site already shows the scan status) and the keep-alive and uptime checks need it. | Accepted: contains no user data, secret or identifier. | accepted |
| S-30 | Info | Disclosure | The US view of the Overview (owner decision 2026-10-16: one worldwide ranking, US is a display filter) is not an access control: the public RPCs and views accept `worldwide` or `us` and return public market data, including the company country. | Accepted: market data only, no personal data; see Residual risks. | accepted |

## Decisions

| ID | Decision | Reason |
|---|---|---|
| P7-D1 | `_headers` is a template; `tools/render-headers.ts` substitutes `__SUPABASE_ORIGIN__` in `dist/_headers`. Local builds without `VITE_SUPABASE_URL` render the placeholder origin `https://unset.invalid` and print a warning; `deploy-web.yml` runs `check:headers -- --expect-origin "$VITE_SUPABASE_URL"`. | The project ref is not known in the repository; a wildcard `*.supabase.co` would let a script exfiltrate to any Supabase project. |
| P7-D2 | The RLS matrix seeds rows generically from `pg_attribute` with `session_replication_role = replica` (no FK checks, no triggers) and per-table `seed_override` JSON. A table whose seed cannot be satisfied may carry a skip reason; at most 5 skips are allowed. | One mechanism covers tables added later without hand-written inserts. |
| P7-D3 | Rate limiting is applied in `index.ts` before the handler, by hashed IP, with the existing atomic counter `public.quotes_rl_incr`. | No handler signature changes; the per-user cooldowns of P5b stay in the handlers. |
| P7-D4 | The kill switch lives in `createThrottle` (`isEnabled` option) because every Yahoo request, including the crumb and cookie requests, already passes it. | One cut point for the worker and for `quotes`; reuses the reschedule path of the breaker. |
| P7-D5 | One Playwright config for local-stack tests, `apps/web/playwright.local.config.ts`, on the Vite dev server (port 5173, the only origin on the local auth allow-list). The production-build variant of P4 Task 7 is retired. | P4 and P5a defined two different `test:e2e:local` scripts; the dev-server one is the only one that can sign in. |
| P7-D6 | The environment variable `UNSUBSCRIBE_SECRET` (P3) is the real name; spec 15.4 calls it `UNSUBSCRIBE_SIGNING_KEY`. Task 6 corrects the spec line. `EMAIL_FROM` replaces the spec's `RESEND_FROM` the same way. | Names in code win; the inventory check enforces one list. |
| P7-D7 | Hosted-only exit items of spec P7 (a full unattended production day, the keep-alive failure drill on GitHub, the `supabase secrets list` comparison) are written as drills in the operator guide section "Production cut-over and drills" and recorded in `p7-results.md` as "owner-run, not executed locally". | They need the hosted project and the owner's accounts. |
| P7-D8 | Spec 16.4 and 16.5 (keep-alive freshness check and alert conditions) were not built by P0 to P6 (`keepalive.yml` only reads one row). Task 1 adds `tools/keepalive.ts` with the conditions that the public `scan_status` and `health` data can evaluate; conditions needing fields that `health` does not expose are listed in the operator guide as manual checks. | Closes the P7 exit item "keep-alive and freshness alerts proven by a deliberate failure" as far as it can be proven locally. |

## Evidence by area

### 1. Authentication and session

Baseline greps of step 1 (2026-10-15, branch `build/initial`):

```text
## ls-files
apps/web/src/features/auth/redirects.ts
supabase/functions/_shared/adapters/email.ts
supabase/functions/_shared/adapters/flex.ts
supabase/functions/_shared/adapters/push.ts
supabase/functions/broker-sync/index.ts
supabase/functions/portfolio-refresh/index.ts
supabase/functions/push-subscribe/index.ts
supabase/functions/scan-control/validate.ts
## claims
supabase/functions/_shared/adapters/user-auth.ts:41:  auth: { getClaims(jwt: string): Promise<{ data: { claims: unknown } | null; error: unknown }> };
supabase/functions/_shared/adapters/user-auth.ts:44:/** Verifies the user JWT with `auth.getClaims()` (the platform JWT check is off for these functions, spec 7.3). */
supabase/functions/_shared/adapters/user-auth.ts:60:      const { data, error } = await client.auth.getClaims(jwt);
supabase/functions/push-subscribe/handler.ts:19:  /** verifies the bearer JWT (getClaims against the project JWKS) and returns the user id, or null */
supabase/functions/push-subscribe/index.ts:14:// verify_jwt is false (A-07): the bearer JWT is verified in code with getClaims (shared verifier).
supabase/functions/scan-control/index.ts:8: * verified in code with getClaims because verify_jwt = false, A-07). Every state change writes an audit_events row.
supabase/functions/scan-control/index.ts:20:  const { data, error } = await db.sb.auth.getClaims(token);
## xss
## console
supabase/functions/_shared/adapters/push-cli.ts:17:console.log(JSON.stringify(result));
supabase/functions/portfolio-refresh/index.ts:33:    log: (event, data) => console.log(JSON.stringify({ fn: "portfolio-refresh", event, ...data })),
supabase/functions/quotes/handler.ts:32:        console.error("rate limiter unavailable", e instanceof Error ? e.message : "unknown");
supabase/functions/quotes/handler.ts:92:    console.error("quotes failed", e instanceof Error ? e.message : "unknown");
supabase/functions/quotes/service.ts:132:          console.error("quote cache write failed", e instanceof Error ? e.message : "unknown");
supabase/functions/scan-control/index.ts:53:    console.error("scan-control failed", e instanceof Error ? e.message : String(e));
supabase/functions/worker-tick/index.ts:66:    console.error("worker-tick failed", e instanceof Error ? e.message : String(e));
## cookie
## cors
supabase/functions/_shared/adapters/http.ts:23:/** CORS headers; `access-control-allow-origin` is only set for an allowed origin. */
## redirect
apps/web/src/features/auth/redirects.ts:64:  return target === "/" ? base : `${base}?next=${encodeURIComponent(target)}`;
## yahoo_enabled
## baseurl
supabase/functions/.env.example:18:LLM_ALT_BASE_URL=
supabase/functions/_shared/adapters/flex.ts:47:export const FLEX_BASE_URL =
supabase/functions/_shared/adapters/flex.ts:159:  const base = o.baseUrl ?? FLEX_BASE_URL;
supabase/functions/_shared/adapters/llm/index.ts:19:  LLM_ALT_BASE_URL?: string | undefined;
supabase/functions/_shared/adapters/llm/index.ts:42:    baseUrl: env.LLM_ALT_BASE_URL,
supabase/functions/_shared/adapters/llm/openai-compatible.ts:36:          message: "LLM_ALT_BASE_URL, LLM_ALT_API_KEY or LLM_ALT_MODEL is not set",
```

Reading: every user-facing function verifies the bearer JWT with `getClaims` (shared `user-auth.ts` verifier for `push-subscribe`, `broker-sync` and
`portfolio-refresh`; direct call in `scan-control`). The XSS, cookie and CORS greps print nothing relevant (`http.ts:23` is a comment; `corsHeaders` sets the
origin only for an allowed one). The redirect grep prints only `features/auth/redirects.ts` (the `?next=` builder).

Reading (baseline, before the fixes): the console grep is finding S-24, the `yahoo_enabled` grep was empty (S-10), and the base-URL grep listed
`FLEX_BASE_URL` (a constant, S-27), `LLM_ALT_BASE_URL` and (through another spelling) `RESEND_API_URL`.

Same greps after Parts C and D (final state; `yahoo_enabled` and the base-URL validation now appear, the `console` list is down to the helper,
a CLI file and three call sites in files owned by other agents):

```text
## claims
supabase/functions/_shared/adapters/user-auth.ts:41:  auth: { getClaims(jwt: string): Promise<{ data: { claims: unknown } | null; error: unknown }> };
supabase/functions/_shared/adapters/user-auth.ts:44:/** Verifies the user JWT with `auth.getClaims()` (the platform JWT check is off for these functions, spec 7.3). */
supabase/functions/_shared/adapters/user-auth.ts:60:      const { data, error } = await client.auth.getClaims(jwt);
supabase/functions/push-subscribe/handler.ts:19:  /** verifies the bearer JWT (getClaims against the project JWKS) and returns the user id, or null */
supabase/functions/push-subscribe/index.ts:15:// verify_jwt is false (A-07): the bearer JWT is verified in code with getClaims (shared verifier).
supabase/functions/scan-control/index.ts:9: * verified in code with getClaims because verify_jwt = false, A-07). Every state change writes an audit_events row.
supabase/functions/scan-control/index.ts:21:  const { data, error } = await db.sb.auth.getClaims(token);
## xss
apps/web/src/lib/zod-config.ts:3:// The enforced CSP has no 'unsafe-eval'. zod 4 probes for `new Function` before compiling validators; the probe is
## console
supabase/functions/_shared/adapters/log.ts:103:/** One redacted JSON line on stdout (function logs). Use instead of console.log(JSON.stringify(...)). */
supabase/functions/_shared/adapters/log.ts:105:  console.log(JSON.stringify(redact({ event, ...data })));
supabase/functions/_shared/adapters/log.ts:110:  console.error(label, redactString(e instanceof Error ? e.message : String(e)));
supabase/functions/_shared/adapters/push-cli.ts:17:console.log(JSON.stringify(result));
supabase/functions/broker-sync/index.ts:72:      log: (event, data) => console.log(JSON.stringify({ fn: "broker-sync", event, ...data })),
supabase/functions/portfolio-refresh/index.ts:33:    log: (event, data) => console.log(JSON.stringify({ fn: "portfolio-refresh", event, ...data })),
supabase/functions/worker-tick/handlers/eur_store.ts:115:        console.error(
## cookie
## cors
supabase/functions/_shared/adapters/http.ts:23:/** CORS headers; `access-control-allow-origin` is only set for an allowed origin. */
## redirect
apps/web/src/features/auth/redirects.ts:64:  return target === "/" ? base : `${base}?next=${encodeURIComponent(target)}`;
## yahoo_enabled
supabase/functions/_shared/adapters/settings.ts:299:      ? (raw as Record<string, unknown>).yahoo_enabled
supabase/functions/scan-control/validate.ts:128:          typeof value["yahoo_enabled"] !== "boolean" ||
supabase/functions/scan-control/validate.ts:129:          Object.keys(value).some((k) => k !== "yahoo_enabled")
supabase/functions/scan-control/validate.ts:131:          return fail("providers_must_be_exactly_yahoo_enabled_boolean");
supabase/migrations/20261015007400_providers_setting.sql:3:values ('providers', '{"yahoo_enabled": true}'::jsonb, false,
supabase/migrations/20261015007400_providers_setting.sql:4:        'Provider kill switches (15.5). yahoo_enabled = false freezes every Yahoo request; the site keeps serving the last published data.')
## baseurl
supabase/functions/.env.example:18:LLM_ALT_BASE_URL=
supabase/functions/_shared/adapters/env.ts:20: * Operator-configured base URLs (LLM_ALT_BASE_URL, RESEND_API_URL) must be https; plain http is accepted
supabase/functions/_shared/adapters/flex.ts:47:export const FLEX_BASE_URL =
supabase/functions/_shared/adapters/flex.ts:159:  const base = o.baseUrl ?? FLEX_BASE_URL;
supabase/functions/_shared/adapters/llm/index.ts:21:  LLM_ALT_BASE_URL?: string | undefined;
supabase/functions/_shared/adapters/llm/index.ts:35:/** An invalid LLM_ALT_BASE_URL (not https outside a local stack) leaves the alternate provider unconfigured instead of failing every tick. */
supabase/functions/_shared/adapters/llm/index.ts:39:    return requireHttpsBase("LLM_ALT_BASE_URL", value.trim());
supabase/functions/_shared/adapters/llm/index.ts:55:    baseUrl: safeBase(env.LLM_ALT_BASE_URL),
supabase/functions/_shared/adapters/llm/openai-compatible.ts:36:          message: "LLM_ALT_BASE_URL, LLM_ALT_API_KEY or LLM_ALT_MODEL is not set",
supabase/functions/notify-dispatch/index.ts:20:        "RESEND_API_URL",
supabase/functions/notify-dispatch/index.ts:21:        Deno.env.get("RESEND_API_URL") ?? "https://api.resend.com/emails",
```

### 2. RLS matrix

Matrix suite `supabase/tests/0900_rls_matrix.test.sql` (P7 Task 2). Discrepancies and rulings:

| Discrepancy | Severity | Ruling |
|---|---|---|
| `public.is_admin()` executable by anon | Medium | FIX (S-07) |
| app functions executable by anon/authenticated via default privileges | Medium | FIX (S-20) |
| `ibkr_catalogue` public select | Info | ACCEPTED (S-18) |
| `audit_events` own-row select | Info | ACCEPTED (S-21) |
| `push_subscriptions` own-row delete | Info | ACCEPTED (S-22) |
| `ai_quota_usage` no admin read | Info | ACCEPTED (S-17) |

After `20261015007000_security_grants.sql` the matrix passes with the pinned expectations flipped (`is_admin` anon=false, `app_fn_allow` empty).

Inventory query (2026-10-15, local stack, after all migrations; 43 public tables, every one has RLS enabled):

```text

### 3. Secrets inventory

`bun run check:secrets` -> `check:secrets: OK (18 environment names, 2 example files)`. The first run (before the fixes) reported
nine names missing from the operator guide, `RECIPIENT_HASH_SECRET` missing from the name list and `FLEX_ENC_KEY_CURRENT=1` in
the example file (a version number, now exempt); see S-26. Bundle scan: `bun run check:bundle` -> `bundle secret scan: OK`
(the scan list is `SERVER_SECRET_NAMES`, covered by `secret-names.test.ts`).

Hosted comparison (`bunx supabase secrets list --project-ref <ref>`): not run: no hosted project; the operator compares names with
the table in operator guide section 2.1 and with the output of `bun run check:secrets`.

### 4. Logging and redaction

`supabase/functions/_shared/adapters/log.ts`: `REDACT_KEY` is `/token|secret|key|authorization|password|cookie|crumb|email|endpoint|p256dh|auth/i`;
strings are masked for URL credentials, bearer tokens, URL userinfo, e-mail addresses and base64-like runs of 48 or more
characters (hex digests are kept). Tested with seeded secrets (`log.test.ts`, 9 Deno tests, including `logLine` and `logError`,
which now carry every function log line except the three below). Remaining direct `console.*` calls after the final grep (section 1):
`log.ts` itself, `_shared/adapters/push-cli.ts` (CLI helper), and three in files owned by other agents (S-24).

Exact change needed in the excluded files (S-24):

- `supabase/functions/broker-sync/index.ts` line 72: `log: (event, data) => logLine(event, { fn: "broker-sync", ...data }),` with `import { logLine } from "@adapters/log.ts";`
- `supabase/functions/portfolio-refresh/index.ts` line 33: `log: (event, data) => logLine(event, { fn: "portfolio-refresh", ...data }),` with the same import.
- `supabase/functions/worker-tick/handlers/eur_store.ts` line 115: replace the `console.error(JSON.stringify({...}))` with `logLine("held_isins_read_failed", { code: res.error.code, message: res.error.message });` and make the test "any other read error is logged and rethrown" in `eur_store.test.ts` capture `console.log` instead of `console.error` (`logLine` writes to stdout).

### 5. XSS surfaces

Step 1 grep: no `dangerouslySetInnerHTML`, `innerHTML`, `eval` or `new Function` in `apps/web/src` outside tests (the one hit is a comment in
`zod-config.ts`). Markdown policy: `MarkdownBody` skips raw HTML, blocks 18 element types including `img`, `svg`, `iframe` and `form`,
rewrites non-http(s) URLs to empty, and renders a link only when its URL is in the evidence ledger (`ReportView` passes the URLs of
`research_sources` as `allowedUrls`; with none, every link is plain text). `markdown-security.test.tsx` (3 tests: hostile
payloads, ledger-only links with `rel="noopener noreferrer"`, inert hostile source line) and the P2 tests pass:
`bunx vitest run --project web apps/web/src/features/research` -> 21 passed. Runtime check of the browser policy: section 6 (CSP e2e).

### 6. CSP and headers

Commands (2026-10-15, Windows 11, Bun 1.3.14):

```text
bun run test:tools headers   -> 23 passed (parser, CSP and Permissions-Policy rules, render, committed file in template and rendered mode)
bun run build                -> render:headers: connect-src origin https://csp-e2e.supabase.co
                                bundle secret scan: OK (11 files)
                                check:headers: OK (rendered, origin https://csp-e2e.supabase.co)
bun run check:headers --template -> check:headers: OK (template)
bun run test:e2e             -> 29 passed (21 existing specs + 8 in csp.spec.ts)
                                (re-run after Parts C and D: build OK, check:headers OK, 29 passed)
```

How the real host reaches `_headers`: `apps/web/public/_headers` is a template with the token `__SUPABASE_ORIGIN__`;
`bun run build` runs `render:headers` after the Vite build, which rewrites `apps/web/dist/_headers` with the origin of
`VITE_SUPABASE_URL` (a missing or non-https URL renders `https://unset.invalid` and prints a PLACEHOLDER warning), and
`check:headers` fails the build on a wildcard, a second origin, a report-only header, an unrendered token, or a
missing/weaker header. `deploy-web.yml` already runs `tools/check-web-env.ts` (requires a real https
`VITE_SUPABASE_URL`) and then `bun run build`, so no workflow step was added (read once: lines 26, 39, 40).
Cloudflare serves `dist/_headers`; HSTS stays a dashboard setting (S-03).

What the app loads, verified against the policy:

- TradingView attribution: `features/quotes/attribution.tsx` is a plain text link to `https://www.tradingview.com/`
  (navigation, not governed by `connect-src` or `img-src`); `lightweight-charts@5.2.1` contains no network request
  (the only URLs in its bundle are the SVG namespace, the licence and the TradingView link; the logo is inline SVG).
  No policy widening needed.
- Google sign-in: a top-level redirect to the Supabase auth endpoint and back (navigation); `form-action 'self'`
  is not involved because no form posts cross-origin.
- Web Push: the subscription is created by the browser (`PushManager`), the service worker and the app talk to
  Supabase only (covered by `connect-src`), the worker is `worker-src 'self'`.
- Finding fixed on the way (S-25, Low): `zod@4.6.7` probes `Function("")` before compiling validators; the probe is
  caught but raised a `securitypolicyviolation` (`script-src eval`) on every page. `apps/web/src/lib/zod-config.ts`
  (imported first by `main.tsx`) sets `z.config({ jitless: true })`; the CSP e2e then reports no violation. No
  `unsafe-eval` was added.
- `apps/web/src/pwa-assets.test.ts` pinned the old report-only header; it now pins the enforced one.

CSP e2e (`apps/web/e2e/csp.spec.ts`, served by `tools/serve-dist.ts` with the real `dist/_headers` on port 4174):
no `securitypolicyviolation` event and no CSP console message on `/`, `/quotes?symbol=MSFT`, `/about`, `/auth/sign-in`,
`/auth/sign-up`; an injected inline script is blocked (`script-src`); a fetch to `https://evil.example` is blocked
(`connect-src`); the service worker registers with scope `/` under the policy.

Caveat recorded for the maintainers: concurrent builds into `apps/web/dist` (another agent running `bun run build`
while Playwright runs) make e2e flaky (missing hashed assets, timeouts); the passing run above had no concurrent build.

### 7. Service worker caching

See the unit test `apps/web/src/sw-routes.test.ts` (run as part of `bun run test:web`, result in section 6 evidence).

### 8. Outbound requests and SSRF

`bun run check:fetch` -> `check:fetch: OK (149 files scanned)` (a new file with an unreviewed `fetch(` call fails the command; a file that
loses its declared guard fails it too). Reviewed call sites (`FETCH_POLICY` in `tools/lib/fetch-callsites.ts`):

| File | Category | URL source |
|---|---|---|
| `_shared/adapters/yahoo.ts`, `throttle.ts`, `session.ts` | fixed-host | Yahoo hosts (query1, query2, fc); symbols never form a host |
| `_shared/adapters/fx.ts` | fixed-host | `api.frankfurter.dev` plus ISO currency codes |
| `_shared/adapters/search/tavily.ts` | fixed-host | `api.tavily.com` |
| `_shared/adapters/llm/gemini.ts` | fixed-host | `generativelanguage.googleapis.com`, URL-encoded model |
| `_shared/adapters/llm/openai-compatible.ts` | operator-configured | `LLM_ALT_BASE_URL`, `requireHttpsBase` in `llm/index.ts` (an invalid value leaves the provider unconfigured and is logged) |
| `_shared/adapters/fetchers/direct.ts` | ssrf-guarded | search-result and document URLs: `publicUrlProblem`, DNS check, re-validated redirects, `readCapped` 2 MB |
| `_shared/adapters/fetchers/jina.ts` | ssrf-guarded | `r.jina.ai` plus a target URL checked by `publicUrlProblem` |
| `_shared/adapters/fetchers/edgar.ts` | fixed-host | `sec.gov` and `data.sec.gov` paths from CIK and accession numbers |
| `_shared/adapters/email.ts` | operator-configured | `api.resend.com`; `RESEND_API_URL` validated by `requireHttpsBase` in `notify-dispatch/index.ts` |
| `_shared/adapters/flex.ts` | fixed-host | `FLEX_BASE_URL` is a constant (S-27) |
| `_shared/adapters/ibkr-catalogue.ts`, `worker-tick/handlers/eur_register.ts` | fixed-host | `www.interactivebrokers.com` constants |

Not detected by the scan and reviewed by hand: `_shared/adapters/push.ts` delegates the request to the web-push library (endpoints are
user-supplied; `isAllowedPushEndpoint` allows https push-service hosts only and runs at subscribe time in `push-subscribe`).
`requireHttpsBase` tests: `env.test.ts` (https accepted, http only for a local stack, other schemes and junk rejected).

Kill switch (S-10): `app_settings.providers = {"yahoo_enabled": true}` (migration `20261015007400_providers_setting.sql`, not public; pgTAP
`0910_providers_setting.test.sql`, 4 tests ok). `scan-control set_setting` accepts exactly `{ yahoo_enabled: boolean }` and stores it
non-public. `createThrottle({ isEnabled })` refuses every Yahoo request with `YahooUnavailableError` (no fetch call; unit-tested). The read is
cached for 30 s, a failing read keeps the last value, and anything but an explicit `false` keeps Yahoo on. Wired in `worker-tick/providers.ts`
and `quotes/provider.ts`.

Exact change needed in the excluded files (S-10): in `supabase/functions/broker-sync/index.ts` (line 33) and
`supabase/functions/portfolio-refresh/index.ts` (line 14), add to the `createYahooProvider({ ... })` options:

```ts
isEnabled: createYahooEnabledCheck(
  async () => (await sb.from("app_settings").select("value").eq("key", "providers").maybeSingle()).data?.value,
  Date.now,
),
```

with `import { createYahooEnabledCheck } from "@adapters/settings.ts";` (`sb` is the service client that `buildDeps` already creates).

### 9. Open redirects

Step 1 grep: only `features/auth/redirects.ts`. No other consumer reads `next`, `redirect` or `returnTo` from the URL.

### 10. Rate limits

`bun run probe:ratelimit` against the local stack (functions served with `RATE_LIMIT_SALT`; a rotating `X-Forwarded-For` must still run into
the limit, and one honest client must get its full allowance in the next minute):

```text
quotes (GET /functions/v1/quotes/search?q=MSFT, limit 60)
  spoofed X-Forwarded-For: 15 of 75 requests were limited
  single client: 0 of 60 requests were limited
  probe:ratelimit OK
push-subscribe (POST, limit 20)
  spoofed X-Forwarded-For: 15 of 35 requests were limited
  single client: 0 of 20 requests were limited
  probe:ratelimit OK
broker-sync (POST, limit 20)
  single client: 0 of 20 requests were limited
  probe:ratelimit FAIL: a rotating X-Forwarded-For bypassed the limit      <- not wrapped yet (S-09)
```

Unit tests: `rate-limit.test.ts` (4 Deno tests: 429 with Retry-After and CORS; per-IP buckets that reset each minute; a spoofed left-most
entry is ignored; preflight is not counted and a counter failure lets the request through). The quotes limiter now takes
`cf-connecting-ip`, else the right-most entry (S-08).

Exact change needed in the excluded files (S-09; same for `portfolio-refresh` with limit 60): in `supabase/functions/broker-sync/index.ts`
replace the final `Deno.serve` by

```ts
import { rpcIncr, withIpRateLimit } from "@adapters/rate-limit.ts";
// ...
let deps: HandlerDeps | undefined;
let limited: ((req: Request) => Promise<Response>) | undefined;
Deno.serve((req) => {
  deps ??= buildDeps();
  limited ??= withIpRateLimit((r) => handleRequest(r, deps as HandlerDeps), {
    fn: "broker-sync",
    perMinute: 20,
    salt: requireEnv("RATE_LIMIT_SALT"),
    incr: rpcIncr(createServiceClient()),
  });
  return limited(req);
});
```

(`portfolio-refresh`: `fn: "portfolio-refresh"`, `perMinute: 60`, handler `handleRequest(r, deps as RefreshDeps)`.) After the change
`bun run probe:ratelimit -- --url http://127.0.0.1:54321/functions/v1/broker-sync --method POST --limit 20` must print `probe:ratelimit OK`.

Operational note: `RATE_LIMIT_SALT` must be set in `supabase/functions/.env` locally (git-ignored; a throw-away value was added for the probe) and as a
function secret in production; otherwise `quotes`, `push-subscribe` and the wrapped functions answer 500 (`requireEnv` fails loudly).

### 11. CSRF posture

The step 1 cookie grep prints nothing: no cookie authentication, bearer tokens only (spec T9).

### 12. Dependency audit and Deno dependencies

Commands (2026-10-15, local, network available):

```text
bun audit --prod                     -> No vulnerabilities found   (bun audit --json --prod -> {})
bun run audit                        -> audit: 0 advisories (0 high or critical), 3 Deno npm packages
                                        audit: OK
bun run test:tools audit alerts      -> 12 passed (parsers, exception expiry, specifier extraction, alert rules)
```

The tool (`tools/audit-deps.ts`, policy in `tools/lib/audit.ts`) audits two dependency sets: the workspace production
dependencies through `bun audit --json --prod` (resolved by `bun.lock`) and the pinned `npm:` specifiers of the Edge
Functions (`npm:@supabase/supabase-js@2.117.3`, `npm:fast-xml-parser@5.11.2`, `npm:yahoo-finance2@4.0.3`), resolved with
`npm install --package-lock-only` in a temporary directory and checked with `npm audit --omit=dev --json`. A high or
critical advisory without a reviewed, unexpired entry in `tools/audit-exceptions.json` fails the run; the tool exits 2
when an audit cannot be read (no silent pass). `tools/audit-exceptions.json` is empty. CI: `bun run audit` is a step of the
`web` job after the bundle scan.

Deno side, checked by hand: `deno info --config supabase/functions/deno.json supabase/functions/worker-tick/index.ts`
lists exactly the three direct npm packages above plus their transitive tree (for example `zod@4.6.7`, `normalize-url`,
`filenamify`, `tldts-core`, `isexe`), which is what `npm install --package-lock-only` resolves from the same three
specifiers; the audited set matches.

No dependency was upgraded or changed in this part (no advisory required it). Finding S-19 is therefore closed with
"no production advisory on 2026-10-15".

Owner note: `bun run audit` needs network and will start failing when a new advisory is published; that is intended.

#### Keep-alive and alerts (Part F)

Implementation: `tools/lib/alerts.ts` (`evaluateAlerts`: scan age and published age against 36 h, coverage below 90%,
database above 400 MB, health `ok=false`), `tools/keepalive.ts` (password sign-in as the dedicated low-privilege user,
authenticated `app_settings` read, `scan_status` RPC, `health` function, alert evaluation, GitHub `::error::` lines and
exit 1 on any alert) and `.github/workflows/keepalive.yml` (checks out the repository, runs the tool with Bun 1.3.14; same
schedule and `KEEPALIVE_ENABLED` gate; optional variable `KEEPALIVE_MAX_AGE_HOURS=0` for a deliberate failure drill).
`bun run lint:workflows` -> `workflows: OK (ci.yml, deploy-supabase.yml, deploy-web.yml, keepalive.yml)`.
Conditions that `health` does not expose (breaker open for 1 h, deferred research, email cap, failed deliveries) stay
manual checks in the operator guide (decision P7-D8).

Local proof (2026-10-15). A completed fixture scan was not available on the shared local stack (its only run is
`running`, `last_successful` is null) and starting one would have disturbed the stack other agents are using, so the
success path was proven against a mock Supabase (scratch script, not committed) and the failure paths against both:

```text
# real local stack (http://127.0.0.1:54321, throw-away user created and deleted through the auth admin API)
$ bun run keepalive
::add-mask::<jwt>
::error::no successful scan on record
::error::no published scan result on record
exit 1        # sign-in, authenticated REST read, scan_status and health all answered; the alert rules failed it

# mock Supabase serving a scan 5 h old, complete coverage, health ok
$ bun run keepalive
keep-alive OK: authenticated read HTTP 200, freshness within 36 h, health ok          exit 0
$ KEEPALIVE_MAX_AGE_HOURS=0 bun run keepalive
::error::last successful scan finished 5.0 h ago (limit 0 h)
::error::latest published result is 5.0 h old (limit 0 h)                              exit 1
```

Owner-run, not executed locally (decision P7-D7): the GitHub-side drill (set `KEEPALIVE_MAX_AGE_HOURS=0` as a repository
variable, run the workflow by hand, expect a red run, remove the variable), and a green run against the hosted project
once its first scan completed.

## Residual risks

- S-13: `style-src 'unsafe-inline'` stays. Radix, Sonner and the chart library write style attributes; scripts remain `'self'` only and `check:headers` blocks any widening.
- S-14: the Supabase session lives in `localStorage` (T8). Only script execution can read it, which the enforced CSP and the link-safe Markdown renderer make hard.
- S-16: the document fetcher's DNS check is best effort; DNS rebinding between check and fetch is not closed (mitigated by public host names, re-validated redirects, a 2 MB cap and no secrets in requests).
- Yahoo ToS position (D1, Q-03): the pipeline uses unofficial Yahoo endpoints for personal, non-commercial use at low volume; the kill switch (`providers.yahoo_enabled`) is the remedy if Yahoo objects, and the site keeps serving the last published data.
- S-09, S-10 and S-24 remainders (`broker-sync` and `portfolio-refresh` rate limit and kill switch, three `console` calls) are small, specified changes in files owned by other agents; until they land, the per-user cooldowns of those functions are their only request limit.
- S-30 (accepted, Info): the US filter is a display filter, not an access control. There is one worldwide ranking and the public RPCs (`universe_summary`, `todays_discounts_feed`, `company_list` and the views) return it, with the company country, to anyone; accepting `us` as `p_mode` is moot because nothing user-facing reads the `us` rows. This is public market data, not personal data, so there is nothing to protect. The only per-user setting is `notification_preferences.digest_country_filter`, own row only (column grants plus the existing policies), and `anon` holds no privilege on it.
- The keep-alive GitHub drill and a green hosted run are owner-run (P7-D7).
