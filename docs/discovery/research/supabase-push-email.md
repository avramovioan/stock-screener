# Supabase platform constraints, Web Push and Resend for a scheduled-screening app

Accessed 2026-10-15. Method: WebFetch returns a model-summarised page, so quotes marked "verbatim" are as returned by the fetch tool and should be re-checked against the live page before being relied on in an ADR. Items not verified are listed in section 10.

## 1. Executive summary (hard constraints and recommended patterns)

- **Edge Function wall clock is 150 s (Free) / 400 s (Paid), CPU time 2 s, memory 256 MB** ([limits](https://supabase.com/docs/guides/functions/limits)). A 1-5 minute AI call per request is only possible on Pro, and then only one call per invocation. Design: one Edge Function invocation = one small unit of work (one batch of N securities, or one AI call), never the whole pipeline.
- **Free projects pause after about one week of insufficient user database activity** ([pausing](https://supabase.com/docs/guides/platform/free-project-pausing), [pricing](https://supabase.com/pricing)). Paid projects never pause. A paused project means the 10:00 pipeline silently does not run. Verdict: Pro ($25/month and up) is the safe choice for a production daily job; Free is viable only for development.
- **pg_cron timezone defaults to GMT** ([pg_cron README](https://github.com/citusdata/pg_cron)); I could not verify that Supabase exposes `cron.timezone`. Treat cron as UTC. DST-safe design: schedule at both 07:00 and 08:00 UTC, guard in SQL on the Sofia local hour, and use a per-local-date idempotency key (section 3).
- **pg_cron to Edge Function** via `pg_net` `net.http_post` is fire-and-forget (request starts only after the transaction commits; default timeout 2000 ms; responses kept 6 hours in `net._http_response`) ([pg_net](https://supabase.com/docs/guides/database/extensions/pg_net)). So cron kicks off a thin dispatcher and every worker invocation must persist its own checkpoint.
- **Chaining pattern**: dispatcher claims jobs from a Postgres job table (or pgmq queue) and fans out one `net.http_post` per job; each worker does one unit, writes result and checkpoint, and may use `EdgeRuntime.waitUntil` to finish after responding, still bounded by wall-clock/CPU/memory ([background tasks](https://supabase.com/docs/guides/functions/background-tasks)). A pg_cron reaper job every few minutes re-enqueues stale claims.
- **Web Push from Edge Functions**: do not rely on `npm:web-push` (reported Node-crypto incompatibilities in Deno; no official Supabase confirmation found). Prefer a Web Crypto library: `jsr:@negrel/webpush` (v0.5.0, lists Deno) or `web-push-neo` / `@pushforge/builder`. A spike is required before committing (section 7).
- **Resend**: plain `fetch` to `https://api.resend.com/emails` works (Supabase's own example uses it). Default 10 requests/s per team; free plan 100 emails/day and 3,000/month, the real constraint beyond a handful of users.
- **Supabase built-in auth email: 2 messages per hour** ([SMTP docs](https://supabase.com/docs/guides/auth/auth-smtp)); custom SMTP (Resend) is mandatory for any real sign-up flow, then 30/hour default, adjustable.

## 2. Constraints table

| Item | Free | Pro | Source |
|---|---|---|---|
| Price | "$0/month" | "from $25/month" | [pricing](https://supabase.com/pricing) |
| Edge Function wall clock | "Free plan: 150s" | "Paid plans: 400s" | [limits](https://supabase.com/docs/guides/functions/limits) |
| Request idle timeout | "150s" | "150s" | same |
| CPU time per request | "Maximum CPU Time: 2s" | same | same |
| Memory | "Maximum Memory: 256MB" | same | same |
| Bundle size | "20MB (bundled locally via the CLI) or 5MB (bundled server-side)" | same | same |
| Functions per project | 100 | 1000 (Team 2000) | same |
| Request body, cold start, concurrency | not stated on limits page | not stated | same (gap) |
| Edge invocations | "500,000 included" | "2 Million included, then $2 per 1 Million" | pricing |
| DB size | "500 MB" | "8 GB disk ... then $0.125 per GB" | pricing |
| Egress | "5 GB" | "250 GB included, then $0.09 per GB" | pricing |
| Auth MAUs | 50,000 | 100,000 then $0.00325 per MAU | pricing |
| Backups | "Not included" | "7 days" | pricing |
| Log retention | "1 day" | "7 days" | pricing |
| Pausing | "After 1 week of inactivity" | "Never" | pricing; [pausing](https://supabase.com/docs/guides/platform/free-project-pausing) |
| Realtime concurrent connections | 200 | 500 | [realtime limits](https://supabase.com/docs/guides/realtime/limits) |
| Realtime messages/s | 100 | 500 | same |
| Realtime channels per connection | 100 | 100 | same |
| Realtime broadcast payload | "256 KB" | "3,000 KB" | same |
| pg_cron guidance | "no more than 8 Jobs run concurrently"; "Each Job should run no more than 10 minutes" | same | [cron](https://supabase.com/docs/guides/cron) |
| pg_cron raw limit | `cron.max_running_jobs` default 32 | same | [pg_cron](https://github.com/citusdata/pg_cron) |
| pg_net | default timeout 2000 ms; ~200 req/s; responses kept 6 h | same | [pg_net](https://supabase.com/docs/guides/database/extensions/pg_net) |
| Built-in auth email | 2 messages/hour | same | [auth-smtp](https://supabase.com/docs/guides/auth/auth-smtp) |
| Custom SMTP default | 30 messages/hour (adjustable) | same | same |
| Resend plan | 3,000/month, 100/day, 3 domains, 30-day retention | Pro $20/mo, 50,000/month, no daily limit | [resend pricing](https://resend.com/pricing) |
| Resend API rate | 10 req/s per team default | same | [rate limit](https://resend.com/docs/api-reference/rate-limit) |

**Pro cost estimate** (from pricing page figures): base $25/month. At ~600 securities/day with a few invocations per batch, invocations are far below the 2M included; DB under 8 GB; egress under 250 GB. Expect about $25/month for Supabase plus Resend free ($0), or Resend Pro $20/month if more than 100 emails/day. This is an estimate; compute add-on pricing and credits were not extracted (gap).

## 3. DST-safe scheduling and cron to Edge Function pattern

Facts: pg_cron "defaults to GMT" and supports `'30 seconds'` interval syntax ([pg_cron README](https://github.com/citusdata/pg_cron)). Supabase Cron uses pg_cron and records runs in `cron.job_run_details` ([cron docs](https://supabase.com/docs/guides/cron)). The pg_cron README suggests cleanup such as `DELETE FROM cron.job_run_details WHERE end_time < now() - interval '7 days'` scheduled daily.

Docs sample (as returned for [schedule-functions](https://supabase.com/docs/guides/functions/schedule-functions)):

```sql
select vault.create_secret('https://project-ref.supabase.co', 'project_url');
select vault.create_secret('YOUR_SUPABASE_PUBLISHABLE_KEY', 'publishable_key');

select
  cron.schedule(
    'invoke-function-every-minute',
    '* * * * *',
    $$
    select
      net.http_post(
          url:= (select decrypted_secret from vault.decrypted_secrets where name = 'project_url') || '/functions/v1/function-name',
          headers:=jsonb_build_object(
            'Content-type', 'application/json',
            'apikey', (select decrypted_secret from vault.decrypted_secrets where name = 'publishable_key')
          ),
          body:=concat('{"time": "', now(), '"}')::jsonb
      ) as request_id;
    $$
  );
```

Recommended design (mine, not from docs):
1. Two cron entries, `0 7 * * *` and `0 8 * * *` (UTC). Sofia is UTC+2 in winter and UTC+3 in summer, so exactly one lands at 10:00 local.
2. Both call one SQL function `start_daily_run()`: return immediately unless `extract(hour from (now() at time zone 'Europe/Sofia')) = 10`; then `insert into pipeline_runs(run_date, ...) values ((now() at time zone 'Europe/Sofia')::date, ...) on conflict (run_date) do nothing returning id;` and only if a row was inserted, enqueue batches and fire the dispatcher with `net.http_post`.
3. Auth for cron to function: send a custom secret header read from Vault and set `verify_jwt = false` for the cron-only function, validating the secret in code; or keep JWT verification and send the secret key as bearer. The functions auth doc says "The default is `verify_jwt = true`" and lists wrapper modes `'user'`, `'secret'`, `'publishable'`, `'none'` ([functions auth](https://supabase.com/docs/guides/functions/auth)). Interaction with asymmetric JWT keys is unverified (gap).
4. Keep SQL work short; Postgres statement timeout defaults on Supabase were not verified. Move long work into Edge Functions.
5. Reaper cron every 2-5 minutes: requeue jobs whose lease expired; inspect `net._http_response` for non-2xx rows (6 h retention).
6. Setting `cron.timezone` on Supabase: unverified; the two-entry guard works either way.

## 4. Queue vs job table

- Supabase Queues is "a Postgres-native durable Message Queue system with guaranteed delivery" built on pgmq, with access control via API settings and RLS, and Dashboard management ([queues](https://supabase.com/docs/guides/queues)).
- SQL API (as returned for [pgmq](https://supabase.com/docs/guides/queues/pgmq)): `create extension pgmq;` `pgmq.create('my_queue')`, `pgmq.send('my_queue', '{"hello": "world"}')`, `pgmq.read('my_queue', 10, 2)` (10 s visibility timeout, 2 messages), `pgmq.archive('my_queue', array[1, 2])`, `pgmq.delete('my_queue', array[2, 3])`. "Exactly once" delivery within the visibility-timeout window.
- Not verified: `pgmq_public` RPC from Edge Functions; queue limits.
- Recommendation (mine): for ~600 securities/day use a plain `scan_jobs` table with `status`, `attempts`, `lease_until`, `unique (run_date, security_id)` and `select ... for update skip locked limit N`. It gives durable checkpoints with business columns and is easy to test with pgTAP. Use pgmq only if you want SQS-style semantics. Checkpoint state lives in your own tables either way.

## 5. Secrets and broker-token encryption

- Vault: `vault.create_secret()` takes the secret plus optional name/description and returns a UUID; `vault.decrypted_secrets` shows plaintext. "anyone that has access to the view has access to decrypted secrets"; secrets remain encrypted on disk, in backup dumps and replication streams; each project has its own root key retrievable via the pgsodium endpoint ([Vault](https://supabase.com/docs/guides/database/vault)).
- pgsodium deprecation status: not verified.
- Recommendation (mine): Vault for infrastructure secrets (project URL, cron secret). For per-user broker tokens use application-level AES-256-GCM in Edge Functions with the master key in function secrets (`supabase secrets set`), storing ciphertext, IV and a `key_version` column per row; rotation = decrypt with old key, re-encrypt with new. Reason: the Vault decrypted view exposes plaintext to any role granted it, and you do not control root-key rotation.
- Local secrets: `.env` read via `Deno.env.get(...)`; production via Edge Function secrets ([send-emails example](https://supabase.com/docs/guides/functions/examples/send-emails)).

## 6. Auth flows checklist

- supabase-js latest on npm: 2.117.3, engines Node >=22 ([npm registry](https://registry.npmjs.org/@supabase/supabase-js/latest)).
- Google OAuth ([guide](https://supabase.com/docs/guides/auth/social-login/auth-google)): create OAuth client of type "Web application"; Authorized JavaScript origins = app origin (e.g. `https://example.com`); Authorized redirect URI = the Supabase callback URL shown in the dashboard (local `http://127.0.0.1:54321/auth/v1/callback`); put Client ID/Secret into the Google provider settings; scopes `openid` (add manually), `userinfo.email`, `userinfo.profile`; extra sensitive scopes may require Google verification.
- Identity linking ([guide](https://supabase.com/docs/guides/auth/auth-identity-linking)): "Supabase Auth automatically links identities with the same email address to a single user"; unconfirmed identities are removed before linking an unverified-email identity; `linkIdentity()` links different-email identities, enabled in config or by `GOTRUE_SECURITY_MANUAL_LINKING_ENABLED: true`; `getUserIdentities()` lists identities; unlinking needs at least 2 identities. Client-side "Google-only" check (inference): `user.identities` contains no entry with `provider === 'email'`.
- CAPTCHA: hCaptcha and Cloudflare Turnstile, enabled under "Bot and Abuse Protection"; pass `captchaToken` to `signUp` ([captcha](https://supabase.com/docs/guides/auth/auth-captcha)).
- Custom SMTP: configure in Auth settings; limits per section 2.
- Not verified: PKCE specifics (`exchangeCodeForSession`, `detectSessionInUrl`), redirect-URL wildcards, `resetPasswordForEmail` then `updateUser` flow, Resend SMTP host/port/user, auth rate limits, `getClaims()`.
- Realtime ([docs](https://supabase.com/docs/guides/realtime/subscribing-to-database-changes)): Broadcast (via `realtime.broadcast_changes()` trigger, private channels, RLS on `realtime.messages`, client `setAuth()`) is "the recommended method for scalability and security"; Postgres Changes "does not scale as well". For a few users either works; prefer Broadcast-from-database.

## 7. Web Push

Protocol facts ([web.dev](https://web.dev/articles/push-notifications-web-push-protocol)): TTL mandatory; Topic optional (replaces pending messages); Urgency optional (`very-low`, `low`, `normal` default, `high`); 201 accepted; 404 and 410 mean delete the subscription; 413 payload too large (minimum supported 4096 bytes); 429 rate limit, honour `Retry-After`.

iOS/iPadOS ([WebKit](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/)): supported from iOS/iPadOS 16.4; app must be added to the Home Screen; permission request must follow direct user interaction; manifest `display` must be `standalone` or `fullscreen`; allow `*.push.apple.com`; no Apple Developer Program membership needed.

Matrix: iOS/iPadOS 16.4+ verified. Android Chrome, desktop Chrome/Edge/Firefox, macOS Safari: not verified in this pass.

Library evidence:
- `jsr:@negrel/webpush` v0.5.0: "Web Push library implementing RFC 8291 and RFC 8292, based on Web APIs"; works with Cloudflare Workers, Deno, Bun, Browsers; exports `generateVapidKeys`, `importVapidKeys`, `exportVapidKeys`, `exportApplicationServerKey`; SubtleCrypto; last published about a year ago; no expert crypto review ([JSR](https://jsr.io/@negrel/webpush)).
- `npm:web-push`: search results report crypto problems on Deno ([deno issue 23693](https://redirect.github.com/denoland/deno/issues/23693), [dev.to](https://dev.to/yigit-konur/using-npm-packages-on-supabase-deno-runtime-4p32)); I did not open these threads. A third-party page ([clix](https://docs.clix.so/integrations/supabase-integration)) describes a Supabase function using `web-push`. Evidence conflicting and unconfirmed.
- Alternatives: [web-push-neo](https://github.com/ryoppippi/web-push-neo) (Web Crypto + fetch), [@pushforge/builder](https://github.com/draphy/pushforge) (snippets only).
- Recommendation: `jsr:@negrel/webpush` plus a mandatory spike (real push to Chrome, Firefox, iOS from both `supabase functions serve` and a deployed function). Fallback: web-push-neo.
- Not verified: `pushsubscriptionchange` behaviour, `Notification.permission` re-check, VAPID key storage, the 4078-byte payload figure.

## 8. Resend

- Send via `fetch('https://api.resend.com/emails', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + RESEND_API_KEY }, body: JSON.stringify({from, to, subject, html}) })` ([Supabase example](https://supabase.com/docs/guides/functions/examples/send-emails)).
- `Idempotency-Key`: expires after 24 hours, max 256 characters; max 50 recipients per email; 40 MB attachment cap after Base64; `scheduled_at` supported ([send-email](https://resend.com/docs/api-reference/emails/send-email)). Suggested key: `digest:<user_id>:<local_date>`.
- Rate limit 10 req/s per team ([rate limit](https://resend.com/docs/api-reference/rate-limit)). Free: 3,000/month, 100/day, 3 domains, 30-day retention; Pro $20/month for 50,000 emails ([pricing](https://resend.com/pricing)).
- Domain: add and verify a domain; use a subdomain (e.g. `updates.example.com`); SPF, DKIM, Return-Path; then DMARC/BIMI ([domains](https://resend.com/docs/dashboard/domains/introduction)).
- Unsubscribe: `List-Unsubscribe: <url>` plus `List-Unsubscribe-Post: List-Unsubscribe=One-Click` (RFC 8058); answer POST with 200/202; stop sending within 48 hours ([guide](https://resend.com/docs/dashboard/emails/add-unsubscribe-to-transactional-emails)).
- Webhooks: headers `svix-id`, `svix-timestamp`, `svix-signature`; `resend.webhooks.verify()` throws if invalid; use the raw body; alternative `new Webhook(secret).verify(payload, headers)` from Svix ([verify](https://resend.com/docs/dashboard/webhooks/verify-webhooks-requests)). Event type list not verified.
- Not verified: batch endpoint, suppression lists, SMTP host/port.

## 9. Local dev and CI on Windows

- Install: `bun add -D supabase` (or npm), or Scoop (`scoop bucket add supabase https://github.com/supabase/scoop-bucket.git`, `scoop install supabase`) ([CLI getting started](https://supabase.com/docs/guides/local-development/cli/getting-started)).
- Documented commands: `supabase start`, `supabase stop` (preserves DB), `supabase db reset`, `supabase db push`, `supabase functions serve`.
- For local `EdgeRuntime.waitUntil` to finish, set `policy = "per_worker"` in `supabase/config.toml` ([background tasks](https://supabase.com/docs/guides/functions/background-tasks)).
- Per-function `deno.json` recommended; `npm:`, `jsr:`, `node:` specifiers supported; import maps are legacy ([dependencies](https://supabase.com/docs/guides/functions/dependencies)).
- Not verified: `supabase test db`, `db diff`, `functions deploy`, GitHub Actions workflow, Deno install on Windows, `deno check`/`deno test`, seeding, two-user RLS tests.

## 10. Open questions and unverified items

1. Whether Supabase allows setting `cron.timezone`; pg_cron version on Supabase.
2. Edge Runtime Deno version; cold start; request body limit; concurrency; whether I/O wait counts against the 2 s CPU limit.
3. Whether pg_cron, Edge Function calls or anonymous REST reads count as activity: docs say only "sufficient user database activity" and "a few user requests to the database each day". Restore window of 1 year is verified.
4. `npm:web-push` on Supabase Edge Runtime: conflicting, unconfirmed.
5. pgsodium deprecation; DB statement timeout defaults; `pgmq_public` from Edge Functions.
6. Asymmetric JWT signing keys, `getClaims()`, cron auth with new secret keys.
7. Auth rate limits, PKCE/redirect wildcards, reset flow, Resend SMTP settings.
8. Android and desktop push matrix, `pushsubscriptionchange`, payload limit.
9. Resend batch, suppression, webhook events, retention on paid tiers.
10. Compute add-on pricing and Pro spend cap.
11. WebFetch summaries are model-condensed; re-verify load-bearing numbers (150/400 s, 2 s CPU) on the live pages.

## 11. Second-pass verification (accessed 2026-10-15)

Method note: WebFetch condenses pages with a small model; where a fetch returned nothing on a point, it is reported as "not found on that page", not as proof of absence. GitHub issue pages sometimes returned only navigation text.

### Corrections to sections 1-10
- Section 10 item 3 and section 1 are unchanged in substance, but the pausing page now gives more detail (see 11.2). Nothing in 11.1-11.8 contradicts sections 1-9, except: section 3 point 6 ("cron.timezone unverified") is now partly answered (11.1), and section 7 statement that `npm:web-push` has "conflicting evidence" is refined by 11.5 (the one concrete Deno failure was fixed upstream in Oct 2024).

### 11.1 pg_cron on Supabase
- Version: no pg_cron version is listed on the [extensions page](https://supabase.com/docs/guides/database/extensions) (fetch said none). The [pg_cron debugging guide](https://supabase.com/docs/guides/troubleshooting/pgcron-debugging-guide-n1KTaz) says: "You should consider initiating a software upgrade in the General Settings if your Postgres version is below v15.6.1.122" and recommends upgrading to pg_cron v1.6.4 for stability. So v1.6.4 is the reference version; the exact version on a given project is not confirmed (check `select extversion from pg_extension where extname='pg_cron'` on the real project).
- Concurrency: "pg_cron supports up to 32 concurrent jobs, each using a database connection" (same guide); the cron docs separately recommend at most 8 concurrent and 10 minutes per job. Long jobs: guide suggests "wrapping their queries in functions with custom timeouts" (statement timeout default value still not found).
- Timezone: pg_cron README: "optionally, specify the timezone in which the pg_cron background worker should run (defaults to GMT). E.g: cron.timezone = 'PRC'" ([README](https://github.com/citusdata/pg_cron)). I found NO Supabase doc or GitHub discussion stating that `cron.timezone` can be set on the hosted platform. A third-party test ([dev.to](https://dev.to/__aa3e4bc832ba7032bfa3/supabase-timezone-cron-m1e)) reports the scheduler stays on UTC even after `alter database postgres set timezone`, which only changes timestamp display. Conclusion: treat the schedule as UTC; the two-entry (07:00/08:00 UTC) plus Sofia-hour guard in section 3 stands.
- `cron.schedule` with `$$ ... $$` body calling `net.http_post`: confirmed by the docs sample in section 3 (from the schedule-functions page). Cleanup of `cron.job_run_details`: README example `DELETE FROM cron.job_run_details WHERE end_time < now() - interval '7 days'`.

### 11.2 Free-tier pausing
- [upgrading-and-pausing](https://supabase.com/docs/guides/platform/upgrading-and-pausing) does not define activity (it only covers the restore window and backup download). The [free-project-pausing](https://supabase.com/docs/guides/platform/free-project-pausing) page says: "A Free plan project is considered inactive if it does not receive sufficient user database activity over the past week"; "a few user requests to the database each day over the previous week is enough to keep the project from being paused". Warning email roughly one week before; confirmation email after pausing. Prevention: visit the Dashboard, or "making API calls or sending requests through their connected application". Restore: Dashboard, select the project, "Resume project"; restorable within 1 year; afterwards download the backup and Storage objects and restore to a new project or locally.
- Not stated anywhere I fetched: whether pg_cron runs, Edge Function invocations or anonymous REST reads count. The text says "user" database activity, which suggests internal cron queries may not count; unverified. Do not rely on cron to keep a Free project alive.

### 11.3 JWT keys, getClaims, cron authentication
- [Signing keys](https://supabase.com/docs/guides/auth/signing-keys): asymmetric keys (RSA/EC) recommended over legacy shared secret; JWKS at `https://<project>.supabase.co/auth/v1/.well-known/jwks.json`, cached 10 minutes at the edge. "For Edge Functions and backend components, use `supabase.auth.getClaims()` to verify JWTs". When rotating keys, disable the Verify JWT setting if your code verifies against the legacy secret, and instead verify with `getClaims()` or a JWKS-aware library such as `jose`.
- [Functions auth](https://supabase.com/docs/guides/functions/auth): "The default is `verify_jwt = true`, so the platform validates the JWT before your handler runs"; wrapper modes `'user'`, `'secret'`, `'publishable'`, `'none'`; `ctx.supabaseAdmin` bypasses RLS and must be filtered by caller id.
- Per-function config: [function configuration](https://supabase.com/docs/guides/functions/function-configuration) shows `[functions.stripe-webhook]` with `verify_jwt = false`, `import_map = './functions/<name>/import_map.json'`, `entrypoint = ...` in `supabase/config.toml`. Deploy flag `--no-verify-jwt` exists ([deploy](https://supabase.com/docs/guides/functions/deploy)).
- Cron to function: the docs sample sends an `apikey` header with the publishable key read from Vault (`vault.decrypted_secrets`). A secret-key or custom-secret-header scheme is my recommendation, not a documented pattern: store the secret in Vault, send it in a header, set `verify_jwt = false` for that function, compare in constant time in code. Whether the platform still accepts the legacy service-role JWT as Bearer alongside new secret keys is not verified.

### 11.4 Edge Runtime
- Latest edge-runtime release on GitHub: v1.77.4, dated 2026-10-01 ([releases](https://github.com/supabase/edge-runtime/releases)); release notes shown did not state the Deno version. Issue #466 "Request for Update to Deno 2.1" is closed (Aug 2025) per the issue list, which suggests Deno 2 support landed, but the exact Deno version is not confirmed.
- `npm:`, `jsr:`, `node:` specifiers, per-function `deno.json` (recommended), import_map legacy: confirmed in section 9 source.
- Cold start: architecture page says "Even initial executions are fast (milliseconds) due to the compact ESZip format"; "Multiple isolates can run simultaneously in the same edge location". No numeric concurrency limit found.
- CPU limit: the [CPU limits troubleshooting page](https://supabase.com/docs/guides/troubleshooting/edge-function-cpu-limits) says "2 seconds of active computing per request" but does not say whether async I/O wait counts. Error 546 (WORKER_RESOURCE_LIMIT) is the failure signal. Request body size limit: not found.

### 11.5 npm:web-push under Edge Runtime
- [web-push issue #904](https://github.com/web-push-libs/web-push/issues/904) "Deno Support" (closed 2024-10-08): `sendNotification` with a payload on Deno produced "AES-GCM decryption failed" in Chrome (no payload worked); maintainer said it was resolved upstream in Deno ([denoland/deno#23693](https://redirect.github.com/denoland/deno/issues/23693)).
- [edge-runtime issue #334](https://github.com/supabase/edge-runtime/issues/334) "Support private EC key signing" (closed 2024-06-19): missing private EC key support in the runtime; fixed in edge-runtime v1.54.0+. Relevant because VAPID signing uses EC keys.
- [edge-runtime issue #536](https://github.com/supabase/edge-runtime/issues/536) "Deno fetch: error sending request for url": page content could not be read; unknown whether related.
- Net: the known payload and EC-signing failures were fixed in 2024 (Deno upstream fix, edge-runtime 1.54.0+); current runtime is v1.77.x. I found no open issue showing `npm:web-push` failing now, but I also found no documented successful deployment, so a spike is still required. Keep `@negrel/webpush` as the primary choice.
- [@negrel/webpush README](https://github.com/negrel/webpush) confirms: "Web Push library (RFC 8291 and RFC 8292)", Deno and "other web compatible runtime", `aes128gcm` through the `http-ece` dependency, `generate-vapid-keys` script, example server, repo tags include Supabase; warning: "hasn't been reviewed by crypto experts and may be unsecure".

### 11.6 Auth flows
- PKCE ([docs](https://supabase.com/docs/guides/auth/sessions/pkce-flow)): `flowType: 'pkce'`; `exchangeCodeForSession(code)`; the code is valid 5 minutes and single-use; `detectSessionInUrl: true` makes the client exchange the code automatically; the code verifier is stored locally so the exchange must happen in the same browser. Whether `pkce` is the default for supabase-js v2 was not stated on the page.
- Redirect allow-list ([docs](https://supabase.com/docs/guides/auth/redirect-urls)): `*` matches any sequence of non-separator characters, `**` any sequence of characters, `?` a single non-separator character; separators are `.` and `/`; use precise paths in production, globstar only for dev and previews.
- Password reset ([docs](https://supabase.com/docs/guides/auth/passwords)): `resetPasswordForEmail(email, {redirectTo})`; `redirectTo` must be in the redirect URLs; user lands on your change-password page; token verified (`verifyOtp` with `token_hash` in the SSR variant, or the `PASSWORD_RECOVERY` auth event in an SPA); then `updateUser({password})`.
- Linking: as section 6; Google-only detection via `user.identities` (no `email` provider) or `app_metadata.providers` is my inference, not quoted from docs.
- Rate limits ([table](https://supabase.com/docs/guides/auth/rate-limits)): built-in email 2/hour; SMS 30/hour; sign-up/sign-in/recover/resend/magiclink/otp/user endpoints per IP 30 requests per 5 minutes (burst 30); OTP/magic link, signup confirmation and password reset per user: 60 seconds between requests; verification per IP 30 per 5 min; token endpoint per IP 150 per 5 min (burst 30); MFA 15 per minute; anonymous sign-ins 30 per hour.
- CAPTCHA: hCaptcha and Cloudflare Turnstile only (section 6).
- Resend SMTP for Supabase ([docs](https://resend.com/docs/send-with-supabase-smtp)): host `smtp.resend.com`, port `465`, username `resend`, password = your API key.

### 11.7 Local dev and CI
- pgTAP ([testing overview](https://supabase.com/docs/guides/local-development/testing/overview)): run `supabase test db`; tests are SQL files wrapped in `begin`/`rollback`; two-user RLS tests: insert separate `auth.users` rows, `set local role authenticated;`, `set local request.jwt.claim.sub = '<user_id>'`; the Basejump repo is referenced for examples.
- CI ([CI/CD workflow](https://supabase.com/docs/guides/functions/cicd-workflow)): `uses: supabase/setup-cli@v1` with `version: latest`; secret `SUPABASE_ACCESS_TOKEN`; `supabase functions deploy --project-ref $PROJECT_ID`. Deploy page lists `supabase functions deploy [name]`, `--use-api`, `--no-verify-jwt`. Migration deploy in CI (`supabase link` then `supabase db push` with `SUPABASE_DB_PASSWORD`): not verified on a docs page in this pass.
- Deno on Windows ([Deno docs](https://docs.deno.com/runtime/getting_started/installation/)): `winget install DenoLand.Deno`, `npm install -g deno`, `scoop install deno`, `choco install deno`, or `irm https://deno.land/install.ps1 | iex`; docs note npm install slows Deno startup.
- Not verified: `supabase db reset` with `seed.sql` page; `deno check` / `deno test` invocation for a function directory (standard Deno CLI, not sourced here).

### 11.8 Resend
- Batch ([docs](https://resend.com/docs/api-reference/emails/send-batch-emails)): "Trigger up to 100 batch emails at once", up to 50 recipients each, `attachments` not supported in batch, idempotency key header same rules (24 h, 256 chars), response order matches payload index.
- Webhook events ([docs](https://resend.com/docs/webhooks/event-types)): `email.sent`, `email.delivered`, `email.delivery_delayed`, `email.bounced`, `email.complained`, `email.failed`, `email.opened`, `email.clicked`, `email.received`, `email.scheduled`, `email.suppressed`; plus `domain.*`, `contact.*`, `suppression.added/removed`, `topic.*` and private-beta `inbox.*`. Svix headers: `svix-id`, `svix-timestamp`, `svix-signature` (section 8).
- Suppression ([page](https://resend.com/docs/dashboard/emails/email-suppressions)): fetch yielded no plan-specific or retention detail; `email.suppressed` and `suppression.added` events exist. Log retention: Free 30 days (pricing page); Pro retention not verified.
- Unsubscribe requirement text: see section 8; applies as mandatory for bulk senders over 5,000 daily messages to Gmail/Yahoo.

### 11.9 Still unverified after second pass
Exact pg_cron and Deno versions on a live project; whether `cron.timezone` is settable on hosted Supabase (no evidence either way); whether cron/Edge/REST calls count for pausing; I/O wait in the CPU limit; request body size limit; numeric concurrency; acceptance of legacy service-role JWT vs new secret keys for `verify_jwt = true`; `pkce` default; migration deploy CI snippet; seed.sql doc; `deno check/test` for functions; Resend Pro log retention and suppression details; edge-runtime issue #536 content; a documented successful `npm:web-push` deployment on Supabase.

## 12. Sources (all accessed 2026-10-15; second-pass additions listed at the end)

- https://supabase.com/docs/guides/functions/limits (Edge Functions limits)
- https://supabase.com/docs/guides/functions/schedule-functions (Scheduling Edge Functions)
- https://supabase.com/docs/guides/cron (Supabase Cron)
- https://supabase.com/pricing (Pricing)
- https://supabase.com/docs/guides/platform/free-project-pausing (Project Pausing)
- https://supabase.com/docs/guides/platform/billing-faq (Billing FAQ; nothing on pausing)
- https://supabase.com/docs/guides/queues and https://supabase.com/docs/guides/queues/pgmq
- https://supabase.com/docs/guides/functions/background-tasks
- https://supabase.com/docs/guides/functions/auth
- https://supabase.com/docs/guides/functions/dependencies
- https://supabase.com/docs/guides/functions/examples/send-emails
- https://supabase.com/docs/guides/functions/examples/push-notifications (mobile only)
- https://supabase.com/docs/guides/database/extensions/pg_net
- https://supabase.com/docs/guides/database/vault
- https://supabase.com/docs/guides/auth/auth-smtp
- https://supabase.com/docs/guides/auth/auth-identity-linking
- https://supabase.com/docs/guides/auth/auth-captcha
- https://supabase.com/docs/guides/auth/social-login/auth-google
- https://supabase.com/docs/guides/realtime/limits
- https://supabase.com/docs/guides/realtime/subscribing-to-database-changes
- https://supabase.com/docs/guides/local-development/cli/getting-started
- https://github.com/citusdata/pg_cron
- https://registry.npmjs.org/@supabase/supabase-js/latest
- https://jsr.io/@negrel/webpush
- https://github.com/ryoppippi/web-push-neo ; https://github.com/draphy/pushforge (search snippets only)
- https://redirect.github.com/denoland/deno/issues/23693 ; https://dev.to/yigit-konur/using-npm-packages-on-supabase-deno-runtime-4p32 ; https://docs.clix.so/integrations/supabase-integration (search leads, not opened)
- https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/
- https://web.dev/articles/push-notifications-web-push-protocol
- https://resend.com/docs/api-reference/rate-limit ; https://resend.com/docs/api-reference/emails/send-email ; https://resend.com/pricing ; https://resend.com/docs/dashboard/webhooks/verify-webhooks-requests ; https://resend.com/docs/dashboard/emails/add-unsubscribe-to-transactional-emails ; https://resend.com/docs/dashboard/domains/introduction
- Second pass additions: https://supabase.com/docs/guides/platform/upgrading-and-pausing ; https://supabase.com/docs/guides/platform/free-project-pausing.md ; https://supabase.com/docs/guides/auth/signing-keys ; https://supabase.com/docs/guides/functions/function-configuration ; https://supabase.com/docs/guides/functions/architecture ; https://supabase.com/docs/guides/functions/deploy ; https://supabase.com/docs/guides/functions/cicd-workflow ; https://supabase.com/docs/guides/functions/troubleshooting ; https://supabase.com/docs/guides/troubleshooting/edge-function-cpu-limits ; https://supabase.com/docs/guides/troubleshooting/pgcron-debugging-guide-n1KTaz ; https://supabase.com/docs/guides/database/extensions ; https://supabase.com/docs/guides/auth/redirect-urls ; https://supabase.com/docs/guides/auth/rate-limits ; https://supabase.com/docs/guides/auth/passwords ; https://supabase.com/docs/guides/auth/sessions/pkce-flow ; https://supabase.com/docs/guides/local-development/testing/overview ; https://github.com/supabase/edge-runtime/releases ; https://github.com/supabase/edge-runtime/issues/334 ; https://github.com/supabase/edge-runtime/issues/536 ; https://github.com/web-push-libs/web-push/issues/904 ; https://github.com/negrel/webpush ; https://dev.to/__aa3e4bc832ba7032bfa3/supabase-timezone-cron-m1e ; https://docs.deno.com/runtime/getting_started/installation/ ; https://resend.com/docs/send-with-supabase-smtp ; https://resend.com/docs/api-reference/emails/send-batch-emails ; https://resend.com/docs/webhooks/event-types ; https://resend.com/docs/dashboard/emails/email-suppressions
