# P3 Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver spec section 10 and phase P3 of section 18: the notification schema with RLS and cut-off SQL, the pure digest module (`core/digest.ts`) with text, HTML and push renderers, the Web Push and Resend adapters (with the mandatory local Web Push spike), the `digest` stage handler, the `notify-dispatch` Edge Function (claim, preference re-check, retries, quota, subscription lifecycle), the user-facing functions `push-subscribe`, `resend-webhook` and `notify-unsubscribe`, the service-worker push handling and the Profile -> Notifications page, plus integration tests and the operator-guide sections 4 and 12. A scan produces at most two logical digests per user (`discounts`, `portfolio`); each is delivered to each opted-in channel and the copies are one logical notification.

**Architecture:** Creation and delivery are separate states. The `digest` stage (inside `worker-tick`) reads candidates through service-only RPCs, builds each user's digest with the pure `core/digest.ts` (ordering, mode merge, empty rule, assertions), and writes `digests`, `digest_items` and `digest_deliveries` in ONE SQL transaction per digest (`public.notify_insert_digest`), guarded by three UNIQUE constraints, so re-running the stage creates nothing. `notify-dispatch` (cron-secret protected, kicked by `app.kick_workers()` only when `app.pending_delivery_count() > 0`) claims deliveries with `FOR UPDATE SKIP LOCKED` and a lease (`next_attempt_at` pushed forward, status stays `pending`), re-reads preferences immediately before every send, sends push (per active subscription) or email (Resend with a stable `Idempotency-Key`), and completes the SAME delivery row (`sent`, `skipped`, `failed`, `bounced` or back to `pending` with backoff), so a retry can never create a second logical alert. Adapters take injected `fetch` seams; handlers take a store interface with an in-memory fake, so every branch is a Deno test with no network. Pure logic (ordering, rendering, payload size) lives in core and is tested with Vitest. The browser never sees secrets: it holds only `VITE_VAPID_PUBLIC_KEY`.

**Tech Stack:** Bun 1.3.14, Node 22.13.1 (Vitest 5.0.4 `core`, `tools`, `web` projects), Deno 2.9.6 local (CI 2.1.x; `deno test` via `bun run functions:test`), TypeScript 6.0.3, Biome 2.5.15, Supabase CLI 2.121.0 with pgTAP, `jsr:@negrel/webpush@0.5.0`, `@supabase/supabase-js` 2.117.3 (`getClaims()`), Resend REST API (plain `fetch`), Svix signature scheme (hand-written HMAC with Web Crypto), React 19.3.1, Testing Library 16.3.3, happy-dom 21.0.1. Windows 11 commands (PowerShell); no network in tests.

**Spec:** docs/superpowers/specs/2026-10-15-stock-screener-design.md (sections 4.10, 6.3, 6.8, 6.9, 7.1, 7.4, 7.10, 7.11, 8.7, 10, 11.5, 14.3, 14.8, 16.5, 16.6, 17, 18 P3, 19 A-13, A-24, A-25, A-31); research `docs/discovery/research/supabase-push-email.md` sections 7, 8 and 11.5; brief `prompt.txt` lines 918 to 1024 and 1605 to 1613.

**Prerequisites (other phases, names assumed where not yet written):** P0 (committed): `apps/web/src/sw.ts` with `push`/`notificationclick`, `sw-routes.ts` (`parsePushPayload`, `resolveNotificationUrl`), `register-sw.ts`, `tools/new-function.ts`, `_shared/adapters/{http,env}.ts` (`json`, `corsHeaders`, `requireCronSecret`, `timingSafeEqualStrings`, `readJson`, `requireEnv`), `supabase/config.toml` function blocks, canonical per-function import map (`@core/`, `@adapters/`, `@supabase/supabase-js`; `@std/assert` is in `supabase/functions/deno.json`), `tools/lib/functions-config.ts` (every function directory needs a `[functions.<name>] verify_jwt = false` block). P1 (assumed): enums `universe_mode`, `job_stage` (includes `digest`), tables `scan_runs` (`status`, `scan_date_local`, `latest_session_date`), `scan_jobs (scan_run_id, stage, key, priority)`, `scan_events`, `signal_episodes`, `todays_discounts`, `securities`, `companies`, `eur_equivalents`, `ai_quota_usage`, `audit_events`, `profiles`, functions `app.kick_workers()`, `app.reap_expired_leases()`, and the `worker-tick` `HANDLERS` registry. P2 (assumed): `risk_findings`, `research_reports`. P5a: `AuthProvider`/`useAuth`, `requireAuth`, the Profile layout with the placeholder `apps/web/src/features/profile/panels/notifications-panel.tsx`, `@/lib/supabase`. P5b: `broker_positions` (may not exist yet: every query that touches it is guarded with `to_regclass`).

## Global Constraints

- **Two logical digests per scan, per user:** `discounts` and `portfolio`. One logical notification across channels: the push and email copies are two `digest_deliveries` rows of ONE `digests` row. Creation (digest rows) and delivery (delivery rows, attempts) are separate states.
- **Uniqueness (idempotency, spec 7.11):** `digests UNIQUE (scan_run_id, kind, user_id)`; `digest_items UNIQUE (user_id, ref_type, ref_id)`; `digest_deliveries UNIQUE (digest_id, user_id, channel)`; `email_events.svix_id UNIQUE`; `push_subscriptions.endpoint UNIQUE`.
- **Content rules:** discounts are ordered Green then Amber, then rank ascending, then `yahooSymbol` ascending (code-unit order, never `localeCompare`). Red, grey and pending candidates are never in a digest: the caller filters, `core/digest.ts` throws if one is passed. A candidate with incomplete research is not marked cleared and not listed. At the 13:00 Sofia cut-off only candidates with a completed report (`research_completed_at is not null`) are included. Empty digests are skipped (`digests.status = 'skipped'`, `skip_reason = 'empty'`, no deliveries) unless `send_empty`. A holding with both a new premium event and a new risk finding is ONE portfolio entry. Emails and pushes contain tickers, signals and links only: no quantities, cost basis or values. Amber entries carry the warning text "Higher risk - moderate bankruptcy risk" and a one-line reason.
- **Email:** cap 90 per UTC day (`app.consume_quota_capped('resend','email_day',1,'day',90)`); a delivery that cannot get quota ends `skipped` with `skip_reason = 'daily_cap'`; portfolio deliveries are claimed before discounts deliveries; Resend header `Idempotency-Key: digest:<kind>:<user_id>:<scan_date_local>` (same value on every retry; at most 256 characters); headers `List-Unsubscribe: <url>` and `List-Unsubscribe-Post: List-Unsubscribe=One-Click`; sender from `EMAIL_FROM`; requests spaced 150 ms apart; a digest older than 24 h is never sent (`failed`, `last_error = 'expired'`).
- **Web Push:** `Topic` per digest kind (`digest-discounts`, `digest-portfolio`: the Web Push Topic alphabet is URL-safe base64 and at most 32 characters, so the spec's `digest:<kind>` colon form is invalid and is replaced), `TTL = 21600` (6 h), urgency `normal`; 404 and 410 revoke the subscription (`revoked_at` set, never used again, purged after 30 days by retention); 413 is fatal for that subscription; 429 honours `Retry-After`; 5 consecutive failures revoke a subscription; the delivery is `sent` when at least one subscription succeeded; the payload JSON is at most 3,500 bytes (push services must accept 4,096).
- **Retry schedule:** attempt n failing transiently reschedules after 1 min, 5 min, 30 min, 2 h (n = 1..4); the 5th failed attempt ends `failed`. A claim leases the row for 10 minutes by moving `next_attempt_at` forward; status stays `pending`.
- **Secrets:** `VAPID_PRIVATE_KEY` (JWK JSON of the private key, the format `jsr:@negrel/webpush` documents), `VAPID_PUBLIC_KEY` (base64url application server key), `VAPID_SUBJECT` (`mailto:`), `RESEND_API_KEY`, `EMAIL_FROM`, `RESEND_WEBHOOK_SECRET` (`whsec_...`), `UNSUBSCRIBE_SECRET`, `SITE_URL` exist only as Supabase function secrets (`supabase secrets set`, local `supabase/functions/.env`). The browser knows only `VITE_VAPID_PUBLIC_KEY`. `tools/check-bundle-secrets.ts` already scans for `VAPID_PRIVATE` and `RESEND_API_KEY`.
- **Preferences are enforced server-side:** digest creation reads current preferences; `notify-dispatch` re-reads them immediately before each send; a browser subscription alone never opts a user in (`push_enabled` is a separate switch); email also needs a confirmed address, `email_unsubscribed_at is null` and `email_bounced_at is null`.
- **Logging:** never log tokens, push endpoints, `p256dh`/`auth` keys, email addresses, payloads or Resend/Svix secrets. Logs carry delivery ids, channels, status classes and counts. `email_events` stores `recipient_hash` (HMAC) and a payload with every address and subject removed.
- **iOS guidance text (verbatim in the UI):** "On iPhone and iPad, notifications work from iOS 16.4 and only for apps added to the Home Screen. Tap Share, choose Add to Home Screen, open Stock Screener from the Home Screen icon, then come back here and enable notifications."
- **Conventions inherited from P0:** Biome (2 spaces, width 100, double quotes, semicolons, `useImportType`, no `any`), `tsc` strict flags (`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`), `.ts` extensions on every import inside `supabase/functions`, core files use relative `.ts` imports only, Deno tests use `Deno.test` and `@std/assert`, Vitest for core and web, a conventional-commit commit at the end of every task, never commit `.env` files or keys.
- **Shell:** Windows 11 PowerShell. Where a step shows a multi-line commit message use a PowerShell here-string; commands in this plan contain no bash-only syntax.

## Plan decisions that deviate from, or complete, the spec (record in the decision log)

1. **Enums follow the brief:** `delivery_status` is `pending|sent|failed|skipped|bounced` and the channel enum is `delivery_channel` (spec: `notify_channel`, more states). The spec's `sending` becomes a lease on `next_attempt_at`; `suppressed` becomes `skipped` with a `skip_reason`; `expired` becomes `failed` with `last_error = 'expired'`; `delivered` becomes the `delivered_at` timestamp (status stays `sent`).
2. **Column names follow the brief:** `digests.content` (spec `payload`), `notification_preferences.send_empty` (spec `send_empty_digests`), `digest_items.ref_type in ('episode','finding')`, `push_subscriptions.revoked_at/revoke_reason` (spec `status`). Added: `digests.status/skip_reason`, `digest_deliveries.skip_reason/idempotency_key/attempt_log/delivered_at/quota_consumed`, `notification_preferences.email_bounced_at`, `email_events.delivery_id`.
3. **Environment names follow the brief:** `EMAIL_FROM` (spec `RESEND_FROM`), `UNSUBSCRIBE_SECRET` (spec `UNSUBSCRIBE_SIGNING_KEY`). The unsubscribe token is `<user_id>.<base64url(HMAC-SHA256(user_id, UNSUBSCRIBE_SECRET))>` without an expiry (an unsubscribe link must keep working), served by its own function `notify-unsubscribe` (spec: a path of `notify-dispatch`). Update spec 3.11 when recording the decision.
4. **Edge-facing RPCs live in `public` as `notify_*` (service role only)** because PostgREST exposes only `public`; `app.claim_deliveries`, `app.consume_quota_capped`, `app.pending_delivery_count`, `app.cutoff_digests` stay in `app` as the brief names them. If P1 chose another exposure mechanism for worker RPCs, change only the `.rpc()` names in the store files.
5. **Clients cannot INSERT into `push_subscriptions`** (the brief lists owner-insert). A client-chosen endpoint would make the server POST to an arbitrary URL (SSRF). Owner SELECT (safe columns) and DELETE are granted; inserts go through `push-subscribe`, which validates the endpoint host allow-list and key lengths. pgTAP pins this.
6. **404/410 revoke instead of deleting the row** (`revoked_at`, `revoke_reason = 'gone'`): the row stays for 30 days for diagnostics, is never used again, and a later `subscribe` with the same endpoint revives it.
7. **Risk-finding dedupe is per user:** candidates are findings without a `digest_items` row for that user (not `notified_at is null`, which is global and would hide a finding from the second holder). `notified_at` is still stamped on insert for observability.
8. **Quota function:** a new `app.consume_quota_capped(provider, resource, amount, period_kind, limit)` is added instead of overloading P1's 4-argument `app.consume_quota`; the row lives in `ai_quota_usage` (`provider 'resend'`, `resource 'email_day'`).
9. **Email cap reached ends the delivery `skipped/daily_cap`** (brief; spec 10.6 would defer to the next UTC day). A next-day email would be a stale "today" alert and push is unaffected.
10. **Webhook signature failure returns 401** (brief; spec 10.5 says 400). Replays with a valid signature return 200 and change nothing.
11. **Retry schedule 1 m / 5 m / 30 m / 2 h then `failed`** (brief) instead of spec 10.8's six steps.
12. **`PortfolioEntry` renderers need more fields than spec 4.10 lists** (price, session date, risk summary): `core/digest.ts` adds `PortfolioEntryView extends PortfolioEntry`; the spec signatures stay verbatim and `buildPortfolioDigest` is generic over `T extends PortfolioEntry`. `buildDiscountDigest` does the per-company mode merge itself with the same rule as `mergeModesForNotification` (primary = first mode of `["worldwide","us"]` with an entry; that P1 function works on `RankedRow`, which has no name or close fields).
13. **`jsr:@negrel/webpush` calls the global `fetch`** (verified in `subscriber.ts` of the repository: `PushSubscriber.pushMessage` has no fetch seam). The adapter therefore swaps `globalThis.fetch` for the duration of one send when a `fetchImpl` is injected (serialised by a mutex); production passes none.
14. **Unverified, to settle in the spike or P3-02:** the exact module surface of the published 0.5.0 (the plan was written from the repository `master` sources: `ApplicationServer.new`, `importVapidKeys`, `exportApplicationServerKey`, `PushSubscriber.pushTextMessage`, `PushMessageError.response`); whether Supabase serves `text/html` from `notify-unsubscribe` on the default `supabase.co` domain (a known platform restriction rewrites it to `text/plain`; one-click POST needs no HTML; fallback in Task 7); the P1 `HANDLERS` signature.

## Review Focus

Five failure modes follow from the spec but no happy-path feature test would exercise them; each is pinned by a named test.

1. **A retried delivery creates a second logical alert (Tasks 1, 4, 7).** Pinned by: pgTAP uniques on digests/items/deliveries; the `runDigestStage` re-run test (the insert RPC returns null, no new rows); the dispatch test "network error keeps the same delivery row, the same Idempotency-Key and the same Topic on the second attempt"; integration "rerunning the digest stage creates no rows".
2. **A revoked subscription spams failures (Tasks 3, 4, 7).** Pinned by: 404/410 -> `gone` adapter tests; the dispatch test that a `gone` subscription is revoked and the NEXT dispatch pass sends zero requests to its endpoint; the 5-failure revoke rule in SQL; the integration 410 test.
3. **An unsubscribed user is still emailed (Tasks 4, 5, 7).** Pinned by: the dispatch re-check test (preferences change between creation and dispatch: zero `sendEmail` calls, delivery `skipped/unsubscribed`); the one-click unsubscribe POST test; the token tamper test; webhook bounce/complaint disabling email; integration.
4. **A digest is built before research finished and includes a `pending` candidate (Tasks 2, 4, 7).** Pinned by: `core/digest.ts` throws on red/grey/pending; the SQL candidate function filters category and, at the cut-off, `research_completed_at`; the stage test that `reason = 'cutoff'` passes `finishedOnly`; the integration 13:00 Sofia path.
5. **A webhook replay or forgery without signature verification (Tasks 3, 5).** Pinned by: `verifySvix` tests (valid, wrong secret, tampered body, missing headers, stale and future timestamp, multi-signature header); webhook handler tests (bad signature 401 and nothing stored, replay of a valid svix id changes nothing, stored payload contains no address).

## Task Dependencies and Concurrency

| Task | Depends on | Can run concurrently with |
|---|---|---|
| 1 Migrations, SQL, pgTAP | P1 schema | Tasks 2 and 3 (disjoint files) |
| 2 `core/digest.ts` | P0 core skeleton | Tasks 1 and 3 |
| 3 Push and email adapters, spike, tools | P0 adapters | Tasks 1 and 2 |
| 4 Digest stage and `notify-dispatch` | Tasks 1, 2, 3 | Task 5 (disjoint files except `supabase/config.toml` and `supabase/functions/.env.example`, edited in the last step of each task; keep both blocks on merge) |
| 5 `push-subscribe`, `resend-webhook`, `notify-unsubscribe` | Tasks 1 and 3 | Task 4 (see left) |
| 6 Web: service worker and Notifications page | Task 5 | none |
| 7 Integration and operator guide | Tasks 1 to 6 | none |
| 8 Exit checklist | all | none |

---

### Task 1: Migrations, SQL functions and pgTAP tests

**Concurrency:** may run at the same time as Tasks 2 and 3 (disjoint files).

**Files:**
- Create: `supabase/migrations/20261015004000_notifications_schema.sql`
- Create: `supabase/migrations/20261015004100_notifications_cron.sql`
- Create: `supabase/tests/0400_notifications_schema.test.sql`
- Create: `supabase/tests/0401_notifications_functions.test.sql`

**Interfaces:**
- Consumes: the P1 enums and tables listed in Prerequisites; schema `app` (P0); `auth.users`.
- Produces: enums `digest_kind`, `delivery_channel`, `delivery_status`; tables `notification_preferences`, `push_subscriptions`, `digests`, `digest_items`, `digest_deliveries`, `email_events`; column `scan_runs.digests_created_at` (added `if not exists`); `app.cutoff_digests(p_now timestamptz default now()) returns int`, `app.pending_delivery_count() returns int`, `app.claim_deliveries(p_limit int) returns setof jsonb`, `app.consume_quota_capped(...) returns boolean`, a replaced `app.kick_workers()`; service-only RPCs `public.notify_digest_users`, `notify_discount_candidates`, `notify_portfolio_candidates`, `notify_insert_digest`, `notify_finish_digests`, `notify_claim_deliveries`, `notify_active_subscriptions`, `notify_mark_subscription`, `notify_complete_delivery`, `notify_consume_email_quota`, `notify_record_email_event`, `notify_unsubscribe`, `notify_event`, `notify_cutoff_digests` (test hook); cron jobs `digest-cutoff-1000` and `digest-cutoff-1100`.

- [ ] **Step 1: Write the failing pgTAP test for the schema (uniques, RLS with two users, grants)**

`supabase/tests/0400_notifications_schema.test.sql`:

```sql
begin;
select plan(26);

-- fixtures -------------------------------------------------------------------------------------
insert into auth.users (id, email, email_confirmed_at, instance_id, aud, role)
values ('00000000-0000-0000-0000-0000000000a1', 'a@example.test', now(), '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated'),
       ('00000000-0000-0000-0000-0000000000b2', 'b@example.test', now(), '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated');
insert into scan_runs (id, scan_date_local, status, settings_snapshot)
values ('00000000-0000-0000-0000-0000000000c1', '2026-07-15', 'complete', '{}');
insert into notification_preferences (user_id, push_enabled) values
  ('00000000-0000-0000-0000-0000000000a1', true), ('00000000-0000-0000-0000-0000000000b2', true);
insert into push_subscriptions (id, user_id, endpoint, p256dh, auth) values
  ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000a1', 'https://push.example.test/a', 'k', 's'),
  ('00000000-0000-0000-0000-0000000000d2', '00000000-0000-0000-0000-0000000000b2', 'https://push.example.test/b', 'k', 's');
insert into digests (id, scan_run_id, kind, user_id, content, content_hash, cutoff_reason) values
  ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000c1', 'discounts', '00000000-0000-0000-0000-0000000000a1', '{}', 'h', 'complete'),
  ('00000000-0000-0000-0000-0000000000e2', '00000000-0000-0000-0000-0000000000c1', 'discounts', '00000000-0000-0000-0000-0000000000b2', '{}', 'h', 'complete');
insert into digest_items (digest_id, user_id, ref_type, ref_id) values
  ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000a1', 'episode', '00000000-0000-0000-0000-0000000000f1');
insert into digest_deliveries (digest_id, user_id, channel, idempotency_key) values
  ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000a1', 'push', 'k1'),
  ('00000000-0000-0000-0000-0000000000e2', '00000000-0000-0000-0000-0000000000b2', 'push', 'k2');

-- uniques (idempotency, spec 7.11) ----------------------------------------------------------------
select throws_ok($$insert into digests (scan_run_id, kind, user_id, content, content_hash, cutoff_reason)
  values ('00000000-0000-0000-0000-0000000000c1','discounts','00000000-0000-0000-0000-0000000000a1','{}','h','complete')$$,
  '23505', null, 'digests UNIQUE (scan_run_id, kind, user_id)');
select throws_ok($$insert into digest_items (digest_id, user_id, ref_type, ref_id)
  values ('00000000-0000-0000-0000-0000000000e1','00000000-0000-0000-0000-0000000000a1','episode','00000000-0000-0000-0000-0000000000f1')$$,
  '23505', null, 'digest_items UNIQUE (user_id, ref_type, ref_id)');
select throws_ok($$insert into digest_deliveries (digest_id, user_id, channel, idempotency_key)
  values ('00000000-0000-0000-0000-0000000000e1','00000000-0000-0000-0000-0000000000a1','push','k9')$$,
  '23505', null, 'digest_deliveries UNIQUE (digest_id, user_id, channel)');
select throws_ok($$insert into push_subscriptions (user_id, endpoint, p256dh, auth)
  values ('00000000-0000-0000-0000-0000000000b2','https://push.example.test/a','k','s')$$,
  '23505', null, 'push_subscriptions endpoint is UNIQUE');
select throws_ok($$insert into email_events (svix_id, type) values ('msg_1','email.sent'), ('msg_1','email.sent')$$,
  '23505', null, 'email_events svix_id is UNIQUE');
select col_default_is('notification_preferences', 'digest_modes', $$'{worldwide}'::universe_mode[]$$, 'digest_modes defaults to worldwide');
select col_default_is('notification_preferences', 'push_enabled', 'false', 'push is opt-in');
select col_default_is('notification_preferences', 'email_enabled', 'false', 'email is opt-in');
select enum_has_labels('delivery_status', array['pending','sent','failed','skipped','bounced'], 'delivery_status labels');
select enum_has_labels('delivery_channel', array['push','email'], 'delivery_channel labels');

-- RLS: user A sees only own rows ------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a1';
select is((select count(*)::int from notification_preferences), 1, 'A sees only own preferences');
select is((select count(*)::int from digests), 1, 'A sees only own digests');
select is((select count(*)::int from digest_items), 1, 'A sees only own digest items');
select is((select count(*)::int from digest_deliveries), 1, 'A sees only own deliveries');
select is((select count(*)::int from push_subscriptions), 1, 'A sees only own subscriptions');
select throws_ok($$select p256dh from push_subscriptions$$, '42501', null, 'push key columns are not selectable');
select throws_ok($$select endpoint from push_subscriptions$$, '42501', null, 'endpoint is not selectable');
select throws_ok($$insert into push_subscriptions (user_id, endpoint, p256dh, auth)
  values ('00000000-0000-0000-0000-0000000000a1','https://169.254.169.254/x','k','s')$$,
  '42501', null, 'clients cannot insert subscriptions (SSRF guard: push-subscribe validates)');
select lives_ok($$update notification_preferences set email_enabled = true where user_id = '00000000-0000-0000-0000-0000000000a1'$$,
  'A can update own preferences');
select lives_ok($$update notification_preferences set send_empty = true where user_id = '00000000-0000-0000-0000-0000000000b2'$$,
  'A updating B preferences affects zero rows (RLS filters)');
select throws_ok($$update notification_preferences set email_unsubscribed_at = now() where user_id = '00000000-0000-0000-0000-0000000000a1'$$,
  '42501', null, 'a client cannot set email_unsubscribed_at (only clear it)');
select throws_ok($$update notification_preferences set email_bounced_at = null where user_id = '00000000-0000-0000-0000-0000000000a1'$$,
  '42501', null, 'email_bounced_at is server-set (no column privilege)');
select lives_ok($$delete from push_subscriptions$$, 'A can delete own subscriptions');

reset role;
select is((select send_empty from notification_preferences where user_id = '00000000-0000-0000-0000-0000000000b2'), false, 'B preferences were not changed by A');
select is((select count(*)::int from push_subscriptions where user_id = '00000000-0000-0000-0000-0000000000a1'), 0, 'A subscription deleted');
select is((select count(*)::int from push_subscriptions where user_id = '00000000-0000-0000-0000-0000000000b2'), 1, 'B subscription survived');

select * from finish();
rollback;
```

- [ ] **Step 2: Write the failing pgTAP test for functions and cron**

`supabase/tests/0401_notifications_functions.test.sql`:

```sql
begin;
select plan(22);

insert into auth.users (id, email, email_confirmed_at, instance_id, aud, role)
values ('00000000-0000-0000-0000-0000000000a1', 'a@example.test', now(), '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated');
insert into scan_runs (id, scan_date_local, status, settings_snapshot) values
  ('00000000-0000-0000-0000-0000000000c1', '2026-07-15', 'running', '{}'),   -- summer
  ('00000000-0000-0000-0000-0000000000c2', '2026-01-15', 'running', '{}');   -- winter

-- cutoff_digests: Sofia hour = 13 guard --------------------------------------------------------------
select is(app.cutoff_digests('2026-07-15 10:00:00+00'), 1, 'summer 10:00Z is 13:00 Sofia: seeds the cut-off job');
select is((select count(*)::int from scan_jobs where scan_run_id = '00000000-0000-0000-0000-0000000000c1' and stage = 'digest' and key = 'digest:cutoff'), 1, 'digest:cutoff job exists');
select is((select status::text from scan_runs where id = '00000000-0000-0000-0000-0000000000c1'), 'partial', 'a running scan becomes partial at the cut-off');
select is(app.cutoff_digests('2026-07-15 10:00:00+00'), 1, 'a second call finds the run again');
select is((select count(*)::int from scan_jobs where scan_run_id = '00000000-0000-0000-0000-0000000000c1' and key = 'digest:cutoff'), 1, '... but never creates a second job (ON CONFLICT DO NOTHING)');
select is(app.cutoff_digests('2026-07-15 11:00:00+00'), 0, 'summer 11:00Z is 14:00 Sofia: guard returns 0');
select is(app.cutoff_digests('2026-07-15 09:00:00+00'), 0, 'summer 09:00Z is 12:00 Sofia: guard returns 0');
select is(app.cutoff_digests('2026-01-15 11:00:00+00'), 1, 'winter 11:00Z is 13:00 Sofia: seeds the job');
select is(app.cutoff_digests('2026-01-15 10:00:00+00'), 0, 'winter 10:00Z is 12:00 Sofia: guard returns 0');

update scan_runs set digests_created_at = now() where id = '00000000-0000-0000-0000-0000000000c2';
select is(app.cutoff_digests('2026-01-15 11:00:00+00'), 0, 'digests already created: no cut-off job');
update scan_runs set digests_created_at = null, status = 'complete' where id = '00000000-0000-0000-0000-0000000000c2';
select is(app.cutoff_digests('2026-01-15 11:00:00+00'), 0, 'a complete scan needs no cut-off');

-- pending_delivery_count ----------------------------------------------------------------------------
insert into digests (id, scan_run_id, kind, user_id, content, content_hash, cutoff_reason)
values ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000c1', 'discounts', '00000000-0000-0000-0000-0000000000a1', '{}', 'h', 'complete');
insert into digest_deliveries (id, digest_id, user_id, channel, idempotency_key, next_attempt_at) values
  ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000a1', 'push', 'k1', now() - interval '1 minute'),
  ('00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000a1', 'email', 'k2', now() + interval '1 hour');
select is(app.pending_delivery_count(), 1, 'only due pending deliveries are counted');

-- claim_deliveries: lease, attempts, no double claim ------------------------------------------------
select is((select count(*)::int from app.claim_deliveries(10)), 1, 'claims the one due delivery');
select is((select attempts from digest_deliveries where id = '00000000-0000-0000-0000-0000000000f1'), 1, 'attempts incremented at claim');
select ok((select next_attempt_at from digest_deliveries where id = '00000000-0000-0000-0000-0000000000f1') > now() + interval '9 minutes', 'the lease moves next_attempt_at about 10 minutes ahead');
select is((select count(*)::int from app.claim_deliveries(10)), 0, 'a leased delivery is not claimed twice');
select is(app.pending_delivery_count(), 0, 'a leased delivery is no longer counted as due');

-- consume_quota_capped -----------------------------------------------------------------------------
select is(app.consume_quota_capped('resend', 'email_day', 1, 'day', 2), true, 'quota 1 of 2');
select is(app.consume_quota_capped('resend', 'email_day', 1, 'day', 2), true, 'quota 2 of 2');
select is(app.consume_quota_capped('resend', 'email_day', 1, 'day', 2), false, 'quota 3 of 2 refused');

-- cron jobs ------------------------------------------------------------------------------------------
select is((select schedule from cron.job where jobname = 'digest-cutoff-1000'), '0 10 * * *', 'cron digest-cutoff-1000');
select is((select schedule from cron.job where jobname = 'digest-cutoff-1100'), '0 11 * * *', 'cron digest-cutoff-1100');

select * from finish();
rollback;
```

The two `plan()` numbers (26 and 22) match the assertions above; if an assertion is added, update the plan.

- [ ] **Step 3: Run the tests to confirm they fail**

Run (PowerShell, repository root, Docker Desktop running): `bun run supabase:start` then `bun run test:db`
Expected: FAIL (`relation "notification_preferences" does not exist`, `function app.cutoff_digests(...) does not exist`). Previous suites still pass.

- [ ] **Step 4: Write the schema migration (enums, tables, grants, RLS, guard trigger)**

`supabase/migrations/20261015004000_notifications_schema.sql`:

```sql
-- P3 notifications: enums, tables, RLS and column privileges, then functions (spec 6.3.6, 6.8, 6.9, 10).

create type digest_kind      as enum ('discounts', 'portfolio');
create type delivery_channel as enum ('push', 'email');
create type delivery_status  as enum ('pending', 'sent', 'failed', 'skipped', 'bounced');

alter table scan_runs add column if not exists digests_created_at timestamptz;

create table notification_preferences (
  user_id uuid primary key references auth.users on delete cascade,
  push_enabled boolean not null default false,
  email_enabled boolean not null default false,
  digest_modes universe_mode[] not null default '{worldwide}',
  send_empty boolean not null default false,
  email_unsubscribed_at timestamptz,
  email_bounced_at timestamptz,
  updated_at timestamptz not null default now()
);

create table push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  user_agent text,
  created_at timestamptz not null default now(),
  last_success_at timestamptz,
  last_failure_at timestamptz,
  failure_count int not null default 0,
  revoked_at timestamptz,
  revoke_reason text
);
create index push_subscriptions_active on push_subscriptions (user_id) where revoked_at is null;

create table digests (
  id uuid primary key default gen_random_uuid(),
  scan_run_id uuid not null references scan_runs,
  kind digest_kind not null,
  user_id uuid not null references auth.users on delete cascade,
  status text not null default 'ready' check (status in ('ready', 'skipped')),
  skip_reason text,
  content jsonb not null default '{}',
  content_hash text not null,
  cutoff_reason text not null check (cutoff_reason in ('complete', 'cutoff')),
  created_at timestamptz not null default now(),
  unique (scan_run_id, kind, user_id)
);

create table digest_items (
  id bigint generated always as identity primary key,
  digest_id uuid not null references digests on delete cascade,
  user_id uuid not null references auth.users on delete cascade,
  ref_type text not null check (ref_type in ('episode', 'finding')),
  ref_id uuid not null,
  payload jsonb not null default '{}',
  created_at timestamptz not null default now(),
  unique (user_id, ref_type, ref_id)
);
create index digest_items_digest on digest_items (digest_id);

create table digest_deliveries (
  id uuid primary key default gen_random_uuid(),
  digest_id uuid not null references digests on delete cascade,
  user_id uuid not null references auth.users on delete cascade,
  channel delivery_channel not null,
  status delivery_status not null default 'pending',
  skip_reason text,
  attempts int not null default 0,
  provider_message_id text,
  last_error text,
  idempotency_key text not null check (char_length(idempotency_key) <= 256),
  attempt_log jsonb not null default '[]',
  quota_consumed boolean not null default false,
  next_attempt_at timestamptz not null default now(),
  sent_at timestamptz,
  delivered_at timestamptz,
  unique (digest_id, user_id, channel)
);
create index digest_deliveries_due on digest_deliveries (next_attempt_at) where status = 'pending';
create index digest_deliveries_provider on digest_deliveries (provider_message_id) where provider_message_id is not null;

create table email_events (
  id bigint generated always as identity primary key,
  svix_id text not null unique,
  delivery_id uuid references digest_deliveries on delete set null,
  type text not null,
  email_id text,
  recipient_hash text,
  payload jsonb,
  received_at timestamptz not null default now()
);

-- RLS and privileges ------------------------------------------------------------------------------
alter table notification_preferences enable row level security;
alter table push_subscriptions       enable row level security;
alter table digests                  enable row level security;
alter table digest_items             enable row level security;
alter table digest_deliveries        enable row level security;
alter table email_events             enable row level security;

revoke all on notification_preferences, push_subscriptions, digests, digest_items, digest_deliveries, email_events
  from anon, authenticated;

grant select on notification_preferences to authenticated;
grant insert (user_id, push_enabled, email_enabled, digest_modes, send_empty) on notification_preferences to authenticated;
grant update (push_enabled, email_enabled, digest_modes, send_empty, email_unsubscribed_at) on notification_preferences to authenticated;
grant select (id, user_id, user_agent, created_at, last_success_at, last_failure_at, failure_count, revoked_at, revoke_reason)
  on push_subscriptions to authenticated;
grant delete on push_subscriptions to authenticated;
grant select on digests, digest_items to authenticated;
grant select (id, digest_id, user_id, channel, status, skip_reason, attempts, sent_at, delivered_at)
  on digest_deliveries to authenticated;

create policy prefs_select_own on notification_preferences for select to authenticated using (user_id = auth.uid());
create policy prefs_insert_own on notification_preferences for insert to authenticated with check (user_id = auth.uid());
create policy prefs_update_own on notification_preferences for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy subs_select_own on push_subscriptions for select to authenticated using (user_id = auth.uid());
create policy subs_delete_own on push_subscriptions for delete to authenticated using (user_id = auth.uid());
create policy digests_select_own on digests for select to authenticated using (user_id = auth.uid());
create policy items_select_own on digest_items for select to authenticated using (user_id = auth.uid());
create policy deliveries_select_own on digest_deliveries for select to authenticated using (user_id = auth.uid());
-- email_events: no policies = deny by default for clients.

-- A client may only CLEAR email_unsubscribed_at (re-enable); only the service role sets it. ----------------
create or replace function app.notification_preferences_guard() returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  if tg_op = 'UPDATE' and current_user in ('authenticated', 'anon')
     and new.email_unsubscribed_at is not null
     and new.email_unsubscribed_at is distinct from old.email_unsubscribed_at then
    raise exception 'email_unsubscribed_at can only be cleared by the user' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger notification_preferences_guard before insert or update on notification_preferences
  for each row execute function app.notification_preferences_guard();
```

- [ ] **Step 5: Append the functions to the same migration (event helper, quota, cut-off, counts, claim, kick)**

Append to `supabase/migrations/20261015004000_notifications_schema.sql`:

```sql
-- Event helper (does not depend on the P1 app.record_event signature) ------------------------------------
create or replace function public.notify_event(p_scan_run uuid, p_level text, p_event text, p_data jsonb default '{}')
returns void language sql security definer set search_path = public as $$
  insert into scan_events (scan_run_id, stage, level, event, data) values (p_scan_run, 'digest', p_level, p_event, p_data);
$$;

-- Quota with an explicit cap (A-25) ------------------------------------------------------------------------
create or replace function app.consume_quota_capped(p_provider text, p_resource text, p_amount bigint, p_period_kind text, p_limit bigint)
returns boolean language plpgsql security definer set search_path = public, app as $$
declare v_start date; v_used bigint;
begin
  v_start := case p_period_kind when 'day' then (now() at time zone 'utc')::date
                                when 'month' then date_trunc('month', now() at time zone 'utc')::date end;
  if v_start is null then raise exception 'bad period_kind %', p_period_kind; end if;
  insert into ai_quota_usage (provider, resource, period_kind, period_start, used, limit_value)
  values (p_provider, p_resource, p_period_kind, v_start, p_amount, p_limit)
  on conflict (provider, resource, period_kind, period_start)
  do update set used = ai_quota_usage.used + p_amount, limit_value = p_limit
     where ai_quota_usage.used + p_amount <= p_limit
  returning used into v_used;
  return v_used is not null;
end $$;

-- Cut-off at 13:00 Europe/Sofia (spec 7.10); two cron entries, one hour guard ------------------------------
create or replace function app.cutoff_digests(p_now timestamptz default now()) returns int
language plpgsql security definer set search_path = public, app as $$
declare v_local timestamp := p_now at time zone 'Europe/Sofia'; r record; n int := 0;
begin
  if extract(hour from v_local)::int <> 13 then return 0; end if;
  for r in select id from scan_runs
           where scan_date_local = v_local::date and status in ('running', 'partial') and digests_created_at is null
  loop
    insert into scan_jobs (scan_run_id, stage, key, priority) values (r.id, 'digest', 'digest:cutoff', 5)
      on conflict (scan_run_id, stage, key) do nothing;
    update scan_runs set status = 'partial', updated_at = now() where id = r.id and status = 'running';
    n := n + 1;
  end loop;
  if n > 0 then perform app.kick_workers(); end if;
  return n;
end $$;

create or replace function app.pending_delivery_count() returns int
language sql stable security definer set search_path = public as $$
  select count(*)::int from digest_deliveries where status = 'pending' and next_attempt_at <= now();
$$;

-- Claim: portfolio before discounts, FOR UPDATE SKIP LOCKED, lease through next_attempt_at -------------------
create or replace function app.claim_deliveries(p_limit int) returns setof jsonb
language plpgsql security definer set search_path = public, app, auth as $$
begin
  return query
  with due as (
    select d.id from digest_deliveries d join digests g on g.id = d.digest_id
    where d.status = 'pending' and d.next_attempt_at <= now()
    order by (g.kind = 'portfolio') desc, d.next_attempt_at
    for update of d skip locked
    limit p_limit
  ), upd as (
    update digest_deliveries d
       set attempts = d.attempts + 1, next_attempt_at = now() + interval '10 minutes'
      from due where d.id = due.id
    returning d.*
  )
  select jsonb_build_object(
    'id', u.id, 'digestId', u.digest_id, 'userId', u.user_id, 'channel', u.channel, 'attempts', u.attempts,
    'idempotencyKey', u.idempotency_key, 'quotaConsumed', u.quota_consumed,
    'kind', g.kind, 'content', g.content, 'scanRunId', g.scan_run_id, 'digestCreatedAt', g.created_at,
    'scanDate', s.scan_date_local,
    'prefs', jsonb_build_object(
      'pushEnabled', coalesce(p.push_enabled, false), 'emailEnabled', coalesce(p.email_enabled, false),
      'emailUnsubscribedAt', p.email_unsubscribed_at, 'emailBouncedAt', p.email_bounced_at,
      'emailConfirmed', (a.email_confirmed_at is not null)),
    'email', case when u.channel = 'email' then a.email end)
  from upd u
  join digests g on g.id = u.digest_id
  join scan_runs s on s.id = g.scan_run_id
  left join notification_preferences p on p.user_id = u.user_id
  left join auth.users a on a.id = u.user_id;
end $$;

-- kick_workers: reproduced from spec 6.6.3 with the pending-count check. At implementation time diff this
-- against the P1 migration's current body (git grep -n "function app.kick_workers") and keep any line P1 added.
create or replace function app.kick_workers() returns void
language plpgsql security definer set search_path = public, app, vault, net as $$
declare v_url text; v_secret text; v_hdr jsonb; v_broker boolean := false;
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
  if app.pending_delivery_count() > 0 then
    perform net.http_post(url := v_url || '/functions/v1/notify-dispatch', headers := v_hdr, body := '{"action":"tick"}'::jsonb, timeout_milliseconds := 145000);
  end if;
  if to_regclass('public.broker_sync_runs') is not null then
    execute $q$select exists (select 1 from broker_sync_runs where state in ('queued','requested','polling') and coalesce(next_poll_at, now()) <= now())$q$ into v_broker;
    if v_broker then
      perform net.http_post(url := v_url || '/functions/v1/broker-sync', headers := v_hdr, body := '{"action":"tick"}'::jsonb, timeout_milliseconds := 145000);
    end if;
  end if;
end $$;

revoke all on function app.cutoff_digests(timestamptz), app.pending_delivery_count(), app.claim_deliveries(int),
  app.consume_quota_capped(text, text, bigint, text, bigint), public.notify_event(uuid, text, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.notify_event(uuid, text, text, jsonb) to service_role;
```

- [ ] **Step 6: Append the digest RPCs (users, candidates, atomic insert, finish)**

Append to the same migration:

```sql
-- Users who can receive a digest: at least one channel enabled ------------------------------------------------
create or replace function public.notify_digest_users() returns table (
  user_id uuid, push_enabled boolean, email_enabled boolean, email_ok boolean, has_active_push boolean,
  digest_modes universe_mode[], send_empty boolean, holds_positions boolean)
language plpgsql security definer set search_path = public, auth as $$
declare v_holds text := case when to_regclass('public.broker_positions') is not null
  then 'exists (select 1 from broker_positions b where b.user_id = p.user_id)' else 'false' end;
begin
  return query execute format($q$
    select p.user_id, p.push_enabled, p.email_enabled,
           (a.email_confirmed_at is not null and p.email_unsubscribed_at is null and p.email_bounced_at is null),
           exists (select 1 from push_subscriptions s where s.user_id = p.user_id and s.revoked_at is null),
           p.digest_modes, p.send_empty, %s
      from notification_preferences p join auth.users a on a.id = p.user_id
     where p.push_enabled or p.email_enabled
     order by p.user_id$q$, v_holds);
end $$;

-- Discount candidates of one run for one user: green/amber, not withheld, restricted to the user's modes,
-- no digest_items row yet (A-13 carry-over), and at the cut-off only finished research. -----------------------
create or replace function public.notify_discount_candidates(p_scan_run uuid, p_user uuid, p_finished_only boolean)
returns table (episode_id uuid, company_id uuid, security_id uuid, mode universe_mode, rank int, yahoo_symbol text,
  name text, close float8, currency text, session_date date, threshold_line text, category text, conclusion text,
  bankruptcy_risk text, summary text, eur_symbol text, eur_status text)
language sql stable security definer set search_path = public as $$
  select t.episode_id, t.company_id, t.security_id, t.mode, t.rank, s.yahoo_symbol, c.name, t.close, t.currency,
         t.session_date, t.threshold_line::text, t.operational_category::text, t.conclusion, t.bankruptcy_risk::text,
         coalesce(t.summary, ''), e.eur_symbol_yahoo, e.status::text
    from todays_discounts t
    join securities s on s.id = t.security_id
    join companies c on c.id = t.company_id
    join notification_preferences p on p.user_id = p_user
    left join eur_equivalents e on e.security_id = t.security_id and e.ibkr_exchange_id = 'IBIS'
   where t.scan_run_id = p_scan_run
     and t.mode = any (p.digest_modes)
     and t.operational_category in ('green', 'amber')
     and not t.withheld
     and (not p_finished_only or (t.report_id is not null and t.research_completed_at is not null))
     and not exists (select 1 from digest_items i where i.user_id = p_user and i.ref_type = 'episode' and i.ref_id = t.episode_id)
   order by t.mode, t.rank, s.yahoo_symbol;
$$;

-- Portfolio candidates: premium episodes opened in this run on held securities + open findings on held securities.
create or replace function public.notify_portfolio_candidates(p_scan_run uuid, p_user uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_premium jsonb := '[]'; v_risks jsonb := '[]';
begin
  if to_regclass('public.broker_positions') is null then
    return jsonb_build_object('premium', v_premium, 'risks', v_risks);
  end if;
  execute $q$
    select coalesce(jsonb_agg(jsonb_build_object(
      'episodeId', e.id, 'securityId', e.security_id, 'yahooSymbol', s.yahoo_symbol, 'name', c.name,
      'kind', e.kind, 'close', e.opened_close, 'ccy', s.currency, 'sessionDate', e.opened_session_date,
      'researchStatus', coalesce((select r.status::text from research_reports r where r.security_id = e.security_id and r.is_current limit 1), 'queued'))
      order by s.yahoo_symbol), '[]')
      from signal_episodes e join securities s on s.id = e.security_id join companies c on c.id = e.company_id
     where e.opened_scan_run_id = $1 and e.kind in ('premium1', 'premium2') and e.status = 'active' and e.notify
       and exists (select 1 from broker_positions b where b.user_id = $2 and b.security_id = e.security_id)
       and not exists (select 1 from digest_items i where i.user_id = $2 and i.ref_type = 'episode' and i.ref_id = e.id)$q$
    into v_premium using p_scan_run, p_user;
  if to_regclass('public.risk_findings') is not null then
    execute $q$
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', f.id, 'securityId', f.security_id, 'yahooSymbol', s.yahoo_symbol, 'name', c.name,
        'category', f.category, 'summary', f.summary, 'detectedOn', f.detected_at::date,
        'researchStatus', coalesce((select r.status::text from research_reports r where r.security_id = f.security_id and r.is_current limit 1), 'queued'))
        order by s.yahoo_symbol, f.detected_at), '[]')
        from risk_findings f join securities s on s.id = f.security_id join companies c on c.id = s.company_id
       where f.status = 'open'
         and exists (select 1 from broker_positions b where b.user_id = $1 and b.security_id = f.security_id)
         and not exists (select 1 from digest_items i where i.user_id = $1 and i.ref_type = 'finding' and i.ref_id = f.id)$q$
      into v_risks using p_user;
  end if;
  return jsonb_build_object('premium', v_premium, 'risks', v_risks);
end $$;

-- One transaction per digest: digest + items + deliveries (+ finding stamps). Returns null when it already existed.
-- p_items: [{"ref_type":"episode","ref_id":"...","payload":{}}]; p_channels: [{"channel":"push","status":"pending","skip_reason":null}]
create or replace function public.notify_insert_digest(
  p_scan_run uuid, p_user uuid, p_kind digest_kind, p_content jsonb, p_hash text, p_reason text,
  p_status text, p_skip_reason text, p_items jsonb, p_channels jsonb, p_scan_date text)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid; it jsonb; ch jsonb;
begin
  insert into digests (scan_run_id, kind, user_id, status, skip_reason, content, content_hash, cutoff_reason)
  values (p_scan_run, p_kind, p_user, p_status, p_skip_reason, p_content, p_hash, p_reason)
  on conflict (scan_run_id, kind, user_id) do nothing
  returning id into v_id;
  if v_id is null then return null; end if;
  if p_status = 'ready' then
    for it in select * from jsonb_array_elements(p_items) loop
      insert into digest_items (digest_id, user_id, ref_type, ref_id, payload)
      values (v_id, p_user, it->>'ref_type', (it->>'ref_id')::uuid, coalesce(it->'payload', '{}'))
      on conflict (user_id, ref_type, ref_id) do nothing;
      if it->>'ref_type' = 'finding' and to_regclass('public.risk_findings') is not null then
        execute 'update risk_findings set notified_at = coalesce(notified_at, now()) where id = $1' using (it->>'ref_id')::uuid;
      end if;
    end loop;
    for ch in select * from jsonb_array_elements(p_channels) loop
      insert into digest_deliveries (digest_id, user_id, channel, status, skip_reason, idempotency_key)
      values (v_id, p_user, (ch->>'channel')::delivery_channel, (ch->>'status')::delivery_status, ch->>'skip_reason',
              'digest:' || p_kind::text || ':' || p_user::text || ':' || p_scan_date)
      on conflict (digest_id, user_id, channel) do nothing;
    end loop;
  end if;
  return v_id;
end $$;

create or replace function public.notify_finish_digests(p_scan_run uuid, p_reason text, p_stats jsonb) returns boolean
language plpgsql security definer set search_path = public as $$
declare v_n int;
begin
  update scan_runs set digests_created_at = now(), updated_at = now() where id = p_scan_run and digests_created_at is null;
  get diagnostics v_n = row_count;
  if v_n > 0 then
    perform public.notify_event(p_scan_run, 'info', 'digest_created', p_stats || jsonb_build_object('reason', p_reason));
  end if;
  return v_n > 0;
end $$;
```

- [ ] **Step 7: Append the dispatch RPCs (subscriptions, complete, quota, webhook, unsubscribe, grants)**

Append to the same migration:

```sql
create or replace function public.notify_active_subscriptions(p_user uuid)
returns table (id uuid, endpoint text, p256dh text, auth text)
language sql stable security definer set search_path = public as $$
  select s.id, s.endpoint, s.p256dh, s.auth from push_subscriptions s
   where s.user_id = p_user and s.revoked_at is null order by s.created_at;
$$;

-- outcome: success | failure | gone. 5 consecutive failures revoke (spec 10.4).
create or replace function public.notify_mark_subscription(p_id uuid, p_outcome text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if p_outcome = 'success' then
    update push_subscriptions set last_success_at = now(), failure_count = 0 where id = p_id;
  elsif p_outcome = 'gone' then
    update push_subscriptions set revoked_at = now(), revoke_reason = 'gone', last_failure_at = now()
     where id = p_id and revoked_at is null;
  elsif p_outcome = 'failure' then
    update push_subscriptions
       set failure_count = failure_count + 1, last_failure_at = now(),
           revoke_reason = case when failure_count + 1 >= 5 and revoked_at is null then 'repeated_failure' else revoke_reason end,
           revoked_at = case when failure_count + 1 >= 5 and revoked_at is null then now() else revoked_at end
     where id = p_id;
  else
    raise exception 'bad outcome %', p_outcome;
  end if;
end $$;

-- One transition function for a delivery. p_retry_in_seconds not null = stays pending with backoff.
create or replace function public.notify_complete_delivery(
  p_id uuid, p_status delivery_status, p_skip_reason text, p_error text, p_message_id text,
  p_retry_in_seconds int, p_log jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare v_scan uuid; v_channel delivery_channel; v_attempts int;
begin
  update digest_deliveries d set
    status = p_status, skip_reason = p_skip_reason, last_error = p_error,
    provider_message_id = coalesce(p_message_id, d.provider_message_id),
    sent_at = case when p_status = 'sent' then now() else d.sent_at end,
    next_attempt_at = case when p_retry_in_seconds is not null then now() + make_interval(secs => p_retry_in_seconds) else d.next_attempt_at end,
    attempt_log = d.attempt_log || jsonb_build_array(p_log || jsonb_build_object('at', now()))
  where d.id = p_id and d.status = 'pending'
  returning d.channel, d.attempts into v_channel, v_attempts;
  if v_channel is null then return; end if;
  select g.scan_run_id into v_scan from digest_deliveries d join digests g on g.id = d.digest_id where d.id = p_id;
  if p_status = 'sent' then
    perform public.notify_event(v_scan, 'info', 'delivery_sent',
      jsonb_build_object('delivery_id', p_id, 'channel', v_channel, 'attempts', v_attempts));
  elsif p_status in ('failed', 'bounced') then
    perform public.notify_event(v_scan, 'warn', 'delivery_failed',
      jsonb_build_object('delivery_id', p_id, 'channel', v_channel, 'attempts', v_attempts, 'error', p_error));
  end if;
end $$;

-- Consume one unit of the email cap once per delivery (quota_consumed makes a retry free).
create or replace function public.notify_consume_email_quota(p_delivery uuid, p_limit bigint) returns boolean
language plpgsql security definer set search_path = public, app as $$
begin
  if (select quota_consumed from digest_deliveries where id = p_delivery) then return true; end if;
  if app.consume_quota_capped('resend', 'email_day', 1, 'day', p_limit) then
    update digest_deliveries set quota_consumed = true where id = p_delivery;
    return true;
  end if;
  return false;
end $$;

-- Webhook effects, atomic and idempotent by svix_id. Returns 'duplicate' or 'recorded'.
create or replace function public.notify_record_email_event(
  p_svix_id text, p_type text, p_email_id text, p_recipient_hash text, p_payload jsonb) returns text
language plpgsql security definer set search_path = public as $$
declare v_event bigint; v_delivery uuid; v_user uuid;
begin
  select id, user_id into v_delivery, v_user from digest_deliveries where provider_message_id = p_email_id limit 1;
  insert into email_events (svix_id, delivery_id, type, email_id, recipient_hash, payload)
  values (p_svix_id, v_delivery, p_type, p_email_id, p_recipient_hash, p_payload)
  on conflict (svix_id) do nothing returning id into v_event;
  if v_event is null then return 'duplicate'; end if;
  if v_delivery is null then return 'recorded'; end if;
  if p_type = 'email.delivered' then
    update digest_deliveries set delivered_at = now() where id = v_delivery;
  elsif p_type = 'email.failed' then
    update digest_deliveries set status = 'failed', last_error = 'resend_failed' where id = v_delivery;
  elsif p_type in ('email.bounced', 'email.complained', 'email.suppressed') then
    update digest_deliveries set status = 'bounced', last_error = p_type where id = v_delivery;
    insert into notification_preferences (user_id, email_enabled, email_unsubscribed_at, email_bounced_at)
      values (v_user, false, now(), now())
      on conflict (user_id) do update set email_enabled = false,
        email_unsubscribed_at = coalesce(notification_preferences.email_unsubscribed_at, now()),
        email_bounced_at = coalesce(notification_preferences.email_bounced_at, now());
  end if;
  return 'recorded';
end $$;

-- One-click unsubscribe (idempotent, audited as notify.unsubscribe).
create or replace function public.notify_unsubscribe(p_user uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  insert into notification_preferences (user_id, email_enabled, email_unsubscribed_at) values (p_user, false, now())
  on conflict (user_id) do update set email_enabled = false,
    email_unsubscribed_at = coalesce(notification_preferences.email_unsubscribed_at, now());
  update digest_deliveries set status = 'skipped', skip_reason = 'unsubscribed'
   where user_id = p_user and channel = 'email' and status = 'pending';
  insert into audit_events (actor, actor_user_id, event_type, target_type, target_id)
  values ('service', p_user, 'notify.unsubscribe', 'user', p_user::text);
end $$;

-- Test hook for the integration suite (spec 7.12): the cut-off with an explicit clock.
create or replace function public.notify_cutoff_digests(p_now timestamptz default now()) returns int
language sql security definer set search_path = public, app as $$ select app.cutoff_digests(p_now); $$;

-- Wrapper so the Edge Function can claim through PostgREST (public schema only).
create or replace function public.notify_claim_deliveries(p_limit int) returns setof jsonb
language sql security definer set search_path = public, app as $$ select * from app.claim_deliveries(p_limit); $$;

revoke all on function public.notify_digest_users(), public.notify_discount_candidates(uuid, uuid, boolean),
  public.notify_portfolio_candidates(uuid, uuid),
  public.notify_insert_digest(uuid, uuid, digest_kind, jsonb, text, text, text, text, jsonb, jsonb, text),
  public.notify_finish_digests(uuid, text, jsonb), public.notify_active_subscriptions(uuid),
  public.notify_mark_subscription(uuid, text),
  public.notify_complete_delivery(uuid, delivery_status, text, text, text, int, jsonb),
  public.notify_consume_email_quota(uuid, bigint),
  public.notify_record_email_event(text, text, text, text, jsonb), public.notify_unsubscribe(uuid),
  public.notify_claim_deliveries(int), public.notify_cutoff_digests(timestamptz)
  from public, anon, authenticated;
grant execute on function public.notify_digest_users(), public.notify_discount_candidates(uuid, uuid, boolean),
  public.notify_portfolio_candidates(uuid, uuid),
  public.notify_insert_digest(uuid, uuid, digest_kind, jsonb, text, text, text, text, jsonb, jsonb, text),
  public.notify_finish_digests(uuid, text, jsonb), public.notify_active_subscriptions(uuid),
  public.notify_mark_subscription(uuid, text),
  public.notify_complete_delivery(uuid, delivery_status, text, text, text, int, jsonb),
  public.notify_consume_email_quota(uuid, bigint),
  public.notify_record_email_event(text, text, text, text, jsonb), public.notify_unsubscribe(uuid),
  public.notify_claim_deliveries(int), public.notify_cutoff_digests(timestamptz)
  to service_role;
```

- [ ] **Step 8: Write the cron migration**

`supabase/migrations/20261015004100_notifications_cron.sql`:

```sql
-- Cut-off digests at 13:00 Europe/Sofia: 10:00 UTC in summer, 11:00 UTC in winter; app.cutoff_digests()
-- checks the Sofia hour = 13 (spec 7.1, 7.10). Idempotent by name (spec 6.10).
do $$
declare j text;
begin
  foreach j in array array['digest-cutoff-1000', 'digest-cutoff-1100'] loop
    if exists (select 1 from cron.job where jobname = j) then perform cron.unschedule(j); end if;
  end loop;
end $$;

select cron.schedule('digest-cutoff-1000', '0 10 * * *', 'select app.cutoff_digests();');
select cron.schedule('digest-cutoff-1100', '0 11 * * *', 'select app.cutoff_digests();');
```

- [ ] **Step 9: Reset the local database and run the tests**

Run: `bun run supabase:reset` then `bun run test:db`
Expected: PASS for `0400_notifications_schema` (26 assertions) and `0401_notifications_functions` (22 assertions); earlier suites still pass. If the `auth.users` fixture insert fails on a NOT NULL column that a newer Supabase auth schema added, add that column to the fixture insert only. If P1's `scan_runs` or `scan_jobs` require more NOT NULL columns, add them to the fixtures, not to the migration.

- [ ] **Step 10: Commit**

```text
git add supabase/migrations/20261015004000_notifications_schema.sql supabase/migrations/20261015004100_notifications_cron.sql supabase/tests/0400_notifications_schema.test.sql supabase/tests/0401_notifications_functions.test.sql
git commit -m "feat(db): add notification schema, RLS, delivery claim, cut-off and cron entries"
```

---

### Task 2: `core/digest.ts` (pure assembly and renderers)

**Concurrency:** may run at the same time as Tasks 1 and 3 (disjoint files).

**Files:**
- Create: `supabase/functions/_shared/core/digest.ts`
- Create: `supabase/functions/_shared/core/digest.test.ts`
- Modify: `supabase/functions/_shared/core/mod.ts` (one `export * from "./digest.ts";` line)

**Interfaces:**
- Consumes: nothing (core purity: no `Date.now()`, no `Math.random()`, no `TextEncoder`/`URL` because core compiles with `lib: ["ES2023"]` and `types: []`).
- Produces (spec 4.10 verbatim): `DiscountEntry`, `PortfolioEntry`, `orderDiscountEntries`, `buildDiscountDigest`, `buildPortfolioDigest`, `canonicalJson`. Additions: `UniverseMode` (local copy; if P1's `ranking.ts` already exports it, replace the declaration with `import type { UniverseMode } from "./ranking.ts";` and re-export nothing twice), `DigestKind`, `PortfolioEntryView`, `RenderContext`, `renderDigestText`, `renderDigestHtml`, `digestSubject`, `digestTopic`, `pushPayload`, `PUSH_PAYLOAD_MAX_BYTES`, `AMBER_WARNING`, `utf8Length`.

- [ ] **Step 1: Write the failing tests**

`supabase/functions/_shared/core/digest.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  AMBER_WARNING,
  buildDiscountDigest,
  buildPortfolioDigest,
  canonicalJson,
  type DiscountEntry,
  digestSubject,
  orderDiscountEntries,
  type PortfolioEntryView,
  PUSH_PAYLOAD_MAX_BYTES,
  pushPayload,
  renderDigestHtml,
  renderDigestText,
  utf8Length,
} from "./digest.ts";

function discount(over: Partial<DiscountEntry> = {}): DiscountEntry {
  return {
    episodeId: "ep-1",
    companyId: "co-1",
    securityId: "sec-1",
    mode: "worldwide",
    alsoIn: [],
    rank: 12,
    yahooSymbol: "AAA",
    name: "Alpha Corp",
    close: 101.5,
    ccy: "USD",
    sessionDate: "2026-10-14",
    line: "-4",
    category: "green",
    conclusion: "Meets these two fundamental checks.",
    bankruptcyRisk: "Low",
    summary: "Shares fell after a sector sell-off.",
    eur: null,
    ...over,
  };
}

function portfolio(over: Partial<PortfolioEntryView> = {}): PortfolioEntryView {
  return {
    key: "sec-9",
    securityId: "sec-9",
    yahooSymbol: "ZZZ",
    name: "Zeta plc",
    priceSignals: [],
    riskFindingIds: [],
    researchStatus: "complete",
    signals: [],
    risks: [],
    ...over,
  };
}

describe("orderDiscountEntries", () => {
  it("puts green before amber, then rank ascending, then symbol ascending", () => {
    const ordered = orderDiscountEntries([
      discount({ episodeId: "a", yahooSymbol: "AMB1", category: "amber", rank: 1 }),
      discount({ episodeId: "b", yahooSymbol: "GRN9", rank: 9 }),
      discount({ episodeId: "c", yahooSymbol: "GRN2B", rank: 2 }),
      discount({ episodeId: "d", yahooSymbol: "GRN2A", rank: 2 }),
    ]);
    expect(ordered.map((e) => e.episodeId)).toEqual(["d", "c", "b", "a"]);
  });

  it("uses code-unit order for symbols (uppercase before lowercase) and does not mutate the input", () => {
    const input = [discount({ episodeId: "x", yahooSymbol: "a", rank: 1 }), discount({ episodeId: "y", yahooSymbol: "B", rank: 1 })];
    expect(orderDiscountEntries(input).map((e) => e.episodeId)).toEqual(["y", "x"]);
    expect(input.map((e) => e.episodeId)).toEqual(["x", "y"]);
  });
});

describe("buildDiscountDigest", () => {
  it.each(["red", "grey", "pending"])("throws when a %s candidate is passed in", (category) => {
    const bad = discount({ category: category as DiscountEntry["category"] });
    expect(() => buildDiscountDigest([bad], { modes: ["worldwide"], sendEmpty: false })).toThrow(/category/);
  });

  it("skips an empty digest with reason empty unless sendEmpty", () => {
    expect(buildDiscountDigest([], { modes: ["worldwide"], sendEmpty: false })).toEqual({ items: [], skipReason: "empty" });
    expect(buildDiscountDigest([], { modes: ["worldwide"], sendEmpty: true })).toEqual({ items: [], skipReason: null });
  });

  it("restricts to the user's modes (a us-only discount does not notify a worldwide user)", () => {
    const rows = [discount({ mode: "us", episodeId: "us-1" })];
    expect(buildDiscountDigest(rows, { modes: ["worldwide"], sendEmpty: false }).skipReason).toBe("empty");
    expect(buildDiscountDigest(rows, { modes: ["worldwide", "us"], sendEmpty: false }).items).toHaveLength(1);
  });

  it("merges one entry per company: primary is the first mode of worldwide, us; the other goes to alsoIn", () => {
    const rows = [
      discount({ mode: "us", episodeId: "us-ep", rank: 9, line: "-3" }),
      discount({ mode: "worldwide", episodeId: "ww-ep", rank: 14 }),
    ];
    const { items } = buildDiscountDigest(rows, { modes: ["us", "worldwide"], sendEmpty: false });
    expect(items).toHaveLength(1);
    expect(items[0]?.episodeId).toBe("ww-ep");
    expect(items[0]?.mode).toBe("worldwide");
    expect(items[0]?.alsoIn).toEqual(["us"]);
  });

  it("a user with only the us mode gets the us entry as primary", () => {
    const rows = [discount({ mode: "us", episodeId: "us-ep" }), discount({ mode: "worldwide", episodeId: "ww-ep" })];
    const { items } = buildDiscountDigest(rows, { modes: ["us"], sendEmpty: false });
    expect(items.map((e) => e.episodeId)).toEqual(["us-ep"]);
    expect(items[0]?.alsoIn).toEqual([]);
  });

  it("orders merged entries green then amber", () => {
    const rows = [
      discount({ companyId: "c1", episodeId: "amber", category: "amber", rank: 1, yahooSymbol: "A" }),
      discount({ companyId: "c2", episodeId: "green", rank: 50, yahooSymbol: "G" }),
    ];
    const { items } = buildDiscountDigest(rows, { modes: ["worldwide"], sendEmpty: false });
    expect(items.map((e) => e.episodeId)).toEqual(["green", "amber"]);
  });
});

describe("buildPortfolioDigest", () => {
  it("combines a new premium event and a new risk finding of one holding into one entry", () => {
    const premium = portfolio({
      priceSignals: ["premium1"],
      signals: [{ kind: "premium1", close: 12.3, ccy: "USD", sessionDate: "2026-10-14" }],
    });
    const risk = portfolio({
      riskFindingIds: ["f-1"],
      risks: [{ id: "f-1", category: "liquidity_debt", summary: "Covenant breach disclosed.", detectedOn: "2026-10-14" }],
    });
    const { items } = buildPortfolioDigest([premium, risk], false);
    expect(items).toHaveLength(1);
    expect(items[0]?.priceSignals).toEqual(["premium1"]);
    expect(items[0]?.riskFindingIds).toEqual(["f-1"]);
    expect(items[0]?.signals).toHaveLength(1);
    expect(items[0]?.risks).toHaveLength(1);
  });

  it("is idempotent when the same finding is passed twice", () => {
    const risk = portfolio({ riskFindingIds: ["f-1"], risks: [{ id: "f-1", category: "other", summary: "x", detectedOn: "2026-10-14" }] });
    const { items } = buildPortfolioDigest([risk, risk], false);
    expect(items[0]?.riskFindingIds).toEqual(["f-1"]);
    expect(items[0]?.risks).toHaveLength(1);
  });

  it("orders by symbol and applies the empty rule", () => {
    const { items } = buildPortfolioDigest([portfolio({ key: "b", yahooSymbol: "BBB" }), portfolio({ key: "a", yahooSymbol: "AAA" })], false);
    expect(items.map((e) => e.yahooSymbol)).toEqual(["AAA", "BBB"]);
    expect(buildPortfolioDigest([], false)).toEqual({ items: [], skipReason: "empty" });
    expect(buildPortfolioDigest([], true)).toEqual({ items: [], skipReason: null });
  });
});

describe("canonicalJson", () => {
  it("is independent of key order, has no whitespace and keeps array order", () => {
    expect(canonicalJson({ b: 1, a: { d: [3, 1], c: "x" } })).toBe('{"a":{"c":"x","d":[3,1]},"b":1}');
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
  });
  it("drops undefined values like JSON and rejects non-finite numbers", () => {
    expect(canonicalJson({ a: undefined, b: null })).toBe('{"b":null}');
    expect(() => canonicalJson({ a: Number.NaN })).toThrow();
  });
});

describe("renderers", () => {
  const green = discount({ eur: { symbol: "AAA.DE", status: "verified" } });
  const amber = discount({
    episodeId: "amber",
    companyId: "co-2",
    yahooSymbol: "BBB",
    name: "Beta <Holdings> & Sons",
    category: "amber",
    bankruptcyRisk: "Moderate",
    summary: "Debt  refinancing\nrisk noted.",
    eur: { symbol: "BBB.DE", status: "unverified" },
  });

  it("text: green section first, amber section with the warning, EUR only when verified", () => {
    const text = renderDigestText("discounts", [green, amber], { scanDate: "2026-10-15", siteUrl: "https://s.example", unsubscribeUrl: "https://u.example/x" });
    expect(text.indexOf("Alpha Corp")).toBeLessThan(text.indexOf("Beta <Holdings> & Sons"));
    expect(text).toContain(AMBER_WARNING);
    expect(text).toContain("AAA.DE");
    expect(text).not.toContain("BBB.DE");
    expect(text).toContain("#12 AAA");
    expect(text).toContain("101.50 USD");
    expect(text).toContain("2026-10-14");
    expect(text).toContain("Unsubscribe: https://u.example/x");
    expect(text).toContain("not advice");
    expect(text).toContain("Debt refinancing risk noted.");
  });

  it("html: escapes company names, labels amber in words, has a language and a title", () => {
    const html = renderDigestHtml("discounts", [green, amber], { scanDate: "2026-10-15", siteUrl: "https://s.example", unsubscribeUrl: "https://u.example/x" });
    expect(html).toContain("Beta &lt;Holdings&gt; &amp; Sons");
    expect(html).not.toContain("<Holdings>");
    expect(html).toContain(AMBER_WARNING);
    expect(html).toContain('<html lang="en">');
    expect(html).toContain("<title>");
    expect(html).not.toMatch(/<img|<script/);
    expect(html).toContain('href="https://u.example/x"');
  });

  it("html refuses a non-http link target", () => {
    const html = renderDigestHtml("discounts", [green], { siteUrl: "javascript:alert(1)" });
    expect(html).not.toContain("javascript:");
  });

  it("portfolio renders price signal and fundamental risk as different facts without quantities", () => {
    const entry = portfolio({
      priceSignals: ["premium2"],
      riskFindingIds: ["f-1"],
      signals: [{ kind: "premium2", close: 55.5, ccy: "EUR", sessionDate: "2026-10-14" }],
      risks: [{ id: "f-1", category: "regulatory_legal", summary: "Regulator opened an inquiry.", detectedOn: "2026-10-13" }],
    });
    const text = renderDigestText("portfolio", [entry]);
    expect(text).toContain("Price signal: Extra premium +2");
    expect(text).toContain("Fundamental risk:");
    expect(text).toContain("Regulator opened an inquiry.");
    expect(text).not.toMatch(/quantity|cost basis|shares held/i);
    expect(renderDigestHtml("portfolio", [entry])).toContain("Fundamental risk");
  });

  it("subject lines follow the template outline", () => {
    expect(digestSubject("discounts", 3, "2026-10-15")).toBe("Today's discounts: 3 new (2026-10-15)");
    expect(digestSubject("portfolio", 2, "2026-10-15")).toBe("Portfolio alert: 2 item(s) (2026-10-15)");
  });
});

describe("pushPayload", () => {
  it("builds a compact payload with a same-site url and the per-kind tag", () => {
    const rows = [1, 2, 3, 4, 5].map((n) => discount({ episodeId: `e${n}`, companyId: `c${n}`, rank: n, yahooSymbol: `S${n}` }));
    const payload = pushPayload("discounts", rows, "https://s.example/");
    expect(payload.url).toBe("https://s.example/");
    expect(payload.tag).toBe("digest-discounts");
    expect(payload.body).toBe("5 new discounts: #1 S1, #2 S2, #3 S3, +2 more");
    expect(Object.keys(payload).sort()).toEqual(["body", "tag", "title", "url"]);
    expect(pushPayload("portfolio", [portfolio({ priceSignals: ["premium1"] })], "https://s.example").url).toBe("https://s.example/portfolio");
  });

  it("never exceeds 3,500 bytes: the body is truncated", () => {
    const huge = discount({ yahooSymbol: "X".repeat(6000), name: "é".repeat(100) });
    const payload = pushPayload("discounts", [huge], "https://s.example", { maxBodyChars: 10_000 });
    const bytes = utf8Length(JSON.stringify(payload));
    expect(bytes).toBeLessThanOrEqual(PUSH_PAYLOAD_MAX_BYTES);
    expect(payload.body.endsWith("…")).toBe(true);
  });

  it("describes an empty digest (send_empty) instead of listing nothing", () => {
    expect(pushPayload("discounts", [], "https://s.example").body).toBe("No new discounts today");
    expect(renderDigestText("discounts", [])).toContain("Nothing new today.");
    expect(renderDigestHtml("portfolio", [])).toContain("Nothing new today.");
  });

  it("caps the body at 140 characters by default", () => {
    const long = discount({ yahooSymbol: "Y".repeat(500) });
    expect(pushPayload("discounts", [long], "https://s.example").body.length).toBeLessThanOrEqual(140);
  });
});
```

- [ ] **Step 2: Run the tests to confirm they fail**

Run: `bun run test:core -- digest`
Expected: FAIL, `Failed to resolve import "./digest.ts"`.

- [ ] **Step 3: Implement `supabase/functions/_shared/core/digest.ts`**

```ts
// Digest assembly and rendering (spec 4.10, 10.1, 10.7). Pure: no I/O, no clocks, no randomness.

export type UniverseMode = "worldwide" | "us";
export type DigestKind = "discounts" | "portfolio";

export interface DiscountEntry {
  episodeId: string;
  companyId: string;
  securityId: string;
  mode: UniverseMode;
  alsoIn: UniverseMode[];
  rank: number;
  yahooSymbol: string;
  name: string;
  close: number;
  ccy: string;
  sessionDate: string;
  line: "-3" | "-4";
  category: "green" | "amber";
  conclusion: string;
  bankruptcyRisk: string;
  summary: string;
  eur: { symbol: string; status: "verified" | "unverified" | "none" } | null;
}

export interface PortfolioEntry {
  key: string;
  securityId: string;
  yahooSymbol: string;
  name: string;
  priceSignals: ("premium1" | "premium2")[];
  riskFindingIds: string[];
  researchStatus: string;
}

/** Display facts for the renderers; the spec's PortfolioEntry stays unchanged. */
export interface PortfolioSignalView {
  kind: "premium1" | "premium2";
  close: number;
  ccy: string;
  sessionDate: string;
}
export interface PortfolioRiskView {
  id: string;
  category: string;
  summary: string;
  detectedOn: string;
}
export interface PortfolioEntryView extends PortfolioEntry {
  signals: PortfolioSignalView[];
  risks: PortfolioRiskView[];
}

export interface RenderContext {
  scanDate?: string;
  siteUrl?: string;
  unsubscribeUrl?: string;
}

export const AMBER_WARNING = "Higher risk - moderate bankruptcy risk";
export const PUSH_PAYLOAD_MAX_BYTES = 3500;
const MODE_ORDER: readonly UniverseMode[] = ["worldwide", "us"];
const DISCLAIMER = "AI-generated research from public sources, not advice.";

// ---------------------------------------------------------------------------------------------
// canonicalJson

function canon(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (value === null) return "null";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonicalJson: non-finite number");
    return JSON.stringify(value);
  }
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => canon(v) ?? "null").join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const parts: string[] = [];
    for (const key of Object.keys(record).sort()) {
      const encoded = canon(record[key]);
      if (encoded !== undefined) parts.push(`${JSON.stringify(key)}:${encoded}`);
    }
    return `{${parts.join(",")}}`;
  }
  throw new Error(`canonicalJson: unsupported type ${typeof value}`);
}

/** Sorted keys, no whitespace; the caller hashes it for digests.content_hash. */
export function canonicalJson(value: unknown): string {
  return canon(value) ?? "null";
}

// ---------------------------------------------------------------------------------------------
// Ordering and assembly

function codeUnitCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Green before amber; then rank ascending; then yahooSymbol ascending (code-unit order). */
export function orderDiscountEntries(entries: DiscountEntry[]): DiscountEntry[] {
  const weight = (e: DiscountEntry) => (e.category === "green" ? 0 : 1);
  return [...entries].sort(
    (a, b) => weight(a) - weight(b) || a.rank - b.rank || codeUnitCompare(a.yahooSymbol, b.yahooSymbol),
  );
}

function assertCandidate(entry: DiscountEntry): void {
  const category: unknown = entry.category;
  if (category !== "green" && category !== "amber") {
    throw new Error(`digest input rejected: category ${String(category)} must never reach a digest`);
  }
}

function modeIndex(mode: UniverseMode): number {
  return MODE_ORDER.indexOf(mode);
}

export function buildDiscountDigest(
  entries: DiscountEntry[],
  prefs: { modes: UniverseMode[]; sendEmpty: boolean },
): { items: DiscountEntry[]; skipReason: string | null } {
  for (const entry of entries) assertCandidate(entry);
  const wanted = entries.filter((e) => prefs.modes.includes(e.mode));
  const byCompany = new Map<string, DiscountEntry[]>();
  for (const entry of wanted) {
    const group = byCompany.get(entry.companyId) ?? [];
    group.push(entry);
    byCompany.set(entry.companyId, group);
  }
  const merged: DiscountEntry[] = [];
  for (const group of byCompany.values()) {
    const sorted = [...group].sort((a, b) => modeIndex(a.mode) - modeIndex(b.mode));
    const primary = sorted[0];
    if (primary === undefined) continue;
    const also = new Set<UniverseMode>(primary.alsoIn);
    for (const other of sorted.slice(1)) {
      if (other.mode !== primary.mode) also.add(other.mode);
      for (const m of other.alsoIn) if (m !== primary.mode) also.add(m);
    }
    merged.push({ ...primary, alsoIn: [...also].sort((a, b) => modeIndex(a) - modeIndex(b)) });
  }
  const items = orderDiscountEntries(merged);
  return { items, skipReason: items.length === 0 && !prefs.sendEmpty ? "empty" : null };
}

function unionSignals(a: PortfolioEntry["priceSignals"], b: PortfolioEntry["priceSignals"]): PortfolioEntry["priceSignals"] {
  const set = new Set([...a, ...b]);
  return (["premium1", "premium2"] as const).filter((s) => set.has(s));
}

function mergePortfolio<T extends PortfolioEntry>(a: T, b: T): T {
  const left = a as unknown as Record<string, unknown>;
  const right = b as unknown as Record<string, unknown>;
  const merged: Record<string, unknown> = { ...left };
  merged.priceSignals = unionSignals(a.priceSignals, b.priceSignals);
  merged.riskFindingIds = [...new Set([...a.riskFindingIds, ...b.riskFindingIds])].sort();
  for (const field of ["signals", "risks"]) {
    const av = left[field];
    const bv = right[field];
    if (Array.isArray(av) || Array.isArray(bv)) {
      const seen = new Set<string>();
      const out: unknown[] = [];
      for (const item of [...(Array.isArray(av) ? av : []), ...(Array.isArray(bv) ? bv : [])]) {
        const id = canonicalJson(item);
        if (!seen.has(id)) {
          seen.add(id);
          out.push(item);
        }
      }
      merged[field] = out;
    }
  }
  return merged as unknown as T;
}

/** One entry per holding (key): a premium event and a risk finding of one security are combined. */
export function buildPortfolioDigest<T extends PortfolioEntry>(
  entries: T[],
  sendEmpty: boolean,
): { items: T[]; skipReason: string | null } {
  const byKey = new Map<string, T>();
  for (const entry of entries) {
    const existing = byKey.get(entry.key);
    byKey.set(entry.key, existing === undefined ? entry : mergePortfolio(existing, entry));
  }
  const items = [...byKey.values()].sort((a, b) => codeUnitCompare(a.yahooSymbol, b.yahooSymbol));
  return { items, skipReason: items.length === 0 && !sendEmpty ? "empty" : null };
}

// ---------------------------------------------------------------------------------------------
// Rendering helpers

export function utf8Length(text: string): number {
  let bytes = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    bytes += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
  }
  return bytes;
}

function truncateUtf8(text: string, maxBytes: number): string {
  if (utf8Length(text) <= maxBytes) return text;
  const budget = maxBytes - 3; // room for the ellipsis
  let used = 0;
  let out = "";
  for (const ch of text) {
    const size = utf8Length(ch);
    if (used + size > budget) break;
    used += size;
    out += ch;
  }
  return `${out}…`;
}

function truncateChars(text: string, max: number): string {
  const chars = [...text];
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join("")}…`;
}

function oneLine(text: string, max = 160): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat === "" ? "See the report on the site." : truncateChars(flat, max);
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function safeHref(url: string | undefined, fallback: string): string {
  return url !== undefined && /^https?:\/\//i.test(url) ? url : fallback;
}

function price(close: number, ccy: string): string {
  return `${close.toFixed(2)} ${ccy}`;
}

const RISK_LABELS: Record<string, string> = {
  liquidity_debt: "Liquidity or debt",
  guidance: "Guidance",
  accounting_audit: "Accounting or audit",
  regulatory_legal: "Regulatory or legal",
  credit_rating: "Credit rating",
  governance: "Governance",
  other: "Other",
};
const SIGNAL_LABELS = { premium1: "Premium +1", premium2: "Extra premium +2" } as const;

function researchLabel(status: string): string {
  switch (status) {
    case "complete":
      return "Research complete";
    case "queued":
    case "running":
      return "Research in progress";
    case "quota_deferred":
      return "Research deferred";
    case "failed":
      return "Research failed";
    case "stale":
      return "Research out of date";
    default:
      return `Research: ${status}`;
  }
}

function baseUrl(ctx: RenderContext): string {
  return (ctx.siteUrl ?? "").replace(/\/+$/, "");
}

// ---------------------------------------------------------------------------------------------
// Plain text

function discountText(e: DiscountEntry): string[] {
  const lines = [
    `#${e.rank} ${e.yahooSymbol} - ${e.name}`,
    `  Close ${price(e.close, e.ccy)}, session ${e.sessionDate}`,
    `  Threshold line: ${e.line}`,
    `  Bankruptcy risk: ${e.bankruptcyRisk}`,
    `  Conclusion: ${e.conclusion}`,
  ];
  lines.push(e.category === "amber" ? `  ${AMBER_WARNING}: ${oneLine(e.summary)}` : `  Why: ${oneLine(e.summary)}`);
  if (e.eur?.status === "verified") lines.push(`  EUR equivalent: ${e.eur.symbol}`);
  return lines;
}

function portfolioText(e: PortfolioEntryView): string[] {
  const lines = [`${e.yahooSymbol} - ${e.name}`];
  for (const s of e.signals) {
    lines.push(`  Price signal: ${s.kind === "premium2" ? "Extra premium +2" : "Premium +1"} (close ${price(s.close, s.ccy)}, session ${s.sessionDate})`);
  }
  if (e.signals.length === 0) {
    for (const s of e.priceSignals) lines.push(`  Price signal: ${SIGNAL_LABELS[s]}`);
  }
  for (const r of e.risks) {
    lines.push(`  Fundamental risk: ${RISK_LABELS[r.category] ?? r.category} - ${oneLine(r.summary)} (evidence ${r.detectedOn})`);
  }
  lines.push(`  ${researchLabel(e.researchStatus)}`);
  return lines;
}

export function renderDigestText(kind: "discounts", items: readonly DiscountEntry[], ctx?: RenderContext): string;
export function renderDigestText(kind: "portfolio", items: readonly PortfolioEntryView[], ctx?: RenderContext): string;
export function renderDigestText(
  kind: DigestKind,
  items: readonly DiscountEntry[] | readonly PortfolioEntryView[],
  ctx: RenderContext = {},
): string {
  const out: string[] = [];
  const site = baseUrl(ctx);
  if (kind === "discounts") {
    const list = items as readonly DiscountEntry[];
    out.push(`Today's discounts${ctx.scanDate ? ` (${ctx.scanDate})` : ""}`, "");
    const green = list.filter((e) => e.category === "green");
    const amber = list.filter((e) => e.category === "amber");
    if (list.length === 0) out.push("Nothing new today.", "");
    if (green.length > 0) out.push("GREEN", ...green.flatMap((e) => [...discountText(e), ""]));
    if (amber.length > 0) out.push(`AMBER - ${AMBER_WARNING}`, ...amber.flatMap((e) => [...discountText(e), ""]));
    if (site) out.push(`Open Overview: ${site}/`);
  } else {
    const list = items as readonly PortfolioEntryView[];
    out.push(`Portfolio alerts${ctx.scanDate ? ` (${ctx.scanDate})` : ""}`, "");
    if (list.length === 0) out.push("Nothing new today.", "");
    out.push(...list.flatMap((e) => [...portfolioText(e), ""]));
    if (site) out.push(`Open Portfolio: ${site}/portfolio`);
  }
  out.push("", DISCLAIMER);
  if (ctx.unsubscribeUrl) out.push(`Unsubscribe: ${ctx.unsubscribeUrl}`);
  return out.join("\n");
}

// ---------------------------------------------------------------------------------------------
// HTML (system fonts, no remote images, meaning never carried by colour alone)

const HTML_STYLE =
  "body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;line-height:1.5;color:#1c1917;background:#fafaf9;margin:0;padding:16px}" +
  "main{max-width:640px;margin:0 auto}h1{font-size:20px}h2{font-size:17px;border-bottom:2px solid #1c1917;padding-bottom:4px}" +
  "li{margin:0 0 16px;padding:12px;background:#fff;border:1px solid #d6d3d1;border-radius:6px;list-style:none}" +
  ".amber{border-left:6px solid #92400e}.label{font-weight:700}a{color:#0f766e}small{color:#57534e}";

function discountHtml(e: DiscountEntry): string {
  const rows = [
    `<strong>#${e.rank} ${escapeHtml(e.yahooSymbol)}</strong> - ${escapeHtml(e.name)}`,
    `Close ${escapeHtml(price(e.close, e.ccy))}, session ${escapeHtml(e.sessionDate)}`,
    `Threshold line: ${escapeHtml(e.line)}`,
    `Bankruptcy risk: ${escapeHtml(e.bankruptcyRisk)}`,
    `Conclusion: ${escapeHtml(e.conclusion)}`,
    e.category === "amber"
      ? `<span class="label">${escapeHtml(AMBER_WARNING)}</span>: ${escapeHtml(oneLine(e.summary))}`
      : `Why: ${escapeHtml(oneLine(e.summary))}`,
  ];
  if (e.eur?.status === "verified") rows.push(`EUR equivalent: ${escapeHtml(e.eur.symbol)}`);
  return `<li class="${e.category}">${rows.join("<br>")}</li>`;
}

function portfolioHtml(e: PortfolioEntryView): string {
  const rows = [`<strong>${escapeHtml(e.yahooSymbol)}</strong> - ${escapeHtml(e.name)}`];
  for (const s of e.signals) {
    rows.push(`<span class="label">Price signal</span>: ${s.kind === "premium2" ? "Extra premium +2" : "Premium +1"} (close ${escapeHtml(price(s.close, s.ccy))}, session ${escapeHtml(s.sessionDate)})`);
  }
  if (e.signals.length === 0) {
    for (const s of e.priceSignals) rows.push(`<span class="label">Price signal</span>: ${SIGNAL_LABELS[s]}`);
  }
  for (const r of e.risks) {
    rows.push(`<span class="label">Fundamental risk</span>: ${escapeHtml(RISK_LABELS[r.category] ?? r.category)} - ${escapeHtml(oneLine(r.summary))} (evidence ${escapeHtml(r.detectedOn)})`);
  }
  rows.push(escapeHtml(researchLabel(e.researchStatus)));
  return `<li>${rows.join("<br>")}</li>`;
}

export function renderDigestHtml(kind: "discounts", items: readonly DiscountEntry[], ctx?: RenderContext): string;
export function renderDigestHtml(kind: "portfolio", items: readonly PortfolioEntryView[], ctx?: RenderContext): string;
export function renderDigestHtml(
  kind: DigestKind,
  items: readonly DiscountEntry[] | readonly PortfolioEntryView[],
  ctx: RenderContext = {},
): string {
  const site = baseUrl(ctx);
  const title = kind === "discounts" ? "Today's discounts" : "Portfolio alerts";
  const date = ctx.scanDate ? ` (${escapeHtml(ctx.scanDate)})` : "";
  const body: string[] = [`<h1>${escapeHtml(title)}${date}</h1>`];
  if (kind === "discounts") {
    const list = items as readonly DiscountEntry[];
    const green = list.filter((e) => e.category === "green");
    const amber = list.filter((e) => e.category === "amber");
    if (list.length === 0) body.push("<p>Nothing new today.</p>");
    if (green.length > 0) body.push("<h2>Green</h2>", `<ol>${green.map(discountHtml).join("")}</ol>`);
    if (amber.length > 0) body.push(`<h2>${escapeHtml(AMBER_WARNING)}</h2>`, `<ol>${amber.map(discountHtml).join("")}</ol>`);
    if (site) body.push(`<p><a href="${escapeHtml(safeHref(`${site}/`, "#"))}">Open Overview</a></p>`);
  } else {
    const list = items as readonly PortfolioEntryView[];
    if (list.length === 0) body.push("<p>Nothing new today.</p>");
    body.push(`<ul>${list.map(portfolioHtml).join("")}</ul>`);
    if (site) body.push(`<p><a href="${escapeHtml(safeHref(`${site}/portfolio`, "#"))}">Open Portfolio</a></p>`);
  }
  body.push(`<p><small>${escapeHtml(DISCLAIMER)}</small></p>`);
  if (ctx.unsubscribeUrl) {
    body.push(`<p><small><a href="${escapeHtml(safeHref(ctx.unsubscribeUrl, "#"))}">Unsubscribe</a></small></p>`);
  }
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>${HTML_STYLE}</style></head><body><main>${body.join("")}</main></body></html>`;
}

// ---------------------------------------------------------------------------------------------
// Subject, topic and push payload

export function digestSubject(kind: DigestKind, count: number, scanDate: string): string {
  return kind === "discounts"
    ? `Today's discounts: ${count} new (${scanDate})`
    : `Portfolio alert: ${count} item(s) (${scanDate})`;
}

/** Web Push Topic and notification tag. URL-safe base64 alphabet, at most 32 characters: no colon. */
export function digestTopic(kind: DigestKind): string {
  return `digest-${kind}`;
}

export interface PushPayload {
  title: string;
  body: string;
  url: string;
  tag: string;
}

export function pushPayload(
  kind: "discounts",
  items: readonly DiscountEntry[],
  siteUrl: string,
  opts?: { maxBodyChars?: number },
): PushPayload;
export function pushPayload(
  kind: "portfolio",
  items: readonly PortfolioEntryView[],
  siteUrl: string,
  opts?: { maxBodyChars?: number },
): PushPayload;
export function pushPayload(
  kind: DigestKind,
  items: readonly DiscountEntry[] | readonly PortfolioEntryView[],
  siteUrl: string,
  opts: { maxBodyChars?: number } = {},
): PushPayload {
  const base = siteUrl.replace(/\/+$/, "");
  let source: string;
  let title: string;
  if (kind === "discounts") {
    const list = items as readonly DiscountEntry[];
    const n = list.length;
    const head = list.slice(0, 3).map((e) => `#${e.rank} ${e.yahooSymbol}`).join(", ");
    const more = n > 3 ? `, +${n - 3} more` : "";
    const risk = list.some((e) => e.category === "amber") ? " (includes higher risk)" : "";
    source = n === 0 ? "No new discounts today" : `${n} new discount${n === 1 ? "" : "s"}: ${head}${more}${risk}`;
    title = "Today's discounts";
  } else {
    const list = items as readonly PortfolioEntryView[];
    const parts = list.slice(0, 3).map((e) => {
      const kinds = [
        ...e.priceSignals.map((s) => (s === "premium2" ? "premium +2" : "premium +1")),
        ...(e.riskFindingIds.length > 0 ? ["risk"] : []),
      ];
      return `${e.yahooSymbol} ${kinds.join(" and ")}`;
    });
    const more = list.length > 3 ? `, +${list.length - 3} more` : "";
    source = list.length === 0 ? "No portfolio alerts today" : `${parts.join(", ")}${more}`;
    title = "Portfolio alerts";
  }
  const url = `${base}${kind === "discounts" ? "/" : "/portfolio"}`;
  const tag = digestTopic(kind);
  let body = truncateChars(source, opts.maxBodyChars ?? 140);
  let limit = utf8Length(body);
  while (utf8Length(JSON.stringify({ title, body, url, tag })) > PUSH_PAYLOAD_MAX_BYTES) {
    if (limit <= 0) throw new Error("push payload metadata exceeds the size cap");
    limit = Math.floor(limit * 0.9);
    body = truncateUtf8(source, limit);
  }
  return { title, body, url, tag };
}
```

- [ ] **Step 4: Export from the core barrel**

Append to `supabase/functions/_shared/core/mod.ts`:

```ts
export * from "./digest.ts";
```

- [ ] **Step 5: Run the tests, typecheck and the purity guard**

Run: `bun run test:core -- digest`
Expected: all pass (about 24 cases).

Run: `bun run lint:fix` then `bun run typecheck`
Expected: exit 0 (the core `tsc` program has `lib: ES2023` only, so the guard confirms no `TextEncoder`, `URL`, `Date.now()` or `Math.random()` slipped in). If `ranking.ts` already exports `UniverseMode`, `export *` of both from `mod.ts` clashes: replace the local declaration as noted in Interfaces.

- [ ] **Step 6: Commit**

```text
git add supabase/functions/_shared/core/digest.ts supabase/functions/_shared/core/digest.test.ts supabase/functions/_shared/core/mod.ts
git commit -m "feat(core): add digest assembly, renderers and push payload"
```

---

### Task 3: Web Push and Resend adapters, Svix verification, unsubscribe token, spike and key tooling

**Concurrency:** may run at the same time as Tasks 1 and 2 (disjoint files). Only `package.json` (two script lines) is shared with no other P3 task.

**Files:**
- Create: `supabase/functions/_shared/adapters/encoding.ts`, `encoding.test.ts`
- Create: `supabase/functions/_shared/adapters/push.ts`, `push.test.ts`, `push-cli.ts`
- Create: `supabase/functions/_shared/adapters/email.ts`, `email.test.ts`
- Create: `supabase/functions/_shared/adapters/unsubscribe-token.ts`, `unsubscribe-token.test.ts`
- Create: `tools/lib/vapid.ts`, `tools/lib/vapid.test.ts`, `tools/lib/webpush-decrypt.ts`, `tools/lib/webpush-decrypt.test.ts`
- Create: `tools/gen-vapid.ts`, `tools/spike-push.ts`
- Modify: `package.json` (scripts `gen:vapid`, `spike:push`)

**Interfaces:**
- Consumes: `requireEnv`, `timingSafeEqualStrings` from `@adapters/` (P0); `jsr:@negrel/webpush@0.5.0`. The library surface used was read from the repository sources (`mod.ts` re-exports `vapid.ts`, `subscriber.ts`, `application_server.ts`): `generateVapidKeys`, `importVapidKeys(exported, { extractable })`, `exportVapidKeys`, `exportApplicationServerKey(keys)`, `ApplicationServer.new({ contactInformation, vapidKeys })`, `appServer.subscribe({ endpoint, keys: { auth, p256dh } })`, `subscriber.pushTextMessage(text, { urgency, ttl, topic })`, `PushMessageError` (`.response`), enum `Urgency`. It sends with the global `fetch` and sets `Content-Encoding: aes128gcm`, `TTL`, `Urgency`, `Topic`, `Authorization: vapid t=<jwt>, k=<key>`.
- Produces: `sendPush(sub, payloadJson, opts, deps?) -> PushResult`, `loadPushEnv(get?)`, `isAllowedPushEndpoint(url, extraHosts?)`, types `PushResult`, `PushTarget`, `SendPushOptions`; `sendEmail(input, deps?) -> EmailResult`, `verifySvix(headers, rawBody, secret, opts?) -> Promise<boolean>`, `hashRecipient(email, salt)`, `redactResendPayload(payload)`; `makeUnsubscribeToken(userId, secret)`, `verifyUnsubscribeToken(token, secret)`; `base64Encode/base64Decode/base64UrlEncode/base64UrlDecode`; root scripts `gen:vapid`, `spike:push`.

- [ ] **Step 1: Write the failing encoding test**

`supabase/functions/_shared/adapters/encoding.test.ts`:

```ts
import { assertEquals, assertThrows } from "@std/assert";
import { base64Decode, base64Encode, base64UrlDecode, base64UrlEncode } from "./encoding.ts";

Deno.test("base64 and base64url round trip, url form has no padding or +/", () => {
  const bytes = new Uint8Array([251, 255, 254, 0, 1, 2, 3]);
  assertEquals(base64Decode(base64Encode(bytes)), bytes);
  const url = base64UrlEncode(bytes);
  assertEquals(/[+/=]/.test(url), false);
  assertEquals(base64UrlDecode(url), bytes);
});

Deno.test("base64UrlDecode accepts padded and unpadded input and rejects garbage", () => {
  assertEquals(base64UrlDecode("AQID"), new Uint8Array([1, 2, 3]));
  assertEquals(base64UrlDecode("AQI="), new Uint8Array([1, 2]));
  assertThrows(() => base64UrlDecode("***"));
});
```

- [ ] **Step 2: Implement `encoding.ts` and run the test**

`supabase/functions/_shared/adapters/encoding.ts`:

```ts
export function base64Encode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function base64Decode(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function base64UrlEncode(bytes: Uint8Array): string {
  return base64Encode(bytes).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function base64UrlDecode(text: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*={0,2}$/.test(text)) throw new Error("invalid base64url");
  const standard = text.replace(/=+$/, "").replaceAll("-", "+").replaceAll("_", "/");
  return base64Decode(standard + "=".repeat((4 - (standard.length % 4)) % 4));
}
```

Run: `deno test --config supabase/functions/deno.json supabase/functions/_shared/adapters/encoding.test.ts`
Expected: 2 tests pass.

- [ ] **Step 3: Write the failing Web Push adapter tests**

`supabase/functions/_shared/adapters/push.test.ts`:

```ts
import { assert, assertEquals, assertRejects, assertStringIncludes, assertThrows } from "@std/assert";
import * as webpush from "jsr:@negrel/webpush@0.5.0";
import { base64UrlEncode } from "./encoding.ts";
import { isAllowedPushEndpoint, loadPushEnv, type PushEnv, sendPush } from "./push.ts";

async function makeEnv(): Promise<PushEnv> {
  const keys = await webpush.generateVapidKeys({ extractable: true });
  const exported = await webpush.exportVapidKeys(keys);
  return {
    publicKey: await webpush.exportApplicationServerKey(keys),
    privateKeyJwk: JSON.stringify(exported.privateKey),
    subject: "mailto:ops@example.test",
  };
}

async function makeSubscription(endpoint = "https://push.example.test/send/abc") {
  const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  return {
    endpoint,
    p256dh: base64UrlEncode(raw),
    auth: base64UrlEncode(crypto.getRandomValues(new Uint8Array(16))),
  };
}

interface Captured {
  url: string;
  headers: Headers;
  body: Uint8Array;
}

function fakeFetch(respond: (n: number) => Response | Error) {
  const calls: Captured[] = [];
  const fn = ((input: string | URL | Request, init?: RequestInit) => {
    const outcome = respond(calls.length);
    calls.push({
      url: String(input),
      headers: new Headers(init?.headers),
      body: init?.body instanceof Uint8Array ? init.body : new Uint8Array(),
    });
    return outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve(outcome);
  }) as typeof fetch;
  return { calls, fn };
}

const OPTS = { ttlSeconds: 21600, topic: "digest-discounts", urgency: "normal" } as const;
const PAYLOAD = JSON.stringify({ title: "t", body: "b", url: "/", tag: "digest-discounts" });

Deno.test("sendPush posts an encrypted aes128gcm message with vapid auth, TTL, Topic and Urgency", async () => {
  const env = await makeEnv();
  const sub = await makeSubscription();
  const { calls, fn } = fakeFetch(() => new Response(null, { status: 201 }));
  const result = await sendPush(sub, PAYLOAD, OPTS, { env, fetchImpl: fn });
  assertEquals(result, { ok: true });
  assertEquals(calls.length, 1);
  const call = calls[0];
  assert(call);
  assertEquals(call.url, sub.endpoint);
  assertStringIncludes(call.headers.get("authorization") ?? "", "vapid t=");
  assertStringIncludes(call.headers.get("authorization") ?? "", `k=${env.publicKey}`);
  assertEquals(call.headers.get("content-encoding"), "aes128gcm");
  assertEquals(call.headers.get("ttl"), "21600");
  assertEquals(call.headers.get("topic"), "digest-discounts");
  assertEquals(call.headers.get("urgency"), "normal");
  assert(call.body.length > 16 + 4 + 1 + 65 + 16, "encrypted body carries header, key id and tag");
});

Deno.test("status mapping: 404 and 410 are gone, 413 too large, 429 rate limited with Retry-After", async () => {
  const env = await makeEnv();
  const sub = await makeSubscription();
  const run = (res: Response | Error) => sendPush(sub, PAYLOAD, OPTS, { env, fetchImpl: fakeFetch(() => res).fn });
  assertEquals(await run(new Response(null, { status: 404 })), { ok: false, kind: "gone", status: 404 });
  assertEquals(await run(new Response(null, { status: 410 })), { ok: false, kind: "gone", status: 410 });
  assertEquals(await run(new Response(null, { status: 413 })), { ok: false, kind: "payload_too_large", status: 413 });
  assertEquals(
    await run(new Response(null, { status: 429, headers: { "retry-after": "120" } })),
    { ok: false, kind: "rate_limited", status: 429, retryAfterSec: 120 },
  );
  assertEquals(await run(new Response(null, { status: 429 })), { ok: false, kind: "rate_limited", status: 429 });
  assertEquals(await run(new Response(null, { status: 500 })), { ok: false, kind: "http", status: 500 });
  assertEquals(await run(new Response(null, { status: 400 })), { ok: false, kind: "http", status: 400 });
  assertEquals(await run(new TypeError("connection refused")), { ok: false, kind: "network" });
});

Deno.test("Retry-After accepts an HTTP date relative to the injected clock", async () => {
  const env = await makeEnv();
  const sub = await makeSubscription();
  const now = Date.parse("2026-10-15T10:00:00Z");
  const res = new Response(null, { status: 429, headers: { "retry-after": "Thu, 15 Oct 2026 10:01:30 GMT" } });
  const result = await sendPush(sub, PAYLOAD, OPTS, { env, fetchImpl: fakeFetch(() => res).fn, nowMs: () => now });
  assertEquals(result, { ok: false, kind: "rate_limited", status: 429, retryAfterSec: 90 });
});

Deno.test("the global fetch is restored after a send, also after a failure", async () => {
  const env = await makeEnv();
  const sub = await makeSubscription();
  const original = globalThis.fetch;
  await sendPush(sub, PAYLOAD, OPTS, { env, fetchImpl: fakeFetch(() => new TypeError("x")).fn });
  assertEquals(globalThis.fetch, original);
});

Deno.test("invalid topic or ttl is a programming error", async () => {
  const env = await makeEnv();
  const sub = await makeSubscription();
  const deps = { env, fetchImpl: fakeFetch(() => new Response(null, { status: 201 })).fn };
  await assertRejects(() => sendPush(sub, PAYLOAD, { ...OPTS, topic: "digest:discounts" }, deps), RangeError);
  await assertRejects(() => sendPush(sub, PAYLOAD, { ...OPTS, topic: "x".repeat(33) }, deps), RangeError);
  await assertRejects(() => sendPush(sub, PAYLOAD, { ...OPTS, ttlSeconds: 0 }, deps), RangeError);
});

Deno.test("loadPushEnv names the missing variable but never a value, and rejects mismatched keys", async () => {
  const env = await makeEnv();
  const get = (map: Record<string, string>) => (name: string) => map[name];
  const error = assertThrows(() => loadPushEnv(get({ VAPID_PUBLIC_KEY: env.publicKey })), Error);
  assertStringIncludes(error.message, "VAPID_PRIVATE_KEY");
  assertEquals(error.message.includes(env.publicKey), false);
  assertThrows(
    () => loadPushEnv(get({ VAPID_PUBLIC_KEY: env.publicKey, VAPID_PRIVATE_KEY: env.privateKeyJwk, VAPID_SUBJECT: "ops@example.test" })),
    Error,
    "VAPID_SUBJECT",
  );
  const other = await makeEnv();
  const sub = await makeSubscription();
  await assertRejects(
    () => sendPush(sub, PAYLOAD, OPTS, { env: { ...env, publicKey: other.publicKey }, fetchImpl: fakeFetch(() => new Response(null, { status: 201 })).fn }),
    Error,
    "does not match",
  );
});

Deno.test("isAllowedPushEndpoint: https push services only", () => {
  const yes = [
    "https://fcm.googleapis.com/fcm/send/abc",
    "https://updates.push.services.mozilla.com/wpush/v2/abc",
    "https://web.push.apple.com/abc",
    "https://wns2-par02p.notify.windows.com/w/?token=abc",
  ];
  const no = [
    "http://fcm.googleapis.com/fcm/send/abc",
    "https://169.254.169.254/latest",
    "https://localhost/x",
    "https://fcm.googleapis.com.evil.example/x",
    "https://evil.example/web.push.apple.com",
    "https://fcm.googleapis.com:8443/x",
    "not a url",
  ];
  for (const url of yes) assert(isAllowedPushEndpoint(url), url);
  for (const url of no) assertEquals(isAllowedPushEndpoint(url), false, url);
  assert(isAllowedPushEndpoint("https://push.example.test/x", ["push.example.test"]));
});
```

- [ ] **Step 4: Run to confirm failure**

Run: `deno test --config supabase/functions/deno.json supabase/functions/_shared/adapters/push.test.ts`
Expected: FAIL, module `./push.ts` not found. (The first run downloads `jsr:@negrel/webpush@0.5.0` and its dependencies into the Deno cache; that is a one-time dependency fetch, not a test network call. In CI run `deno cache` first.)

- [ ] **Step 5: Implement `push.ts`**

`supabase/functions/_shared/adapters/push.ts`:

```ts
import * as webpush from "jsr:@negrel/webpush@0.5.0";

export interface PushEnv {
  /** base64url application server key (VAPID public key), also shipped to the SPA */
  publicKey: string;
  /** JWK JSON of the EC P-256 private key (or the {publicKey, privateKey} JSON of the generator) */
  privateKeyJwk: string;
  /** mailto: or https: contact for the push service operators */
  subject: string;
}

export interface PushTarget {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface SendPushOptions {
  ttlSeconds: number;
  topic: string;
  urgency: "very-low" | "low" | "normal" | "high";
}

export type PushResult =
  | { ok: true }
  | {
      ok: false;
      kind: "gone" | "payload_too_large" | "rate_limited" | "http" | "network";
      status?: number;
      retryAfterSec?: number;
    };

export interface PushDeps {
  env?: PushEnv;
  /** test seam: the library calls the global fetch, so it is swapped for the duration of one send */
  fetchImpl?: typeof fetch;
  nowMs?: () => number;
}

/** Reads the three VAPID secrets. Error messages name variables, never values. */
export function loadPushEnv(get: (name: string) => string | undefined = (n) => Deno.env.get(n)): PushEnv {
  const need = (name: string): string => {
    const value = get(name);
    if (value === undefined || value.trim() === "") throw new Error(`Missing required environment variable: ${name}`);
    return value.trim();
  };
  const publicKey = need("VAPID_PUBLIC_KEY");
  const privateKeyJwk = need("VAPID_PRIVATE_KEY");
  const subject = need("VAPID_SUBJECT");
  if (!/^(mailto:|https:\/\/)/.test(subject)) throw new Error("VAPID_SUBJECT must start with mailto: or https://");
  return { publicKey, privateKeyJwk, subject };
}

const servers = new Map<string, Promise<webpush.ApplicationServer>>();

async function createServer(env: PushEnv): Promise<webpush.ApplicationServer> {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(env.privateKeyJwk) as Record<string, unknown>;
  } catch {
    throw new Error("VAPID_PRIVATE_KEY must be JSON (an EC P-256 private JWK)");
  }
  const priv = (parsed.privateKey ?? parsed) as JsonWebKey;
  if (priv.kty !== "EC" || priv.crv !== "P-256" || !priv.d || !priv.x || !priv.y) {
    throw new Error("VAPID_PRIVATE_KEY must be an EC P-256 private JWK");
  }
  const pub: JsonWebKey = { kty: "EC", crv: "P-256", x: priv.x, y: priv.y, ext: true, key_ops: ["verify"] };
  const vapidKeys = await webpush.importVapidKeys({ publicKey: pub, privateKey: priv }, { extractable: false });
  if ((await webpush.exportApplicationServerKey(vapidKeys)) !== env.publicKey) {
    throw new Error("VAPID_PUBLIC_KEY does not match VAPID_PRIVATE_KEY");
  }
  return await webpush.ApplicationServer.new({ contactInformation: env.subject, vapidKeys });
}

function serverFor(env: PushEnv): Promise<webpush.ApplicationServer> {
  const cacheKey = `${env.publicKey}|${env.subject}`;
  let server = servers.get(cacheKey);
  if (server === undefined) {
    server = createServer(env);
    servers.set(cacheKey, server);
    server.catch(() => servers.delete(cacheKey));
  }
  return server;
}

let chain: Promise<unknown> = Promise.resolve();
function withFetch<T>(impl: typeof fetch | undefined, run: () => Promise<T>): Promise<T> {
  if (impl === undefined) return run();
  const next = chain.then(async () => {
    const original = globalThis.fetch;
    globalThis.fetch = impl;
    try {
      return await run();
    } finally {
      globalThis.fetch = original;
    }
  });
  chain = next.catch(() => undefined);
  return next;
}

const URGENCY: Record<SendPushOptions["urgency"], webpush.Urgency> = {
  "very-low": webpush.Urgency.VeryLow,
  low: webpush.Urgency.Low,
  normal: webpush.Urgency.Normal,
  high: webpush.Urgency.High,
};

function retryAfterSeconds(header: string | null, nowMs: number): number | undefined {
  if (header === null) return undefined;
  const text = header.trim();
  const seconds = /^\d+$/.test(text) ? Number(text) : Math.ceil((Date.parse(text) - nowMs) / 1000);
  if (!Number.isFinite(seconds)) return undefined;
  return Math.min(Math.max(seconds, 0), 86_400);
}

export async function sendPush(
  sub: PushTarget,
  payloadJson: string,
  opts: SendPushOptions,
  deps: PushDeps = {},
): Promise<PushResult> {
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(opts.topic)) {
    throw new RangeError("Topic must be 1 to 32 characters of the URL-safe base64 alphabet");
  }
  if (!Number.isInteger(opts.ttlSeconds) || opts.ttlSeconds <= 0) throw new RangeError("ttlSeconds must be a positive integer");
  const env = deps.env ?? loadPushEnv();
  const server = await serverFor(env);
  const subscriber = server.subscribe({ endpoint: sub.endpoint, keys: { auth: sub.auth, p256dh: sub.p256dh } });
  try {
    await withFetch(deps.fetchImpl, () =>
      subscriber.pushTextMessage(payloadJson, { ttl: opts.ttlSeconds, topic: opts.topic, urgency: URGENCY[opts.urgency] }),
    );
    return { ok: true };
  } catch (error) {
    if (error instanceof webpush.PushMessageError) {
      const status = error.response.status;
      const retry = retryAfterSeconds(error.response.headers.get("retry-after"), (deps.nowMs ?? Date.now)());
      try {
        await error.response.body?.cancel();
      } catch {
        // the body is not needed
      }
      if (status === 404 || status === 410) return { ok: false, kind: "gone", status };
      if (status === 413) return { ok: false, kind: "payload_too_large", status };
      if (status === 429) {
        return retry === undefined
          ? { ok: false, kind: "rate_limited", status }
          : { ok: false, kind: "rate_limited", status, retryAfterSec: retry };
      }
      return { ok: false, kind: "http", status };
    }
    return { ok: false, kind: "network" };
  }
}

const EXACT_HOSTS = new Set(["fcm.googleapis.com", "updates.push.services.mozilla.com", "web.push.apple.com"]);
const HOST_SUFFIXES = [".push.services.mozilla.com", ".push.apple.com", ".notify.windows.com"];

/** Endpoint allow-list used by push-subscribe (spec 10.4): https, default port, known push services. */
export function isAllowedPushEndpoint(endpoint: string, extraHosts: readonly string[] = []): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.port !== "" || url.username !== "" || url.password !== "") return false;
  const host = url.hostname.toLowerCase();
  if (/^[\d.]+$/.test(host) || host.includes(":") || host === "localhost") return false;
  return EXACT_HOSTS.has(host) || HOST_SUFFIXES.some((s) => host.endsWith(s)) || extraHosts.includes(host);
}
```

- [ ] **Step 6: Run the adapter tests until they pass**

Run: `deno test --config supabase/functions/deno.json supabase/functions/_shared/adapters/push.test.ts`
Expected: 7 tests pass. If `PushMessageError` is not exported with `.response` under 0.5.0 (the plan was read from `master`), adjust only the `catch` branch in `sendPush` and record the finding as the answer to unverified item 14; if `importVapidKeys` rejects a JWK because of `key_ops`, drop `key_ops` from the public JWK literal.

- [ ] **Step 7: Write the failing email, Svix and redaction tests**

`supabase/functions/_shared/adapters/email.test.ts`:

```ts
import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { base64Encode } from "./encoding.ts";
import { hashRecipient, redactResendPayload, sendEmail, verifySvix } from "./email.ts";

const INPUT = {
  to: "user@example.test",
  subject: "Today's discounts: 2 new (2026-10-15)",
  html: "<p>hi</p>",
  text: "hi",
  idempotencyKey: "digest:discounts:00000000-0000-0000-0000-0000000000a1:2026-10-15",
  unsubscribeUrl: "https://abc.supabase.co/functions/v1/notify-unsubscribe?t=tok",
};
const DEPS = { apiKey: "re_test_key", from: "Screener <alerts@updates.example.test>" };

function fake(res: Response | Error) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = ((input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return res instanceof Error ? Promise.reject(res) : Promise.resolve(res);
  }) as typeof fetch;
  return { calls, fn };
}
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

Deno.test("sendEmail posts to Resend with auth, Idempotency-Key and one-click unsubscribe headers", async () => {
  const { calls, fn } = fake(json(200, { id: "em_123" }));
  const result = await sendEmail(INPUT, { ...DEPS, fetchImpl: fn });
  assertEquals(result, { ok: true, id: "em_123" });
  const call = calls[0];
  assert(call);
  assertEquals(call.url, "https://api.resend.com/emails");
  assertEquals(call.init.method, "POST");
  const headers = new Headers(call.init.headers);
  assertEquals(headers.get("authorization"), "Bearer re_test_key");
  assertEquals(headers.get("idempotency-key"), INPUT.idempotencyKey);
  assertEquals(headers.get("content-type"), "application/json");
  const body = JSON.parse(String(call.init.body));
  assertEquals(body.from, DEPS.from);
  assertEquals(body.to, ["user@example.test"]);
  assertEquals(body.subject, INPUT.subject);
  assertEquals(body.html, INPUT.html);
  assertEquals(body.text, INPUT.text);
  assertEquals(body.headers["List-Unsubscribe"], `<${INPUT.unsubscribeUrl}>`);
  assertEquals(body.headers["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
});

Deno.test("sendEmail can be pointed at another endpoint (integration suite only)", async () => {
  const { calls, fn } = fake(json(200, { id: "em_1" }));
  await sendEmail(INPUT, { ...DEPS, fetchImpl: fn, url: "http://127.0.0.1:54782/emails" });
  assertEquals(calls[0]?.url, "http://127.0.0.1:54782/emails");
});

Deno.test("sendEmail error mapping", async () => {
  const run = (res: Response | Error) => sendEmail(INPUT, { ...DEPS, fetchImpl: fake(res).fn });
  assertEquals(await run(json(429, { name: "rate_limit_exceeded" }, { "retry-after": "2" })), { ok: false, kind: "rate_limited", status: 429, retryAfterSec: 2 });
  assertEquals(await run(json(429, { name: "rate_limit_exceeded" })), { ok: false, kind: "rate_limited", status: 429 });
  assertEquals(await run(json(422, { name: "validation_error" })), { ok: false, kind: "invalid", status: 422 });
  assertEquals(await run(json(400, { name: "validation_error" })), { ok: false, kind: "invalid", status: 400 });
  assertEquals(await run(json(401, { name: "missing_api_key" })), { ok: false, kind: "invalid", status: 401 });
  assertEquals(await run(json(403, { name: "restricted_api_key" })), { ok: false, kind: "invalid", status: 403 });
  assertEquals(await run(json(409, { name: "concurrent_idempotent_requests" })), { ok: false, kind: "http", status: 409 });
  assertEquals(await run(json(500, { name: "internal_server_error" })), { ok: false, kind: "http", status: 500 });
  assertEquals(await run(new TypeError("dns failure")), { ok: false, kind: "network" });
  assertEquals(await run(json(200, { nope: true })), { ok: false, kind: "http", status: 200 });
});

Deno.test("sendEmail rejects bad input without leaking the api key", async () => {
  await assertRejects(() => sendEmail({ ...INPUT, idempotencyKey: "k".repeat(257) }, { ...DEPS, fetchImpl: fake(json(200, { id: "x" })).fn }), RangeError);
  await assertRejects(() => sendEmail({ ...INPUT, unsubscribeUrl: "javascript:x" }, { ...DEPS, fetchImpl: fake(json(200, { id: "x" })).fn }), RangeError);
  Deno.env.delete("RESEND_API_KEY");
  const error = await assertRejects(() => sendEmail(INPUT, { from: DEPS.from, fetchImpl: fake(json(200, { id: "x" })).fn }), Error);
  assertStringIncludes(error.message, "RESEND_API_KEY");
});

// --- Svix --------------------------------------------------------------------------------------
const SECRET_BYTES = new Uint8Array(24).map((_, i) => (i * 7 + 3) & 255);
const SECRET = `whsec_${base64Encode(SECRET_BYTES)}`;
const NOW = Date.parse("2026-10-15T10:00:00Z");

async function sign(secretBytes: Uint8Array, id: string, ts: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", secretBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${ts}.${body}`));
  return base64Encode(new Uint8Array(mac));
}

async function signedHeaders(body: string, over: { ts?: number; secret?: Uint8Array; signature?: string } = {}) {
  const ts = String(over.ts ?? Math.floor(NOW / 1000));
  const sig = over.signature ?? `v1,${await sign(over.secret ?? SECRET_BYTES, "msg_1", ts, body)}`;
  return new Headers({ "svix-id": "msg_1", "svix-timestamp": ts, "svix-signature": sig });
}
const BODY = JSON.stringify({ type: "email.delivered", data: { email_id: "em_1" } });
const verify = (h: Headers, body = BODY, secret = SECRET) => verifySvix(h, body, secret, { nowMs: NOW });

Deno.test("verifySvix accepts a valid signature", async () => {
  assertEquals(await verify(await signedHeaders(BODY)), true);
});

Deno.test("verifySvix rejects a wrong secret, a tampered body and missing headers", async () => {
  assertEquals(await verify(await signedHeaders(BODY, { secret: new Uint8Array(24).fill(9) })), false);
  assertEquals(await verify(await signedHeaders(BODY), BODY.replace("delivered", "bounced")), false);
  const missing = await signedHeaders(BODY);
  missing.delete("svix-id");
  assertEquals(await verify(missing), false);
  assertEquals(await verify(await signedHeaders(BODY), BODY, "whsec_" + base64Encode(new Uint8Array(24).fill(1))), false);
});

Deno.test("verifySvix enforces the 5 minute tolerance in both directions", async () => {
  const sec = Math.floor(NOW / 1000);
  assertEquals(await verify(await signedHeaders(BODY, { ts: sec - 240 })), true);
  assertEquals(await verify(await signedHeaders(BODY, { ts: sec - 301 })), false);
  assertEquals(await verify(await signedHeaders(BODY, { ts: sec + 301 })), false);
  assertEquals(await verify(await signedHeaders(BODY, { ts: sec + 240 })), true);
});

Deno.test("verifySvix handles a space separated list and only trusts v1", async () => {
  const good = await sign(SECRET_BYTES, "msg_1", String(Math.floor(NOW / 1000)), BODY);
  assertEquals(await verify(await signedHeaders(BODY, { signature: `v1,AAAA v1,${good}` })), true);
  assertEquals(await verify(await signedHeaders(BODY, { signature: `v2,${good}` })), false);
  assertEquals(await verify(await signedHeaders(BODY, { signature: "garbage" })), false);
  const bad = await signedHeaders(BODY);
  bad.set("svix-timestamp", "not-a-number");
  assertEquals(await verify(bad), false);
});

// --- recipient hash and payload redaction ---------------------------------------------------------
Deno.test("hashRecipient is stable, case-insensitive and salted", async () => {
  const a = await hashRecipient("User@Example.test", "salt-1");
  assertEquals(a, await hashRecipient(" user@example.test ", "salt-1"));
  assert(a !== (await hashRecipient("user@example.test", "salt-2")));
  assert(/^[0-9a-f]{64}$/.test(a));
  assertEquals(a.includes("example"), false);
});

Deno.test("redactResendPayload removes addresses and subjects everywhere", () => {
  const redacted = redactResendPayload({
    type: "email.bounced",
    data: {
      email_id: "em_1",
      from: "Screener <alerts@updates.example.test>",
      to: ["user@example.test"],
      subject: "Today's discounts",
      bounce: { message: "mailbox user@example.test full", type: "Permanent" },
      tags: [{ name: "who", value: "other@example.test" }],
    },
  });
  const text = JSON.stringify(redacted);
  assertEquals(text.includes("@"), false);
  assertEquals(text.includes("Today's discounts"), false);
  assertStringIncludes(text, "em_1");
  assertStringIncludes(text, "Permanent");
});
```

- [ ] **Step 8: Implement `email.ts`**

`supabase/functions/_shared/adapters/email.ts`:

```ts
import { requireEnv } from "./env.ts";
import { base64Decode, base64Encode } from "./encoding.ts";
import { timingSafeEqualStrings } from "./http.ts";

export interface SendEmailInput {
  to: string;
  subject: string;
  html: string;
  text: string;
  idempotencyKey: string;
  unsubscribeUrl: string;
}

export type EmailResult =
  | { ok: true; id: string }
  | { ok: false; kind: "rate_limited" | "invalid" | "http" | "network"; status?: number; retryAfterSec?: number };

export interface EmailDeps {
  fetchImpl?: typeof fetch;
  apiKey?: string;
  from?: string;
  /** test seam for the integration suite (a fake Resend); never set in production */
  url?: string;
}

const RESEND_URL = "https://api.resend.com/emails";

export async function sendEmail(input: SendEmailInput, deps: EmailDeps = {}): Promise<EmailResult> {
  if (input.idempotencyKey.length === 0 || input.idempotencyKey.length > 256) {
    throw new RangeError("Idempotency-Key must be 1 to 256 characters");
  }
  if (!/^https?:\/\//.test(input.unsubscribeUrl)) throw new RangeError("unsubscribeUrl must be an http(s) URL");
  const apiKey = deps.apiKey ?? requireEnv("RESEND_API_KEY");
  const from = deps.from ?? requireEnv("EMAIL_FROM");
  const doFetch = deps.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await doFetch(deps.url ?? RESEND_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": input.idempotencyKey,
      },
      body: JSON.stringify({
        from,
        to: [input.to],
        subject: input.subject,
        html: input.html,
        text: input.text,
        headers: {
          "List-Unsubscribe": `<${input.unsubscribeUrl}>`,
          "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        },
      }),
    });
  } catch {
    return { ok: false, kind: "network" };
  }
  const status = response.status;
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // an empty or non-JSON body is handled by the status below
  }
  if (status >= 200 && status < 300) {
    const id = (body as { id?: unknown } | null)?.id;
    return typeof id === "string" ? { ok: true, id } : { ok: false, kind: "http", status };
  }
  if (status === 429) {
    const raw = response.headers.get("retry-after");
    const seconds = raw !== null && /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : undefined;
    return seconds === undefined
      ? { ok: false, kind: "rate_limited", status }
      : { ok: false, kind: "rate_limited", status, retryAfterSec: seconds };
  }
  if (status === 400 || status === 401 || status === 403 || status === 422) return { ok: false, kind: "invalid", status };
  return { ok: false, kind: "http", status };
}

// --- Svix webhook verification (HMAC-SHA256 over `${svix-id}.${svix-timestamp}.${rawBody}`) -------------

export interface VerifySvixOptions {
  nowMs?: number;
  toleranceSec?: number;
}

export async function verifySvix(
  headers: Headers,
  rawBody: string,
  secret: string,
  opts: VerifySvixOptions = {},
): Promise<boolean> {
  const id = headers.get("svix-id");
  const timestamp = headers.get("svix-timestamp");
  const signatures = headers.get("svix-signature");
  if (!id || !timestamp || !signatures) return false;
  if (!/^\d{1,12}$/.test(timestamp)) return false;
  const nowSec = Math.floor((opts.nowMs ?? Date.now()) / 1000);
  if (Math.abs(nowSec - Number(timestamp)) > (opts.toleranceSec ?? 300)) return false;
  let keyBytes: Uint8Array;
  try {
    keyBytes = base64Decode(secret.startsWith("whsec_") ? secret.slice(6) : secret);
  } catch {
    return false;
  }
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${timestamp}.${rawBody}`));
  const expected = base64Encode(new Uint8Array(mac));
  let matched = false;
  for (const part of signatures.split(" ")) {
    const [version, value] = part.split(",");
    if (version === "v1" && value !== undefined && (await timingSafeEqualStrings(value, expected))) matched = true;
  }
  return matched;
}

// --- Privacy helpers for email_events -----------------------------------------------------------------

export async function hashRecipient(email: string, salt: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(salt), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(email.trim().toLowerCase()));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const DROP_KEYS = new Set(["to", "from", "cc", "bcc", "reply_to", "subject"]);
const EMAIL_PATTERN = /[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+/g;

/** Deep copy without address and subject fields; any remaining address-like text is replaced. */
export function redactResendPayload(value: unknown): unknown {
  if (typeof value === "string") return value.replace(EMAIL_PATTERN, "[redacted]");
  if (Array.isArray(value)) return value.map(redactResendPayload);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      if (!DROP_KEYS.has(key)) out[key] = redactResendPayload(inner);
    }
    return out;
  }
  return value;
}
```

- [ ] **Step 9: Run the email tests, then write and run the unsubscribe token tests**

Run: `deno test --config supabase/functions/deno.json supabase/functions/_shared/adapters/email.test.ts`
Expected: 10 tests pass.

`supabase/functions/_shared/adapters/unsubscribe-token.test.ts`:

```ts
import { assertEquals } from "@std/assert";
import { makeUnsubscribeToken, verifyUnsubscribeToken } from "./unsubscribe-token.ts";

const USER = "00000000-0000-0000-0000-0000000000a1";
const OTHER = "00000000-0000-0000-0000-0000000000b2";

Deno.test("a token round trips to the user id", async () => {
  const token = await makeUnsubscribeToken(USER, "secret-1");
  assertEquals(await verifyUnsubscribeToken(token, "secret-1"), USER);
  assertEquals(/^[0-9a-f-]{36}\.[A-Za-z0-9_-]+$/.test(token), true);
});

Deno.test("a tampered, swapped or wrongly signed token is rejected", async () => {
  const token = await makeUnsubscribeToken(USER, "secret-1");
  const mac = token.split(".")[1] ?? "";
  assertEquals(await verifyUnsubscribeToken(`${OTHER}.${mac}`, "secret-1"), null);
  assertEquals(await verifyUnsubscribeToken(`${USER}.${mac.slice(0, -1)}A`, "secret-1"), null);
  assertEquals(await verifyUnsubscribeToken(token, "secret-2"), null);
  assertEquals(await verifyUnsubscribeToken("", "secret-1"), null);
  assertEquals(await verifyUnsubscribeToken("not-a-token", "secret-1"), null);
  assertEquals(await verifyUnsubscribeToken(`${USER}.`, "secret-1"), null);
});
```

`supabase/functions/_shared/adapters/unsubscribe-token.ts`:

```ts
import { base64UrlEncode } from "./encoding.ts";
import { timingSafeEqualStrings } from "./http.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function mac(userId: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return base64UrlEncode(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(userId))));
}

/** `<user_id>.<base64url(HMAC-SHA256(user_id, UNSUBSCRIBE_SECRET))>`; no expiry (the link must keep working). */
export async function makeUnsubscribeToken(userId: string, secret: string): Promise<string> {
  return `${userId}.${await mac(userId, secret)}`;
}

/** Returns the user id, or null for anything malformed, forged or signed with another secret. */
export async function verifyUnsubscribeToken(token: string, secret: string): Promise<string | null> {
  const dot = token.indexOf(".");
  if (dot < 0) return null;
  const userId = token.slice(0, dot);
  const given = token.slice(dot + 1);
  if (!UUID.test(userId) || given === "") return null;
  return (await timingSafeEqualStrings(given, await mac(userId, secret))) ? userId : null;
}
```

Run: `deno test --config supabase/functions/deno.json supabase/functions/_shared/adapters/unsubscribe-token.test.ts`
Expected: 2 tests pass.

- [ ] **Step 10: Write the VAPID tooling with its test (Vitest `tools` project)**

`tools/lib/vapid.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { generateVapid } from "./vapid.ts";

function fromBase64Url(text: string): Buffer {
  return Buffer.from(text.replaceAll("-", "+").replaceAll("_", "/"), "base64");
}

describe("generateVapid", () => {
  it("returns a 65 byte uncompressed public key and a matching private JWK", async () => {
    const keys = await generateVapid();
    const raw = fromBase64Url(keys.publicKey);
    expect(raw.length).toBe(65);
    expect(raw[0]).toBe(4);
    expect(keys.privateKeyJwk.kty).toBe("EC");
    expect(keys.privateKeyJwk.crv).toBe("P-256");
    expect(typeof keys.privateKeyJwk.d).toBe("string");
    expect(fromBase64Url(keys.privateKeyJwk.x ?? "")).toEqual(raw.subarray(1, 33));
    expect(fromBase64Url(keys.privateKeyJwk.y ?? "")).toEqual(raw.subarray(33, 65));
  });

  it("formats env lines for supabase secrets and the SPA, with the private key on one line", async () => {
    const keys = await generateVapid();
    const lines = keys.envLines("mailto:ops@example.test").split("\n");
    expect(lines).toContain(`VAPID_PUBLIC_KEY=${keys.publicKey}`);
    expect(lines).toContain("VAPID_SUBJECT=mailto:ops@example.test");
    expect(lines.some((l) => l.startsWith("VAPID_PRIVATE_KEY={") && l.endsWith("}"))).toBe(true);
    expect(lines).toContain(`VITE_VAPID_PUBLIC_KEY=${keys.publicKey}`);
  });

  it("generates a different pair every time", async () => {
    expect((await generateVapid()).publicKey).not.toBe((await generateVapid()).publicKey);
  });
});
```

`tools/lib/vapid.ts`:

```ts
export interface VapidKeys {
  publicKey: string;
  privateKeyJwk: JsonWebKey;
  envLines(subject: string): string;
}

function base64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export async function generateVapid(): Promise<VapidKeys> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const privateKeyJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const publicKey = base64Url(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)));
  return {
    publicKey,
    privateKeyJwk,
    envLines: (subject) =>
      [
        `VAPID_PUBLIC_KEY=${publicKey}`,
        `VAPID_PRIVATE_KEY=${JSON.stringify(privateKeyJwk)}`,
        `VAPID_SUBJECT=${subject}`,
        `VITE_VAPID_PUBLIC_KEY=${publicKey}`,
      ].join("\n"),
  };
}
```

`tools/gen-vapid.ts`:

```ts
import { writeFileSync } from "node:fs";
import { basename } from "node:path";
import { generateVapid } from "./lib/vapid.ts";

// usage: bun run gen:vapid -- mailto:you@example.com [--out supabase/functions/.env.vapid]
const args = process.argv.slice(2);
const outIndex = args.indexOf("--out");
const outPath = outIndex >= 0 ? args[outIndex + 1] : undefined;
const subject = args.find((a, i) => !a.startsWith("--") && i !== outIndex + 1) ?? "";

if (!/^(mailto:|https:\/\/)/.test(subject)) {
  console.error("usage: bun run gen:vapid -- mailto:you@example.com [--out <.env-file>]");
  process.exit(1);
}
if (outPath !== undefined && !basename(outPath).startsWith(".env")) {
  console.error("--out must name a git-ignored .env* file (for example supabase/functions/.env.vapid)");
  process.exit(1);
}

const keys = await generateVapid();
const lines = keys.envLines(subject);
if (outPath === undefined) {
  console.log(lines);
} else {
  writeFileSync(outPath, `${lines}\n`, { mode: 0o600 });
  console.error(`wrote ${outPath}`);
}
console.error(
  [
    "",
    "Next steps (the private key must exist only as a function secret):",
    "  supabase secrets set --env-file <the .env file above> --project-ref <ref>",
    "  put VITE_VAPID_PUBLIC_KEY into the web build environment (it is public)",
    "  delete the .env file when the secrets are set",
  ].join("\n"),
);
```

Add to the root `package.json` `scripts` (keep alphabetical neighbours): `"gen:vapid": "bun run tools/gen-vapid.ts"`, `"spike:push": "bun run tools/spike-push.ts"`.

Run: `bun run test:tools -- vapid`
Expected: 3 tests pass.

- [ ] **Step 11: Write the decrypt helper with a round-trip test**

`tools/lib/webpush-decrypt.test.ts`:

```ts
import { createCipheriv, createECDH, hkdfSync, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decryptAes128gcm } from "./webpush-decrypt.ts";

// RFC 8291 encryption for one record, written independently of the decrypt helper.
function encrypt(plain: string, uaPublic: Buffer, authSecret: Buffer): Buffer {
  const server = createECDH("prime256v1");
  const serverPublic = server.generateKeys();
  const secret = server.computeSecret(uaPublic);
  const salt = randomBytes(16);
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, serverPublic]);
  const ikm = Buffer.from(hkdfSync("sha256", secret, authSecret, keyInfo, 32));
  const cek = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(plain), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21 + 65);
  salt.copy(header, 0);
  header.writeUInt32BE(4096, 16);
  header[20] = 65;
  serverPublic.copy(header, 21);
  return Buffer.concat([header, body]);
}

describe("decryptAes128gcm", () => {
  it("decrypts what an independent RFC 8291 encryptor produced", () => {
    const ua = createECDH("prime256v1");
    const uaPublic = ua.generateKeys();
    const auth = randomBytes(16);
    const body = encrypt('{"title":"héllo"}', uaPublic, auth);
    expect(decryptAes128gcm(body, ua, auth)).toBe('{"title":"héllo"}');
  });

  it("fails on a flipped ciphertext bit", () => {
    const ua = createECDH("prime256v1");
    const uaPublic = ua.generateKeys();
    const auth = randomBytes(16);
    const body = encrypt("secret", uaPublic, auth);
    body[body.length - 20] = (body[body.length - 20] ?? 0) ^ 1;
    expect(() => decryptAes128gcm(body, ua, auth)).toThrow();
  });
});
```

`tools/lib/webpush-decrypt.ts`:

```ts
import { createDecipheriv, type ECDH, hkdfSync } from "node:crypto";

/** Decrypts one aes128gcm Web Push record (RFC 8188 framing, RFC 8291 key derivation). */
export function decryptAes128gcm(body: Buffer, ua: ECDH, authSecret: Buffer): string {
  const salt = body.subarray(0, 16);
  const idLength = body[20] ?? 0;
  const serverPublic = body.subarray(21, 21 + idLength);
  const record = body.subarray(21 + idLength);
  const uaPublic = ua.getPublicKey();
  const secret = ua.computeSecret(serverPublic);
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, serverPublic]);
  const ikm = Buffer.from(hkdfSync("sha256", secret, authSecret, keyInfo, 32));
  const cek = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
  const decipher = createDecipheriv("aes-128-gcm", cek, nonce);
  decipher.setAuthTag(record.subarray(record.length - 16));
  const padded = Buffer.concat([decipher.update(record.subarray(0, record.length - 16)), decipher.final()]);
  let end = padded.length;
  while (end > 0 && padded[end - 1] === 0) end--;
  if (end === 0 || padded[end - 1] !== 2) throw new Error("missing last-record delimiter");
  return padded.subarray(0, end - 1).toString("utf8");
}
```

Run: `bun run test:tools -- webpush-decrypt`
Expected: 2 tests pass.

- [ ] **Step 12: Write the Deno side of the spike and the Bun spike script**

`supabase/functions/_shared/adapters/push-cli.ts` (used only by the spike; reads one JSON job on stdin and prints the `PushResult`):

```ts
import { loadPushEnv, sendPush } from "./push.ts";

// stdin: { "sub": { endpoint, p256dh, auth }, "payload": "<json text>", "topic": "...", "ttlSeconds": 21600 }
// env: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT. Prints the result; never prints keys.
const job = JSON.parse(await new Response(Deno.stdin.readable).text()) as {
  sub: { endpoint: string; p256dh: string; auth: string };
  payload: string;
  topic: string;
  ttlSeconds: number;
};
const result = await sendPush(job.sub, job.payload, { ttlSeconds: job.ttlSeconds, topic: job.topic, urgency: "normal" }, { env: loadPushEnv() });
console.log(JSON.stringify(result));
```

`tools/spike-push.ts`:

```ts
import { spawn } from "node:child_process";
import { createECDH, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { generateVapid } from "./lib/vapid.ts";
import { decryptAes128gcm } from "./lib/webpush-decrypt.ts";

// P3-01 (local half): the Deno adapter encrypts and POSTs to a fake push endpoint served by Bun.
// Asserts the RFC 8030/8291/8292 request shape and that the payload decrypts. A real browser
// receive test (Chrome, Firefox, Android, iOS Home Screen) is a manual operator step: see the
// operator guide section 4. Exit code 0 = pass.
const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const base64Url = (b: Buffer) => b.toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");

const vapid = await generateVapid();
const ua = createECDH("prime256v1");
const uaPublic = ua.generateKeys();
const authSecret = randomBytes(16);

interface Seen { headers: Headers; body: Buffer }
const received: Seen[] = [];
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    received.push({ headers: req.headers, body: Buffer.from(await req.arrayBuffer()) });
    return new Response(null, { status: 201 });
  },
});

const payload = JSON.stringify({ title: "Spike", body: "Hello from the Deno adapter", url: "/", tag: "digest-discounts" });
const job = {
  sub: { endpoint: `http://127.0.0.1:${server.port}/push/spike`, p256dh: base64Url(uaPublic), auth: base64Url(authSecret) },
  payload,
  topic: "digest-discounts",
  ttlSeconds: 21600,
};

const output = await new Promise<string>((resolve, reject) => {
  const child = spawn(
    "deno",
    ["run", "--allow-net", "--allow-env", "--config", "supabase/functions/deno.json", "supabase/functions/_shared/adapters/push-cli.ts"],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        VAPID_PUBLIC_KEY: vapid.publicKey,
        VAPID_PRIVATE_KEY: JSON.stringify(vapid.privateKeyJwk),
        VAPID_SUBJECT: "mailto:spike@example.test",
      },
    },
  );
  let out = "";
  let err = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (err += d));
  child.on("error", reject);
  child.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`deno exited ${code}: ${err}`))));
  child.stdin.end(JSON.stringify(job));
});
server.stop(true);

const failures: string[] = [];
const check = (ok: boolean, message: string) => {
  if (!ok) failures.push(message);
};
check(JSON.parse(output.trim()).ok === true, `adapter result was ${output.trim()}`);
const seen = received[0];
check(seen !== undefined, "the fake endpoint received no request");
if (seen) {
  const h = seen.headers;
  const auth = h.get("authorization") ?? "";
  check(/^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=/.test(auth), "Authorization is not 'vapid t=<jwt>, k=<key>'");
  check(auth.endsWith(`k=${vapid.publicKey}`), "VAPID k does not equal the application server key");
  check(h.get("content-encoding") === "aes128gcm", "Content-Encoding is not aes128gcm");
  check(h.get("ttl") === "21600", "TTL is not 21600");
  check(h.get("topic") === "digest-discounts", "Topic header missing or wrong");
  check(h.get("urgency") === "normal", "Urgency is not normal");
  check(seen.body.length > 0, "empty body");
  try {
    check(decryptAes128gcm(seen.body, ua, authSecret) === payload, "decrypted payload differs from the sent payload");
  } catch (error) {
    check(false, `payload did not decrypt: ${(error as Error).message}`);
  }
}
if (failures.length > 0) {
  console.error(`spike:push FAILED\n- ${failures.join("\n- ")}`);
  console.error("If the library fails here, record the failure in the spec open-question table and switch to web-push-neo (spec 10.4).");
  process.exit(1);
}
console.log("spike:push passed: vapid auth, aes128gcm, TTL 21600, Topic, Urgency and payload decryption verified.");
```

- [ ] **Step 13: Run the spike**

Run: `bun run spike:push`
Expected: `spike:push passed: ...`. This starts a loopback HTTP server only (no external network). If it fails, the first failure line says which RFC element is wrong; record it and stop before Task 4 (the spec makes the spike a gate for the Web Push implementation).

- [ ] **Step 14: Lint, type-check and run the whole adapter and tools suites**

Run: `bun run lint:fix` then `bun run lint`; `bun run typecheck`; `bun run functions:check`; `bun run functions:test`; `bun run test:tools`
Expected: all exit 0. `tools/spike-push.ts` uses `Bun.serve`, so if `tsc -p tsconfig.json` complains about the `Bun` global add `/// <reference types="bun" />` is NOT allowed (no new dependency); instead replace `Bun.serve` with `node:http` `createServer(...).listen(0)` and read `address().port`.

- [ ] **Step 15: Commit**

```text
git add supabase/functions/_shared/adapters tools package.json
git commit -m "feat(notify): add web push and resend adapters, svix verification, unsubscribe token and push spike"
```

---

### Task 4: Digest creation (stage `digest`) and the `notify-dispatch` function

**Concurrency:** starts after Tasks 1, 2 and 3 are merged. May run at the same time as Task 5 (disjoint files); the last step of each task edits `supabase/config.toml` and `supabase/functions/.env.example`, so merge those two files by keeping both tasks' blocks.

**Files:**
- Create: `supabase/functions/worker-tick/handlers/digest-stage.ts`, `digest-stage.test.ts`, `digest-store.ts`, `digest-store.test.ts`, `digest.ts`
- Create (scaffolded, then replaced): `supabase/functions/notify-dispatch/{deno.json,index.ts}`
- Create: `supabase/functions/notify-dispatch/dispatch.ts`, `dispatch.test.ts`, `store.ts`, `handler.ts`, `handler.test.ts`
- Modify: `supabase/functions/worker-tick/index.ts` or the P1 `HANDLERS` registry file (one registration line), `supabase/config.toml`, `supabase/functions/.env.example`

**Interfaces:**
- Consumes: Task 1 RPCs and tables; Task 2 `@core/digest.ts` (`buildDiscountDigest`, `buildPortfolioDigest`, `canonicalJson`, `pushPayload`, `renderDigestText`, `renderDigestHtml`, `digestSubject`, `digestTopic`); Task 3 `sendPush`, `loadPushEnv`, `sendEmail`, `makeUnsubscribeToken`; P0 `requireCronSecret`, `json`, `requireEnv`; the P1 `worker-tick` `HANDLERS` registry (shape assumed: a map from stage name to `(job, ctx) => Promise<void>`; adapt the registration line only).
- Produces: `runDigestStage(scanRunId, reason, deps) -> DigestStageResult`, `DigestStore`, `createDigestStore(client)`, `digestHandler`; `processDelivery(delivery, deps) -> Completion`, `runDispatch(deps, opts)`, `DispatchStore`, `createDispatchStore(client)`, `handleNotifyDispatch(req, deps)`; constants `RETRY_SECONDS`, `MAX_ATTEMPTS`, `EMAIL_DAILY_CAP`.

- [ ] **Step 1: Write the failing digest-stage tests**

`supabase/functions/worker-tick/handlers/digest-stage.test.ts`:

```ts
import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  type DigestStore,
  type DigestUser,
  type DiscountRow,
  type InsertDigestArgs,
  type PortfolioCandidates,
  runDigestStage,
  sha256Hex,
} from "./digest-stage.ts";

const RUN = "run-1";
const U1 = "00000000-0000-0000-0000-0000000000a1";
const U2 = "00000000-0000-0000-0000-0000000000b2";

function user(over: Partial<DigestUser> = {}): DigestUser {
  return {
    userId: U1, pushEnabled: true, emailEnabled: true, emailOk: true, hasActivePush: true,
    modes: ["worldwide"], sendEmpty: false, holdsPositions: false, ...over,
  };
}
function row(over: Partial<DiscountRow> = {}): DiscountRow {
  return {
    episodeId: "ep-1", companyId: "co-1", securityId: "sec-1", mode: "worldwide", rank: 12, yahooSymbol: "AAA",
    name: "Alpha Corp", close: 100, currency: "USD", sessionDate: "2026-10-14", thresholdLine: "-4",
    category: "green", conclusion: "Meets these two fundamental checks.", bankruptcyRisk: "Low", summary: "s",
    eurSymbol: null, eurStatus: null, ...over,
  };
}

class FakeStore implements DigestStore {
  users_: DigestUser[] = [user()];
  discounts = new Map<string, DiscountRow[]>();
  portfolio = new Map<string, PortfolioCandidates>();
  inserted: InsertDigestArgs[] = [];
  keys = new Set<string>();
  finished = 0;
  status = "complete";
  digestsCreatedAt: string | null = null;
  finishedOnlyCalls: boolean[] = [];
  failUser: string | null = null;
  scanRun() {
    return Promise.resolve({ id: RUN, status: this.status, scanDateLocal: "2026-10-15", digestsCreatedAt: this.digestsCreatedAt });
  }
  getUsers() { return Promise.resolve(this.users_); }
  discountCandidates(_run: string, userId: string, finishedOnly: boolean) {
    this.finishedOnlyCalls.push(finishedOnly);
    return Promise.resolve(this.discounts.get(userId) ?? []);
  }
  portfolioCandidates(_run: string, userId: string) {
    return Promise.resolve(this.portfolio.get(userId) ?? { premium: [], risks: [] });
  }
  insertDigest(args: InsertDigestArgs) {
    if (this.failUser === args.userId) return Promise.reject(new Error("db down"));
    const key = `${args.scanRunId}|${args.kind}|${args.userId}`;
    if (this.keys.has(key)) return Promise.resolve(null);
    this.keys.add(key);
    this.inserted.push(args);
    return Promise.resolve(`digest-${this.inserted.length}`);
  }
  finish() { this.finished++; this.digestsCreatedAt = "2026-10-15T09:00:00Z"; return Promise.resolve(true); }
}
const deps = (store: FakeStore) => ({ store, sha256Hex, log: () => {} });

Deno.test("builds the discounts digest in green-then-amber order and creates one delivery per enabled channel", async () => {
  const store = new FakeStore();
  store.discounts.set(U1, [
    row({ episodeId: "amber", companyId: "c2", category: "amber", rank: 1, yahooSymbol: "AMB" }),
    row({ episodeId: "green", companyId: "c1", rank: 30, yahooSymbol: "GRN" }),
  ]);
  const result = await runDigestStage(RUN, "complete", deps(store));
  assertEquals(result.status, "created");
  assertEquals(store.inserted.length, 1);
  const digest = store.inserted[0];
  assert(digest);
  assertEquals(digest.kind, "discounts");
  assertEquals(digest.reason, "complete");
  assertEquals(digest.status, "ready");
  assertEquals(digest.scanDate, "2026-10-15");
  assertEquals((digest.content.items as { episodeId: string }[]).map((i) => i.episodeId), ["green", "amber"]);
  assertEquals(digest.items.map((i) => `${i.ref_type}:${i.ref_id}`), ["episode:green", "episode:amber"]);
  assertEquals(digest.channels, [
    { channel: "push", status: "pending", skip_reason: null },
    { channel: "email", status: "pending", skip_reason: null },
  ]);
  assertEquals(digest.hash.length, 64);
  assertEquals(store.finished, 1);
});

Deno.test("red, grey and pending rows never reach a digest (the caller filters, the core asserts)", async () => {
  const store = new FakeStore();
  store.discounts.set(U1, [
    row({ episodeId: "ok" }),
    row({ episodeId: "p", companyId: "c2", category: "pending" }),
    row({ episodeId: "r", companyId: "c3", category: "red" }),
    row({ episodeId: "g", companyId: "c4", category: "grey" }),
  ]);
  await runDigestStage(RUN, "complete", deps(store));
  assertEquals(store.inserted[0]?.items.map((i) => i.ref_id), ["ok"]);
});

Deno.test("a digest is not created twice: re-running inserts nothing and a created scan is a no-op", async () => {
  const store = new FakeStore();
  store.discounts.set(U1, [row()]);
  await runDigestStage(RUN, "complete", deps(store));
  const again = await runDigestStage(RUN, "complete", deps(store));
  assertEquals(again.status, "skipped_already_created");
  assertEquals(store.inserted.length, 1);
  store.digestsCreatedAt = null; // simulate a crash before finish: the unique key makes the retry a no-op
  const retry = await runDigestStage(RUN, "complete", deps(store));
  assertEquals(retry.status, "created");
  assertEquals(store.inserted.length, 1);
});

Deno.test("the cut-off passes finishedOnly so unfinished research is excluded; complete does not", async () => {
  const store = new FakeStore();
  await runDigestStage(RUN, "cutoff", deps(store));
  assertEquals(store.finishedOnlyCalls, [true]);
  const other = new FakeStore();
  await runDigestStage(RUN, "complete", deps(other));
  assertEquals(other.finishedOnlyCalls, [false]);
  assertEquals(store.inserted[0]?.status, "skipped", "an empty digest is recorded as skipped, never as ready");
});

Deno.test("empty digest: recorded as skipped without deliveries unless send_empty", async () => {
  const store = new FakeStore();
  await runDigestStage(RUN, "complete", deps(store));
  const skipped = store.inserted[0];
  assertEquals(skipped?.status, "skipped");
  assertEquals(skipped?.skipReason, "empty");
  assertEquals(skipped?.channels, []);
  const withEmpty = new FakeStore();
  withEmpty.users_ = [user({ sendEmpty: true })];
  await runDigestStage(RUN, "complete", deps(withEmpty));
  assertEquals(withEmpty.inserted[0]?.status, "ready");
  assertEquals(withEmpty.inserted[0]?.channels.length, 2);
});

Deno.test("channel rules: disabled, no subscription and undeliverable email are recorded as skipped", async () => {
  const store = new FakeStore();
  store.users_ = [user({ hasActivePush: false, emailOk: false })];
  store.discounts.set(U1, [row()]);
  await runDigestStage(RUN, "complete", deps(store));
  assertEquals(store.inserted[0]?.channels, [
    { channel: "push", status: "skipped", skip_reason: "no_subscription" },
    { channel: "email", status: "skipped", skip_reason: "email_not_deliverable" },
  ]);
  const off = new FakeStore();
  off.users_ = [user({ pushEnabled: false, emailEnabled: true })];
  off.discounts.set(U1, [row()]);
  await runDigestStage(RUN, "complete", deps(off));
  assertEquals(off.inserted[0]?.channels[0], { channel: "push", status: "skipped", skip_reason: "preference_off" });
});

Deno.test("merges modes per company and marks the merged-away episode in digest_items", async () => {
  const store = new FakeStore();
  store.users_ = [user({ modes: ["worldwide", "us"] })];
  store.discounts.set(U1, [
    row({ episodeId: "us-ep", mode: "us", rank: 9, thresholdLine: "-3" }),
    row({ episodeId: "ww-ep", mode: "worldwide", rank: 14 }),
  ]);
  await runDigestStage(RUN, "complete", deps(store));
  const digest = store.inserted[0];
  assertEquals((digest?.content.items as { episodeId: string }[]).map((i) => i.episodeId), ["ww-ep"]);
  assertEquals(digest?.items.map((i) => i.ref_id).sort(), ["us-ep", "ww-ep"]);
  assertEquals(digest?.items.find((i) => i.ref_id === "us-ep")?.payload, { mergedInto: "ww-ep" });
});

Deno.test("portfolio: only for holders, one entry for a premium event plus a risk finding of one security", async () => {
  const store = new FakeStore();
  store.users_ = [user({ holdsPositions: true }), user({ userId: U2, holdsPositions: false })];
  const candidates: PortfolioCandidates = {
    premium: [{ episodeId: "pe-1", securityId: "s9", yahooSymbol: "ZZZ", name: "Zeta", kind: "premium1", close: 12.3, ccy: "USD", sessionDate: "2026-10-14", researchStatus: "complete" }],
    risks: [{ id: "f-1", securityId: "s9", yahooSymbol: "ZZZ", name: "Zeta", category: "liquidity_debt", summary: "Covenant breach.", detectedOn: "2026-10-14", researchStatus: "complete" }],
  };
  store.portfolio.set(U1, candidates);
  store.portfolio.set(U2, candidates);
  await runDigestStage(RUN, "complete", deps(store));
  const portfolio = store.inserted.filter((d) => d.kind === "portfolio");
  assertEquals(portfolio.length, 1, "the non-holder gets no portfolio digest");
  const only = portfolio[0];
  assertEquals((only?.content.items as unknown[]).length, 1);
  assertEquals(only?.items.map((i) => `${i.ref_type}:${i.ref_id}`).sort(), ["episode:pe-1", "finding:f-1"]);
});

Deno.test("one failing user does not block the others, but the scan is not marked finished", async () => {
  const store = new FakeStore();
  store.users_ = [user(), user({ userId: U2 })];
  store.discounts.set(U1, [row()]);
  store.discounts.set(U2, [row()]);
  store.failUser = U1;
  await assertRejects(() => runDigestStage(RUN, "complete", deps(store)), Error, "1 of 2");
  assertEquals(store.inserted.map((d) => d.userId), [U2]);
  assertEquals(store.finished, 0);
});

Deno.test("a failed scan produces no digest", async () => {
  const store = new FakeStore();
  store.status = "failed";
  const result = await runDigestStage(RUN, "complete", deps(store));
  assertEquals(result.status, "skipped_failed_scan");
  assertEquals(store.inserted.length, 0);
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `deno test --config supabase/functions/deno.json supabase/functions/worker-tick/handlers/digest-stage.test.ts`
Expected: FAIL, module `./digest-stage.ts` not found.

- [ ] **Step 3: Implement `digest-stage.ts`**

`supabase/functions/worker-tick/handlers/digest-stage.ts`:

```ts
import {
  buildDiscountDigest,
  buildPortfolioDigest,
  canonicalJson,
  type DigestKind,
  type DiscountEntry,
  type PortfolioEntryView,
  type UniverseMode,
} from "@core/digest.ts";

export type DigestReason = "complete" | "cutoff";

export interface DigestUser {
  userId: string;
  pushEnabled: boolean;
  emailEnabled: boolean;
  emailOk: boolean;
  hasActivePush: boolean;
  modes: UniverseMode[];
  sendEmpty: boolean;
  holdsPositions: boolean;
}

export interface DiscountRow {
  episodeId: string;
  companyId: string;
  securityId: string;
  mode: UniverseMode;
  rank: number;
  yahooSymbol: string;
  name: string;
  close: number;
  currency: string;
  sessionDate: string;
  thresholdLine: string;
  category: string;
  conclusion: string | null;
  bankruptcyRisk: string | null;
  summary: string;
  eurSymbol: string | null;
  eurStatus: string | null;
}

export interface PremiumRow {
  episodeId: string;
  securityId: string;
  yahooSymbol: string;
  name: string;
  kind: "premium1" | "premium2";
  close: number;
  ccy: string;
  sessionDate: string;
  researchStatus: string;
}

export interface RiskRow {
  id: string;
  securityId: string;
  yahooSymbol: string;
  name: string;
  category: string;
  summary: string;
  detectedOn: string;
  researchStatus: string;
}

export interface PortfolioCandidates {
  premium: PremiumRow[];
  risks: RiskRow[];
}

export interface ScanRunInfo {
  id: string;
  status: string;
  scanDateLocal: string;
  digestsCreatedAt: string | null;
}

export interface DigestItemInput {
  ref_type: "episode" | "finding";
  ref_id: string;
  payload: Record<string, unknown>;
}
export interface ChannelInput {
  channel: "push" | "email";
  status: "pending" | "skipped";
  skip_reason: string | null;
}
export interface InsertDigestArgs {
  scanRunId: string;
  userId: string;
  kind: DigestKind;
  content: { kind: DigestKind; scanDate: string; items: unknown[] } & Record<string, unknown>;
  hash: string;
  reason: DigestReason;
  status: "ready" | "skipped";
  skipReason: string | null;
  items: DigestItemInput[];
  channels: ChannelInput[];
  scanDate: string;
}

export interface DigestStore {
  scanRun(id: string): Promise<ScanRunInfo | null>;
  getUsers(): Promise<DigestUser[]>;
  discountCandidates(scanRunId: string, userId: string, finishedOnly: boolean): Promise<DiscountRow[]>;
  portfolioCandidates(scanRunId: string, userId: string): Promise<PortfolioCandidates>;
  /** one transaction; returns null when the (scan, kind, user) digest already exists */
  insertDigest(args: InsertDigestArgs): Promise<string | null>;
  finish(scanRunId: string, reason: DigestReason, stats: Record<string, unknown>): Promise<boolean>;
}

export interface DigestStageDeps {
  store: DigestStore;
  sha256Hex(text: string): Promise<string>;
  log(event: string, data: Record<string, unknown>): void;
}

export interface DigestStageResult {
  status: "created" | "skipped_already_created" | "skipped_failed_scan";
  users: number;
  created: number;
  existing: number;
  skippedEmpty: number;
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function toDiscountEntry(r: DiscountRow): DiscountEntry {
  const eur =
    r.eurSymbol !== null && (r.eurStatus === "verified" || r.eurStatus === "unverified" || r.eurStatus === "none")
      ? { symbol: r.eurSymbol, status: r.eurStatus }
      : null;
  return {
    episodeId: r.episodeId, companyId: r.companyId, securityId: r.securityId, mode: r.mode, alsoIn: [],
    rank: r.rank, yahooSymbol: r.yahooSymbol, name: r.name, close: r.close, ccy: r.currency,
    sessionDate: r.sessionDate, line: r.thresholdLine === "-3" ? "-3" : "-4",
    category: r.category === "amber" ? "amber" : "green",
    conclusion: r.conclusion ?? "", bankruptcyRisk: r.bankruptcyRisk ?? "Unclear", summary: r.summary, eur,
  };
}

function channelsFor(u: DigestUser): ChannelInput[] {
  const push: ChannelInput = !u.pushEnabled
    ? { channel: "push", status: "skipped", skip_reason: "preference_off" }
    : !u.hasActivePush
      ? { channel: "push", status: "skipped", skip_reason: "no_subscription" }
      : { channel: "push", status: "pending", skip_reason: null };
  const email: ChannelInput = !u.emailEnabled
    ? { channel: "email", status: "skipped", skip_reason: "preference_off" }
    : !u.emailOk
      ? { channel: "email", status: "skipped", skip_reason: "email_not_deliverable" }
      : { channel: "email", status: "pending", skip_reason: null };
  return [push, email];
}

export async function runDigestStage(
  scanRunId: string,
  reason: DigestReason,
  deps: DigestStageDeps,
): Promise<DigestStageResult> {
  const { store } = deps;
  const run = await store.scanRun(scanRunId);
  const empty = { users: 0, created: 0, existing: 0, skippedEmpty: 0 };
  if (run === null || run.status === "failed") return { status: "skipped_failed_scan", ...empty };
  if (run.digestsCreatedAt !== null) return { status: "skipped_already_created", ...empty };

  const users = await store.getUsers();
  let created = 0;
  let existing = 0;
  let skippedEmpty = 0;
  let failed = 0;

  const write = async (args: InsertDigestArgs) => {
    const id = await store.insertDigest(args);
    if (id === null) existing++;
    else if (args.status === "skipped") skippedEmpty++;
    else created++;
  };

  for (const user of users) {
    try {
      // --- Today's Discounts ------------------------------------------------------------------
      const rows = await store.discountCandidates(scanRunId, user.userId, reason === "cutoff");
      const cleared = rows.filter((r) => r.category === "green" || r.category === "amber");
      if (cleared.length !== rows.length) deps.log("digest_rows_rejected", { count: rows.length - cleared.length });
      const built = buildDiscountDigest(cleared.map(toDiscountEntry), { modes: user.modes, sendEmpty: user.sendEmpty });
      const kept = new Set(built.items.map((i) => i.companyId));
      const primaryByCompany = new Map(built.items.map((i) => [i.companyId, i.episodeId]));
      const mergedAway = cleared.filter(
        (r) => user.modes.includes(r.mode) && kept.has(r.companyId) && !built.items.some((i) => i.episodeId === r.episodeId),
      );
      const discountContent = { kind: "discounts" as const, scanDate: run.scanDateLocal, items: built.items };
      await write({
        scanRunId, userId: user.userId, kind: "discounts", content: discountContent,
        hash: await deps.sha256Hex(canonicalJson(discountContent)), reason,
        status: built.skipReason === null ? "ready" : "skipped", skipReason: built.skipReason,
        items: [
          ...built.items.map((i) => ({ ref_type: "episode" as const, ref_id: i.episodeId, payload: {} })),
          ...mergedAway.map((r) => ({
            ref_type: "episode" as const, ref_id: r.episodeId, payload: { mergedInto: primaryByCompany.get(r.companyId) ?? null },
          })),
        ],
        channels: built.skipReason === null ? channelsFor(user) : [],
        scanDate: run.scanDateLocal,
      });

      // --- Portfolio Alerts (holders only) ------------------------------------------------------
      if (user.holdsPositions) {
        const cand = await store.portfolioCandidates(scanRunId, user.userId);
        const entries: PortfolioEntryView[] = [
          ...cand.premium.map((p) => ({
            key: p.securityId, securityId: p.securityId, yahooSymbol: p.yahooSymbol, name: p.name,
            priceSignals: [p.kind], riskFindingIds: [], researchStatus: p.researchStatus,
            signals: [{ kind: p.kind, close: p.close, ccy: p.ccy, sessionDate: p.sessionDate }], risks: [],
          })),
          ...cand.risks.map((r) => ({
            key: r.securityId, securityId: r.securityId, yahooSymbol: r.yahooSymbol, name: r.name,
            priceSignals: [], riskFindingIds: [r.id], researchStatus: r.researchStatus, signals: [],
            risks: [{ id: r.id, category: r.category, summary: r.summary, detectedOn: r.detectedOn }],
          })),
        ];
        const portfolio = buildPortfolioDigest(entries, user.sendEmpty);
        const content = { kind: "portfolio" as const, scanDate: run.scanDateLocal, items: portfolio.items };
        await write({
          scanRunId, userId: user.userId, kind: "portfolio", content,
          hash: await deps.sha256Hex(canonicalJson(content)), reason,
          status: portfolio.skipReason === null ? "ready" : "skipped", skipReason: portfolio.skipReason,
          items: [
            ...cand.premium.map((p) => ({ ref_type: "episode" as const, ref_id: p.episodeId, payload: {} })),
            ...cand.risks.map((r) => ({ ref_type: "finding" as const, ref_id: r.id, payload: {} })),
          ],
          channels: portfolio.skipReason === null ? channelsFor(user) : [],
          scanDate: run.scanDateLocal,
        });
      }
    } catch (error) {
      failed++;
      deps.log("digest_user_failed", { message: error instanceof Error ? error.message : "unknown" });
    }
  }

  if (failed > 0) throw new Error(`digest stage: ${failed} of ${users.length} users failed; the job will be retried`);
  const stats = { users: users.length, created, existing, skippedEmpty };
  await store.finish(scanRunId, reason, stats);
  return { status: "created", ...stats };
}
```

- [ ] **Step 4: Run the stage tests until they pass**

Run: `deno test --config supabase/functions/deno.json supabase/functions/worker-tick/handlers/digest-stage.test.ts`
Expected: 10 tests pass. (`DigestStore` names its user listing `getUsers`; keep that name.)

- [ ] **Step 5: Write the failing store test and implement `digest-store.ts` and the handler adapter**

`supabase/functions/worker-tick/handlers/digest-store.test.ts`:

```ts
import { assertEquals, assertRejects } from "@std/assert";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createDigestStore } from "./digest-store.ts";

function fakeClient(responses: Record<string, unknown>) {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const client = {
    rpc(name: string, args: Record<string, unknown>) {
      calls.push({ name, args });
      const data = responses[name];
      return Promise.resolve(data instanceof Error ? { data: null, error: { message: data.message } } : { data, error: null });
    },
    from() {
      return { select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: { id: "r1", status: "complete", scan_date_local: "2026-10-15", digests_created_at: null }, error: null }) }) }) };
    },
  };
  return { calls, client: client as unknown as SupabaseClient };
}

Deno.test("store maps RPC rows and passes the documented parameter names", async () => {
  const { calls, client } = fakeClient({
    notify_digest_users: [{ user_id: "u1", push_enabled: true, email_enabled: false, email_ok: true, has_active_push: true, digest_modes: ["worldwide"], send_empty: false, holds_positions: true }],
    notify_discount_candidates: [{ episode_id: "e1", company_id: "c1", security_id: "s1", mode: "us", rank: 3, yahoo_symbol: "AAA", name: "Alpha", close: 1.5, currency: "USD", session_date: "2026-10-14", threshold_line: "-3", category: "green", conclusion: null, bankruptcy_risk: null, summary: "s", eur_symbol: null, eur_status: null }],
    notify_portfolio_candidates: { premium: [], risks: [] },
    notify_insert_digest: "digest-1",
    notify_finish_digests: true,
  });
  const store = createDigestStore(client);
  assertEquals((await store.scanRun("r1"))?.scanDateLocal, "2026-10-15");
  const users = await store.getUsers();
  assertEquals(users[0]?.holdsPositions, true);
  assertEquals(users[0]?.modes, ["worldwide"]);
  const rows = await store.discountCandidates("r1", "u1", true);
  assertEquals(rows[0]?.thresholdLine, "-3");
  assertEquals(calls.find((c) => c.name === "notify_discount_candidates")?.args, { p_scan_run: "r1", p_user: "u1", p_finished_only: true });
  assertEquals(await store.portfolioCandidates("r1", "u1"), { premium: [], risks: [] });
  const id = await store.insertDigest({
    scanRunId: "r1", userId: "u1", kind: "discounts", content: { kind: "discounts", scanDate: "2026-10-15", items: [] },
    hash: "h", reason: "complete", status: "skipped", skipReason: "empty", items: [], channels: [], scanDate: "2026-10-15",
  });
  assertEquals(id, "digest-1");
  assertEquals(Object.keys(calls.find((c) => c.name === "notify_insert_digest")?.args ?? {}).sort(), [
    "p_channels", "p_content", "p_hash", "p_items", "p_kind", "p_reason", "p_scan_date", "p_scan_run", "p_skip_reason", "p_status", "p_user",
  ]);
  assertEquals(await store.finish("r1", "complete", { users: 1 }), true);
});

Deno.test("store surfaces RPC errors without parameters in the message", async () => {
  const { client } = fakeClient({ notify_digest_users: new Error("permission denied") });
  await assertRejects(() => createDigestStore(client).getUsers(), Error, "notify_digest_users failed: permission denied");
});
```

`supabase/functions/worker-tick/handlers/digest-store.ts`:

```ts
import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  DigestStore, DigestUser, DiscountRow, InsertDigestArgs, PortfolioCandidates, ScanRunInfo,
} from "./digest-stage.ts";

type Row = Record<string, unknown>;

export function createDigestStore(client: SupabaseClient): DigestStore {
  async function rpc(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    const { data, error } = await client.rpc(name, args);
    if (error) throw new Error(`${name} failed: ${error.message}`);
    return data;
  }
  return {
    async scanRun(id): Promise<ScanRunInfo | null> {
      const { data, error } = await client
        .from("scan_runs").select("id,status,scan_date_local,digests_created_at").eq("id", id).maybeSingle();
      if (error) throw new Error(`scan_runs read failed: ${error.message}`);
      if (data === null) return null;
      const r = data as Row;
      return {
        id: String(r.id), status: String(r.status), scanDateLocal: String(r.scan_date_local),
        digestsCreatedAt: r.digests_created_at === null ? null : String(r.digests_created_at),
      };
    },
    async getUsers(): Promise<DigestUser[]> {
      return ((await rpc("notify_digest_users")) as Row[]).map((r) => ({
        userId: String(r.user_id), pushEnabled: Boolean(r.push_enabled), emailEnabled: Boolean(r.email_enabled),
        emailOk: Boolean(r.email_ok), hasActivePush: Boolean(r.has_active_push),
        modes: (r.digest_modes as DigestUser["modes"]) ?? ["worldwide"], sendEmpty: Boolean(r.send_empty),
        holdsPositions: Boolean(r.holds_positions),
      }));
    },
    async discountCandidates(scanRunId, userId, finishedOnly): Promise<DiscountRow[]> {
      const data = (await rpc("notify_discount_candidates", {
        p_scan_run: scanRunId, p_user: userId, p_finished_only: finishedOnly,
      })) as Row[];
      return data.map((r) => ({
        episodeId: String(r.episode_id), companyId: String(r.company_id), securityId: String(r.security_id),
        mode: r.mode as DiscountRow["mode"], rank: Number(r.rank), yahooSymbol: String(r.yahoo_symbol),
        name: String(r.name), close: Number(r.close), currency: String(r.currency), sessionDate: String(r.session_date),
        thresholdLine: String(r.threshold_line), category: String(r.category),
        conclusion: r.conclusion === null ? null : String(r.conclusion),
        bankruptcyRisk: r.bankruptcy_risk === null ? null : String(r.bankruptcy_risk), summary: String(r.summary ?? ""),
        eurSymbol: r.eur_symbol === null ? null : String(r.eur_symbol),
        eurStatus: r.eur_status === null ? null : String(r.eur_status),
      }));
    },
    async portfolioCandidates(scanRunId, userId): Promise<PortfolioCandidates> {
      return (await rpc("notify_portfolio_candidates", { p_scan_run: scanRunId, p_user: userId })) as PortfolioCandidates;
    },
    async insertDigest(a: InsertDigestArgs): Promise<string | null> {
      const id = await rpc("notify_insert_digest", {
        p_scan_run: a.scanRunId, p_user: a.userId, p_kind: a.kind, p_content: a.content, p_hash: a.hash,
        p_reason: a.reason, p_status: a.status, p_skip_reason: a.skipReason, p_items: a.items,
        p_channels: a.channels, p_scan_date: a.scanDate,
      });
      return id === null ? null : String(id);
    },
    async finish(scanRunId, reason, stats): Promise<boolean> {
      return Boolean(await rpc("notify_finish_digests", { p_scan_run: scanRunId, p_reason: reason, p_stats: stats }));
    },
  };
}
```

`supabase/functions/worker-tick/handlers/digest.ts` (the registry adapter):

```ts
import type { SupabaseClient } from "@supabase/supabase-js";
import { type DigestReason, runDigestStage, sha256Hex } from "./digest-stage.ts";
import { createDigestStore } from "./digest-store.ts";

// Stage 12 (spec 7.4). Job key `digest` runs at scan completion, `digest:cutoff` is seeded by
// app.cutoff_digests() at 13:00 Sofia (spec 7.10). The handler is idempotent: digests_created_at,
// the digest UNIQUE key and the digest_items UNIQUE key make a second run a no-op.
export async function digestHandler(job: { scan_run_id: string; key: string }, client: SupabaseClient): Promise<void> {
  const reason: DigestReason = job.key === "digest:cutoff" ? "cutoff" : "complete";
  const result = await runDigestStage(job.scan_run_id, reason, {
    store: createDigestStore(client),
    sha256Hex,
    log: (event, data) => console.log(JSON.stringify({ event, ...data })),
  });
  console.log(JSON.stringify({ event: "digest_stage_done", ...result }));
}
```

Register it: in the P1 registry file (`grep -n "HANDLERS" supabase/functions/worker-tick`) add `digest: (job, ctx) => digestHandler(job, ctx.client)` and the import `import { digestHandler } from "./handlers/digest.ts";`. If the P1 handler context names the service client differently, change only that argument.

Run: `deno test --config supabase/functions/deno.json supabase/functions/worker-tick/handlers`
Expected: the stage tests (10) and store tests (2) pass.

- [ ] **Step 6: Write the failing dispatch tests**

`supabase/functions/notify-dispatch/dispatch.test.ts`:

```ts
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import type { DiscountEntry } from "@core/digest.ts";
import { verifyUnsubscribeToken } from "@adapters/unsubscribe-token.ts";
import type { EmailResult, SendEmailInput } from "@adapters/email.ts";
import type { PushResult, PushTarget, SendPushOptions } from "@adapters/push.ts";
import {
  type ClaimedDelivery, type Completion, type DispatchDeps, type DispatchStore, MAX_ATTEMPTS,
  processDelivery, RETRY_SECONDS, runDispatch,
} from "./dispatch.ts";

const NOW = Date.parse("2026-10-15T10:30:00Z");
const USER = "00000000-0000-0000-0000-0000000000a1";
const ENTRY: DiscountEntry = {
  episodeId: "e1", companyId: "c1", securityId: "s1", mode: "worldwide", alsoIn: [], rank: 12, yahooSymbol: "AAA",
  name: "Alpha Corp", close: 100, ccy: "USD", sessionDate: "2026-10-14", line: "-4", category: "green",
  conclusion: "Meets these two fundamental checks.", bankruptcyRisk: "Low", summary: "Fell with the sector.", eur: null,
};

function delivery(over: Partial<ClaimedDelivery> = {}): ClaimedDelivery {
  return {
    id: "del-1", digestId: "dig-1", userId: USER, channel: "email", attempts: 1,
    idempotencyKey: `digest:discounts:${USER}:2026-10-15`, quotaConsumed: false, kind: "discounts",
    content: { kind: "discounts", scanDate: "2026-10-15", items: [ENTRY] }, scanRunId: "run-1",
    digestCreatedAt: "2026-10-15T10:20:00Z", scanDate: "2026-10-15",
    prefs: { pushEnabled: true, emailEnabled: true, emailUnsubscribedAt: null, emailBouncedAt: null, emailConfirmed: true },
    email: "user@example.test", ...over,
  };
}

interface Sub { id: string; userId: string; endpoint: string; p256dh: string; auth: string; revoked: boolean; failures: number }

class FakeStore implements DispatchStore {
  completions: { id: string; c: Completion }[] = [];
  subs: Sub[] = [];
  queue: ClaimedDelivery[] = [];
  quotaUsed = 0;
  consumed = new Set<string>();
  claim(limit: number) { return Promise.resolve(this.queue.splice(0, limit)); }
  subscriptions(userId: string) {
    return Promise.resolve(this.subs.filter((s) => s.userId === userId && !s.revoked).map(({ id, endpoint, p256dh, auth }) => ({ id, endpoint, p256dh, auth })));
  }
  markSubscription(id: string, outcome: "success" | "failure" | "gone") {
    const s = this.subs.find((x) => x.id === id);
    if (s) {
      if (outcome === "success") s.failures = 0;
      if (outcome === "gone") s.revoked = true;
      if (outcome === "failure" && ++s.failures >= 5) s.revoked = true;
    }
    return Promise.resolve();
  }
  consumeEmailQuota(id: string, limit: number) {
    if (this.consumed.has(id)) return Promise.resolve(true);
    if (this.quotaUsed >= limit) return Promise.resolve(false);
    this.quotaUsed++;
    this.consumed.add(id);
    return Promise.resolve(true);
  }
  complete(id: string, c: Completion) { this.completions.push({ id, c }); return Promise.resolve(); }
}

function sub(id: string, over: Partial<Sub> = {}): Sub {
  return { id, userId: USER, endpoint: `https://push.example.test/${id}`, p256dh: "k", auth: "a", revoked: false, failures: 0, ...over };
}

function setup(over: { push?: (t: PushTarget, o: SendPushOptions) => PushResult; email?: (i: SendEmailInput) => EmailResult; cap?: number } = {}) {
  const store = new FakeStore();
  const pushCalls: { endpoint: string; payload: string; opts: SendPushOptions }[] = [];
  const emails: SendEmailInput[] = [];
  const sleeps: number[] = [];
  const deps: DispatchDeps = {
    store,
    sendPush: (t, payload, opts) => { pushCalls.push({ endpoint: t.endpoint, payload, opts }); return Promise.resolve(over.push?.(t, opts) ?? { ok: true }); },
    sendEmail: (input) => { emails.push(input); return Promise.resolve(over.email?.(input) ?? { ok: true, id: "em_1" }); },
    nowMs: () => NOW, sleep: (ms) => { sleeps.push(ms); return Promise.resolve(); },
    siteUrl: "https://screener.example.test", functionsBaseUrl: "https://abc.supabase.co/functions/v1",
    unsubscribeSecret: "unsub-secret", emailDailyCap: over.cap ?? 90, log: () => {},
  };
  return { store, deps, pushCalls, emails, sleeps };
}

Deno.test("email: sent with the stable idempotency key, a verifiable unsubscribe link and no private data", async () => {
  const { store, deps, emails } = setup();
  const completion = await processDelivery(delivery(), deps);
  assertEquals(completion.status, "sent");
  assertEquals(completion.messageId, "em_1");
  const mail = emails[0];
  assert(mail);
  assertEquals(mail.idempotencyKey, `digest:discounts:${USER}:2026-10-15`);
  assertEquals(mail.to, "user@example.test");
  assertEquals(mail.subject, "Today's discounts: 1 new (2026-10-15)");
  const token = new URL(mail.unsubscribeUrl).searchParams.get("t") ?? "";
  assertEquals(await verifyUnsubscribeToken(token, "unsub-secret"), USER);
  assertStringIncludes(mail.html, "Alpha Corp");
  assertStringIncludes(mail.text, "#12 AAA");
  assertEquals(/quantity|cost basis/i.test(mail.text + mail.html), false);
  assertEquals(store.quotaUsed, 1);
});

Deno.test("a retried delivery stays one delivery: same row, same Idempotency-Key, same Topic, one quota unit", async () => {
  let n = 0;
  const { store, deps, emails } = setup({ email: () => (n++ === 0 ? { ok: false, kind: "network" } : { ok: true, id: "em_9" }) });
  const first = delivery({ attempts: 1 });
  const c1 = await processDelivery(first, deps);
  const c2 = await processDelivery({ ...first, attempts: 2 }, deps);
  assertEquals(c1.status, "pending");
  assertEquals(c1.retryInSeconds, 60);
  assertEquals(c2.status, "sent");
  assertEquals(emails[0]?.idempotencyKey, emails[1]?.idempotencyKey);
  assertEquals(store.quotaUsed, 1);

  const p = setup({ push: () => ({ ok: false, kind: "network" }) });
  p.store.subs = [sub("s1")];
  const pd = delivery({ id: "del-2", channel: "push" });
  await processDelivery(pd, p.deps);
  await processDelivery({ ...pd, attempts: 2 }, p.deps);
  assertEquals(p.pushCalls.map((c) => c.opts.topic), ["digest-discounts", "digest-discounts"]);
});

Deno.test("retry schedule is 1 m, 5 m, 30 m, 2 h and the fifth failed attempt is final", async () => {
  const { deps } = setup({ email: () => ({ ok: false, kind: "http", status: 503 }) });
  const seconds: (number | null | undefined)[] = [];
  for (let attempts = 1; attempts <= 4; attempts++) seconds.push((await processDelivery(delivery({ attempts }), deps)).retryInSeconds);
  assertEquals(seconds, [60, 300, 1800, 7200]);
  assertEquals([...RETRY_SECONDS], [60, 300, 1800, 7200]);
  const last = await processDelivery(delivery({ attempts: MAX_ATTEMPTS }), deps);
  assertEquals(last.status, "failed");
  assertStringIncludes(last.error ?? "", "attempts_exhausted");
});

Deno.test("an unsubscribed, disabled, bounced or unconfirmed user is never emailed (preferences re-read at dispatch)", async () => {
  const cases: [Partial<ClaimedDelivery["prefs"]>, string][] = [
    [{ emailUnsubscribedAt: "2026-10-15T10:25:00Z" }, "unsubscribed"],
    [{ emailEnabled: false }, "preference_off"],
    [{ emailBouncedAt: "2026-10-14T00:00:00Z" }, "bounced"],
    [{ emailConfirmed: false }, "email_unverified"],
  ];
  for (const [prefs, reason] of cases) {
    const { store, deps, emails } = setup();
    const d = delivery();
    const completion = await processDelivery({ ...d, prefs: { ...d.prefs, ...prefs } }, deps);
    assertEquals(completion.status, "skipped");
    assertEquals(completion.skipReason, reason);
    assertEquals(emails.length, 0);
    assertEquals(store.quotaUsed, 0, "no quota is spent on a suppressed email");
  }
});

Deno.test("the daily cap ends the delivery as skipped/daily_cap without calling Resend", async () => {
  const { deps, emails } = setup({ cap: 1 });
  assertEquals((await processDelivery(delivery({ id: "a" }), deps)).status, "sent");
  const capped = await processDelivery(delivery({ id: "b" }), deps);
  assertEquals(capped.status, "skipped");
  assertEquals(capped.skipReason, "daily_cap");
  assertEquals(emails.length, 1);
});

Deno.test("email error classes: invalid is final, rate limit honours Retry-After, expired digest is never sent", async () => {
  const invalid = setup({ email: () => ({ ok: false, kind: "invalid", status: 422 }) });
  assertEquals((await processDelivery(delivery(), invalid.deps)).status, "failed");
  const limited = setup({ email: () => ({ ok: false, kind: "rate_limited", status: 429, retryAfterSec: 900 }) });
  assertEquals((await processDelivery(delivery(), limited.deps)).retryInSeconds, 900);
  const old = setup();
  const expired = await processDelivery(delivery({ digestCreatedAt: "2026-10-14T09:00:00Z" }), old.deps);
  assertEquals(expired.status, "failed");
  assertEquals(expired.error, "expired");
  assertEquals(old.emails.length, 0);
});

Deno.test("push: sent when one subscription succeeds; a gone subscription is revoked and never used again", async () => {
  const { store, deps, pushCalls } = setup({ push: (t) => (t.endpoint.endsWith("/dead") ? { ok: false, kind: "gone", status: 410 } : { ok: true }) });
  store.subs = [sub("dead"), sub("live")];
  const d = delivery({ channel: "push", email: null });
  const first = await processDelivery(d, deps);
  assertEquals(first.status, "sent");
  assertEquals(store.subs.find((s) => s.id === "dead")?.revoked, true);
  assertEquals(pushCalls.length, 2);
  assertEquals(pushCalls[0]?.opts, { ttlSeconds: 21600, topic: "digest-discounts", urgency: "normal" });
  await processDelivery({ ...d, id: "del-next", attempts: 1 }, deps);
  assertEquals(pushCalls.filter((c) => c.endpoint.endsWith("/dead")).length, 1, "the revoked endpoint is not contacted again");
});

Deno.test("push: all subscriptions gone or none at all is skipped, 429 retries after Retry-After, payload stays small", async () => {
  const gone = setup({ push: () => ({ ok: false, kind: "gone", status: 404 }) });
  gone.store.subs = [sub("x")];
  const c = await processDelivery(delivery({ channel: "push", email: null }), gone.deps);
  assertEquals([c.status, c.skipReason], ["skipped", "no_subscription"]);
  const none = setup();
  assertEquals((await processDelivery(delivery({ channel: "push", email: null }), none.deps)).skipReason, "no_subscription");
  const limited = setup({ push: () => ({ ok: false, kind: "rate_limited", status: 429, retryAfterSec: 900 }) });
  limited.store.subs = [sub("x")];
  const r = await processDelivery(delivery({ channel: "push", email: null }), limited.deps);
  assertEquals([r.status, r.retryInSeconds], ["pending", 900]);
  const ok = setup();
  ok.store.subs = [sub("x")];
  await processDelivery(delivery({ channel: "push", email: null }), ok.deps);
  assert((ok.pushCalls[0]?.payload.length ?? 0) <= 3500);
});

Deno.test("push: a persistent 4xx counts against the subscription and five failures revoke it", async () => {
  const { store, deps } = setup({ push: () => ({ ok: false, kind: "http", status: 401 }) });
  store.subs = [sub("bad")];
  for (let i = 0; i < 5; i++) {
    const c = await processDelivery(delivery({ id: `d${i}`, channel: "push", email: null }), deps);
    assertEquals(c.status, "failed");
  }
  assertEquals(store.subs[0]?.revoked, true);
  assertEquals((await processDelivery(delivery({ id: "d9", channel: "push", email: null }), deps)).skipReason, "no_subscription");
});

Deno.test("push disabled after creation is skipped, not sent", async () => {
  const { store, deps, pushCalls } = setup();
  store.subs = [sub("x")];
  const d = delivery({ channel: "push", email: null });
  const c = await processDelivery({ ...d, prefs: { ...d.prefs, pushEnabled: false } }, deps);
  assertEquals([c.status, c.skipReason], ["skipped", "preference_off"]);
  assertEquals(pushCalls.length, 0);
});

Deno.test("runDispatch completes every claimed delivery, spaces emails by 150 ms and survives one exception", async () => {
  const { store, deps, sleeps } = setup();
  store.queue = [delivery({ id: "a" }), delivery({ id: "boom" }), delivery({ id: "c" })];
  const original = store.complete.bind(store);
  store.complete = (id, c) => (id === "boom" ? Promise.reject(new Error("db")) : original(id, c));
  const result = await runDispatch(deps, { limit: 20, budgetMs: 100_000 });
  assertEquals(store.completions.map((c) => c.id), ["a", "c"]);
  assertEquals(result.processed, 2);
  assertEquals(result.errors, 1);
  assert(sleeps.every((ms) => ms === 150) && sleeps.length >= 2);
});
```

- [ ] **Step 7: Run to confirm failure**

Run: `deno test --config supabase/functions/deno.json supabase/functions/notify-dispatch/dispatch.test.ts`
Expected: FAIL, module `./dispatch.ts` not found.

- [ ] **Step 8: Implement `dispatch.ts`**

`supabase/functions/notify-dispatch/dispatch.ts`:

```ts
import {
  type DigestKind, type DiscountEntry, digestSubject, digestTopic, type PortfolioEntryView, pushPayload,
  renderDigestHtml, renderDigestText,
} from "@core/digest.ts";
import type { EmailResult, SendEmailInput } from "@adapters/email.ts";
import type { PushResult, PushTarget, SendPushOptions } from "@adapters/push.ts";
import { makeUnsubscribeToken } from "@adapters/unsubscribe-token.ts";

export const RETRY_SECONDS = [60, 300, 1800, 7200] as const;
export const MAX_ATTEMPTS = 5;
export const EMAIL_DAILY_CAP = 90;
const EXPIRY_MS = 24 * 60 * 60 * 1000;
const EMAIL_SPACING_MS = 150;
const PUSH_TTL_SECONDS = 21_600;

export interface ClaimedDelivery {
  id: string;
  digestId: string;
  userId: string;
  channel: "push" | "email";
  attempts: number;
  idempotencyKey: string;
  quotaConsumed: boolean;
  kind: DigestKind;
  content: unknown;
  scanRunId: string;
  digestCreatedAt: string;
  scanDate: string;
  prefs: {
    pushEnabled: boolean;
    emailEnabled: boolean;
    emailUnsubscribedAt: string | null;
    emailBouncedAt: string | null;
    emailConfirmed: boolean;
  };
  /** held in memory for one send; never logged */
  email: string | null;
}

export interface Completion {
  status: "sent" | "failed" | "skipped" | "bounced" | "pending";
  skipReason?: string | null;
  error?: string | null;
  messageId?: string | null;
  retryInSeconds?: number | null;
  log: Record<string, unknown>;
}

export interface DispatchStore {
  claim(limit: number): Promise<ClaimedDelivery[]>;
  subscriptions(userId: string): Promise<(PushTarget & { id: string })[]>;
  markSubscription(id: string, outcome: "success" | "failure" | "gone"): Promise<void>;
  consumeEmailQuota(deliveryId: string, limit: number): Promise<boolean>;
  complete(id: string, completion: Completion): Promise<void>;
}

export interface DispatchDeps {
  store: DispatchStore;
  sendPush(sub: PushTarget, payloadJson: string, opts: SendPushOptions): Promise<PushResult>;
  sendEmail(input: SendEmailInput): Promise<EmailResult>;
  nowMs(): number;
  sleep(ms: number): Promise<void>;
  siteUrl: string;
  functionsBaseUrl: string;
  unsubscribeSecret: string;
  emailDailyCap: number;
  log(event: string, data: Record<string, unknown>): void;
}

function items(d: ClaimedDelivery): unknown[] {
  const raw = (d.content as { items?: unknown } | null)?.items;
  return Array.isArray(raw) ? raw : [];
}

function skip(d: ClaimedDelivery, reason: string): Completion {
  return { status: "skipped", skipReason: reason, log: { attempt: d.attempts, status: "skipped", detail: reason } };
}

function retryOrFail(d: ClaimedDelivery, error: string, minDelaySec = 0): Completion {
  if (d.attempts >= MAX_ATTEMPTS) {
    return { status: "failed", error: `attempts_exhausted:${error}`, log: { attempt: d.attempts, status: "failed", detail: error } };
  }
  const base = RETRY_SECONDS[Math.min(d.attempts, RETRY_SECONDS.length) - 1] ?? RETRY_SECONDS[RETRY_SECONDS.length - 1] ?? 60;
  return {
    status: "pending", error, retryInSeconds: Math.max(base, minDelaySec),
    log: { attempt: d.attempts, status: "retry", detail: error },
  };
}

async function processPush(d: ClaimedDelivery, deps: DispatchDeps): Promise<Completion> {
  if (!d.prefs.pushEnabled) return skip(d, "preference_off");
  const subs = await deps.store.subscriptions(d.userId);
  if (subs.length === 0) return skip(d, "no_subscription");
  const payload = JSON.stringify(
    d.kind === "discounts"
      ? pushPayload("discounts", items(d) as DiscountEntry[], deps.siteUrl)
      : pushPayload("portfolio", items(d) as PortfolioEntryView[], deps.siteUrl),
  );
  const opts: SendPushOptions = { ttlSeconds: PUSH_TTL_SECONDS, topic: digestTopic(d.kind), urgency: "normal" };
  let sentAny = false;
  let gone = 0;
  let retry: { error: string; after: number } | null = null;
  for (const sub of subs) {
    const result = await deps.sendPush({ endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth }, payload, opts);
    if (result.ok) {
      sentAny = true;
      await deps.store.markSubscription(sub.id, "success");
    } else if (result.kind === "gone") {
      gone++;
      await deps.store.markSubscription(sub.id, "gone");
    } else if (result.kind === "rate_limited") {
      retry = { error: "push_rate_limited", after: Math.max(retry?.after ?? 0, result.retryAfterSec ?? 0) };
    } else if (result.kind === "network" || (result.kind === "http" && (result.status ?? 0) >= 500)) {
      retry = { error: result.kind === "network" ? "push_network" : `push_http_${result.status}`, after: retry?.after ?? 0 };
    } else {
      await deps.store.markSubscription(sub.id, "failure");
    }
  }
  if (sentAny) return { status: "sent", log: { attempt: d.attempts, status: "sent", detail: `${subs.length - gone} subscriptions` } };
  if (retry !== null) return retryOrFail(d, retry.error, retry.after);
  if (gone === subs.length) return skip(d, "no_subscription");
  return { status: "failed", error: "push_rejected", log: { attempt: d.attempts, status: "failed", detail: "push_rejected" } };
}

async function processEmail(d: ClaimedDelivery, deps: DispatchDeps): Promise<Completion> {
  const p = d.prefs;
  if (!p.emailEnabled) return skip(d, "preference_off");
  if (p.emailUnsubscribedAt !== null) return skip(d, "unsubscribed");
  if (p.emailBouncedAt !== null) return skip(d, "bounced");
  if (!p.emailConfirmed || d.email === null) return skip(d, "email_unverified");
  if (!(await deps.store.consumeEmailQuota(d.id, deps.emailDailyCap))) return skip(d, "daily_cap");

  const token = await makeUnsubscribeToken(d.userId, deps.unsubscribeSecret);
  const unsubscribeUrl = `${deps.functionsBaseUrl}/notify-unsubscribe?t=${token}`;
  const ctx = { scanDate: d.scanDate, siteUrl: deps.siteUrl, unsubscribeUrl };
  const list = items(d);
  const html =
    d.kind === "discounts"
      ? renderDigestHtml("discounts", list as DiscountEntry[], ctx)
      : renderDigestHtml("portfolio", list as PortfolioEntryView[], ctx);
  const text =
    d.kind === "discounts"
      ? renderDigestText("discounts", list as DiscountEntry[], ctx)
      : renderDigestText("portfolio", list as PortfolioEntryView[], ctx);
  const result = await deps.sendEmail({
    to: d.email, subject: digestSubject(d.kind, list.length, d.scanDate), html, text,
    idempotencyKey: d.idempotencyKey, unsubscribeUrl,
  });
  if (result.ok) {
    return { status: "sent", messageId: result.id, log: { attempt: d.attempts, status: "sent", detail: "accepted" } };
  }
  if (result.kind === "invalid") {
    return { status: "failed", error: `email_invalid_${result.status ?? 0}`, log: { attempt: d.attempts, status: "failed", detail: "invalid" } };
  }
  if (result.kind === "rate_limited") return retryOrFail(d, "email_rate_limited", result.retryAfterSec ?? 0);
  return retryOrFail(d, result.kind === "network" ? "email_network" : `email_http_${result.status ?? 0}`);
}

/** Decides the fate of one claimed delivery and records it on the SAME delivery row. */
export async function processDelivery(d: ClaimedDelivery, deps: DispatchDeps): Promise<Completion> {
  if (deps.nowMs() - Date.parse(d.digestCreatedAt) > EXPIRY_MS) {
    return { status: "failed", error: "expired", log: { attempt: d.attempts, status: "failed", detail: "expired" } };
  }
  return d.channel === "push" ? await processPush(d, deps) : await processEmail(d, deps);
}

export interface DispatchResult {
  claimed: number;
  processed: number;
  errors: number;
}

export async function runDispatch(deps: DispatchDeps, opts: { limit: number; budgetMs: number }): Promise<DispatchResult> {
  const deadline = deps.nowMs() + opts.budgetMs;
  const result: DispatchResult = { claimed: 0, processed: 0, errors: 0 };
  while (deps.nowMs() < deadline) {
    const batch = await deps.store.claim(opts.limit);
    if (batch.length === 0) break;
    result.claimed += batch.length;
    for (const d of batch) {
      if (deps.nowMs() >= deadline) return result; // unprocessed rows return when their 10 minute lease ends
      try {
        const completion = await processDelivery(d, deps);
        await deps.store.complete(d.id, completion);
        result.processed++;
        deps.log("delivery_processed", { delivery: d.id, channel: d.channel, status: completion.status, attempt: d.attempts });
        if (d.channel === "email" && completion.status !== "skipped") await deps.sleep(EMAIL_SPACING_MS);
      } catch (error) {
        result.errors++;
        deps.log("delivery_error", { delivery: d.id, channel: d.channel, message: error instanceof Error ? error.message : "unknown" });
      }
    }
  }
  return result;
}
```

- [ ] **Step 9: Run the dispatch tests until they pass**

Run: `deno test --config supabase/functions/deno.json supabase/functions/notify-dispatch/dispatch.test.ts`
Expected: 11 tests pass. The `runDispatch` test expects at least two 150 ms sleeps (two emails sent); the thrown delivery does not sleep.

- [ ] **Step 10: Write the handler test, then the store, handler and entrypoint**

`supabase/functions/notify-dispatch/handler.test.ts`:

```ts
import { assertEquals } from "@std/assert";
import { handleNotifyDispatch } from "./handler.ts";

const run = () => Promise.resolve({ claimed: 2, processed: 2, errors: 0 });
const deps = { cronSecret: "s3cret", run };

Deno.test("rejects calls without the cron secret", async () => {
  const res = await handleNotifyDispatch(new Request("http://x/", { method: "POST" }), deps);
  assertEquals(res.status, 401);
  assertEquals((await res.json()).error, "unauthorized");
});

Deno.test("fails closed when no secret is configured", async () => {
  const res = await handleNotifyDispatch(new Request("http://x/", { method: "POST", headers: { "x-cron-secret": "" } }), { ...deps, cronSecret: "" });
  assertEquals(res.status, 500);
});

Deno.test("POST with the secret runs one dispatch pass and reports counts only", async () => {
  const res = await handleNotifyDispatch(new Request("http://x/", { method: "POST", headers: { "x-cron-secret": "s3cret" }, body: '{"action":"tick"}' }), deps);
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { ok: true, claimed: 2, processed: 2, errors: 0 });
});

Deno.test("only POST is allowed", async () => {
  const res = await handleNotifyDispatch(new Request("http://x/", { method: "GET", headers: { "x-cron-secret": "s3cret" } }), deps);
  assertEquals(res.status, 405);
});
```

`supabase/functions/notify-dispatch/handler.ts`:

```ts
import { json, requireCronSecret } from "@adapters/http.ts";
import type { DispatchResult } from "./dispatch.ts";

export interface HandlerDeps {
  cronSecret: string;
  run(): Promise<DispatchResult>;
}

export async function handleNotifyDispatch(req: Request, deps: HandlerDeps): Promise<Response> {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, { status: 405, headers: { allow: "POST" } });
  const denied = await requireCronSecret(req, deps.cronSecret);
  if (denied !== null) return denied;
  const result = await deps.run();
  return json({ ok: true, ...result });
}
```

`supabase/functions/notify-dispatch/store.ts`:

```ts
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ClaimedDelivery, Completion, DispatchStore } from "./dispatch.ts";

export function createDispatchStore(client: SupabaseClient): DispatchStore {
  async function rpc(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    const { data, error } = await client.rpc(name, args);
    if (error) throw new Error(`${name} failed: ${error.message}`);
    return data;
  }
  return {
    async claim(limit) {
      return (await rpc("notify_claim_deliveries", { p_limit: limit })) as ClaimedDelivery[];
    },
    async subscriptions(userId) {
      const rows = (await rpc("notify_active_subscriptions", { p_user: userId })) as {
        id: string; endpoint: string; p256dh: string; auth: string;
      }[];
      return rows.map((r) => ({ id: r.id, endpoint: r.endpoint, p256dh: r.p256dh, auth: r.auth }));
    },
    async markSubscription(id, outcome) {
      await rpc("notify_mark_subscription", { p_id: id, p_outcome: outcome });
    },
    async consumeEmailQuota(deliveryId, limit) {
      return Boolean(await rpc("notify_consume_email_quota", { p_delivery: deliveryId, p_limit: limit }));
    },
    async complete(id, c: Completion) {
      await rpc("notify_complete_delivery", {
        p_id: id, p_status: c.status, p_skip_reason: c.skipReason ?? null, p_error: c.error ?? null,
        p_message_id: c.messageId ?? null, p_retry_in_seconds: c.retryInSeconds ?? null, p_log: c.log,
      });
    },
  };
}
```

Scaffold the function (PowerShell): `bun run tools/new-function.ts notify-dispatch`, then replace `supabase/functions/notify-dispatch/index.ts`:

```ts
import { createClient } from "@supabase/supabase-js";
import { requireEnv } from "@adapters/env.ts";
import { sendEmail } from "@adapters/email.ts";
import { loadPushEnv, sendPush } from "@adapters/push.ts";
import { handleNotifyDispatch } from "./handler.ts";
import { EMAIL_DAILY_CAP, type DispatchDeps, runDispatch } from "./dispatch.ts";
import { createDispatchStore } from "./store.ts";

const client = createClient(requireEnv("SUPABASE_URL"), requireEnv("SUPABASE_SERVICE_ROLE_KEY"), {
  auth: { persistSession: false, autoRefreshToken: false },
});

const deps: DispatchDeps = {
  store: createDispatchStore(client),
  sendPush: (sub, payload, opts) => sendPush(sub, payload, opts, { env: loadPushEnv() }),
  sendEmail: (input) => sendEmail(input, { url: Deno.env.get("RESEND_API_URL") ?? "https://api.resend.com/emails" }),
  nowMs: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  siteUrl: requireEnv("SITE_URL"),
  functionsBaseUrl: Deno.env.get("FUNCTIONS_PUBLIC_URL") ?? `${requireEnv("SUPABASE_URL")}/functions/v1`,
  unsubscribeSecret: requireEnv("UNSUBSCRIBE_SECRET"),
  emailDailyCap: EMAIL_DAILY_CAP,
  // ids, channels, status classes only: never addresses, endpoints, keys or payloads
  log: (event, data) => console.log(JSON.stringify({ event, ...data })),
};

Deno.serve((req) =>
  handleNotifyDispatch(req, {
    cronSecret: Deno.env.get("CRON_SHARED_SECRET") ?? "",
    run: () => runDispatch(deps, { limit: 20, budgetMs: 100_000 }),
  }),
);
```

- [ ] **Step 11: Register the function in `config.toml` and `.env.example`**

Append to `supabase/config.toml` (next to the other function blocks):

```toml
[functions.notify-dispatch]
verify_jwt = false
```

Append to `supabase/functions/.env.example` (names only, empty values):

```text
# --- P3 notifications (function secrets; never commit values) ---
VAPID_PUBLIC_KEY=
VAPID_PRIVATE_KEY=
VAPID_SUBJECT=mailto:
RESEND_API_KEY=
EMAIL_FROM=
RESEND_WEBHOOK_SECRET=
UNSUBSCRIBE_SECRET=
# public base URL of the functions (used in List-Unsubscribe links); defaults to SUPABASE_URL/functions/v1
FUNCTIONS_PUBLIC_URL=
```

- [ ] **Step 12: Run the full function suites and guards**

Run: `bun run lint:fix` then `bun run lint`; `bun run functions:check`; `bun run functions:test`; `bun run check:functions-config`
Expected: all exit 0 (`check:functions-config` passes because `notify-dispatch` has a directory, an identical import map, an `index.ts` and a `verify_jwt = false` block).

- [ ] **Step 13: Commit**

```text
git add supabase/functions/worker-tick supabase/functions/notify-dispatch supabase/config.toml supabase/functions/.env.example
git commit -m "feat(notify): add digest stage and notify-dispatch with retries, quota and preference re-check"
```

---

### Task 5: User-facing functions `push-subscribe`, `resend-webhook` and `notify-unsubscribe`

**Concurrency:** starts after Tasks 1 and 3 are merged; may run at the same time as Task 4 (disjoint files; `supabase/config.toml` is edited in the last step of both tasks, keep both blocks on merge).

**Files:**
- Create (scaffolded, then replaced): `supabase/functions/{push-subscribe,resend-webhook,notify-unsubscribe}/{deno.json,index.ts}`
- Create: `supabase/functions/push-subscribe/handler.ts`, `handler.test.ts`, `store.ts`
- Create: `supabase/functions/resend-webhook/handler.ts`, `handler.test.ts`, `store.ts`
- Create: `supabase/functions/notify-unsubscribe/handler.ts`, `handler.test.ts`, `store.ts`
- Modify: `supabase/config.toml`

**Interfaces:**
- Consumes: Task 1 RPCs (`notify_active_subscriptions`, `notify_mark_subscription`, `notify_record_email_event`, `notify_unsubscribe`) and table `push_subscriptions`; Task 3 `isAllowedPushEndpoint`, `sendPush`, `loadPushEnv`, `verifySvix`, `hashRecipient`, `redactResendPayload`, `verifyUnsubscribeToken`, `base64UrlDecode`; P0 `json`, `corsHeaders`, `readJson`, `requireEnv`.
- Produces: HTTP contracts: `POST push-subscribe` with `Authorization: Bearer <user JWT>` and body `{ action: "subscribe", subscription: { endpoint, keys: { p256dh, auth } } }`, `{ action: "unsubscribe", endpoint }` or `{ action: "test" }`; `POST resend-webhook` (Svix headers, raw JSON body); `GET|POST notify-unsubscribe?t=<token>`.

- [ ] **Step 1: Write the failing `push-subscribe` tests**

`supabase/functions/push-subscribe/handler.test.ts`:

```ts
import { assertEquals } from "@std/assert";
import { base64UrlEncode } from "@adapters/encoding.ts";
import type { PushResult, PushTarget } from "@adapters/push.ts";
import { handlePushSubscribe, type SubscribeStore } from "./handler.ts";

const USER = "00000000-0000-0000-0000-0000000000a1";
const P256DH = base64UrlEncode(new Uint8Array([4, ...new Uint8Array(64).fill(7)]));
const AUTH = base64UrlEncode(new Uint8Array(16).fill(3));
const ENDPOINT = "https://fcm.googleapis.com/fcm/send/abc";

class FakeStore implements SubscribeStore {
  upserts: { userId: string; endpoint: string; userAgent: string | null }[] = [];
  removed: { userId: string; endpoint: string }[] = [];
  marks: { id: string; outcome: string }[] = [];
  subs: (PushTarget & { id: string })[] = [];
  full = false;
  upsert(userId: string, sub: { endpoint: string; p256dh: string; auth: string; userAgent: string | null }) {
    if (this.full) return Promise.resolve("too_many" as const);
    this.upserts.push({ userId, endpoint: sub.endpoint, userAgent: sub.userAgent });
    return Promise.resolve("ok" as const);
  }
  remove(userId: string, endpoint: string) { this.removed.push({ userId, endpoint }); return Promise.resolve(); }
  active() { return Promise.resolve(this.subs); }
  mark(id: string, outcome: "success" | "failure" | "gone") { this.marks.push({ id, outcome }); return Promise.resolve(); }
}

function setup(sendTestPush: (s: PushTarget, payload: string) => PushResult = () => ({ ok: true })) {
  const store = new FakeStore();
  const sent: { endpoint: string; payload: string }[] = [];
  const deps = {
    store,
    verifyUser: (token: string) => Promise.resolve(token === "good" ? USER : null),
    sendTestPush: (s: PushTarget, payload: string) => { sent.push({ endpoint: s.endpoint, payload }); return Promise.resolve(sendTestPush(s, payload)); },
    siteUrl: "https://screener.example.test",
    extraHosts: [] as string[],
    maxSubscriptions: 10,
    allowedOrigins: ["https://screener.example.test"],
  };
  return { store, sent, deps };
}

function post(body: unknown, token: string | null = "good", extra: Record<string, string> = {}) {
  const headers: Record<string, string> = { "content-type": "application/json", origin: "https://screener.example.test", "user-agent": "TestBrowser/1.0", ...extra };
  if (token !== null) headers.authorization = `Bearer ${token}`;
  return new Request("https://f.example/push-subscribe", { method: "POST", headers, body: JSON.stringify(body) });
}
const SUB = { action: "subscribe", subscription: { endpoint: ENDPOINT, keys: { p256dh: P256DH, auth: AUTH } } };

Deno.test("requires a verified user JWT", async () => {
  const { deps, store } = setup();
  assertEquals((await handlePushSubscribe(post(SUB, null), deps)).status, 401);
  assertEquals((await handlePushSubscribe(post(SUB, "forged"), deps)).status, 401);
  assertEquals(store.upserts.length, 0);
});

Deno.test("subscribe stores the subscription for the JWT user, never for a user id in the body", async () => {
  const { deps, store } = setup();
  const res = await handlePushSubscribe(post({ ...SUB, userId: "00000000-0000-0000-0000-0000000000b2" }), deps);
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { ok: true });
  assertEquals(store.upserts, [{ userId: USER, endpoint: ENDPOINT, userAgent: "TestBrowser/1.0" }]);
});

Deno.test("subscribe validates the endpoint allow-list, key sizes and the per-user cap", async () => {
  const { deps, store } = setup();
  const bad = (sub: unknown) => handlePushSubscribe(post({ action: "subscribe", subscription: sub }), deps);
  assertEquals((await bad({ endpoint: "http://fcm.googleapis.com/x", keys: { p256dh: P256DH, auth: AUTH } })).status, 400);
  assertEquals((await bad({ endpoint: "https://169.254.169.254/latest", keys: { p256dh: P256DH, auth: AUTH } })).status, 400);
  assertEquals((await bad({ endpoint: ENDPOINT, keys: { p256dh: "AAAA", auth: AUTH } })).status, 400);
  assertEquals((await bad({ endpoint: ENDPOINT, keys: { p256dh: P256DH, auth: "AAAA" } })).status, 400);
  assertEquals((await bad({ endpoint: ENDPOINT })).status, 400);
  assertEquals(store.upserts.length, 0);
  store.full = true;
  assertEquals((await handlePushSubscribe(post(SUB), deps)).status, 409);
});

Deno.test("unsubscribe removes only the caller's row for that endpoint and is idempotent", async () => {
  const { deps, store } = setup();
  const body = { action: "unsubscribe", endpoint: ENDPOINT };
  assertEquals((await handlePushSubscribe(post(body), deps)).status, 200);
  assertEquals((await handlePushSubscribe(post(body), deps)).status, 200);
  assertEquals(store.removed, [{ userId: USER, endpoint: ENDPOINT }, { userId: USER, endpoint: ENDPOINT }]);
});

Deno.test("test sends one fixed payload to the caller's active subscriptions and records the outcome", async () => {
  const { deps, store, sent } = setup((s) => (s.endpoint.endsWith("/dead") ? { ok: false, kind: "gone", status: 410 } : { ok: true }));
  store.subs = [
    { id: "s1", endpoint: "https://fcm.googleapis.com/fcm/send/live", p256dh: "k", auth: "a" },
    { id: "s2", endpoint: "https://fcm.googleapis.com/fcm/send/dead", p256dh: "k", auth: "a" },
  ];
  const res = await handlePushSubscribe(post({ action: "test" }), deps);
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { ok: true, sent: 1, failed: 1 });
  assertEquals(store.marks, [{ id: "s1", outcome: "success" }, { id: "s2", outcome: "gone" }]);
  const payload = JSON.parse(sent[0]?.payload ?? "{}");
  assertEquals(payload, { title: "Test notification", body: "Push is working on this device.", url: "https://screener.example.test/profile/notifications", tag: "test" });
});

Deno.test("test without a subscription is a 409, unknown actions and methods are rejected", async () => {
  const { deps } = setup();
  assertEquals((await handlePushSubscribe(post({ action: "test" }), deps)).status, 409);
  assertEquals((await handlePushSubscribe(post({ action: "nope" }), deps)).status, 400);
  assertEquals((await handlePushSubscribe(new Request("https://f.example/", { method: "GET" }), deps)).status, 405);
});

Deno.test("CORS preflight answers 204 and echoes only the configured origin", async () => {
  const { deps } = setup();
  const ok = await handlePushSubscribe(new Request("https://f.example/", { method: "OPTIONS", headers: { origin: "https://screener.example.test" } }), deps);
  assertEquals(ok.status, 204);
  assertEquals(ok.headers.get("access-control-allow-origin"), "https://screener.example.test");
  const other = await handlePushSubscribe(new Request("https://f.example/", { method: "OPTIONS", headers: { origin: "https://evil.example" } }), deps);
  assertEquals(other.headers.get("access-control-allow-origin"), null);
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `deno test --config supabase/functions/deno.json supabase/functions/push-subscribe/handler.test.ts`
Expected: FAIL, module `./handler.ts` not found.

- [ ] **Step 3: Implement `push-subscribe/handler.ts`, `store.ts` and `index.ts`**

`supabase/functions/push-subscribe/handler.ts`:

```ts
import { base64UrlDecode } from "@adapters/encoding.ts";
import { corsHeaders, json, readJson } from "@adapters/http.ts";
import { isAllowedPushEndpoint, type PushResult, type PushTarget } from "@adapters/push.ts";

export interface SubscribeStore {
  upsert(
    userId: string,
    sub: { endpoint: string; p256dh: string; auth: string; userAgent: string | null },
  ): Promise<"ok" | "too_many">;
  remove(userId: string, endpoint: string): Promise<void>;
  active(userId: string): Promise<(PushTarget & { id: string })[]>;
  mark(id: string, outcome: "success" | "failure" | "gone"): Promise<void>;
}

export interface PushSubscribeDeps {
  store: SubscribeStore;
  /** verifies the bearer JWT (getClaims against the project JWKS) and returns the user id, or null */
  verifyUser(token: string): Promise<string | null>;
  sendTestPush(sub: PushTarget, payloadJson: string): Promise<PushResult>;
  siteUrl: string;
  extraHosts: string[];
  maxSubscriptions: number;
  allowedOrigins: string[];
}

type Parsed = { endpoint: string; p256dh: string; auth: string } | "invalid_endpoint" | "invalid_keys";

function parseSubscription(value: unknown, extraHosts: string[]): Parsed {
  const sub = value as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } } | null;
  const endpoint = sub?.endpoint;
  if (typeof endpoint !== "string" || endpoint.length > 2048 || !isAllowedPushEndpoint(endpoint, extraHosts)) {
    return "invalid_endpoint";
  }
  const p256dh = sub?.keys?.p256dh;
  const auth = sub?.keys?.auth;
  if (typeof p256dh !== "string" || typeof auth !== "string") return "invalid_keys";
  try {
    const key = base64UrlDecode(p256dh);
    if (key.length !== 65 || key[0] !== 4) return "invalid_keys";
    if (base64UrlDecode(auth).length !== 16) return "invalid_keys";
  } catch {
    return "invalid_keys";
  }
  return { endpoint, p256dh, auth };
}

export async function handlePushSubscribe(req: Request, deps: PushSubscribeDeps): Promise<Response> {
  const cors = corsHeaders(req.headers.get("origin"), deps.allowedOrigins);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, { status: 405, headers: { ...cors, allow: "POST, OPTIONS" } });
  const reply = (body: unknown, status = 200) => json(body, { status, headers: cors });

  const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.get("authorization") ?? "")?.[1];
  const userId = bearer === undefined ? null : await deps.verifyUser(bearer.trim());
  if (userId === null) return reply({ error: "unauthorized" }, 401);

  const body = await readJson(req, 8_000);
  if (!body.ok) return reply(await body.response.json(), body.response.status);
  const input = body.value as { action?: unknown; subscription?: unknown; endpoint?: unknown } | null;

  switch (input?.action) {
    case "subscribe": {
      const parsed = parseSubscription(input.subscription, deps.extraHosts);
      if (typeof parsed === "string") return reply({ error: parsed }, 400);
      const userAgent = (req.headers.get("user-agent") ?? "").slice(0, 200) || null;
      const result = await deps.store.upsert(userId, { ...parsed, userAgent });
      return result === "too_many" ? reply({ error: "too_many_subscriptions" }, 409) : reply({ ok: true });
    }
    case "unsubscribe": {
      if (typeof input.endpoint !== "string" || input.endpoint.length > 2048) return reply({ error: "invalid_endpoint" }, 400);
      await deps.store.remove(userId, input.endpoint);
      return reply({ ok: true });
    }
    case "test": {
      const subs = await deps.store.active(userId);
      if (subs.length === 0) return reply({ error: "no_subscription" }, 409);
      const payload = JSON.stringify({
        title: "Test notification",
        body: "Push is working on this device.",
        url: `${deps.siteUrl.replace(/\/+$/, "")}/profile/notifications`,
        tag: "test",
      });
      let sent = 0;
      let failed = 0;
      for (const sub of subs) {
        const result = await deps.sendTestPush({ endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth }, payload);
        if (result.ok) {
          sent++;
          await deps.store.mark(sub.id, "success");
        } else {
          failed++;
          await deps.store.mark(sub.id, result.kind === "gone" ? "gone" : "failure");
        }
      }
      return reply({ ok: true, sent, failed });
    }
    default:
      return reply({ error: "unknown_action" }, 400);
  }
}
```

`supabase/functions/push-subscribe/store.ts`:

```ts
import type { SupabaseClient } from "@supabase/supabase-js";
import type { SubscribeStore } from "./handler.ts";

export function createSubscribeStore(client: SupabaseClient, maxSubscriptions: number): SubscribeStore {
  return {
    async upsert(userId, sub) {
      const { count, error: countError } = await client
        .from("push_subscriptions")
        .select("id", { count: "exact", head: true })
        .eq("user_id", userId)
        .is("revoked_at", null)
        .neq("endpoint", sub.endpoint);
      if (countError) throw new Error(`subscription count failed: ${countError.message}`);
      if ((count ?? 0) >= maxSubscriptions) return "too_many";
      // onConflict endpoint: a browser that switches account takes the row over; a revoked row is revived
      const { error } = await client.from("push_subscriptions").upsert(
        {
          user_id: userId, endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth, user_agent: sub.userAgent,
          revoked_at: null, revoke_reason: null, failure_count: 0,
        },
        { onConflict: "endpoint" },
      );
      if (error) throw new Error(`subscription upsert failed: ${error.message}`);
      return "ok";
    },
    async remove(userId, endpoint) {
      const { error } = await client.from("push_subscriptions").delete().eq("user_id", userId).eq("endpoint", endpoint);
      if (error) throw new Error(`subscription delete failed: ${error.message}`);
    },
    async active(userId) {
      const { data, error } = await client.rpc("notify_active_subscriptions", { p_user: userId });
      if (error) throw new Error(`notify_active_subscriptions failed: ${error.message}`);
      return (data as { id: string; endpoint: string; p256dh: string; auth: string }[]).map((r) => ({
        id: r.id, endpoint: r.endpoint, p256dh: r.p256dh, auth: r.auth,
      }));
    },
    async mark(id, outcome) {
      const { error } = await client.rpc("notify_mark_subscription", { p_id: id, p_outcome: outcome });
      if (error) throw new Error(`notify_mark_subscription failed: ${error.message}`);
    },
  };
}
```

Scaffold (PowerShell): `bun run tools/new-function.ts push-subscribe`, then replace `supabase/functions/push-subscribe/index.ts`:

```ts
import { createClient } from "@supabase/supabase-js";
import { allowedOriginsFromEnv } from "@adapters/http.ts";
import { requireEnv } from "@adapters/env.ts";
import { loadPushEnv, sendPush } from "@adapters/push.ts";
import { handlePushSubscribe } from "./handler.ts";
import { createSubscribeStore } from "./store.ts";

const MAX_SUBSCRIPTIONS = 10;
const url = requireEnv("SUPABASE_URL");
const options = { auth: { persistSession: false, autoRefreshToken: false } };
const admin = createClient(url, requireEnv("SUPABASE_SERVICE_ROLE_KEY"), options);
const anon = createClient(url, requireEnv("SUPABASE_ANON_KEY"), options);

// Spec 11.5 / A-07: verify_jwt is false; the JWT is verified here against the project JWKS.
async function verifyUser(token: string): Promise<string | null> {
  const { data, error } = await anon.auth.getClaims(token);
  if (error || data === null) return null;
  const claims = data.claims;
  return claims.role === "authenticated" && typeof claims.sub === "string" ? claims.sub : null;
}

const extraHosts = (Deno.env.get("PUSH_ENDPOINT_EXTRA_HOSTS") ?? "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);

Deno.serve((req) =>
  handlePushSubscribe(req, {
    store: createSubscribeStore(admin, MAX_SUBSCRIPTIONS),
    verifyUser,
    sendTestPush: (sub, payload) => sendPush(sub, payload, { ttlSeconds: 300, topic: "test", urgency: "normal" }, { env: loadPushEnv() }),
    siteUrl: requireEnv("SITE_URL"),
    extraHosts,
    maxSubscriptions: MAX_SUBSCRIPTIONS,
    allowedOrigins: allowedOriginsFromEnv(),
  }),
);
```

Run: `deno test --config supabase/functions/deno.json supabase/functions/push-subscribe/handler.test.ts`
Expected: 7 tests pass.

- [ ] **Step 4: Write the failing `resend-webhook` tests**

`supabase/functions/resend-webhook/handler.test.ts`:

```ts
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { base64Encode } from "@adapters/encoding.ts";
import { handleResendWebhook, type RecordArgs } from "./handler.ts";

const SECRET_BYTES = new Uint8Array(24).map((_, i) => (i * 11 + 5) & 255);
const SECRET = `whsec_${base64Encode(SECRET_BYTES)}`;
const NOW = Date.parse("2026-10-15T10:00:00Z");

async function signed(body: string, over: { id?: string; ts?: number; secret?: Uint8Array } = {}): Promise<Request> {
  const id = over.id ?? "msg_1";
  const ts = String(over.ts ?? Math.floor(NOW / 1000));
  const key = await crypto.subtle.importKey("raw", over.secret ?? SECRET_BYTES, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = base64Encode(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${ts}.${body}`))));
  return new Request("https://f.example/resend-webhook", {
    method: "POST",
    headers: { "svix-id": id, "svix-timestamp": ts, "svix-signature": `v1,${mac}`, "content-type": "application/json" },
    body,
  });
}

function setup() {
  const seen = new Set<string>();
  const recorded: RecordArgs[] = [];
  const deps = {
    secret: SECRET,
    hashSalt: "salt",
    nowMs: () => NOW,
    record: (args: RecordArgs) => {
      if (seen.has(args.svixId)) return Promise.resolve("duplicate" as const);
      seen.add(args.svixId);
      recorded.push(args);
      return Promise.resolve("recorded" as const);
    },
  };
  return { deps, recorded };
}

const BOUNCE = JSON.stringify({
  type: "email.bounced",
  created_at: "2026-10-15T09:59:00Z",
  data: { email_id: "em_1", from: "Screener <alerts@updates.example.test>", to: ["user@example.test"], subject: "Today's discounts", bounce: { type: "Permanent", message: "mailbox user@example.test does not exist" } },
});

Deno.test("an invalid signature is rejected with 401 and nothing is stored", async () => {
  const { deps, recorded } = setup();
  const res = await handleResendWebhook(await signed(BOUNCE, { secret: new Uint8Array(24).fill(1) }), deps);
  assertEquals(res.status, 401);
  assertEquals(recorded.length, 0);
});

Deno.test("a tampered body, missing headers and a stale timestamp are rejected", async () => {
  const { deps, recorded } = setup();
  const good = await signed(BOUNCE);
  const tampered = new Request(good.url, { method: "POST", headers: good.headers, body: BOUNCE.replace("bounced", "delivered") });
  assertEquals((await handleResendWebhook(tampered, deps)).status, 401);
  assertEquals((await handleResendWebhook(new Request("https://f.example/", { method: "POST", body: BOUNCE }), deps)).status, 401);
  assertEquals((await handleResendWebhook(await signed(BOUNCE, { ts: Math.floor(NOW / 1000) - 600 }), deps)).status, 401);
  assertEquals(recorded.length, 0);
});

Deno.test("a valid event is recorded with a hashed recipient and a payload that has no address or subject", async () => {
  const { deps, recorded } = setup();
  const res = await handleResendWebhook(await signed(BOUNCE), deps);
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { status: "recorded" });
  const call = recorded[0];
  assert(call);
  assertEquals([call.svixId, call.type, call.emailId], ["msg_1", "email.bounced", "em_1"]);
  assert(/^[0-9a-f]{64}$/.test(call.recipientHash ?? ""));
  const stored = JSON.stringify(call.payload);
  assertEquals(stored.includes("@"), false);
  assertEquals(stored.includes("Today's discounts"), false);
  assertStringIncludes(stored, "Permanent");
});

Deno.test("a replayed svix id (validly signed) changes nothing", async () => {
  const { deps, recorded } = setup();
  assertEquals((await (await handleResendWebhook(await signed(BOUNCE), deps)).json()).status, "recorded");
  const again = await handleResendWebhook(await signed(BOUNCE), deps);
  assertEquals(again.status, 200);
  assertEquals((await again.json()).status, "duplicate");
  assertEquals(recorded.length, 1);
});

Deno.test("event types the dispatcher does not use are acknowledged but not stored", async () => {
  const { deps, recorded } = setup();
  const res = await handleResendWebhook(await signed(JSON.stringify({ type: "email.opened", data: { email_id: "em_2" } }), { id: "msg_2" }), deps);
  assertEquals(res.status, 200);
  assertEquals((await res.json()).status, "ignored");
  assertEquals(recorded.length, 0);
});

Deno.test("malformed JSON after a valid signature is 400, other methods are 405", async () => {
  const { deps } = setup();
  assertEquals((await handleResendWebhook(await signed("not json"), deps)).status, 400);
  assertEquals((await handleResendWebhook(new Request("https://f.example/", { method: "GET" }), deps)).status, 405);
});
```

- [ ] **Step 5: Implement `resend-webhook`**

`supabase/functions/resend-webhook/handler.ts`:

```ts
import { hashRecipient, redactResendPayload, verifySvix } from "@adapters/email.ts";
import { json } from "@adapters/http.ts";

export interface RecordArgs {
  svixId: string;
  type: string;
  emailId: string | null;
  recipientHash: string | null;
  payload: unknown;
}

export interface WebhookDeps {
  secret: string;
  hashSalt: string;
  nowMs(): number;
  /** atomic and idempotent by svix id: the SQL function also applies the delivery and preference effects */
  record(args: RecordArgs): Promise<"duplicate" | "recorded">;
}

const HANDLED = new Set([
  "email.sent", "email.delivered", "email.delivery_delayed", "email.bounced", "email.complained", "email.failed", "email.suppressed",
]);
const MAX_BODY_BYTES = 256_000;

export async function handleResendWebhook(req: Request, deps: WebhookDeps): Promise<Response> {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, { status: 405, headers: { allow: "POST" } });
  const raw = await req.text(); // the signature covers the raw body: never re-serialise before verifying
  if (raw.length > MAX_BODY_BYTES) return json({ error: "payload_too_large" }, { status: 413 });
  if (!(await verifySvix(req.headers, raw, deps.secret, { nowMs: deps.nowMs() }))) {
    return json({ error: "invalid_signature" }, { status: 401 });
  }
  let event: { type?: unknown; data?: { email_id?: unknown; to?: unknown } };
  try {
    event = JSON.parse(raw);
  } catch {
    return json({ error: "invalid_json" }, { status: 400 });
  }
  if (typeof event.type !== "string" || !HANDLED.has(event.type)) return json({ status: "ignored" });
  const toList: unknown = event.data?.to;
  const to: unknown = Array.isArray(toList) ? toList[0] : undefined;
  const status = await deps.record({
    svixId: req.headers.get("svix-id") ?? "",
    type: event.type,
    emailId: typeof event.data?.email_id === "string" ? event.data.email_id : null,
    recipientHash: typeof to === "string" ? await hashRecipient(to, deps.hashSalt) : null,
    payload: redactResendPayload(event),
  });
  return json({ status });
}
```

`supabase/functions/resend-webhook/store.ts`:

```ts
import type { SupabaseClient } from "@supabase/supabase-js";
import type { RecordArgs } from "./handler.ts";

export function createWebhookStore(client: SupabaseClient) {
  return async (a: RecordArgs): Promise<"duplicate" | "recorded"> => {
    const { data, error } = await client.rpc("notify_record_email_event", {
      p_svix_id: a.svixId, p_type: a.type, p_email_id: a.emailId, p_recipient_hash: a.recipientHash, p_payload: a.payload,
    });
    if (error) throw new Error(`notify_record_email_event failed: ${error.message}`);
    return data === "duplicate" ? "duplicate" : "recorded";
  };
}
```

Scaffold: `bun run tools/new-function.ts resend-webhook`, then `supabase/functions/resend-webhook/index.ts`:

```ts
import { createClient } from "@supabase/supabase-js";
import { requireEnv } from "@adapters/env.ts";
import { handleResendWebhook } from "./handler.ts";
import { createWebhookStore } from "./store.ts";

const client = createClient(requireEnv("SUPABASE_URL"), requireEnv("SUPABASE_SERVICE_ROLE_KEY"), {
  auth: { persistSession: false, autoRefreshToken: false },
});
const record = createWebhookStore(client);

Deno.serve((req) =>
  handleResendWebhook(req, {
    secret: requireEnv("RESEND_WEBHOOK_SECRET"),
    hashSalt: requireEnv("UNSUBSCRIBE_SECRET"),
    nowMs: () => Date.now(),
    record,
  }),
);
```

Run: `deno test --config supabase/functions/deno.json supabase/functions/resend-webhook/handler.test.ts`
Expected: 6 tests pass.

- [ ] **Step 6: Write the failing `notify-unsubscribe` tests**

`supabase/functions/notify-unsubscribe/handler.test.ts`:

```ts
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { makeUnsubscribeToken } from "@adapters/unsubscribe-token.ts";
import { handleUnsubscribe } from "./handler.ts";

const USER = "00000000-0000-0000-0000-0000000000a1";
const SECRET = "unsub-secret";

function setup() {
  const calls: string[] = [];
  return { calls, deps: { secret: SECRET, unsubscribe: (id: string) => { calls.push(id); return Promise.resolve(); } } };
}
const url = (token: string) => `https://f.example/notify-unsubscribe?t=${encodeURIComponent(token)}`;

Deno.test("GET shows a confirmation page with a POST form and changes nothing (link scanners prefetch)", async () => {
  const { deps, calls } = setup();
  const res = await handleUnsubscribe(new Request(url(await makeUnsubscribeToken(USER, SECRET))), deps);
  assertEquals(res.status, 200);
  assertStringIncludes(res.headers.get("content-type") ?? "", "text/html");
  assertStringIncludes(res.headers.get("cache-control") ?? "", "no-store");
  assertEquals(res.headers.get("referrer-policy"), "no-referrer");
  const html = await res.text();
  assertStringIncludes(html, '<form method="post"');
  assertStringIncludes(html, "Unsubscribe");
  assertEquals(calls.length, 0);
});

Deno.test("POST (one-click or the button) unsubscribes the token's user and is idempotent", async () => {
  const { deps, calls } = setup();
  const token = await makeUnsubscribeToken(USER, SECRET);
  const oneClick = new Request(url(token), { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "List-Unsubscribe=One-Click" });
  assertEquals((await handleUnsubscribe(oneClick, deps)).status, 200);
  assertEquals((await handleUnsubscribe(new Request(url(token), { method: "POST" }), deps)).status, 200);
  assertEquals(calls, [USER, USER]);
});

Deno.test("a tampered, swapped, wrongly signed or missing token is rejected and nothing changes", async () => {
  const { deps, calls } = setup();
  const good = await makeUnsubscribeToken(USER, SECRET);
  const mac = good.split(".")[1] ?? "";
  const bad = [
    `00000000-0000-0000-0000-0000000000b2.${mac}`,
    `${USER}.${mac.slice(0, -1)}A`,
    await makeUnsubscribeToken(USER, "other-secret"),
    "garbage",
    "",
  ];
  for (const token of bad) {
    for (const method of ["GET", "POST"]) {
      const res = await handleUnsubscribe(new Request(url(token), { method }), deps);
      assertEquals(res.status, 400, `${method} ${token}`);
    }
  }
  assertEquals((await handleUnsubscribe(new Request("https://f.example/notify-unsubscribe", { method: "POST" }), deps)).status, 400);
  assertEquals(calls.length, 0);
});

Deno.test("other methods are 405 and the page never reflects unverified input", async () => {
  const { deps } = setup();
  assertEquals((await handleUnsubscribe(new Request(url("x"), { method: "PUT" }), deps)).status, 405);
  const res = await handleUnsubscribe(new Request(url('"><script>alert(1)</script>')), deps);
  assert(!(await res.text()).includes("<script>"));
});
```

- [ ] **Step 7: Implement `notify-unsubscribe`**

`supabase/functions/notify-unsubscribe/handler.ts`:

```ts
import { verifyUnsubscribeToken } from "@adapters/unsubscribe-token.ts";

export interface UnsubscribeDeps {
  secret: string;
  /** public.notify_unsubscribe: idempotent, audited as notify.unsubscribe */
  unsubscribe(userId: string): Promise<void>;
}

const PAGE_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'",
};

function page(title: string, body: string, status = 200): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem;line-height:1.5}button{font:inherit;padding:.6rem 1rem}</style></head><body><main><h1>${title}</h1>${body}</main></body></html>`;
  return new Response(html, { status, headers: PAGE_HEADERS });
}

export async function handleUnsubscribe(req: Request, deps: UnsubscribeDeps): Promise<Response> {
  if (req.method !== "GET" && req.method !== "POST") {
    return new Response("method not allowed", { status: 405, headers: { allow: "GET, POST" } });
  }
  const token = new URL(req.url).searchParams.get("t") ?? "";
  const userId = await verifyUnsubscribeToken(token, deps.secret);
  if (userId === null) return page("Link not valid", "<p>This unsubscribe link is not valid. Open Stock Screener, then Profile, then Notifications to change your email settings.</p>", 400);
  if (req.method === "GET") {
    // Verified tokens contain only [0-9a-f.-] and base64url characters, so echoing one is safe.
    return page(
      "Unsubscribe from emails",
      `<p>Stop all Stock Screener emails to this address?</p><form method="post" action="?t=${token}"><button type="submit">Unsubscribe from emails</button></form>`,
    );
  }
  await deps.unsubscribe(userId);
  return page("You are unsubscribed", "<p>You will not receive further emails. You can turn email notifications on again from Profile, then Notifications, after signing in.</p>");
}
```

`supabase/functions/notify-unsubscribe/store.ts`:

```ts
import type { SupabaseClient } from "@supabase/supabase-js";

export function createUnsubscribeStore(client: SupabaseClient) {
  return async (userId: string): Promise<void> => {
    const { error } = await client.rpc("notify_unsubscribe", { p_user: userId });
    if (error) throw new Error(`notify_unsubscribe failed: ${error.message}`);
  };
}
```

Scaffold: `bun run tools/new-function.ts notify-unsubscribe`, then `supabase/functions/notify-unsubscribe/index.ts`:

```ts
import { createClient } from "@supabase/supabase-js";
import { requireEnv } from "@adapters/env.ts";
import { handleUnsubscribe } from "./handler.ts";
import { createUnsubscribeStore } from "./store.ts";

const client = createClient(requireEnv("SUPABASE_URL"), requireEnv("SUPABASE_SERVICE_ROLE_KEY"), {
  auth: { persistSession: false, autoRefreshToken: false },
});

Deno.serve((req) =>
  handleUnsubscribe(req, { secret: requireEnv("UNSUBSCRIBE_SECRET"), unsubscribe: createUnsubscribeStore(client) }),
);
```

Run: `deno test --config supabase/functions/deno.json supabase/functions/notify-unsubscribe/handler.test.ts`
Expected: 4 tests pass. (Whether the hosted `supabase.co` domain serves `text/html` as HTML is UNVERIFIED, plan decision 14; the one-click POST needs no HTML. Task 7 records the manual check and the fallback.)

- [ ] **Step 8: Register the three functions and run all guards**

Append to `supabase/config.toml`:

```toml
[functions.push-subscribe]
verify_jwt = false

[functions.resend-webhook]
verify_jwt = false

[functions.notify-unsubscribe]
verify_jwt = false
```

Run: `bun run lint:fix` then `bun run lint`; `bun run functions:check`; `bun run functions:test`; `bun run check:functions-config`
Expected: all exit 0.

- [ ] **Step 9: Commit**

```text
git add supabase/functions/push-subscribe supabase/functions/resend-webhook supabase/functions/notify-unsubscribe supabase/config.toml
git commit -m "feat(notify): add push-subscribe, resend-webhook and notify-unsubscribe functions"
```

---

### Task 6: Web - service-worker push handling and Profile -> Notifications

**Concurrency:** starts after Task 5 is merged; no other task touches these files. Steps 1 to 8 (pure modules and the service worker) are independent of the P5a router wiring; Step 12 edits the single P5a placeholder file and one assertion.

**REQUIRED before Step 9 (components):** the implementer MUST load the `frontend-design:frontend-design` and `ui-ux-pro-max:ui-ux-pro-max` skills (Skill tool). The code below is a complete, working baseline; the skills may refine spacing, hierarchy and copy styling. Fixed constraints: keep every heading, label, button name and sentence used by the tests; shadcn components and P0 tokens only; state is never colour-only (always text); usable at phone width; iOS guidance sentence verbatim.

**Files:**
- Modify: `apps/web/src/sw-routes.ts`, `apps/web/src/sw-routes.test.ts`, `apps/web/src/sw.ts`, `apps/web/src/register-sw.ts`
- Create: `apps/web/src/lib/vapid-key.ts`, `apps/web/src/lib/vapid-key.test.ts`, `apps/web/src/sw-push.ts`, `apps/web/src/sw-push.test.ts`
- Create: `apps/web/src/features/notifications/{copy.ts,push-support.ts,push-support.test.ts,push-client.ts,push-client.test.ts,notifications-api.ts,notifications-api.test.ts,notifications-context.tsx,use-notification-preferences.ts,sw-messages.ts,sw-messages.test.ts,notifications-view.tsx,notifications-view.test.tsx}`
- Create: `apps/web/src/features/notifications/components/{web-push-card.tsx,email-card.tsx,digest-preferences-card.tsx}`
- Modify: `apps/web/src/features/profile/panels/notifications-panel.tsx` (P5a placeholder) and, if it asserts the placeholder text, one assertion in `apps/web/src/features/profile/profile-panels.test.tsx`
- Modify: `apps/web/.env.example` (document `VITE_VAPID_PUBLIC_KEY`, already listed by spec 3.11)

**Interfaces:**
- Consumes: P0 `sw-routes.ts` (`parsePushPayload`, `resolveNotificationUrl`), `sw.ts`, `register-sw.ts`; shadcn `card`, `button`, `switch`, `label`, `badge`, `skeleton` from `@/components/ui`; TanStack Query (`QueryClient` provided by `AppProviders`); P5a `useAuth()` (only in the panel) and `@/lib/supabase`; Task 5 `push-subscribe` contract.
- Produces: `PushPayload.tag?`, `resubscribeAndBroadcast`, `urlBase64ToUint8Array`; `detectPushSupport`, `readSupportEnv`, `usePushSupport()`; `enablePush`, `disablePush`, `reconcilePush`, `BrowserPush`; `createNotificationsApi`, `NotificationsApi`; `useNotificationPreferences()`; `NotificationsView`; the real `NotificationsPanel`.

- [ ] **Step 1: Extend the payload parser with the optional `tag` (tests first)**

Append to `apps/web/src/sw-routes.test.ts` inside the `parsePushPayload` describe block:

```ts
  it("keeps a short tag so a newer digest replaces the older notification, and omits it otherwise", () => {
    expect(parsePushPayload('{"title":"t","body":"b","url":"/","tag":"digest-discounts"}')).toEqual({
      title: "t",
      body: "b",
      url: "/",
      tag: "digest-discounts",
    });
    expect("tag" in parsePushPayload('{"title":"t","body":"b"}')).toBe(false);
    expect("tag" in parsePushPayload('{"tag":42}')).toBe(false);
    expect(parsePushPayload(JSON.stringify({ tag: "x".repeat(200) })).tag?.length).toBe(64);
  });
```

Run: `bun run test:web -- sw-routes`
Expected: the new test FAILS (`tag` is not returned); the existing parser tests still pass.

In `apps/web/src/sw-routes.ts` change the interface and the JSON branch of `parsePushPayload`:

```ts
export interface PushPayload {
  title: string;
  body: string;
  url: string;
  tag?: string;
}
```

```ts
      const record = data as Record<string, unknown>;
      const tag = cleanString(record.tag, 64);
      return {
        title: cleanString(record.title, 100) ?? fallback.title,
        body: cleanString(record.body, 300) ?? fallback.body,
        url: cleanString(record.url, 500) ?? fallback.url,
        ...(tag === null ? {} : { tag }),
      };
```

Run: `bun run test:web -- sw-routes`
Expected: all pass.

- [ ] **Step 2: VAPID key helper (shared by the page and the service worker)**

`apps/web/src/lib/vapid-key.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { urlBase64ToUint8Array } from "./vapid-key";

describe("urlBase64ToUint8Array", () => {
  it("decodes url-safe base64 without padding", () => {
    expect([...urlBase64ToUint8Array("AQID")]).toEqual([1, 2, 3]);
    expect([...urlBase64ToUint8Array("-_8")]).toEqual([251, 255]);
  });
  it("round trips a 65 byte application server key", () => {
    const bytes = new Uint8Array([4, ...Array.from({ length: 64 }, (_, i) => i * 3)]);
    const text = btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
    expect(urlBase64ToUint8Array(text)).toEqual(bytes);
  });
  it("throws on characters outside the alphabet", () => {
    expect(() => urlBase64ToUint8Array("***")).toThrow();
  });
});
```

`apps/web/src/lib/vapid-key.ts`:

```ts
/** Decodes the base64url VAPID public key into the bytes `pushManager.subscribe` expects. */
export function urlBase64ToUint8Array(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*={0,2}$/.test(value)) throw new Error("invalid base64url");
  const standard = value.replace(/=+$/, "").replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(standard + "=".repeat((4 - (standard.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
```

Run: `bun run test:web -- vapid-key`
Expected: 3 tests pass.

- [ ] **Step 3: Service-worker re-subscribe logic (pure, tested) and its wiring**

The service worker has no access to the user's session (it lives in the page's `localStorage`), so on `pushsubscriptionchange` it re-subscribes and tells open pages to POST the new subscription to `push-subscribe` with their JWT; if no page is open, the Notifications page reconciles on the next visit (spec 10.4, behaviour of the event is UNVERIFIED on some browsers).

`apps/web/src/sw-push.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { resubscribeAndBroadcast, SUBSCRIPTION_CHANGED } from "./sw-push";

const json = (endpoint: string): PushSubscriptionJSON => ({ endpoint, keys: { p256dh: "k", auth: "a" } });

describe("resubscribeAndBroadcast", () => {
  it("broadcasts the browser-provided new subscription without subscribing again", async () => {
    const subscribe = vi.fn();
    const broadcast = vi.fn().mockResolvedValue(undefined);
    const ok = await resubscribeAndBroadcast({ newSubscription: { toJSON: () => json("https://new") }, subscribe, broadcast });
    expect(ok).toBe(true);
    expect(subscribe).not.toHaveBeenCalled();
    expect(broadcast).toHaveBeenCalledWith({ type: SUBSCRIPTION_CHANGED, subscription: json("https://new") });
  });

  it("subscribes itself when the event carries no new subscription", async () => {
    const subscribe = vi.fn().mockResolvedValue({ toJSON: () => json("https://made") });
    const broadcast = vi.fn().mockResolvedValue(undefined);
    expect(await resubscribeAndBroadcast({ newSubscription: null, subscribe, broadcast })).toBe(true);
    expect(broadcast).toHaveBeenCalledWith({ type: SUBSCRIPTION_CHANGED, subscription: json("https://made") });
  });

  it("returns false and broadcasts nothing when subscribing fails", async () => {
    const broadcast = vi.fn();
    const ok = await resubscribeAndBroadcast({ newSubscription: null, subscribe: () => Promise.reject(new Error("denied")), broadcast });
    expect(ok).toBe(false);
    expect(broadcast).not.toHaveBeenCalled();
  });
});
```

`apps/web/src/sw-push.ts`:

```ts
export const SUBSCRIPTION_CHANGED = "PUSH_SUBSCRIPTION_CHANGED";

export interface SubscriptionLike {
  toJSON(): PushSubscriptionJSON;
}
export interface SubscriptionChangedMessage {
  type: typeof SUBSCRIPTION_CHANGED;
  subscription: PushSubscriptionJSON;
}

export async function resubscribeAndBroadcast(deps: {
  newSubscription: SubscriptionLike | null;
  subscribe(): Promise<SubscriptionLike>;
  broadcast(message: SubscriptionChangedMessage): Promise<void>;
}): Promise<boolean> {
  try {
    const subscription = deps.newSubscription ?? (await deps.subscribe());
    await deps.broadcast({ type: SUBSCRIPTION_CHANGED, subscription: subscription.toJSON() });
    return true;
  } catch {
    return false;
  }
}
```

Run: `bun run test:web -- sw-push`
Expected: 3 tests pass.

In `apps/web/src/sw.ts` add the imports `import { resubscribeAndBroadcast } from "./sw-push";` and `import { urlBase64ToUint8Array } from "./lib/vapid-key";`, pass the tag to the notification, and add the new listener. Replace the body of the `push` listener's `showNotification` call and append the listener:

```ts
  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      data: { url: payload.url },
      ...(payload.tag === undefined ? {} : { tag: payload.tag }),
    }),
  );
```

```ts
// 7. Subscription rotation. The SW cannot authenticate, so it re-subscribes and hands the new
//    subscription to open pages (features/notifications/sw-messages.ts POSTs it to push-subscribe).
interface SubscriptionChangeEvent extends ExtendableEvent {
  newSubscription?: PushSubscription | null;
}
self.addEventListener("pushsubscriptionchange", (event) => {
  const change = event as SubscriptionChangeEvent;
  const key = (import.meta.env as Record<string, string | undefined>).VITE_VAPID_PUBLIC_KEY;
  change.waitUntil(
    resubscribeAndBroadcast({
      newSubscription: change.newSubscription ?? null,
      subscribe: () => {
        if (!key) return Promise.reject(new Error("VITE_VAPID_PUBLIC_KEY is not set"));
        return self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(key) });
      },
      broadcast: async (message) => {
        const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
        for (const client of windows) client.postMessage(message);
      },
    }),
  );
});
```

The existing `notificationclick` handler (focus an open window or open one, same-origin only through `resolveNotificationUrl`) is kept unchanged; the fallback notification for a malformed payload already lives in `parsePushPayload`.

- [ ] **Step 4: Page side of the subscription-change message (tests first)**

`apps/web/src/features/notifications/sw-messages.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { SUBSCRIPTION_CHANGED } from "@/sw-push";
import { attachSubscriptionChangeListener } from "./sw-messages";

function fakeTarget() {
  let handler: ((event: MessageEvent) => void) | undefined;
  return {
    target: { addEventListener: (_: "message", h: (event: MessageEvent) => void) => { handler = h; } },
    emit: (data: unknown) => handler?.({ data } as MessageEvent),
  };
}

describe("attachSubscriptionChangeListener", () => {
  it("posts a changed subscription to the server", () => {
    const { target, emit } = fakeTarget();
    const post = vi.fn().mockResolvedValue(undefined);
    attachSubscriptionChangeListener(target, post);
    emit({ type: SUBSCRIPTION_CHANGED, subscription: { endpoint: "https://e", keys: { p256dh: "k", auth: "a" } } });
    expect(post).toHaveBeenCalledWith({ endpoint: "https://e", keys: { p256dh: "k", auth: "a" } });
  });

  it("ignores other messages and subscriptions without an endpoint", () => {
    const { target, emit } = fakeTarget();
    const post = vi.fn().mockResolvedValue(undefined);
    attachSubscriptionChangeListener(target, post);
    emit({ type: "SKIP_WAITING" });
    emit({ type: SUBSCRIPTION_CHANGED, subscription: {} });
    emit(null);
    expect(post).not.toHaveBeenCalled();
  });
});
```

`apps/web/src/features/notifications/sw-messages.ts`:

```ts
import { SUBSCRIPTION_CHANGED } from "@/sw-push";

export function attachSubscriptionChangeListener(
  target: { addEventListener(type: "message", handler: (event: MessageEvent) => void): void },
  post: (subscription: PushSubscriptionJSON) => Promise<void>,
): void {
  target.addEventListener("message", (event) => {
    const data = event.data as { type?: unknown; subscription?: PushSubscriptionJSON } | null;
    if (data?.type !== SUBSCRIPTION_CHANGED || typeof data.subscription?.endpoint !== "string") return;
    void post(data.subscription).catch(() => {
      // the next visit to Profile -> Notifications reconciles the subscription
    });
  });
}
```

Wire it in `apps/web/src/register-sw.ts`: inside `registerServiceWorker()` after the `registerSW` call add

```ts
  void import("@/features/notifications/sw-messages").then(async ({ attachSubscriptionChangeListener }) => {
    const { createNotificationsApi } = await import("@/features/notifications/notifications-api");
    const { supabase } = await import("@/lib/supabase");
    attachSubscriptionChangeListener(navigator.serviceWorker, (subscription) => createNotificationsApi(supabase).subscribe(subscription));
  });
```

Run: `bun run test:web -- sw-messages`
Expected: 2 tests pass.

- [ ] **Step 5: Copy and push-support detection (tests first)**

`apps/web/src/features/notifications/copy.ts`:

```ts
export const IOS_GUIDANCE =
  "On iPhone and iPad, notifications work from iOS 16.4 and only for apps added to the Home Screen. Tap Share, choose Add to Home Screen, open Stock Screener from the Home Screen icon, then come back here and enable notifications.";

export const IOS_STEPS = [
  "Open this site in Safari and tap the Share button.",
  "Choose Add to Home Screen, then Add.",
  "Open Stock Screener from the new Home Screen icon (not from Safari).",
  "Come back to Profile, then Notifications, and turn on Web Push.",
] as const;

export const DENIED_HELP =
  "In your browser's site settings, set Notifications to Allow for this site, then reload this page.";
```

`apps/web/src/features/notifications/push-support.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { detectPushSupport, readSupportEnv, type SupportEnv } from "./push-support";

const DESKTOP: SupportEnv = {
  hasServiceWorker: true, hasPushManager: true, hasNotification: true, isSecureContext: true,
  userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130", platform: "Win32", maxTouchPoints: 0,
  standalone: false, permission: "default",
};
const IPHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1";

describe("detectPushSupport", () => {
  it("is ready to ask on a capable desktop browser", () => {
    expect(detectPushSupport(DESKTOP).kind).toBe("prompt");
    expect(detectPushSupport({ ...DESKTOP, permission: "granted" }).kind).toBe("granted");
  });
  it("reports a denied permission with how to reset it", () => {
    expect(detectPushSupport({ ...DESKTOP, permission: "denied" }).kind).toBe("denied");
  });
  it("reports why a browser is unsupported", () => {
    expect(detectPushSupport({ ...DESKTOP, hasPushManager: false })).toMatchObject({ kind: "unsupported", reason: "no_push_manager" });
    expect(detectPushSupport({ ...DESKTOP, hasServiceWorker: false })).toMatchObject({ kind: "unsupported", reason: "no_service_worker" });
    expect(detectPushSupport({ ...DESKTOP, isSecureContext: false })).toMatchObject({ kind: "unsupported", reason: "insecure_context" });
    expect(detectPushSupport({ ...DESKTOP, hasNotification: false })).toMatchObject({ kind: "unsupported" });
  });
  it("asks iOS Safari users to install first (no PushManager outside the Home Screen app)", () => {
    const safari = { ...DESKTOP, userAgent: IPHONE_UA, platform: "iPhone", maxTouchPoints: 5, hasPushManager: false, hasNotification: false, permission: null };
    expect(detectPushSupport(safari)).toMatchObject({ kind: "ios_install", isIos: true, isStandalone: false });
  });
  it("detects iPadOS that presents a desktop Mac user agent", () => {
    const ipad = { ...DESKTOP, userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15", platform: "MacIntel", maxTouchPoints: 5, hasPushManager: false };
    expect(detectPushSupport(ipad).kind).toBe("ios_install");
  });
  it("treats an installed iOS app as capable, and an old installed iOS as unsupported", () => {
    const installed = { ...DESKTOP, userAgent: IPHONE_UA, platform: "iPhone", maxTouchPoints: 5, standalone: true };
    expect(detectPushSupport(installed).kind).toBe("prompt");
    expect(detectPushSupport({ ...installed, hasPushManager: false })).toMatchObject({ kind: "unsupported", reason: "no_push_manager", isIos: true });
  });
  it("a real Mac desktop is not mistaken for an iPad", () => {
    expect(detectPushSupport({ ...DESKTOP, platform: "MacIntel", maxTouchPoints: 0 }).kind).toBe("prompt");
  });
});

describe("readSupportEnv", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reads Notification, PushManager and navigator.standalone from the globals", () => {
    vi.stubGlobal("Notification", { permission: "granted" });
    vi.stubGlobal("PushManager", class {});
    vi.stubGlobal("navigator", { serviceWorker: {}, userAgent: IPHONE_UA, platform: "iPhone", maxTouchPoints: 5, standalone: true });
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    const env = readSupportEnv();
    expect(env).toMatchObject({ hasServiceWorker: true, hasPushManager: true, hasNotification: true, standalone: true, permission: "granted" });
  });

  it("falls back to the display-mode media query for installed Android and desktop PWAs", () => {
    vi.stubGlobal("navigator", { serviceWorker: {}, userAgent: "Android Chrome", platform: "Linux", maxTouchPoints: 5 });
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: q === "(display-mode: standalone)" }));
    expect(readSupportEnv().standalone).toBe(true);
  });

  it("reports missing APIs as false", () => {
    vi.stubGlobal("navigator", { userAgent: "x", platform: "x", maxTouchPoints: 0 });
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    const env = readSupportEnv();
    expect(env.hasServiceWorker).toBe(false);
  });
});
```

Run: `bun run test:web -- push-support`
Expected: FAIL (module missing).

`apps/web/src/features/notifications/push-support.ts`:

```ts
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNotificationsContext } from "./notifications-context";

export interface SupportEnv {
  hasServiceWorker: boolean;
  hasPushManager: boolean;
  hasNotification: boolean;
  isSecureContext: boolean;
  userAgent: string;
  platform: string;
  maxTouchPoints: number;
  standalone: boolean;
  permission: NotificationPermission | null;
}

export type PushSupport =
  | { kind: "unsupported"; reason: "insecure_context" | "no_service_worker" | "no_push_manager"; isIos: boolean }
  | { kind: "ios_install"; isIos: true; isStandalone: false }
  | { kind: "denied" | "prompt" | "granted"; isIos: boolean; isStandalone: boolean };

export function readSupportEnv(): SupportEnv {
  const nav = navigator as Navigator & { standalone?: boolean };
  const displayStandalone = typeof matchMedia === "function" && matchMedia("(display-mode: standalone)").matches;
  const hasNotification = typeof Notification !== "undefined";
  return {
    hasServiceWorker: "serviceWorker" in nav,
    hasPushManager: typeof PushManager !== "undefined",
    hasNotification,
    isSecureContext: typeof isSecureContext === "boolean" ? isSecureContext : true,
    userAgent: nav.userAgent ?? "",
    platform: nav.platform ?? "",
    maxTouchPoints: nav.maxTouchPoints ?? 0,
    standalone: nav.standalone === true || displayStandalone,
    permission: hasNotification ? Notification.permission : null,
  };
}

export function detectPushSupport(env: SupportEnv): PushSupport {
  const isIos = /iPad|iPhone|iPod/.test(env.userAgent) || (env.platform === "MacIntel" && env.maxTouchPoints > 1);
  if (isIos && !env.standalone) return { kind: "ios_install", isIos: true, isStandalone: false };
  if (!env.isSecureContext) return { kind: "unsupported", reason: "insecure_context", isIos };
  if (!env.hasServiceWorker) return { kind: "unsupported", reason: "no_service_worker", isIos };
  if (!env.hasPushManager || !env.hasNotification) return { kind: "unsupported", reason: "no_push_manager", isIos };
  const kind = env.permission === "denied" ? "denied" : env.permission === "granted" ? "granted" : "prompt";
  return { kind, isIos, isStandalone: env.standalone };
}

/** Support detection plus `refresh()` to re-read the permission after a prompt. */
export function usePushSupport(): { support: PushSupport; refresh: () => void } {
  const { readEnv } = useNotificationsContext();
  const [env, setEnv] = useState<SupportEnv>(() => readEnv());
  const refresh = useCallback(() => setEnv(readEnv()), [readEnv]);
  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const query = matchMedia("(display-mode: standalone)");
    query.addEventListener?.("change", refresh);
    return () => query.removeEventListener?.("change", refresh);
  }, [refresh]);
  return { support: useMemo(() => detectPushSupport(env), [env]), refresh };
}
```

Run (after Step 7 creates the context): `bun run test:web -- push-support`
Expected: 10 tests pass.

- [ ] **Step 6: API wrapper (tests first)**

`apps/web/src/features/notifications/notifications-api.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createNotificationsApi, DEFAULT_PREFERENCES } from "./notifications-api";

interface Call { table?: string; method: string; args: unknown[] }
type Result = { data: unknown; error: { message: string } | null; count?: number | null };

function fakeClient(results: Record<string, Result>, invoke?: (name: string, opts: unknown) => Result) {
  const calls: Call[] = [];
  const chain = (table: string): Record<string, unknown> => {
    const self: Record<string, unknown> = {};
    for (const method of ["select", "eq", "is", "order", "limit", "maybeSingle", "upsert", "update"]) {
      self[method] = (...args: unknown[]) => { calls.push({ table, method, args }); return self; };
    }
    self.then = (resolve: (value: Result) => unknown) => resolve(results[table] ?? { data: null, error: null });
    return self;
  };
  const client = {
    from: (table: string) => chain(table),
    functions: { invoke: (name: string, opts: unknown) => { calls.push({ method: `invoke:${name}`, args: [opts] }); return Promise.resolve(invoke?.(name, opts) ?? { data: { ok: true }, error: null }); } },
  };
  return { client: client as unknown as Parameters<typeof createNotificationsApi>[0], calls };
}

describe("createNotificationsApi", () => {
  it("maps a preferences row and falls back to opt-out defaults when there is none", async () => {
    const row = { push_enabled: true, email_enabled: false, digest_modes: ["worldwide", "us"], send_empty: true, email_unsubscribed_at: "2026-10-14T08:00:00Z", email_bounced_at: null };
    expect(await createNotificationsApi(fakeClient({ notification_preferences: { data: row, error: null } }).client).getPreferences("u1")).toEqual({
      pushEnabled: true, emailEnabled: false, digestModes: ["worldwide", "us"], sendEmpty: true, emailUnsubscribedAt: "2026-10-14T08:00:00Z", emailBouncedAt: null,
    });
    expect(await createNotificationsApi(fakeClient({ notification_preferences: { data: null, error: null } }).client).getPreferences("u1")).toEqual(DEFAULT_PREFERENCES);
  });

  it("surfaces a read error", async () => {
    const api = createNotificationsApi(fakeClient({ notification_preferences: { data: null, error: { message: "boom" } } }).client);
    await expect(api.getPreferences("u1")).rejects.toThrow("boom");
  });

  it("saves in two steps: insert-if-missing with user_id only, then update of the changed columns", async () => {
    const { client, calls } = fakeClient({});
    await createNotificationsApi(client).savePreferences("u1", { emailUnsubscribedAt: null, emailEnabled: true });
    const upsert = calls.find((c) => c.method === "upsert");
    expect(upsert?.args).toEqual([{ user_id: "u1" }, { onConflict: "user_id", ignoreDuplicates: true }]);
    const update = calls.find((c) => c.method === "update");
    expect(update?.args).toEqual([{ email_unsubscribed_at: null, email_enabled: true }]);
    expect(calls.find((c) => c.method === "eq")?.args).toEqual(["user_id", "u1"]);
  });

  it("reads the newest active subscription date and the active count", async () => {
    const { client } = fakeClient({ push_subscriptions: { data: [{ id: "s1", created_at: "2026-10-14T10:00:00Z" }], error: null, count: 2 } });
    expect(await createNotificationsApi(client).getSubscriptionInfo("u1")).toEqual({ activeCount: 2, latestCreatedAt: "2026-10-14T10:00:00Z" });
  });

  it("calls push-subscribe with the documented bodies and maps the test result", async () => {
    const { client, calls } = fakeClient({}, (_n, opts) => ({ data: (opts as { body: { action: string } }).body.action === "test" ? { ok: true, sent: 2, failed: 0 } : { ok: true }, error: null }));
    const api = createNotificationsApi(client);
    await api.subscribe({ endpoint: "https://e", keys: { p256dh: "k", auth: "a" } });
    await api.unsubscribe("https://e");
    expect(await api.sendTest()).toEqual({ sent: 2, failed: 0 });
    expect(calls.filter((c) => c.method.startsWith("invoke")).map((c) => (c.args[0] as { body: unknown }).body)).toEqual([
      { action: "subscribe", subscription: { endpoint: "https://e", keys: { p256dh: "k", auth: "a" } } },
      { action: "unsubscribe", endpoint: "https://e" },
      { action: "test" },
    ]);
  });

  it("throws a readable error when the function fails", async () => {
    const api = createNotificationsApi(fakeClient({}, () => ({ data: null, error: { message: "non-2xx" } })).client);
    await expect(api.sendTest()).rejects.toThrow(/push-subscribe/);
  });
});
```

`apps/web/src/features/notifications/notifications-api.ts`:

```ts
import type { SupabaseClient } from "@supabase/supabase-js";

export type DigestMode = "worldwide" | "us";

export interface NotificationPreferences {
  pushEnabled: boolean;
  emailEnabled: boolean;
  digestModes: DigestMode[];
  sendEmpty: boolean;
  emailUnsubscribedAt: string | null;
  emailBouncedAt: string | null;
}

export type PreferencePatch = Partial<
  Pick<NotificationPreferences, "pushEnabled" | "emailEnabled" | "digestModes" | "sendEmpty" | "emailUnsubscribedAt">
>;

export const DEFAULT_PREFERENCES: NotificationPreferences = {
  pushEnabled: false,
  emailEnabled: false,
  digestModes: ["worldwide"],
  sendEmpty: false,
  emailUnsubscribedAt: null,
  emailBouncedAt: null,
};

export interface SubscriptionInfo {
  activeCount: number;
  latestCreatedAt: string | null;
}

export interface NotificationsApi {
  getPreferences(userId: string): Promise<NotificationPreferences>;
  savePreferences(userId: string, patch: PreferencePatch): Promise<void>;
  getSubscriptionInfo(userId: string): Promise<SubscriptionInfo>;
  subscribe(subscription: PushSubscriptionJSON): Promise<void>;
  unsubscribe(endpoint: string): Promise<void>;
  sendTest(): Promise<{ sent: number; failed: number }>;
}

type Client = Pick<SupabaseClient, "from" | "functions">;

const COLUMNS: Record<keyof PreferencePatch, string> = {
  pushEnabled: "push_enabled",
  emailEnabled: "email_enabled",
  digestModes: "digest_modes",
  sendEmpty: "send_empty",
  emailUnsubscribedAt: "email_unsubscribed_at",
};

export function createNotificationsApi(client: Client): NotificationsApi {
  async function invoke(body: Record<string, unknown>): Promise<unknown> {
    const { data, error } = await client.functions.invoke("push-subscribe", { body });
    if (error) throw new Error("push-subscribe request failed");
    return data;
  }
  return {
    async getPreferences(userId) {
      const { data, error } = await client
        .from("notification_preferences")
        .select("push_enabled,email_enabled,digest_modes,send_empty,email_unsubscribed_at,email_bounced_at")
        .eq("user_id", userId)
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (data === null) return DEFAULT_PREFERENCES;
      const row = data as Record<string, unknown>;
      return {
        pushEnabled: row.push_enabled === true,
        emailEnabled: row.email_enabled === true,
        digestModes: (row.digest_modes as DigestMode[] | null) ?? ["worldwide"],
        sendEmpty: row.send_empty === true,
        emailUnsubscribedAt: (row.email_unsubscribed_at as string | null) ?? null,
        emailBouncedAt: (row.email_bounced_at as string | null) ?? null,
      };
    },
    async savePreferences(userId, patch) {
      // An INSERT that names email_unsubscribed_at would be refused by the column grant, so the row is
      // created with user_id only (no-op when it exists) and every change goes through UPDATE.
      const ensure = await client.from("notification_preferences").upsert({ user_id: userId }, { onConflict: "user_id", ignoreDuplicates: true });
      if (ensure.error) throw new Error(ensure.error.message);
      const columns: Record<string, unknown> = {};
      for (const key of Object.keys(patch) as (keyof PreferencePatch)[]) columns[COLUMNS[key]] = patch[key];
      const { error } = await client.from("notification_preferences").update(columns).eq("user_id", userId);
      if (error) throw new Error(error.message);
    },
    async getSubscriptionInfo(userId) {
      const { data, error, count } = await client
        .from("push_subscriptions")
        .select("id,created_at", { count: "exact" })
        .eq("user_id", userId)
        .is("revoked_at", null)
        .order("created_at", { ascending: false })
        .limit(1);
      if (error) throw new Error(error.message);
      const rows = (data ?? []) as { created_at: string }[];
      return { activeCount: count ?? rows.length, latestCreatedAt: rows[0]?.created_at ?? null };
    },
    async subscribe(subscription) {
      await invoke({ action: "subscribe", subscription: { endpoint: subscription.endpoint, keys: subscription.keys } });
    },
    async unsubscribe(endpoint) {
      await invoke({ action: "unsubscribe", endpoint });
    },
    async sendTest() {
      const data = (await invoke({ action: "test" })) as { sent?: number; failed?: number } | null;
      return { sent: data?.sent ?? 0, failed: data?.failed ?? 0 };
    },
  };
}
```

Run: `bun run test:web -- notifications-api`
Expected: 6 tests pass.

- [ ] **Step 7: Browser push client and the context (tests first for the client)**

`apps/web/src/features/notifications/push-client.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import type { NotificationsApi } from "./notifications-api";
import { disablePush, enablePush, reconcilePush, type BrowserPush } from "./push-client";

const KEY = "AQID";
const json = { endpoint: "https://push.example/e1", keys: { p256dh: "k", auth: "a" } };

function fakes(over: { permission?: NotificationPermission; existing?: boolean; subscribeError?: Error } = {}) {
  const sub = { endpoint: json.endpoint, toJSON: () => json, unsubscribe: vi.fn().mockResolvedValue(true) };
  const pushManager = {
    getSubscription: vi.fn().mockResolvedValue(over.existing ? sub : null),
    subscribe: vi.fn(() => (over.subscribeError ? Promise.reject(over.subscribeError) : Promise.resolve(sub))),
  };
  const browser: BrowserPush = {
    requestPermission: vi.fn().mockResolvedValue(over.permission ?? "granted"),
    getRegistration: vi.fn().mockResolvedValue({ pushManager }),
  };
  const api = { subscribe: vi.fn().mockResolvedValue(undefined), unsubscribe: vi.fn().mockResolvedValue(undefined) } as unknown as NotificationsApi;
  return { browser, api, pushManager, sub };
}

describe("enablePush", () => {
  it("requests permission synchronously (inside the click gesture), subscribes with the key and posts to the server", async () => {
    const { browser, api, pushManager } = fakes();
    const pending = enablePush(browser, api, KEY);
    expect(browser.requestPermission).toHaveBeenCalledTimes(1); // before any await resolved
    expect(await pending).toEqual({ ok: true });
    expect(pushManager.subscribe).toHaveBeenCalledWith({ userVisibleOnly: true, applicationServerKey: new Uint8Array([1, 2, 3]) });
    expect(api.subscribe).toHaveBeenCalledWith(json);
  });

  it("does nothing when permission is denied or dismissed", async () => {
    for (const [permission, reason] of [["denied", "denied"], ["default", "dismissed"]] as const) {
      const { browser, api } = fakes({ permission });
      expect(await enablePush(browser, api, KEY)).toEqual({ ok: false, reason });
      expect(api.subscribe).not.toHaveBeenCalled();
    }
  });

  it("does not even prompt when the VAPID key is not configured", async () => {
    const { browser, api } = fakes();
    expect(await enablePush(browser, api, undefined)).toEqual({ ok: false, reason: "no_key" });
    expect(browser.requestPermission).not.toHaveBeenCalled();
    expect(api.subscribe).not.toHaveBeenCalled();
  });

  it("reuses an existing browser subscription and reports subscribe and server failures", async () => {
    const reuse = fakes({ existing: true });
    expect((await enablePush(reuse.browser, reuse.api, KEY)).ok).toBe(true);
    expect(reuse.pushManager.subscribe).not.toHaveBeenCalled();
    const broken = fakes({ subscribeError: new Error("push service unreachable") });
    expect(await enablePush(broken.browser, broken.api, KEY)).toEqual({ ok: false, reason: "subscribe_failed" });
    const serverDown = fakes();
    (serverDown.api.subscribe as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("500"));
    expect(await enablePush(serverDown.browser, serverDown.api, KEY)).toEqual({ ok: false, reason: "server_failed" });
  });
});

describe("disablePush", () => {
  it("unsubscribes this device in the browser and removes it on the server", async () => {
    const { browser, api, sub } = fakes({ existing: true });
    await disablePush(browser, api);
    expect(sub.unsubscribe).toHaveBeenCalled();
    expect(api.unsubscribe).toHaveBeenCalledWith(json.endpoint);
  });
  it("is a no-op without a browser subscription", async () => {
    const { browser, api } = fakes();
    await disablePush(browser, api);
    expect(api.unsubscribe).not.toHaveBeenCalled();
  });
});

describe("reconcilePush (page visit)", () => {
  it("re-registers the current browser subscription so a rotated endpoint is stored", async () => {
    const { browser, api } = fakes({ existing: true });
    expect(await reconcilePush(browser, api, KEY, "granted")).toBe("synced");
    expect(api.subscribe).toHaveBeenCalledWith(json);
  });
  it("silently creates a subscription when permission is already granted but none exists", async () => {
    const { browser, api, pushManager } = fakes();
    expect(await reconcilePush(browser, api, KEY, "granted")).toBe("synced");
    expect(pushManager.subscribe).toHaveBeenCalled();
  });
  it("does nothing without a granted permission or a key", async () => {
    const { browser, api } = fakes();
    expect(await reconcilePush(browser, api, KEY, "default")).toBe("skipped");
    expect(await reconcilePush(browser, api, undefined, "granted")).toBe("skipped");
    expect(api.subscribe).not.toHaveBeenCalled();
  });
});
```

`apps/web/src/features/notifications/push-client.ts`:

```ts
import { urlBase64ToUint8Array } from "@/lib/vapid-key";
import type { NotificationsApi } from "./notifications-api";

export interface SubscriptionLike {
  endpoint: string;
  toJSON(): PushSubscriptionJSON;
  unsubscribe(): Promise<boolean>;
}
export interface PushRegistrationLike {
  pushManager: {
    getSubscription(): Promise<SubscriptionLike | null>;
    subscribe(options: { userVisibleOnly: boolean; applicationServerKey: BufferSource }): Promise<SubscriptionLike>;
  };
}
export interface BrowserPush {
  requestPermission(): Promise<NotificationPermission>;
  getRegistration(): Promise<PushRegistrationLike>;
}

export function defaultBrowserPush(): BrowserPush {
  return {
    requestPermission: () => Notification.requestPermission(),
    getRegistration: async () => (await navigator.serviceWorker.ready) as unknown as PushRegistrationLike,
  };
}

export type EnableResult =
  | { ok: true }
  | { ok: false; reason: "no_key" | "denied" | "dismissed" | "subscribe_failed" | "server_failed" };

/**
 * Must be called directly from the click handler: browsers (iOS in particular) only show the
 * permission prompt for a call made inside the user gesture, so requestPermission() is the first
 * thing that runs, before any await.
 */
export async function enablePush(browser: BrowserPush, api: NotificationsApi, vapidPublicKey: string | undefined): Promise<EnableResult> {
  if (!vapidPublicKey) return { ok: false, reason: "no_key" };
  const permission = await browser.requestPermission();
  if (permission === "denied") return { ok: false, reason: "denied" };
  if (permission !== "granted") return { ok: false, reason: "dismissed" };
  let subscription: SubscriptionLike;
  try {
    const registration = await browser.getRegistration();
    subscription =
      (await registration.pushManager.getSubscription()) ??
      (await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(vapidPublicKey) }));
  } catch {
    return { ok: false, reason: "subscribe_failed" };
  }
  try {
    await api.subscribe(subscription.toJSON());
  } catch {
    return { ok: false, reason: "server_failed" };
  }
  return { ok: true };
}

export async function disablePush(browser: BrowserPush, api: NotificationsApi): Promise<void> {
  const registration = await browser.getRegistration();
  const subscription = await registration.pushManager.getSubscription();
  if (subscription === null) return;
  const endpoint = subscription.endpoint;
  await subscription.unsubscribe();
  await api.unsubscribe(endpoint);
}

/** Spec 10.4: pushsubscriptionchange is unreliable, so every visit re-registers the live subscription. */
export async function reconcilePush(
  browser: BrowserPush,
  api: NotificationsApi,
  vapidPublicKey: string | undefined,
  permission: NotificationPermission | null,
): Promise<"synced" | "skipped"> {
  if (permission !== "granted" || !vapidPublicKey) return "skipped";
  const registration = await browser.getRegistration();
  const subscription =
    (await registration.pushManager.getSubscription()) ??
    (await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(vapidPublicKey) }));
  await api.subscribe(subscription.toJSON());
  return "synced";
}
```

`apps/web/src/features/notifications/notifications-context.tsx`:

```tsx
import { createContext, type ReactNode, useContext } from "react";
import type { NotificationsApi } from "./notifications-api";
import type { BrowserPush } from "./push-client";
import type { SupportEnv } from "./push-support";

export interface NotificationsContextValue {
  userId: string;
  emailVerified: boolean;
  api: NotificationsApi;
  browser: BrowserPush;
  vapidPublicKey: string | undefined;
  readEnv: () => SupportEnv;
}

const NotificationsContext = createContext<NotificationsContextValue | null>(null);

export function NotificationsProvider({ value, children }: { value: NotificationsContextValue; children: ReactNode }) {
  return <NotificationsContext.Provider value={value}>{children}</NotificationsContext.Provider>;
}

export function useNotificationsContext(): NotificationsContextValue {
  const value = useContext(NotificationsContext);
  if (value === null) throw new Error("useNotificationsContext must be used inside NotificationsProvider");
  return value;
}
```

`apps/web/src/features/notifications/use-notification-preferences.ts`:

```ts
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { NotificationPreferences, PreferencePatch } from "./notifications-api";
import { useNotificationsContext } from "./notifications-context";

export function useNotificationPreferences(): {
  preferences: NotificationPreferences | undefined;
  status: "pending" | "error" | "success";
  refetch: () => void;
  update: (patch: PreferencePatch) => Promise<void>;
  saving: boolean;
} {
  const { api, userId } = useNotificationsContext();
  const queryClient = useQueryClient();
  const key = ["notifications", "preferences", userId];
  const query = useQuery({ queryKey: key, queryFn: () => api.getPreferences(userId) });
  const mutation = useMutation({
    mutationFn: (patch: PreferencePatch) => api.savePreferences(userId, patch),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: key }),
  });
  return {
    preferences: query.data,
    status: query.status,
    refetch: () => void query.refetch(),
    update: (patch) => mutation.mutateAsync(patch),
    saving: mutation.isPending,
  };
}
```

Run: `bun run test:web -- push-client` and `bun run test:web -- push-support`
Expected: push-client 9 tests and push-support 10 tests pass.

- [ ] **Step 8: Write the failing view tests (every state)**

`apps/web/src/features/notifications/notifications-view.test.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { IOS_GUIDANCE } from "./copy";
import { DEFAULT_PREFERENCES, type NotificationPreferences, type NotificationsApi } from "./notifications-api";
import type { BrowserPush } from "./push-client";
import type { SupportEnv } from "./push-support";
import { NotificationsView } from "./notifications-view";

const DESKTOP: SupportEnv = {
  hasServiceWorker: true, hasPushManager: true, hasNotification: true, isSecureContext: true,
  userAgent: "Mozilla/5.0 (Windows NT 10.0) Chrome/130", platform: "Win32", maxTouchPoints: 0, standalone: false, permission: "default",
};
const IPHONE: SupportEnv = {
  ...DESKTOP, userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) Safari/604.1", platform: "iPhone",
  maxTouchPoints: 5, hasPushManager: false, hasNotification: false, permission: null,
};
const SUB_JSON = { endpoint: "https://push.example/e1", keys: { p256dh: "k", auth: "a" } };

function setup(over: { prefs?: Partial<NotificationPreferences>; env?: Partial<SupportEnv>; emailVerified?: boolean; permissionResult?: NotificationPermission; loadError?: boolean; existingSub?: boolean } = {}) {
  const prefs: NotificationPreferences = { ...DEFAULT_PREFERENCES, ...over.prefs };
  const sub = { endpoint: SUB_JSON.endpoint, toJSON: () => SUB_JSON, unsubscribe: vi.fn().mockResolvedValue(true) };
  const pushManager = {
    getSubscription: vi.fn().mockResolvedValue(over.existingSub ? sub : null),
    subscribe: vi.fn().mockResolvedValue(sub),
  };
  const browser: BrowserPush = {
    requestPermission: vi.fn().mockResolvedValue(over.permissionResult ?? "granted"),
    getRegistration: vi.fn().mockResolvedValue({ pushManager }),
  };
  const api = {
    getPreferences: vi.fn(() => (over.loadError ? Promise.reject(new Error("down")) : Promise.resolve(prefs))),
    savePreferences: vi.fn().mockResolvedValue(undefined),
    getSubscriptionInfo: vi.fn().mockResolvedValue({ activeCount: 1, latestCreatedAt: "2026-10-14T10:00:00Z" }),
    subscribe: vi.fn().mockResolvedValue(undefined),
    unsubscribe: vi.fn().mockResolvedValue(undefined),
    sendTest: vi.fn().mockResolvedValue({ sent: 1, failed: 0 }),
  } satisfies NotificationsApi;
  const env = { ...DESKTOP, ...over.env };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <NotificationsView userId="u1" emailVerified={over.emailVerified ?? true} api={api} browser={browser} vapidPublicKey="AQID" readEnv={() => env} />
    </QueryClientProvider>,
  );
  return { api, browser, pushManager, sub };
}

const pushToggle = () => screen.findByRole("switch", { name: "Push notifications on this device" });

describe("Web Push card states", () => {
  it("unsupported browser: explains why and offers no switch", async () => {
    setup({ env: { hasPushManager: false } });
    expect(await screen.findByText("Web Push is not available in this browser")).toBeTruthy();
    expect(screen.queryByRole("switch", { name: "Push notifications on this device" })).toBeNull();
  });

  it("iOS Safari outside the Home Screen app: step by step guidance instead of the switch", async () => {
    setup({ env: IPHONE });
    expect(await screen.findByText(IOS_GUIDANCE)).toBeTruthy();
    expect(screen.getByText(/Choose Add to Home Screen/)).toBeTruthy();
    expect(screen.queryByRole("switch", { name: "Push notifications on this device" })).toBeNull();
  });

  it("permission denied: says it is blocked and how to reset it", async () => {
    setup({ env: { permission: "denied" } });
    expect(await screen.findByText("Notifications are blocked for this site")).toBeTruthy();
    expect(screen.getByText(/set Notifications to Allow for this site/)).toBeTruthy();
    const toggle = screen.queryByRole("switch", { name: "Push notifications on this device" });
    expect(toggle === null || (toggle as HTMLButtonElement).disabled).toBe(true);
  });

  it("enabled: shows the subscription date, and Send test notification reports the result", async () => {
    const { api } = setup({ prefs: { pushEnabled: true }, env: { permission: "granted" }, existingSub: true });
    expect(await screen.findByText("Subscribed on 14 Oct 2026")).toBeTruthy();
    expect((await pushToggle()).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Send test notification" }));
    expect(await screen.findByText("Test notification sent to 1 device.")).toBeTruthy();
    expect(api.sendTest).toHaveBeenCalledTimes(1);
  });

  it("enabled: re-registers the live subscription on visit (rotation reconcile)", async () => {
    const { api } = setup({ prefs: { pushEnabled: true }, env: { permission: "granted" }, existingSub: true });
    await waitFor(() => expect(api.subscribe).toHaveBeenCalledWith(SUB_JSON));
  });

  it("turning on requests permission inside the click, subscribes, posts and saves the preference", async () => {
    const { api, browser, pushManager } = setup();
    const toggle = await pushToggle();
    fireEvent.click(toggle);
    expect(browser.requestPermission).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(api.savePreferences).toHaveBeenCalledWith("u1", { pushEnabled: true }));
    expect(pushManager.subscribe).toHaveBeenCalledWith({ userVisibleOnly: true, applicationServerKey: new Uint8Array([1, 2, 3]) });
    expect(api.subscribe).toHaveBeenCalledWith(SUB_JSON);
  });

  it("turning on while the browser prompt is denied saves nothing and shows the denied help", async () => {
    const { api } = setup({ permissionResult: "denied" });
    fireEvent.click(await pushToggle());
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByText("Notifications are blocked for this site")).toBeTruthy();
    expect(api.savePreferences).not.toHaveBeenCalledWith("u1", { pushEnabled: true });
  });

  it("turning off unsubscribes this device and saves the preference", async () => {
    const { api, sub } = setup({ prefs: { pushEnabled: true }, env: { permission: "granted" }, existingSub: true });
    fireEvent.click(await pushToggle());
    await waitFor(() => expect(api.savePreferences).toHaveBeenCalledWith("u1", { pushEnabled: false }));
    expect(sub.unsubscribe).toHaveBeenCalled();
    expect(api.unsubscribe).toHaveBeenCalledWith(SUB_JSON.endpoint);
  });
});

describe("Email card states", () => {
  it("verified address: the switch saves emailEnabled", async () => {
    const { api } = setup();
    fireEvent.click(await screen.findByRole("switch", { name: "Email notifications" }));
    await waitFor(() => expect(api.savePreferences).toHaveBeenCalledWith("u1", { emailEnabled: true }));
  });

  it("unverified address: the switch is disabled with the reason", async () => {
    setup({ emailVerified: false });
    const toggle = await screen.findByRole("switch", { name: "Email notifications" });
    expect((toggle as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Verify your email address to turn on email notifications.")).toBeTruthy();
  });

  it("unsubscribed: shows the date and a re-enable action that clears email_unsubscribed_at", async () => {
    const { api } = setup({ prefs: { emailUnsubscribedAt: "2026-10-14T08:00:00Z" } });
    expect(await screen.findByText("Unsubscribed on 14 Oct 2026")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Re-enable email" }));
    await waitFor(() => expect(api.savePreferences).toHaveBeenCalledWith("u1", { emailUnsubscribedAt: null, emailEnabled: true }));
  });

  it("bounced: email is paused and cannot be re-enabled from here", async () => {
    setup({ prefs: { emailBouncedAt: "2026-10-13T08:00:00Z", emailEnabled: false } });
    expect(await screen.findByText(/Email delivery to your address failed/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Re-enable email" })).toBeNull();
    expect(((await screen.findByRole("switch", { name: "Email notifications" })) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("Digest preferences", () => {
  it("adds the US mode and keeps at least one mode selected", async () => {
    const { api } = setup();
    const group = await screen.findByRole("group", { name: "Digest coverage" });
    const worldwide = within(group).getByRole("checkbox", { name: "Worldwide" }) as HTMLInputElement;
    const us = within(group).getByRole("checkbox", { name: "US only" }) as HTMLInputElement;
    expect(worldwide.checked).toBe(true);
    expect(us.checked).toBe(false);
    fireEvent.click(worldwide); // the last remaining mode cannot be unchecked
    expect(api.savePreferences).not.toHaveBeenCalled();
    fireEvent.click(us);
    await waitFor(() => expect(api.savePreferences).toHaveBeenCalledWith("u1", { digestModes: ["worldwide", "us"] }));
  });

  it("Send empty digests switch saves sendEmpty", async () => {
    const { api } = setup();
    fireEvent.click(await screen.findByRole("switch", { name: "Send empty digests" }));
    await waitFor(() => expect(api.savePreferences).toHaveBeenCalledWith("u1", { sendEmpty: true }));
  });
});

describe("loading and error states", () => {
  it("shows a skeleton while loading and a retry when the load fails", async () => {
    setup({ loadError: true });
    expect(await screen.findByText("Could not load your notification settings.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });
});
```

Run: `bun run test:web -- notifications-view`
Expected: FAIL (module `./notifications-view` missing).

- [ ] **Step 9: Implement the components (load the two design skills first)**

`apps/web/src/features/notifications/components/web-push-card.tsx`:

```tsx
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { DENIED_HELP, IOS_GUIDANCE, IOS_STEPS } from "../copy";
import type { NotificationPreferences, PreferencePatch } from "../notifications-api";
import { useNotificationsContext } from "../notifications-context";
import { disablePush, enablePush, reconcilePush } from "../push-client";
import { usePushSupport } from "../push-support";

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "Europe/Sofia" });
}

const FAILURES = {
  no_key: "Push is not configured for this site yet (missing public key).",
  subscribe_failed: "The browser could not create a push subscription. Try again, or use email instead.",
  server_failed: "The subscription could not be saved. Try again in a moment.",
} as const;

export function WebPushCard({ prefs, onChange }: { prefs: NotificationPreferences; onChange: (patch: PreferencePatch) => Promise<void> }) {
  const { api, browser, userId, vapidPublicKey } = useNotificationsContext();
  const { support, refresh } = usePushSupport();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [deniedNow, setDeniedNow] = useState(false);
  const kind = deniedNow ? "denied" : support.kind;
  const subscriptionKey = ["notifications", "subscription", userId];
  const info = useQuery({ queryKey: subscriptionKey, queryFn: () => api.getSubscriptionInfo(userId), enabled: prefs.pushEnabled });

  // Once per visit: re-register the live browser subscription (a rotated endpoint is stored again).
  const reconciled = useRef(false);
  useEffect(() => {
    if (reconciled.current || !prefs.pushEnabled || support.kind !== "granted") return;
    reconciled.current = true;
    void reconcilePush(browser, api, vapidPublicKey, "granted")
      .then(() => queryClient.invalidateQueries({ queryKey: ["notifications", "subscription", userId] }))
      .catch(() => undefined);
  }, [prefs.pushEnabled, support.kind, browser, api, vapidPublicKey, queryClient, userId]);

  async function toggle(next: boolean) {
    setError(null);
    setTestResult(null);
    setBusy(true);
    try {
      if (next) {
        const result = await enablePush(browser, api, vapidPublicKey); // first statement requests permission: still inside the gesture
        refresh();
        if (!result.ok) {
          if (result.reason === "denied") setDeniedNow(true);
          setError(result.reason === "denied" ? "Notifications were blocked in the browser prompt." : result.reason === "dismissed" ? "The permission prompt was dismissed. Nothing was changed." : FAILURES[result.reason]);
          return;
        }
        await onChange({ pushEnabled: true });
      } else {
        await disablePush(browser, api).catch(() => undefined);
        await onChange({ pushEnabled: false });
      }
      await queryClient.invalidateQueries({ queryKey: subscriptionKey });
    } catch {
      setError("Could not save the change. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function sendTest() {
    setError(null);
    setTestResult(null);
    setBusy(true);
    try {
      const { sent, failed } = await api.sendTest();
      setTestResult(sent > 0 ? `Test notification sent to ${sent} device${sent === 1 ? "" : "s"}.` : `The test could not be delivered (${failed} failed). Turn push off and on again on this device.`);
    } catch {
      setError("No active subscription was found for this device. Turn push off and on again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Web Push</CardTitle>
        <CardDescription>Notifications on this device when a daily digest is ready. Works even when the site is closed.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {support.kind === "unsupported" && (
          <div>
            <p className="font-medium">Web Push is not available in this browser</p>
            <p className="text-sm text-muted-foreground">
              {support.reason === "insecure_context" && "Push needs a secure (https) connection."}
              {support.reason === "no_service_worker" && "This browser does not support service workers."}
              {support.reason === "no_push_manager" &&
                (support.isIos ? "Update to iOS or iPadOS 16.4 or later to use push." : "Try a current version of Chrome, Edge, Firefox or Safari, or use email instead.")}
            </p>
          </div>
        )}
        {kind === "ios_install" && (
          <div className="space-y-3">
            <p>{IOS_GUIDANCE}</p>
            <ol className="list-decimal space-y-1 pl-5 text-sm">
              {IOS_STEPS.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
          </div>
        )}
        {kind === "denied" && (
          <div>
            <p className="font-medium">Notifications are blocked for this site</p>
            <p className="text-sm text-muted-foreground">{DENIED_HELP}</p>
          </div>
        )}
        {(kind === "prompt" || kind === "granted") && (
          <>
            <div className="flex items-center justify-between gap-4">
              <label htmlFor="push-switch" className="font-medium">Push notifications on this device</label>
              <div className="flex items-center gap-2">
                <span className="text-sm text-muted-foreground" aria-hidden="true">{prefs.pushEnabled ? "On" : "Off"}</span>
                <Switch id="push-switch" aria-label="Push notifications on this device" checked={prefs.pushEnabled} disabled={busy} onCheckedChange={(next) => void toggle(next)} />
              </div>
            </div>
            {prefs.pushEnabled && (
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-sm text-muted-foreground">
                  {info.data?.latestCreatedAt ? `Subscribed on ${formatDate(info.data.latestCreatedAt)}` : "Checking subscription"}
                </p>
                <Button variant="outline" size="sm" disabled={busy} onClick={() => void sendTest()}>Send test notification</Button>
              </div>
            )}
          </>
        )}
        {testResult && <p role="status" className="text-sm">{testResult}</p>}
        {error && (
          <p role="alert" className="text-sm font-medium">
            {error}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
```

`apps/web/src/features/notifications/components/email-card.tsx`:

```tsx
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import type { NotificationPreferences, PreferencePatch } from "../notifications-api";
import { useNotificationsContext } from "../notifications-context";
import { formatDate } from "./web-push-card";

export function EmailCard({ prefs, onChange }: { prefs: NotificationPreferences; onChange: (patch: PreferencePatch) => Promise<void> }) {
  const { emailVerified } = useNotificationsContext();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bounced = prefs.emailBouncedAt !== null;
  const unsubscribed = prefs.emailUnsubscribedAt !== null;

  async function save(patch: PreferencePatch) {
    setBusy(true);
    setError(null);
    try {
      await onChange(patch);
    } catch {
      setError("Could not save the change. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Email</CardTitle>
        <CardDescription>One email per digest, with tickers, signals and links only. No quantities or values.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between gap-4">
          <label htmlFor="email-switch" className="font-medium">Email notifications</label>
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground" aria-hidden="true">{prefs.emailEnabled ? "On" : "Off"}</span>
            <Switch
              id="email-switch"
              aria-label="Email notifications"
              checked={prefs.emailEnabled}
              disabled={busy || !emailVerified || bounced || unsubscribed}
              onCheckedChange={(next) => void save({ emailEnabled: next })}
            />
          </div>
        </div>
        {!emailVerified && <p className="text-sm text-muted-foreground">Verify your email address to turn on email notifications.</p>}
        {bounced && (
          <p className="text-sm">Email delivery to your address failed, so email notifications are paused. Contact the operator once the address is fixed.</p>
        )}
        {unsubscribed && !bounced && (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm">{`Unsubscribed on ${formatDate(prefs.emailUnsubscribedAt as string)}`}</p>
            <Button variant="outline" size="sm" disabled={busy || !emailVerified} onClick={() => void save({ emailUnsubscribedAt: null, emailEnabled: true })}>
              Re-enable email
            </Button>
          </div>
        )}
        {error && <p role="alert" className="text-sm font-medium">{error}</p>}
      </CardContent>
    </Card>
  );
}
```

`apps/web/src/features/notifications/components/digest-preferences-card.tsx`:

```tsx
import { useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import type { DigestMode, NotificationPreferences, PreferencePatch } from "../notifications-api";

const MODES: { value: DigestMode; label: string }[] = [
  { value: "worldwide", label: "Worldwide" },
  { value: "us", label: "US only" },
];

export function DigestPreferencesCard({ prefs, onChange }: { prefs: NotificationPreferences; onChange: (patch: PreferencePatch) => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(patch: PreferencePatch) {
    setBusy(true);
    setError(null);
    try {
      await onChange(patch);
    } catch {
      setError("Could not save the change. Try again.");
    } finally {
      setBusy(false);
    }
  }

  function toggleMode(mode: DigestMode, checked: boolean) {
    const next = MODES.map((m) => m.value).filter((m) => (m === mode ? checked : prefs.digestModes.includes(m)));
    if (next.length === 0) return; // at least one universe stays selected
    void save({ digestModes: next });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Digest settings</CardTitle>
        <CardDescription>Applies to both push and email. At most two digests per scan: Today's Discounts and Portfolio Alerts.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <fieldset className="space-y-2" aria-describedby="modes-help">
          <legend className="font-medium">Digest coverage</legend>
          <p id="modes-help" className="text-sm text-muted-foreground">Which universes should Today's Discounts include? A company in both is listed once.</p>
          {MODES.map((mode) => (
            <label key={mode.value} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="size-4"
                checked={prefs.digestModes.includes(mode.value)}
                disabled={busy}
                onChange={(event) => toggleMode(mode.value, event.target.checked)}
              />
              {mode.label}
            </label>
          ))}
        </fieldset>
        <div className="flex items-center justify-between gap-4">
          <div>
            <label htmlFor="send-empty" className="font-medium">Send empty digests</label>
            <p className="text-sm text-muted-foreground">Also notify me on days with nothing to report.</p>
          </div>
          <Switch id="send-empty" aria-label="Send empty digests" checked={prefs.sendEmpty} disabled={busy} onCheckedChange={(next) => void save({ sendEmpty: next })} />
        </div>
        {error && <p role="alert" className="text-sm font-medium">{error}</p>}
      </CardContent>
    </Card>
  );
}
```

`apps/web/src/features/notifications/notifications-view.tsx`:

```tsx
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { DigestPreferencesCard } from "./components/digest-preferences-card";
import { EmailCard } from "./components/email-card";
import { WebPushCard } from "./components/web-push-card";
import type { NotificationsApi } from "./notifications-api";
import { NotificationsProvider, type NotificationsContextValue } from "./notifications-context";
import type { BrowserPush } from "./push-client";
import type { SupportEnv } from "./push-support";
import { useNotificationPreferences } from "./use-notification-preferences";

interface ViewProps {
  userId: string;
  emailVerified: boolean;
  api: NotificationsApi;
  browser: BrowserPush;
  vapidPublicKey: string | undefined;
  readEnv: () => SupportEnv;
}

function Cards() {
  const { preferences, status, refetch, update } = useNotificationPreferences();
  if (status === "pending") {
    return (
      <div className="space-y-4" aria-busy="true" aria-label="Loading notification settings">
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-44 w-full" />
      </div>
    );
  }
  if (status === "error" || preferences === undefined) {
    return (
      <div role="alert" className="space-y-3">
        <p>Could not load your notification settings.</p>
        <Button variant="outline" onClick={refetch}>Retry</Button>
      </div>
    );
  }
  return (
    <div className="space-y-6">
      <WebPushCard prefs={preferences} onChange={update} />
      <EmailCard prefs={preferences} onChange={update} />
      <DigestPreferencesCard prefs={preferences} onChange={update} />
    </div>
  );
}

export function NotificationsView(props: ViewProps) {
  const value: NotificationsContextValue = { ...props };
  return (
    <NotificationsProvider value={value}>
      <Cards />
    </NotificationsProvider>
  );
}
```

Run: `bun run test:web -- notifications-view`
Expected: all 15 view tests pass. If Radix `Switch` does not expose `aria-checked` under happy-dom, assert `data-state="checked"` instead (keep the visible "On"/"Off" text).

- [ ] **Step 10: Replace the P5a placeholder panel**

`apps/web/src/features/profile/panels/notifications-panel.tsx`:

```tsx
import { useAuth } from "@/features/auth/auth-provider";
import { createNotificationsApi, type NotificationsApi } from "@/features/notifications/notifications-api";
import { NotificationsView } from "@/features/notifications/notifications-view";
import { defaultBrowserPush } from "@/features/notifications/push-client";
import { readSupportEnv } from "@/features/notifications/push-support";

// The supabase client is imported lazily so that importing this panel never builds a client
// (component tests of the profile pages do not provide Supabase environment variables).
async function real(): Promise<NotificationsApi> {
  const { supabase } = await import("@/lib/supabase");
  return createNotificationsApi(supabase);
}

const lazyApi: NotificationsApi = {
  getPreferences: async (userId) => (await real()).getPreferences(userId),
  savePreferences: async (userId, patch) => (await real()).savePreferences(userId, patch),
  getSubscriptionInfo: async (userId) => (await real()).getSubscriptionInfo(userId),
  subscribe: async (subscription) => (await real()).subscribe(subscription),
  unsubscribe: async (endpoint) => (await real()).unsubscribe(endpoint),
  sendTest: async () => (await real()).sendTest(),
};

export function NotificationsPanel() {
  const { user } = useAuth();
  if (user === null) return null;
  return (
    <NotificationsView
      userId={user.id}
      emailVerified={Boolean(user.email_confirmed_at)}
      api={lazyApi}
      browser={defaultBrowserPush()}
      vapidPublicKey={import.meta.env.VITE_VAPID_PUBLIC_KEY as string | undefined}
      readEnv={readSupportEnv}
    />
  );
}
```

If P5a's `profile-panels.test.tsx` asserts the placeholder sentence "Notification settings arrive with the notifications phase.", replace that assertion with `expect(await screen.findByText("Web Push")).toBeTruthy();` (the heading `Notifications` assertion stays). Add to `apps/web/.env.example`: `VITE_VAPID_PUBLIC_KEY=` (public key only, from `bun run gen:vapid`).

- [ ] **Step 11: Full web verification**

Run: `bun run lint:fix` then `bun run lint`; `bun run typecheck`; `bun run test:web`; `bun run build`; `bun run check:bundle`
Expected: all exit 0. `check:bundle` must still report no secret (only the public VAPID key can appear). If `tsc` rejects `PushSubscriptionChangeEvent` use the local `SubscriptionChangeEvent` interface already defined in `sw.ts`; if it rejects `Uint8Array<ArrayBuffer>` as `BufferSource` for `applicationServerKey`, keep the helper's explicit return type (it is what makes the types line up under TypeScript 6).

- [ ] **Step 12: Commit**

```text
git add apps/web
git commit -m "feat(web): add push handling, subscription reconcile and Profile Notifications settings"
```

---

### Task 7: Integration tests, retention and the operator guide

**Concurrency:** starts after Tasks 1 to 6 are merged; no other task runs at the same time.

**Files:**
- Create: `supabase/migrations/20261015004200_notifications_retention.sql`, `supabase/tests/0402_notifications_retention.test.sql`
- Create: `tools/integration/notifications.integration.ts`
- Modify: `package.json` (script `test:integration:notifications`; append it to P1's `test:integration` if that script exists), `.gitignore` is already covered (`.env*`)
- Modify: `docs/operator-guide.md` (section 4 replaced, subsection 12.1 added)

**Interfaces:**
- Consumes: everything from Tasks 1 to 6; the P1 `worker-tick` (job `digest`), P1 fixture scan data (the script clones the discount rows of the latest fixture run), the local Supabase stack (`bun run supabase:start`), `supabase functions serve`.
- Produces: `bun run test:integration:notifications`; `app.purge_notifications(p_batch int default 5000) returns jsonb`; cron job `retention-notifications`; the operator-guide text.

- [ ] **Step 1: Write the failing retention pgTAP test**

`supabase/tests/0402_notifications_retention.test.sql`:

```sql
begin;
select plan(7);

-- FK parents are not needed for this test (the function only reads refs by id).
set local session_replication_role = replica;

insert into auth.users (id, email, email_confirmed_at, instance_id, aud, role)
values ('00000000-0000-0000-0000-0000000000a1', 'a@example.test', now(), '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated');
insert into scan_runs (id, scan_date_local, status, settings_snapshot)
values ('00000000-0000-0000-0000-0000000000c1', '2026-01-01', 'complete', '{}');

insert into digests (id, scan_run_id, kind, user_id, content, content_hash, cutoff_reason, created_at) values
  ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000c1', 'discounts', '00000000-0000-0000-0000-0000000000a1', '{}', 'h', 'complete', now() - interval '200 days'),
  ('00000000-0000-0000-0000-0000000000e2', '00000000-0000-0000-0000-0000000000c1', 'portfolio', '00000000-0000-0000-0000-0000000000a1', '{}', 'h', 'complete', now() - interval '200 days'),
  ('00000000-0000-0000-0000-0000000000e3', '00000000-0000-0000-0000-0000000000c1', 'discounts', '00000000-0000-0000-0000-0000000000b2', '{}', 'h', 'complete', now() - interval '10 days');
insert into digest_items (digest_id, user_id, ref_type, ref_id) values
  ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000a1', 'episode', '00000000-0000-0000-0000-0000000000f1'),
  ('00000000-0000-0000-0000-0000000000e2', '00000000-0000-0000-0000-0000000000a1', 'episode', '00000000-0000-0000-0000-0000000000f2');
insert into digest_deliveries (digest_id, user_id, channel, idempotency_key) values
  ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000a1', 'push', 'k1');
-- f2 is a still-active episode: its (old) digest must be kept so dedupe never breaks
insert into signal_episodes (id, security_id, company_id, kind, mode, threshold_line, status, opened_scan_run_id, opened_session_date,
  opened_close, opened_line_value, open_reason, last_evaluated_session_date)
values ('00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-0000000000a9', '00000000-0000-0000-0000-0000000000a8', 'premium1', 'worldwide', '+1',
  'active', '00000000-0000-0000-0000-0000000000c1', '2026-01-01', 1, 1, 'new_entry', '2026-01-01');

insert into email_events (svix_id, type, received_at) values ('old', 'email.sent', now() - interval '200 days'), ('new', 'email.sent', now());
insert into push_subscriptions (user_id, endpoint, p256dh, auth, revoked_at, revoke_reason) values
  ('00000000-0000-0000-0000-0000000000a1', 'https://p.example.test/old', 'k', 's', now() - interval '40 days', 'gone'),
  ('00000000-0000-0000-0000-0000000000a1', 'https://p.example.test/recent', 'k', 's', now() - interval '5 days', 'gone'),
  ('00000000-0000-0000-0000-0000000000a1', 'https://p.example.test/live', 'k', 's', null, null);

set local session_replication_role = default; -- restore FK actions so the cascades below run

select is((app.purge_notifications(100)->>'digests')::int, 1, 'one old digest without live references is purged');
select is((select count(*)::int from digests where id = '00000000-0000-0000-0000-0000000000e1'), 0, 'the old unreferenced digest is gone');
select is((select count(*)::int from digest_deliveries where digest_id = '00000000-0000-0000-0000-0000000000e1'), 0, 'its deliveries are gone (cascade)');
select is((select count(*)::int from digests where id in ('00000000-0000-0000-0000-0000000000e2', '00000000-0000-0000-0000-0000000000e3')), 2,
  'an old digest with an active episode and a recent digest are kept');
select is((select count(*)::int from email_events), 1, 'old email events are purged');
select is((select count(*)::int from push_subscriptions where endpoint like '%/old'), 0, 'subscriptions revoked more than 30 days ago are purged');
select is((select count(*)::int from push_subscriptions where endpoint not like '%/old'), 2, 'recent revoked and live subscriptions are kept');

select * from finish();
rollback;
```

- [ ] **Step 2: Run to confirm failure, then write the retention migration**

Run: `bun run test:db`
Expected: `0402` FAILS (`function app.purge_notifications(integer) does not exist`).

`supabase/migrations/20261015004200_notifications_retention.sql`:

```sql
-- Retention for notification data (spec 6.4, D14): digests, items, deliveries and email events 180 days;
-- revoked push subscriptions 30 days. A digest that still references an active episode or an open risk
-- finding is kept so digest_items dedupe never breaks. Runs from its own cron entry so it does not depend on
-- how P1's app.purge_expired is written.
create or replace function app.purge_notifications(p_batch int default 5000) returns jsonb
language plpgsql security definer set search_path = public, app as $$
declare v_digests int; v_events int; v_subs int;
begin
  with doomed as (
    select g.id from digests g
     where g.created_at < now() - interval '180 days'
       and not exists (select 1 from digest_items i join signal_episodes e on e.id = i.ref_id
                        where i.digest_id = g.id and i.ref_type = 'episode' and e.status = 'active')
       and not exists (select 1 from digest_items i join risk_findings f on f.id = i.ref_id
                        where i.digest_id = g.id and i.ref_type = 'finding' and f.status = 'open')
     order by g.created_at limit p_batch)
  delete from digests where id in (select id from doomed);
  get diagnostics v_digests = row_count;

  delete from email_events where id in (select id from email_events where received_at < now() - interval '180 days' order by id limit p_batch);
  get diagnostics v_events = row_count;

  delete from push_subscriptions where id in (select id from push_subscriptions where revoked_at < now() - interval '30 days' limit p_batch);
  get diagnostics v_subs = row_count;

  return jsonb_build_object('digests', v_digests, 'email_events', v_events, 'push_subscriptions', v_subs);
end $$;
revoke all on function app.purge_notifications(int) from public, anon, authenticated;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'retention-notifications') then perform cron.unschedule('retention-notifications'); end if;
end $$;
select cron.schedule('retention-notifications', '40 1 * * *', 'select app.purge_notifications();');
```

Run: `bun run supabase:reset` then `bun run test:db`
Expected: `0402` passes (7 assertions). If P1 added NOT NULL columns to `signal_episodes` or `scan_runs`, add them to the fixture inserts.

- [ ] **Step 3: Write the integration script**

The script needs the local stack (`bun run supabase:start`), a completed P1/P2 fixture scan in the local database (it clones the discount rows of the latest fixture run), and `supabase functions serve` started with the environment file the script writes. Fake services run on the host: a fake push endpoint on port 54781 and a fake Resend on port 54782; the local Edge Runtime reaches them as `host.docker.internal`.

`tools/integration/notifications.integration.ts`:

```ts
import { spawnSync } from "node:child_process";
import { createECDH, createHmac, randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import { fileURLToPath } from "node:url";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { generateVapid } from "../lib/vapid.ts";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const ENV_FILE = `${ROOT}supabase/functions/.env.integration`;
const PUSH_PORT = 54781;
const RESEND_PORT = 54782;
const FUNCTIONS = "http://127.0.0.1:54321/functions/v1";

// --- phase 1: write the function env file --------------------------------------------------------------
if (process.argv.includes("--write-env")) {
  if (existsSync(ENV_FILE)) {
    console.log(`${ENV_FILE} exists; delete it to regenerate`);
    process.exit(0);
  }
  const vapid = await generateVapid();
  writeFileSync(
    ENV_FILE,
    [
      vapid.envLines("mailto:integration@example.test"),
      "RESEND_API_KEY=re_integration",
      "RESEND_API_URL=http://host.docker.internal:54782/emails",
      "EMAIL_FROM=Screener <alerts@integration.test>",
      `RESEND_WEBHOOK_SECRET=whsec_${randomBytes(24).toString("base64")}`,
      `UNSUBSCRIBE_SECRET=${randomBytes(24).toString("base64url")}`,
      `CRON_SHARED_SECRET=${randomBytes(24).toString("base64url")}`,
      "SITE_URL=http://localhost:5173",
      `FUNCTIONS_PUBLIC_URL=${FUNCTIONS}`,
      "PUSH_ENDPOINT_EXTRA_HOSTS=host.docker.internal",
    ].join("\n") + "\n",
  );
  console.log(`wrote ${ENV_FILE}\nnow run:  bun run supabase:start  then  supabase functions serve --no-verify-jwt --env-file supabase/functions/.env.integration`);
  process.exit(0);
}

// --- phase 2: run the scenarios ------------------------------------------------------------------------
if (!existsSync(ENV_FILE)) throw new Error("run with --write-env first");
const env = Object.fromEntries(
  readFileSync(ENV_FILE, "utf8").split(/\r?\n/).filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
) as Record<string, string>;

const status = spawnSync("bun", ["run", "supabase", "status", "-o", "env"], { cwd: ROOT, encoding: "utf8" }).stdout;
const fromStatus = (key: string) => new RegExp(`^${key}="?([^"\\r\\n]+)"?`, "m").exec(status)?.[1];
const apiUrl = fromStatus("API_URL") ?? "http://127.0.0.1:54321";
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? fromStatus("SERVICE_ROLE_KEY");
if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(apiUrl)) throw new Error("refusing to run against a non-local Supabase URL");
if (!serviceKey) throw new Error("could not read the local service role key from `supabase status -o env`");
const admin: SupabaseClient = createClient(apiUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

// fake services ---------------------------------------------------------------------------------------------
interface Seen { path: string; headers: Record<string, string>; body: string }
const pushSeen: Seen[] = [];
const emailSeen: Seen[] = [];
async function read(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}
const pushServer = createServer(async (req, res) => {
  pushSeen.push({ path: req.url ?? "", headers: req.headers as Record<string, string>, body: await read(req) });
  if (req.url?.startsWith("/gone/")) res.writeHead(410).end();
  else if (req.url?.startsWith("/limited/")) res.writeHead(429, { "retry-after": "120" }).end();
  else res.writeHead(201).end();
}).listen(PUSH_PORT);
const resendServer = createServer(async (req, res) => {
  const body = await read(req);
  emailSeen.push({ path: req.url ?? "", headers: req.headers as Record<string, string>, body });
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: `em_int_${emailSeen.length}` }));
}).listen(RESEND_PORT);

// helpers -----------------------------------------------------------------------------------------------------
const failures: string[] = [];
const check = (ok: boolean, message: string) => {
  if (!ok) failures.push(message);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const created = { users: [] as string[], runs: [] as string[] };

async function callFn(name: string, body: unknown = {}, headers: Record<string, string> = {}) {
  return await fetch(`${FUNCTIONS}/${name}`, { method: "POST", headers: { "content-type": "application/json", "x-cron-secret": env.CRON_SHARED_SECRET ?? "", ...headers }, body: JSON.stringify(body) });
}
async function must<T>(q: PromiseLike<{ data: T | null; error: { message: string } | null }>): Promise<T> {
  const { data, error } = await q;
  if (error || data === null) throw new Error(error?.message ?? "no data");
  return data;
}
async function makeUser(label: string, prefs: { push?: boolean; email?: boolean } = {}): Promise<string> {
  const email = `${label}-${randomBytes(4).toString("hex")}@integration.test`;
  const { data, error } = await admin.auth.admin.createUser({ email, email_confirm: true, password: randomBytes(12).toString("base64url") });
  if (error || !data.user) throw new Error(`createUser: ${error?.message}`);
  created.users.push(data.user.id);
  await must(admin.from("notification_preferences").insert({ user_id: data.user.id, push_enabled: prefs.push ?? false, email_enabled: prefs.email ?? false }).select());
  return data.user.id;
}
async function addSub(userId: string, kind: "ok" | "gone" | "limited"): Promise<string> {
  const ua = createECDH("prime256v1");
  const endpoint = `http://host.docker.internal:${PUSH_PORT}/${kind}/${randomBytes(4).toString("hex")}`;
  await must(admin.from("push_subscriptions").insert({
    user_id: userId, endpoint, p256dh: ua.generateKeys().toString("base64url"), auth: randomBytes(16).toString("base64url"),
  }).select());
  return endpoint;
}

type RowSpec = { category: "green" | "amber" | "pending" | "red"; done: boolean; rank?: number };
const source = await (async () => {
  const run = await must(admin.from("scan_runs").select("id").eq("status", "complete").contains("settings_snapshot", { provider_mode: "fixture" }).order("started_at", { ascending: false }).limit(1).maybeSingle());
  const rows = await must(admin.from("todays_discounts").select("*").eq("scan_run_id", (run as { id: string }).id).eq("mode", "worldwide").limit(4));
  if ((rows as unknown[]).length < 4) throw new Error("the fixture scan needs at least 4 worldwide discount rows (extend the P1 fixtures)");
  return rows as Record<string, unknown>[];
})();

let dayCounter = 10;
async function makeRun(status: "complete" | "running", specs: RowSpec[]) {
  const date = `2030-01-${String(dayCounter++).padStart(2, "0")}`;
  const run = (await must(admin.from("scan_runs").insert({ scan_date_local: date, status, trigger: "manual", settings_snapshot: { provider_mode: "fixture" } }).select("id").single())) as { id: string };
  created.runs.push(run.id);
  const episodes: string[] = [];
  for (const [index, spec] of specs.entries()) {
    const base = { ...source[index] } as Record<string, unknown>;
    delete base.id;
    delete base.created_at;
    episodes.push(String(base.episode_id));
    await must(admin.from("todays_discounts").insert({
      ...base, scan_run_id: run.id, mode: "worldwide", operational_category: spec.category,
      withheld: spec.category === "pending" || spec.category === "red", rank: spec.rank ?? Number(base.rank),
      report_id: spec.done ? crypto.randomUUID() : null, research_completed_at: spec.done ? new Date().toISOString() : null,
    }).select());
  }
  return { id: run.id, date, episodes };
}
async function runDigestJob(runId: string, key: "digest" | "digest:cutoff") {
  await must(admin.from("scan_jobs").upsert({ scan_run_id: runId, stage: "digest", key, priority: 5, status: "queued", attempts: 0, not_before: new Date().toISOString() }, { onConflict: "scan_run_id,stage,key" }).select());
  for (let i = 0; i < 30; i++) {
    await callFn("worker-tick");
    const job = (await must(admin.from("scan_jobs").select("status").eq("scan_run_id", runId).eq("stage", "digest").eq("key", key).single())) as { status: string };
    if (job.status === "done" || job.status === "dead") return job.status;
    await sleep(2000);
  }
  return "timeout";
}
const digestsOf = async (runId: string, userId: string) =>
  (await must(admin.from("digests").select("id,kind,status,cutoff_reason,content").eq("scan_run_id", runId).eq("user_id", userId))) as { id: string; kind: string; status: string; cutoff_reason: string; content: { items: { episodeId: string }[] } }[];
const itemsOf = async (userId: string) => ((await must(admin.from("digest_items").select("ref_id").eq("user_id", userId))) as { ref_id: string }[]).map((r) => r.ref_id);
const deliveriesOf = async (userId: string) =>
  (await must(admin.from("digest_deliveries").select("id,channel,status,skip_reason,attempts,provider_message_id,idempotency_key").eq("user_id", userId))) as { id: string; channel: string; status: string; skip_reason: string | null; attempts: number; provider_message_id: string | null; idempotency_key: string }[];
const dispatch = async () => (await callFn("notify-dispatch", { action: "tick" })).json();
const svixHeaders = (id: string, body: string, secret = env.RESEND_WEBHOOK_SECRET ?? "") => {
  const ts = String(Math.floor(Date.now() / 1000));
  const mac = createHmac("sha256", Buffer.from(secret.replace("whsec_", ""), "base64")).update(`${id}.${ts}.${body}`).digest("base64");
  return { "svix-id": id, "svix-timestamp": ts, "svix-signature": `v1,${mac}` };
};

async function scenario(name: string, fn: () => Promise<void>) {
  const before = failures.length;
  try {
    await fn();
  } catch (error) {
    failures.push(`${name}: threw ${(error as Error).message}`);
  }
  console.log(`${failures.length === before ? "PASS" : "FAIL"}  ${name}`);
}

const unauthorized = await fetch(`${FUNCTIONS}/notify-dispatch`, { method: "POST" });
if (unauthorized.status !== 401) throw new Error(`notify-dispatch answered ${unauthorized.status} without the secret: is \`supabase functions serve --env-file supabase/functions/.env.integration\` running?`);

// --- scenarios ---------------------------------------------------------------------------------------------
const FULL: RowSpec[] = [
  { category: "green", done: true, rank: 40 },
  { category: "amber", done: true, rank: 2 },
  { category: "pending", done: false },
  { category: "red", done: true },
];
let emailIdForWebhook = "";
let unsubscribeUrl = "";
let normalUser = "";

await scenario("digest exists once per user and kind; green first; pending and red excluded; rerun creates nothing", async () => {
  normalUser = await makeUser("normal", { push: true, email: true });
  await addSub(normalUser, "ok");
  const run = await makeRun("complete", FULL);
  check((await runDigestJob(run.id, "digest")) === "done", "digest job did not finish");
  const digests = await digestsOf(run.id, normalUser);
  check(digests.filter((d) => d.kind === "discounts").length === 1, "expected exactly one discounts digest");
  check(digests.every((d) => d.kind !== "portfolio"), "a user without holdings must not get a portfolio digest");
  const first = digests[0];
  check(first?.cutoff_reason === "complete", "cutoff_reason should be complete");
  check(JSON.stringify(first?.content.items.map((i) => i.episodeId)) === JSON.stringify([run.episodes[0], run.episodes[1]]), "order must be green then amber");
  const items = await itemsOf(normalUser);
  check(!items.includes(run.episodes[2] as string) && !items.includes(run.episodes[3] as string), "pending/red candidates must not be in digest_items");
  const deliveries = await deliveriesOf(normalUser);
  check(deliveries.length === 2 && deliveries.every((d) => d.status === "pending"), "one pending delivery per enabled channel");
  const counts = [digests.length, items.length, deliveries.length];
  await must(admin.from("scan_runs").update({ digests_created_at: null }).eq("id", run.id).select());
  check((await runDigestJob(run.id, "digest")) === "done", "rerun of the digest job did not finish");
  check(JSON.stringify([(await digestsOf(run.id, normalUser)).length, (await itemsOf(normalUser)).length, (await deliveriesOf(normalUser)).length]) === JSON.stringify(counts), "rerunning the digest stage created new rows");
});

await scenario("dispatch sends push (Topic, TTL) and email (Idempotency-Key, List-Unsubscribe) once and records sent", async () => {
  const result = (await dispatch()) as { processed: number; errors: number };
  check(result.errors === 0 && result.processed >= 2, `dispatch result ${JSON.stringify(result)}`);
  const deliveries = await deliveriesOf(normalUser);
  check(deliveries.every((d) => d.status === "sent"), `deliveries: ${deliveries.map((d) => d.status).join(",")}`);
  const push = pushSeen.find((s) => s.path.startsWith("/ok/"));
  check(push?.headers.topic === "digest-discounts" && push?.headers.ttl === "21600" && push?.headers["content-encoding"] === "aes128gcm", "push request headers");
  const mail = emailSeen.at(-1);
  const email = deliveries.find((d) => d.channel === "email");
  check(mail?.headers["idempotency-key"] === email?.idempotency_key, "Idempotency-Key must equal the delivery key digest:<kind>:<user>:<date>");
  const body = JSON.parse(mail?.body ?? "{}") as { headers?: Record<string, string> };
  check(body.headers?.["List-Unsubscribe-Post"] === "List-Unsubscribe=One-Click", "one-click header");
  unsubscribeUrl = /<([^>]+)>/.exec(body.headers?.["List-Unsubscribe"] ?? "")?.[1] ?? "";
  emailIdForWebhook = email?.provider_message_id ?? "";
  check(emailIdForWebhook !== "", "provider_message_id must be stored");
  const before = emailSeen.length;
  await dispatch();
  check(emailSeen.length === before, "a second dispatch pass must not send again");
});

await scenario("a 410 from the push service revokes the subscription and it is never contacted again", async () => {
  const user = await makeUser("gone", { push: true });
  const endpoint = await addSub(user, "gone");
  const run = await makeRun("complete", FULL);
  await runDigestJob(run.id, "digest");
  await dispatch();
  const sub = (await must(admin.from("push_subscriptions").select("revoked_at,revoke_reason").eq("endpoint", endpoint).single())) as { revoked_at: string | null; revoke_reason: string | null };
  check(sub.revoked_at !== null && sub.revoke_reason === "gone", "subscription must be revoked with reason gone");
  const hits = () => pushSeen.filter((s) => s.path === new URL(endpoint).pathname).length;
  check(hits() === 1, "exactly one request to the dead endpoint");
  await must(admin.from("digest_deliveries").update({ status: "pending", next_attempt_at: new Date().toISOString() }).eq("user_id", user).select());
  await dispatch();
  check(hits() === 1, "the revoked endpoint must not be contacted again");
  check((await deliveriesOf(user))[0]?.skip_reason === "no_subscription", "delivery should end skipped/no_subscription");
});

await scenario("the email cap stops sends at 90 with skipped/daily_cap", async () => {
  const today = new Date().toISOString().slice(0, 10);
  await must(admin.from("ai_quota_usage").upsert({ provider: "resend", resource: "email_day", period_kind: "day", period_start: today, used: 90, limit_value: 90 }, { onConflict: "provider,resource,period_kind,period_start" }).select());
  const user = await makeUser("capped", { email: true });
  const run = await makeRun("complete", FULL);
  await runDigestJob(run.id, "digest");
  const before = emailSeen.length;
  await dispatch();
  const delivery = (await deliveriesOf(user)).find((d) => d.channel === "email");
  check(delivery?.status === "skipped" && delivery.skip_reason === "daily_cap", `capped delivery was ${delivery?.status}/${delivery?.skip_reason}`);
  check(emailSeen.length === before, "no email may be sent over the cap");
  await must(admin.from("ai_quota_usage").update({ used: 0 }).eq("provider", "resend").eq("resource", "email_day").eq("period_start", today).select());
});

await scenario("an email user who unsubscribes between creation and dispatch is not emailed", async () => {
  const user = await makeUser("unsub", { email: true });
  const run = await makeRun("complete", FULL);
  await runDigestJob(run.id, "digest");
  await must(admin.from("notification_preferences").update({ email_unsubscribed_at: new Date().toISOString() }).eq("user_id", user).select());
  const before = emailSeen.length;
  await dispatch();
  const delivery = (await deliveriesOf(user)).find((d) => d.channel === "email");
  check(delivery?.status === "skipped" && delivery.skip_reason === "unsubscribed", `delivery was ${delivery?.status}/${delivery?.skip_reason}`);
  check(emailSeen.length === before, "no email may be sent to an unsubscribed user");
});

await scenario("the 13:00 Sofia cut-off builds the digest without pending or unfinished candidates, and no second digest follows", async () => {
  const user = await makeUser("cutoff", { push: true });
  await addSub(user, "ok");
  const run = await makeRun("running", [
    { category: "green", done: true, rank: 5 },
    { category: "amber", done: false, rank: 6 },
    { category: "pending", done: false },
    { category: "red", done: true },
  ]);
  const winter13 = new Date(`${run.date}T11:00:00Z`).toISOString(); // 2030-01 is winter time: 13:00 Sofia is 11:00Z
  const seeded = await must(admin.rpc("notify_cutoff_digests", { p_now: winter13 }));
  check(Number(seeded) >= 1, "cut-off must seed the digest:cutoff job");
  const wrongHour = await must(admin.rpc("notify_cutoff_digests", { p_now: `${run.date}T10:00:00Z` }));
  check(Number(wrongHour) === 0, "10:00Z is 12:00 Sofia in winter: the guard must return 0");
  check((await runDigestJob(run.id, "digest:cutoff")) === "done", "cut-off job did not finish");
  const digests = await digestsOf(run.id, user);
  check(digests.length === 1 && digests[0]?.cutoff_reason === "cutoff", "one digest with cutoff_reason cutoff");
  check(JSON.stringify(digests[0]?.content.items.map((i) => i.episodeId)) === JSON.stringify([run.episodes[0]]), "only the finished green candidate may be listed");
  const state = (await must(admin.from("scan_runs").select("status,digests_created_at").eq("id", run.id).single())) as { status: string; digests_created_at: string | null };
  check(state.status === "partial" && state.digests_created_at !== null, "scan becomes partial and digests_created_at is set");
  await must(admin.from("todays_discounts").update({ research_completed_at: new Date().toISOString(), report_id: crypto.randomUUID() }).eq("scan_run_id", run.id).select());
  await runDigestJob(run.id, "digest");
  check((await digestsOf(run.id, user)).length === 1, "research finishing after the cut-off must not create a second digest");
});

await scenario("signed webhook events update deliveries; unsigned and replayed events change nothing; unsubscribe link works", async () => {
  const payload = JSON.stringify({ type: "email.bounced", data: { email_id: emailIdForWebhook, to: ["x@example.test"], subject: "s", bounce: { type: "Permanent" } } });
  const unsigned = await fetch(`${FUNCTIONS}/resend-webhook`, { method: "POST", body: payload });
  check(unsigned.status === 401, "unsigned webhook must be 401");
  const forged = await fetch(`${FUNCTIONS}/resend-webhook`, { method: "POST", body: payload, headers: svixHeaders("msg_int_1", payload, `whsec_${randomBytes(24).toString("base64")}`) });
  check(forged.status === 401, "forged signature must be 401");
  const ok = await fetch(`${FUNCTIONS}/resend-webhook`, { method: "POST", body: payload, headers: svixHeaders("msg_int_1", payload) });
  check(ok.status === 200, "valid webhook must be 200");
  const replay = await fetch(`${FUNCTIONS}/resend-webhook`, { method: "POST", body: payload, headers: svixHeaders("msg_int_1", payload) });
  check(((await replay.json()) as { status: string }).status === "duplicate", "replay must be reported as duplicate");
  const events = await must(admin.from("email_events").select("id,payload").eq("svix_id", "msg_int_1"));
  check((events as unknown[]).length === 1 && !JSON.stringify(events).includes("@"), "exactly one stored event, without any address");
  const delivery = (await deliveriesOf(normalUser)).find((d) => d.channel === "email");
  check(delivery?.status === "bounced", "bounce must mark the delivery bounced");
  const prefs = (await must(admin.from("notification_preferences").select("email_enabled,email_unsubscribed_at,email_bounced_at").eq("user_id", normalUser).single())) as { email_enabled: boolean; email_unsubscribed_at: string | null; email_bounced_at: string | null };
  check(prefs.email_enabled === false && prefs.email_unsubscribed_at !== null && prefs.email_bounced_at !== null, "bounce must disable email");

  const another = await makeUser("link", { email: true });
  const token = unsubscribeUrl.split("t=")[1];
  check(Boolean(token), "the captured List-Unsubscribe URL carries a token");
  const get = await fetch(unsubscribeUrl);
  check(get.status === 200, "GET confirmation page");
  const post = await fetch(unsubscribeUrl, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "List-Unsubscribe=One-Click" });
  check(post.status === 200, "one-click POST");
  const tampered = await fetch(`${FUNCTIONS}/notify-unsubscribe?t=${encodeURIComponent(`${another}.AAAA`)}`, { method: "POST" });
  check(tampered.status === 400, "a forged token must be rejected");
});

// --- cleanup and verdict ---------------------------------------------------------------------------------------
// users first: their digests cascade from auth.users, and digests reference scan_runs without cascade
for (const id of created.users) await admin.auth.admin.deleteUser(id);
for (const id of created.runs) await admin.from("scan_runs").delete().eq("id", id);
pushServer.close();
resendServer.close();
if (failures.length > 0) {
  console.error(`\nnotifications integration FAILED:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log("\nnotifications integration: all scenarios passed");
process.exit(0);
```

- [ ] **Step 4: Add the `package.json` script**

Add to the root `package.json` `scripts`: `"test:integration:notifications": "bun run tools/integration/notifications.integration.ts"`, and, if P1 already defines `test:integration`, append ` && bun run test:integration:notifications` to it. (The test seam `RESEND_API_URL`, used by this suite to point `sendEmail` at the fake Resend, is already part of Tasks 3 and 4; it is never set in production.)

- [ ] **Step 5: Run the integration suite**

Run (PowerShell, three steps; Docker Desktop running, and a P1/P2 fixture scan already executed against the local stack):

```text
bun run test:integration:notifications -- --write-env
bun run supabase:start
supabase functions serve --no-verify-jwt --env-file supabase/functions/.env.integration
```

Leave `functions serve` running in a second terminal, then in the first:

```text
bun run test:integration:notifications
```

Expected: seven `PASS` lines (digest once per user and kind; dispatch sends once; 410 revokes; daily cap; unsubscribe between creation and dispatch; 13:00 Sofia cut-off; webhook and unsubscribe link) and `notifications integration: all scenarios passed`. If the script reports that the fixture scan has fewer than four worldwide discount rows, extend the P1 fixture set (not this plan). If `notify-dispatch` answers anything but 401 without the secret, the functions server is not running with the env file.

- [ ] **Step 6: Write the operator guide section 4**

In `docs/operator-guide.md` replace the heading `## 4. Configure Web Push (VAPID) and Resend (pending P3)` and its empty body with the text below (the heading becomes `(filled in P3)`).

````markdown
## 4. Configure Web Push (VAPID) and Resend (filled in P3)

### 4.1 VAPID keys (Web Push)

Generate one key pair for the project (never reuse keys between environments). The private key must
exist only as a Supabase function secret; the public key is shipped to the browser.

```powershell
bun run gen:vapid -- mailto:you@example.com --out supabase/functions/.env.vapid
supabase secrets set --env-file supabase/functions/.env.vapid --project-ref <ref>
```

The file defines `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` (a JWK on one line), `VAPID_SUBJECT` and
`VITE_VAPID_PUBLIC_KEY`. `supabase secrets set` stores the first three as function secrets (the
`VITE_` line is stored too and is harmless). Then add the public key as the web build variable
`VITE_VAPID_PUBLIC_KEY` (section 11) and redeploy the web app. Delete `supabase/functions/.env.vapid`
afterwards (it is git-ignored, but it holds the private key). Rotating the key pair invalidates every
stored subscription: users must switch push off and on again.

### 4.2 Resend account, domain and DNS

1. Create a Resend account and an API key with sending access: Dashboard -> API Keys.
2. Add a sending **subdomain** (for example `updates.example.com`): Dashboard -> Domains -> Add domain.
3. Add the DNS records Resend shows at your DNS provider: SPF (TXT), DKIM (TXT or CNAME) and the
   Return-Path (MX/CNAME) record. Wait until the domain shows **Verified**.
4. Add DMARC for the subdomain, starting in monitoring mode:
   `_dmarc.updates.example.com  TXT  "v=DMARC1; p=none; rua=mailto:you@example.com"`.
   Tighten to `p=quarantine` after a few weeks of clean reports.
5. Set the secrets:

```powershell
supabase secrets set RESEND_API_KEY=<key> EMAIL_FROM="Stock Screener <alerts@updates.example.com>" SITE_URL=https://<your-site> --project-ref <ref>
```

Free plan limits: 100 emails per day, 3,000 per month, 30 days of logs, 3 domains.

### 4.3 Webhook and the other secrets

1. Resend Dashboard -> Webhooks -> Add endpoint. URL: `https://<ref>.supabase.co/functions/v1/resend-webhook`.
   Events: `email.sent`, `email.delivered`, `email.delivery_delayed`, `email.bounced`, `email.complained`,
   `email.failed`, `email.suppressed`.
2. Copy the signing secret (`whsec_...`) and set it:
   `supabase secrets set RESEND_WEBHOOK_SECRET=whsec_... --project-ref <ref>`.
3. Create the unsubscribe signing secret (32 random bytes) and set it:

```powershell
bun -e "console.log(Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url'))"
supabase secrets set UNSUBSCRIBE_SECRET=<value> --project-ref <ref>
```

   Changing `UNSUBSCRIBE_SECRET` invalidates every unsubscribe link already sent.
4. `CRON_SHARED_SECRET` (section 2) is reused by `notify-dispatch`. `FUNCTIONS_PUBLIC_URL` is only needed
   behind a custom domain (default `https://<ref>.supabase.co/functions/v1`); it is the base of the
   `List-Unsubscribe` link.

### 4.4 Supabase Auth mail through Resend (optional)

Dashboard -> Authentication -> SMTP Settings: host `smtp.resend.com`, port `465`, user `resend`, password =
the Resend API key, sender = an address on the verified domain. This raises Supabase's mail limit from the
built-in 2 per hour but those messages share the same Resend quota of 100 per day.

### 4.5 Email quota arithmetic

`notify-dispatch` stops at **90 emails per UTC day** (a 10 % margin for auth mail and retries). Each user can
receive at most two digests per scan, so 45 email users reach the cap. A delivery that cannot get quota is
recorded as `skipped` with reason `daily_cap`; push is unaffected, portfolio digests are claimed before
discount digests. Upgrading the Resend plan and raising the cap is a code constant (`EMAIL_DAILY_CAP`).

### 4.6 Verify Web Push on real devices (spike P3-01, manual)

The automated spike (`bun run spike:push`) proves the request shape and payload decryption against a local
fake push service. A real receive test is a manual step. For each row, sign in, open Profile ->
Notifications, turn Web Push on, press **Send test notification** and tick the row. Repeat once against
`supabase functions serve` and once against the deployed function.

| Client | Local serve | Deployed | Notes |
|---|---|---|---|
| Chrome desktop | [ ] | [ ] | |
| Firefox desktop | [ ] | [ ] | |
| Android Chrome | [ ] | [ ] | |
| iPhone or iPad Home Screen app (iOS 16.4+) | [ ] | [ ] | permission prompt only after tapping the switch |

If any row fails because of the library (`jsr:@negrel/webpush`), record it in the spec open-question table and
switch the adapter to `web-push-neo` (spec 10.4).

### 4.7 What to tell iPhone and iPad users

"On iPhone and iPad, notifications work from iOS 16.4 and only for apps added to the Home Screen. Tap Share,
choose Add to Home Screen, open Stock Screener from the Home Screen icon, then come back to Profile ->
Notifications and enable notifications." Safari tabs cannot receive push; the Notifications page shows these
steps instead of the switch until the app runs from the Home Screen.

### 4.8 Checks after configuration

- Profile -> Notifications -> **Send test notification** arrives on every enabled device.
- Open a received digest email and press the unsubscribe link: the confirmation page should render. If the
  browser shows raw HTML as text, Supabase is serving the default domain as `text/plain` (a platform
  restriction that is UNVERIFIED for this project). One-click unsubscribe (mail clients send a POST) still
  works; record a follow-up to add a site route `/unsubscribe` that POSTs to `notify-unsubscribe`.
- Resend Dashboard -> Webhooks shows 2xx for recent events; `select type, count(*) from email_events group by 1`
  shows them arriving.

### 4.9 Troubleshooting

| Symptom | Cause and action |
|---|---|
| Webhook shows 401 in Resend | `RESEND_WEBHOOK_SECRET` differs from the endpoint's signing secret, or the server clock is off by more than 5 minutes |
| Deliveries `skipped` with `no_subscription` | the push service answered 404/410 (subscription revoked); the user must switch push off and on again |
| Deliveries `skipped` with `daily_cap` | 90 emails already sent today (section 4.5) |
| Deliveries `failed` with `expired` | the digest was older than 24 hours when a retry came due (Resend idempotency window) |
| Email `bounced` and the toggle disabled | hard bounce or complaint; fix the address with the user, then clear `email_bounced_at` by SQL |
````

- [ ] **Step 7: Add the retention subsection 12.1 to the operator guide**

In `docs/operator-guide.md`, immediately before the heading `## 13. Backups, rotations, incident runbooks (pending P7)` insert:

````markdown
### 12.1 Notification data retention (180 days)

`digests`, `digest_items`, `digest_deliveries` and `email_events` are kept for **180 days**; revoked push
subscriptions for 30 days (spec 6.4). The cron job `retention-notifications` (01:40 UTC) calls
`app.purge_notifications()`, which deletes in batches of 5,000. A digest that still references an active
episode or an open risk finding is kept past 180 days so that "already notified" dedupe never breaks.

```sql
select jobname, status, start_time from cron.job_run_details
 where jobname = 'retention-notifications' order by start_time desc limit 5;
select count(*) from digests where created_at < now() - interval '180 days';
```

The second query should stay small (only digests that still reference active episodes or findings).
````

- [ ] **Step 8: Lint, full local gates, commit**

Run: `bun run lint:fix` then `bun run lint`; `bun run typecheck`; `bun run test`; `bun run test:db`
Expected: all exit 0. `typecheck` includes `tools/integration/notifications.integration.ts`; if `tsc` objects to the top-level `await` or to `for await (const chunk of req)`, keep `module: ESNext` (already set) and cast `chunk as Buffer` as written.

```text
git add supabase/migrations/20261015004200_notifications_retention.sql supabase/tests/0402_notifications_retention.test.sql tools/integration docs/operator-guide.md package.json
git commit -m "test(notify): add notification integration suite, retention job and operator guide sections"
```

---

### Task 8: Phase exit checklist

**Files:**
- Create: `docs/discovery/p3-results.md`
- Modify: `docs/superpowers/specs/2026-10-15-stock-screener-design.md` (one pointer line under the table in section 19.2 and the decision-log entries named in Step 4)

**Interfaces:**
- Consumes: everything from Tasks 1 to 7.
- Produces: the written answers to spec P3-01 to P3-04, a clean tree, the decision-log entries.

- [ ] **Step 1: Confirm a clean tree and a frozen install**

Run: `git status --short`
Expected: no output (`supabase/functions/.env.integration` and `.env.vapid` are ignored and do not appear).

Run: `bun install --frozen-lockfile`
Expected: exit 0.

- [ ] **Step 2: Static, unit and Deno gates**

```text
bun run lint
bun run typecheck
bun run test
bun run functions:check
bun run check:functions-config
bun run build
bun run check:bundle
```

Expected: every command exits 0. `test` now includes `core` digest tests (about 25), `tools` vapid and decrypt tests, `web` notification tests (about 45 across sw-routes, vapid-key, sw-push, sw-messages, push-support, push-client, notifications-api, notifications-view) and the Deno suites for the adapters, `digest-stage`, `digest-store`, `notify-dispatch`, `push-subscribe`, `resend-webhook`, `notify-unsubscribe`. `check:bundle` shows no `VAPID_PRIVATE` or `RESEND_API_KEY`.

- [ ] **Step 3: Database, spike and integration gates**

```text
bun run supabase:reset
bun run test:db
bun run spike:push
bun run test:integration:notifications
```

Expected: `test:db` passes the three P3 files (26, 22 and 7 assertions) and every earlier file; the spike prints `spike:push passed`; the integration suite prints `all scenarios passed` (with `supabase functions serve --env-file supabase/functions/.env.integration` running).

- [ ] **Step 4: Check the five review-focus failure modes one by one**

| Failure mode | Pinned by (must be green) |
|---|---|
| A retried delivery creates a second logical alert | pgTAP `0400` uniques; `digest-stage.test.ts` "not created twice"; `dispatch.test.ts` "a retried delivery stays one delivery"; integration scenario 1 |
| A revoked subscription spams failures | `push.test.ts` status mapping; `dispatch.test.ts` "gone ... never used again" and "five failures revoke"; integration scenario 3 |
| An unsubscribed user is still emailed | `dispatch.test.ts` "never emailed (preferences re-read at dispatch)"; `notify-unsubscribe` tests; integration scenarios 5 and 7 |
| A digest built before research finished includes a `pending` candidate | `digest.test.ts` throws on red/grey/pending; `digest-stage.test.ts` "never reach a digest" and "cut-off passes finishedOnly"; integration scenario 6 |
| Webhook replay or forgery without signature verification | `email.test.ts` Svix suite; `resend-webhook` tests; integration scenario 7 |

- [ ] **Step 5: Verify that nothing secret is tracked**

```text
git ls-files | Select-String -Pattern '(^|/)\.env' | Where-Object { $_ -notmatch '\.env\.example$' }
git grep -n -I -E "VAPID_PRIVATE_KEY=\{|re_[A-Za-z0-9]{20,}|whsec_[A-Za-z0-9+/=]{20,}" -- . ":!docs" ":!*.test.ts"
```

Expected: both print nothing (the test files contain fake `whsec_` values and are excluded on purpose; they are generated from fixed byte patterns).

- [ ] **Step 6: Manual and hosted items (operator, recorded in the results file)**

These cannot run in CI; each needs an observed result in `docs/discovery/p3-results.md`:

1. P3-01 real-browser matrix (operator guide 4.6) on Chrome, Firefox, Android Chrome and an iOS Home Screen app, local and deployed.
2. P3-02 Resend: domain verified, DKIM/SPF/DMARC pass, a real digest email received, `email.delivered` webhook updates `delivered_at`, signature verification accepted live events.
3. P3-03 delivery latency: time from `digest_deliveries.created` to push receipt and to email arrival (note in the file).
4. P3-04 `pushsubscriptionchange`: observed or not; the page-visit reconcile is the fallback.
5. `app.kick_workers()` on the hosted project calls `notify-dispatch` (check `net._http_response` after creating a pending delivery) and the cut-off cron entries exist (`select jobname, schedule from cron.job where jobname like 'digest-cutoff%'`).
6. The unsubscribe confirmation page renders on the hosted domain (operator guide 4.8).

- [ ] **Step 7: Write the results record `docs/discovery/p3-results.md`**

```markdown
# P3 verification results

Environment: Windows 11, Bun 1.3.14, Node 22.13.1, Deno 2.9.6 locally and 2.1.x in CI, Supabase CLI 2.121.0.

| ID | Question | Prepared answer | Evidence and result |
|---|---|---|---|
| P3-01 | Does `jsr:@negrel/webpush` deliver (Chrome, Firefox, Android, iOS Home Screen) from local and deployed functions? | Local half automated by `bun run spike:push` (request shape and decryption). Real browsers are manual (operator guide 4.6). Fallback `web-push-neo`. | Observed: |
| P3-02 | Resend domain DNS, webhook and live signature verification | Operator guide 4.2 and 4.3 | Observed: |
| P3-03 | Delivery latency | measure push and email | Observed: |
| P3-04 | `pushsubscriptionchange` behaviour | SW re-subscribes and notifies pages; page-visit reconcile is the fallback | Observed: |
| T-01 | Exact surface of `@negrel/webpush` 0.5.0 (plan read the repository `master` sources: `ApplicationServer.new`, `importVapidKeys`, `PushSubscriber.pushTextMessage`, `PushMessageError.response`) | `push.test.ts` and the spike are the check | Observed: |
| T-02 | Does the hosted `supabase.co` domain serve `text/html` from `notify-unsubscribe`? | One-click POST needs no HTML; follow-up: site route `/unsubscribe` | Observed: |
| T-03 | P1 `HANDLERS` signature for the `digest` stage | adapter line in `worker-tick` | Observed: |
| T-04 | Does P1's `app.kick_workers` body match the version replaced by migration `20261015004000`? | diff before applying | Observed: |
```

- [ ] **Step 8: Record the decisions in the specification**

In `docs/superpowers/specs/2026-10-15-stock-screener-design.md`: after the last row of the 19.2 table add the pointer line `P3 verification results: docs/discovery/p3-results.md.`; in the decision log (section 19.1, next free `A-` numbers) record the plan decisions 1 to 13 of `docs/superpowers/plans/2026-10-15-p3-notifications.md`, and update spec 3.11 (`EMAIL_FROM`, `UNSUBSCRIBE_SECRET`, `FUNCTIONS_PUBLIC_URL`, `PUSH_ENDPOINT_EXTRA_HOSTS`, `RESEND_API_URL` test seam) and spec 10.4 (Topic alphabet) accordingly.

- [ ] **Step 9: Commit the record**

```text
git add docs/discovery/p3-results.md docs/superpowers/specs/2026-10-15-stock-screener-design.md
git commit -m "docs: record P3 verification results and notification decisions"
```

P3 is complete when: Steps 1 to 5 are green locally, CI is green, the manual rows of Step 6 have observed results (or are explicitly deferred with the owner's agreement), both digests were delivered to a real test user on push and email within one scan, a real 410 revoked a subscription, an `email.delivered` webhook updated a delivery, and the owner has accepted or amended the specification.
